import { describe, expect, it } from "vitest";
import { chapterEndAt, nextSentenceMs, replayTargetMs, targetIndex } from "./navigation";

// Sentences start at 0, 4 s, 8 s and 12 s.
const STARTS = [0, 4000, 8000, 12000];

describe("replayTargetMs (PRD 4.4.3)", () => {
  it("goes back to the previous Sentence when the current one started under 1.5 s ago (AC-REP-01)", () => {
    expect(replayTargetMs(STARTS, 8900, { rate: 1, landedAtMs: null })).toBe(4000);
  });

  it("replays the current Sentence from its start once it played 1.5 s or more (AC-REP-02)", () => {
    expect(replayTargetMs(STARTS, 11000, { rate: 1, landedAtMs: null })).toBe(8000);
    expect(replayTargetMs(STARTS, 9500, { rate: 1, landedAtMs: null })).toBe(8000);
  });

  it("measures the 1.5 s in listening time, so at 2x the current Sentence counts after 3 s of audio", () => {
    expect(replayTargetMs(STARTS, 10000, { rate: 2, landedAtMs: null })).toBe(4000);
    expect(replayTargetMs(STARTS, 11000, { rate: 2, landedAtMs: null })).toBe(8000);
  });

  it("keeps to the current Sentence after a jump until playback crosses a Sentence start on its own (G2)", () => {
    // Dragged to 8.2 s: still in the Sentence it landed in, so no reaction compensation.
    expect(replayTargetMs(STARTS, 8500, { rate: 1, landedAtMs: 8200 })).toBe(8000);
    // Played on into the next Sentence: compensation applies again.
    expect(replayTargetMs(STARTS, 12500, { rate: 1, landedAtMs: 8200 })).toBe(8000);
  });

  it("stays at the first Sentence's start when there is none before it", () => {
    expect(replayTargetMs(STARTS, 500, { rate: 1, landedAtMs: null })).toBe(0);
    expect(replayTargetMs([1500, 4000], 300, { rate: 1, landedAtMs: null })).toBe(1500);
  });

  it("has no target without Sentences", () => {
    expect(replayTargetMs([], 300, { rate: 1, landedAtMs: null })).toBeNull();
  });
});

describe("nextSentenceMs", () => {
  it("is the start of the Sentence after the current one", () => {
    expect(nextSentenceMs(STARTS, 5000)).toBe(8000);
    expect(nextSentenceMs(STARTS, 4000)).toBe(8000);
  });

  it("is null at the last Sentence", () => {
    expect(nextSentenceMs(STARTS, 13000)).toBeNull();
  });
});

describe("chapterEndAt", () => {
  const chapters = [
    { id: "a", startMs: 0, endMs: 8000 },
    { id: "b", startMs: 8000, endMs: null },
  ];

  it("is the end of the Chapter holding the position", () => {
    expect(chapterEndAt(chapters, 3000)).toBe(8000);
  });

  it("is null while that Chapter is still generating, or before any Chapter", () => {
    expect(chapterEndAt(chapters, 9000)).toBeNull();
    expect(chapterEndAt([], 0)).toBeNull();
  });
});

describe("targetIndex (PRD 4.4.2 目标句判定)", () => {
  it("picks the Sentence 【标记】 marks by the same rule as 重听", () => {
    expect(targetIndex(STARTS, 11000, { rate: 1, landedAtMs: null })).toBe(2);
    expect(targetIndex(STARTS, 8900, { rate: 1, landedAtMs: null })).toBe(1);
    expect(targetIndex(STARTS, 8500, { rate: 1, landedAtMs: 8200 })).toBe(2);
    expect(targetIndex(STARTS, 500, { rate: 1, landedAtMs: null })).toBe(0);
    expect(targetIndex([], 500, { rate: 1, landedAtMs: null })).toBeNull();
  });
});
