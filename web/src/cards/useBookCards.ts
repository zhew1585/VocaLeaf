import { useCallback, useEffect, useMemo, useState } from "react";
import { getBookCards, type Card } from "../api";

/** The user's Cards of one Book as its views use them. */
export interface CardsInBook {
  /** The Cards of each Sentence that has any, by Target start (the green underlines, PRD 4.4.5). */
  bySentence: ReadonlyMap<string, Card[]>;
  /** The Sentence's Cards; empty when it has none. */
  of(sentenceId: string): Card[];
  /** Adds a Card just made, or replaces one whose back was generated again. */
  put(card: Card): void;
}

const NONE: Card[] = [];

/** Loads the user's Cards of a Book (none while `bookId` is null) and keeps those made or changed here. */
export function useBookCards(bookId: string | null): CardsInBook {
  const [cards, setCards] = useState<Card[]>(NONE);

  useEffect(() => {
    setCards(NONE);
    if (bookId === null) return;
    let active = true;
    getBookCards(bookId).then(
      (loaded) => active && setCards(Array.isArray(loaded) ? loaded : NONE),
      // Without them the text shows no underlines; the next visit asks again.
      (err: unknown) => console.warn("loading the Book's Cards failed", err),
    );
    return () => {
      active = false;
    };
  }, [bookId]);

  const put = useCallback((card: Card) => {
    setCards((prev) => (prev.some((c) => c.id === card.id) ? prev.map((c) => (c.id === card.id ? card : c)) : [...prev, card]));
  }, []);

  return useMemo(() => {
    const bySentence = new Map<string, Card[]>();
    for (const c of cards) {
      if (c.sentenceId === null) continue;
      bySentence.set(c.sentenceId, [...(bySentence.get(c.sentenceId) ?? []), c]);
    }
    for (const list of bySentence.values()) list.sort((a, b) => a.targetStart - b.targetStart || a.targetEnd - b.targetEnd);
    return { bySentence, of: (id) => bySentence.get(id) ?? NONE, put };
  }, [cards, put]);
}
