import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useEffect, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlaybackProvider, usePlayback, type Playback } from "./playback";
import { formatElapsed, formatRemaining, Player } from "./Player";

// hls.js needs MediaSource, which jsdom lacks: a stand-in records what the player asks of it.
const hls = vi.hoisted(() => ({
  instances: [] as {
    config: unknown;
    source?: string;
    media?: HTMLMediaElement;
    destroyed: boolean;
    handlers: Record<string, (event: string, data: { fatal: boolean }) => void>;
  }[],
}));
vi.mock("hls.js", () => ({
  default: class {
    static isSupported = () => true;
    static Events = { ERROR: "hlsError" };
    record: (typeof hls.instances)[number];
    constructor(config: unknown) {
      this.record = { config, destroyed: false, handlers: {} };
      hls.instances.push(this.record);
    }
    on(event: string, handler: (event: string, data: { fatal: boolean }) => void) {
      this.record.handlers[event] = handler;
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

const SRC = "/api/books/b1/audio.m3u8";

/** Opens `src` in the session, as the 专注页 does, and hands the session out for the test to drive. */
function Open({ src, children, onSession }: { src: string; children?: ReactNode; onSession?: (p: Playback) => void }) {
  const playback = usePlayback();
  const { load } = playback;
  useEffect(() => load(src), [load, src]);
  onSession?.(playback);
  return children;
}

function renderPlayer(totalSeconds?: number) {
  return render(
    <PlaybackProvider>
      <Open src={SRC}>
        <Player totalSeconds={totalSeconds} />
      </Open>
    </PlaybackProvider>,
  );
}

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
    renderPlayer();

    expect(hls.instances).toHaveLength(1);
    expect(hls.instances[0]).toMatchObject({ source: SRC, media: audio() });
    expect(hls.instances[0]!.config).toMatchObject({ startPosition: 0 });
  });

  it("plays and pauses with the one button, which says what it will do", () => {
    renderPlayer();

    fireEvent.click(screen.getByRole("button", { name: "播放" }));
    expect(play).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "暂停" }));
    expect(pause).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "播放" })).toBeTruthy();
  });

  it("shows how far into the whole Book playback is, with time listened and time left", () => {
    renderPlayer();

    timeUpdate(252, 41_752);

    const bar = screen.getByRole("progressbar", { name: "整本进度" });
    expect(bar.getAttribute("aria-valuenow")).toBe("252");
    expect(bar.getAttribute("aria-valuemax")).toBe("41752");
    expect(screen.getByText("0:04:12")).toBeTruthy();
    expect(screen.getByText("−11:31:40")).toBeTruthy();
  });

  it("uses what is seekable as the length while the Book is still generating", () => {
    renderPlayer();
    Object.defineProperty(audio(), "seekable", { value: { length: 1, end: () => 120 }, configurable: true });

    timeUpdate(30, Number.POSITIVE_INFINITY);

    expect(screen.getByRole("progressbar").getAttribute("aria-valuemax")).toBe("120");
    expect(screen.getByText("−0:01:30")).toBeTruthy();
  });

  it("measures progress against the whole Book's length when it is known", () => {
    renderPlayer(41_752);

    timeUpdate(252, 600); // only 10 minutes are generated so far

    expect(screen.getByRole("progressbar").getAttribute("aria-valuemax")).toBe("41752");
    expect(screen.getByText("−11:31:40")).toBeTruthy();
  });

  it("says so when the stream cannot be played, but not for errors hls.js recovers from", () => {
    renderPlayer();
    const onError = hls.instances[0]!.handlers.hlsError!;

    act(() => onError("hlsError", { fatal: false }));
    expect(screen.queryByRole("alert")).toBeNull();

    act(() => onError("hlsError", { fatal: true }));
    expect(screen.getByRole("alert").textContent).toBe("播放失败，请刷新页面重试");
  });

  it("keeps playing when the player goes away, as when the user leaves the 专注页", () => {
    const { rerender } = renderPlayer();
    fireEvent.click(screen.getByRole("button", { name: "播放" }));

    rerender(<PlaybackProvider>{null}</PlaybackProvider>);

    expect(hls.instances).toHaveLength(1);
    expect(hls.instances[0]!.destroyed).toBe(false);
    expect(pause).not.toHaveBeenCalled();
  });

  it("loads a Book once however often it is opened, and drops it for another Book", () => {
    const { rerender } = render(
      <PlaybackProvider>
        <Open src={SRC} />
        <Open src={SRC} />
      </PlaybackProvider>,
    );
    expect(hls.instances).toHaveLength(1);

    rerender(
      <PlaybackProvider>
        <Open src="/api/books/b2/audio.m3u8" />
      </PlaybackProvider>,
    );
    expect(hls.instances.map((h) => [h.source, h.destroyed])).toEqual([
      [SRC, true],
      ["/api/books/b2/audio.m3u8", false],
    ]);
  });

  it("plays from a given point of the Book, even when paused before", () => {
    let session!: Playback;
    render(
      <PlaybackProvider>
        <Open src={SRC} onSession={(p) => (session = p)} />
      </PlaybackProvider>,
    );

    act(() => session.playFrom(8));

    expect(audio().currentTime).toBe(8);
    expect(play).toHaveBeenCalledTimes(1);
    expect(session.position).toBe(8);
  });
});

describe("time formats", () => {
  it("writes hours, minutes and seconds, and a minus sign for time left", () => {
    expect(formatElapsed(0)).toBe("0:00:00");
    expect(formatElapsed(3_725.9)).toBe("1:02:05");
    expect(formatRemaining(41_500)).toBe("−11:31:40");
  });
});
