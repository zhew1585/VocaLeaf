import { describe, expect, it } from "vitest";
import {
  DEFAULT_RENDER_MS_PER_CHAR,
  FIRST_SEGMENT_CHARS,
  queueWaits,
  renderPace,
  type OpenRenderJob,
} from "../src/books/wait.js";

const t0 = new Date("2026-11-18T00:00:00Z");
const job = (chapterId: string, position: number, remainingChars: number, extra: Partial<OpenRenderJob> = {}) => ({
  id: `job-${chapterId}`,
  chapterId,
  running: false,
  position,
  createdAt: t0,
  remainingChars,
  ...extra,
});

describe("queueWaits", () => {
  it("makes each Chapter wait for the work ahead of it plus its own first segment", () => {
    // 10 ms per character: 1000 characters are 10 seconds.
    const waits = queueWaits([job("b", 2, 3000), job("a", 1, 1000), job("c", 3, 50)], 10);
    expect(Object.fromEntries(waits)).toEqual({
      a: Math.ceil((FIRST_SEGMENT_CHARS * 10) / 1000),
      b: Math.ceil(((1000 + FIRST_SEGMENT_CHARS) * 10) / 1000),
      c: Math.ceil(((4000 + 50) * 10) / 1000),
    });
  });

  it("puts running jobs first, then queued ones by position, then by age, as claims take them", () => {
    const later = new Date(t0.getTime() + 1000);
    const waits = queueWaits(
      [
        job("queued-old", 1, 1000),
        job("queued-new", 1, 1000, { createdAt: later }),
        job("running", 5, 1000, { running: true }),
      ],
      1,
    );
    const order = [...waits].sort((x, y) => x[1] - y[1]).map(([id]) => id);
    expect(order).toEqual(["running", "queued-old", "queued-new"]);
  });

  it("never estimates less than a second", () => {
    expect(queueWaits([job("a", 1, 0)], 10).get("a")).toBe(1);
  });
});

describe("renderPace", () => {
  it("is the measured milliseconds per character over the samples", () => {
    expect(renderPace([{ chars: 100, ms: 3000 }, { chars: 300, ms: 5000 }])).toBe(20);
  });

  it("falls back to the default before anything was generated", () => {
    expect(renderPace([])).toBe(DEFAULT_RENDER_MS_PER_CHAR);
    expect(renderPace([{ chars: 0, ms: 0 }])).toBe(DEFAULT_RENDER_MS_PER_CHAR);
  });
});
