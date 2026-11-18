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

/** Every Sentence of the Book in reading order. */
async function sentencesOf(book: BookDetail): Promise<Sentence[]> {
  const all: Sentence[] = [];
  for (const c of book.chapters) all.push(...(await api<Sentence[]>(`/chapters/${c.id}/sentences`)).body);
  return all;
}

/** Positions (in reading order) of each Chapter's first Sentence. */
function chapterStarts(book: BookDetail): Set<number> {
  const starts = new Set<number>();
  let position = 0;
  for (const c of book.chapters) {
    starts.add(position);
    position += c.sentenceCount;
  }
  return starts;
}

/** The Book's whole playlist decoded to 24 kHz mono PCM, by ffmpeg inside the worker container. */
function decodeBook(bookId: string): Int16Array {
  const pcm = execFileSync(
    "docker",
    [
      ...["compose", "exec", "-T", "worker", "ffmpeg", "-loglevel", "error", "-allowed_extensions", "ALL"],
      ...["-i", `http://api:3000/api/books/${bookId}/audio.m3u8`, "-f", "s16le", "-ac", "1", "-ar", "24000", "pipe:1"],
    ],
    { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 },
  );
  return new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 2);
}

/** Root mean square level of the audio between two times in ms. */
function rms(audio: Int16Array, fromMs: number, toMs: number): number {
  const window = audio.subarray(Math.floor((fromMs * 24_000) / 1000), Math.floor((toMs * 24_000) / 1000));
  let sum = 0;
  for (const v of window) sum += v * v;
  return Math.sqrt(sum / Math.max(window.length, 1));
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

    const sentences = await sentencesOf(book);
    expect(sentences.length).toBe(5); // the two headings repeat the Chapter titles and are not Sentences
    for (const s of sentences) {
      expect(s.startMs).not.toBeNull();
      expect(s.endMs!).toBeGreaterThan(s.startMs!);
      expect(s.wordTimings!.length).toBeGreaterThan(0);
    }
    // The whole playlist covers every Sentence and the pauses after the last one.
    const total = book.chapters.reduce((ms, c) => ms + c.durationMs!, 0);
    expect(total).toBeGreaterThanOrEqual(sentences.at(-1)!.endMs!);
    expect(total - sentences.at(-1)!.endMs!).toBeLessThan(300);

    const m3u8 = await playlist(book.id);
    expect(m3u8).toContain("#EXT-X-ENDLIST");
    expect(m3u8.match(/#EXT-X-DISCONTINUITY/g)).toHaveLength(1);
    for (const path of segmentPaths(m3u8, book.id)) {
      expect((await fetchBytes(path)).status).toBe(200);
    }
  });
});

