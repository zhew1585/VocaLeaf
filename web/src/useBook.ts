import { useEffect, useState } from "react";
import { getBook, type BookDetail } from "./api";

const POLL_MS = 1500;

/**
 * Loads a Book, and loads it again every 1.5 s while `keepPolling` says the worker is still changing
 * something the page shows (parsing, or no audio yet).
 */
export function useBook(id: string, keepPolling: (book: BookDetail) => boolean) {
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
        if (next.status !== "parse_failed" && keepPolling(next)) timer = setTimeout(load, POLL_MS);
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : "加载失败");
      }
    };
    void load();
    return () => {
      active = false;
      clearTimeout(timer);
    };
    // keepPolling is a per-page rule, not data: a new function on each render must not restart loading.
  }, [id]);

  return { book, error };
}
