import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BookDetail, ChapterSummary, Sentence } from "../api";
import { App } from "../App";

const hls = vi.hoisted(() => ({ instances: [] as { destroyed: boolean }[] }));
vi.mock("hls.js", () => ({
  default: class {
    static isSupported = () => true;
    static Events = { ERROR: "hlsError" };
    record = { destroyed: false };
    constructor() {
      hls.instances.push(this.record);
    }
    on() {}
    loadSource() {}
    attachMedia() {}
    destroy() {
      this.record.destroyed = true;
    }
  },
}));

/**
 * jsdom has no layout. The stand-in IntersectionObserver reports the sections a test lists as near the viewport
 * (all of them by default), so the windowing of long Books can be driven by hand.
 */
const io = { near: null as Set<string> | null, observers: [] as FakeIntersectionObserver[] };
class FakeIntersectionObserver {
  elements = new Set<Element>();
  constructor(private callback: IntersectionObserverCallback) {
    io.observers.push(this);
  }
  observe(el: Element) {
    this.elements.add(el);
    this.report([el]);
  }
  unobserve(el: Element) {
    this.elements.delete(el);
  }
  disconnect() {
    this.elements.clear();
  }
  report(els: Iterable<Element>) {
    const entries = [...els].map((target) => ({
      target,
      isIntersecting: io.near === null || io.near.has((target as HTMLElement).dataset.chapterId!),
      boundingClientRect: { height: 500 },
    }));
    queueMicrotask(() => act(() => this.callback(entries as never, this as never)));
  }
}

function setNear(ids: string[] | null) {
  io.near = ids && new Set(ids);
  for (const o of io.observers) o.report(o.elements);
}

let play: ReturnType<typeof vi.fn>;
let pause: ReturnType<typeof vi.fn>;
let scrollTo: ReturnType<typeof vi.fn>;

