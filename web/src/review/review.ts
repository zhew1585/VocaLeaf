// What the 复习页 shows besides the Card (PRD 4.5.3, F13): the four ratings and their next intervals, and how far
// the queue is done.
import type { Rating, ReviewItem } from "../api";

/** The self-ratings in key order (1 to 4), with the tone of their label (design 06-2). */
export const RATINGS: readonly { rating: Rating; label: string; tone: "danger" | "amber" | "leaf" }[] = [
  { rating: 1, label: "忘了", tone: "danger" },
  { rating: 2, label: "困难", tone: "amber" },
  { rating: 3, label: "记得", tone: "leaf" },
  { rating: 4, label: "简单", tone: "leaf" },
];

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A next interval as a rating button shows it: 1 分钟, 10 分钟, 3 小时, 2 天, 4 个月, 1 年. */
export function intervalLabel(ms: number): string {
  if (ms < HOUR) return `${Math.max(1, Math.round(ms / MINUTE))} 分钟`;
  if (ms < DAY) return `${Math.round(ms / HOUR)} 小时`;
  const days = Math.round(ms / DAY);
  if (days < 30) return `${days} 天`;
  if (days < 365) return `${Math.round(days / 30)} 个月`;
  return `${Math.round(days / 365)} 年`;
}

/**
 * How far this visit's queue is: every Card seen in it so far, and how many of them have left it. A Card rated and
 * due again today (a learning step) is still to do.
 */
export function progressOf(seen: ReadonlySet<string>, queue: readonly ReviewItem[]): { done: number; total: number } {
  return { done: seen.size - queue.length, total: seen.size };
}
