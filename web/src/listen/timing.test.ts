import { describe, expect, it } from "vitest";
import type { ChapterSummary, Sentence } from "../api";
import { paragraphs, playingChapterId, playingSentenceId, timesBehind } from "./timing";

const chapter = (id: string, startMs: number | null): ChapterSummary => ({
  id,
  index: 0,
  title: id,
  skipped: false,
  audioStatus: startMs === null ? "pending" : "generated",
  sentenceCount: 1,
  durationMs: null,
  startMs,
});

const sentence = (id: string, startMs: number | null, endMs: number | null, paragraphIndex = 0): Sentence => ({
  id,
  index: 0,
  paragraphIndex,
  text: id,
  spokenText: id,
  startMs,
  endMs,
  wordTimings: null,
});

describe("playingChapterId", () => {
  // I plays from 0, the Imprint is Skipped (not in the audio), II from 8 s, III is not generated yet.
  const chapters = [chapter("I", 0), chapter("Imprint", null), chapter("II", 8000), chapter("III", null)];

  it("is the last Chapter in the audio that has started", () => {
    expect(playingChapterId(chapters, 0)).toBe("I");
    expect(playingChapterId(chapters, 7999)).toBe("I");
    expect(playingChapterId(chapters, 8000)).toBe("II");
    expect(playingChapterId(chapters, 60_000)).toBe("II");
  });

  it("is none before any Chapter is in the audio", () => {
    expect(playingChapterId([chapter("I", null)], 0)).toBeNull();
  });
});

describe("playingSentenceId", () => {
  // The Chapter opens with a 1.5 s pause, and 300 ms pass between Sentences.
  const sentences = [sentence("a", 1500, 3000), sentence("b", 3300, 5000), sentence("c", null, null)];

  it("is none in the pause before the Chapter's first Sentence", () => {
    expect(playingSentenceId(sentences, 0)).toBeNull();
  });

  it("moves on when the next Sentence starts, not when the previous one ends", () => {
    expect(playingSentenceId(sentences, 1500)).toBe("a");
    expect(playingSentenceId(sentences, 3100)).toBe("a");
    expect(playingSentenceId(sentences, 3300)).toBe("b");
  });

  it("ignores Sentences without a time yet", () => {
    expect(playingSentenceId(sentences, 99_000)).toBe("b");
  });
});

describe("timesBehind", () => {
  it("is true once playback passes every timed Sentence while some have no time", () => {
    const partial = [sentence("a", 0, 1000), sentence("b", null, null)];
    expect(timesBehind(partial, 500)).toBe(false);
    expect(timesBehind(partial, 1001)).toBe(true);
  });

  it("is false when every Sentence has its time", () => {
    expect(timesBehind([sentence("a", 0, 1000)], 5000)).toBe(false);
  });
});

describe("paragraphs", () => {
  it("groups consecutive Sentences of the same paragraph", () => {
    const s = [sentence("a", null, null, 0), sentence("b", null, null, 1), sentence("c", null, null, 1)];
    expect(paragraphs(s).map((p) => p.map((x) => x.id))).toEqual([["a"], ["b", "c"]]);
  });
});
