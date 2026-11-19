// Unit tests of cutting a Sentence's audio out of a Chapter's HLS segments (PRD 4.5.2 audio_url, AC-CARD-07), on
// segments ffmpeg made the way the worker does (AAC mono 48 kbps at 24 kHz in MPEG-TS, about 2 s each here).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { adtsFramesOf, cutClip, splitAdts } from "../src/cards/audio-clip.js";
import { fakeTsSegment } from "./ts-fixture.js";

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/hls/${name}`, import.meta.url)));
/** The fixture's playlist: 2.005333 s, 2.005333 s, then 1.032 s. */
const SEGMENTS = [
  { bytes: fixture("seg-0.mpegts"), startMs: 0 },
  { bytes: fixture("seg-1.mpegts"), startMs: 2005 },
  { bytes: fixture("seg-2.mpegts"), startMs: 4011 },
];
/** One AAC frame at 24 kHz: 1024 samples. */
const FRAME_MS = 1024 / 24;

describe("adtsFramesOf", () => {
  it("reads every AAC frame of an ffmpeg segment with its duration", () => {
    const frames = adtsFramesOf(SEGMENTS[0]!.bytes);
    expect(frames).toHaveLength(47);
    for (const f of frames) expect(f.durationMs).toBeCloseTo(FRAME_MS, 5);
  });

  it("refuses bytes that are not MPEG-TS", () => {
    expect(() => adtsFramesOf(new TextEncoder().encode("audio of a sentence"))).toThrow(/MPEG-TS/);
  });
});

describe("cutClip", () => {
  it("keeps the frames that overlap the Sentence, across a segment boundary, as one ADTS stream", () => {
    const clip = cutClip(SEGMENTS, 1000, 3000);
    // 981 ms (frame 23 of the first segment) to 3029 ms (frame 23 of the second): 24 + 24 frames.
    expect(splitAdts(clip)).toHaveLength(48);
  });

  it("cuts within one segment and at the very start", () => {
    expect(splitAdts(cutClip(SEGMENTS, 0, FRAME_MS * 10))).toHaveLength(10);
  });

  it("is empty when no segment reaches the Sentence", () => {
    expect(cutClip(SEGMENTS, 9000, 9500)).toHaveLength(0);
  });

  it("times frames from each segment's start, so frames of a fake segment land where the test put them", () => {
    const segments = [
      { bytes: fakeTsSegment(1000, 0), startMs: 0 },
      { bytes: fakeTsSegment(1000, 1), startMs: 1000 },
    ];
    const kept = splitAdts(cutClip(segments, 1000, 1500));
    // Each fake frame's payload says which segment it is from.
    expect(new Set(kept.map((f) => f[7]))).toEqual(new Set([1]));
    expect(kept).toHaveLength(Math.ceil(500 / FRAME_MS));
  });
});
