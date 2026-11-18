import Hls from "hls.js";
import { useEffect, useRef, useState } from "react";
import { LoaderIcon, PauseSolidIcon, PlaySolidIcon } from "../icons";
import { playableLength, useStartRequest, useWaitingForAudio, type StartRequest } from "./playback";

export type { StartRequest } from "./playback";

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
/** When the browser refused to start playback on its own (autoplay policy) and wants a tap. */
const TAP_TO_PLAY = "已可以收听，点播放开始";

export interface PlayerProps {
  src: string;
  /** The whole Book's length (estimated while generating); without it the bar measures what is generated so far. */
  totalSeconds?: number | null;
  /** Move here as soon as the playlist has audio there (a Chapter picked before it was generated). */
  startAt?: StartRequest | null;
  /** The start request is done: carried out, or dropped because the user played or paused in the meantime. */
  onStartSettled?: () => void;
  /** Playback reached the end of the audio generated so far and waits for more (true), or moves again (false). */
  onWaitingForAudio?: (waiting: boolean) => void;
  /** Where playback is, on every time update, so a reloaded playlist can resume at the same place. */
  onPosition?: (seconds: number, playing: boolean) => void;
  /** Shown above the controls, such as how long the audio being waited for still takes. */
  notice?: string | null;
}

function isPlayError(err: unknown, name: "AbortError" | "NotAllowedError"): boolean {
  return err instanceof DOMException && err.name === name;
}

/** The whole Book's progress bar with time listened and time left. */
function Progress({ position, length }: { position: number; length: number }) {
  const progress = length > 0 ? Math.min(position / length, 1) : 0;
  return (
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
  );
}

/**
 * The floating player of the 专注页 (design 01, ④): play / pause and the whole Book's progress.
 * Playback runs through the Book's one continuous HLS stream, so it moves from Chapter to Chapter on its own
 * and never meets a Skipped Chapter. While the Book generates, playback that catches up with the generated
 * audio waits and goes on by itself once more is appended. Speed, sleep timer, ⏮ / ⏭ and Mark come with #9 and #13.
 */
export function Player(props: PlayerProps) {
  const { src, totalSeconds = null, notice = null } = props;
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [playable, setPlayable] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [needsTap, setNeedsTap] = useState(false);
  useHls(audio, src, () => setError(PLAYBACK_FAILED));

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
  const start = useStartRequest(audio, props.startAt ?? null, props.onStartSettled, (el) => play(el, true));
  const waiting = useWaitingForAudio(audio, props.onWaitingForAudio);

  const sync = () => {
    const el = audio.current!;
    setPosition(el.currentTime);
    setPlayable(playableLength(el));
    props.onPosition?.(el.currentTime, !el.paused);
    start.tryStart();
  };

  const toggle = () => {
    const el = audio.current!;
    start.drop();
    if (el.paused) play(el);
    else el.pause();
  };

  const shownNotice = needsTap ? TAP_TO_PLAY : notice;
  return (
    <div className="player">
      <audio
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
      {shownNotice && (
        <p className="player-notice" role="status">
          {!needsTap && <LoaderIcon />}
          {shownNotice}
        </p>
      )}
      <div className="player-controls">
        <button type="button" className="play-button" aria-label={playing ? "暂停" : "播放"} onClick={toggle}>
          {playing ? <PauseSolidIcon /> : <PlaySolidIcon />}
        </button>
      </div>
      <Progress position={position} length={Math.max(playable, totalSeconds ?? 0)} />
      {error && (
        <p className="form-error player-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
