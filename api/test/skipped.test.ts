// Functional tests for turning a Chapter's narration on and off (#20, PRD 4.2.5 用户调整, AC-BOOK-01 and -02):
// the user's side goes through the user routes, the worker's side only through the /internal protocol.
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { BookDetail, BookTimeline, ClaimedRenderJob, ParseResult } from "../src/contract.js";
import { allowlist, jobs } from "../src/db/schema.js";
import {
  bookDetail,
  claimJob,
  generatedBook,
  logIn,
  renderAll,
  reportFailure,
  reportParse,
  reportRenderResult,
  testApp,
  uploadBook,
  withCookie,
  type TestApp,
} from "./helpers.js";

const sentence = (text: string) => ({ paragraphIndex: 0, text, spokenText: text });

/** Three narrated Chapters between Skipped ones; each Sentence lasts 4 s once generated. */
const chapters: Omit<ParseResult, "attempt">["chapters"] = [
  { title: "Imprint", skipped: true, sentences: [sentence("This ebook is in the public domain.")] },
  { title: "I", sentences: [sentence("It is a truth universally acknowledged."), sentence("However little known.")] },
  { title: "II", sentences: [sentence("Mr. Bennet was among the earliest."), sentence("He had always intended.")] },
  { title: "III", sentences: [sentence("Not all that Mrs. Bennet could ask.")] },
  { title: "Acknowledgments", skipped: true, sentences: [sentence("Thanks to everyone.")] },
  { title: "Dedication", skipped: true, sentences: [] },
];

type T = Awaited<ReturnType<typeof testApp>>;

function setSkipped(app: TestApp, chapterId: string, skipped: boolean) {
  return app.request(`/api/chapters/${chapterId}/skipped`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ skipped }),
  });
}

async function playlistSegments(app: TestApp, bookId: string) {
  const m3u8 = await (await app.request(`/api/books/${bookId}/audio.m3u8`)).text();
  return m3u8.split("\n").filter((l) => l.startsWith("segments/"));
}

async function playlistEnded(app: TestApp, bookId: string) {
  return (await (await app.request(`/api/books/${bookId}/audio.m3u8`)).text()).includes("#EXT-X-ENDLIST");
}

async function timeline(app: TestApp, bookId: string) {
  return (await (await app.request(`/api/books/${bookId}/timeline`)).json()) as BookTimeline;
}

const chapterNamed = (b: BookDetail, title: string) => b.chapters.find((c) => c.title === title)!;
const placed = (b: BookDetail) => b.chapters.filter((c) => c.startMs !== null).map((c) => [c.title, c.startMs]);

async function claimRender(app: TestApp) {
  const job = await claimJob(app);
  expect(job?.type).toBe("render_chapter");
  return job as ClaimedRenderJob;
}

async function renderFully(t: T, job: ClaimedRenderJob) {
  expect((await reportRenderResult(t.app, job, await renderAll(t.storage, job))).status).toBe(204);
}

/** A Book parsed into `chapters` with nothing generated yet. */
async function parsedBook(t: T) {
  const book = await uploadBook(t.app);
  expect((await reportParse(t.app, (await claimJob(t.app))!, { parserVersion: "test-1", title: "P", author: null, chapters })).status).toBe(204);
  return bookDetail(t.app, book.id);
}

