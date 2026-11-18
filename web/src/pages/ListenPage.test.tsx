import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BookDetail } from "../api";
import { ListenPage } from "./ListenPage";

// How many players loaded the playlist: a reload makes a new hls.js instance.
const hlsLoads = vi.hoisted(() => ({ count: 0 }));
vi.mock("hls.js", () => ({
  default: class {
    static isSupported = () => true;
    constructor() {
      hlsLoads.count += 1;
    }
    static Events = { ERROR: "hlsError" };
    on() {}
    loadSource() {}
    attachMedia() {}
    destroy() {}
  },
}));

let play: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // jsdom does not implement media playback.
  play = vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (this: HTMLMediaElement) {
    Object.defineProperty(this, "paused", { value: false, configurable: true });
    this.dispatchEvent(new Event("play"));
    return Promise.resolve();
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  window.history.pushState(null, "", "/");
});

const book: BookDetail = {
  id: "b1",
  title: "Pride and Prejudice",
  author: "Jane Austen",
  status: "generating",
  playable: true,
  failureReason: null,
  progress: { generated: 0, narrated: 0 },
  createdAt: "2026-11-18T00:00:00.000Z",
  chapters: [],
  durationMs: 41_752_000,
};

type Chapter = BookDetail["chapters"][number];
const chapter = (id: string, index: number, rest: Partial<Chapter>): Chapter => ({
  id,
  index,
  title: `Chapter ${index}`,
  skipped: false,
  audioStatus: "pending",
  sentenceCount: 10,
  durationMs: null,
  startMs: null,
  waitSeconds: null,
  ...rest,
});

/** Chapter 1 is generated (10 minutes), Chapter 2 is generating with nothing playable yet, Chapter 3 waits. */
const generating: BookDetail = {
  ...book,
  progress: { generated: 1, narrated: 3 },
  chapters: [
    chapter("c1", 0, { audioStatus: "generated", durationMs: 600_000, startMs: 0 }),
    chapter("c2", 1, { audioStatus: "generating", waitSeconds: 40 }),
    chapter("c3", 2, { waitSeconds: 300 }),
  ],
};

/** Chapter 2 now has audio in the playlist, right after Chapter 1. */
const secondPlayable: BookDetail = {
  ...generating,
  chapters: [generating.chapters[0]!, { ...generating.chapters[1]!, startMs: 600_000, waitSeconds: null }, generating.chapters[2]!],
};

/** Answers GET /api/books/b1 with each response in turn, the last one from then on. */
function serve(...responses: BookDetail[]) {
  const queue = [...responses];
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(queue.length > 1 ? queue.shift() : queue[0])));
}

/** The audio element as hls.js leaves it: metadata loaded, `seconds` playable; returns the seeks made. */
function audioWithGenerated(seconds: number) {
  const el = document.querySelector("audio")!;
  const seeks: number[] = [];
  Object.defineProperty(el, "readyState", { value: HTMLMediaElement.HAVE_METADATA, configurable: true });
  Object.defineProperty(el, "duration", { value: seconds, configurable: true });
  Object.defineProperty(el, "currentTime", {
    get: () => seeks.at(-1) ?? 0,
    set: (t: number) => seeks.push(t),
    configurable: true,
  });
  act(() => el.dispatchEvent(new Event("durationchange")));
  return { el, seeks };
}

/** The playlist reloaded with `seconds` of audio in it. */
function grow(seconds: number) {
  const el = document.querySelector("audio")!;
  Object.defineProperty(el, "duration", { value: seconds, configurable: true });
  act(() => el.dispatchEvent(new Event("durationchange")));
}

