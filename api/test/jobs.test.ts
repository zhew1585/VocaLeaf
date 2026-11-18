import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { ClaimedJob, ParseResult } from "../src/contract.js";
import { jobs } from "../src/db/schema.js";
import {
  bookDetail,
  claim,
  postJson,
  reportFailure,
  reportParse,
  testApp,
  uploadBook,
  type TestApp,
} from "./helpers.js";

const result: Omit<ParseResult, "attempt"> = {
  parserVersion: "test-1",
  title: "Pride and Prejudice",
  author: "Jane Austen",
  chapters: [
    {
      title: "Chapter 1",
      sentences: [
        { paragraphIndex: 0, text: "It is a truth universally acknowledged.", spokenText: "It is a truth universally acknowledged." },
        { paragraphIndex: 1, text: "However little known.", spokenText: "However little known." },
      ],
    },
    { title: null, sentences: [{ paragraphIndex: 0, text: "Mr. Bennet was among.", spokenText: "Mr. Bennet was among." }] },
  ],
};

async function claimedJob(app: TestApp) {
  const book = await uploadBook(app);
  const job = (await (await claim(app)).json()) as ClaimedJob;
  return { book, job };
}


describe("worker auth", () => {
  it("rejects /internal calls without the worker token", async () => {
    const { app } = await testApp();
    const res = await app.request("/api/internal/jobs/claim", { method: "POST" });
    expect(res.status).toBe(401);
  });
});

describe("POST /api/internal/jobs/claim", () => {
  it("returns 204 when nothing is queued", async () => {
    const { app } = await testApp();
    expect((await claim(app)).status).toBe(204);
  });

  it("hands out a queued parse job once, with the source key, and marks it running", async () => {
    const { app, db } = await testApp();
    const book = await uploadBook(app);

    const res = await claim(app);
    expect(res.status).toBe(200);
    const job = (await res.json()) as ClaimedJob;
    expect(job).toMatchObject({ type: "parse", bookId: book.id, sourceKey: `books/${book.id}/source.epub` });

    const [row] = await db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(row).toMatchObject({ status: "running", attempt: 1 });
    expect((await claim(app)).status).toBe(204);
  });

  it("hands out jobs oldest first", async () => {
    const { app } = await testApp();
    const first = await uploadBook(app, "a.epub");
    const second = await uploadBook(app, "b.epub");
    expect(((await (await claim(app)).json()) as ClaimedJob).bookId).toBe(first.id);
    expect(((await (await claim(app)).json()) as ClaimedJob).bookId).toBe(second.id);
  });
});

describe("POST /api/internal/jobs/:id/parse-result", () => {
  it("stores Chapters and Sentences and moves the Book to generating", async () => {
    const { app } = await testApp();
    const { book, job } = await claimedJob(app);

    const res = await reportParse(app, job, result);
    expect(res.status).toBe(204);

    const d = await bookDetail(app, book.id);
    expect(d).toMatchObject({ title: "Pride and Prejudice", author: "Jane Austen", status: "generating" });
    expect(d.chapters.map((c) => [c.index, c.title, c.sentenceCount, c.skipped, c.audioStatus])).toEqual([
      [0, "Chapter 1", 2, false, "pending"],
      [1, "第 2 章", 1, false, "pending"],
    ]);
  });

  it("stores books larger than one insert batch", async () => {
    const { app } = await testApp();
    const { book, job } = await claimedJob(app);
    const many = Array.from({ length: 12_001 }, (_, i) => ({ paragraphIndex: i, text: `S${i}.`, spokenText: `S${i}.` }));
    const res = await reportParse(app, job, {
      ...result,
      chapters: [{ title: "Long", sentences: many }],
    });
    expect(res.status).toBe(204);
    expect((await bookDetail(app, book.id)).chapters[0]!.sentenceCount).toBe(12_001);
  });

  it("keeps the file-name title when the EPUB has no title", async () => {
    const { app } = await testApp();
    const { book, job } = await claimedJob(app);
    await reportParse(app, job, { ...result, title: null, author: null });
    expect(await bookDetail(app, book.id)).toMatchObject({ title: "Pride and Prejudice", author: null });
  });

  it("refuses a second report for the same job", async () => {
    const { app } = await testApp();
    const { job } = await claimedJob(app);
    await reportParse(app, job, result);
    const again = await reportParse(app, job, result);
    expect(again.status).toBe(409);
  });

  it("refuses a job that was never claimed", async () => {
    const { app, db } = await testApp();
    const book = await uploadBook(app);
    const [queued] = await db.select().from(jobs).where(eq(jobs.bookId, book.id));
    const res = await reportParse(app, { id: queued!.id, attempt: 1 }, result);
    expect(res.status).toBe(409);
  });

  it("rejects a result without Chapters", async () => {
    const { app } = await testApp();
    const { job } = await claimedJob(app);
    const res = await reportParse(app, job, { ...result, chapters: [] });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/internal/jobs/:id/failure", () => {
  it("marks the job failed and the Book parse_failed", async () => {
    const { app, db } = await testApp();
    const { book, job } = await claimedJob(app);

    const res = await reportFailure(app, job, "BadZipFile: not a zip");
    expect(res.status).toBe(204);
    expect((await bookDetail(app, book.id)).status).toBe("parse_failed");
    const [row] = await db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(row).toMatchObject({ status: "failed", error: "BadZipFile: not a zip" });
  });

  // PRD 4.3.5 #4 to #6, AC-UP-05: the user sees why, and the Book stays 解析失败 for good.
  it.each([
    ["drm", "该文件受 DRM 保护，无法转换。请使用无 DRM 的 EPUB"],
    ["unreadable", "文件无法读取，可能已损坏"],
    ["no_text", "没有识别到可朗读的正文"],
  ] as const)("shows the %s reason with the parse_failed Book, and never parses it again", async (reason, message) => {
    const { app } = await testApp();
    const { book, job } = await claimedJob(app);

    expect((await reportFailure(app, job, "ParseFailed: details for the log", reason)).status).toBe(204);

    expect(await bookDetail(app, book.id)).toMatchObject({ status: "parse_failed", failureReason: message, chapters: [] });
    expect((await claim(app)).status).toBe(204);
  });

  it("tells the user the file could not be read when a parse fails without a reason", async () => {
    const { app } = await testApp();
    const { book, job } = await claimedJob(app);

    await reportFailure(app, job, "RuntimeError: boom");

    expect((await bookDetail(app, book.id)).failureReason).toBe("文件无法读取，可能已损坏");
  });

  it("rejects an unknown reason", async () => {
    const { app } = await testApp();
    const { job } = await claimedJob(app);

    const res = await postJson(app, `/api/internal/jobs/${job.id}/failure`, { attempt: job.attempt, error: "x", reason: "bad" });

    expect(res.status).toBe(400);
  });
});

describe("worker protocol contract", () => {
  it("hands out the attempt with the job and requires it back on every report", async () => {
    const { app } = await testApp();
    const { job } = await claimedJob(app);
    expect(job.attempt).toBe(1);

    const withoutAttempt = { parserVersion: "x", title: null, author: null, chapters: [{ title: null, sentences: [] }] };
    expect((await postJson(app, `/api/internal/jobs/${job.id}/parse-result`, withoutAttempt)).status).toBe(400);
    expect((await reportParse(app, { id: job.id, attempt: 2 }, withoutAttempt)).status).toBe(409);
  });
});
