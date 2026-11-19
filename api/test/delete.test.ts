// Functional tests for deleting a Book (#8, PRD 4.3.6): the user deletes through DELETE /api/books/:id while the
// worker side is driven only through the /internal HTTP protocol, as the real worker does.
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Book, ClaimedRenderJob, ParseResult } from "../src/contract.js";
import { allowlist, auditLog, audioSegments, books, chapters, jobs, sentences } from "../src/db/schema.js";
import {
  bookDetail,
  claimJob,
  heartbeat,
  logIn,
  READER_EMAIL,
  renderAll,
  reportFailure,
  reportParse,
  reportRenderProgress,
  reportRenderResult,
  testApp,
  uploadBook,
  withCookie,
  type TestApp,
} from "./helpers.js";

type T = Awaited<ReturnType<typeof testApp>>;

const sentence = (text: string) => ({ paragraphIndex: 0, text, spokenText: text });

const parsed: Omit<ParseResult, "attempt"> = {
  parserVersion: "test-1",
  title: "Pride and Prejudice",
  author: "Jane Austen",
  chapters: [
    { title: "I", sentences: [sentence("It is a truth universally acknowledged."), sentence("However little known.")] },
    { title: "II", sentences: [sentence("Mr. Bennet was among the earliest.")] },
  ],
};

function deleteBook(app: TestApp, id: string) {
  return app.request(`/api/books/${id}`, { method: "DELETE" });
}

/** Uploads a Book and lets the worker parse it: generating, with both Chapters queued. */
async function generatingBook(t: T) {
  const book = await uploadBook(t.app);
  const job = (await claimJob(t.app))!;
  expect((await reportParse(t.app, job, parsed)).status).toBe(204);
  return book;
}

/** Every row and object the Book left behind, so a test can check nothing of it is left. */
async function leftovers(t: T, bookId: string) {
  const chapterIds = (await t.db.select({ id: chapters.id }).from(chapters).where(eq(chapters.bookId, bookId))).map(
    (c) => c.id,
  );
  return {
    books: (await t.db.select().from(books).where(eq(books.id, bookId))).length,
    chapters: chapterIds.length,
    jobs: (await t.db.select().from(jobs).where(eq(jobs.bookId, bookId))).length,
    sentences: (await t.db.select().from(sentences).innerJoin(chapters, eq(chapters.id, sentences.chapterId)).where(eq(chapters.bookId, bookId))).length,
    segments: (await t.db.select().from(audioSegments).innerJoin(chapters, eq(chapters.id, audioSegments.chapterId)).where(eq(chapters.bookId, bookId))).length,
    objects: [...t.storage.objects.keys()].filter((k) => k.startsWith(`books/${bookId}/`)),
  };
}

const NOTHING_LEFT = { books: 0, chapters: 0, jobs: 0, sentences: 0, segments: 0, objects: [] };

