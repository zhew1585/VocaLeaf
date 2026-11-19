import { useCallback, useEffect, useRef, useState } from "react";
import { getBook, type BookDetail } from "./api";

/** While parsing, or while the user waits on audio that is not there yet: they are watching for it. */
const WAITING_POLL_MS = 1500;
/** Generating with audio to play: progress (生成中 n/N) and Chapter statuses move every few seconds. */
const GENERATING_POLL_MS = 5000;

/** Whether the worker still has work on the Book: parsing, or a narrated Chapter still to generate. */
export function isWorking(book: BookDetail): boolean {
  return (
    book.status === "parsing" ||
    book.status === "generating" ||
    // A retried or newly narrated Chapter generates in a Book that is already 已就绪.
    book.chapters.some((c) => !c.skipped && (c.audioStatus === "pending" || c.audioStatus === "generating"))
  );
}

/**
 * How soon to load the Book again, or null once nothing about it changes any more. `eager` when the user is
 * waiting on a Chapter to become playable.
 */
export function nextPollMs(book: BookDetail, eager = false): number | null {
  if (!isWorking(book)) return null;
  return book.status === "parsing" || !book.playable || eager ? WAITING_POLL_MS : GENERATING_POLL_MS;
}

/**
 * Loads a Book and keeps it current while the worker is still working on it. `reload` loads it again at once,
 * after the user changed it (a retried Chapter, one set Skipped or narrated); so does `eager` turning on.
 */
export function useBook(id: string, { eager = false } = {}) {
  const [book, setBook] = useState<BookDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  // Read when the next poll is scheduled, so a change does not restart loading.
  const eagerRef = useRef(eager);
  eagerRef.current = eager;

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active = true;
    const load = async () => {
      try {
        const next = await getBook(id);
        if (!active) return;
        setBook(next);
        setError(null);
        const delay = nextPollMs(next, eagerRef.current);
        if (delay !== null) timer = setTimeout(load, delay);
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : "加载失败");
      }
    };
    void load();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [id, version]);

  const reload = useCallback(() => setVersion((v) => v + 1), []);
  // Starting to wait on audio: check now rather than at the next, slower, poll.
  const wasEager = useRef(eager);
  useEffect(() => {
    if (eager && !wasEager.current) reload();
    wasEager.current = eager;
  }, [eager, reload]);
  return { book, error, reload };
}
