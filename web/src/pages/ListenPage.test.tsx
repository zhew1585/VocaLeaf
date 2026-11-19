import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BookDetail, BookTimeline, Sentence } from "../api";
import { PlayGuideProvider } from "../guide/PlayGuide";
import { layoutOf } from "../player/layout";
import { ListeningProvider } from "../player/session";
import { resetSentenceChats } from "../reading/chatStore";
import { audio, audioWithGenerated, grow, hlsInstances, stubMediaPlayback, timeUpdate } from "../test-media";
import { ListenPage } from "./ListenPage";

vi.mock("hls.js", async () => ({ default: (await import("../test-media")).FakeHls }));

let media: ReturnType<typeof stubMediaPlayback>;
let scrollTo: ReturnType<typeof vi.fn>;

beforeEach(() => {
  hlsInstances.length = 0;
  media = stubMediaPlayback();
  // jsdom does not lay out or scroll; record where the reading view asks to go.
  scrollTo = vi.fn();
  Element.prototype.scrollTo = scrollTo as never;
});

afterEach(() => {
  cleanup();
  resetSentenceChats();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  window.history.pushState(null, "", "/");
});

const book: BookDetail = {
  id: "b1",
  source: "upload",
  title: "Pride and Prejudice",
  author: "Jane Austen",
  status: "generating",
  playable: true,
  failureReason: null,
  coverUrl: null,
  listening: null,
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

const sentence = (id: string, paragraphIndex: number, text: string, startMs: number | null, endMs: number | null = null): Sentence => ({
  id,
  index: 0,
  paragraphIndex,
  text,
  spokenText: text,
  startMs,
  endMs,
  wordTimings: null,
});

/** The Book timeline the served Sentences and the Book as last served make (GET /api/books/b1/timeline). */
function timelineOf(sentences: Record<string, Sentence[]>, book: BookDetail): BookTimeline {
  const timed = Object.values(sentences)
    .flat()
    .filter((s) => s.startMs !== null)
    .sort((a, b) => a.startMs! - b.startMs!);
  // Settled, so the session does not poll it; the page's own polls tell it of a new layout.
  return {
    sentenceStartsMs: timed.map((s) => s.startMs!),
    sentenceIds: timed.map((s) => s.id),
    chapters: layoutOf(book),
    complete: true,
    settled: true,
  };
}

/**
 * Answers GET /api/books/b1 with each Book in turn, the last one from then on, and a Chapter's Sentences from
 * `sentences` (none when missing). Returns the fetch mock.
 */
function serve(books: BookDetail[], sentences: Record<string, Sentence[]> = {}) {
  const queue = [...books];
  let last = queue[0]!;
  const fetchMock = vi.fn(async (url: string) => {
    const chapterId = /^\/api\/chapters\/([^/]+)\/sentences$/.exec(url)?.[1];
    if (chapterId) return Response.json(sentences[chapterId] ?? []);
    if (url.endsWith("/timeline")) return Response.json(timelineOf(sentences, last));
    if (url.endsWith("/marks")) return Response.json({ pending: [] });
    if (url.endsWith("/explanation")) return Response.json({ content: null, messages: [], aiRemaining: 100 });
    last = (queue.length > 1 ? queue.shift() : queue[0])!;
    return Response.json(last);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Adds PUT /api/me/play-guide (204) in front of a fetch stand-in. */
function withGuideRoute(next: (url: string, init?: RequestInit) => Promise<Response>) {
  return async (url: string, init?: RequestInit) =>
    url === "/api/me/play-guide" ? new Response(null, { status: 204 }) : next(url, init);
}

/** The 专注页 as the app holds it; `guideSeen: false` is a user who never played anything yet. */
function renderPage({ guideSeen = true } = {}) {
  return render(
    <PlayGuideProvider seen={guideSeen}>
      <ListeningProvider>
        <ListenPage id="b1" />
      </ListeningProvider>
    </PlayGuideProvider>,
  );
}

describe("ListenPage (专注页)", () => {
  it("shows the Book and its player once the Book is playable", async () => {
    serve([book]);
    renderPage();

    expect(await screen.findByRole("heading", { name: "Pride and Prejudice" })).toBeTruthy();
    expect(await screen.findByRole("button", { name: "播放" })).toBeTruthy();
    expect(screen.getByRole("slider", { name: "整本进度" })).toBeTruthy();
  });

  it("waits for the first segment, then offers the player without a reload", async () => {
    const fetchMock = serve([{ ...book, playable: false }, { ...book, playable: false }, book]);
    renderPage();

    expect(await screen.findByText("正在生成第一段音频，稍候即可收听")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "播放" })).toBeNull();

    expect(await screen.findByRole("button", { name: "播放" }, { timeout: 5000 })).toBeTruthy();
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/books/b1").length).toBeGreaterThanOrEqual(3);
  });

  it("shows the whole Book's length, even while only its start is generated", async () => {
    serve([book]);
    renderPage();
    expect(await screen.findByText("−11:35:52")).toBeTruthy();
  });

  it("says there is nothing to play when the Book finished without audio", async () => {
    serve([{ ...book, status: "ready", playable: false, durationMs: null }]);
    renderPage();
    expect(await screen.findByText("这本书没有可播放的音频")).toBeTruthy();
  });

  describe("resuming where the user left off (AC-SHELF-04)", () => {
    const listened: BookDetail = {
      ...secondPlayable,
      listening: {
        sentenceId: "s2",
        chapterTitle: "Chapter 1",
        share: 0.5,
        startMs: 612_500,
        listenedAt: "2026-11-18T00:00:00.000Z",
      },
    };

    it("opened from the Shelf, plays from the start of the last Sentence listened to", async () => {
      window.history.pushState(null, "", "/books/b1/listen?autoplay");
      serve([listened]);
      renderPage();
      await screen.findByRole("button", { name: "播放" });

      const { seeks } = audioWithGenerated(900);

      expect(seeks).toEqual([612.5]);
      expect(media.play).toHaveBeenCalledTimes(1);
      // Done: a reload does not start playing by itself.
      expect(window.location.search).toBe("");
    });

    it("opened from the Shelf, plays a Book never listened to from its beginning", async () => {
      window.history.pushState(null, "", "/books/b1/listen?autoplay");
      serve([secondPlayable]);
      renderPage();
      await screen.findByRole("button", { name: "播放" });

      const { seeks } = audioWithGenerated(900);

      expect(seeks).toEqual([0]);
      expect(media.play).toHaveBeenCalledTimes(1);
    });

    it("opened otherwise (a reload), waits paused at the last Sentence listened to", async () => {
      serve([listened]);
      renderPage();
      await screen.findByRole("button", { name: "播放" });

      const { seeks } = audioWithGenerated(900);

      expect(seeks).toEqual([612.5]);
      expect(media.play).not.toHaveBeenCalled();
    });

    it("shows the first-play guide before a user's first play, and 【开始听】 starts playback (AC-GUIDE-02)", async () => {
      window.history.pushState(null, "", "/books/b1/listen?autoplay");
      const fetchMock = serve([listened]);
      fetchMock.mockImplementation(withGuideRoute(fetchMock.getMockImplementation()!));
      renderPage({ guideSeen: false });

      const dialog = await screen.findByRole("dialog", { name: "没听懂？按一下" });
      const { seeks } = audioWithGenerated(900);
      // Held back while the guide is up, Space included.
      expect(media.play).not.toHaveBeenCalled();
      fireEvent.keyDown(window, { key: " ", code: "Space" });
      expect(media.play).not.toHaveBeenCalled();
      // 标记 comes first (PRD F2), then 重听 and 下一句 with their keys.
      expect(within(dialog).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
        "标记没听懂就按，句子会留到拾起M",
        "重听回到这句开头再听一遍←",
        "下一句→",
        "耳机按两下 下一句 · 按三下 重听（因设备而异）",
      ]);

      fireEvent.click(within(dialog).getByRole("button", { name: "开始听" }));

      expect(screen.queryByRole("dialog")).toBeNull();
      expect(seeks).toEqual([612.5]);
      expect(media.play).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/me/play-guide", { method: "PUT" }));
    });

    it("starts playback from the guide even when opened paused (a reload)", async () => {
      const fetchMock = serve([listened]);
      fetchMock.mockImplementation(withGuideRoute(fetchMock.getMockImplementation()!));
      renderPage({ guideSeen: false });
      fireEvent.click(await screen.findByRole("button", { name: "开始听" }));

      const { seeks } = audioWithGenerated(900);

      expect(seeks).toEqual([612.5]);
      expect(media.play).toHaveBeenCalledTimes(1);
    });

    it("takes the guide along when the user leaves the page before 【开始听】", async () => {
      serve([listened]);
      const view = renderPage({ guideSeen: false });
      await screen.findByRole("dialog", { name: "没听懂？按一下" });

      view.rerender(
        <PlayGuideProvider seen={false}>
          <ListeningProvider>
            <p>书架</p>
          </ListeningProvider>
        </PlayGuideProvider>,
      );

      expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("does not show the guide again once seen", async () => {
      window.history.pushState(null, "", "/books/b1/listen?autoplay");
      serve([listened]);
      renderPage({ guideSeen: true });
      await screen.findByRole("button", { name: "播放" });
      audioWithGenerated(900);

      expect(screen.queryByRole("dialog")).toBeNull();
      expect(media.play).toHaveBeenCalledTimes(1);
    });

    it("gives way to a Chapter picked to listen to", async () => {
      window.history.pushState(null, "", "/books/b1/listen?chapter=c2&autoplay");
      serve([listened]);
      renderPage();
      await screen.findByRole("button", { name: "播放" });

      const { seeks } = audioWithGenerated(900);

      expect(seeks).toEqual([600]);
    });
  });

  describe("opened at a Chapter (from the Chapter list)", () => {
    it("says how long a Chapter that is not generated yet takes, then plays it from its start by itself (AC-BOOK-03)", async () => {
      window.history.pushState(null, "", "/books/b1/listen?chapter=c2");
      serve([generating, secondPlayable]);
      renderPage();

      expect((await screen.findByRole("status")).textContent).toBe("该章节生成中，预计约 40 秒");
      const { seeks } = audioWithGenerated(600);
      expect(media.play).not.toHaveBeenCalled();

      // The next poll (every 1.5 seconds while the user waits) places Chapter 2; the playlist then grows.
      await vi.waitFor(() => expect(screen.queryByRole("status")).toBeNull(), { timeout: 4000 });
      grow(610);
      await vi.waitFor(() => expect(media.play).toHaveBeenCalledTimes(1));
      expect(seeks.at(-1)).toBe(600);
      // Done: a reload does not jump to the Chapter again.
      expect(window.location.search).toBe("");
    });

    it("plays a generated Chapter from its start at once", async () => {
      window.history.pushState(null, "", "/books/b1/listen?chapter=c2");
      serve([secondPlayable]);
      renderPage();
      await screen.findByRole("button", { name: "播放" });

      const { seeks } = audioWithGenerated(900);

      expect(seeks).toEqual([600]);
      expect(media.play).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("status")).toBeNull();
    });

    it("says how long the Chapter takes while the Book has no audio at all yet", async () => {
      window.history.pushState(null, "", "/books/b1/listen?chapter=c2");
      serve([{ ...generating, playable: false }]);
      renderPage();
      expect(await screen.findByText("该章节生成中，预计约 40 秒")).toBeTruthy();
    });

    it("stops waiting for the Chapter once the user plays something else", async () => {
      window.history.pushState(null, "", "/books/b1/listen?chapter=c3");
      serve([generating]);
      renderPage();
      await screen.findByRole("status");
      await act(async () => {}); // the page has asked the session for the Chapter

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
      serve([retrying, inserted]);
      renderPage();
      fireEvent.click(await screen.findByRole("button", { name: "播放" }));
      const { el } = audioWithGenerated(700);
      Object.defineProperty(el, "currentTime", { value: 612, configurable: true });
      act(() => el.dispatchEvent(new Event("timeupdate")));
      expect(hlsInstances).toHaveLength(1);

      // Polls every 5 seconds while a retried Chapter generates in a 已就绪 Book.
      await vi.waitFor(() => expect(hlsInstances).toHaveLength(2), { timeout: 7000 });
      const reloaded = audioWithGenerated(1000);
      expect(reloaded.el).not.toBe(el);
      expect(reloaded.seeks).toEqual([912]);
      expect(media.play).toHaveBeenCalledTimes(2);
    }, 10_000);

    it("plays the retried Chapter the user waits for from its start in the new playlist (AC-BOOK-03, AC-BOOK-04)", async () => {
      window.history.pushState(null, "", "/books/b1/listen?chapter=c2");
      serve([retrying, inserted]);
      renderPage();
      expect((await screen.findByRole("status")).textContent).toBe("该章节生成中，预计约 30 秒");
      const old = audioWithGenerated(700);

      await vi.waitFor(() => expect(hlsInstances).toHaveLength(2), { timeout: 4000 });
      expect(old.seeks).toEqual([]);
      const reloaded = audioWithGenerated(1000);
      expect(reloaded.seeks).toEqual([600]);
      expect(media.play).toHaveBeenCalledTimes(1);
    });
  });

  it("asks for a tap when the browser does not let the Chapter start on its own", async () => {
    media.play.mockImplementationOnce(() => Promise.reject(new DOMException("autoplay", "NotAllowedError")));
    window.history.pushState(null, "", "/books/b1/listen?chapter=c2");
    serve([secondPlayable]);
    renderPage();
    await screen.findByRole("button", { name: "播放" });

    audioWithGenerated(900);

    expect((await screen.findByRole("status")).textContent).toBe("已可以收听，点播放开始");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says the Chapter being generated is awaited when playback catches up with it", async () => {
    serve([secondPlayable]);
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "播放" }));
    const { el } = audioWithGenerated(640);
    Object.defineProperty(el, "currentTime", { value: 640, configurable: true });

    act(() => el.dispatchEvent(new Event("waiting")));

    expect(screen.getByRole("status").textContent).toBe("该章节生成中，生成后自动播放");
  });

  it("says how long the next Chapter takes when playback catches up with the generated audio", async () => {
    serve([generating]);
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "播放" }));
    const { el } = audioWithGenerated(600);
    Object.defineProperty(el, "currentTime", { value: 600, configurable: true });

    act(() => el.dispatchEvent(new Event("waiting")));
    expect(screen.getByRole("status").textContent).toBe("该章节生成中，预计约 40 秒");

    act(() => el.dispatchEvent(new Event("playing")));
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("ListenPage reading view (F7, F9)", () => {
  /** A finished Book: Chapter 1 (0 to 10 s), a Skipped imprint, Chapter 2 (from 10 s), one that failed. */
  const finished: BookDetail = {
    ...book,
    status: "ready",
    durationMs: 20_000,
    chapters: [
      chapter("c1", 0, { title: "Chapter I", audioStatus: "generated", startMs: 0, sentenceCount: 3 }),
      chapter("imprint", 1, { title: "Imprint", skipped: true, sentenceCount: 1 }),
      chapter("c2", 2, { title: "Chapter II", audioStatus: "generated", startMs: 10_000, sentenceCount: 2 }),
      chapter("c3", 3, { title: "Chapter III", audioStatus: "failed", sentenceCount: 1 }),
    ],
  };
  const sentences = {
    c1: [
      sentence("s1", 0, "It is a truth universally acknowledged.", 0, 3_700),
      sentence("s2", 0, "However little known the feelings may be.", 4_000, 6_700),
      sentence("s3", 1, "My dear Mr. Bennet, said his lady.", 7_000, 9_700),
    ],
    imprint: [sentence("i1", 0, "Printed in London.", null)],
    c2: [sentence("t1", 0, "Mr. Bennet was among the earliest.", 10_000), sentence("t2", 0, "He had always intended.", 15_000)],
  };

  const directory = () => screen.getByRole("navigation", { name: "章节目录" });
  const playingSentence = () => document.querySelector("[aria-current='true'][data-sentence-id]")?.textContent;
  const column = () => (document.querySelector(".reading") as HTMLElement).style.getPropertyValue("--column");

  async function openFinished() {
    serve([finished], sentences);
    renderPage();
    await screen.findByText("It is a truth universally acknowledged.");
  }

  it("lists every Chapter, tagging the Skipped and failed ones, and shows the text by Sentence and paragraph", async () => {
    await openFinished();

    const items = within(directory()).getAllByRole("button").map((b) => b.textContent);
    expect(items).toEqual(["Chapter I", "Imprint未朗读", "Chapter II", "Chapter III生成失败"]);
    const first = screen.getByRole("region", { name: "Chapter I" });
    expect([...first.querySelectorAll("p")].map((p) => p.textContent)).toEqual([
      "It is a truth universally acknowledged. However little known the feelings may be.",
      "My dear Mr. Bennet, said his lady.",
    ]);
    // A Skipped Chapter can be read, tagged at its title (G5).
    expect(await screen.findByText("Printed in London.")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Imprint" })).getByText("未朗读")).toBeTruthy();
  });

  it("highlights the Sentence being read and keeps it in view as playback moves (AC-READ-01)", async () => {
    await openFinished();
    fireEvent.click(screen.getByRole("button", { name: "播放" }));
    scrollTo.mockClear();

    timeUpdate(5);
    expect(playingSentence()).toBe("However little known the feelings may be.");
    expect(scrollTo).toHaveBeenCalled();
    expect(within(directory()).getByRole("button", { current: true }).textContent).toBe("Chapter I");

    timeUpdate(12);
    await vi.waitFor(() => expect(playingSentence()).toBe("Mr. Bennet was among the earliest."));
    expect(within(directory()).getByRole("button", { current: true }).textContent).toBe("Chapter II");
  });

  it("stops following when the user scrolls, and 【回到播放处】 follows again (AC-READ-02, AC-READ-03)", async () => {
    await openFinished();
    timeUpdate(1);
    expect(screen.queryByRole("button", { name: "回到播放处" })).toBeNull();

    fireEvent.wheel(document.querySelector(".reading-scroll")!);
    scrollTo.mockClear();
    timeUpdate(5);

    expect(playingSentence()).toBe("However little known the feelings may be.");
    expect(scrollTo).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "回到播放处" }));
    expect(scrollTo).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "回到播放处" })).toBeNull();
  });

  it("plays a Chapter picked in the directory from its start", async () => {
    await openFinished();
    const { seeks } = audioWithGenerated(20);

    fireEvent.click(within(directory()).getByRole("button", { name: "Chapter II" }));

    expect(seeks).toEqual([10]);
    expect(media.play).toHaveBeenCalledTimes(1);
  });

  it("shows a Skipped Chapter picked in the directory without playing it", async () => {
    await openFinished();
    audioWithGenerated(20);
    scrollTo.mockClear();

    fireEvent.click(within(directory()).getByRole("button", { name: /Imprint/ }));

    expect(scrollTo).toHaveBeenCalled();
    expect(media.play).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "回到播放处" })).toBeTruthy();
  });

  it("opens and closes the directory from the Chapter title, widening the column (F7)", async () => {
    await openFinished();
    const title = screen.getByRole("button", { name: "Chapter I" , expanded: true });
    expect(column()).toBe("720px");

    fireEvent.click(title);

    expect(screen.queryByRole("navigation", { name: "章节目录" })).toBeNull();
    expect(screen.getByRole("link", { name: "返回书架" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Chapter I", expanded: false })).toBeTruthy();
    expect(column()).toBe("760px");
  });

  it("keeps 句子精读 collapsed until opened (AC-READ-14)", async () => {
    await openFinished();
    expect(screen.queryByRole("complementary", { name: "句子精读" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "展开句子精读" }));

    expect(screen.getByRole("complementary", { name: "句子精读" })).toBeTruthy();
    expect(column()).toBe("620px");
    fireEvent.click(screen.getByRole("button", { name: "收起句子精读" }));
    expect(column()).toBe("720px");
  });

  describe("selecting a Sentence (句子精读)", () => {
    const panel = () => screen.getByRole("complementary", { name: "句子精读" });
    const selectedText = () => document.querySelector(".sentence.is-selected")?.textContent ?? null;
    const SECOND = "However little known the feelings may be.";

    async function selectSecond() {
      await act(async () => fireEvent.click(screen.getByText(SECOND)));
    }

    it("selects a Sentence without a Card and opens 句子精读 on it (AC-READ-15)", async () => {
      await openFinished();

      await selectSecond();

      expect(selectedText()).toBe(SECOND);
      expect(within(panel()).getByText(SECOND)).toBeTruthy();
      expect(within(panel()).getByRole("button", { name: "AI 解析" })).toBeTruthy();
      expect(column()).toBe("620px");
      // Only a look: playback is untouched (PRD 4.4.5 点击规则 #4).
      expect(media.play).not.toHaveBeenCalled();
    });

    it("deselects on blank text and with Esc, keeping the panel open", async () => {
      await openFinished();
      await selectSecond();

      fireEvent.click(document.querySelector(".reading-content")!);
      expect(selectedText()).toBeNull();
      expect(within(panel()).getByText("选择一句正文")).toBeTruthy();

      await selectSecond();
      fireEvent.keyDown(document.body, { key: "Escape" });
      expect(selectedText()).toBeNull();
    });

    it("keeps the selection when the panel is collapsed and opened again", async () => {
      await openFinished();
      await selectSecond();

      fireEvent.click(screen.getByRole("button", { name: "收起句子精读" }));
      expect(selectedText()).toBe(SECOND);
      fireEvent.click(screen.getByRole("button", { name: "展开句子精读" }));
      expect(within(panel()).getByText(SECOND)).toBeTruthy();
    });

    it("plays from the selected Sentence's start with 【从这里播放】 beside it (AC-PLAY-15)", async () => {
      await openFinished();
      const { seeks } = audioWithGenerated(20);
      expect(screen.queryByRole("button", { name: "从这里播放" })).toBeNull();
      await selectSecond();

      fireEvent.click(screen.getByRole("button", { name: "从这里播放" }));

      expect(seeks).toEqual([4]);
      expect(media.play).toHaveBeenCalledTimes(1);
    });

    it("scrolls the text back to the Sentence with 【定位原文】, playback untouched (AC-PANEL-12)", async () => {
      await openFinished();
      const { seeks } = audioWithGenerated(20);
      seeks.push(1);
      await selectSecond();
      fireEvent.wheel(document.querySelector(".reading-scroll")!);
      scrollTo.mockClear();

      fireEvent.click(within(panel()).getByRole("button", { name: "定位原文" }));

      expect(scrollTo).toHaveBeenCalled();
      expect(seeks.at(-1)).toBe(1);
      expect(media.play).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "回到播放处" })).toBeTruthy();
    });

    it("plays only the selected Sentence with 【试听本句】, interrupting playback (AC-PLAY-12)", async () => {
      await openFinished();
      audioWithGenerated(20);
      fireEvent.click(screen.getByRole("button", { name: "播放" }));
      await selectSecond();

      fireEvent.click(within(panel()).getByRole("button", { name: "试听本句" }));

      expect(audio().paused).toBe(true);
      const audition = hlsInstances.at(-1)!;
      expect(audition.media).toBe(document.querySelectorAll("audio")[1]);
      expect(audition.config).toMatchObject({ startPosition: 4 });
      expect(within(panel()).getByRole("button", { name: "试听本句" }).getAttribute("aria-busy")).toBe("true");
    });

    it("stops a 试听 when another Sentence is selected", async () => {
      await openFinished();
      audioWithGenerated(20);
      await selectSecond();
      fireEvent.click(within(panel()).getByRole("button", { name: "试听本句" }));
      const audition = hlsInstances.at(-1)!;

      await act(async () => fireEvent.click(screen.getByText("My dear Mr. Bennet, said his lady.")));

      expect(audition.destroyed).toBe(true);
      expect(within(panel()).getByRole("button", { name: "试听本句" }).getAttribute("aria-busy")).toBe("false");
    });
  });

  it("loads only the Chapters near the reading position of a long Book (AC-READ-05)", async () => {
    const long: BookDetail = {
      ...finished,
      chapters: Array.from({ length: 60 }, (_, i) =>
        chapter(`k${i}`, i, { title: `Part ${i}`, audioStatus: "generated", startMs: i * 60_000, sentenceCount: 40 }),
      ),
    };
    const fetchMock = serve([long], { k0: [sentence("k0s", 0, "The first line.", 0)] });
    renderPage();
    await screen.findByText("The first line.");

    const loaded = fetchMock.mock.calls.map(([url]) => url).filter((url) => url.includes("/sentences"));
    expect(loaded.sort()).toEqual(["/api/chapters/k0/sentences", "/api/chapters/k1/sentences"]);
    // The rest wait as placeholders of about their height.
    expect(document.querySelectorAll("[data-rendered='false']").length).toBeGreaterThanOrEqual(58);
  });
});

