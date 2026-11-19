import { useEffect, useRef } from "react";
import { ApiRequestError, getBook } from "../api";

// Which Book this device's listening session holds, kept across reloads so the session comes back after one
// (paused at the last synced Sentence). Storage may be unavailable (private mode, blocked site data); the
// session then simply does not come back.

const KEY = "vocaleaf:listening-book";

export function rememberedBook(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

/** Remembers the session's Book, or forgets it with null (the Book was deleted, the user logged out). */
export function rememberBook(bookId: string | null): void {
  try {
    if (bookId === null) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, bookId);
  } catch {
    // Not remembered: a reload starts without a session, as before.
  }
}

interface Restore {
  /** The session holds no Book yet; a Book a page opened meanwhile wins over the remembered one. */
  vacant(): boolean;
  /** Opens the Book paused at `startMs`, the last synced Sentence's start (null: at the Book's start). */
  restore(bookId: string, startMs: number | null): void;
}

/**
 * After a reload, brings the remembered Book back into the session, paused at the last synced Sentence (synced
 * by any device). A Book that is gone is forgotten; one without audio is left alone.
 */
export function useRestoredSession(options: Restore): void {
  const latest = useRef(options);
  latest.current = options;
  useEffect(() => {
    const id = rememberedBook();
    if (id === null) return;
    let active = true;
    getBook(id).then(
      (book) => {
        if (active && book.playable && latest.current.vacant()) latest.current.restore(id, book.listening?.startMs ?? null);
      },
      (err: unknown) => {
        if (err instanceof ApiRequestError && err.status === 404) rememberBook(null);
        else console.warn("restoring the listening session failed", err);
      },
    );
    return () => {
      active = false;
    };
  }, []);
}
