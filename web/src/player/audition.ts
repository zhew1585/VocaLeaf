// 试听 (PRD 4.4.1 试听与主播放): one Sentence played on its own audio element, beside the main playback. Only one
// sound at a time: a 试听 that starts while the main playback plays interrupts it, and once the Sentence is read
// the main playback goes on from the start of the Sentence it was interrupted in (AC-PLAY-12). Started while paused,
// it stays paused (AC-PLAY-13); stopped by hand (Space, 暂停, another Sentence), nothing goes on (AC-PLAY-14).
import { useEffect, useRef, useState, type RefObject } from "react";
import { useHls } from "./hls";

/** The Sentence to play, by its place in the Book's audio. */
export interface AuditionSentence {
  id: string;
  startMs: number;
  endMs: number;
}

export interface AuditionState {
  sentenceId: string;
  /** Until its audio starts playing (the button shows a thin ring). */
  loading: boolean;
}

interface Options {
  /** The main playback's element. */
  main: RefObject<HTMLAudioElement | null>;
  /** The session Book's playlist, or null with none. */
  src: string | null;
  /** Start of every Sentence in the Book's audio, as far as known. */
  sentenceStartsMs(): number[];
  /** Plays the main element from `seconds` (the session's play, which reports failures). */
  resumeMain(el: HTMLAudioElement, seconds: number): void;
}

/** Where the Sentence holding `positionMs` starts; the position itself when no Sentence start is known before it. */
function sentenceStartAt(starts: number[], positionMs: number): number {
  return starts.findLast((s) => s <= positionMs) ?? positionMs;
}

export function useAudition({ main, src, sentenceStartsMs, resumeMain }: Options) {
  const element = useRef<HTMLAudioElement>(null);
  const [current, setCurrent] = useState<(AuditionSentence & { n: number; loading: boolean }) | null>(null);
  const count = useRef(0);
  // Where the main playback goes on from once the 试听 is read, when it interrupted the main playback.
  const interruptedAtMs = useRef<number | null>(null);

  // A fresh hls.js per 试听, loading from its Sentence.
  useHls(element, current && src, current?.n ?? 0, () => end(true), (current?.startMs ?? 0) / 1000);

  useEffect(() => {
    const el = element.current;
    if (!current || !el) return;
    el.play().catch((err: unknown) => {
      if (!(err instanceof DOMException && err.name === "AbortError")) console.warn("试听 failed to play", err);
    });
  }, [current?.n]);

  /** Ends the 试听; `resume` lets an interrupted main playback go on. */
  const end = (resume: boolean) => {
    element.current?.pause();
    setCurrent(null);
    const at = interruptedAtMs.current;
    interruptedAtMs.current = null;
    const el = main.current;
    if (resume && at !== null && el) resumeMain(el, at / 1000);
  };

  const start = (sentence: AuditionSentence) => {
    const el = main.current;
    // A 试听 replacing another keeps what the first interrupted.
    if (el && !el.paused && current === null) {
      interruptedAtMs.current = sentenceStartAt(sentenceStartsMs(), el.currentTime * 1000);
      el.pause();
    }
    setCurrent({ ...sentence, n: ++count.current, loading: true });
  };

  const onTimeUpdate = () => {
    const el = element.current;
    if (current && el && el.currentTime * 1000 >= current.endMs) end(true);
  };

  return {
    element,
    state: current ? ({ sentenceId: current.id, loading: current.loading } satisfies AuditionState) : null,
    active: current !== null,
    start,
    /** Stops by hand: the main playback stays paused. */
    stop: () => {
      if (current) end(false);
    },
    /** Media events of the 试听's element. */
    events: {
      onPlaying: () => setCurrent((c) => (c ? { ...c, loading: false } : c)),
      onTimeUpdate,
      onEnded: () => end(true),
      // Native HLS (iOS Safari) starts at the playlist's beginning; move to the Sentence.
      onLoadedMetadata: () => {
        const el = element.current;
        if (current && el && Math.abs(el.currentTime * 1000 - current.startMs) > 300) el.currentTime = current.startMs / 1000;
      },
    },
  };
}
