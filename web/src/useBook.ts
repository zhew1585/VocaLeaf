import { useEffect, useState } from "react";
import { getBook, type BookDetail } from "./api";

/** While parsing, or until the first segment exists: the page is waiting on something the user is watching. */
const WAITING_POLL_MS = 1500;
/** Playable but still generating: status, Chapters and the Book's length change slowly. */
const GENERATING_POLL_MS = 15_000;

/** How soon to load the Book again, or null once nothing about it changes any more (已就绪 or 解析失败). */
export function nextPollMs(book: BookDetail): number | null {
  if (book.status === "parsing") return WAITING_POLL_MS;
  if (book.status !== "generating") return null;
  return book.playable ? GENERATING_POLL_MS : WAITING_POLL_MS;
}

/** Loads a Book and keeps it current while the worker is still working on it. */
export function useBook(id: string) {
  const [book, setBook] = useState<BookDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active = true;
    const load = async () => {
      try {
        const next = await getBook(id);
        if (!active) return;
        setBook(next);
        setError(null);
        const delay = nextPollMs(next);
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
  }, [id]);

  return { book, error };
}
