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
