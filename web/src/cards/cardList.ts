// The Card list's searching and filtering (F14), done on the client over every Card of the user.
import type { CardListItem } from "../api";

/** Whether the Card's Target or Sentence holds the query, ignoring case (AC-CLIST-01); a blank query matches all. */
export function matchesSearch(card: CardListItem, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  return card.targetText.toLowerCase().includes(q) || card.sentenceText.toLowerCase().includes(q);
}

/** A Book Cards came from, as the filter offers it. */
export interface CardSource {
  key: string;
  label: string;
}

/**
 * The Card's source as the filter tells sources apart: its Book while on the Shelf, otherwise its title snapshot (all
 * Cards of a deleted Book share it).
 */
export function sourceKey(card: CardListItem): string {
  return card.bookId ?? `deleted:${card.bookTitle}`;
}

/** The source as the list shows it: the Book's title, marked when the Book is gone (design 07). */
export function sourceLabel(card: CardListItem): string {
  return card.bookId === null ? `${card.bookTitle}（已删除）` : card.bookTitle;
}

/** The source as the detail shows it: 【来源：《书名》（已删除）】 once the Book is gone (AC-CLIST-03). */
export function sourceDetail(card: CardListItem): string {
  return card.bookId === null ? `来源：《${card.bookTitle}》（已删除）` : card.bookTitle;
}

/** The sources of the Cards, each once, in the order their first Card comes. */
export function cardSources(cards: readonly CardListItem[]): CardSource[] {
  const seen = new Map<string, string>();
  for (const c of cards) {
    const key = sourceKey(c);
    if (!seen.has(key)) seen.set(key, sourceLabel(c));
  }
  return [...seen].map(([key, label]) => ({ key, label }));
}
