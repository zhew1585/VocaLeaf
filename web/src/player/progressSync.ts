import { useCallback, useEffect, useRef, type RefObject } from "react";
import { saveListening } from "../api";

/** Playback syncs its position this often while it plays (PRD 4.7.2 进度同步间隔). */
export const SYNC_INTERVAL_MS = 15_000;

interface ReportOptions {
  /** Report even when playback did not move since the last report: it just started or paused. */
  always?: boolean;
  /** The page is going away; the request has to outlive it. */
  keepalive?: boolean;
}

/**
 * Tells the API where the session's playback is (PRD 4.4.1 进度同步); the API keeps the Sentence there as the
 * place to resume, on any device. The session reports on play and pause (`report({ always })`) and before it
 * switches Books (`report()`); this hook adds every 15 seconds while playing and whenever the page is hidden or
 * left. A paused session reports only when this device moved it (`moved`: a drag, 重听, 下一句), so a tab left
 * paused never overwrites what another device listened to since. `bookToReport` names the Book playback belongs
 * to, or null while that is not known (no Book, or switching Books).
 */
export function useProgressSync(
  audio: RefObject<HTMLAudioElement | null>,
  bookToReport: () => string | null,
  playing: boolean,
) {
  const moved = useRef(false);
  const latest = useRef(bookToReport);
  latest.current = bookToReport;

  const report = useCallback(
    ({ always = false, keepalive = false }: ReportOptions = {}) => {
      const el = audio.current;
      const bookId = latest.current();
      if (!el || bookId === null) return;
      if (!always && !moved.current && el.paused) return;
      moved.current = false;
      saveListening(bookId, el.currentTime * 1000, { keepalive }).catch((err: unknown) => {
        // Losing one report only loses a little progress; the next one reports again.
        console.warn("saving listening progress failed", err);
      });
    },
    [audio],
  );

  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => report(), SYNC_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [playing, report]);

  useEffect(() => {
    const onLeave = () => report({ keepalive: true });
    const onVisibility = () => {
      if (document.visibilityState === "hidden") onLeave();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onLeave);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onLeave);
    };
  }, [report]);

  return {
    report,
    /** This device moved playback while it may be paused; the next report sends it. */
    moved: () => {
      moved.current = true;
    },
    /** A new Book or none: nothing of the old one is left to report. */
    forget: () => {
      moved.current = false;
    },
  };
}
