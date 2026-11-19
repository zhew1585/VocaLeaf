// Keeps the 专注页's player on the Book's playlist as it is now. The playlist normally only grows at its end,
// which the player follows by itself; when a retried Chapter is inserted before its end (api/src/books/
// timeline.ts), the player must load it again and resume at the same place. When the Book's Voice changed
// (api/src/jobs/voice-change.ts), all of its audio is new: the player loads it and resumes at the same Sentence
// (PRD 4.2.4 rule 3), which sits elsewhere in the new Voice's audio.
import { useState } from "react";
import type { BookDetail, BookTimeline, Voice } from "../api";
import type { StartRequest } from "../player/playback";

/** Where each Chapter with audio starts in the playlist, in playlist order. */
export type Layout = { id: string; startMs: number }[];

export function layoutOf(book: BookDetail): Layout {
  return book.chapters.flatMap((c) => (c.startMs === null ? [] : [{ id: c.id, startMs: c.startMs }]));
}

/** Whether `next` is `prev` with Chapters appended (or unchanged): a player on `prev` follows it by itself. */
export function onlyAppends(prev: Layout, next: Layout): boolean {
  return prev.every((c, i) => next[i]?.id === c.id && next[i].startMs === c.startMs);
}

/**
 * The same place in the new layout: the same offset into the same Chapter. A Chapter that left the playlist
 * resumes at the start of the next one still in it.
 */
export function mapPosition(seconds: number, from: Layout, to: Layout): number {
  const ms = seconds * 1000;
  const at = from.findLastIndex((c) => c.startMs <= ms);
  for (let i = Math.max(at, 0); i < from.length; i++) {
    const there = to.find((c) => c.id === from[i]!.id);
    if (there) return (there.startMs + (i === at ? ms - from[i]!.startMs : 0)) / 1000;
  }
  return 0;
}

/** How many Sentences of the playlist start at or before `ms`, less one: the index of the Sentence playing there. */
export function sentenceIndexAt(starts: number[], ms: number): number {
  return Math.max(0, starts.findLastIndex((s) => s <= ms));
}

/**
 * Where the reloaded player resumes: a position in the new playlist, or the start of the Sentence that was
 * playing, the `index`th of the playlist, once the timeline of the new playlist (another object than `from`, the
 * old one) is loaded.
 */
type Resume =
  | { kind: "position"; request: StartRequest }
  | { kind: "sentence"; id: string; index: number; from: BookTimeline; autoplay: boolean };

interface State {
  /** The layout the current player has. */
  layout: Layout;
  /** The Voice the last reload was for, so the reload is asked once while the session catches up. */
  reloadedFor: Voice | null;
  /** Counts reloads. */
  revision: number;
  /** Where the reloaded player resumes, until it has. */
  resume: Resume | null;
}

function toRequest(resume: Resume | null, timeline: BookTimeline | null): StartRequest | null {
  if (resume === null) return null;
  if (resume.kind === "position") return resume.request;
  // Until the session holds the new playlist's timeline, where to go is not known yet.
  if (timeline === null || timeline === resume.from) return { id: resume.id, seconds: null, autoplay: resume.autoplay };
  const starts = timeline.sentenceStartsMs;
  const ms = starts[resume.index] ?? starts.at(-1) ?? 0;
  return { id: resume.id, seconds: ms / 1000, autoplay: resume.autoplay };
}

/** Where playback of the Book is now. */
export interface PlaybackAt {
  seconds: number;
  playing: boolean;
}

/** What the listening session holds of this Book: its audio's Voice and timeline. */
export interface Held {
  voice: Voice | null;
  timeline: BookTimeline | null;
}

/**
 * Follows the Book's playlist layout and Voice. Returns the `revision` (a new one means the playlist must be
 * loaded again), the Voice to load it in, where the reloaded playlist resumes, and `clearResume` for once it has
 * resumed. `held` is what the session holds when it holds this Book (null otherwise): audio in another Voice than
 * the Book's is reloaded at the Sentence playing, also when the page opens on a session still playing it.
 */
export function usePlaylist(book: BookDetail | null, at: PlaybackAt, held: Held | null = null) {
  const [state, setState] = useState<State>({ layout: [], reloadedFor: null, revision: 0, resume: null });

  // Adjusted while rendering, so the old player never acts on positions of the new layout.
  const next = book ? layoutOf(book) : state.layout;
  const voiceChanged =
    book !== null && held?.voice != null && held.voice !== book.voice && state.reloadedFor !== book.voice;
  if (voiceChanged || !onlyAppends(state.layout, next)) {
    const revision = state.revision + 1;
    const id = `resume-${revision}`;
    const timeline = held?.timeline;
    const resume: Resume =
      voiceChanged && timeline
        ? { kind: "sentence", id, index: sentenceIndexAt(timeline.sentenceStartsMs, at.seconds * 1000), from: timeline, autoplay: at.playing }
        : { kind: "position", request: { id, seconds: mapPosition(at.seconds, state.layout, next), autoplay: at.playing } };
    setState({ layout: next, reloadedFor: book?.voice ?? state.reloadedFor, revision, resume });
  } else if (next.length !== state.layout.length) {
    setState({ ...state, layout: next });
  }

  return {
    revision: state.revision,
    voice: book?.voice,
    resume: toRequest(state.resume, held?.timeline ?? null),
    clearResume: () => setState((s) => (s.resume ? { ...s, resume: null } : s)),
  };
}
