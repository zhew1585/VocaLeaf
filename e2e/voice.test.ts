// End-to-end: choosing a Voice at upload and changing it later on the running compose stack (#19, PRD 4.2.4,
// AC-BOOK-05, AC-BOOK-06). The real worker renders with Kokoro. Needs `npm run e2e:up`.
import { beforeAll, describe, expect, it } from "vitest";
import type { BookDetail } from "../api/src/contract.js";
import { api, endOpenJobs, fetchBytes, SHORT_WALK, upload, waitForBook } from "./support.js";

/** Generating both short Chapters on CPU. */
const GENERATE_MS = 240_000;

async function playlistSegments(bookId: string) {
  const res = await fetchBytes(`/api/books/${bookId}/audio.m3u8`);
  return new TextDecoder().decode(res.bytes).split("\n").filter((l) => l.startsWith("segments/"));
}

function changeVoice(bookId: string, voice: string) {
  return api(`/books/${bookId}/voice`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ voice }),
  });
}

describe("the Voice of a Book", () => {
  beforeAll(() => endOpenJobs());

  it("serves the 5-second preview of every Voice as a static file", async () => {
    for (const voice of ["us_female", "us_male", "uk_female", "uk_male"]) {
      const res = await fetchBytes(`/voices/${voice}.m4a`);
      expect([voice, res.status]).toEqual([voice, 200]);
      expect(res.bytes.length).toBeGreaterThan(10_000);
    }
  });

  it("is narrated in the Voice chosen at upload, then changes as a whole while the old audio plays", async () => {
    const created = await upload("short-walk.epub", SHORT_WALK, { voice: "uk_male" });
    expect(created.status).toBe(201);
    const id = created.body.id;
    const ready = await waitForBook(id, (b) => b.status === "ready", GENERATE_MS);
    expect(ready).toMatchObject({ voice: "uk_male", voiceChange: null, voiceChangeable: true, playable: true });
    const before = await playlistSegments(id);

    // Progress at the second Chapter's first Sentence.
    const second = ready.chapters[1]!;
    expect((await api(`/books/${id}/listening`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ positionMs: second.startMs! + 100 }),
    })).status).toBe(204);
    const where = (await api<BookDetail>(`/books/${id}`)).body.listening!;

    // AC-BOOK-05: right after the change, the old Voice still plays; no second change meanwhile.
    expect((await changeVoice(id, "us_female")).status).toBe(202);
    const changing = (await api<BookDetail>(`/books/${id}`)).body;
    expect(changing).toMatchObject({ voice: "uk_male", voiceChange: { to: "us_female", status: "running" } });
    expect(await playlistSegments(id)).toEqual(before);
    expect((await changeVoice(id, "us_male")).status).toBe(409);

    // AC-BOOK-06: once done, new audio throughout, and progress at the same Sentence.
    const done = await waitForBook(id, (b) => b.voiceChange === null, GENERATE_MS, (b) => {
      if (b.voice === "uk_male") expect(b.voiceChange?.status).toBe("running");
    });
    expect(done.voice).toBe("us_female");
    const after = await playlistSegments(id);
    expect(after.length).toBeGreaterThan(0);
    expect(after.filter((s) => before.includes(s))).toEqual([]);
    expect(done.listening?.sentenceId).toBe(where.sentenceId);
    // That Sentence opens the second Chapter, after its opening pause, wherever the new Voice puts the Chapter.
    expect(done.listening!.startMs).toBeGreaterThanOrEqual(done.chapters[1]!.startMs!);
    expect(done.listening!.startMs).toBeLessThan(done.chapters[1]!.startMs! + 5000);
  }, 2 * GENERATE_MS + 30_000);
});
