import { describe, expect, it } from "vitest";
import { mapPosition, onlyAppends, type Layout } from "./usePlaylist";

// Chapters I and III are in the playlist; II failed and is out of it.
const before: Layout = [
  { id: "I", startMs: 0 },
  { id: "III", startMs: 600_000 },
];
// II was retried and is now generated: 5 minutes inserted before III.
const after: Layout = [
  { id: "I", startMs: 0 },
  { id: "II", startMs: 600_000 },
  { id: "III", startMs: 900_000 },
];

describe("onlyAppends", () => {
  it("accepts the same layout and Chapters added at the end", () => {
    expect(onlyAppends(before, before)).toBe(true);
    expect(onlyAppends(before, [...before, { id: "IV", startMs: 700_000 }])).toBe(true);
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

  it("resumes at the next Chapter still in the playlist when the Chapter left it", () => {
    expect(mapPosition(700, after, before)).toBe(600);
  });
});
