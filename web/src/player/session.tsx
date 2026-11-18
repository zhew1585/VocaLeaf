import Hls from "hls.js";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

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
  /** Loads the Book's audio, paused at its start; does nothing when it is already the session's Book. */
  open(bookId: string): void;
  toggle(): void;
  /** Jumps to a position in the Book's audio and plays from there, even when paused before (从这里播放, 点章节). */
  playFrom(seconds: number): void;
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

/**
 * Length of what can be played. While the Book is generating, its playlist is still growing and some browsers
 * report an infinite duration; what is seekable is then the audio generated so far.
 */
function playableLength(audio: HTMLAudioElement): number {
  if (Number.isFinite(audio.duration)) return audio.duration;
  const { seekable } = audio;
  return seekable && seekable.length > 0 ? seekable.end(seekable.length - 1) : 0;
}

/**
 * Attaches the Book's HLS playlist to the audio element: hls.js where Media Source is available, the browser's
 * own HLS (Safari on iOS) otherwise. The playlist is an EVENT playlist while the Book is generating, which
 * hls.js would otherwise start at the live edge; listening always starts at the Book's beginning.
 */
function useHls(audio: React.RefObject<HTMLAudioElement | null>, src: string | null, onFatal: () => void) {
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
  }, [audio, src]);
}

/** Holds the session's audio element; mounted once for the logged-in app. */
export function ListeningProvider({ children }: { children: ReactNode }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [bookId, setBookId] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [playable, setPlayable] = useState(0);
  const [error, setError] = useState<string | null>(null);
  useHls(audio, bookId === null ? null : playlistUrl(bookId), () => setError(PLAYBACK_FAILED));

  const sync = () => {
    const el = audio.current!;
    setPosition(el.currentTime);
    setPlayable(playableLength(el));
  };

  const start = useCallback(() => {
    setError(null);
    audio.current!.play().catch((err: unknown) => {
      setPlaying(false);
      // AbortError: a pause or reload interrupted the start, which is not a failure.
      if (!(err instanceof DOMException && err.name === "AbortError")) setError(PLAYBACK_FAILED);
    });
  }, []);

  const openBookId = useRef<string | null>(null);
  const open = useCallback((id: string) => {
    if (openBookId.current === id) return;
    if (openBookId.current !== null) audio.current!.pause();
    openBookId.current = id;
    setBookId(id);
    setPosition(0);
    setPlayable(0);
    setError(null);
  }, []);

  const toggle = useCallback(() => {
    if (audio.current!.paused) start();
    else audio.current!.pause();
  }, [start]);

  const playFrom = useCallback(
    (seconds: number) => {
      audio.current!.currentTime = seconds;
      setPosition(seconds);
      start();
    },
    [start],
  );

  const value = useMemo<Listening>(
    () => ({ bookId, playing, position, playable, error, open, toggle, playFrom }),
    [bookId, playing, position, playable, error, open, toggle, playFrom],
  );

  return (
    <ListeningContext.Provider value={value}>
      <audio
        ref={audio}
        preload="auto"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onTimeUpdate={sync}
        onDurationChange={sync}
        onProgress={sync}
      />
      {children}
    </ListeningContext.Provider>
  );
}
