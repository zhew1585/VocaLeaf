import Hls from "hls.js";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { playableLength, useStartRequest, useWaitingForAudio, type StartRequest } from "./playback";

/**
 * The one listening session (PRD 4.4.1): one Book's continuous audio, played by one audio element that lives
 * above the pages, so leaving the 专注页 (【返回书架】) does not stop it. The 专注页 opens its Book here; the
 * player and the reading view read and steer it. Progress sync and the sidebar entry come with #10.
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
  /** Loads the Book's audio, paused at its start; does nothing when it is already the session's Book. */
  open(bookId: string): void;
  /** Loads the playlist again on a fresh audio element (a retried Chapter came in before its end). */
  reload(): void;
  toggle(): void;
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

export const PLAYBACK_FAILED = "播放失败，请刷新页面重试";

export function playlistUrl(bookId: string): string {
  return `/api/books/${bookId}/audio.m3u8`;
}

function isPlayError(err: unknown, name: "AbortError" | "NotAllowedError"): boolean {
  return err instanceof DOMException && err.name === name;
}

/**
 * Attaches the Book's HLS playlist to the audio element: hls.js where Media Source is available, the browser's
 * own HLS (Safari on iOS) otherwise. The playlist is an EVENT playlist while the Book is generating, which
 * hls.js would otherwise start at the live edge; listening always starts at the Book's beginning. A new
 * `reloads` loads it again.
 */
function useHls(audio: RefObject<HTMLAudioElement | null>, src: string | null, reloads: number, onFatal: () => void) {
  useEffect(() => {
    const el = audio.current!;
    if (src === null) return;
    if (!Hls.isSupported()) {
      el.src = src;
      return () => {
        el.removeAttribute("src");
        el.load();
      };
    }
    const hls = new Hls({ startPosition: 0 });
    // hls.js retries network and media errors itself; a fatal one means playback cannot go on.
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (data.fatal) onFatal();
    });
    hls.loadSource(src);
    hls.attachMedia(el);
    return () => hls.destroy();
    // onFatal only reports; a new function each render must not reload the stream.
  }, [audio, src, reloads]);
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
  const [start, setStart] = useState<{ request: StartRequest | null; onSettled?: () => void }>({ request: null });
  useHls(audio, bookId === null ? null : playlistUrl(bookId), reloads, () => setError(PLAYBACK_FAILED));

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
  const starter = useStartRequest(audio, start.request, start.onSettled, (el) => play(el, true));
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
    waiting.onPause();
  };

  // open and reload stay the same functions (the 专注页 calls them from effects); `fresh` only sets state
  // and resets the waiting flag through refs, so the first render's copy will do.
  const openBookId = useRef<string | null>(null);
  const open = useCallback((id: string) => {
    if (openBookId.current === id) return;
    openBookId.current = id;
    setBookId(id);
    setStart({ request: null });
    setPosition(0);
    setPlayable(0);
    fresh();
  }, []);

  const reload = useCallback(() => {
    setReloads((n) => n + 1);
    fresh();
  }, []);

  const requestStart = useCallback((request: StartRequest | null, onSettled?: () => void) => {
    setStart({ request, onSettled });
  }, []);

  const toggle = () => {
    const el = audio.current!;
    starter.drop();
    if (el.paused) play(el);
    else el.pause();
  };

  const value: Listening = {
    bookId,
    playing,
    position,
    playable,
    error,
    needsTap,
    waitingForAudio,
    open,
    reload,
    toggle,
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
        }}
        onPause={() => {
          setPlaying(false);
          waiting.onPause();
        }}
        onPlaying={waiting.onPlaying}
        onWaiting={waiting.onWaiting}
        onTimeUpdate={sync}
        onDurationChange={sync}
        onLoadedMetadata={sync}
        onProgress={sync}
      />
      {children}
    </ListeningContext.Provider>
  );
}
