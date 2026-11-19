// Unit tests of FSRS scheduling (review/schedule.ts): the intervals shown are the ones ratings give.
import { describe, expect, it } from "vitest";
import type { Rating } from "../src/contract.js";
import { nextIntervals, rateSchedule, type Schedule } from "../src/review/schedule.js";

const created = new Date("2026-11-18T00:00:00Z");
const fresh: Schedule = {
  due: created,
  state: "new",
  stability: 0,
  difficulty: 0,
  scheduledDays: 0,
  learningSteps: 0,
  reps: 0,
  lapses: 0,
  lastReviewedAt: null,
  firstReviewedAt: null,
};
const RATINGS: Rating[] = [1, 2, 3, 4];

describe("FSRS scheduling", () => {
  it("rates a Card to exactly the interval previewed for each rating, at any state", () => {
    let s = fresh;
    let now = new Date(created.getTime() + 60_000);
    for (const step of [3, 3, 1, 4, 2]) {
      const intervals = nextIntervals(s, now);
      for (const r of RATINGS) expect(rateSchedule(s, r, now).due.getTime() - now.getTime()).toBe(intervals[r - 1]);
      s = rateSchedule(s, step as Rating, now);
      now = new Date(s.due.getTime() + 1000);
    }
    expect(s.reps).toBe(5);
    expect(s.lapses).toBe(1);
  });

  it("keeps when the Card was first rated, and when it was last", () => {
    const first = new Date("2026-11-18T01:00:00Z");
    const once = rateSchedule(fresh, 3, first);
    const later = new Date("2026-11-18T01:20:00Z");
    const twice = rateSchedule(once, 3, later);

    expect(once).toMatchObject({ firstReviewedAt: first, lastReviewedAt: first, state: "learning", reps: 1 });
    expect(twice).toMatchObject({ firstReviewedAt: first, lastReviewedAt: later });
  });
});
