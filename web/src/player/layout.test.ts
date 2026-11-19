import { describe, expect, it } from "vitest";
import { mapPosition, onlyAppends, sentenceIndexAt, type Layout } from "./layout";

// Chapters I and III are in the playlist; II failed and is out of it.
const before: Layout = [
  { id: "I", startMs: 0, endMs: 600_000 },
  { id: "III", startMs: 600_000, endMs: 700_000 },
];
// II was retried and is now generated: 5 minutes inserted before III.
const after: Layout = [
  { id: "I", startMs: 0, endMs: 600_000 },
  { id: "II", startMs: 600_000, endMs: 900_000 },
  { id: "III", startMs: 900_000, endMs: 1_000_000 },
];

describe("onlyAppends", () => {
  it("accepts the same layout and Chapters added at the end", () => {
    expect(onlyAppends(before, before)).toBe(true);
    expect(onlyAppends(before, [...before, { id: "IV", startMs: 700_000, endMs: null }])).toBe(true);
    expect(onlyAppends([], before)).toBe(true);
  });

  it("refuses a Chapter inserted before the end, or one that left", () => {
    expect(onlyAppends(before, after)).toBe(false);
    expect(onlyAppends(after, before)).toBe(false);
  });
});

describe("mapPosition", () => {
  it("keeps the same offset into the same Chapter", () => {
    expect(mapPosition(612, before, after)).toBe(912);
    expect(mapPosition(30, before, after)).toBe(30);
  });

  it("resumes at the next Chapter still in the playlist when the Chapter left it (AC-BOOK-02)", () => {
    expect(mapPosition(700, after, before)).toBe(600);
  });

  it("waits at the end of the playlist when no Chapter after the one that left is in it yet", () => {
    expect(mapPosition(950, after, after.slice(0, 2))).toBe(900);
    expect(mapPosition(5, before, [])).toBe(0);
  });
});

describe("sentenceIndexAt", () => {
  it("is the Sentence playing at a position: the last one starting at or before it", () => {
    expect(sentenceIndexAt([0, 4000, 8000], 8000)).toBe(2);
    expect(sentenceIndexAt([0, 4000, 8000], 7999)).toBe(1);
    expect(sentenceIndexAt([1500, 4000], 0)).toBe(0);
  });
});
