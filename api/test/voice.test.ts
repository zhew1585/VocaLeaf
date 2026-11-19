// Functional tests for choosing and changing a Book's Voice (#19, PRD 4.2.4, 4.3.4 更换音色, 4.3.5 #11,
// AC-BOOK-05, AC-BOOK-06): the user's side goes through the user routes, the worker's only through /internal.
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { BookDetail, ClaimedRenderJob, ParseResult, Voice } from "../src/contract.js";
import { allowlist, books, chapters, jobs } from "../src/db/schema.js";
import { startVoiceChange } from "../src/jobs/voice-change.js";
import {
  bookDetail,
  claimJob,
  epubForm,
  generatedBook,
  logIn,
  renderAll,
  reportFailure,
  reportParse,
  reportRenderProgress,
  reportRenderResult,
  TEST_LEASE_MS,
  testApp,
  uploadBook,
  withCookie,
  type TestApp,
} from "./helpers.js";

type T = Awaited<ReturnType<typeof testApp>>;

const sentence = (text: string) => ({ paragraphIndex: 0, text, spokenText: text });

/** Two narrated Chapters and a Skipped Imprint. */
const CHAPTERS: Omit<ParseResult, "attempt">["chapters"] = [
  { title: "Imprint", skipped: true, sentences: [sentence("This ebook is in the public domain.")] },
  { title: "I", sentences: [sentence("It is a truth universally acknowledged."), sentence("However little known.")] },
  { title: "II", sentences: [sentence("Mr. Bennet was among the earliest."), sentence("He had always intended.")] },
];

/** The new Voice's Sentences last longer than the old one's 4 seconds, so its timings tell them apart. */
const NEW_SENTENCE_MS = 5000;

function changeVoice(app: TestApp, bookId: string, voice: Voice) {
  return app.request(`/api/books/${bookId}/voice`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ voice }),
  });
}

async function playlistSegments(app: TestApp, bookId: string) {
  const m3u8 = await (await app.request(`/api/books/${bookId}/audio.m3u8`)).text();
  return m3u8.split("\n").filter((l) => l.startsWith("segments/"));
}

async function sentenceStarts(app: TestApp, chapterId: string) {
  const rows = (await (await app.request(`/api/chapters/${chapterId}/sentences`)).json()) as { id: string; startMs: number }[];
  return rows.map((s) => [s.id, s.startMs]);
}

async function claimRender(app: TestApp) {
  const job = await claimJob(app);
  expect(job?.type).toBe("render_chapter");
  return job as ClaimedRenderJob;
}

async function renderNewVoice(t: T, job: ClaimedRenderJob) {
  expect((await reportRenderResult(t.app, job, await renderAll(t.storage, job, NEW_SENTENCE_MS))).status).toBe(204);
}

function saveListening(app: TestApp, bookId: string, positionMs: number, voice?: Voice) {
  return app.request(`/api/books/${bookId}/listening`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ positionMs, voice }),
  });
}

const chapterNamed = (b: BookDetail, title: string) => b.chapters.find((c) => c.title === title)!;
const ready = (t: T) => generatedBook(t, "Pride and Prejudice", CHAPTERS);

describe("choosing the Voice at upload (PRD 4.2.4)", () => {
  it("narrates the Book in the Voice chosen in the upload", async () => {
    const t = await testApp();
    const form = epubForm();
    form.append("voice", "uk_male");
    const res = await t.app.request("/api/books", { method: "POST", body: form });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    expect((await bookDetail(t.app, id)).voice).toBe("uk_male");

    const parse = (await claimJob(t.app))!;
    await reportParse(t.app, parse, { parserVersion: "test-1", title: "P", author: null, chapters: CHAPTERS });
    expect((await claimRender(t.app)).voice).toBe("uk_male");
  });

  it("uses 美音女声 when the upload names no Voice, and refuses an unknown one", async () => {
    const t = await testApp();
    const { id } = await uploadBook(t.app);
    expect(await bookDetail(t.app, id)).toMatchObject({ voice: "us_female", voiceChange: null, voiceChangeable: true });

    const form = epubForm();
    form.append("voice", "robot");
    expect((await t.app.request("/api/books", { method: "POST", body: form })).status).toBe(400);
  });
});

