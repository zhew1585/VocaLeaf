// How Cards show in text and in the 卡片浮窗 (PRD 4.4.5, F16): a Sentence cut into runs by its Cards' Targets,
// which Cards a click hits, and the labels of a Card's kind and next Review.
import type { Card, TargetKind } from "../api";

/** A run of a Sentence's text, and the Cards whose Target covers it (none: not underlined). */
export interface TextRun {
  start: number;
  end: number;
  text: string;
  cardIds: string[];
}

/**
 * Cuts the text at every Target boundary of its Cards. Runs covered by any Card are underlined; one covered by a
 * whole-Sentence Card and a phrase Card belongs to both (PRD 4.4.5 一句多卡).
 */
export function textRuns(text: string, cards: readonly Card[]): TextRun[] {
  const cuts = new Set([0, text.length]);
  for (const c of cards) {
    cuts.add(Math.min(c.targetStart, text.length));
    cuts.add(Math.min(c.targetEnd, text.length));
  }
  const points = [...cuts].sort((a, b) => a - b);
  return points.slice(1).map((end, i) => {
    const start = points[i]!;
    const cardIds = cards.filter((c) => c.targetStart <= start && c.targetEnd >= end).map((c) => c.id);
    return { start, end, text: text.slice(start, end), cardIds };
  });
}

/** The Cards a click on a run hits: those of its underline, or all of the Sentence's off any underline (PRD 4.4.5). */
export function cardsHit(cards: readonly Card[], hitIds: readonly string[] | null): Card[] {
  if (!hitIds || hitIds.length === 0) return [...cards];
  return cards.filter((c) => hitIds.includes(c.id));
}

/** A Card without a back (PRD 4.5.2 规则 6); the API says the same (contract CARD_BACK_FAILED_MESSAGE). */
export const CARD_BACK_FAILED = "释义生成失败，点击重试";
/** The same, short, where a Card's meaning would be (the popover's list). */
export const BACK_MISSING = "释义生成失败";

export const KIND_LABELS: Record<TargetKind, string> = { word: "单词", phrase: "短语", sentence: "整句" };

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole local days from `now`'s day to `due`'s day; 0 or less is due today. */
function daysUntil(due: string, now: Date): number {
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Math.round((day(new Date(due)) - day(now)) / DAY_MS);
}

/** When a Card is next reviewed, short (the list): 今天, 明天, N 天后. */
export function dueShort(due: string, now = new Date()): string {
  const days = daysUntil(due, now);
  if (days <= 0) return "今天";
  if (days === 1) return "明天";
  return `${days} 天后`;
}

/** When a Card is next reviewed (a Card's detail): 今天复习, 明天复习, N 天后复习. */
export function dueLabel(due: string, now = new Date()): string {
  return `${dueShort(due, now)}复习`;
}

/** The Card's meaning in one line: a word or phrase's 语境义, a Sentence's translation; empty without a back. */
export function cardMeaning(card: Card): string {
  const back = card.back;
  if (!back) return "";
  return back.kind === "sentence" ? back.translation : back.meaning;
}
