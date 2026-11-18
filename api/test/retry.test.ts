// Functional tests for generation failures, retries and progress (#5, PRD 4.3.3 and 4.3.5 #8 to #10):
// the user's side goes through the user routes, the worker's side only through the /internal protocol.
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Book, BookDetail, ClaimedRenderJob, ParseResult } from "../src/contract.js";
import { allowlist, jobs } from "../src/db/schema.js";
import {
  bookDetail,
  claimJob,
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

const OTHER_EMAIL = "other@example.com";

const sentence = (text: string, paragraphIndex = 0) => ({ paragraphIndex, text, spokenText: text });

/** Three narrated Chapters and a Skipped Imprint. */
const parsed: Omit<ParseResult, "attempt"> = {
  parserVersion: "test-1",
  title: "Pride and Prejudice",
  author: "Jane Austen",
  chapters: [
    { title: "Imprint", skipped: true, sentences: [sentence("This ebook is in the public domain.")] },
    { title: "I", sentences: [sentence("It is a truth universally acknowledged."), sentence("However little known.")] },
    { title: "II", sentences: [sentence("Mr. Bennet was among the earliest."), sentence("He had always intended.")] },
    { title: "III", sentences: [sentence("Not all that Mrs. Bennet could ask.")] },
  ],
};

type T = Awaited<ReturnType<typeof testApp>>;

async function parsedBook(t: T) {
  const book = await uploadBook(t.app);
  const job = (await claimJob(t.app))!;
  expect((await reportParse(t.app, job, parsed)).status).toBe(204);
  return book;
}

async function claimRender(app: TestApp) {
  const job = await claimJob(app);
  expect(job?.type).toBe("render_chapter");
  return job as ClaimedRenderJob;
}

async function renderFully(t: T, job: ClaimedRenderJob) {
  expect((await reportRenderResult(t.app, job, await renderAll(t.storage, job))).status).toBe(204);
}

/** Claims the Chapter's job and reports every attempt failed, as a worker whose Kokoro keeps crashing. */
async function failEveryAttempt(app: TestApp, chapterId: string) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const job = await claimRender(app);
    expect([job.chapterId, job.attempt]).toEqual([chapterId, attempt]);
    expect((await reportFailure(app, job, "RuntimeError: kokoro crashed")).status).toBe(204);
  }
}

function retry(app: TestApp, chapterId: string) {
  return app.request(`/api/chapters/${chapterId}/retry`, { method: "POST" });
}

async function playlistSegments(app: TestApp, bookId: string) {
  const m3u8 = await (await app.request(`/api/books/${bookId}/audio.m3u8`)).text();
  return m3u8.split("\n").filter((l) => l.startsWith("segments/"));
}

const statuses = (b: BookDetail) => b.chapters.map((c) => [c.title, c.audioStatus]);
const chapterNamed = (b: BookDetail, title: string) => b.chapters.find((c) => c.title === title)!;

