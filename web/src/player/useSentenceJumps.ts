import { useRef, type RefObject } from "react";
import type { BookTimeline } from "../api";
import { nextSentenceMs, replayTargetMs } from "./navigation";

interface Options {
  /** The session Book's timeline as it covers a position (useBookTimeline's `covering`). */
  covering(positionMs: number): Promise<BookTimeline | null>;
  /** Called with the target just before a jump moves the element (a start request still waiting is dropped). */
  jumping(ms: number): void;
}

/**
 * 重听 and 下一句 on the session's audio element (PRD 4.4.3). Keeps where playback last landed by any other jump
 * the session makes (`landed`: a drag, a picked Chapter, a resume), which turns off reaction compensation until
 * playback crosses a Sentence start on its own (PRD G2). Seeks the browser or hls.js make by themselves do not
 * count. `forget` starts over for a new Book or playlist.
 */
export function useSentenceJumps(audio: RefObject<HTMLAudioElement | null>, { covering, jumping }: Options) {
  const landedAtMs = useRef<number | null>(null);

  /** Jumps to a Sentence start worked out from what the press saw, once the timeline covers that position. */
  const jump = (target: (starts: number[], positionMs: number) => number | null) => {
    const el = audio.current;
    if (!el) return;
    const positionMs = el.currentTime * 1000;
    void covering(positionMs).then((timeline) => {
      const ms = timeline === null ? null : target(timeline.sentenceStartsMs, positionMs);
      // A reload meanwhile replaced the element; the press belonged to the old one.
      if (ms === null || audio.current !== el) return;
      jumping(ms);
      landedAtMs.current = null;
      el.currentTime = ms / 1000;
    });
  };

  return {
    replay: () => {
      const el = audio.current;
      if (!el) return;
      const context = { rate: el.playbackRate, landedAtMs: landedAtMs.current };
      jump((starts, positionMs) => replayTargetMs(starts, positionMs, context));
    },
    next: () => jump(nextSentenceMs),
    landed: (ms: number) => {
      landedAtMs.current = ms;
    },
    forget: () => {
      landedAtMs.current = null;
    },
  };
}
