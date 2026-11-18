// Where playback is in the Book's text, from the position in its continuous audio (PRD 4.4.5 跟读).
import type { ChapterSummary, Sentence } from "../api";

/** The Chapter playing at `ms`: the last one in the playlist that starts at or before it. */
export function playingChapterId(chapters: readonly ChapterSummary[], ms: number): string | null {
  let id: string | null = null;
  for (const c of chapters) if (c.startMs !== null && c.startMs <= ms) id = c.id;
  return id;
}

/**
 * The Sentence playing at `ms` among one Chapter's Sentences. In the pause after a Sentence it is still that
 * Sentence (highlight moves on only when the next one starts); in the pause before the Chapter's first Sentence
 * there is none.
 */
export function playingSentenceId(sentences: readonly Sentence[], ms: number): string | null {
  let id: string | null = null;
  for (const s of sentences) if (s.startMs !== null && s.startMs <= ms) id = s.id;
  return id;
}

/**
 * Whether Sentences fetched while their Chapter was generating are behind playback: some still lack a time and
 * playback has passed the end of every timed one, so newer times are on the server.
 */
export function timesBehind(sentences: readonly Sentence[], ms: number): boolean {
  let lastEnd = -1;
  let untimed = false;
  for (const s of sentences) {
    if (s.endMs === null) untimed = true;
    else lastEnd = Math.max(lastEnd, s.endMs);
  }
  return untimed && ms > lastEnd;
}

/** Consecutive Sentences of one paragraph, for laying the text out by paragraph (PRD 4.4.5). */
export function paragraphs(sentences: readonly Sentence[]): Sentence[][] {
  const out: Sentence[][] = [];
  for (const s of sentences) {
    const last = out.at(-1);
    if (last && last[0]!.paragraphIndex === s.paragraphIndex) last.push(s);
    else out.push([s]);
  }
  return out;
}
