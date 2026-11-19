import { useRef, type RefObject } from "react";
import type { BookTimeline } from "../api";
import { nextSentenceMs, replayTargetMs, targetIndex } from "./navigation";

interface Options {
  /** The session Book's timeline as it covers a position (useBookTimeline's `covering`). */
  covering(positionMs: number): Promise<BookTimeline | null>;
  /** Called with the target just before a jump moves the element (a start request still waiting is dropped). */
  jumping(ms: number): void;
}

/**
 * 重听 and 下一句 on the session's audio element (PRD 4.4.3), and the Sentence 【标记】 marks (PRD 4.4.2). Keeps where playback last landed by any other jump
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

  /** What a press sees: where playback is, at what speed, and where it last landed. */
  const context = (el: HTMLAudioElement) => ({ rate: el.playbackRate, landedAtMs: landedAtMs.current });

  return {
    replay: () => {
      const el = audio.current;
      if (!el) return;
      const seen = context(el);
      jump((starts, positionMs) => replayTargetMs(starts, positionMs, seen));
    },
    /** The id of the Sentence a Mark pressed now goes to, by the same rule as 重听; null without Sentences. */
    target: async (): Promise<string | null> => {
      const el = audio.current;
      if (!el) return null;
      const positionMs = el.currentTime * 1000;
      const seen = context(el);
      const timeline = await covering(positionMs);
      const i = timeline === null ? null : targetIndex(timeline.sentenceStartsMs, positionMs, seen);
      return i === null ? null : (timeline!.sentenceIds[i] ?? null);
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
