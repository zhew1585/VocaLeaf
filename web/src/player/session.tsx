import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { BOOK_DELETED_EVENT, type BookDetail, type BookTimeline, type Voice } from "../api";
import { useAudition, type AuditionSource, type AuditionState } from "./audition";
import { useHls } from "./hls";
import { layoutOf, mapPosition, onlyAppends, sentenceIndexAt, type Layout } from "./layout";
import { playableLength, useStartRequest, useWaitingForAudio, type StartRequest } from "./playback";
import { useProgressSync } from "./progressSync";
import { rememberBook, useRestoredSession } from "./rememberedBook";
import { useSleepTimer, type SleepChoice, type SleepTimer } from "./sleep";
import { useSpeed, type Speed } from "./speed";
import { useBookTimeline } from "./useBookTimeline";
import { useOfflinePause } from "./useOfflinePause";
import { useSentenceJumps } from "./useSentenceJumps";

/**
 * The one listening session (PRD 4.4.1): one Book's continuous audio, played by one audio element that lives
 * above the pages, so leaving the 专注页 (【返回书架】) does not stop it. The 专注页 opens its Book here; the
 * player, the reading view and the sidebar's 当前收听 entry read and steer it. Where playback is goes to the API
 * (useProgressSync), so the Shelf orders Books by it and any device resumes there. The device remembers the
 * session's Book, so after a reload the session comes back paused at the last synced Sentence. It ends when its
 * Book is deleted (#8) or taken off the Shelf (a Library Book), or the user logs out. The speed and the sleep timer
 * belong to the session, not the Book, so they hold across Books (PRD 4.4.1, G9). A 试听 of one Sentence plays
 * beside it on a second element (audition.ts).
 */
