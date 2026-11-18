import Hls from "hls.js";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

const PLAYBACK_FAILED = "播放失败，请刷新页面重试";

/** The one main playback (PRD 4.4.1 收听会话): one Book's continuous audio, shared by every screen. */
export interface Playback {
  /** The playlist being played, null before any Book is opened. */
  src: string | null;
  playing: boolean;
  /** Seconds into the Book's audio. */
  position: number;
  /** Seconds of audio that can be played so far. */
  playable: number;
  error: string | null;
  /** Opens a Book's playlist from its beginning, paused; does nothing when it is already the one loaded. */
  load(src: string): void;
  toggle(): void;
  /** Jumps to `seconds` into the Book's audio and plays from there, even when paused before. */
  playFrom(seconds: number): void;
}

const PlaybackContext = createContext<Playback | null>(null);

export function usePlayback(): Playback {
  const playback = useContext(PlaybackContext);
  if (!playback) throw new Error("usePlayback needs a PlaybackProvider");
  return playback;
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
 * Attaches the playlist to the audio element: hls.js where Media Source is available, the browser's own HLS
 * (Safari on iOS) otherwise. The playlist is an EVENT playlist while the Book is generating, which hls.js would
 * otherwise start at the live edge; listening always starts at the Book's beginning.
 */
function useHls(audio: React.RefObject<HTMLAudioElement | null>, src: string | null, onFatal: () => void) {
  useEffect(() => {
    const el = audio.current!;
    if (!src) return;
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

/**
 * Owns the audio element at the top of the app, so playback goes on when the user leaves the 专注页
 * (PRD 4.4.1 收听会话 4). Wrap the whole app in it once.
 */
export function PlaybackProvider({ children }: { children: ReactNode }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [playable, setPlayable] = useState(0);
  const [error, setError] = useState<string | null>(null);
  useHls(audio, src, () => setError(PLAYBACK_FAILED));

  const sync = () => {
    const el = audio.current!;
    setPosition(el.currentTime);
    setPlayable(playableLength(el));
  };

  const play = useCallback(() => {
    setError(null);
    audio.current!.play().catch((err: unknown) => {
      setPlaying(false);
      // AbortError: a pause or reload interrupted the start, which is not a failure.
      if (!(err instanceof DOMException && err.name === "AbortError")) setError(PLAYBACK_FAILED);
    });
  }, []);

  const loaded = useRef<string | null>(null);
  const load = useCallback((next: string) => {
    if (loaded.current === next) return;
    loaded.current = next;
    setSrc(next);
    setPosition(0);
    setPlayable(0);
    setError(null);
  }, []);

  const toggle = useCallback(() => {
    if (audio.current!.paused) play();
    else audio.current!.pause();
  }, [play]);

  const playFrom = useCallback(
    (seconds: number) => {
      audio.current!.currentTime = seconds;
      setPosition(seconds);
      play();
    },
    [play],
  );

  const value = useMemo(
    () => ({ src, playing, position, playable, error, load, toggle, playFrom }),
    [src, playing, position, playable, error, load, toggle, playFrom],
  );

  return (
    <PlaybackContext.Provider value={value}>
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
    </PlaybackContext.Provider>
  );
}
