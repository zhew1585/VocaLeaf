// End-to-end: setting a Chapter Skipped and narrated again on the running compose stack (#20, PRD 4.2.5).
// Needs `npm run e2e:up`.
import { beforeEach, describe, expect, it } from "vitest";
import type { BookDetail, BookTimeline } from "../api/src/contract.js";
import { api, endOpenJobs, fetchBytes, SHORT_WALK, sql, upload, waitForBook } from "./support.js";

beforeEach(() => endOpenJobs());

async function playlistSegments(bookId: string) {
  const res = await fetchBytes(`/api/books/${bookId}/audio.m3u8`);
  return new TextDecoder().decode(res.bytes).split("\n").filter((l) => l.startsWith("segments/"));
}

function setSkipped(chapterId: string, skipped: boolean) {
  return api(`/chapters/${chapterId}/skipped`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ skipped }),
  });
}

describe("a generated Chapter set Skipped", () => {
  it("leaves the playlist at once and comes back with the same audio, without generating it again", async () => {
    const created = await upload("short-walk.epub", SHORT_WALK);
    const book = await waitForBook(created.body.id, (b) => b.status === "ready", 180_000);
    const [letter, walk] = book.chapters;
    const before = await playlistSegments(book.id);

    expect((await setSkipped(letter!.id, true)).status).toBe(204);
    const skipped = (await api<BookDetail>(`/books/${book.id}`)).body;
    expect(skipped.chapters.map((c) => [c.title, c.skipped, c.startMs])).toEqual([
      [letter!.title, true, null],
      [walk!.title, false, 0],
    ]);
    expect(skipped).toMatchObject({ status: "ready", progress: { generated: 1, narrated: 1 } });
    const without = await playlistSegments(book.id);
    expect(without.length).toBeGreaterThan(0);
    expect(without.length).toBeLessThan(before.length);
    expect(before.slice(-without.length)).toEqual(without);
    expect((await api<BookTimeline>(`/books/${book.id}/timeline`)).body.chapters.map((c) => c.id)).toEqual([walk!.id]);

    expect((await setSkipped(letter!.id, false)).status).toBe(204);
    const back = (await api<BookDetail>(`/books/${book.id}`)).body;
    expect(back.chapters.map((c) => [c.audioStatus, c.startMs])).toEqual(book.chapters.map((c) => [c.audioStatus, c.startMs]));
    expect(await playlistSegments(book.id)).toEqual(before);
    // One render job per Chapter, from the first generation only.
    expect(sql(`select count(*) from jobs where book_id = '${book.id}' and type = 'render_chapter'`)).toEqual(["2"]);
  });
});