describe("ListenPage (专注页)", () => {
  it("shows the Book and its player once the Book is playable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(book)));
    render(<ListenPage id="b1" />);

    expect(await screen.findByRole("heading", { name: "Pride and Prejudice" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "播放" })).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "整本进度" })).toBeTruthy();
  });

  it("waits for the first segment, then offers the player without a reload", async () => {
    const responses = [{ ...book, playable: false }, { ...book, playable: false }, book];
    const fetchMock = vi.fn(async () => Response.json(responses.shift() ?? book));
    vi.stubGlobal("fetch", fetchMock);
    render(<ListenPage id="b1" />);

    expect(await screen.findByText("正在生成第一段音频，稍候即可收听")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "播放" })).toBeNull();

    expect(await screen.findByRole("button", { name: "播放" }, { timeout: 5000 })).toBeTruthy();
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("shows the whole Book's length, even while only its start is generated", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(book)));
    render(<ListenPage id="b1" />);
    expect(await screen.findByText("−11:35:52")).toBeTruthy();
  });

  it("says there is nothing to play when the Book finished without audio", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...book, status: "ready", playable: false, durationMs: null })));
    render(<ListenPage id="b1" />);
    expect(await screen.findByText("这本书没有可播放的音频")).toBeTruthy();
  });

  describe("opened at a Chapter (from the Chapter list)", () => {
    it("says how long a Chapter that is not generated yet takes, then plays it from its start by itself (AC-BOOK-03)", async () => {
      window.history.pushState(null, "", "/books/b1/listen?chapter=c2");
      serve(generating, secondPlayable);
      render(<ListenPage id="b1" />);

      expect((await screen.findByRole("status")).textContent).toBe("该章节生成中，预计约 40 秒");
      const { seeks } = audioWithGenerated(600);
      expect(play).not.toHaveBeenCalled();

      // The next poll (every 1.5 seconds while the user waits) places Chapter 2; the playlist then grows.
      await vi.waitFor(() => expect(screen.queryByRole("status")).toBeNull(), { timeout: 4000 });
      grow(610);
      await vi.waitFor(() => expect(play).toHaveBeenCalledTimes(1));
      expect(seeks.at(-1)).toBe(600);
      // Done: a reload does not jump to the Chapter again.
      expect(window.location.search).toBe("");
    });

    it("plays a generated Chapter from its start at once", async () => {
      window.history.pushState(null, "", "/books/b1/listen?chapter=c2");
      serve(secondPlayable);
      render(<ListenPage id="b1" />);
      await screen.findByRole("button", { name: "播放" });

      const { seeks } = audioWithGenerated(900);

      expect(seeks).toEqual([600]);
      expect(play).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("status")).toBeNull();
    });

    it("says how long the Chapter takes while the Book has no audio at all yet", async () => {
      window.history.pushState(null, "", "/books/b1/listen?chapter=c2");
      serve({ ...generating, playable: false });
      render(<ListenPage id="b1" />);
      expect(await screen.findByText("该章节生成中，预计约 40 秒")).toBeTruthy();
    });

    it("stops waiting for the Chapter once the user plays something else", async () => {
      window.history.pushState(null, "", "/books/b1/listen?chapter=c3");
      serve(generating);
      render(<ListenPage id="b1" />);
      await screen.findByRole("status");

      fireEvent.click(screen.getByRole("button", { name: "播放" }));

      expect(screen.queryByRole("status")).toBeNull();
      expect(window.location.search).toBe("");
    });
  });

  describe("when a retried Chapter comes into the playlist before its end", () => {
    // Chapter 2 failed and was retried; Chapter 3 played on after Chapter 1.
    const retrying: BookDetail = {
      ...book,
      status: "ready",
      chapters: [
        chapter("c1", 0, { audioStatus: "generated", startMs: 0 }),
        chapter("c2", 1, { audioStatus: "generating", waitSeconds: 30 }),
        chapter("c3", 2, { audioStatus: "generated", startMs: 600_000 }),
      ],
    };
    // Chapter 2 is generated (5 minutes) and inserted before Chapter 3.
    const inserted: BookDetail = {
      ...retrying,
      chapters: [
        retrying.chapters[0]!,
        { ...retrying.chapters[1]!, audioStatus: "generated", startMs: 600_000, waitSeconds: null },
        { ...retrying.chapters[2]!, startMs: 900_000 },
      ],
    };

    it("reloads the playlist and resumes at the same place in the same Chapter, still playing", async () => {
      hlsLoads.count = 0;
      serve(retrying, inserted);
      render(<ListenPage id="b1" />);
      fireEvent.click(await screen.findByRole("button", { name: "播放" }));
      const { el } = audioWithGenerated(700);
      Object.defineProperty(el, "currentTime", { value: 612, configurable: true });
      act(() => el.dispatchEvent(new Event("timeupdate")));
      expect(hlsLoads.count).toBe(1);

      // Polls every 5 seconds while a retried Chapter generates in a 已就绪 Book.
      await vi.waitFor(() => expect(hlsLoads.count).toBe(2), { timeout: 7000 });
      const reloaded = audioWithGenerated(1000);
      expect(reloaded.el).not.toBe(el);
      expect(reloaded.seeks).toEqual([912]);
      expect(play).toHaveBeenCalledTimes(2);
    }, 10_000);

    it("plays the retried Chapter the user waits for from its start in the new playlist (AC-BOOK-03, AC-BOOK-04)", async () => {
      hlsLoads.count = 0;
      window.history.pushState(null, "", "/books/b1/listen?chapter=c2");
      serve(retrying, inserted);
      render(<ListenPage id="b1" />);
      expect((await screen.findByRole("status")).textContent).toBe("该章节生成中，预计约 30 秒");
      const old = audioWithGenerated(700);

      await vi.waitFor(() => expect(hlsLoads.count).toBe(2), { timeout: 4000 });
      expect(old.seeks).toEqual([]);
      const reloaded = audioWithGenerated(1000);
      expect(reloaded.seeks).toEqual([600]);
      expect(play).toHaveBeenCalledTimes(1);
    });
  });

  it("asks for a tap when the browser does not let the Chapter start on its own", async () => {
    play.mockImplementationOnce(() => Promise.reject(new DOMException("autoplay", "NotAllowedError")));
    window.history.pushState(null, "", "/books/b1/listen?chapter=c2");
    serve(secondPlayable);
    render(<ListenPage id="b1" />);
    await screen.findByRole("button", { name: "播放" });

    audioWithGenerated(900);

    expect((await screen.findByRole("status")).textContent).toBe("已可以收听，点播放开始");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says the Chapter being generated is awaited when playback catches up with it", async () => {
    const partly: BookDetail = {
      ...generating,
      chapters: [generating.chapters[0]!, { ...generating.chapters[1]!, startMs: 600_000, waitSeconds: null }, generating.chapters[2]!],
    };
    serve(partly);
    render(<ListenPage id="b1" />);
    fireEvent.click(await screen.findByRole("button", { name: "播放" }));
    const { el } = audioWithGenerated(640);
    Object.defineProperty(el, "currentTime", { value: 640, configurable: true });

    act(() => el.dispatchEvent(new Event("waiting")));

    expect(screen.getByRole("status").textContent).toBe("该章节生成中，生成后自动播放");
  });

  it("says how long the next Chapter takes when playback catches up with the generated audio", async () => {
    serve(generating);
    render(<ListenPage id="b1" />);
    fireEvent.click(await screen.findByRole("button", { name: "播放" }));
    const { el } = audioWithGenerated(600);
    Object.defineProperty(el, "currentTime", { value: 600, configurable: true });

    act(() => el.dispatchEvent(new Event("waiting")));
    expect(screen.getByRole("status").textContent).toBe("该章节生成中，预计约 40 秒");

    act(() => el.dispatchEvent(new Event("playing")));
    expect(screen.queryByRole("status")).toBeNull();
  });
});
