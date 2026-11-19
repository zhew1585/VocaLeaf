// 试听 (PRD 4.4.1 试听与主播放): one Sentence played on its own audio element, beside the main playback. Only one
// sound at a time: a 试听 that starts while the main playback plays interrupts it, and once the Sentence is read
// the main playback goes on from the start of the Sentence it was interrupted in (AC-PLAY-12). Started while paused,
// it stays paused (AC-PLAY-13); stopped by hand (Space, 暂停, another Sentence), nothing goes on (AC-PLAY-14).
// A Card's 卡片原声 (F16, AC-POP-05) plays the same way, from the Card's own audio file instead of the Book's audio.
import { useEffect, useRef, useState, type RefObject } from "react";
import { useHls } from "./hls";

/** The Sentence to play, by its place in the Book's audio. */
export interface AuditionSentence {
  id: string;
  startMs: number;
  endMs: number;
  /** The playlist of its Book when that is not the session's (拾起 lists Sentences of every Book). */
  playlist?: string;
}

/** A Card's own copy of its Sentence's audio, played whole (【卡片原声】). */
export interface AuditionClip {
  /** The Card's id. */
  id: string;
  src: string;
}

export type AuditionSource = AuditionSentence | AuditionClip;

const isClip = (source: AuditionSource): source is AuditionClip => "src" in source;

export interface AuditionState {
  /** The Sentence's or Card's id. */
  id: string;
  /** Until its audio starts playing (the button shows a thin ring). */
  loading: boolean;
  /** Its audio could not be loaded (【音频加载失败】); kept until the next 试听 starts or one is stopped. */
  failed: boolean;
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
  const [current, setCurrent] = useState<(AuditionSource & { n: number; loading: boolean }) | null>(null);
  const [failedId, setFailedId] = useState<string | null>(null);
  const count = useRef(0);
  // Where the main playback goes on from once the 试听 is read, when it interrupted the main playback.
  const interruptedAtMs = useRef<number | null>(null);

  const sentence = current && !isClip(current) ? current : null;
  // A fresh hls.js per 试听 of a Sentence, loading from it; a Card's clip is a plain file.
  useHls(element, sentence && (sentence.playlist ?? src), current?.n ?? 0, () => end(true), (sentence?.startMs ?? 0) / 1000);

  useEffect(() => {
    const el = element.current;
    if (!current || !el) return;
    if (isClip(current)) el.src = current.src;
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

  const start = (source: AuditionSource) => {
    const el = main.current;
    // A 试听 replacing another keeps what the first interrupted.
    if (el && !el.paused && current === null) {
      interruptedAtMs.current = sentenceStartAt(sentenceStartsMs(), el.currentTime * 1000);
      el.pause();
    }
    setFailedId(null);
    setCurrent({ ...source, n: ++count.current, loading: true });
  };

  const onTimeUpdate = () => {
    const el = element.current;
    if (sentence && el && el.currentTime * 1000 >= sentence.endMs) end(true);
  };

  const state = (): AuditionState | null => {
    if (current) return { id: current.id, loading: current.loading, failed: false };
    return failedId === null ? null : { id: failedId, loading: false, failed: true };
  };

  return {
    element,
    state: state(),
    active: current !== null,
    start,
    /** Stops by hand: the main playback stays paused. */
    stop: () => {
      setFailedId(null);
      if (current) end(false);
    },
    /** Media events of the 试听's element. */
    events: {
      onPlaying: () => setCurrent((c) => (c ? { ...c, loading: false } : c)),
      onTimeUpdate,
      onEnded: () => end(true),
      // Only a clip's load failure is reported; hls.js reports a Sentence's (useHls onFatal).
      onError: () => {
        if (!current || !isClip(current)) return;
        setFailedId(current.id);
        end(true);
      },
      // Native HLS (iOS Safari) starts at the playlist's beginning; move to the Sentence.
      onLoadedMetadata: () => {
        const el = element.current;
        if (sentence && el && Math.abs(el.currentTime * 1000 - sentence.startMs) > 300) el.currentTime = sentence.startMs / 1000;
      },
    },
  };
}
