import { useEffect, useRef, useState, type RefObject } from "react";

interface Options {
  /** Makes the stream load again once the network is back (hls.js gave up on it meanwhile). */
  restart(): void;
  /** Plays the element again, as the play button does. */
  play(el: HTMLAudioElement): void;
}

/**
 * PRD F7 异常处理: when the network goes down, playing audio pauses and `offline` says so; once it is back, the
 * stream loads again and playback goes on if it was the network that paused it. `forget` drops that intent (the
 * user played or paused by hand, or another Book took over).
 */
export function useOfflinePause(audio: RefObject<HTMLAudioElement | null>, options: Options) {
  const [offline, setOffline] = useState(false);
  const pausedOffline = useRef(false);
  const latest = useRef(options);
  latest.current = options;

  useEffect(() => {
    const onOffline = () => {
      setOffline(true);
      const el = audio.current;
      if (el && !el.paused) {
        pausedOffline.current = true;
        el.pause();
      }
    };
    const onOnline = () => {
      setOffline(false);
      latest.current.restart();
      const el = audio.current;
      if (pausedOffline.current && el) latest.current.play(el);
      pausedOffline.current = false;
    };
    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);
    return () => {
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
    };
  }, [audio]);

  return {
    offline,
    forget: () => {
      pausedOffline.current = false;
    },
  };
}
