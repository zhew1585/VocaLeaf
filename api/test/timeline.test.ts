import { describe, expect, it } from "vitest";
import { buildTimeline, estimateDurationMs, hasAudio, toM3u8, type TimelineChapterInput } from "../src/books/timeline.js";

const seg = (id: string, durationMs = 10_000) => ({ id, durationMs });
const ch = (id: string, audioStatus: TimelineChapterInput["audioStatus"], segments = [seg(`${id}-0`)], skipped = false) => ({
  id,
  audioStatus,
  segments,
  skipped,
});

describe("buildTimeline", () => {
  it("lays generated Chapters end to end, leaving out Skipped ones and failed ones that published nothing", () => {
    const t = buildTimeline([
      ch("a", "generated", [seg("a0"), seg("a1", 4_000)]),
      ch("skip", "pending", [], true),
      ch("fail", "failed", []),
      ch("partly", "failed", [seg("p0", 5_000)]),
      ch("b", "generated"),
    ]);
    expect(t.entries.map((e) => [e.chapterId, e.offsetMs])).toEqual([
      ["a", 0],
      ["partly", 14_000],
      ["b", 19_000],
    ]);
    expect(t.complete).toBe(true);
  });

  it("stops after a generating Chapter's segments so far", () => {
    const t = buildTimeline([ch("a", "generating"), ch("b", "generated")]);
    expect(t.entries.map((e) => e.chapterId)).toEqual(["a"]);
    expect(t.complete).toBe(false);
  });

  it("stops before a pending narrated Chapter", () => {
    const t = buildTimeline([ch("a", "generated"), ch("b", "pending", []), ch("c", "generated")]);
    expect(t.entries.map((e) => e.chapterId)).toEqual(["a"]);
    expect(t.complete).toBe(false);
  });

  it("has no audio when nothing was written yet, even with a Chapter generating", () => {
    expect(hasAudio(buildTimeline([ch("a", "generating", [])]))).toBe(false);
    expect(hasAudio(buildTimeline([ch("a", "generating")]))).toBe(true);
  });

  it("is complete and empty for a Book with no narrated Chapter", () => {
    expect(buildTimeline([ch("a", "pending", [], true)])).toEqual({ entries: [], complete: true });
  });
});

describe("toM3u8", () => {
  it("raises the target duration when a segment rounds above 10 seconds", () => {
    const m3u8 = toM3u8(buildTimeline([ch("a", "generated", [seg("a0", 10_400), seg("a1", 10_600)])]));
    expect(m3u8).toContain("#EXT-X-TARGETDURATION:11\n");
    expect(m3u8).toContain("#EXTINF:10.600,\nsegments/a1.ts\n");
  });

  it("puts no discontinuity before the first Chapter with audio", () => {
    const m3u8 = toM3u8(buildTimeline([ch("empty", "generated", []), ch("a", "generated")]));
    expect(m3u8).not.toContain("DISCONTINUITY");
  });
});

describe("estimateDurationMs", () => {
  const c = (audioStatus: TimelineChapterInput["audioStatus"], spokenChars: number, durationMs: number | null = null, skipped = false) => ({
    audioStatus,
    spokenChars,
    durationMs,
    skipped,
  });

  it("is unknown until a Chapter with text is generated", () => {
    expect(estimateDurationMs([c("generated", 0, 0), c("generating", 1000)])).toBeNull();
  });

  it("is exact once everything is generated, Skipped Chapters left out", () => {
    expect(estimateDurationMs([c("generated", 100, 7000), c("pending", 500, null, true), c("generated", 50, 4000)])).toBe(11_000);
  });

  it("estimates the Chapters still to generate at the generated ones' pace, failed ones counting as nothing", () => {
    expect(estimateDurationMs([c("generated", 100, 6000), c("generating", 200), c("pending", 100), c("failed", 900)])).toBe(24_000);
  });
});
