import Hls from "hls.js";
import { useEffect, useRef, useState } from "react";
import { PauseSolidIcon, PlaySolidIcon } from "../icons";

/** "1:02:05": hours, minutes, seconds of the whole Book (it runs for hours). */
export function formatElapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${Math.floor(s / 3600)}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

/** "−11:31:40", with a true minus sign as in the design. */
export function formatRemaining(seconds: number): string {
  return `−${formatElapsed(seconds)}`;
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
function useHls(audio: React.RefObject<HTMLAudioElement | null>, src: string, onFatal: () => void) {
  useEffect(() => {
    const el = audio.current!;
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

const PLAYBACK_FAILED = "播放失败，请刷新页面重试";

/**
 * The floating player of the 专注页 (design 01, ④): play / pause and the whole Book's progress.
 * Playback runs through the Book's one continuous HLS stream, so it moves from Chapter to Chapter on its own
 * and never meets a Skipped Chapter. Speed, sleep timer, ⏮ / ⏭ and Mark come with #9 and #13.
 * `totalSeconds` is the whole Book's length (estimated while generating); without it the bar measures what is
 * generated so far.
 */
export function Player({ src, totalSeconds = null }: { src: string; totalSeconds?: number | null }) {
  const audio = useRef<HTMLAudioElement>(null);
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

  const toggle = () => {
    const el = audio.current!;
    if (el.paused) {
      setError(null);
      el.play().catch((err: unknown) => {
        setPlaying(false);
        // AbortError: a pause or reload interrupted the start, which is not a failure.
        if (!(err instanceof DOMException && err.name === "AbortError")) setError(PLAYBACK_FAILED);
      });
    } else el.pause();
  };

  const length = Math.max(playable, totalSeconds ?? 0);
  const progress = length > 0 ? Math.min(position / length, 1) : 0;

  return (
    <div className="player">
      <audio
        ref={audio}
        preload="auto"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onTimeUpdate={sync}
        onDurationChange={sync}
        onProgress={sync}
      />
      <div className="player-controls">
        <button type="button" className="play-button" aria-label={playing ? "暂停" : "播放"} onClick={toggle}>
          {playing ? <PauseSolidIcon /> : <PlaySolidIcon />}
        </button>
      </div>
      <div className="player-progress">
        <span className="player-time">{formatElapsed(position)}</span>
        <div
          className="player-track"
          role="progressbar"
          aria-label="整本进度"
          aria-valuemin={0}
          aria-valuemax={Math.round(length)}
          aria-valuenow={Math.round(position)}
        >
          <div className="player-fill" style={{ width: `${progress * 100}%` }} />
          <div className="player-knob" style={{ left: `${progress * 100}%` }} />
        </div>
        <span className="player-time">{formatRemaining(length - position)}</span>
      </div>
      {error && (
        <p className="form-error player-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