describe("ListenPage controls (#9)", () => {
  it("plays and pauses with Space, and moves by Sentence with ← and →", async () => {
    serve([book], {
      c1: [sentence("s1", 0, "It is a truth.", 0), sentence("s2", 0, "However little known.", 4000), sentence("s3", 1, "My dear.", 8000)],
    });
    renderPage();
    await screen.findByRole("button", { name: "播放" });
    const { seeks } = audioWithGenerated(600);

    fireEvent.keyDown(document.body, { key: " " });
    expect(media.play).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document.body, { key: " " });
    expect(media.pause).toHaveBeenCalledTimes(1);

    seeks.push(5);
    await act(async () => {
      fireEvent.keyDown(document.body, { key: "ArrowRight" });
    });
    expect(seeks.at(-1)).toBe(8);
    seeks.push(10);
    await act(async () => {
      fireEvent.keyDown(document.body, { key: "ArrowLeft" });
    });
    expect(seeks.at(-1)).toBe(8);
  });

  it("says how long it takes when the bar is dragged past the generated audio", async () => {
    serve([generating]);
    renderPage();
    const bar = await screen.findByRole("slider", { name: "整本进度" });
    audioWithGenerated(600);
    bar.getBoundingClientRect = () => ({ left: 0, width: 1000 }) as DOMRect;

    fireEvent.pointerDown(bar, { clientX: 500, pointerId: 1 });
    fireEvent.pointerUp(bar, { clientX: 500, pointerId: 1 });

    expect((await screen.findByRole("status")).textContent).toBe("该章节生成中，预计约 40 秒");
  });
});
