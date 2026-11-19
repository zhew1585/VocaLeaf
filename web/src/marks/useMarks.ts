import { useCallback, useEffect, useMemo, useState } from "react";
import { getBookMarks, getGleaningCount } from "../api";
import { MARKS_CHANGED_EVENT, markSentence, unmarkSentence, withQueued, type MarkOutcome, type MarksChange } from "./marks";

/** Calls `onChange` (keep it stable) with every MARKS_CHANGED_EVENT while mounted. */
export function useMarksChanged(onChange: (change: MarksChange) => void) {
  useEffect(() => {
    const listener = (e: Event) => onChange((e as CustomEvent<MarksChange>).detail);
    window.addEventListener(MARKS_CHANGED_EVENT, listener);
    return () => window.removeEventListener(MARKS_CHANGED_EVENT, listener);
  }, [onChange]);
}

/** The Marks of one Book as its views use them; see useBookMarks. */
export interface MarksInBook {
  /** Sentences with a pending Mark: underlined in the reading view (PRD 4.4.5), a filled leaf in 句子精读. */
  pending: ReadonlySet<string>;
  isMarked(sentenceId: string): boolean;
  /** Marks the Sentence (PRD 4.4.2); offline it waits on the device and goes out later. */
  mark(sentenceId: string): Promise<MarkOutcome>;
  /** Deletes the Sentence's Mark: 撤销 and 取消标记 (PRD 4.4.2 规则 4). */
  unmark(sentenceId: string): Promise<void>;
}

/**
 * The user's pending Marks in a Book, kept up to date with every change on this device whoever makes it (【标记】, M,
 * the leaf in 句子精读, Gleanings). The one entry point for marking a Sentence: 句子精读's leaf toggle is
 * `isMarked(id) ? unmark(id) : mark(id)`.
 */
export function useBookMarks(bookId: string): MarksInBook {
  const [pending, setPending] = useState<ReadonlySet<string>>(() => withQueued([]));
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    let active = true;
    getBookMarks(bookId).then(
      (marks) => active && setPending(withQueued(Array.isArray(marks?.pending) ? marks.pending : [])),
      // Offline the Marks made on this device still show; the next change or reload asks again.
      (err: unknown) => console.warn("loading the Book's Marks failed", err),
    );
    return () => {
      active = false;
    };
  }, [bookId, reloads]);

  useMarksChanged(
    useCallback((change: MarksChange) => {
      if (change === null) return setReloads((n) => n + 1);
      // A Sentence of another Book never gets asked about here, so it needs no filtering out.
      setPending((prev) => {
        if (prev.has(change.sentenceId) === change.pending) return prev;
        const next = new Set(prev);
        if (change.pending) next.add(change.sentenceId);
        else next.delete(change.sentenceId);
        return next;
      });
    }, []),
  );

  return useMemo(
    () => ({ pending, isMarked: (id) => pending.has(id), mark: markSentence, unmark: unmarkSentence }),
    [pending],
  );
}

/** How many Sentences wait in Gleanings, for the navigation's badge; null until known. */
export function useGleaningCount(): number | null {
  const [count, setCount] = useState<number | null>(null);
  const [reloads, setReloads] = useState(0);
  useEffect(() => {
    let active = true;
    getGleaningCount().then(
      (r) => active && setCount(typeof r?.count === "number" ? r.count : null),
      (err: unknown) => console.warn("loading the Gleanings count failed", err),
    );
    return () => {
      active = false;
    };
  }, [reloads]);
  useMarksChanged(useCallback(() => setReloads((n) => n + 1), []));
  return count;
}

/** The badge text: the count, 99+ above 99 (PRD 4.4.4), nothing at 0. */
export function badgeText(count: number | null): string | null {
  if (!count) return null;
  return count > 99 ? "99+" : String(count);
}
