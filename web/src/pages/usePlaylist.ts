// Keeps the 专注页's player on the Book's playlist as it is now. The playlist normally only grows at its end,
// which the player follows by itself; when a retried Chapter is inserted before its end (api/src/books/
// timeline.ts), the player must load it again and resume at the same place.
import { useState } from "react";
import type { BookDetail } from "../api";
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

interface State {
  /** The layout the current player has. */
  layout: Layout;
  /** Counts reloads. */
  revision: number;
  /** Where the reloaded player resumes, until it has. */
  resume: StartRequest | null;
}

/** Where playback of the Book is now. */
export interface PlaybackAt {
  seconds: number;
  playing: boolean;
}

/**
 * Follows the Book's playlist layout. Returns the `revision` (a new one means the playlist must be loaded
 * again), where the reloaded playlist resumes, and `clearResume` for once it has resumed.
 */
export function usePlaylist(book: BookDetail | null, at: PlaybackAt) {
  const [state, setState] = useState<State>({ layout: [], revision: 0, resume: null });

  // Adjusted while rendering, so the old player never acts on positions of the new layout.
  const next = book ? layoutOf(book) : state.layout;
  if (!onlyAppends(state.layout, next)) {
    const revision = state.revision + 1;
    const seconds = mapPosition(at.seconds, state.layout, next);
    setState({ layout: next, revision, resume: { id: `resume-${revision}`, seconds, autoplay: at.playing } });
  } else if (next.length !== state.layout.length) {
    setState({ ...state, layout: next });
  }

  return {
    revision: state.revision,
    resume: state.resume,
    clearResume: () => setState((s) => (s.resume ? { ...s, resume: null } : s)),
  };
}
