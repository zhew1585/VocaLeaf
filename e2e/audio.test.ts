// End-to-end: audio generation and playback on the running compose stack, with real Kokoro, ffmpeg and
// object storage. Everything the user does goes through the web origin; the worker runs for real.
// Needs `npm run e2e:up` (5 s job lease, so any render longer than 5 s depends on heartbeats).
import { execFileSync } from "node:child_process";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { BookDetail, Sentence } from "../api/src/contract.js";
import {
  api,
  compose,
  endOpenJobs,
  fetchBytes,
  PRIDE_AND_PREJUDICE,
  ROOT,
  SHORT_WALK,
  sql,
  upload,
  waitForBook,
} from "./support.js";

/** PRD F4 scenario: a Standard Ebooks EPUB can be listened to within 60 s of uploading it. */
const FIRST_AUDIO_MS = 60_000;

/** The segment paths of a playlist, resolved against the playlist URL as a player does. */
function segmentPaths(m3u8: string, bookId: string): string[] {
  return m3u8
    .split("\n")
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => new URL(l, `http://web/api/books/${bookId}/audio.m3u8`).pathname);
}

async function playlist(bookId: string) {
  const res = await fetch(`http://localhost:8080/api/books/${bookId}/audio.m3u8`);
  expect(res.status).toBe(200);
  return res.text();
}

/** ffprobe inside the worker container (which has ffmpeg), reading the bytes from stdin. */
function probe(bytes: Uint8Array) {
  const out = execFileSync(
    "docker",
    ["compose", "exec", "-T", "worker", "ffprobe", "-v", "error", "-show_streams", "-of", "json", "-i", "pipe:0"],
    { cwd: ROOT, input: bytes },
  );
  return (JSON.parse(out.toString()) as { streams: { codec_name: string; profile: string; channels: number }[] })
    .streams[0]!;
}

beforeEach(() => endOpenJobs());
afterAll(() => endOpenJobs());

describe("uploading a Standard Ebooks EPUB", () => {
  it("can be listened to within 60 s: the playlist holds narrated audio whose segments come from object storage", async () => {
    const started = Date.now();
    const created = await upload("pride-and-prejudice.epub", PRIDE_AND_PREJUDICE);

    const book = await waitForBook(created.body.id, (b) => b.playable, FIRST_AUDIO_MS);
    const elapsed = Date.now() - started;
    console.log(`Pride and Prejudice playable ${elapsed} ms after upload`);
    expect(elapsed).toBeLessThan(FIRST_AUDIO_MS);
    expect(book.status).toBe("generating");

    const m3u8 = await playlist(book.id);
    expect(m3u8).toContain("#EXT-X-PLAYLIST-TYPE:EVENT");
    expect(m3u8).not.toContain("#EXT-X-ENDLIST");
    const paths = segmentPaths(m3u8, book.id);
    expect(paths.length).toBeGreaterThan(0);

    const first = await fetchBytes(paths[0]!);
    expect(first).toMatchObject({ status: 200, type: "video/mp2t" });
    expect(first.bytes[0]).toBe(0x47); // MPEG-TS sync byte
    expect(probe(first.bytes)).toMatchObject({ codec_name: "aac", profile: "LC", channels: 1 });
  });
});

describe("a Book generated to the end", () => {
  it("goes 生成中·未可播 → 生成中·可播 → 已就绪, with every Sentence timed and one HLS stream of all its Chapters", async () => {
    const created = await upload("short-walk.epub", SHORT_WALK);
    const seen: string[] = [];
    const record = (b: BookDetail) => {
      const state = `${b.status}${b.status === "generating" ? (b.playable ? "·可播" : "·未可播") : ""}`;
      if (seen.at(-1) !== state) seen.push(state);
    };

    const book = await waitForBook(created.body.id, (b) => b.status === "ready", 120_000, record);

    expect(seen).toEqual(["parsing", "generating·未可播", "generating·可播", "ready"]);
    expect(book.playable).toBe(true);
    expect(book.chapters.map((c) => [c.title, c.audioStatus])).toEqual([
      ["The Letter", "generated"],
      ["The Walk", "generated"],
    ]);

    const sentences: Sentence[] = [];
    for (const c of book.chapters) sentences.push(...(await api<Sentence[]>(`/chapters/${c.id}/sentences`)).body);
    expect(sentences.length).toBeGreaterThanOrEqual(6);
    for (const s of sentences) {
      expect(s.startMs).not.toBeNull();
      expect(s.endMs!).toBeGreaterThan(s.startMs!);
      expect(s.wordTimings!.length).toBeGreaterThan(0);
    }
    // One continuous timeline: each Sentence starts where the previous one ended. A new Chapter starts after the
    // previous Chapter's last segment, which the AAC encoder pads by up to one frame (about 43 ms at 24 kHz).
    for (let i = 1; i < sentences.length; i++) {
      const gap = sentences[i]!.startMs! - sentences[i - 1]!.endMs!;
      expect(gap).toBeGreaterThanOrEqual(0);
      expect(gap).toBeLessThan(100);
    }
    const total = book.chapters.reduce((ms, c) => ms + c.durationMs!, 0);
    expect(Math.abs(sentences.at(-1)!.endMs! - total)).toBeLessThan(200);

    const m3u8 = await playlist(book.id);
    expect(m3u8).toContain("#EXT-X-ENDLIST");
    expect(m3u8.match(/#EXT-X-DISCONTINUITY/g)).toHaveLength(1);
    for (const path of segmentPaths(m3u8, book.id)) {
      expect((await fetchBytes(path)).status).toBe(200);
    }
  });
});

describe("a Chapter that takes longer to generate than the job lease", () => {
  afterAll(() => {
    compose("up", "-d", "--no-deps", "--scale", "worker=1", "worker");
  });

  it("is generated by one worker under its first claim, while a second worker polls for jobs all along", async () => {
    compose("up", "-d", "--no-deps", "--scale", "worker=2", "worker");
    const created = await upload("pride-and-prejudice.epub", PRIDE_AND_PREJUDICE);
    const parsed = await waitForBook(created.body.id, (b) => b.status !== "parsing", 60_000);
    // Imprint: 9 Sentences, over a minute of audio, about 20 s to generate on a laptop CPU, 4 leases of 5 s.
    const imprint = parsed.chapters.find((c) => c.title === "Imprint")!;

    const started = Date.now();
    await waitForBook(
      created.body.id,
      (b) => b.chapters.find((c) => c.id === imprint.id)!.audioStatus === "generated",
      180_000,
    );
    const renderMs = Date.now() - started;
    console.log(`Imprint generated in ${renderMs} ms with a 5000 ms lease`);
    expect(renderMs).toBeGreaterThan(2 * 5_000);

    const [job] = sql(`select id || '|' || attempt || '|' || status from jobs where chapter_id = '${imprint.id}'`);
    const [jobId, attempt, status] = job!.split("|");
    expect([attempt, status]).toEqual(["1", "succeeded"]);
    // Across both workers' logs the job was claimed once and never taken over.
    const logs = compose("logs", "worker");
    expect(logs.match(new RegExp(`job ${jobId}: render_chapter`, "g"))).toHaveLength(1);
    expect(logs).not.toContain(`job ${jobId} attempt 1 was superseded`);
  });
});
