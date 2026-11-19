import { useCallback, useEffect, useMemo, useRef, type RefObject } from "react";
import { getBook, saveListening } from "../api";
import { sentenceStartMs } from "./navigation";

/** Playback syncs its position this often while it plays (PRD 4.7.2 进度同步间隔). */
export const SYNC_INTERVAL_MS = 15_000;

interface Options {
  /** The Book playback belongs to, or null while that is not known (no Book, or switching Books). */
  bookToReport(): string | null;
  playing: boolean;
  /** Sentence starts of the session's Book as held so far (its timeline), ascending. */
  sentenceStarts(): readonly number[];
  /** Moves paused playback to a position another device synced, keeping it paused. */
  moveTo(seconds: number): void;
}

/** The position this device last sent or took for the session's Book, and whether the API holds it. */
interface Synced {
  bookId: string;
  ms: number;
  /** `failed`: sent again at the next chance. */
  state: "sending" | "held" | "failed";
}

/**
 * Keeps the session's position and the API's in step (PRD 4.4.1 进度同步); the API keeps the Sentence there as
 * the place to resume, on any device, the latest sync winning.
 * - Sends: on play and pause (`report`), when a paused position moves (`moved`: a drag, 重听, 下一句), before
 *   switching Books or logging out (`flush`), every SYNC_INTERVAL_MS while playing, and when the page is hidden
 *   or left (with keepalive). Only a position the API does not hold yet is sent, so a session left paused never
 *   overwrites what another device listened to since.
 * - Takes: when the page shows again with the session paused where the API holds it, playback moves to the
 *   Sentence another device synced meanwhile.
 * `adopt` records a position that came from the API (a resume), or a fresh Book's start, as already held.
 */
export function useProgressSync(audio: RefObject<HTMLAudioElement | null>, options: Options) {
  const synced = useRef<Synced | null>(null);
  const latest = useRef(options);
  latest.current = options;

  /** Sends `ms` unless the API holds it already (`force`: playback started or paused, which also dates it). */
  const send = useCallback((positionMs: number, { keepalive = false, force = false } = {}) => {
    const bookId = latest.current.bookToReport();
    if (bookId === null) return;
    const ms = Math.round(positionMs);
    const held = synced.current;
    if (!force && held?.bookId === bookId && held.ms === ms && held.state !== "failed") return;
    const sent: Synced = { bookId, ms, state: "sending" };
    synced.current = sent;
    saveListening(bookId, ms, { keepalive }).then(
      () => {
        if (synced.current === sent) synced.current = { ...sent, state: "held" };
      },
      (err: unknown) => {
        // Sent again at the next play, pause, interval or page hide.
        if (synced.current === sent) synced.current = { ...sent, state: "failed" };
        console.warn("saving listening progress failed", err);
      },
    );
  }, []);

  /** Sends where playback is now, unless the API holds it already. */
  const flush = useCallback(
    (keepalive = false) => {
      const el = audio.current;
      if (el) send(el.currentTime * 1000, { keepalive });
    },
    [audio, send],
  );

  const playing = options.playing;
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => flush(), SYNC_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [playing, flush]);

  /** Back on the page, paused and unmoved: follow another device that listened on meanwhile. */
  const follow = useCallback(async () => {
    const el = audio.current;
    const held = synced.current;
    if (!el || !el.paused || held?.state !== "held" || held.ms !== Math.round(el.currentTime * 1000)) return;
    const startMs = (await getBook(held.bookId)).listening?.startMs ?? null;
    // Anything changed meanwhile (played, moved, another Book) wins over the API's position.
    if (startMs === null || synced.current !== held || audio.current !== el || !el.paused) return;
    if (startMs === sentenceStartMs(latest.current.sentenceStarts(), held.ms)) return;
    synced.current = { bookId: held.bookId, ms: startMs, state: "held" };
    latest.current.moveTo(startMs / 1000);
  }, [audio]);

  useEffect(() => {
    const onLeave = () => flush(true);
    const onVisibility = () => {
      if (document.visibilityState === "hidden") onLeave();
      else
        follow().catch((err: unknown) => {
          console.warn("loading listening progress failed", err);
        });
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onLeave);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onLeave);
    };
  }, [flush, follow]);

  return useMemo(
    () => ({
      /** Playback started or paused: send where it is. */
      report: () => {
        const el = audio.current;
        if (el) send(el.currentTime * 1000, { force: true });
      },
      flush,
      /** This device moved playback to `ms`; sent at once while paused (playing sends on its own). */
      moved: (ms: number) => {
        if (audio.current?.paused) send(ms);
      },
      adopt: (bookId: string, ms: number) => {
        const rounded = Math.round(ms);
        const held = synced.current;
        // Landing where this device just sent (a drag) keeps that report's state.
        if (held?.bookId === bookId && held.ms === rounded) return;
        synced.current = { bookId, ms: rounded, state: "held" };
      },
    }),
    [audio, flush, send],
  );
}
