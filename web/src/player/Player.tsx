import { LoaderIcon, NextSentenceIcon, PauseSolidIcon, PlaySolidIcon, ReplayIcon } from "../icons";
import { SleepMenu, SpeedMenu } from "./PlayerMenus";
import { Progress } from "./Progress";
import { useListening } from "./session";

/** When the browser refused to start playback on its own (autoplay policy) and wants a tap. */
const TAP_TO_PLAY = "已可以收听，点播放开始";
/** PRD F7 异常处理: the network went down. */
export const OFFLINE_NOTICE = "网络已断开，恢复后继续播放";

export interface PlayerProps {
  /** The whole Book's length (estimated while generating); without it the bar measures what is generated so far. */
  totalSeconds?: number | null;
  /** Shown above the controls, such as how long the audio being waited for still takes. */
  notice?: string | null;
}

/**
 * The floating player of the 专注页 (design 01, ④), for the listening session's Book: from left to right speed,
 * sleep timer, 重听, play / pause, 下一句, then the whole Book's progress bar to drag. Playback runs through the
 * Book's one continuous HLS stream, so it moves from Chapter to Chapter on its own, never meets a Skipped
 * Chapter and pauses at the Book's end (PRD 4.4.1 章节衔接); while the Book generates, playback that catches up
 * with the generated audio waits and goes on by itself. The right side keeps room for 【标记 M】 (#13).
 */
export function Player({ totalSeconds = null, notice = null }: PlayerProps) {
  const { playing, position, playable, error, needsTap, offline, toggle, replay, next, seek } = useListening();
  const shownNotice = offline ? OFFLINE_NOTICE : needsTap ? TAP_TO_PLAY : notice;
  const waitingNotice = !offline && !needsTap;

  return (
    <div className="player">
      {shownNotice && (
        <p className="player-notice" role="status">
          {waitingNotice && <LoaderIcon />}
          {shownNotice}
        </p>
      )}
      <div className="player-controls">
        <div className="player-side">
          <SpeedMenu />
          <SleepMenu />
        </div>
        <div className="player-transport">
          <button type="button" className="player-icon-button" aria-label="重听" onClick={replay}>
            <ReplayIcon />
          </button>
          <button type="button" className="play-button" aria-label={playing ? "暂停" : "播放"} onClick={toggle}>
            {playing ? <PauseSolidIcon /> : <PlaySolidIcon />}
          </button>
          <button type="button" className="player-icon-button" aria-label="下一句" onClick={next}>
            <NextSentenceIcon />
          </button>
        </div>
        <div className="player-side" />
      </div>
      <Progress position={position} length={Math.max(playable, totalSeconds ?? 0)} onSeek={seek} />
      {error && (
        <p className="form-error player-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
