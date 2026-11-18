import { describe, expect, it } from "vitest";
import { buildTimeline, hasAudio, toM3u8, type TimelineChapterInput } from "../src/books/timeline.js";

const seg = (id: string, durationMs = 10_000) => ({ id, durationMs });
const ch = (id: string, audioStatus: TimelineChapterInput["audioStatus"], segments = [seg(`${id}-0`)], skipped = false) => ({
  id,
  audioStatus,
  segments,
  skipped,
});

describe("buildTimeline", () => {
  it("lays generated Chapters end to end, leaving out Skipped and passing over failed ones", () => {
    const t = buildTimeline([
      ch("a", "generated", [seg("a0"), seg("a1", 4_000)]),
      ch("skip", "pending", [], true),
      ch("fail", "failed", [seg("f0")]),
      ch("b", "generated"),
    ]);
    expect(t.entries.map((e) => [e.chapterId, e.offsetMs])).toEqual([
      ["a", 0],
      ["b", 14_000],
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
