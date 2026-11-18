import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  it("measures progress against the whole Book's length when it is known", () => {
    render(<Player src="/api/books/b1/audio.m3u8" totalSeconds={41_752} />);

    timeUpdate(252, 600); // only 10 minutes are generated so far

    expect(screen.getByRole("progressbar").getAttribute("aria-valuemax")).toBe("41752");
    expect(screen.getByText("−11:31:40")).toBeTruthy();
  });

  it("says so when the stream cannot be played, but not for errors hls.js recovers from", () => {
    render(<Player src="/api/books/b1/audio.m3u8" />);
    const onError = hls.instances[0]!.handlers.hlsError!;

    act(() => onError("hlsError", { fatal: false }));
    expect(screen.queryByRole("alert")).toBeNull();

    act(() => onError("hlsError", { fatal: true }));
    expect(screen.getByRole("alert").textContent).toBe("播放失败，请刷新页面重试");
  });

  describe("a requested start (a Chapter picked from the list)", () => {
    /** The audio element as hls.js leaves it: metadata loaded, `generated` seconds playable, seeks recorded. */
    function loaded(generated: number) {
      const el = audio();
      const seeks: number[] = [];
      Object.defineProperty(el, "readyState", { value: HTMLMediaElement.HAVE_METADATA, configurable: true });
      Object.defineProperty(el, "currentTime", {
        get: () => seeks.at(-1) ?? 0,
        set: (t: number) => seeks.push(t),
        configurable: true,
      });
      grow(generated);
      return seeks;
    }

    /** The playlist reloaded with `generated` seconds of audio in it. */
    function grow(generated: number) {
      const el = audio();
      Object.defineProperty(el, "duration", { value: generated, configurable: true });
      act(() => el.dispatchEvent(new Event("durationchange")));
    }

    it("seeks there and plays once the playlist reaches it, then reports the request done", () => {
      const onStartSettled = vi.fn();
      render(<Player src="/api/books/b1/audio.m3u8" startAt={{ id: "c3", seconds: 600 }} onStartSettled={onStartSettled} />);
      const seeks = loaded(300);
      expect(play).not.toHaveBeenCalled();

      grow(610);

      expect(seeks).toEqual([600]);
      expect(play).toHaveBeenCalledTimes(1);
      expect(onStartSettled).toHaveBeenCalledTimes(1);
      grow(620);
      expect(seeks).toEqual([600]);
    });

    it("keeps waiting while the position is not known yet, and plays once it is", () => {
      const { rerender } = render(<Player src="/api/books/b1/audio.m3u8" startAt={{ id: "c3", seconds: null }} />);
      const seeks = loaded(300);
      grow(900);
      expect(play).not.toHaveBeenCalled();

      rerender(<Player src="/api/books/b1/audio.m3u8" startAt={{ id: "c3", seconds: 600 }} />);

      expect(seeks).toEqual([600]);
      expect(play).toHaveBeenCalledTimes(1);
    });

    it("is dropped when the user plays or pauses by hand meanwhile", () => {
      const onStartSettled = vi.fn();
      render(<Player src="/api/books/b1/audio.m3u8" startAt={{ id: "c3", seconds: 600 }} onStartSettled={onStartSettled} />);
      const seeks = loaded(300);

      fireEvent.click(screen.getByRole("button", { name: "播放" }));
      expect(onStartSettled).toHaveBeenCalledTimes(1);
      grow(610);

      expect(seeks).toEqual([]);
      expect(play).toHaveBeenCalledTimes(1);
    });

    it("shows no error when the browser wants a tap before playing on its own", async () => {
      play.mockImplementationOnce(() => Promise.reject(new DOMException("autoplay", "NotAllowedError")));
      render(<Player src="/api/books/b1/audio.m3u8" startAt={{ id: "c3", seconds: 10 }} />);
      loaded(60);
      await act(async () => {});

      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.getByRole("button", { name: "播放" })).toBeTruthy();
    });
  });

  it("reports when playback waits at the end of the generated audio, and when it moves on again", () => {
    const onWaitingForAudio = vi.fn();
    render(<Player src="/api/books/b1/audio.m3u8" onWaitingForAudio={onWaitingForAudio} />);
    fireEvent.click(screen.getByRole("button", { name: "播放" }));
    const el = audio();

    // Buffering in the middle is not waiting for audio to be generated.
    timeUpdate(100, 600);
    act(() => el.dispatchEvent(new Event("waiting")));
    expect(onWaitingForAudio).not.toHaveBeenCalled();

    timeUpdate(599.6, 600);
    act(() => el.dispatchEvent(new Event("waiting")));
    expect(onWaitingForAudio).toHaveBeenLastCalledWith(true);

    act(() => el.dispatchEvent(new Event("playing")));
    expect(onWaitingForAudio).toHaveBeenLastCalledWith(false);
    expect(onWaitingForAudio).toHaveBeenCalledTimes(2);
  });

  it("shows a notice above the controls", () => {
    render(<Player src="/api/books/b1/audio.m3u8" notice="该章节生成中，预计约 40 秒" />);
    expect(screen.getByRole("status").textContent).toBe("该章节生成中，预计约 40 秒");
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
