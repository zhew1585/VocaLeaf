import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatElapsed, formatRemaining, Player } from "./Player";

// hls.js needs MediaSource, which jsdom lacks: a stand-in records what the player asks of it.
const hls = vi.hoisted(() => ({
  instances: [] as { config: unknown; source?: string; media?: HTMLMediaElement; destroyed: boolean }[],
}));
vi.mock("hls.js", () => ({
  default: class {
    static isSupported = () => true;
    record: (typeof hls.instances)[number];
    constructor(config: unknown) {
      this.record = { config, destroyed: false };
      hls.instances.push(this.record);
    }
    loadSource(src: string) {
      this.record.source = src;
    }
    attachMedia(media: HTMLMediaElement) {
      this.record.media = media;
    }
    destroy() {
      this.record.destroyed = true;
    }
  },
}));

let play: ReturnType<typeof vi.fn>;
let pause: ReturnType<typeof vi.fn>;

beforeEach(() => {
  hls.instances.length = 0;
  // jsdom does not implement media playback; play and pause fire the events a browser would.
  play = vi.fn(function (this: HTMLMediaElement) {
    Object.defineProperty(this, "paused", { value: false, configurable: true });
    this.dispatchEvent(new Event("play"));
    return Promise.resolve();
  });
  pause = vi.fn(function (this: HTMLMediaElement) {
    Object.defineProperty(this, "paused", { value: true, configurable: true });
    this.dispatchEvent(new Event("pause"));
  });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(play as never);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(pause as never);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function audio() {
  return document.querySelector("audio")!;
}

function timeUpdate(currentTime: number, duration: number) {
  const el = audio();
  Object.defineProperty(el, "currentTime", { value: currentTime, configurable: true });
  Object.defineProperty(el, "duration", { value: duration, configurable: true });
  act(() => {
    el.dispatchEvent(new Event("durationchange"));
    el.dispatchEvent(new Event("timeupdate"));
  });
}

describe("Player", () => {
  it("loads the Book's HLS playlist from the beginning, not from the live edge", () => {
    render(<Player src="/api/books/b1/audio.m3u8" />);

    expect(hls.instances).toHaveLength(1);
    expect(hls.instances[0]).toMatchObject({ source: "/api/books/b1/audio.m3u8", media: audio() });
    expect(hls.instances[0]!.config).toMatchObject({ startPosition: 0 });
  });

  it("plays and pauses with the one button, which says what it will do", () => {
    render(<Player src="/api/books/b1/audio.m3u8" />);

    fireEvent.click(screen.getByRole("button", { name: "播放" }));
    expect(play).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "暂停" }));
    expect(pause).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "播放" })).toBeTruthy();
  });

  it("shows how far into the whole Book playback is, with time listened and time left", () => {
    render(<Player src="/api/books/b1/audio.m3u8" />);

    timeUpdate(252, 41_752);

    const bar = screen.getByRole("progressbar", { name: "整本进度" });
    expect(bar.getAttribute("aria-valuenow")).toBe("252");
    expect(bar.getAttribute("aria-valuemax")).toBe("41752");
    expect(screen.getByText("0:04:12")).toBeTruthy();
    expect(screen.getByText("−11:31:40")).toBeTruthy();
  });

  it("uses what is seekable as the length while the Book is still generating", () => {
    render(<Player src="/api/books/b1/audio.m3u8" />);
    Object.defineProperty(audio(), "seekable", { value: { length: 1, end: () => 120 }, configurable: true });

    timeUpdate(30, Number.POSITIVE_INFINITY);

    expect(screen.getByRole("progressbar").getAttribute("aria-valuemax")).toBe("120");
    expect(screen.getByText("−0:01:30")).toBeTruthy();
  });

  it("stops loading when it goes away", () => {
    const { unmount } = render(<Player src="/api/books/b1/audio.m3u8" />);
    unmount();
    expect(hls.instances[0]!.destroyed).toBe(true);
  });
});

describe("time formats", () => {
  it("writes hours, minutes and seconds, and a minus sign for time left", () => {
    expect(formatElapsed(0)).toBe("0:00:00");
    expect(formatElapsed(3_725.9)).toBe("1:02:05");
    expect(formatRemaining(41_500)).toBe("−11:31:40");
  });
});
