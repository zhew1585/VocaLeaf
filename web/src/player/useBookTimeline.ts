import { useCallback, useEffect, useRef, useState } from "react";
import { getBookTimeline, type BookTimeline } from "../api";

/** While the Book generates, its timeline grows; it is loaded again this often. */
const GROWING_REFRESH_MS = 10_000;
/** What a Book holds until its timeline is loaded: nothing, and more to come. */
const NOT_LOADED: BookTimeline = { sentenceStartsMs: [], chapters: [], complete: false };

/**
 * The listening session's Book timeline (GET /books/:id/timeline), loaded when the Book or its playlist changes
 * and again every 10 seconds while it grows. `covering` answers for a position: the timeline as held when it covers
 * that position, loaded again first when the playlist may have grown past it.
 */
export function useBookTimeline(bookId: string | null, reloads: number) {
  const [timeline, setTimeline] = useState<BookTimeline | null>(null);
  // The latest timeline and the Book it belongs to, for `fresh` called from event handlers.
  const held = useRef<{ bookId: string; timeline: BookTimeline } | null>(null);

  const load = useCallback(async (id: string): Promise<BookTimeline | null> => {
    try {
      const loaded = await getBookTimeline(id);
      // A Book switched meanwhile keeps its own timeline.
      if (held.current?.bookId !== id) return null;
      held.current = { bookId: id, timeline: loaded };
      setTimeline(loaded);
      return loaded;
    } catch (err) {
      // The controls keep the timeline they have; the next refresh or press asks again.
      console.warn("loading the Book timeline failed", err);
      return held.current?.bookId === id ? held.current.timeline : null;
    }
  }, []);

  useEffect(() => {
    held.current = bookId === null ? null : { bookId, timeline: NOT_LOADED };
    setTimeline(null);
    if (bookId !== null) void load(bookId);
  }, [bookId, reloads, load]);

  const growing = bookId !== null && timeline !== null && !timeline.complete;
  useEffect(() => {
    if (!growing) return;
    const timer = setInterval(() => void load(bookId), GROWING_REFRESH_MS);
    return () => clearInterval(timer);
  }, [growing, bookId, load]);

  const covering = useCallback(
    async (positionMs: number): Promise<BookTimeline | null> => {
      const current = held.current;
      if (current === null) return null;
      const last = current.timeline.sentenceStartsMs.at(-1);
      if (current.timeline.complete || (last !== undefined && last > positionMs)) return current.timeline;
      return load(current.bookId);
    },
    [load],
  );

  return { timeline, covering };
}
