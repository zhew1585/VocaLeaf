// How a selection in a Sentence becomes a Card's Target (PRD 4.5.2 制卡规则 2 and target_kind). Plain functions
// without dependencies, shared with the web client (`@vocaleaf/api/card-target`), so the selection it shows is the
// Target the API makes.

/** What a Card teaches: one word, several words, or the whole Sentence. Also the database enum. */
export const TARGET_KINDS = ["word", "phrase", "sentence"] as const;
export type TargetKind = (typeof TARGET_KINDS)[number];

/** A Target: characters [start, end) of its Sentence's text. */
export interface Target {
  start: number;
  end: number;
  kind: TargetKind;
}

/** Letters and digits, with apostrophes and hyphens inside a word ("don’t", "well-known"). */
const WORD = /[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu;

/** The words of a text as [start, end) ranges. */
function words(text: string): [number, number][] {
  return [...text.matchAll(WORD)].map((m) => [m.index, m.index + m[0].length]);
}

/**
 * The Target a selection of characters [start, end) of `text` makes: widened to whole words, without the spaces and
 * punctuation around them. Covering every word, it is the whole Sentence, punctuation included; one word is a word,
 * more a phrase. Null when the selection is out of range, empty or holds no word.
 */
export function resolveTarget(text: string, start: number, end: number): Target | null {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > text.length || start >= end) return null;
  const all = words(text);
  const touched = all.filter(([s, e]) => s < end && e > start);
  const first = touched[0];
  const last = touched.at(-1);
  if (!first || !last) return null;
  if (touched.length === all.length) return { start: 0, end: text.length, kind: "sentence" };
  return { start: first[0], end: last[1], kind: touched.length === 1 ? "word" : "phrase" };
}
