// Playback behaviour of the Player beyond play / pause: starting at a position on its own once the playlist
// reaches it, and telling when playback waits for audio that is still being generated.
import { useEffect, useRef, type RefObject } from "react";

/** How close to the end of the generated audio a stall counts as waiting for more to be generated. */
const END_SLACK_SECONDS = 1;

/** A position the player moves to on its own once the playlist reaches it. */
export interface StartRequest {
  /** Tells one request from the next, so asking for the same position again starts again. */
  id: string;
  /** Null while that position is not known yet (its Chapter has no audio yet): the request waits. */
  seconds: number | null;
  /** Play from there (a Chapter picked to listen to), or only move there (keeping a paused player paused). */
  autoplay: boolean;
}

/**
 * Length of what can be played. While the Book is generating, its playlist is still growing and some browsers
 * report an infinite duration; what is seekable is then the audio generated so far.
 */
export function playableLength(audio: HTMLAudioElement): number {
  if (Number.isFinite(audio.duration)) return audio.duration;
  const { seekable } = audio;
  return seekable && seekable.length > 0 ? seekable.end(seekable.length - 1) : 0;
}

/**
 * Carries out `startAt` on the audio element once the playlist has audio at its position, then calls
 * `onSettled`. The Player calls `tryStart` on media events (the playlist grew) and `drop` when the user plays
 * or pauses by hand, which drops a start still waiting.
 */
export function useStartRequest(
  audio: RefObject<HTMLAudioElement | null>,
  startAt: StartRequest | null,
  onSettled: (() => void) | undefined,
  play: (el: HTMLAudioElement) => void,
) {
  const pending = useRef<StartRequest | null>(null);
  // As of the latest render; read from media events.
  const latest = useRef({ onSettled, play });
  latest.current = { onSettled, play };

  const settle = () => {
    pending.current = null;
    latest.current.onSettled?.();
  };

  const tryStart = () => {
    const el = audio.current;
    const request = pending.current;
    if (!el || request?.seconds == null || el.readyState < HTMLMediaElement.HAVE_METADATA) return;
    if (playableLength(el) <= request.seconds) return;
    el.currentTime = request.seconds;
    if (request.autoplay) latest.current.play(el);
    settle();
  };

  useEffect(() => {
    pending.current = startAt;
    tryStart();
    // tryStart only reads refs; the request's id and position say when it changed.
  }, [startAt?.id, startAt?.seconds]);

  const drop = () => {
    if (pending.current) settle();
  };

  return { tryStart, drop };
}

/**
 * Tells `onChange` when playback reaches the end of the audio generated so far and waits for more (true), and
 * when it moves again, is paused or goes away (false). Returns the media event handlers that detect it.
 */
export function useWaitingForAudio(
  audio: RefObject<HTMLAudioElement | null>,
  onChange: ((waiting: boolean) => void) | undefined,
) {
  const waiting = useRef(false);
  const latest = useRef(onChange);
  latest.current = onChange;

  const set = (next: boolean) => {
    if (waiting.current === next) return;
    waiting.current = next;
    latest.current?.(next);
  };
  // A player that goes away (reloaded or closed) no longer waits.
  useEffect(() => () => set(false), []);

  return {
    onWaiting: () => {
      const el = audio.current!;
      if (!el.paused && el.currentTime >= playableLength(el) - END_SLACK_SECONDS) set(true);
    },
    onPlaying: () => set(false),
    onPause: () => set(false),
  };
}
