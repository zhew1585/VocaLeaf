// The sleep timer (PRD 4.4.1, G9): pauses playback after 15 to 60 minutes of wall-clock time, or at the end of
// the Chapter, fading out first. It keeps running while paused and across Books; a jump to another Chapter
// moves 【本章结束】 to that Chapter's end.
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { BookTimeline } from "../api";
import { chapterEndAt } from "./navigation";

export const SLEEP_MINUTES = [15, 30, 45, 60] as const;
export type SleepChoice = (typeof SLEEP_MINUTES)[number] | "chapter";

export type SleepTimer =
  | { choice: (typeof SLEEP_MINUTES)[number]; endsAt: number }
  /** `anchorMs`: where playback was when the timer was set or last jumped; its Chapter's end is the deadline. */
  | { choice: "chapter"; anchorMs: number };

/** The volume fades to nothing over this much listening time before the timer pauses. */
export const FADE_MS = 3000;
const TICK_MS = 250;
const MINUTE_MS = 60_000;

interface Moment {
  now: number;
  positionMs: number;
  rate: number;
  chapters: BookTimeline["chapters"];
}

/** Listening time left until the timer pauses, or null while unknown (its Chapter is still generating). */
export function sleepRemainingMs(timer: SleepTimer, { now, positionMs, rate, chapters }: Moment): number | null {
  if (timer.choice !== "chapter") return timer.endsAt - now;
  const end = chapterEndAt(chapters, timer.anchorMs);
  return end === null ? null : (end - positionMs) / rate;
}

/**
 * Runs the sleep timer on the session's audio element. `chapters` is the session Book's timeline; `jumped` is
 * called with the new position whenever playback jumps or another Book opens, so 【本章结束】 follows to the
 * Chapter landed in.
 */
export function useSleepTimer(audio: RefObject<HTMLAudioElement | null>, chapters: BookTimeline["chapters"]) {
  const [timer, setTimer] = useState<SleepTimer | null>(null);
  const latestChapters = useRef(chapters);
  latestChapters.current = chapters;

  const moment = (el: HTMLAudioElement): Moment => ({
    now: Date.now(),
    positionMs: el.currentTime * 1000,
    rate: el.playbackRate,
    chapters: latestChapters.current,
  });

  useEffect(() => {
    if (timer === null) return;
    const tick = () => {
      const el = audio.current;
      if (!el) return;
      const left = sleepRemainingMs(timer, moment(el));
      if (left === null) return;
      if (left <= 0) {
        // Ran out while paused: the timer just ends (G9, wall-clock time).
        if (!el.paused) el.pause();
        el.volume = 1;
        setTimer(null);
        return;
      }
      el.volume = el.paused ? 1 : Math.min(1, left / FADE_MS);
    };
    tick();
    const id = setInterval(tick, TICK_MS);
    return () => {
      clearInterval(id);
      if (audio.current) audio.current.volume = 1;
    };
    // moment reads refs and the element; the timer says when to start over.
  }, [timer, audio]);

  const set = useCallback(
    (choice: SleepChoice | null) => {
      if (choice === null) setTimer(null);
      else if (choice === "chapter") setTimer({ choice, anchorMs: (audio.current?.currentTime ?? 0) * 1000 });
      else setTimer({ choice, endsAt: Date.now() + choice * MINUTE_MS });
    },
    [audio],
  );

  const jumped = useCallback((positionMs: number) => {
    setTimer((t) => (t?.choice === "chapter" ? { ...t, anchorMs: positionMs } : t));
  }, []);

  /** Time left now, for display; null while unknown or with no timer. */
  const remaining = (): number | null => {
    const el = audio.current;
    return timer === null || !el ? null : sleepRemainingMs(timer, moment(el));
  };

  return { timer, set, jumped, remaining };
}
