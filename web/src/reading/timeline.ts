// Where playback is in the reading view: which Chapter and Sentence the Book's audio position falls in.
import type { ChapterSummary } from "../api";

/** What the reading view keeps of a Sentence (word timings are not shown, PRD 4.4.5). */
export interface ReadingSentence {
  id: string;
  paragraphIndex: number;
  text: string;
  /** Position in the Book's audio; null until its Chapter is placed in the playlist. */
  startMs: number | null;
}

/** The Chapter whose audio holds the position: the last placed one starting at or before it. */
export function playingChapterId(chapters: ChapterSummary[], positionMs: number): string | null {
  let found: string | null = null;
  for (const c of chapters) {
    if (c.startMs === null) continue;
    if (c.startMs > positionMs) break;
    found = c.id;
  }
  return found;
}

/**
 * The Sentence being read at the position: the last timed one starting at or before it, so the pause after a
 * Sentence still belongs to it. Before the first one starts, that first one. Timed Sentences come first and in
 * order (a generating Chapter times its Sentences from the start), so a binary search finds it.
 */
export function currentSentenceId(sentences: ReadingSentence[], positionMs: number): string | null {
  let lo = 0;
  let hi = sentences.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const start = sentences[mid]!.startMs;
    if (start !== null && start <= positionMs) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0) return sentences[lo - 1]!.id;
  return sentences[0]?.startMs != null ? sentences[0].id : null;
}

/** Sentences grouped into their paragraphs, in reading order. */
export function paragraphs(sentences: ReadingSentence[]): ReadingSentence[][] {
  const out: ReadingSentence[][] = [];
  for (const s of sentences) {
    const last = out.at(-1);
    if (last && last[0]!.paragraphIndex === s.paragraphIndex) last.push(s);
    else out.push([s]);
  }
  return out;
}

/** Reading column widths of F7, by which side panels are open. */
const COLUMN = { both: 620, sentencePanel: 680, directory: 720, none: 760 } as const;

/** Width of the reading column and the player for each combination of open side panels (F7). */
export function columnWidth({ directory, sentencePanel }: { directory: boolean; sentencePanel: boolean }): number {
  if (sentencePanel) return directory ? COLUMN.both : COLUMN.sentencePanel;
  return directory ? COLUMN.directory : COLUMN.none;
}
