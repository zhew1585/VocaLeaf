// Where the player's controls take playback, from the Book's timeline (GET /books/:id/timeline): 重听 (PRD
// 4.4.3), 下一句, and the end of the Chapter for the sleep timer. All positions are milliseconds of the Book's audio.
import type { BookTimeline } from "../api";

/** Reaction compensation (PRD 4.7.2): a Sentence that began less than this long ago counts as not heard yet. */
export const REACTION_MS = 1500;

/** Index of the last Sentence starting at or before the position, or -1 before the first one. */
function currentIndex(starts: readonly number[], positionMs: number): number {
  let lo = 0;
  let hi = starts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid]! <= positionMs) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

export interface ReplayContext {
  /** Playback speed; the 1.5 s are listening time. */
  rate: number;
  /**
   * Where playback last landed by a jump other than 重听 / 下一句 (a dragged progress bar, a picked Chapter, a
   * resume), or null. Until playback crosses a Sentence start on its own after it, there is no reaction
   * compensation (PRD G2): the user just chose that Sentence.
   */
  landedAtMs: number | null;
}

/**
 * 重听 (PRD 4.4.3): the start of the previous Sentence when the current one began less than 1.5 s of listening
 * ago, otherwise the start of the current one. Before the first Sentence, the first one; null without Sentences.
 */
export function replayTargetMs(starts: readonly number[], positionMs: number, { rate, landedAtMs }: ReplayContext): number | null {
  if (starts.length === 0) return null;
  const i = currentIndex(starts, positionMs);
  if (i < 0) return starts[0]!;
  const start = starts[i]!;
  const justJumped = landedAtMs !== null && landedAtMs >= start;
  const justBegan = (positionMs - start) / rate < REACTION_MS;
  return justBegan && !justJumped && i > 0 ? starts[i - 1]! : start;
}

/** 下一句: the start of the Sentence after the current one, or null at the last Sentence known. */
export function nextSentenceMs(starts: readonly number[], positionMs: number): number | null {
  return starts[currentIndex(starts, positionMs) + 1] ?? null;
}

/** End of the Chapter holding the position, or null while it is still generating (or before any Chapter). */
export function chapterEndAt(chapters: BookTimeline["chapters"], positionMs: number): number | null {
  const chapter = chapters.findLast((c) => c.startMs <= positionMs);
  return chapter?.endMs ?? null;
}
