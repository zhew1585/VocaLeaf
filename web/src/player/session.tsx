import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { BOOK_DELETED_EVENT, saveListening, type BookDetail } from "../api";
import { useHls } from "./hls";
import { layoutOf, mapPosition, onlyAppends, type Layout } from "./layout";
import { playableLength, useStartRequest, useWaitingForAudio, type StartRequest } from "./playback";
import { useSleepTimer, type SleepChoice, type SleepTimer } from "./sleep";
import { useSpeed, type Speed } from "./speed";
import { useBookTimeline } from "./useBookTimeline";
import { useOfflinePause } from "./useOfflinePause";
import { useSentenceJumps } from "./useSentenceJumps";

/**
 * The one listening session (PRD 4.4.1): one Book's continuous audio, played by one audio element that lives
 * above the pages, so leaving the 专注页 (【返回书架】) does not stop it. The 专注页 opens its Book here; the
 * player and the reading view read and steer it. Where playback is goes to the API when it starts and pauses, so
 * the Shelf can order Books and resume them (#7); the other sync moments and the sidebar entry come with #10.
 * It ends when its Book is deleted (#8). The speed and the sleep timer belong to the session, not the Book, so
 * they hold across Books (PRD 4.4.1, G9).
 */
export interface Listening {
  /** The Book whose audio is loaded, or null before any 专注页 opened one. */
  bookId: string | null;
  playing: boolean;
  /** Seconds into the Book's audio. */
  position: number;
  /** Seconds of audio that can be played so far. */
  playable: number;
  error: string | null;
  /** The browser refused to start playback on its own (autoplay policy) and wants a tap on play. */
  needsTap: boolean;
  /** Playback reached the end of the audio generated so far and waits for more. */
  waitingForAudio: boolean;
  /** The progress bar was dragged past the generated audio; playback goes there once it is generated. */
  seekPending: boolean;
  /** The network is down; playback paused and goes on once it is back. */
  offline: boolean;
  speed: Speed;
  sleep: SleepTimer | null;
  /** Listening time left on the sleep timer, in milliseconds; null with none or while unknown. */
  sleepRemaining(): number | null;
  /** Loads the Book's audio, paused at its start; does nothing when it is already the session's Book. */
  open(bookId: string): void;
  /** Loads the playlist again on a fresh audio element. */
  reload(): void;
  /**
   * Tells the session the Book as a page just loaded it. The session follows its Book's playlist by itself (its
   * timeline, loaded again while a Chapter may still come in): when a Chapter came in before the end or left
   * (retried, narrated or set Skipped, PRD 4.2.5), it loads the playlist again and resumes at the same place in the
   * same Chapter, or at the start of the next narrated one when the playing Chapter left (AC-BOOK-02), playing on
   * if it was. A page that loads the session's Book follows a change at once, before it asks for a position.
   */
  follow(book: BookDetail): void;
  toggle(): void;
  /** 重听 (PRD 4.4.3): back to the start of the Sentence the user wants to hear again. */
  replay(): void;
  /** 下一句: to the start of the next Sentence. */
  next(): void;
  /** Moves to a dragged position (PRD 4.4.1 进度拖动), not snapped to a Sentence start, keeping play or pause. */
  seek(seconds: number): void;
  setSpeed(speed: Speed): void;
  setSleep(choice: SleepChoice | null): void;
  /**
   * Moves to the request's position once the playlist reaches it (a picked Chapter, a resume after a reload),
   * then calls `onSettled`; also when the user plays or pauses by hand meanwhile, which drops it. Replaces a
   * request still waiting; null drops it.
   */
  requestStart(request: StartRequest | null, onSettled?: () => void): void;
}

const ListeningContext = createContext<Listening | null>(null);

export function useListening(): Listening {
  const listening = useContext(ListeningContext);
  if (!listening) throw new Error("useListening needs a ListeningProvider");
  return listening;
}

const PLAYBACK_FAILED = "播放失败，请刷新页面重试";
/** A drag lands this close to the end of the generated audio or beyond: it waits for more to be generated. */
const GENERATED_EDGE_SECONDS = 0.5;

function playlistUrl(bookId: string): string {
  return `/api/books/${bookId}/audio.m3u8`;
}

