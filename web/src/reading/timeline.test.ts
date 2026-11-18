import { describe, expect, it } from "vitest";
import type { ChapterSummary } from "../api";
import { columnWidth, currentSentenceId, paragraphs, playingChapterId, type ReadingSentence } from "./timeline";

const chapter = (id: string, startMs: number | null, skipped = false): ChapterSummary => ({
  id,
  index: 0,
  title: id,
  skipped,
  audioStatus: startMs === null ? "pending" : "generated",
  sentenceCount: 1,
  durationMs: null,
  waitSeconds: null,
  startMs,
});

const sentence = (id: string, paragraphIndex: number, startMs: number | null): ReadingSentence => ({
  id,
  paragraphIndex,
  text: id,
  startMs,
});

describe("playingChapterId", () => {
  const chapters = [chapter("i", 0), chapter("imprint", null, true), chapter("ii", 8000), chapter("iii", null)];

  it("is the last Chapter that starts at or before the position, passing over Skipped ones", () => {
    expect(playingChapterId(chapters, 0)).toBe("i");
    expect(playingChapterId(chapters, 7999)).toBe("i");
    expect(playingChapterId(chapters, 8000)).toBe("ii");
    expect(playingChapterId(chapters, 60_000)).toBe("ii");
  });

  it("is null for a Book with no audio placed yet", () => {
    expect(playingChapterId([chapter("i", null)], 0)).toBeNull();
  });
});

describe("currentSentenceId", () => {
  const sentences = [sentence("a", 0, 1000), sentence("b", 0, 4000), sentence("c", 1, 8000), sentence("d", 1, null)];

  it("is the Sentence being read, and stays on it through the pause after it", () => {
    expect(currentSentenceId(sentences, 1000)).toBe("a");
    expect(currentSentenceId(sentences, 3999)).toBe("a");
    expect(currentSentenceId(sentences, 4000)).toBe("b");
    expect(currentSentenceId(sentences, 9000)).toBe("c");
  });

  it("is the first Sentence before it starts (the silence at a Chapter's start), and null without timed Sentences", () => {
    expect(currentSentenceId(sentences, 0)).toBe("a");
    expect(currentSentenceId([sentence("x", 0, null)], 0)).toBeNull();
    expect(currentSentenceId([], 0)).toBeNull();
  });
});

describe("paragraphs", () => {
  it("groups Sentences into their paragraphs, in order", () => {
    const s = [sentence("a", 0, null), sentence("b", 0, null), sentence("c", 1, null), sentence("d", 3, null)];
    expect(paragraphs(s).map((p) => p.map((x) => x.id))).toEqual([["a", "b"], ["c"], ["d"]]);
  });
});

describe("columnWidth", () => {
  it("follows which side panels are open (F7: 620, 680, 720, 760)", () => {
    expect(columnWidth({ directory: true, sentencePanel: true })).toBe(620);
    expect(columnWidth({ directory: false, sentencePanel: true })).toBe(680);
    expect(columnWidth({ directory: true, sentencePanel: false })).toBe(720);
    expect(columnWidth({ directory: false, sentencePanel: false })).toBe(760);
  });
});
