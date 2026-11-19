import { describe, expect, it } from "vitest";
import type { ReviewItem } from "../api";
import { intervalLabel, progressOf } from "./review";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

describe("intervalLabel", () => {
  it("names minutes, hours, days, months and years as the rating buttons show them", () => {
    expect([10_000, MINUTE, 10 * MINUTE, 59 * MINUTE].map(intervalLabel)).toEqual(["1 分钟", "1 分钟", "10 分钟", "59 分钟"]);
    expect([60 * MINUTE, 5 * 60 * MINUTE].map(intervalLabel)).toEqual(["1 小时", "5 小时"]);
    expect([DAY, 2 * DAY, 29 * DAY].map(intervalLabel)).toEqual(["1 天", "2 天", "29 天"]);
    expect([30 * DAY, 100 * DAY, 400 * DAY, 1000 * DAY].map(intervalLabel)).toEqual(["1 个月", "3 个月", "1 年", "3 年"]);
  });
});

describe("progressOf", () => {
  const queued = (...ids: string[]) => ids.map((id) => ({ card: { id } }) as ReviewItem);

  it("counts Cards that left the queue as done, out of every Card seen in it", () => {
    expect(progressOf(new Set(["a", "b", "c"]), queued("a", "b", "c"))).toEqual({ done: 0, total: 3 });
    // b rated 忘了 is due again today: still to do.
    expect(progressOf(new Set(["a", "b", "c"]), queued("c", "b"))).toEqual({ done: 1, total: 3 });
    expect(progressOf(new Set(["a", "b", "c"]), [])).toEqual({ done: 3, total: 3 });
  });
});
