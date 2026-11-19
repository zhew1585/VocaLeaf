import { useCallback, useEffect, useRef, useState } from "react";
import { getBookTimeline, type BookTimeline } from "../api";

/** While a narrated Chapter is still to generate, the timeline changes; it is loaded again this often. */
const GROWING_REFRESH_MS = 10_000;
/** What a Book holds until its timeline is loaded: nothing, and more to come. */
const NOT_LOADED: BookTimeline = { sentenceStartsMs: [], chapters: [], complete: false, settled: false };

/**
 * The listening session's Book timeline (GET /books/:id/timeline), loaded when the Book or its playlist changes,
 * and again every 10 seconds while it is not settled (a Chapter may still come in).
 * `covering` answers for a position: the timeline as held when it covers that position, loaded again first when
 * the playlist may have grown past it.
 */
export function useBookTimeline(bookId: string | null, reloads: number) {
  const [timeline, setTimeline] = useState<BookTimeline | null>(null);
  // The latest timeline and the Book it belongs to, for `fresh` called from event handlers.
  const held = useRef<{ bookId: string; timeline: BookTimeline } | null>(null);

  // Counts (re)loads of the playlist; a timeline asked for before the latest one may describe the old playlist.
  const generation = useRef(0);

  const load = useCallback(async (id: string): Promise<BookTimeline | null> => {
    const asked = generation.current;
    try {
      const loaded = await getBookTimeline(id);
      // A Book switched or a playlist reloaded meanwhile keeps its own timeline.
      if (held.current?.bookId !== id || asked !== generation.current) return null;
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
    generation.current += 1;
    held.current = bookId === null ? null : { bookId, timeline: NOT_LOADED };
    setTimeline(null);
    if (bookId !== null) void load(bookId);
  }, [bookId, reloads, load]);

  const changing = bookId !== null && timeline !== null && !timeline.settled;
  useEffect(() => {
    if (!changing) return;
    const timer = setInterval(() => void load(bookId), GROWING_REFRESH_MS);
    return () => clearInterval(timer);
  }, [changing, bookId, load]);

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
