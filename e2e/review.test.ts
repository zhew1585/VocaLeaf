// End-to-end: Review (#16, PRD 4.5.3) on the running compose stack, against real Postgres: a user of their own makes
// Cards of a Book the real worker rendered, works through today's queue with FSRS ratings, and the queue keeps what
// is left. Needs `npm run e2e:up`.
import { beforeAll, describe, expect, it } from "vitest";
import type { BookDetail, Card, ReviewCount, ReviewQueue, Sentence } from "../api/src/contract.js";
import { endOpenJobs, fetchBytes, newUser, SHORT_WALK } from "./support.js";

/** Generating both short Chapters on CPU. */
const GENERATE_MS = 240_000;
const DAY = 24 * 60 * 60 * 1000;

type User = Awaited<ReturnType<typeof newUser>>;

function postJson<T>(user: User, path: string, body: unknown) {
  return user.api<T>(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

/** Polls the user's own Book until it is ready (waitForBook polls as the file's shared user). */
async function readyBook(user: User, id: string): Promise<BookDetail> {
  const deadline = Date.now() + GENERATE_MS;
  for (;;) {
    const { body } = await user.api<BookDetail>(`/books/${id}`);
    if (body.status === "ready") return body;
    if (Date.now() > deadline) throw new Error(`book ${id} still ${body.status}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

describe("Review through the stack", () => {
  beforeAll(() => endOpenJobs());

  it("queues new Cards, schedules ratings by FSRS and goes on with what is left (AC-REV-03, AC-REV-05)", async () => {
    const user = await newUser("review");
    const created = await user.upload("short-walk.epub", SHORT_WALK);
    expect(created.status).toBe(201);
    const book = await readyBook(user, created.body.id);
    const chapter = book.chapters.find((c) => !c.skipped)!;
    const sentence = (await user.api<Sentence[]>(`/chapters/${chapter.id}/sentences`)).body.find((s) =>
      /[A-Za-z]{3,}\W+[A-Za-z]{3,}/.test(s.text),
    )!;
    const words = [...sentence.text.matchAll(/[A-Za-z]{3,}/g)].slice(0, 2);
    const cards: Card[] = [];
    for (const w of words) {
      const made = await postJson<Card>(user, "/cards", { sentenceId: sentence.id, start: w.index, end: w.index + w[0].length });
      expect(made.status).toBe(201);
      cards.push(made.body);
    }

    const queue = (await user.api<ReviewQueue>("/review")).body.cards;
    expect(queue.map((i) => i.card.id)).toEqual(cards.map((c) => c.id));
    expect((await user.api<ReviewCount>("/review/count")).body.count).toBe(2);
    expect(await fetchBytes(`/api/cards/${cards[0]!.id}/audio`, user.cookie)).toMatchObject({ status: 200, type: "audio/aac" });

    // 简单 moves the first Card days away, by the interval its button showed.
    const easy = await postJson<ReviewQueue>(user, `/cards/${cards[0]!.id}/review`, { rating: 4 });
    expect(easy.status).toBe(200);
    expect(easy.body.cards.map((i) => i.card.id)).toEqual([cards[1]!.id]);
    expect(queue[0]!.intervalsMs[3]).toBeGreaterThanOrEqual(DAY);

    // 记得 on a new Card is a learning step: it stays in today's queue, due a few minutes later.
    const good = await postJson<ReviewQueue>(user, `/cards/${cards[1]!.id}/review`, { rating: 3 });
    const [again] = good.body.cards;
    expect(again!.card.id).toBe(cards[1]!.id);
    expect(Date.parse(again!.card.due)).toBeGreaterThan(Date.now());

    // Leaving and coming back: the queue is what is left.
    expect((await user.api<ReviewQueue>("/review")).body.cards.map((i) => i.card.id)).toEqual([cards[1]!.id]);
    expect((await postJson(user, `/cards/${cards[1]!.id}/review`, { rating: 9 })).status).toBe(400);
  });
});
