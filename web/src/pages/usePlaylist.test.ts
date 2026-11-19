import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { BookDetail, BookTimeline } from "../api";
import { mapPosition, onlyAppends, sentenceIndexAt, usePlaylist, type Held, type Layout } from "./usePlaylist";

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

describe("sentenceIndexAt", () => {
  it("is the Sentence playing at a position: the last one starting at or before it", () => {
    expect(sentenceIndexAt([0, 4000, 8000], 8000)).toBe(2);
    expect(sentenceIndexAt([0, 4000, 8000], 7999)).toBe(1);
    expect(sentenceIndexAt([1500, 4000], 0)).toBe(0);
  });
});

describe("usePlaylist when the Book's Voice changed", () => {
  const book = (voice: BookDetail["voice"]) => ({ voice, chapters: [{ id: "I", startMs: 0 }] }) as unknown as BookDetail;
  const timeline = (step: number): BookTimeline => ({
    sentenceStartsMs: [0, 1, 2].map((i) => i * step),
    chapters: [],
    complete: true,
  });
  const at = { seconds: 9, playing: true };
  type Props = { b: BookDetail; held: Held | null };

  it("reloads once and resumes at the start of the same Sentence once the new Voice's timeline is loaded", () => {
    const old = timeline(4000);
    const { result, rerender } = renderHook(({ b, held }: Props) => usePlaylist(b, at, held), {
      initialProps: { b: book("us_female"), held: { voice: "us_female", timeline: old } },
    });
    expect([result.current.revision, result.current.resume]).toEqual([0, null]);

    rerender({ b: book("us_male"), held: { voice: "us_female", timeline: old } });
    expect([result.current.revision, result.current.voice]).toEqual([1, "us_male"]);
    // The session still holds the old Voice's timeline: where to go is not known yet.
    expect(result.current.resume).toEqual({ id: "resume-1", seconds: null, autoplay: true });
    // Asked once, however long the session takes to reload.
    rerender({ b: book("us_male"), held: { voice: "us_female", timeline: old } });
    rerender({ b: book("us_male"), held: { voice: "us_male", timeline: null } });
    expect(result.current.revision).toBe(1);
    expect(result.current.resume?.seconds).toBeNull();

    rerender({ b: book("us_male"), held: { voice: "us_male", timeline: timeline(5000) } });
    expect(result.current.resume).toEqual({ id: "resume-1", seconds: 10, autoplay: true });
    act(() => result.current.clearResume());
    expect(result.current.resume).toBeNull();
  });

  it("reloads when the page opens on a session still playing the old Voice", () => {
    const { result } = renderHook(({ b, held }: Props) => usePlaylist(b, at, held), {
      initialProps: { b: book("uk_male"), held: { voice: "us_female", timeline: timeline(4000) } },
    });
    expect(result.current.revision).toBe(1);
  });

  it("does not reload for the same Voice, or for a session holding another Book", () => {
    const { result, rerender } = renderHook(({ b, held }: Props) => usePlaylist(b, at, held), {
      initialProps: { b: book("uk_male"), held: { voice: "uk_male", timeline: null } as Held | null },
    });
    rerender({ b: book("uk_male"), held: null });
    expect(result.current.revision).toBe(0);
  });
});
