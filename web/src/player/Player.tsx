import { LoaderIcon, PauseSolidIcon, PlaySolidIcon } from "../icons";
import { useListening } from "./session";

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

/** When the browser refused to start playback on its own (autoplay policy) and wants a tap. */
const TAP_TO_PLAY = "已可以收听，点播放开始";

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

export interface PlayerProps {
  /** The whole Book's length (estimated while generating); without it the bar measures what is generated so far. */
  totalSeconds?: number | null;
  /** Shown above the controls, such as how long the audio being waited for still takes. */
  notice?: string | null;
}

/**
 * The floating player of the 专注页 (design 01, ④): play / pause and the whole Book's progress, for the
 * listening session's Book. Playback runs through the Book's one continuous HLS stream, so it moves from
 * Chapter to Chapter on its own and never meets a Skipped Chapter; while the Book generates, playback that
 * catches up with the generated audio waits and goes on by itself. Speed, sleep timer, ⏮ / ⏭ and Mark come
 * with #9 and #13.
 */
export function Player({ totalSeconds = null, notice = null }: PlayerProps) {
  const { playing, position, playable, error, needsTap, toggle } = useListening();
  const shownNotice = needsTap ? TAP_TO_PLAY : notice;

  return (
    <div className="player">
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
