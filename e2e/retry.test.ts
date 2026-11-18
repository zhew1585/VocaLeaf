// End-to-end: Chapter generation failing on the running compose stack (#5, PRD 4.3.5 #8 and #9).
// Kokoro is stopped so the real worker fails every attempt; once it is back, the user retries the Chapters.
// Needs `npm run e2e:up`.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Book, BookDetail } from "../api/src/contract.js";
import { api, compose, endOpenJobs, fetchBytes, SHORT_WALK, upload, waitForBook } from "./support.js";

/** Three attempts per Chapter fail within seconds when Kokoro cannot be reached. */
const ALL_ATTEMPTS_FAIL_MS = 60_000;
/** Generating one of the short Chapters on CPU, with Kokoro just restarted. */
const GENERATE_MS = 120_000;

const isPending = (b: BookDetail) => b.chapters.some((c) => c.audioStatus === "pending" || c.audioStatus === "generating");

async function playlistSegments(bookId: string) {
  const res = await fetchBytes(`/api/books/${bookId}/audio.m3u8`);
  return new TextDecoder().decode(res.bytes).split("\n").filter((l) => l.startsWith("segments/"));
}

function retry(chapterId: string) {
  return api(`/chapters/${chapterId}/retry`, { method: "POST" });
}

describe("a Chapter whose generation keeps failing", () => {
  beforeAll(() => {
    endOpenJobs();
    compose("stop", "-t", "0", "kokoro");
  });
  afterAll(() => {
    compose("up", "-d", "--wait", "kokoro");
    endOpenJobs();
  });

  it("is retried automatically 3 times, ends 生成失败 without blocking the Book, and generates once the user retries it", async () => {
    const created = await upload("short-walk.epub", SHORT_WALK);
    const id = created.body.id;

    // Every attempt of both Chapters fails: the Book still finishes, with nothing to play.
    const failed = await waitForBook(id, (b) => b.status === "ready", ALL_ATTEMPTS_FAIL_MS);
    expect(failed.chapters.map((c) => [c.title, c.audioStatus])).toEqual([
      ["The Letter", "failed"],
      ["The Walk", "failed"],
    ]);
    expect(failed).toMatchObject({ playable: false, progress: { generated: 0, narrated: 2 } });
    const logs = compose("logs", "worker");
    for (const attempt of [1, 2, 3]) expect(logs).toContain(`render_chapter book ${id} (attempt ${attempt})`);
    expect(logs).not.toContain(`render_chapter book ${id} (attempt 4)`);

    compose("up", "-d", "--wait", "kokoro");
    const [letter, walk] = failed.chapters;

    // AC-BOOK-04: the retried Chapter leaves 生成失败 and generates; the Book stays 已就绪.
    expect((await retry(letter!.id)).status).toBe(204);
    const retried = (await api<BookDetail>(`/books/${id}`)).body;
    expect(["pending", "generating"]).toContain(retried.chapters[0]!.audioStatus);
    expect(retried.status).toBe("ready");
    expect((await retry(letter!.id)).status).toBe(409);

    const first = await waitForBook(id, (b) => !isPending(b), GENERATE_MS);
    expect(first.chapters.map((c) => [c.audioStatus, c.startMs])).toEqual([
      ["generated", 0],
      ["failed", null],
    ]);
    expect(first).toMatchObject({ status: "ready", playable: true, progress: { generated: 1, narrated: 2 } });
    const letterSegments = await playlistSegments(id);
    expect(letterSegments.length).toBeGreaterThan(0);

    expect((await retry(walk!.id)).status).toBe(204);
    const done = await waitForBook(id, (b) => !isPending(b), GENERATE_MS);
    expect(done.chapters.map((c) => [c.audioStatus, c.startMs])).toEqual([
      ["generated", 0],
      ["generated", done.chapters[0]!.durationMs],
    ]);
    expect(done.progress).toEqual({ generated: 2, narrated: 2 });
    const all = await playlistSegments(id);
    expect(all.slice(0, letterSegments.length)).toEqual(letterSegments);
    expect(all.length).toBeGreaterThan(letterSegments.length);

    // The shelf list carries the same progress.
    const shelf = (await api<Book[]>("/books")).body.find((b) => b.id === id)!;
    expect(shelf.progress).toEqual({ generated: 2, narrated: 2 });
  });
});
