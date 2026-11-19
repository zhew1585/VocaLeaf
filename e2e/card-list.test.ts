// End-to-end: the Card list (#17, F14) on the running compose stack, as a user of its own so the list holds only
// this test's Cards. A Card outlives its deleted Book with its audio (AC-CLIST-03); 【重新生成】 keeps its next Review
// (AC-CLIST-04); deleting it removes its audio from RustFS. Needs `npm run e2e:up`.
import { beforeAll, describe, expect, it } from "vitest";
import type { BookDetail, Card, CardListItem, Sentence } from "../api/src/contract.js";
import { endOpenJobs, fetchBytes, newUser, SHORT_WALK } from "./support.js";

/** Generating both short Chapters on CPU. */
const GENERATE_MS = 240_000;

describe("the Card list through the stack", () => {
  beforeAll(() => endOpenJobs());

  it("lists a Card, keeps it with its audio once its Book is deleted, and deletes it for good", async () => {
    const user = await newUser("card-list");
    const created = await user.upload("short-walk.epub", SHORT_WALK);
    expect(created.status).toBe(201);
    const bookId = created.body.id;

    // Polled with this user's own session (waitForBook is the file user's).
    const deadline = Date.now() + GENERATE_MS;
    let book = (await user.api<BookDetail>(`/books/${bookId}`)).body;
    while (book.status !== "ready") {
      if (Date.now() > deadline) throw new Error(`book ${bookId} still ${book.status}`);
      await new Promise((r) => setTimeout(r, 500));
      book = (await user.api<BookDetail>(`/books/${bookId}`)).body;
    }
    const chapter = book.chapters.find((c) => !c.skipped)!;
    const sentence = (await user.api<Sentence[]>(`/chapters/${chapter.id}/sentences`)).body.find((s) => /\w+ \w+/.test(s.text))!;
    const word = /[A-Za-z]{3,}/.exec(sentence.text)!;
    const made = await user.api<Card>("/cards", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sentenceId: sentence.id, start: word.index, end: word.index + word[0].length }),
    });
    expect(made.status).toBe(201);
    const id = made.body.id;

    const listed = await user.api<CardListItem[]>("/cards");
    expect(listed).toMatchObject({ status: 200, body: [{ id, bookId, targetText: word[0], bookTitle: book.title }] });

    // 【重新生成】: a new back, the same next Review (AC-CLIST-04).
    const regenerated = await user.api<Card>(`/cards/${id}/back`, { method: "POST" });
    expect(regenerated).toMatchObject({ status: 200, body: { id, due: made.body.due, back: { kind: "word" } } });

    // The Book goes; the Card stays, without it, and still plays (AC-CLIST-03).
    const audio = await fetchBytes(`/api/cards/${id}/audio`, user.cookie);
    expect(audio.status).toBe(200);
    expect((await user.api(`/books/${bookId}`, { method: "DELETE" })).status).toBe(204);
    expect((await user.api<CardListItem[]>("/cards")).body).toMatchObject([{ id, bookId: null, sentenceId: null, bookTitle: book.title }]);
    expect(await fetchBytes(`/api/cards/${id}/audio`, user.cookie)).toEqual(audio);

    // Deleted for good, its audio too (AC-CLIST-02).
    expect((await user.api(`/cards/${id}`, { method: "DELETE" })).status).toBe(204);
    expect((await user.api<CardListItem[]>("/cards")).body).toEqual([]);
    expect((await fetchBytes(`/api/cards/${id}/audio`, user.cookie)).status).toBe(404);
  });
});