describe("narration with pauses, spoken a paragraph at a time", () => {
  it("separates Sentences with silence, paragraphs with longer silence, and keeps every word inside its Sentence", async () => {
    const created = await upload("short-walk.epub", SHORT_WALK);
    const parsed = await waitForBook(created.body.id, (b) => b.status !== "parsing", 60_000);
    const before = await sentencesOf(parsed);

    const book = await waitForBook(created.body.id, (b) => b.status === "ready", 120_000);
    const sentences = await sentencesOf(book);

    // Generating changes no Sentence: same IDs, boundaries and text as parsing produced.
    const text = (list: Sentence[]) => list.map((s) => [s.id, s.paragraphIndex, s.text, s.spokenText]);
    expect(text(sentences)).toEqual(text(before));

    // Times only ever move forward and never overlap; each pause matches its kind (defaults: 300 / 800 / 1500 ms).
    const firstOf = chapterStarts(book);
    expect(sentences[0]!.startMs).toBe(1500);
    for (let i = 1; i < sentences.length; i++) {
      const gap = sentences[i]!.startMs! - sentences[i - 1]!.endMs!;
      const newParagraph = sentences[i]!.paragraphIndex !== sentences[i - 1]!.paragraphIndex;
      if (firstOf.has(i)) expect(gap, `chapter start before sentence ${i}`).toBeGreaterThanOrEqual(1500);
      else expect(gap, `pause before sentence ${i}`).toBe(newParagraph ? 800 : 300);
    }

    // Every word lies inside its own Sentence's span, and is one of that Sentence's words.
    const norm = (w: string) => w.toLowerCase().replace(/[^a-z0-9]/g, "");
    for (const s of sentences) {
      const own = new Set(s.spokenText.split(/\s+/).map(norm));
      for (const w of s.wordTimings!) {
        expect(w.startMs).toBeGreaterThanOrEqual(0);
        expect(w.endMs).toBeLessThanOrEqual(s.endMs! - s.startMs!);
        expect(own.has(norm(w.word)), `${w.word} in "${s.spokenText}"`).toBe(true);
      }
    }

    // In the audio a player decodes, the pauses are silent and the Sentences are not.
    const audio = decodeBook(book.id);
    const level = (from: number, to: number) => rms(audio, from, to);
    expect(level(100, 1300), "chapter start").toBeLessThan(150);
    for (let i = 0; i < sentences.length; i++) {
      const s = sentences[i]!;
      expect(level(s.startMs!, s.endMs!), `sentence ${i}`).toBeGreaterThan(500);
      if (i > 0 && !firstOf.has(i)) {
        expect(level(sentences[i - 1]!.endMs! + 110, s.startMs! - 110), `pause before sentence ${i}`).toBeLessThan(150);
      }
    }
  });
});

/** Titles that stand before a name (AC-UP-08): no Sentence may end on one. */
const TITLES = ["Mr", "Mrs", "Ms", "Dr", "St", "Prof", "Rev", "Capt", "Col", "Gen", "Lt", "Gov"];

describe("Sentences split around abbreviations and Chapter headings (AC-UP-08)", () => {
  it("keeps Mr. with Bennet in text and in audio, and starts Chapter I with its opening line", async () => {
    const created = await upload("pride-and-prejudice.epub", PRIDE_AND_PREJUDICE);
    const parsed = await waitForBook(created.body.id, (b) => b.status !== "parsing", 60_000);

    const all = await sentencesOf(parsed);
    const endsOnTitle = all.filter((s) => TITLES.some((t) => new RegExp(`(^|[\\s“‘"'(])${t}\\.$`).test(s.text)));
    expect(endsOnTitle.map((s) => s.text)).toEqual([]);

    const chapterOne = parsed.chapters.find((c) => c.title === "I")!;
    const one = (await api<Sentence[]>(`/chapters/${chapterOne.id}/sentences`)).body;
    expect(one[0]!.text).toMatch(/^It is a truth universally acknowledged/);
    expect(one[2]!.text).toMatch(/^“My dear Mr\. Bennet,” said his lady to him one day/);
    expect(one[3]!.text).toBe("Mr. Bennet replied that he had not.");

    // Once Chapter I is narrated, nothing is inserted between "Mr." and "Bennet": they are one Sentence, and the
    // TTS reads them on without a break.
    const book = await waitForBook(
      created.body.id,
      (b) => b.chapters.find((c) => c.id === chapterOne.id)!.audioStatus === "generated",
      300_000,
    );
    const timed = (await api<Sentence[]>(`/chapters/${chapterOne.id}/sentences`)).body;
    for (const s of [timed[2]!, timed[3]!]) {
      const words = s.wordTimings!;
      const mister = words.findIndex((w) => w.word === "Mister");
      expect(words[mister + 1]?.word, s.text).toBe("Bennet");
      expect(words[mister + 1]!.startMs - words[mister]!.endMs).toBeLessThan(150);
    }
    expect(book.chapters.find((c) => c.id === chapterOne.id)!.durationMs).toBeGreaterThan(0);
  }, 360_000); // Imprint and Chapter I are narrated first: about two minutes on a laptop CPU
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
