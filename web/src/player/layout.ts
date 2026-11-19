// Where each Chapter sits in a Book's playlist, and how a position carries over when that changes. The playlist
// normally only grows at its end, which the player follows by itself; when a Chapter comes in before its end (a
// retried or newly narrated Chapter, api/src/books/timeline.ts) or leaves it (set Skipped), the player must load
// it again and resume at the same place (session.tsx).
import type { BookDetail, BookTimeline } from "../api";

/** The Chapters with audio in the playlist, in playlist order; `endMs` is null while one is still generating. */
export type Layout = BookTimeline["chapters"];

/** The layout as the Book detail tells it. */
export function layoutOf(book: BookDetail): Layout {
  return book.chapters.flatMap((c) =>
    c.startMs === null
      ? []
      : [{ id: c.id, startMs: c.startMs, endMs: c.audioStatus === "generated" ? c.startMs + (c.durationMs ?? 0) : null }],
  );
}

/** Whether `next` is `prev` with Chapters appended (or unchanged): a player on `prev` follows it by itself. */
export function onlyAppends(prev: Layout, next: Layout): boolean {
  return prev.every((c, i) => next[i]?.id === c.id && next[i].startMs === c.startMs);
}

/**
 * The same place in the new layout: the same offset into the same Chapter. A Chapter that left the playlist
 * resumes at the start of the next one still in it (AC-BOOK-02), or at the end of the playlist, where the next
 * one comes in once generated.
 */
export function mapPosition(seconds: number, from: Layout, to: Layout): number {
  const ms = seconds * 1000;
  const at = from.findLastIndex((c) => c.startMs <= ms);
  for (let i = Math.max(at, 0); i < from.length; i++) {
    const there = to.find((c) => c.id === from[i]!.id);
    if (there) return (there.startMs + (i === at ? ms - from[i]!.startMs : 0)) / 1000;
  }
  const last = to.at(-1);
  return last ? (last.endMs ?? last.startMs) / 1000 : 0;
}

/** How many Sentences of the playlist start at or before `ms`, less one: the index of the Sentence playing there. */
export function sentenceIndexAt(starts: readonly number[], ms: number): number {
  return Math.max(0, starts.findLastIndex((s) => s <= ms));
}