describe("DELETE /api/books/:id", () => {
  it("deletes a 解析中 Book: its file and its parse job go, and the worker gets nothing to do", async () => {
    const t = await testApp();
    const book = await uploadBook(t.app);

    expect((await deleteBook(t.app, book.id)).status).toBe(204);

    expect((await t.app.request(`/api/books/${book.id}`)).status).toBe(404);
    expect((await (await t.app.request("/api/books")).json()) as Book[]).toEqual([]);
    expect(await leftovers(t, book.id)).toEqual(NOTHING_LEFT);
    expect(await claimJob(t.app)).toBeUndefined();
  });

  it("deletes a 生成中 Book mid-generation: text, audio and jobs go, and the worker's claim is cancelled", async () => {
    const t = await testApp();
    const book = await generatingBook(t);
    // The first Chapter is generated and playable; the worker is halfway through the second.
    const first = (await claimJob(t.app)) as ClaimedRenderJob;
    expect((await reportRenderResult(t.app, first, await renderAll(t.storage, first))).status).toBe(204);
    const second = (await claimJob(t.app)) as ClaimedRenderJob;
    expect((await reportRenderProgress(t.app, second, await renderAll(t.storage, second))).status).toBe(204);
    expect((await bookDetail(t.app, book.id)).playable).toBe(true);

    expect((await deleteBook(t.app, book.id)).status).toBe(204);

    expect(await leftovers(t, book.id)).toEqual(NOTHING_LEFT);
    expect((await t.app.request(`/api/books/${book.id}/audio.m3u8`)).status).toBe(404);
    // The worker learns at its next heartbeat or report that the job is gone, and drops it.
    expect((await heartbeat(t.app, second)).status).toBe(409);
    expect((await reportFailure(t.app, second, "boom")).status).toBe(409);
    expect(await claimJob(t.app)).toBeUndefined();
  });

  it("deletes the segments a worker writes after the Book was deleted, when it reports them", async () => {
    const t = await testApp();
    const book = await generatingBook(t);
    const job = (await claimJob(t.app)) as ClaimedRenderJob;
    expect((await deleteBook(t.app, book.id)).status).toBe(204);

    // Still unaware, the worker writes its segments and reports them; the report is refused.
    const report = await renderAll(t.storage, job);
    expect(report.segments.length).toBeGreaterThan(0);
    expect((await reportRenderProgress(t.app, job, report)).status).toBe(409);

    expect((await leftovers(t, book.id)).objects).toEqual([]);
  });

  it("leaves a superseded claim's objects alone: only a deleted Book's audio is cleaned up after a refused report", async () => {
    const t = await testApp();
    const book = await generatingBook(t);
    const job = (await claimJob(t.app)) as ClaimedRenderJob;
    const report = await renderAll(t.storage, job);
    expect((await reportRenderResult(t.app, job, report)).status).toBe(204);

    // A late duplicate of the last report: the job already finished, the Book is still there.
    expect((await reportRenderResult(t.app, job, report)).status).toBe(409);

    expect((await leftovers(t, book.id)).objects).toEqual(
      expect.arrayContaining(report.segments.map((s) => s.key)),
    );
  });

  it("deletes a 解析失败 Book", async () => {
    const t = await testApp();
    const book = await uploadBook(t.app);
    const job = (await claimJob(t.app))!;
    expect((await reportFailure(t.app, job, "DRM", "drm")).status).toBe(204);
    expect((await bookDetail(t.app, book.id)).status).toBe("parse_failed");

    expect((await deleteBook(t.app, book.id)).status).toBe(204);
    expect(await leftovers(t, book.id)).toEqual(NOTHING_LEFT);
  });

  it("writes the deletion to the audit log: who, when, which Book, and the result (PRD 4.6.2)", async () => {
    const t = await testApp();
    const book = await uploadBook(t.app, "Emma.epub");

    expect((await deleteBook(t.app, book.id)).status).toBe(204);

    const log = await t.db.select().from(auditLog);
    expect(log).toMatchObject([
      { actor: READER_EMAIL, action: "book_delete", target: `${book.id} 《Emma》`, result: "deleted" },
    ]);
    expect(log[0]!.createdAt).toBeInstanceOf(Date);
  });

  it("keeps the user's other Books, and lets them upload again right away", async () => {
    const t = await testApp();
    const kept = await uploadBook(t.app, "Emma.epub");
    const gone = await uploadBook(t.app, "Persuasion.epub");

    expect((await deleteBook(t.app, gone.id)).status).toBe(204);

    expect(((await (await t.app.request("/api/books")).json()) as Book[]).map((b) => b.title)).toEqual(["Emma"]);
    expect(t.storage.objects.has(`books/${kept.id}/source.epub`)).toBe(true);
    const again = await uploadBook(t.app, "Persuasion.epub");
    expect(again.status).toBe("parsing");
  });

  it("answers 404 for another user's Book and for an unknown one, and deletes nothing", async () => {
    const t = await testApp();
    const theirs = await uploadBook(t.app);
    await t.db.insert(allowlist).values({ email: "other@example.com" });
    const other = withCookie(t.anon, await logIn(t, "other@example.com"));

    expect((await deleteBook(other, theirs.id)).status).toBe(404);
    expect((await deleteBook(t.app, crypto.randomUUID())).status).toBe(404);
    expect((await deleteBook(t.app, "not-a-uuid")).status).toBe(400);

    expect((await bookDetail(t.app, theirs.id)).id).toBe(theirs.id);
    expect(await t.db.select().from(auditLog)).toEqual([]);
  });

  it("needs a session", async () => {
    const t = await testApp();
    const book = await uploadBook(t.app);
    expect((await deleteBook(t.anon, book.id)).status).toBe(401);
    expect((await bookDetail(t.app, book.id)).id).toBe(book.id);
  });

  it("answers 404 when the Book was already deleted", async () => {
    const t = await testApp();
    const book = await uploadBook(t.app);
    expect((await deleteBook(t.app, book.id)).status).toBe(204);
    expect((await deleteBook(t.app, book.id)).status).toBe(404);
    expect(await t.db.select().from(auditLog)).toHaveLength(1);
  });
});