describe("turning a Skipped Chapter's narration on (AC-BOOK-01)", () => {
  it("queues it, keeps the playlist as it is while it generates, then inserts it in its place; the Book stays 已就绪", async () => {
    const t = await testApp();
    const book = await generatedBook(t, "Pride", chapters);
    const ack = chapterNamed(book, "Acknowledgments");
    const imprint = chapterNamed(book, "Imprint");
    const before = await playlistSegments(t.app, book.id);
    expect(before).toHaveLength(5);

    expect((await setSkipped(t.app, imprint.id, false)).status).toBe(204);
    let d = await bookDetail(t.app, book.id);
    expect(chapterNamed(d, "Imprint")).toMatchObject({ skipped: false, audioStatus: "pending", startMs: null });
    expect(d).toMatchObject({ status: "ready", progress: { generated: 3, narrated: 4 } });
    // The rest of the Book still plays, at the same places, while the first Chapter is generated out of order.
    expect(await playlistSegments(t.app, book.id)).toEqual(before);
    expect(placed(d)).toEqual(placed(book));
    // The playlist ends where it did, but a player keeps checking it: the Imprint will come in before its end.
    expect(await timeline(t.app, book.id)).toMatchObject({ complete: true, settled: false });

    const job = await claimRender(t.app);
    expect(job.chapterId).toBe(imprint.id);
    await renderFully(t, job);

    d = await bookDetail(t.app, book.id);
    expect(chapterNamed(d, "Imprint").audioStatus).toBe("generated");
    expect(placed(d)).toEqual([
      ["Imprint", 0],
      ["I", 4000],
      ["II", 12000],
      ["III", 20000],
    ]);
    expect(d).toMatchObject({ status: "ready", progress: { generated: 4, narrated: 4 } });
    const after = await playlistSegments(t.app, book.id);
    expect(after).toHaveLength(6);
    expect(after.slice(1)).toEqual(before);
    expect(await playlistEnded(t.app, book.id)).toBe(true);
    expect(await timeline(t.app, book.id)).toMatchObject({ complete: true, settled: true });

    // AC-BOOK-01 with the Chapter at the end.
    expect((await setSkipped(t.app, ack.id, false)).status).toBe(204);
    await renderFully(t, await claimRender(t.app));
    expect(chapterNamed(await bookDetail(t.app, book.id), "Acknowledgments").startMs).toBe(24000);
  });

  it("queues it in Chapter order among the Chapters still to generate", async () => {
    const t = await testApp();
    const book = await parsedBook(t);
    await renderFully(t, await claimRender(t.app));
    await setSkipped(t.app, chapterNamed(book, "Acknowledgments").id, false);
    await setSkipped(t.app, chapterNamed(book, "Imprint").id, false);
    expect((await bookDetail(t.app, book.id)).status).toBe("generating");

    const order = [];
    for (let job = await claimJob(t.app); job; job = await claimJob(t.app)) {
      order.push(chapters[book.chapters.findIndex((c) => c.id === (job as ClaimedRenderJob).chapterId)]!.title);
      await renderFully(t, job as ClaimedRenderJob);
    }
    expect(order).toEqual(["Imprint", "II", "III", "Acknowledgments"]);
    const d = await bookDetail(t.app, book.id);
    expect(d).toMatchObject({ status: "ready", progress: { generated: 5, narrated: 5 } });
    expect(placed(d).map(([title]) => title)).toEqual(["Imprint", "I", "II", "III", "Acknowledgments"]);
  });

  it("holds playback for a Chapter generation has not reached yet, as for any other Chapter in order", async () => {
    const t = await testApp();
    const book = await parsedBook(t);
    await renderFully(t, await claimRender(t.app));
    await setSkipped(t.app, chapterNamed(book, "Acknowledgments").id, false);
    await renderFully(t, await claimRender(t.app));
    await renderFully(t, await claimRender(t.app));

    // III is done; the playlist does not end there, the Acknowledgments come next.
    expect(placed(await bookDetail(t.app, book.id)).map(([title]) => title)).toEqual(["I", "II", "III"]);
    expect(await playlistEnded(t.app, book.id)).toBe(false);
    const job = await claimRender(t.app);
    expect(job.chapterId).toBe(chapterNamed(book, "Acknowledgments").id);
    await renderFully(t, job);
    expect(placed(await bookDetail(t.app, book.id)).at(-1)).toEqual(["Acknowledgments", 20000]);
  });

  it("makes a Chapter without text generated at once, with nothing to queue", async () => {
    const t = await testApp();
    const book = await generatedBook(t, "Pride", chapters);
    expect((await setSkipped(t.app, chapterNamed(book, "Dedication").id, false)).status).toBe(204);
    expect(chapterNamed(await bookDetail(t.app, book.id), "Dedication")).toMatchObject({ skipped: false, audioStatus: "generated" });
    expect(await claimJob(t.app)).toBeUndefined();
  });

  it("queues it only once when turned on twice", async () => {
    const t = await testApp();
    const book = await generatedBook(t, "Pride", chapters);
    const ack = chapterNamed(book, "Acknowledgments");
    expect((await setSkipped(t.app, ack.id, false)).status).toBe(204);
    expect((await setSkipped(t.app, ack.id, false)).status).toBe(204);
    expect(await t.db.select().from(jobs).where(eq(jobs.chapterId, ack.id))).toHaveLength(1);
  });
});

