// End-to-end: Marks and Gleanings (#13, PRD 4.4.2, 4.4.4) on the running compose stack with the real worker: mark the
// Sentence the timeline names, find it in Gleanings, Dismiss it, mark it again. Needs `npm run e2e:up`.
import { beforeEach, describe, expect, it } from "vitest";
import type { BookDetail, BookMarks, BookTimeline, Gleaning, MarkResult } from "../api/src/contract.js";
import { endOpenJobs, newUser, SHORT_WALK } from "./support.js";

beforeEach(() => endOpenJobs());

type User = Awaited<ReturnType<typeof newUser>>;

/** Uploads the short fixture as `user` and polls until `done` holds for it. */
async function uploadedBook(user: User, done: (book: BookDetail) => boolean, timeoutMs = 180_000): Promise<BookDetail> {
  const created = await user.upload("short-walk.epub", SHORT_WALK);
  expect(created.status).toBe(201);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { body } = await user.api<BookDetail>(`/books/${created.body.id}`);
    if (done(body)) return body;
    if (Date.now() > deadline) throw new Error(`book ${body.id} still ${body.status}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe("marking while listening, then gleaning", () => {
  it("marks a Sentence, lists it in Gleanings with its place in the audio, Dismisses it and marks it again", async () => {
    // A user of their own, so Gleanings start empty.
    const user = await newUser("marks");
    const book = await uploadedBook(user, (b) => b.status === "ready");
    const { body: timeline } = await user.api<BookTimeline>(`/books/${book.id}/timeline`);
    expect(timeline.sentenceIds).toHaveLength(timeline.sentenceStartsMs.length);
    const target = timeline.sentenceIds[1]!;
    const mark = (id: string) => user.api<MarkResult>(`/sentences/${id}/mark`, { method: "PUT" });
    const count = async () => (await user.api<{ count: number }>("/gleanings/count")).body.count;

    expect((await mark(target)).body).toEqual({ result: "created" });
    expect((await mark(target)).body).toEqual({ result: "already" });

    expect((await user.api<BookMarks>(`/books/${book.id}/marks`)).body.pending).toEqual([target]);
    const { body: gleanings } = await user.api<Gleaning[]>("/gleanings");
    expect(gleanings.map((g) => [g.sentenceId, g.bookId, g.startMs])).toEqual([
      [target, book.id, timeline.sentenceStartsMs[1]],
    ]);
    expect(await count()).toBe(1);

    expect((await user.api(`/sentences/${target}/mark/dismiss`, { method: "POST" })).status).toBe(204);
    expect(await count()).toBe(0);

    expect((await mark(target)).body).toEqual({ result: "reopened" });
    expect((await user.api(`/sentences/${target}/mark`, { method: "DELETE" })).status).toBe(204);
    expect(await count()).toBe(0);
  });

  it("keeps a stranger from marking the user's Sentences", async () => {
    const owner = await newUser("marks-owner");
    const book = await uploadedBook(owner, (b) => b.playable);
    const { body: timeline } = await owner.api<BookTimeline>(`/books/${book.id}/timeline`);
    const stranger = await newUser("marks-stranger");

    expect((await stranger.api(`/sentences/${timeline.sentenceIds[0]}/mark`, { method: "PUT" })).status).toBe(404);
  });
});
