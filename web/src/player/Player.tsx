import Hls from "hls.js";
import { useEffect, useRef, useState } from "react";
import { LoaderIcon, PauseSolidIcon, PlaySolidIcon } from "../icons";

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

/** How close to the end of the generated audio a stall counts as waiting for more to be generated. */
const END_SLACK_SECONDS = 1;

/** A position the player starts playing from on its own, once the playlist reaches it. */
export interface StartRequest {
  /** Tells one request from the next, so asking for the same position again starts again. */
  id: string;
  /** Null while that position is not known yet (its Chapter has no audio yet): the request waits. */
  seconds: number | null;
}

export interface PlayerProps {
  src: string;
  /** The whole Book's length (estimated while generating); without it the bar measures what is generated so far. */
  totalSeconds?: number | null;
  /** Start playing here as soon as the playlist has audio there (a Chapter picked before it was generated). */
  startAt?: StartRequest | null;
  /** The start request is done: playback started there, or the user played or paused in the meantime. */
  onStartSettled?: () => void;
  /** Playback reached the end of the audio generated so far and waits for more (true), or moves again (false). */
  onWaitingForAudio?: (waiting: boolean) => void;
  /** Shown above the controls, such as how long the audio being waited for still takes. */
  notice?: string | null;
}

/** Errors of play() that are not playback failures. */
function isHarmlessPlayError(err: unknown): boolean {
  // AbortError: a pause or reload interrupted the start. NotAllowedError: the browser wants a tap first
  // (autoplay policy), and the play button is there for it.
  return err instanceof DOMException && (err.name === "AbortError" || err.name === "NotAllowedError");
}

/**
 * The floating player of the 专注页 (design 01, ④): play / pause and the whole Book's progress.
 * Playback runs through the Book's one continuous HLS stream, so it moves from Chapter to Chapter on its own
 * and never meets a Skipped Chapter. While the Book generates, playback that catches up with the generated
 * audio waits and goes on by itself once more is appended. Speed, sleep timer, ⏮ / ⏭ and Mark come with #9 and #13.
 */
export function Player({
  src,
  totalSeconds = null,
  startAt = null,
  onStartSettled,
  onWaitingForAudio,
  notice = null,
}: PlayerProps) {
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [playable, setPlayable] = useState(0);
  const [error, setError] = useState<string | null>(null);
  useHls(audio, src, () => setError(PLAYBACK_FAILED));

  // The start request still to carry out, and the callbacks as of the latest render, read from media events.
  const pendingStart = useRef<StartRequest | null>(null);
  const callbacks = useRef({ onStartSettled, onWaitingForAudio });
  callbacks.current = { onStartSettled, onWaitingForAudio };
  const waitingForAudio = useRef(false);

  const setWaitingForAudio = (waiting: boolean) => {
    if (waitingForAudio.current === waiting) return;
    waitingForAudio.current = waiting;
    callbacks.current.onWaitingForAudio?.(waiting);
  };

  const play = (el: HTMLAudioElement) => {
    setError(null);
    el.play().catch((err: unknown) => {
      setPlaying(false);
      if (!isHarmlessPlayError(err)) setError(PLAYBACK_FAILED);
    });
  };

  const settleStart = () => {
    pendingStart.current = null;
    callbacks.current.onStartSettled?.();
  };

  /** Carries out the pending start request once the playlist has audio at its position. */
  const tryStart = () => {
    const el = audio.current;
    const request = pendingStart.current;
    if (!el || request?.seconds == null || el.readyState < HTMLMediaElement.HAVE_METADATA) return;
    if (playableLength(el) <= request.seconds) return;
    el.currentTime = request.seconds;
    play(el);
    settleStart();
  };

  useEffect(() => {
    pendingStart.current = startAt;
    tryStart();
    // tryStart only reads refs; the request's id and position say when it changed.
  }, [startAt?.id, startAt?.seconds]);

  const sync = () => {
    const el = audio.current!;
    setPosition(el.currentTime);
    setPlayable(playableLength(el));
    tryStart();
  };

  const onWaiting = () => {
    const el = audio.current!;
    if (!el.paused && el.currentTime >= playableLength(el) - END_SLACK_SECONDS) setWaitingForAudio(true);
  };

  const toggle = () => {
    const el = audio.current!;
    // Playing or pausing by hand drops a start the player was still waiting to make.
    if (pendingStart.current) settleStart();
    if (el.paused) play(el);
    else el.pause();
  };

  const length = Math.max(playable, totalSeconds ?? 0);
  const progress = length > 0 ? Math.min(position / length, 1) : 0;

  return (
    <div className="player">
      <audio
        ref={audio}
        preload="auto"
        onPlay={() => setPlaying(true)}
        onPause={() => {
          setPlaying(false);
          setWaitingForAudio(false);
        }}
        onPlaying={() => setWaitingForAudio(false)}
        onWaiting={onWaiting}
        onTimeUpdate={sync}
        onDurationChange={sync}
        onLoadedMetadata={sync}
        onProgress={sync}
      />
      {notice && (
        <p className="player-notice" role="status">
          <LoaderIcon />
          {notice}
        </p>
      )}
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