describe("setting a narrated Chapter Skipped", () => {
  it("takes it out of the playlist at once, keeps its audio, and puts it back without generating it again", async () => {
    const t = await testApp();
    const book = await generatedBook(t, "Pride", chapters);
    const two = chapterNamed(book, "II");
    const before = await playlistSegments(t.app, book.id);
    const objects = t.storage.objects.size;

    expect((await setSkipped(t.app, two.id, true)).status).toBe(204);
    let d = await bookDetail(t.app, book.id);
    expect(chapterNamed(d, "II")).toMatchObject({ skipped: true, audioStatus: "generated", startMs: null });
    expect(d).toMatchObject({ status: "ready", progress: { generated: 2, narrated: 2 } });
    // III moves up to where II started.
    expect(placed(d)).toEqual([
      ["I", 0],
      ["III", 8000],
    ]);
    expect(await playlistSegments(t.app, book.id)).toEqual([...before.slice(0, 2), before[4]]);
    expect((await timeline(t.app, book.id)).chapters.map((c) => c.id)).toEqual([chapterNamed(d, "I").id, chapterNamed(d, "III").id]);
    expect(t.storage.objects.size).toBe(objects);

    expect((await setSkipped(t.app, two.id, false)).status).toBe(204);
    d = await bookDetail(t.app, book.id);
    expect(chapterNamed(d, "II")).toMatchObject({ skipped: false, audioStatus: "generated", startMs: 8000 });
    expect(await playlistSegments(t.app, book.id)).toEqual(before);
    expect(await claimJob(t.app)).toBeUndefined();
  });

  it("takes a Chapter still to generate out of the queue, and the Book is 已就绪 without it", async () => {
    const t = await testApp();
    const book = await parsedBook(t);
    await renderFully(t, await claimRender(t.app));
    await renderFully(t, await claimRender(t.app));
    expect((await setSkipped(t.app, chapterNamed(book, "III").id, true)).status).toBe(204);

    expect(await claimJob(t.app)).toBeUndefined();
    const d = await bookDetail(t.app, book.id);
    expect(chapterNamed(d, "III")).toMatchObject({ skipped: true, audioStatus: "pending" });
    expect(d).toMatchObject({ status: "ready", progress: { generated: 2, narrated: 2 } });
    expect(await playlistEnded(t.app, book.id)).toBe(true);
  });

  it("drops a running Chapter's job instead of trying it again when the attempt fails after it was set Skipped", async () => {
    const t = await testApp();
    const book = await parsedBook(t);
    const job = await claimRender(t.app);
    expect(job.chapterId).toBe(chapterNamed(book, "I").id);
    expect((await setSkipped(t.app, job.chapterId, true)).status).toBe(204);

    expect((await reportFailure(t.app, job, "RuntimeError: kokoro crashed")).status).toBe(204);
    expect((await claimRender(t.app)).chapterId).toBe(chapterNamed(book, "II").id);
    expect(chapterNamed(await bookDetail(t.app, book.id), "I")).toMatchObject({ skipped: true, audioStatus: "pending" });

    // Narrated again, it is queued anew.
    expect((await setSkipped(t.app, job.chapterId, false)).status).toBe(204);
    const open = await t.db.select().from(jobs).where(eq(jobs.chapterId, job.chapterId));
    expect(open.map((j) => j.status)).toEqual(["queued"]);
  });

  it("resumes a listener whose Sentence was in it at the start of the next narrated Chapter", async () => {
    const t = await testApp();
    const book = await generatedBook(t, "Pride", chapters);
    // The second Sentence of II.
    expect((await t.app.request(`/api/books/${book.id}/listening`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ positionMs: 13_000 }),
    })).status).toBe(204);
    expect((await bookDetail(t.app, book.id)).listening?.startMs).toBe(12_000);

    await setSkipped(t.app, chapterNamed(book, "II").id, true);
    expect((await bookDetail(t.app, book.id)).listening).toMatchObject({ startMs: 8000, chapterTitle: "III" });
  });
});

describe("who may change it", () => {
  it("refuses another user's Chapter, and a Library Book's", async () => {
    const t = await testApp();
    const book = await generatedBook(t, "Pride", chapters);
    const ack = chapterNamed(book, "Acknowledgments");
    await t.db.insert(allowlist).values({ email: "other@example.com" });
    const other = withCookie(t.anon, await logIn(t, "other@example.com"));
    expect((await setSkipped(other, ack.id, false)).status).toBe(404);

    expect(book.source).toBe("upload");
    // Library Books (#12) share their audio with every user; nobody changes their Chapters (PRD 4.2.5, F5).
    await t.db.execute(sql`update books set source = 'library' where id = ${book.id}`);
    const res = await setSkipped(t.app, ack.id, false);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: "library_book" } });
    expect(chapterNamed(await bookDetail(t.app, book.id), "Acknowledgments").skipped).toBe(true);
  });

  it("rejects a body without the flag", async () => {
    const t = await testApp();
    const book = await generatedBook(t, "Pride", chapters);
    const res = await t.app.request(`/api/chapters/${book.chapters[0]!.id}/skipped`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});