beforeEach(() => {
  hls.instances.length = 0;
  io.near = null;
  io.observers.length = 0;
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  scrollTo = vi.fn();
  Element.prototype.scrollTo = scrollTo as never;
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
  window.history.pushState(null, "", "/books/b1/listen");
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const chapter = (id: string, title: string, startMs: number | null, extra: Partial<ChapterSummary> = {}): ChapterSummary => ({
  id,
  index: 0,
  title,
  skipped: false,
  audioStatus: startMs === null ? "pending" : "generated",
  sentenceCount: 2,
  durationMs: null,
  startMs,
  ...extra,
});

const sentence = (id: string, text: string, startMs: number | null, paragraphIndex: number): Sentence => ({
  id,
  index: 0,
  paragraphIndex,
  text,
  spokenText: text,
  startMs,
  endMs: startMs === null ? null : startMs + 2000,
  wordTimings: null,
});

// Chapter I plays from 0, the Imprint is Skipped, Chapter II starts at 10 s, Chapter III is not generated yet.
const book: BookDetail = {
  id: "b1",
  title: "Pride and Prejudice",
  author: "Jane Austen",
  status: "generating",
  playable: true,
  failureReason: null,
  createdAt: "2026-11-18T00:00:00.000Z",
  chapters: [
    chapter("c1", "Chapter I", 0),
    chapter("imprint", "Imprint", null, { skipped: true, sentenceCount: 1 }),
    chapter("c2", "Chapter II", 10_000),
    chapter("c3", "Chapter III", null, { audioStatus: "generating" }),
  ],
  durationMs: 41_752_000,
};

const sentences: Record<string, Sentence[]> = {
  c1: [
    sentence("s1", "It is a truth universally acknowledged.", 1500, 0),
    sentence("s2", "However little known the feelings.", 4000, 1),
    sentence("s3", "This truth is so well fixed.", 6500, 1),
  ],
  imprint: [sentence("i1", "This ebook is in the public domain.", null, 0)],
  c2: [sentence("s4", "Mr. Bennet was among the earliest.", 11_500, 0)],
  c3: [sentence("s5", "Not narrated yet.", null, 0)],
};

function serve(detail: BookDetail = book) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const chapterId = /\/api\/chapters\/([^/]+)\/sentences/.exec(url)?.[1];
    return Response.json(chapterId ? sentences[chapterId] : detail);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function audio() {
  return document.querySelector("audio")!;
}

function playTo(seconds: number) {
  Object.defineProperty(audio(), "currentTime", { value: seconds, configurable: true, writable: true });
  act(() => {
    audio().dispatchEvent(new Event("timeupdate"));
  });
}

const directory = () => screen.getByRole("navigation", { name: "章节目录" });
const directoryRow = (name: RegExp) => within(directory()).getByRole("button", { name });
const column = () => (document.querySelector(".focus") as HTMLElement).style.getPropertyValue("--col");

describe("ListenPage (专注页)", () => {
  it("shows every Chapter's text by paragraph, the Skipped one marked 未朗读, under the playing Chapter's title", async () => {
    serve();
    render(<App />);

    expect(await screen.findByText("It is a truth universally acknowledged.")).toBeTruthy();
    const second = screen.getByText("However little known the feelings.").closest("p")!;
    expect(second.textContent).toBe("However little known the feelings. This truth is so well fixed.");
    expect(await screen.findByText("This ebook is in the public domain.")).toBeTruthy();
    expect(within(screen.getByRole("heading", { name: /Imprint/ })).getByText("未朗读")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Chapter I/, expanded: true })).toBeTruthy();
    // The global navigation is hidden on the 专注页.
    expect(screen.queryByText("拾页")).toBeNull();
  });

  it("lists every Chapter in the directory, tagging those that cannot be played", async () => {
    serve();
    render(<App />);
    await screen.findByText("It is a truth universally acknowledged.");

    expect(directoryRow(/^Chapter I$/).getAttribute("aria-current")).toBe("true");
    expect(directoryRow(/Imprint/).textContent).toBe("Imprint未朗读");
    expect(directoryRow(/Chapter III/).textContent).toBe("Chapter III生成中");
  });

  it("highlights the playing Sentence as playback moves on, and the playing Chapter in the directory", async () => {
    serve();
    render(<App />);
    await screen.findByText("It is a truth universally acknowledged.");
    const playingSentences = () => [...document.querySelectorAll(".is-playing[data-sentence-id]")].map((el) => el.textContent);

    // The pause before the Chapter's first Sentence: nothing is highlighted yet.
    playTo(0.5);
    expect(playingSentences()).toEqual([]);

    playTo(2);
    expect(playingSentences()).toEqual(["It is a truth universally acknowledged."]);

    playTo(7);
    expect(playingSentences()).toEqual(["This truth is so well fixed."]);

    playTo(12);
    await waitFor(() => expect(playingSentences()).toEqual(["Mr. Bennet was among the earliest."]));
    expect(directoryRow(/Chapter II$/).getAttribute("aria-current")).toBe("true");
  });

  it("stops following when the user scrolls, and 回到播放处 follows again", async () => {
    serve();
    render(<App />);
    await screen.findByText("It is a truth universally acknowledged.");
    expect(screen.queryByRole("button", { name: "回到播放处" })).toBeNull();

    fireEvent.wheel(screen.getByTestId("reading-scroll"));
    const back = screen.getByRole("button", { name: "回到播放处" });

    fireEvent.click(back);
    expect(screen.queryByRole("button", { name: "回到播放处" })).toBeNull();
  });

  it("plays a Chapter from its start when it is clicked in the directory", async () => {
    serve();
    render(<App />);
    await screen.findByText("It is a truth universally acknowledged.");

    fireEvent.click(directoryRow(/Chapter II$/));

    expect(audio().currentTime).toBe(10);
    expect(play).toHaveBeenCalledTimes(1);
  });

  it("only shows a Chapter that cannot be played, without playing it", async () => {
    serve();
    render(<App />);
    await screen.findByText("It is a truth universally acknowledged.");

    fireEvent.click(directoryRow(/Imprint/));

    expect(play).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "回到播放处" })).toBeTruthy();
  });

  it("opens and closes the directory from the Chapter title, widening the text from 720 to 760, and remembers it", async () => {
    serve();
    render(<App />);
    await screen.findByText("It is a truth universally acknowledged.");
    expect(column()).toBe("720px");

    fireEvent.click(screen.getByRole("button", { name: /Chapter I/, expanded: true }));

    expect(screen.queryByRole("navigation", { name: "章节目录" })).toBeNull();
    expect(column()).toBe("760px");
    expect(screen.getByRole("button", { name: "返回书架" })).toBeTruthy();
    expect(localStorage.getItem("vocaleaf.directoryOpen")).toBe("false");

    fireEvent.click(screen.getByRole("button", { name: /Chapter I/, expanded: false }));
    expect(directory()).toBeTruthy();
    expect(column()).toBe("720px");
  });

  it("starts with 句子精读 collapsed, and its button opens it", async () => {
    // Wide enough for both sidebars docked: 240 + 620 + 64 + 440.
    vi.stubGlobal("innerWidth", 1440);
    serve();
    render(<App />);
    await screen.findByText("It is a truth universally acknowledged.");
    expect(screen.queryByRole("complementary", { name: "句子精读" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "展开句子精读" }));
    expect(screen.getByRole("complementary", { name: "句子精读" })).toBeTruthy();
    expect(column()).toBe("620px");

    fireEvent.click(screen.getByRole("button", { name: "收起句子精读" }));
    expect(screen.queryByRole("complementary", { name: "句子精读" })).toBeNull();
  });

  it("shows 句子精读 over the text when the window is too narrow to dock it, keeping the directory docked", async () => {
    serve();
    render(<App />);
    await screen.findByText("It is a truth universally acknowledged.");

    fireEvent.click(screen.getByRole("button", { name: "展开句子精读" }));

    expect(screen.getByRole("complementary", { name: "句子精读" }).className).toContain("is-overlay");
    expect(directory()).toBeTruthy();
    expect(column()).toBe("720px");
  });

  it("keeps playing after 返回书架", async () => {
    serve();
    render(<App />);
    await screen.findByText("It is a truth universally acknowledged.");
    fireEvent.click(screen.getByRole("button", { name: "播放" }));

    fireEvent.click(within(directory()).getByRole("link", { name: /返回书架/ }));

    expect(window.location.pathname).toBe("/");
    expect(screen.getByText("拾页")).toBeTruthy();
    expect(pause).not.toHaveBeenCalled();
    expect(hls.instances.map((h) => h.destroyed)).toEqual([false]);
  });

  it("fetches and renders only the Chapters near the viewport, keeping the others' place", async () => {
    const fetchMock = serve();
    io.near = new Set(["c1"]);
    render(<App />);
    await screen.findByText("It is a truth universally acknowledged.");

    const fetched = () => fetchMock.mock.calls.map(([url]) => String(url)).filter((u) => u.includes("/sentences"));
    expect(fetched()).toEqual(["/api/chapters/c1/sentences"]);
    expect(screen.queryByText("Mr. Bennet was among the earliest.")).toBeNull();
    expect(screen.getByRole("heading", { name: "Chapter II" })).toBeTruthy();

    setNear(["c2"]);
    expect(await screen.findByText("Mr. Bennet was among the earliest.")).toBeTruthy();
    // Chapter I is still fetched, as it is playing, but no longer rendered.
    expect(screen.queryByText("It is a truth universally acknowledged.")).toBeNull();
  });

  it("waits for the first segment, then offers the player without a reload", async () => {
    const responses = [{ ...book, playable: false }, { ...book, playable: false }, book];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const chapterId = /\/api\/chapters\/([^/]+)\/sentences/.exec(String(input))?.[1];
      return Response.json(chapterId ? sentences[chapterId] : (responses.shift() ?? book));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    expect(await screen.findByText("正在生成第一段音频，稍候即可收听")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "播放" })).toBeNull();

    expect(await screen.findByRole("button", { name: "播放" }, { timeout: 5000 })).toBeTruthy();
  });

  it("shows the whole Book's length, even while only its start is generated", async () => {
    serve();
    render(<App />);
    expect(await screen.findByText("−11:35:52")).toBeTruthy();
  });

  it("says there is nothing to play when the Book finished without audio", async () => {
    serve({ ...book, status: "ready", playable: false, durationMs: null });
    render(<App />);
    expect(await screen.findByText("这本书没有可播放的音频")).toBeTruthy();
  });
});
