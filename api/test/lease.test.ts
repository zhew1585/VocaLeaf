// Functional tests for job leases: a worker that claims a job and dies must not strand the Book.
import { describe, expect, it } from "vitest";
import type { BookDetail, ParseResult, Sentence } from "../src/contract.js";
import {
  claimJob,
  reportFailure,
  reportParse,
  TEST_LEASE_MS,
  testApp,
  uploadBook,
  type TestApp,
} from "./helpers.js";

const parsed: Omit<ParseResult, "attempt"> = {
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
  ],
};

async function detail(app: TestApp, id: string) {
  return (await (await app.request(`/api/books/${id}`)).json()) as BookDetail;
}

async function sentencesOf(app: TestApp, chapterId: string) {
  return (await (await app.request(`/api/chapters/${chapterId}/sentences`)).json()) as Sentence[];
}

describe("a worker that dies after claiming a parse job", () => {
  it("keeps the job with its first worker until the lease expires", async () => {
    const { app, clock } = await testApp();
    await uploadBook(app);
    await claimJob(app);

    clock.advance(TEST_LEASE_MS - 1);

    expect(await claimJob(app)).toBeUndefined();
  });

  it("lets another worker claim it once the lease expires and finish the Book", async () => {
    const { app, clock } = await testApp();
    const book = await uploadBook(app);
    const crashed = (await claimJob(app))!;
    expect(crashed.attempt).toBe(1);

    clock.advance(TEST_LEASE_MS + 1);
    const retry = (await claimJob(app))!;

    expect(retry).toMatchObject({ id: crashed.id, bookId: book.id, attempt: 2 });
    expect((await reportParse(app, retry, parsed)).status).toBe(204);
    const d = await detail(app, book.id);
    expect(d).toMatchObject({ status: "generating", failureReason: null });
    expect(d.chapters.map((c) => [c.title, c.sentenceCount])).toEqual([["Chapter 1", 2]]);
    expect((await sentencesOf(app, d.chapters[0]!.id)).map((s) => s.text)).toEqual([
      "It is a truth universally acknowledged.",
      "However little known.",
    ]);
  });

  it("gives up after 3 expired attempts: the job is not handed out again and the Book is parse_failed", async () => {
    const { app, clock } = await testApp();
    const book = await uploadBook(app);

    for (const attempt of [1, 2, 3]) {
      expect((await claimJob(app))?.attempt).toBe(attempt);
      clock.advance(TEST_LEASE_MS + 1);
    }

    expect(await claimJob(app)).toBeUndefined();
    expect(await detail(app, book.id)).toMatchObject({
      status: "parse_failed",
      failureReason: "解析超时，请删除后重新上传",
      chapters: [],
    });
  });

  it("still hands out other queued jobs while one Book gives up", async () => {
    const { app, clock } = await testApp();
    await uploadBook(app, "a.epub");
    for (let i = 0; i < 3; i++) {
      await claimJob(app);
      clock.advance(TEST_LEASE_MS + 1);
    }
    const other = await uploadBook(app, "b.epub");

    expect((await claimJob(app))?.bookId).toBe(other.id);
  });
});

describe("late reports from a worker whose lease was taken over", () => {
  it("are refused once the job has been claimed again, and the new worker still finishes", async () => {
    const { app, clock } = await testApp();
    const book = await uploadBook(app);
    const late = (await claimJob(app))!;
    clock.advance(TEST_LEASE_MS + 1);
    const current = (await claimJob(app))!;

    expect((await reportParse(app, late, { ...parsed, title: "Stale" })).status).toBe(409);
    expect((await reportFailure(app, late, "stale failure")).status).toBe(409);
    expect((await detail(app, book.id)).status).toBe("parsing");

    expect((await reportParse(app, current, parsed)).status).toBe(204);
    expect((await detail(app, book.id)).title).toBe("Pride and Prejudice");
  });

  it("are refused after the new worker has finished, leaving its result untouched", async () => {
    const { app, clock } = await testApp();
    const book = await uploadBook(app);
    const late = (await claimJob(app))!;
    clock.advance(TEST_LEASE_MS + 1);
    const current = (await claimJob(app))!;
    await reportParse(app, current, parsed);
    const before = await detail(app, book.id);
    const sentenceIds = (await sentencesOf(app, before.chapters[0]!.id)).map((s) => s.id);

    const stale = { ...parsed, title: "Stale", chapters: [{ title: "Stale", sentences: [] }] };
    expect((await reportParse(app, late, stale)).status).toBe(409);
    expect((await reportFailure(app, late, "stale failure")).status).toBe(409);

    expect(await detail(app, book.id)).toEqual(before);
    expect((await sentencesOf(app, before.chapters[0]!.id)).map((s) => s.id)).toEqual(sentenceIds);
  });

  it("are accepted when the lease ran out but nobody took the job over", async () => {
    const { app, clock } = await testApp();
    const book = await uploadBook(app);
    const slow = (await claimJob(app))!;
    clock.advance(TEST_LEASE_MS + 1);

    expect((await reportParse(app, slow, parsed)).status).toBe(204);
    expect((await detail(app, book.id)).status).toBe("generating");
    expect(await claimJob(app)).toBeUndefined();
  });
});

describe("concurrent claims", () => {
  it("hand one job to exactly one worker", async () => {
    const { app } = await testApp();
    await uploadBook(app);

    const results = await Promise.all(Array.from({ length: 5 }, () => claimJob(app)));

    expect(results.filter(Boolean)).toHaveLength(1);
  });
});
