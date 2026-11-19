// Functional tests of what the settings page shows about the user's quotas (PRD F15, 4.7.2) through the HTTP API:
// today's AI calls left and uploaded Books held, counted by the same code that enforces each limit.
import { describe, expect, it } from "vitest";
import { DAILY_AI_CALLS, MAX_UPLOADED_BOOKS, type ParseResult, type Sentence, type Usage } from "../src/contract.js";
import { allowlist, books } from "../src/db/schema.js";
import { generatedBook, logIn, testApp, uploadBook, withCookie, type TestApp } from "./helpers.js";

const CHAPTERS: ParseResult["chapters"] = [
  { title: "Chapter 1", sentences: [{ paragraphIndex: 0, text: "It is a truth.", spokenText: "It is a truth." }] },
];

async function usage(app: TestApp): Promise<Usage> {
  const res = await app.request("/api/me/usage");
  expect(res.status).toBe(200);
  return (await res.json()) as Usage;
}

function explain(app: TestApp, sentenceId: string) {
  return app.request(`/api/sentences/${sentenceId}/explanation`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "explain" }),
  });
}

/** Makes `n` AI calls (each regenerates the Explanation, which counts) and reads each stream to its end. */
async function callAi(app: TestApp, sentenceId: string, n: number) {
  for (let i = 0; i < n; i++) {
    const res = await explain(app, sentenceId);
    expect(res.status).toBe(200);
    await res.text();
  }
}

/** A Library Book the 书库 lists (ready, nothing left to generate), put on the user's Shelf through the API. */
async function shelveLibraryBook(t: Awaited<ReturnType<typeof testApp>>) {
  const id = crypto.randomUUID();
  await t.db.insert(books).values({
    id,
    source: "library",
    title: "Emma",
    fileSize: 1,
    status: "ready",
    libraryKey: "jane-austen/emma",
    difficulty: "beginner",
    blurb: "简介",
  });
  expect((await t.app.request(`/api/books/${id}/shelf`, { method: "PUT" })).status).toBe(204);
}

describe("GET /api/me/usage (设置页 quotas)", () => {
  it("starts with every AI call of the day left and no uploads", async () => {
    const { app } = await testApp();
    expect(await usage(app)).toEqual({
      aiRemaining: DAILY_AI_CALLS,
      aiDailyLimit: DAILY_AI_CALLS,
      uploadedBooks: 0,
      maxUploadedBooks: MAX_UPLOADED_BOOKS,
    });
  });

  it("shows 3 / 20 and 95 left after 3 uploads and 5 AI calls (AC-SET-01)", async () => {
    const t = await testApp();
    const book = await generatedBook(t, "Pride and Prejudice", CHAPTERS);
    await uploadBook(t.app, "two.epub");
    await uploadBook(t.app, "three.epub");
    const [sentence] = (await (await t.app.request(`/api/chapters/${book.chapters[0]!.id}/sentences`)).json()) as Sentence[];
    await callAi(t.app, sentence!.id, 5);

    expect(await usage(t.app)).toMatchObject({ aiRemaining: DAILY_AI_CALLS - 5, uploadedBooks: 3 });
  });

  it("does not count Library Books on the Shelf as uploads", async () => {
    const t = await testApp();
    await uploadBook(t.app, "mine.epub");
    await shelveLibraryBook(t);

    expect((await usage(t.app)).uploadedBooks).toBe(1);
  });

  it("frees an upload's place when the Book is deleted", async () => {
    const t = await testApp();
    const book = await uploadBook(t.app, "gone.epub");
    expect((await t.app.request(`/api/books/${book.id}`, { method: "DELETE" })).status).toBe(204);

    expect((await usage(t.app)).uploadedBooks).toBe(0);
  });

  it("gives back the day's AI calls at 00:00 Beijing time", async () => {
    const t = await testApp();
    const book = await generatedBook(t, "Pride and Prejudice", CHAPTERS);
    const [sentence] = (await (await t.app.request(`/api/chapters/${book.chapters[0]!.id}/sentences`)).json()) as Sentence[];
    // The test clock starts at 08:00 Beijing time.
    await callAi(t.app, sentence!.id, 2);
    t.clock.advance(15 * 60 * 60 * 1000 + 59 * 60 * 1000); // 23:59
    expect((await usage(t.app)).aiRemaining).toBe(DAILY_AI_CALLS - 2);

    t.clock.advance(60 * 1000); // 00:00 the next day
    expect((await usage(t.app)).aiRemaining).toBe(DAILY_AI_CALLS);
  });

  it("counts only the user's own calls and uploads", async () => {
    const t = await testApp();
    const book = await generatedBook(t, "Pride and Prejudice", CHAPTERS);
    const [sentence] = (await (await t.app.request(`/api/chapters/${book.chapters[0]!.id}/sentences`)).json()) as Sentence[];
    await callAi(t.app, sentence!.id, 1);
    await t.db.insert(allowlist).values({ email: "other@example.com" });
    const other = withCookie(t.anon, await logIn(t, "other@example.com"));

    expect(await usage(other)).toMatchObject({ aiRemaining: DAILY_AI_CALLS, uploadedBooks: 0 });
  });

  it("is 401 without a session", async () => {
    const { anon } = await testApp();
    expect((await anon.request("/api/me/usage")).status).toBe(401);
  });
});