describe("changing the Voice of a Book (PRD 4.2.4)", () => {
  it("AC-BOOK-05: keeps playing the old audio while the new Voice is generated, and refuses a second change", async () => {
    const t = await testApp();
    const book = await ready(t);
    const before = await playlistSegments(t.app, book.id);
    const one = chapterNamed(book, "I");
    const timings = await sentenceStarts(t.app, one.id);

    expect((await changeVoice(t.app, book.id, "uk_female")).status).toBe(202);
    let d = await bookDetail(t.app, book.id);
    expect(d).toMatchObject({ voice: "us_female", voiceChange: { to: "uk_female", status: "running" }, status: "ready" });

    const first = await claimRender(t.app);
    expect([first.chapterId, first.voice]).toEqual([one.id, "uk_female"]);
    await renderNewVoice(t, first);

    // Half the new audio is there; the playlist, timings and Chapters are the old Voice's still.
    d = await bookDetail(t.app, book.id);
    expect(d.voiceChange).toEqual({ to: "uk_female", status: "running" });
    expect(d.chapters.map((c) => c.audioStatus)).toEqual(book.chapters.map((c) => c.audioStatus));
    expect(await playlistSegments(t.app, book.id)).toEqual(before);
    expect(await sentenceStarts(t.app, one.id)).toEqual(timings);

    const again = await changeVoice(t.app, book.id, "uk_male");
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: { code: "voice_change_running", message: "正在更换音色，完成前不能再次更换" } });
  });

  it("AC-BOOK-06: switches every Chapter at once when the last one is generated, keeping progress at its Sentence", async () => {
    const t = await testApp();
    const book = await ready(t);
    const two = chapterNamed(book, "II");
    // The listener is in Chapter II's second Sentence: 2 Sentences of I at 4 s, then 4 s into II.
    expect((await saveListening(t.app, book.id, 8000 + 4500)).status).toBe(204);
    const where = (await bookDetail(t.app, book.id)).listening!;
    const before = await playlistSegments(t.app, book.id);
    const ids = (await sentenceStarts(t.app, two.id)).map(([id]) => id);

    await changeVoice(t.app, book.id, "us_male");
    await renderNewVoice(t, await claimRender(t.app));
    await renderNewVoice(t, await claimRender(t.app));
    expect(await claimJob(t.app)).toBeUndefined();

    const d = await bookDetail(t.app, book.id);
    expect(d).toMatchObject({ voice: "us_male", voiceChange: null, status: "ready", durationMs: 4 * NEW_SENTENCE_MS });
    expect(chapterNamed(d, "II")).toMatchObject({ startMs: 2 * NEW_SENTENCE_MS, durationMs: 2 * NEW_SENTENCE_MS });
    const after = await playlistSegments(t.app, book.id);
    expect(after).toHaveLength(4);
    expect(after.filter((s) => before.includes(s))).toEqual([]);
    // Same Sentence, now where the new Voice says it is.
    expect(d.listening).toMatchObject({ sentenceId: where.sentenceId, startMs: 3 * NEW_SENTENCE_MS });
    expect(await sentenceStarts(t.app, two.id)).toEqual([
      [ids[0], 2 * NEW_SENTENCE_MS],
      [ids[1], 3 * NEW_SENTENCE_MS],
    ]);
    // A player still holding the old playlist can fetch its segments until the next change.
    const old = await t.app.request(`/api/books/${book.id}/${before[0]}`);
    expect(old.status).toBe(200);
  });

  it("does not misplace progress a player reports in the old Voice's audio after the switch", async () => {
    const t = await testApp();
    const book = await ready(t);
    await saveListening(t.app, book.id, 4500, "us_female");
    const where = (await bookDetail(t.app, book.id)).listening!;
    await changeVoice(t.app, book.id, "us_male");
    await renderNewVoice(t, await claimRender(t.app));
    await renderNewVoice(t, await claimRender(t.app));

    // 12.5 s in the old audio is Chapter II; in the new one it would be Chapter I's last Sentence.
    expect((await saveListening(t.app, book.id, 12_500, "us_female")).status).toBe(204);
    expect((await bookDetail(t.app, book.id)).listening!.sentenceId).toBe(where.sentenceId);
    // In the new Voice it counts.
    await saveListening(t.app, book.id, 12_500, "us_male");
    expect((await bookDetail(t.app, book.id)).listening!.sentenceId).not.toBe(where.sentenceId);
  });

  it("AC-BOOK-06: a Chapter rendered in parts stays aside until the whole change is done", async () => {
    const t = await testApp();
    const book = await ready(t);
    const before = await playlistSegments(t.app, book.id);
    await changeVoice(t.app, book.id, "us_male");

    const first = await claimRender(t.app);
    const report = await renderAll(t.storage, first, NEW_SENTENCE_MS);
    await reportRenderProgress(t.app, first, { segments: report.segments.slice(0, 1), sentences: report.sentences.slice(0, 1) });
    expect(await playlistSegments(t.app, book.id)).toEqual(before);
    // The last report is refused while a Sentence of the Chapter has no timing in the new Voice.
    const short = await reportRenderResult(t.app, first, { segments: report.segments.slice(1), sentences: [] });
    expect(short.status).toBe(400);
    await reportRenderResult(t.app, first, { segments: report.segments.slice(1), sentences: report.sentences.slice(1) });
    expect((await bookDetail(t.app, book.id)).voice).toBe("us_female");
  });

  it("4.3.5 #11: keeps the old Voice and audio when a Chapter fails for good, and cancels the change's other jobs", async () => {
    const t = await testApp();
    const book = await ready(t);
    const before = await playlistSegments(t.app, book.id);
    await changeVoice(t.app, book.id, "uk_male");

    // Chapter I fails on every attempt; Chapter II was claimed meanwhile by a second worker.
    const one = await claimRender(t.app);
    const two = await claimRender(t.app);
    expect((await reportFailure(t.app, one, "RuntimeError: kokoro crashed")).status).toBe(204);
    for (let attempt = 2; attempt <= 3; attempt++) {
      const retried = await claimRender(t.app);
      expect([retried.chapterId, retried.attempt]).toEqual([one.chapterId, attempt]);
      await reportFailure(t.app, retried, "RuntimeError: kokoro crashed");
    }

    const d = await bookDetail(t.app, book.id);
    expect(d).toMatchObject({ voice: "us_female", voiceChange: { to: "uk_male", status: "failed" }, status: "ready" });
    expect(d.chapters.map((c) => c.audioStatus)).toEqual(book.chapters.map((c) => c.audioStatus));
    expect(await playlistSegments(t.app, book.id)).toEqual(before);
    expect(await claimJob(t.app)).toBeUndefined();

    // The cancelled job's worker hears 409 and its segments are deleted.
    const report = await renderAll(t.storage, two, NEW_SENTENCE_MS);
    expect((await reportRenderResult(t.app, two, report)).status).toBe(409);
    expect(report.segments.filter((s) => t.storage.objects.has(s.key))).toEqual([]);

    // The user can try again: the failure notice goes, the change runs.
    expect((await changeVoice(t.app, book.id, "uk_male")).status).toBe(202);
    expect((await bookDetail(t.app, book.id)).voiceChange).toEqual({ to: "uk_male", status: "running" });
  });

  it("puts a Voice change's job with an expired lease back in the queue without touching the playing Chapter", async () => {
    const t = await testApp();
    const book = await ready(t);
    await changeVoice(t.app, book.id, "uk_male");
    const first = await claimRender(t.app);
    t.clock.advance(TEST_LEASE_MS + 1);

    const again = await claimRender(t.app);
    expect([again.chapterId, again.attempt]).toEqual([first.chapterId, 2]);
    expect(chapterNamed(await bookDetail(t.app, book.id), "I").audioStatus).toBe("generated");
  });

  it("deletes the previous Voice's segments, objects too, when the next change starts", async () => {
    const t = await testApp();
    const book = await ready(t);
    const keys = () => [...t.storage.objects.keys()].filter((k) => k.includes("/audio/"));
    const original = keys();
    await changeVoice(t.app, book.id, "us_male");
    await renderNewVoice(t, await claimRender(t.app));
    await renderNewVoice(t, await claimRender(t.app));
    expect(keys()).toHaveLength(2 * original.length);

    // Back to the first Voice: its old segments are gone, the playing ones stay.
    expect((await changeVoice(t.app, book.id, "us_female")).status).toBe(202);
    expect(keys().filter((k) => original.includes(k))).toEqual([]);
    expect(keys()).toHaveLength(original.length);
    await renderNewVoice(t, await claimRender(t.app));
    await renderNewVoice(t, await claimRender(t.app));
    expect((await bookDetail(t.app, book.id)).voice).toBe("us_female");
    expect(await playlistSegments(t.app, book.id)).toHaveLength(4);
  });

  it("sends a Skipped Chapter that kept audio in the old Voice back to 待生成", async () => {
    const t = await testApp();
    const book = await ready(t);
    // A narrated Chapter turned Skipped keeps its audio (PRD 4.2.5, #20).
    const two = chapterNamed(book, "II");
    await t.db.update(chapters).set({ skipped: true }).where(eq(chapters.id, two.id));

    await changeVoice(t.app, book.id, "us_male");
    await renderNewVoice(t, await claimRender(t.app));
    expect(await claimJob(t.app)).toBeUndefined();

    const d = await bookDetail(t.app, book.id);
    expect(d.voice).toBe("us_male");
    expect(chapterNamed(d, "II")).toMatchObject({ audioStatus: "pending", durationMs: null });
    expect((await sentenceStarts(t.app, two.id)).map(([, ms]) => ms)).toEqual([null, null]);
  });
});

