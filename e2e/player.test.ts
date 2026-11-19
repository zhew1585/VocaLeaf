// End-to-end: the timeline the player's controls steer by (重听, 下一句, 本章结束; #9), on the running compose
// stack with the real worker. Needs `npm run e2e:up`.
import { beforeEach, describe, expect, it } from "vitest";
import type { BookTimeline, Sentence } from "../api/src/contract.js";
import { api, endOpenJobs, newUser, SHORT_WALK, upload, waitForBook } from "./support.js";

beforeEach(() => endOpenJobs());

describe("a generated Book's timeline", () => {
  it("places every Sentence and narrated Chapter where the Book's audio has them, end to end", async () => {
    const created = await upload("short-walk.epub", SHORT_WALK);
    expect(created.status).toBe(201);
    const book = await waitForBook(created.body.id, (b) => b.status === "ready", 180_000);

    const { status, body: timeline } = await api<BookTimeline>(`/books/${book.id}/timeline`);
    expect(status).toBe(200);
    expect(timeline.complete).toBe(true);

    // Sentence starts are the ones each Chapter's Sentences report, in reading order.
    const narrated = book.chapters.filter((c) => !c.skipped);
    const starts: number[] = [];
    for (const c of narrated) {
      const sentences = (await api<Sentence[]>(`/chapters/${c.id}/sentences`)).body;
      starts.push(...sentences.map((s) => s.startMs!));
    }
    expect(timeline.sentenceStartsMs).toEqual(starts);
    expect(starts.length).toBeGreaterThan(1);

    // Chapters follow each other without gaps, from 0 to the end of the Book's audio, Skipped ones left out.
    expect(timeline.chapters.map((c) => [c.id, c.startMs])).toEqual(narrated.map((c) => [c.id, c.startMs]));
    expect(timeline.chapters[0]!.startMs).toBe(0);
    for (const [i, c] of timeline.chapters.entries()) {
      expect(c.endMs).toBe(timeline.chapters[i + 1]?.startMs ?? book.durationMs);
    }
  });

  it("is only served to the Book's owner", async () => {
    const created = await upload("short-walk.epub", SHORT_WALK);
    const stranger = await newUser("timeline-stranger");
    expect((await stranger.api(`/books/${created.body.id}/timeline`)).status).toBe(404);
  });
});