describe("a Chapter whose generation fails", () => {
  it("goes back to 待生成 and is retried automatically, then generates on its third attempt", async () => {
    const t = await testApp();
    const book = await parsedBook(t);
    const first = await claimRender(t.app);

    expect((await reportFailure(t.app, first, "RuntimeError: kokoro crashed")).status).toBe(204);
    expect(statuses(await bookDetail(t.app, book.id))[1]).toEqual(["I", "pending"]);

    const second = await claimRender(t.app);
    expect([second.id, second.chapterId, second.attempt]).toEqual([first.id, first.chapterId, 2]);
    await reportFailure(t.app, second, "RuntimeError: kokoro crashed");

    const third = await claimRender(t.app);
    expect(third.attempt).toBe(3);
    await renderFully(t, third);
    expect(statuses(await bookDetail(t.app, book.id))[1]).toEqual(["I", "generated"]);
  });

  it("counts a timed-out attempt (lease expired) like a failed one: 3 attempts in all, then 生成失败", async () => {
    const t = await testApp();
    const book = await parsedBook(t);
    const first = await claimRender(t.app);
    t.clock.advance(TEST_LEASE_MS + 1);

    const second = await claimRender(t.app);
    expect([second.chapterId, second.attempt]).toEqual([first.chapterId, 2]);
    await reportFailure(t.app, second, "RuntimeError: kokoro crashed");
    const third = await claimRender(t.app);
    expect(third.attempt).toBe(3);
    await reportFailure(t.app, third, "RuntimeError: kokoro crashed");

    expect(statuses(await bookDetail(t.app, book.id))[1]).toEqual(["I", "failed"]);
    const [row] = await t.db.select().from(jobs).where(eq(jobs.id, first.id));
    expect(row).toMatchObject({ status: "failed", attempt: 3, error: "RuntimeError: kokoro crashed" });
  });

  it("ends 生成失败 after 3 failed attempts without blocking the Book: the others generate and it becomes 已就绪", async () => {
    const t = await testApp();
    const book = await parsedBook(t);
    const one = chapterNamed(await bookDetail(t.app, book.id), "I");

    await failEveryAttempt(t.app, one.id);
    await renderFully(t, await claimRender(t.app));
    await renderFully(t, await claimRender(t.app));
    expect(await claimJob(t.app)).toBeUndefined();

    const d = await bookDetail(t.app, book.id);
    expect(d).toMatchObject({ status: "ready", playable: true, progress: { generated: 2, narrated: 3 } });
    expect(statuses(d)).toEqual([
      ["Imprint", "pending"],
      ["I", "failed"],
      ["II", "generated"],
      ["III", "generated"],
    ]);
    expect(await playlistSegments(t.app, book.id)).toHaveLength(3);
  });

  it("keeps the segments an attempt published when it is retried, and later Chapters wait for it", async () => {
    const t = await testApp();
    const book = await parsedBook(t);
    const first = await claimRender(t.app);
    const report = await renderAll(t.storage, first);
    await reportRenderProgress(t.app, first, { segments: report.segments.slice(0, 1), sentences: report.sentences.slice(0, 1) });
    const published = await playlistSegments(t.app, book.id);
    expect(published).toHaveLength(1);

    await reportFailure(t.app, first, "RuntimeError: kokoro crashed");
    expect(await playlistSegments(t.app, book.id)).toEqual(published);
    const later = await claimRender(t.app);
    expect(later.chapterId).toBe(first.chapterId);
    // The new attempt renders the whole Chapter again; the segment already published stays.
    await reportRenderResult(t.app, later, await renderAll(t.storage, later));
    const after = await playlistSegments(t.app, book.id);
    expect(after[0]).toBe(published[0]);
    expect(after).toHaveLength(2);
  });
});

describe("retrying a 生成失败 Chapter (AC-BOOK-04)", () => {
  async function bookWithFailedChapter(t: T) {
    const book = await parsedBook(t);
    const two = chapterNamed(await bookDetail(t.app, book.id), "II");
    await renderFully(t, await claimRender(t.app));
    await failEveryAttempt(t.app, two.id);
    await renderFully(t, await claimRender(t.app));
    expect((await bookDetail(t.app, book.id)).status).toBe("ready");
    return { book, two };
  }

  it("queues it again with fresh attempts and inserts its audio in its place once generated; the Book stays 已就绪", async () => {
    const t = await testApp();
    const { book, two } = await bookWithFailedChapter(t);
    const before = await playlistSegments(t.app, book.id);
    expect(before).toHaveLength(3);

    expect((await retry(t.app, two.id)).status).toBe(204);
    let d = await bookDetail(t.app, book.id);
    expect(chapterNamed(d, "II").audioStatus).toBe("pending");
    expect(d.status).toBe("ready");
    // Chapter III keeps playing while II is generated again.
    expect(await playlistSegments(t.app, book.id)).toEqual(before);

    const again = await claimRender(t.app);
    expect([again.chapterId, again.attempt]).toEqual([two.id, 1]);
    expect(chapterNamed(await bookDetail(t.app, book.id), "II").audioStatus).toBe("generating");
    await renderFully(t, again);

    d = await bookDetail(t.app, book.id);
    expect(d).toMatchObject({ status: "ready", progress: { generated: 3, narrated: 3 } });
    expect(d.chapters.slice(1).map((c) => [c.title, c.audioStatus, c.startMs])).toEqual([
      ["I", "generated", 0],
      ["II", "generated", 8000],
      ["III", "generated", 16000],
    ]);
    const after = await playlistSegments(t.app, book.id);
    expect(after).toHaveLength(5);
    expect([after[0], after[1], after[4]]).toEqual(before);
  });

  it("refuses a Chapter that is not 生成失败, including a second retry", async () => {
    const t = await testApp();
    const { book, two } = await bookWithFailedChapter(t);
    const one = chapterNamed(await bookDetail(t.app, book.id), "I");

    expect((await retry(t.app, one.id)).status).toBe(409);
    expect((await retry(t.app, two.id)).status).toBe(204);
    const res = await retry(t.app, two.id);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: "chapter_not_failed" } });
    // Only one new job.
    expect(await t.db.select().from(jobs).where(eq(jobs.chapterId, two.id))).toHaveLength(2);
  });

  it("does not let another user retry the Chapter", async () => {
    const t = await testApp();
    const { book, two } = await bookWithFailedChapter(t);
    await t.db.insert(allowlist).values({ email: OTHER_EMAIL });
    const other = withCookie(t.anon, await logIn(t, OTHER_EMAIL));

    expect((await retry(other, two.id)).status).toBe(404);
    expect(chapterNamed(await bookDetail(t.app, book.id), "II").audioStatus).toBe("failed");
  });
});

