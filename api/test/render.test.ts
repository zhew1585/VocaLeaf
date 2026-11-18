// Functional tests for audio generation and playback at the API seam: the user uploads a Book and plays it,
// the worker side is driven only through the /internal HTTP protocol, as the real worker does.
import { describe, expect, it } from "vitest";
import type { BookDetail, ClaimedRenderJob, ParseResult, Sentence } from "../src/contract.js";
import { books, users } from "../src/db/schema.js";
import {
  bookDetail,
  claimJob,
  heartbeat,
  renderAll,
  reportFailure,
  reportParse,
  reportRenderProgress,
  reportRenderResult,
  TEST_LEASE_MS,
  testApp,
  uploadBook,
  type TestApp,
} from "./helpers.js";

const sentence = (text: string, paragraphIndex = 0) => ({ paragraphIndex, text, spokenText: text });

/** A Book whose Imprint is Skipped (as #3 will report it) and whose two other Chapters are narrated. */
const parsed: Omit<ParseResult, "attempt"> = {
  parserVersion: "test-1",
  title: "Pride and Prejudice",
  author: "Jane Austen",
  chapters: [
    { title: "I", sentences: [sentence("It is a truth universally acknowledged."), sentence("However little known.")] },
    { title: "Imprint", skipped: true, sentences: [sentence("This ebook is in the public domain.")] },
    { title: "II", sentences: [sentence("Mr. Bennet was among the earliest.", 0), sentence("He had always intended.", 1), sentence("Observing his second daughter.", 1)] },
  ],
};

