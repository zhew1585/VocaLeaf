import { useEffect, useState, type RefObject } from "react";

// Playback speed (PRD 4.4.1): seven steps, remembered for every Book rather than per Book. It is kept in this
// browser's storage, so it holds across Books and reloads on one device.

/** The playback speeds, slowest first. */
export const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const;
export type Speed = (typeof SPEEDS)[number];

const STORAGE_KEY = "vocaleaf.speed";

/** "1.0×", "0.75×": one decimal unless the speed needs two, as in the design. */
export function speedLabel(speed: number): string {
  return `${Number.isInteger(speed * 10) ? speed.toFixed(1) : speed.toFixed(2)}×`;
}

function isSpeed(value: number): value is Speed {
  return (SPEEDS as readonly number[]).includes(value);
}

/** The remembered speed, 1.0 when none was chosen or storage is unavailable. */
export function loadSpeed(): Speed {
  try {
    const stored = Number(localStorage.getItem(STORAGE_KEY));
    return isSpeed(stored) ? stored : 1;
  } catch {
    return 1;
  }
}

/** Remembers the speed for every Book from now on. */
export function saveSpeed(speed: Speed): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(speed));
  } catch {
    // Without storage the speed holds until the page reloads.
  }
}

/**
 * The session's speed, applied to its audio element: kept for every Book and every fresh element, since loading
 * a stream resets the element's rate to its default. `reset` changes whenever the element or its stream does.
 */
export function useSpeed(audio: RefObject<HTMLAudioElement | null>, reset: unknown) {
  const [speed, setSpeedState] = useState<Speed>(loadSpeed);
  useEffect(() => {
    const el = audio.current;
    if (!el) return;
    el.defaultPlaybackRate = speed;
    el.playbackRate = speed;
  }, [audio, speed, reset]);
  const setSpeed = (next: Speed) => {
    saveSpeed(next);
    setSpeedState(next);
  };
  return { speed, setSpeed };
}