describe("generation progress (AC-SHELF-02)", () => {
  it("counts generated narrated Chapters out of all narrated ones, on the shelf list and the detail page", async () => {
    const t = await testApp();
    const book = await uploadBook(t.app);
    const progressOnShelf = async () =>
      ((await (await t.app.request("/api/books")).json()) as Book[]).find((b) => b.id === book.id)!.progress;
    expect(await progressOnShelf()).toEqual({ generated: 0, narrated: 0 });

    const parse = (await claimJob(t.app))!;
    await reportParse(t.app, parse, parsed);
    expect(await progressOnShelf()).toEqual({ generated: 0, narrated: 3 });

    await renderFully(t, await claimRender(t.app));
    expect(await progressOnShelf()).toEqual({ generated: 1, narrated: 3 });
    expect((await bookDetail(t.app, book.id)).progress).toEqual({ generated: 1, narrated: 3 });
  });
});

describe("Chapters not playable yet (AC-BOOK-03)", () => {
  it("say how long they still wait, later ones longer; a playable one says where it starts instead", async () => {
    const t = await testApp();
    const book = await parsedBook(t);
    const first = await claimRender(t.app);
    const report = await renderAll(t.storage, first);
    await reportRenderProgress(t.app, first, { segments: report.segments.slice(0, 1), sentences: report.sentences.slice(0, 1) });

    const d = await bookDetail(t.app, book.id);
    const [imprint, one, two, three] = d.chapters;
    expect([imprint!.startMs, imprint!.waitSeconds]).toEqual([null, null]);
    expect([one!.startMs, one!.waitSeconds]).toEqual([0, null]);
    expect(two!.startMs).toBeNull();
    expect(three!.startMs).toBeNull();
    expect(two!.waitSeconds).toBeGreaterThanOrEqual(1);
    expect(three!.waitSeconds).toBeGreaterThan(two!.waitSeconds!);
  });

  it("measure the wait at the pace the worker generated earlier Chapters", async () => {
    const t = await testApp();
    const book = await parsedBook(t);
    // Chapter I (60 characters) takes 60 seconds to generate: 1 second per character.
    const first = await claimRender(t.app);
    t.clock.advance(60_000);
    await renderFully(t, first);

    const d = await bookDetail(t.app, book.id);
    // II (57 characters) waits for its own first segment, III (35) for all of II and its own.
    expect(chapterNamed(d, "II").waitSeconds).toBe(57);
    expect(chapterNamed(d, "III").waitSeconds).toBe(57 + 35);
    expect(chapterNamed(d, "I").waitSeconds).toBeNull();
  });
});