export interface Listening {
  /** The Book whose audio is loaded, or null before any 专注页 opened one. */
  bookId: string | null;
  playing: boolean;
  /** Seconds into the Book's audio. */
  position: number;
  /** The Chapter playing, from the Book's timeline as held so far; null before it is known. */
  chapterId: string | null;
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
  /**
   * Loads the Book's audio (in `voice`, when known), paused at its start; does nothing when it is already the
   * session's Book. Switching Books saves where the previous one was first (PRD 4.4.1 收听会话 #2).
   */
  open(bookId: string, voice?: Voice): void;
  /** Ends the session on logging out (PRD G16): syncs where playback is and forgets the Book on this device. */
  end(): void;
  /** Loads the playlist again on a fresh audio element. */
  reload(): void;
  /**
   * Tells the session the Book as a page just loaded it. The session follows its Book's playlist by itself (its
   * timeline, loaded again while a Chapter may still come in): when a Chapter came in before the end or left
   * (retried, narrated or set Skipped, PRD 4.2.5), it loads the playlist again and resumes at the same place in the
   * same Chapter, or at the start of the next narrated one when the playing Chapter left (AC-BOOK-02), playing on
   * if it was. A page that loads the session's Book follows a change at once, before it asks for a position.
   * When the Book's Voice changed (#19), all of its audio is new: it loads it and resumes at the start of the same
   * Sentence (PRD 4.2.4 rule 3), which sits elsewhere in the new Voice's audio.
   */
  follow(book: BookDetail): void;
  toggle(): void;
  /** 重听 (PRD 4.4.3): back to the start of the Sentence the user wants to hear again. */
  replay(): void;
  /** 下一句: to the start of the next Sentence. */
  next(): void;
  /** The id of the Sentence 【标记】 pressed now marks (PRD 4.4.2 目标句判定), or null without Sentences. */
  markTarget(): Promise<string | null>;
  /** Moves to a dragged position (PRD 4.4.1 进度拖动), not snapped to a Sentence start, keeping play or pause. */
  seek(seconds: number): void;
  /** 【从这里播放】 (AC-PLAY-15): plays from `seconds` (a Sentence's start), playing even when paused; ends any 试听. */
  playFrom(seconds: number): void;
  /** The 试听 playing or loading, or null. */
  audition: AuditionState | null;
  /**
   * 【试听本句】: plays only this Sentence (again from its start when it is already playing); or 【卡片原声】, a Card's
   * own audio.
   */
  startAudition(source: AuditionSource): void;
  /** Stops a 试听 without letting an interrupted main playback go on (another Sentence selected, panel closed). */
  stopAudition(): void;
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
      progress.moved(ms);
    },
  });
  /** The session moved playback to `seconds` (a drag, a picked Chapter, a resume). */
  const landed = (seconds: number) => {
    jumps.landed(seconds * 1000);
    sleep.jumped(seconds * 1000);
    // A resume lands where the API has it; a drag or a picked Chapter was sent when it was asked for or played.
    if (openBookId.current !== null) progress.adopt(openBookId.current, seconds * 1000);
  };
  const starter = useStartRequest(audio, start.request, start.onSettled, (el) => play(el, true), landed);
  const audition = useAudition({
    main: audio,
    src: bookId === null ? null : playlistUrl(bookId),
    sentenceStartsMs: () => timeline.timeline?.sentenceStartsMs ?? [],
    resumeMain: (el, seconds) => {
      el.currentTime = seconds;
      landed(seconds);
      play(el);
    },
  });
  const waiting = useWaitingForAudio(audio, setWaitingForAudio);
  const openBookId = useRef<string | null>(null);
  // From switching Books or reloading until the new playlist's metadata loads, the element holds the old Book's
  // audio or none yet (its stream going away may fire a pause there); positions are not reported meanwhile.
  const switching = useRef(false);
  // The Voice of the loaded audio, as the page that opened the Book said; null when not known (a restored session).
  const voice = useRef<Voice | null>(null);
  const follows = useRef(0);
  const progress = useProgressSync(audio, {
    bookToReport: () => (switching.current ? null : openBookId.current),
    playing,
    sentenceStarts: () => timeline.timeline?.sentenceStartsMs ?? [],
    moveTo: (seconds) => setStart({ request: { id: `follow#${++follows.current}`, seconds, autoplay: false } }),
    voice: () => voice.current ?? undefined,
  });

  const sync = () => {
    const el = audio.current!;
    setPosition(el.currentTime);
    setPlayable(playableLength(el));
    starter.tryStart();
  };

  /** A fresh audio element: paused, nothing waited for. */
  const fresh = () => {
    audition.stop();
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
  // resets refs, and `progress` is memoized on refs, so the first render's copies will do.
  const open = useCallback((id: string, v?: Voice) => {
    if (openBookId.current === id) return;
    voice.current = v ?? null;
    progress.flush();
    switching.current = openBookId.current !== null;
    openBookId.current = id;
    // A fresh Book starts at 0, which is not progress to sync.
    progress.adopt(id, 0);
    rememberBook(id);
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
      voice.current = null;
      rememberBook(null);
      setBookId(null);
      setStart({ request: null });
      setPosition(0);
      setPlayable(0);
      fresh();
    };
    window.addEventListener(BOOK_DELETED_EVENT, onDeleted);
    return () => window.removeEventListener(BOOK_DELETED_EVENT, onDeleted);
  }, []);

  useRestoredSession({
    vacant: () => openBookId.current === null,
    restore: (id, startMs) => {
      open(id);
      if (startMs !== null) setStart({ request: { id: "restore", seconds: startMs / 1000, autoplay: false } });
    },
  });

  const reload = useCallback(() => {
    switching.current = true;
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
    // Like reload: the old playlist's positions are not reported while the new one loads.
    switching.current = true;
    setReloads((n) => n + 1);
    fresh();
    setStart({ request });
  }, []);

  // After a Voice change, where to resume: the `index`th Sentence of the new audio, once its timeline (another
  // object than `from`, the old audio's) is loaded.
  const voiceResume = useRef<{ index: number; from: BookTimeline | null; autoplay: boolean } | null>(null);
  const latestTimeline = useRef(timeline.timeline);
  latestTimeline.current = timeline.timeline;
  const voiceChanges = useRef(0);
  /** Loads the Book's audio in its new Voice and resumes at the start of the Sentence playing now. Stable. */
  const changeVoice = useCallback((next: Voice) => {
    const el = audio.current!;
    const from = latestTimeline.current;
    const index = sentenceIndexAt(from?.sentenceStartsMs ?? [], el.currentTime * 1000);
    voice.current = next;
    voiceResume.current = { index, from, autoplay: !el.paused };
    // The new audio has its own layout; the first timeline of it is taken as is.
    held.current = null;
    switching.current = true;
    setReloads((n) => n + 1);
    fresh();
    // Nothing to start until the new timeline says where the Sentence is (the effect below).
    setStart({ request: null });
    voiceChanges.current += 1;
  }, []);

  // In the background the session follows its own timeline, loaded again while a Chapter may still come in.
  useEffect(() => {
    const t = timeline.timeline;
    if (t === null) return;
    const pending = voiceResume.current;
    if (pending === null) return relayout(t.chapters);
    if (t === pending.from) return;
    voiceResume.current = null;
    held.current = t.chapters;
    const ms = t.sentenceStartsMs[pending.index] ?? t.sentenceStartsMs.at(-1) ?? 0;
    setStart({ request: { id: `voice#${voiceChanges.current}`, seconds: ms / 1000, autoplay: pending.autoplay } });
  }, [timeline.timeline, relayout]);

  // A page's fresher Book is followed at once, before the page asks for a position in the new layout.
  const follow = useCallback(
    (book: BookDetail) => {
      if (book.id !== openBookId.current) return;
      // A restored session does not know its audio's Voice; what it loaded is the Book's Voice now.
      if (voice.current === null) voice.current = book.voice;
      if (book.voice !== voice.current) changeVoice(book.voice);
      else if (voiceResume.current === null) relayout(layoutOf(book));
    },
    [relayout, changeVoice],
  );

  const requestStart = useCallback((request: StartRequest | null, onSettled?: () => void) => {
    setStart({ request, onSettled });
  }, []);

  const toggle = () => {
    // Space or 暂停 during a 试听 stops it; the main playback stays paused (AC-PLAY-14).
    if (audition.active) return audition.stop();
    const el = audio.current!;
    starter.drop();
    offline.forget();
    if (el.paused) play(el);
    else el.pause();
  };

  const seeks = useRef(0);
  /** Moves to `seconds`, then plays when `autoplay`, otherwise keeps playing or paused. */
  const moveTo = (seconds: number, autoplay: boolean) => {
    const el = audio.current;
    if (!el || openBookId.current === null) return;
    starter.drop();
    progress.moved(seconds * 1000);
    audition.stop();
    if (seconds < playableLength(el) - GENERATED_EDGE_SECONDS) {
      el.currentTime = seconds;
      landed(seconds);
      // Show the new place at once rather than the old one until the next time update.
      setPosition(seconds);
      if (autoplay && el.paused) play(el);
      return;
    }
    // Not generated yet: wait there (PRD 4.3.4), playing on once it is if it was playing.
    const wasPlaying = !el.paused;
    setSeekPending(true);
    setStart({
      request: { id: `seek#${++seeks.current}`, seconds, autoplay: autoplay || wasPlaying },
      onSettled: () => setSeekPending(false),
    });
    if (wasPlaying) el.pause();
  };

  const end = () => {
    progress.flush();
    rememberBook(null);
  };

  const value: Listening = {
    bookId,
    playing,
    position,
    chapterId: timeline.timeline?.chapters.findLast((c) => c.startMs <= position * 1000)?.id ?? null,
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
    end,
    reload,
    follow,
    toggle,
    replay: () => {
      audition.stop();
      jumps.replay();
    },
    next: () => {
      audition.stop();
      jumps.next();
    },
    markTarget: jumps.target,
    seek: (seconds) => moveTo(seconds, false),
    playFrom: (seconds) => moveTo(seconds, true),
    audition: audition.state,
    startAudition: audition.start,
    stopAudition: audition.stop,
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
          progress.report();
        }}
        onPause={() => {
          setPlaying(false);
          waiting.onPause();
          progress.report();
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
      <audio ref={audition.element} preload="none" {...audition.events} />
      {children}
    </ListeningContext.Provider>
  );
}