function isPlayError(err: unknown, name: "AbortError" | "NotAllowedError"): boolean {
  return err instanceof DOMException && err.name === name;
}

/** Holds the session's audio element; mounted once for the logged-in app. */
export function ListeningProvider({ children }: { children: ReactNode }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [bookId, setBookId] = useState<string | null>(null);
  // Counts reloads of the playlist; the audio element is keyed by it, so a reload starts from a fresh one.
  const [reloads, setReloads] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [playable, setPlayable] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [needsTap, setNeedsTap] = useState(false);
  const [waitingForAudio, setWaitingForAudio] = useState(false);
  const [seekPending, setSeekPending] = useState(false);
  const [start, setStart] = useState<{ request: StartRequest | null; onSettled?: () => void }>({ request: null });
  const hls = useHls(audio, bookId === null ? null : playlistUrl(bookId), reloads, () => {
    // Offline, hls.js gives up on the stream; it loads again once the network is back.
    if (navigator.onLine) setError(PLAYBACK_FAILED);
  });
  const timeline = useBookTimeline(bookId, reloads);
  const sleep = useSleepTimer(audio, timeline.timeline?.chapters ?? []);
  const { speed, setSpeed } = useSpeed(audio, `${bookId}#${reloads}`);

  /** `onItsOwn`: started by a start request rather than the play button, so the browser may refuse it. */
  const play = (el: HTMLAudioElement, onItsOwn = false) => {
    setError(null);
    el.play().catch((err: unknown) => {
      setPlaying(false);
      if (isPlayError(err, "NotAllowedError") && onItsOwn) setNeedsTap(true);
      // AbortError: a pause or reload interrupted the start, which is not a failure.
      else if (!isPlayError(err, "AbortError")) setError(PLAYBACK_FAILED);
    });
  };
  const offline = useOfflinePause(audio, { restart: hls.restart, play });
  const jumps = useSentenceJumps(audio, {
    covering: timeline.covering,
    jumping: (ms) => {
      starter.drop();
      sleep.jumped(ms);
    },
  });
  /** The session moved playback to `seconds` (a drag, a picked Chapter, a resume). */
  const landed = (seconds: number) => {
    jumps.landed(seconds * 1000);
    sleep.jumped(seconds * 1000);
  };
  const starter = useStartRequest(audio, start.request, start.onSettled, (el) => play(el, true), landed);
  const waiting = useWaitingForAudio(audio, setWaitingForAudio);

  const sync = () => {
    const el = audio.current!;
    setPosition(el.currentTime);
    setPlayable(playableLength(el));
    starter.tryStart();
  };

  /** A fresh audio element: paused, nothing waited for. */
  const fresh = () => {
    setPlaying(false);
    setNeedsTap(false);
    setError(null);
    setSeekPending(false);
    waiting.onPause();
    jumps.forget();
    offline.forget();
    // A fresh element starts at 0; 【本章结束】 follows to its first Chapter.
    sleep.jumped(0);
  };

  // open, reload and follow stay the same functions (pages call them from effects); `fresh` only sets state and
  // resets refs, so the first render's copy will do.
  const openBookId = useRef<string | null>(null);
  // From switching Books until the new playlist's metadata loads, the element still holds the old Book's audio
  // (its stream going away may fire a pause there); positions are not reported meanwhile.
  const switching = useRef(false);
  const open = useCallback((id: string) => {
    if (openBookId.current === id) return;
    switching.current = openBookId.current !== null;
    openBookId.current = id;
    held.current = null;
    setBookId(id);
    setStart({ request: null });
    setPosition(0);
    setPlayable(0);
    fresh();
  }, []);

  // The Book is gone with its audio: stop and forget it, as before any Book was opened.
  useEffect(() => {
    const onDeleted = (e: Event) => {
      if ((e as CustomEvent<string>).detail !== openBookId.current) return;
      openBookId.current = null;
      setBookId(null);
      setStart({ request: null });
      setPosition(0);
      setPlayable(0);
      fresh();
    };
    window.addEventListener(BOOK_DELETED_EVENT, onDeleted);
    return () => window.removeEventListener(BOOK_DELETED_EVENT, onDeleted);
  }, []);

  const reload = useCallback(() => {
    setReloads((n) => n + 1);
    fresh();
  }, []);

  // The layout of the playlist the audio element holds: the first one seen after a Book was opened, then each one
  // after while it only grows, or the one it was reloaded for. Null until then.
  const held = useRef<Layout | null>(null);
  const relayouts = useRef(0);
  /**
   * Takes `next` as the playlist's layout. When a Chapter came in before its end or left it (retried, narrated, set
   * Skipped), loads the playlist again and resumes at the same place in the same Chapter, or at the next narrated
   * one when the playing Chapter left. Stable: reads only refs and stable setters.
   */
  const relayout = useCallback((next: Layout) => {
    const prev = held.current;
    held.current = next;
    if (prev === null || onlyAppends(prev, next)) return;
    const el = audio.current!;
    const request = {
      id: `relayout#${++relayouts.current}`,
      seconds: mapPosition(el.currentTime, prev, next),
      autoplay: !el.paused,
    };
    setReloads((n) => n + 1);
    fresh();
    setStart({ request });
  }, []);

  // In the background the session follows its own timeline, loaded again while a Chapter may still come in.
  useEffect(() => {
    if (timeline.timeline !== null) relayout(timeline.timeline.chapters);
  }, [timeline.timeline, relayout]);

  // A page's fresher Book is followed at once, before the page asks for a position in the new layout.
  const follow = useCallback(
    (book: BookDetail) => {
      if (book.id === openBookId.current) relayout(layoutOf(book));
    },
    [relayout],
  );

  const requestStart = useCallback((request: StartRequest | null, onSettled?: () => void) => {
    setStart({ request, onSettled });
  }, []);

  /** Reports where playback is; the API keeps the Sentence there as the place to resume (PRD 4.4.1). */
  const reportPosition = () => {
    const id = openBookId.current;
    if (id === null || switching.current) return;
    saveListening(id, audio.current!.currentTime * 1000).catch((err: unknown) => {
      // Losing one report only loses a little progress; the next play or pause reports again.
      console.warn("saving listening progress failed", err);
    });
  };

  const toggle = () => {
    const el = audio.current!;
    starter.drop();
    offline.forget();
    if (el.paused) play(el);
    else el.pause();
  };

  const seeks = useRef(0);
  const seek = (seconds: number) => {
    const el = audio.current;
    if (!el || openBookId.current === null) return;
    starter.drop();
    if (seconds < playableLength(el) - GENERATED_EDGE_SECONDS) {
      el.currentTime = seconds;
      landed(seconds);
      // Show the new place at once rather than the old one until the next time update.
      setPosition(seconds);
      return;
    }
    // Not generated yet: wait there (PRD 4.3.4), playing on once it is if it was playing.
    const wasPlaying = !el.paused;
    setSeekPending(true);
    setStart({
      request: { id: `seek#${++seeks.current}`, seconds, autoplay: wasPlaying },
      onSettled: () => setSeekPending(false),
    });
    if (wasPlaying) el.pause();
  };

  const value: Listening = {
    bookId,
    playing,
    position,
    playable,
    error,
    needsTap,
    waitingForAudio,
    seekPending,
    offline: offline.offline,
    speed,
    sleep: sleep.timer,
    sleepRemaining: sleep.remaining,
    open,
    reload,
    follow,
    toggle,
    replay: jumps.replay,
    next: jumps.next,
    seek,
    setSpeed,
    setSleep: sleep.set,
    requestStart,
  };

  return (
    <ListeningContext.Provider value={value}>
      <audio
        key={reloads}
        ref={audio}
        preload="auto"
        onPlay={() => {
          setPlaying(true);
          setNeedsTap(false);
          reportPosition();
        }}
        onPause={() => {
          setPlaying(false);
          waiting.onPause();
          reportPosition();
        }}
        onPlaying={waiting.onPlaying}
        onWaiting={waiting.onWaiting}
        onTimeUpdate={sync}
        onDurationChange={sync}
        onLoadedMetadata={() => {
          switching.current = false;
          sync();
        }}
        onProgress={sync}
      />
      {children}
    </ListeningContext.Provider>
  );
}