describe("refused Voice changes", () => {
  it("before the Book is 已就绪, to the Voice it has, and for another user's Book", async () => {
    const t = await testApp();
    const { id } = await uploadBook(t.app);
    const early = await changeVoice(t.app, id, "uk_male");
    expect(early.status).toBe(409);
    expect(await early.json()).toMatchObject({ error: { message: "这本书生成完成后才能更换音色" } });

    const book = await ready(t);
    expect((await changeVoice(t.app, book.id, "us_female")).status).toBe(409);

    await t.db.insert(allowlist).values({ email: "other@example.com" });
    const other = withCookie(t.anon, await logIn(t, "other@example.com"));
    expect((await changeVoice(other, book.id, "uk_male")).status).toBe(404);
    expect((await changeVoice(t.app, book.id, "robot" as Voice)).status).toBe(400);
  });

  it("while a retried Chapter of a 已就绪 Book still generates in the old Voice", async () => {
    const t = await testApp();
    const book = await ready(t);
    await t.db.update(chapters).set({ audioStatus: "pending" }).where(eq(chapters.id, chapterNamed(book, "II").id));
    const res = await changeVoice(t.app, book.id, "uk_male");
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: "book_not_ready" } });
  });

  it("for a Library Book, which keeps its Voice (PRD 4.2.2)", async () => {
    const t = await testApp();
    const book = await ready(t);
    // Library Books come with #12; the schema has no such source yet, so the row is read and relabelled.
    const [row] = await t.db.select().from(books).where(eq(books.id, book.id));
    const outcome = await t.db.transaction((tx) =>
      startVoiceChange(tx, { ...row!, source: "library" as never }, "uk_male"),
    );
    expect(outcome).toEqual({ started: false, refusal: "not_changeable" });
  });

  it("refuses to retry a 生成失败 Chapter while the Voice changes", async () => {
    const t = await testApp();
    const book = await ready(t);
    const one = chapterNamed(book, "I");
    await t.db.update(chapters).set({ audioStatus: "failed" }).where(eq(chapters.id, one.id));
    await t.db.update(jobs).set({ status: "failed" }).where(eq(jobs.chapterId, one.id));
    await changeVoice(t.app, book.id, "uk_male");

    const res = await t.app.request(`/api/chapters/${one.id}/retry`, { method: "POST" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { message: "正在更换音色，完成后再重试" } });
  });
});
