// Test stand-ins for audio playback, which jsdom lacks: hls.js needs MediaSource, and media elements do not play.
import { act } from "@testing-library/react";
import { vi } from "vitest";

export interface FakeHlsRecord {
  config: unknown;
  source?: string;
  media?: HTMLMediaElement;
  destroyed: boolean;
  /** startLoad asked hls.js to load again (the network came back). */
  restarted?: boolean;
  handlers: Record<string, (event: string, data: { fatal: boolean }) => void>;
}

/** Every FakeHls made, in order; clear it between tests. */
export const hlsInstances: FakeHlsRecord[] = [];

/** Use with `vi.mock("hls.js", async () => ({ default: (await import("./test-media")).FakeHls }))`. */
export class FakeHls {
  static isSupported = () => true;
  static Events = { ERROR: "hlsError" };
  record: FakeHlsRecord;
  constructor(config: unknown) {
    this.record = { config, destroyed: false, handlers: {} };
    hlsInstances.push(this.record);
  }
  on(event: string, handler: FakeHlsRecord["handlers"][string]) {
    this.record.handlers[event] = handler;
  }
  loadSource(src: string) {
    this.record.source = src;
  }
  attachMedia(media: HTMLMediaElement) {
    this.record.media = media;
  }
  startLoad() {
    this.record.restarted = true;
  }
  destroy() {
    this.record.destroyed = true;
  }
}

/** Makes play and pause fire the events a browser would, and lets currentTime be set; returns the spies. */
export function stubMediaPlayback() {
  const play = vi.fn(function (this: HTMLMediaElement) {
    Object.defineProperty(this, "paused", { value: false, configurable: true });
    this.dispatchEvent(new Event("play"));
    return Promise.resolve();
  });
  const pause = vi.fn(function (this: HTMLMediaElement) {
    Object.defineProperty(this, "paused", { value: true, configurable: true });
    this.dispatchEvent(new Event("pause"));
  });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(play as never);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(pause as never);
  return { play, pause };
}

export function audio(): HTMLAudioElement {
  return document.querySelector("audio")!;
}

/** The audio reports a new position (and length), as it does while playing. */
export function timeUpdate(currentTime: number, duration = Number.POSITIVE_INFINITY) {
  const el = audio();
  Object.defineProperty(el, "currentTime", { value: currentTime, configurable: true, writable: true });
  Object.defineProperty(el, "duration", { value: duration, configurable: true });
  act(() => {
    el.dispatchEvent(new Event("durationchange"));
    el.dispatchEvent(new Event("timeupdate"));
  });
}

/** The audio element as hls.js leaves it: metadata loaded, `seconds` playable; returns the seeks made. */
export function audioWithGenerated(seconds: number) {
  const el = audio();
  const seeks: number[] = [];
  Object.defineProperty(el, "readyState", { value: HTMLMediaElement.HAVE_METADATA, configurable: true });
  Object.defineProperty(el, "currentTime", {
    get: () => seeks.at(-1) ?? 0,
    set: (t: number) => seeks.push(t),
    configurable: true,
  });
  grow(seconds);
  return { el, seeks };
}

/** The playlist reloaded with `seconds` of audio in it. */
export function grow(seconds: number) {
  const el = audio();
  Object.defineProperty(el, "duration", { value: seconds, configurable: true });
  act(() => el.dispatchEvent(new Event("durationchange")));
}