async function parsedBook(t: Awaited<ReturnType<typeof testApp>>) {
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

async function playlist(app: TestApp, bookId: string) {
  const res = await app.request(`/api/books/${bookId}/audio.m3u8`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("application/vnd.apple.mpegurl");
  return res.text();
}

/** The segment URLs of a playlist, resolved against the playlist's own URL as a player does. */
function segmentUrls(m3u8: string, bookId: string) {
  return m3u8
    .split("\n")
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => new URL(l, `http://web/api/books/${bookId}/audio.m3u8`).pathname);
}

async function sentencesOf(app: TestApp, chapterId: string) {
  return (await (await app.request(`/api/chapters/${chapterId}/sentences`)).json()) as Sentence[];
}

const state = (b: BookDetail) => [b.status, b.playable];

/** Reports the claim failed, then claims and fails the job's remaining attempts: its Chapter ends 生成失败. */
async function failForGood(app: TestApp, job: ClaimedRenderJob, error: string) {
  expect((await reportFailure(app, job, error)).status).toBe(204);
  for (let attempt = job.attempt + 1; attempt <= 3; attempt++) {
    const again = await claimRender(app);
    expect([again.id, again.attempt]).toEqual([job.id, attempt]);
    expect((await reportFailure(app, again, error)).status).toBe(204);
  }
}

describe("generating a Book's audio after parsing", () => {
  it("goes 生成中·未可播 → 生成中·可播 → 已就绪, and every narrated Sentence gets start_ms, end_ms and word_timings", async () => {
    const t = await testApp();
    const { app, storage } = t;
    const book = await parsedBook(t);
    expect(state(await bookDetail(app, book.id))).toEqual(["generating", false]);

    const first = await claimRender(app);
    const firstReport = await renderAll(storage, first);
    // First segment written: the Book becomes playable while the rest of the Chapter still renders.
    expect((await reportRenderProgress(app, first, { segments: firstReport.segments.slice(0, 1), sentences: firstReport.sentences.slice(0, 1) })).status).toBe(204);
    expect(state(await bookDetail(app, book.id))).toEqual(["generating", true]);

    expect((await reportRenderResult(app, first, { segments: firstReport.segments.slice(1), sentences: firstReport.sentences.slice(1) })).status).toBe(204);
    const halfway = await bookDetail(app, book.id);
    expect(state(halfway)).toEqual(["generating", true]);
    // Chapter I took 8 s for 60 characters; Chapter II has 87 more to go.
    expect(halfway.durationMs).toBe(8000 + (87 * 8000) / 60);

    const second = await claimRender(app);
    expect((await reportRenderResult(app, second, await renderAll(storage, second))).status).toBe(204);

    const ready = await bookDetail(app, book.id);
    expect(state(ready)).toEqual(["ready", true]);
    expect(ready.durationMs).toBe(20_000);
    expect(ready.chapters.map((c) => [c.title, c.audioStatus, c.durationMs])).toEqual([
      ["I", "generated", 8000],
      ["Imprint", "pending", null],
      ["II", "generated", 12000],
    ]);

    // Times are positions in the Book's continuous audio: Chapter II starts where Chapter I ends.
    const one = await sentencesOf(app, ready.chapters[0]!.id);
    const two = await sentencesOf(app, ready.chapters[2]!.id);
    expect([...one, ...two].map((s) => [s.startMs, s.endMs])).toEqual([
      [0, 3700],
      [4000, 7700],
      [8000, 11700],
      [12000, 15700],
      [16000, 19700],
    ]);
    expect(two[0]!.wordTimings).toEqual([{ word: "Mr.", startMs: 0, endMs: 400 }]);
    const skipped = await sentencesOf(app, ready.chapters[1]!.id);
    expect(skipped.map((s) => [s.startMs, s.endMs, s.wordTimings])).toEqual([[null, null, null]]);
  });

  it("hands out one render job per narrated Chapter, in Chapter order, each with its Sentences and the Book's Voice", async () => {
    const t = await testApp();
    const book = await parsedBook(t);
    const detail = await bookDetail(t.app, book.id);

    const first = await claimRender(t.app);
    const second = await claimRender(t.app);

    expect(await claimJob(t.app)).toBeUndefined();
    expect([first.chapterId, second.chapterId]).toEqual([detail.chapters[0]!.id, detail.chapters[2]!.id]);
    expect(first).toMatchObject({ bookId: book.id, voice: "us_female", attempt: 1, leaseMs: TEST_LEASE_MS });
    expect(first.audioPrefix.startsWith(`books/${book.id}/audio/`)).toBe(true);
    // With their paragraphs, so the worker can speak a paragraph at once and pause longer between paragraphs.
    expect(second.sentences.map((s) => [s.spokenText, s.paragraphIndex])).toEqual([
      ["Mr. Bennet was among the earliest.", 0],
      ["He had always intended.", 1],
      ["Observing his second daughter.", 1],
    ]);
    expect((await bookDetail(t.app, book.id)).chapters.map((c) => c.audioStatus)).toEqual(["generating", "pending", "generating"]);
  });

  it("marks a narrated Chapter without Sentences generated right away, with no job", async () => {
    const t = await testApp();
    const book = await uploadBook(t.app);
    const job = (await claimJob(t.app))!;
    await reportParse(t.app, job, { ...parsed, chapters: [{ title: "Blank", sentences: [] }, parsed.chapters[0]!] });

    const render = await claimRender(t.app);
    expect(await claimJob(t.app)).toBeUndefined();
    await reportRenderResult(t.app, render, await renderAll(t.storage, render));

    const d = await bookDetail(t.app, book.id);
    expect(d.chapters.map((c) => [c.title, c.audioStatus, c.durationMs])).toEqual([
      ["Blank", "generated", 0],
      ["I", "generated", 8000],
    ]);
    expect(d.status).toBe("ready");
  });

  it("finishes a Book whose Chapter failed, leaving that Chapter 生成失败 and out of the playlist", async () => {
    const t = await testApp();
    const book = await parsedBook(t);
    const first = await claimRender(t.app);
    const second = await claimRender(t.app);

    await failForGood(t.app, first, "kokoro unreachable");
    expect((await bookDetail(t.app, book.id)).status).toBe("generating");
    await reportRenderResult(t.app, second, await renderAll(t.storage, second));

    const d = await bookDetail(t.app, book.id);
    expect(d.status).toBe("ready");
    expect(d.chapters.map((c) => c.audioStatus)).toEqual(["failed", "pending", "generated"]);
    expect(segmentUrls(await playlist(t.app, book.id), book.id)).toHaveLength(3);
  });

  it("refuses a report whose segment is outside the claim's prefix or whose Sentence is not in the Chapter", async () => {
    const t = await testApp();
    await parsedBook(t);
    const first = await claimRender(t.app);
    const second = await claimRender(t.app);
    const report = await renderAll(t.storage, first);

    const foreignKey = { ...report, segments: [{ index: 0, key: "books/other/seg.ts", durationMs: 1000 }] };
    expect((await reportRenderProgress(t.app, first, foreignKey)).status).toBe(400);
    const foreignSentence = { segments: [], sentences: [{ ...report.sentences[0]!, id: second.sentences[0]!.id }] };
    expect((await reportRenderProgress(t.app, first, foreignSentence)).status).toBe(400);
  });

  it("refuses to finish a Chapter while some of its Sentences have no timing", async () => {
    const t = await testApp();
    await parsedBook(t);
    const job = await claimRender(t.app);
    const report = await renderAll(t.storage, job);

    const res = await reportRenderResult(t.app, job, { segments: report.segments, sentences: report.sentences.slice(1) });

    expect(res.status).toBe(400);
  });
});

describe("the Book's playlist", () => {
  it("is one HLS stream of the narrated Chapters in order, without the Skipped one, and every segment comes from storage", async () => {
    const t = await testApp();
    const book = await parsedBook(t);
    const first = await claimRender(t.app);
    const second = await claimRender(t.app);
    await reportRenderResult(t.app, first, await renderAll(t.storage, first, 10_000));
    await reportRenderResult(t.app, second, await renderAll(t.storage, second, 9_500));

    const m3u8 = await playlist(t.app, book.id);

    expect(m3u8.split("\n").filter((l) => l.startsWith("#EXT-X-") || l.startsWith("#EXTINF"))).toEqual([
      "#EXT-X-VERSION:3",
      "#EXT-X-PLAYLIST-TYPE:EVENT",
      "#EXT-X-TARGETDURATION:10",
      "#EXT-X-MEDIA-SEQUENCE:0",
      "#EXTINF:10.000,",
      "#EXTINF:10.000,",
      "#EXT-X-DISCONTINUITY",
      "#EXTINF:9.500,",
      "#EXTINF:9.500,",
      "#EXTINF:9.500,",
      "#EXT-X-ENDLIST",
    ]);
    const bodies = [];
    for (const url of segmentUrls(m3u8, book.id)) {
      const res = await t.app.request(url);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("video/mp2t");
      bodies.push(await res.text());
    }
    expect(bodies).toEqual([...first.sentences, ...second.sentences].map((s) => `audio of ${s.id}`));
  });

  it("while generating, holds only what plays without a gap: it stops before the first narrated Chapter not yet generated", async () => {
    const t = await testApp();
    const book = await parsedBook(t);
    const first = await claimRender(t.app);
    const second = await claimRender(t.app);
    const firstReport = await renderAll(t.storage, first);
    await reportRenderProgress(t.app, first, { segments: firstReport.segments.slice(0, 1), sentences: [] });
    // Another worker finishes Chapter II before Chapter I is done.
    await reportRenderResult(t.app, second, await renderAll(t.storage, second));

    const m3u8 = await playlist(t.app, book.id);

    expect(segmentUrls(m3u8, book.id)).toHaveLength(1);
    expect(m3u8).not.toContain("#EXT-X-ENDLIST");
    // Chapter II's place in the Book is not known yet, so neither are its Sentences' times.
    const two = await sentencesOf(t.app, (await bookDetail(t.app, book.id)).chapters[2]!.id);
    expect(two.every((s) => s.startMs === null)).toBe(true);
  });

  it("is empty and the Book not playable before any segment is written", async () => {
    const t = await testApp();
    const book = await parsedBook(t);
    expect(segmentUrls(await playlist(t.app, book.id), book.id)).toEqual([]);
    expect((await bookDetail(t.app, book.id)).playable).toBe(false);
  });

  it("is not served for another user's Book, nor are its segments", async () => {
    const t = await testApp();
    const book = await parsedBook(t);
    const job = await claimRender(t.app);
    await reportRenderResult(t.app, job, await renderAll(t.storage, job));
    const [url] = segmentUrls(await playlist(t.app, book.id), book.id);

    const [other] = await t.db.insert(users).values({ email: "other@example.com" }).returning();
    await t.db.update(books).set({ ownerId: other!.id });

    expect((await t.app.request(`/api/books/${book.id}/audio.m3u8`)).status).toBe(404);
    expect((await t.app.request(url!)).status).toBe(404);
  });
});

describe("a render job that runs longer than the lease", () => {
  it("stays with its worker while it sends heartbeats, and is not handed to another worker", async () => {
    const t = await testApp();
    await parsedBook(t);
    const job = await claimRender(t.app);
    const other = await claimRender(t.app);
    await reportRenderResult(t.app, other, await renderAll(t.storage, other)); // now only a re-claim could hand out a job

    for (let i = 0; i < 5; i++) {
      t.clock.advance(TEST_LEASE_MS / 2);
      expect((await heartbeat(t.app, job)).status).toBe(204);
      expect(await claimJob(t.app)).toBeUndefined();
    }
    // 2.5 leases later the worker finishes, under its original attempt.
    expect((await reportRenderResult(t.app, job, await renderAll(t.storage, job))).status).toBe(204);
  });

  it("is handed to another worker once heartbeats stop, and the old worker's heartbeat is then refused", async () => {
    const t = await testApp();
    await parsedBook(t);
    const job = await claimRender(t.app);
    await claimRender(t.app);
    t.clock.advance(TEST_LEASE_MS / 2);
    await heartbeat(t.app, job);

    t.clock.advance(TEST_LEASE_MS + 1);
    const retry = await claimRender(t.app);

    expect(retry).toMatchObject({ id: job.id, chapterId: job.chapterId, attempt: 2 });
    expect(retry.audioPrefix).not.toBe(job.audioPrefix);
    expect((await heartbeat(t.app, job)).status).toBe(409);
  });

  it("keeps what the dead claim published when claimed again: the Book stays playable and the playlist only grows", async () => {
    const t = await testApp();
    const book = await parsedBook(t);
    const dead = await claimRender(t.app);
    const deadReport = await renderAll(t.storage, dead);
    await reportRenderProgress(t.app, dead, { segments: deadReport.segments.slice(0, 1), sentences: deadReport.sentences.slice(0, 1) });
    await claimRender(t.app);
    const before = segmentUrls(await playlist(t.app, book.id), book.id);

    t.clock.advance(TEST_LEASE_MS + 1);
    const retry = await claimRender(t.app);

    expect(segmentUrls(await playlist(t.app, book.id), book.id)).toEqual(before);
    expect((await bookDetail(t.app, book.id)).playable).toBe(true);
    // The new claim renders the whole Chapter again; only what comes after the published segment is added.
    expect((await reportRenderResult(t.app, retry, await renderAll(t.storage, retry))).status).toBe(204);
    const after = segmentUrls(await playlist(t.app, book.id), book.id);
    expect(after).toHaveLength(2);
    expect(after[0]).toBe(before[0]);
    expect(await (await t.app.request(after[0]!)).text()).toBe(`audio of ${dead.sentences[0]!.id}`);
  });

  it("keeps the segments a Chapter published before it failed, and the Chapters after it follow on", async () => {
    const t = await testApp();
    const book = await parsedBook(t);
    const first = await claimRender(t.app);
    const second = await claimRender(t.app);
    const firstReport = await renderAll(t.storage, first);
    await reportRenderProgress(t.app, first, { segments: firstReport.segments.slice(0, 1), sentences: [] });
    const before = segmentUrls(await playlist(t.app, book.id), book.id);

    await failForGood(t.app, first, "kokoro crashed");
    await reportRenderResult(t.app, second, await renderAll(t.storage, second));

    const after = segmentUrls(await playlist(t.app, book.id), book.id);
    expect(after.slice(0, 1)).toEqual(before);
    expect(after).toHaveLength(4);
    expect(await bookDetail(t.app, book.id)).toMatchObject({ status: "ready", playable: true });
  });

  it("fails only its Chapter after 3 expired leases; the Book is not parse_failed", async () => {
    const t = await testApp();
    const book = await parsedBook(t);
    const other = await claimRender(t.app);
    await reportRenderResult(t.app, other, await renderAll(t.storage, other));

    for (const attempt of [1, 2, 3]) {
      expect((await claimRender(t.app)).attempt).toBe(attempt);
      t.clock.advance(TEST_LEASE_MS + 1);
    }
    expect(await claimJob(t.app)).toBeUndefined();

    const d = await bookDetail(t.app, book.id);
    expect(d).toMatchObject({ status: "ready", failureReason: null });
    expect(d.chapters.map((c) => c.audioStatus)).toEqual(["generated", "pending", "failed"]);
  });
});

describe("claim order across Books", () => {
  it("hands out a newly uploaded Book's parse and first Chapter before an older Book's later Chapters", async () => {
    const t = await testApp();
    const older = await parsedBook(t);
    const olderFirst = await claimRender(t.app);
    expect(olderFirst.bookId).toBe(older.id);

    const newer = await uploadBook(t.app);
    const parse = (await claimJob(t.app))!;
    expect(parse).toMatchObject({ type: "parse", bookId: newer.id });
    await reportParse(t.app, parse, parsed);

    const [newerFirst, olderSecond] = [await claimRender(t.app), await claimRender(t.app)];
    const newerChapters = (await bookDetail(t.app, newer.id)).chapters;
    expect(newerFirst.chapterId).toBe(newerChapters[0]!.id);
    expect(olderSecond.bookId).toBe(older.id);
  });
});

