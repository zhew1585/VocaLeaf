import { useCallback, useEffect, useState } from "react";
import { getShelf, type Book } from "../api";

/** While a Book on the Shelf is parsing or generating, its status and 生成中 n/N move every few seconds. */
const WORKING_POLL_MS = 3000;

function isWorking(book: Book): boolean {
  return book.status === "parsing" || book.status === "generating";
}

/**
 * Loads the user's Shelf and keeps it current while the worker is busy with any of its Books (AC-SHELF-02);
 * `reload` loads it again at once (a Book was just uploaded).
 */
export function useShelf() {
  const [books, setBooks] = useState<Book[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active = true;
    const load = async () => {
      try {
        const next = await getShelf();
        if (!active) return;
        setBooks(next);
        setError(null);
        if (next.some(isWorking)) timer = setTimeout(load, WORKING_POLL_MS);
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : "加载失败");
      }
    };
    void load();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [version]);

  const reload = useCallback(() => setVersion((v) => v + 1), []);
  return { books, error, reload };
}
