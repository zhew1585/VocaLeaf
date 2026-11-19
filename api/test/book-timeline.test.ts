// Functional tests of GET /api/books/:id/timeline, which the player steers by (重听, 下一句, 本章结束), through the
// HTTP API with the worker played over /internal.
import { describe, expect, it } from "vitest";
import type { BookTimeline, ClaimedRenderJob, ParseResult } from "../src/contract.js";
import { books, users } from "../src/db/schema.js";
import {
  claimJob,
  generatedBook,
  renderAll,
  reportParse,
  reportRenderProgress,
  reportRenderResult,
  testApp,
  uploadBook,
  type TestApp,
} from "./helpers.js";

const sentence = (text: string) => ({ paragraphIndex: 0, text, spokenText: text });

/** Rendered 4 s per Sentence: I runs 0 to 8 s, the Skipped Imprint has no audio, II runs 8 to 20 s. */
const CHAPTERS: ParseResult["chapters"] = [
  { title: "I", sentences: [sentence("It is a truth."), sentence("However little known.")] },
  { title: "Imprint", skipped: true, sentences: [sentence("This ebook is in the public domain.")] },
  { title: "II", sentences: [sentence("Mr. Bennet was among the earliest."), sentence("He had always intended."), sentence("Observing.")] },
];

async function timeline(app: TestApp, bookId: string) {
  const res = await app.request(`/api/books/${bookId}/timeline`);
  expect(res.status).toBe(200);
  return (await res.json()) as BookTimeline;
}

describe("GET /api/books/:id/timeline", () => {
  it("lists every Sentence start and every narrated Chapter's span in the Book's audio once generated", async () => {
    const t = await testApp();
    const book = await generatedBook(t, "Pride and Prejudice", CHAPTERS);
    const [one, , two] = book.chapters;

    const { sentenceIds: _, ...got } = await timeline(t.app, book.id);
    expect(got).toEqual({
      sentenceStartsMs: [0, 4000, 8000, 12000, 16000],
      chapters: [
        { id: one!.id, startMs: 0, endMs: 8000 },
        { id: two!.id, startMs: 8000, endMs: 20000 },
      ],
      complete: true,
    });
  });

  it("names the Sentence at each start, so the player can tell which one to mark (#13)", async () => {
    const t = await testApp();
    const book = await generatedBook(t, "Pride and Prejudice", CHAPTERS);
    const ids: string[] = [];
    for (const c of book.chapters.filter((c) => !c.skipped)) {
      const rows = (await (await t.app.request(`/api/chapters/${c.id}/sentences`)).json()) as { id: string }[];
      ids.push(...rows.map((s) => s.id));
    }

    expect((await timeline(t.app, book.id)).sentenceIds).toEqual(ids);
  });

  it("holds only what is generated so far, the generating Chapter's end unknown", async () => {
    const t = await testApp();
    const { id } = await uploadBook(t.app);
    const parse = (await claimJob(t.app))!;
    expect((await reportParse(t.app, parse, { parserVersion: "test-1", title: "P", author: null, chapters: CHAPTERS })).status).toBe(204);

    const first = (await claimJob(t.app)) as ClaimedRenderJob;
    expect((await reportRenderResult(t.app, first, await renderAll(t.storage, first))).status).toBe(204);
    const second = (await claimJob(t.app)) as ClaimedRenderJob;
    const report = await renderAll(t.storage, second);
    const partial = { segments: report.segments.slice(0, 1), sentences: report.sentences.slice(0, 1) };
    expect((await reportRenderProgress(t.app, second, partial)).status).toBe(204);

    const got = await timeline(t.app, id);
    expect(got.sentenceStartsMs).toEqual([0, 4000, 8000]);
    expect(got.chapters.map((c) => [c.startMs, c.endMs])).toEqual([
      [0, 8000],
      [8000, null],
    ]);
    expect(got.complete).toBe(false);
  });

  it("ends a generated Chapter while the next one has not started yet", async () => {
    const t = await testApp();
    const { id } = await uploadBook(t.app);
    const parse = (await claimJob(t.app))!;
    expect((await reportParse(t.app, parse, { parserVersion: "test-1", title: "P", author: null, chapters: CHAPTERS })).status).toBe(204);
    const first = (await claimJob(t.app)) as ClaimedRenderJob;
    expect((await reportRenderResult(t.app, first, await renderAll(t.storage, first))).status).toBe(204);

    const got = await timeline(t.app, id);
    expect(got.chapters.map((c) => [c.startMs, c.endMs])).toEqual([[0, 8000]]);
    expect(got.complete).toBe(false);
  });

  it("is empty while the Book is parsing", async () => {
    const t = await testApp();
    const { id } = await uploadBook(t.app);
    expect(await timeline(t.app, id)).toEqual({ sentenceStartsMs: [], sentenceIds: [], chapters: [], complete: true });
  });

  it("returns 404 for another user's Book", async () => {
    const { app, db } = await testApp();
    const [other] = await db.insert(users).values({ email: "other@example.com" }).returning();
    const otherId = crypto.randomUUID();
    await db.insert(books).values({ id: otherId, ownerId: other!.id, title: "x", fileSize: 1 });
    expect((await app.request(`/api/books/${otherId}/timeline`)).status).toBe(404);
  });
});
