import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Book, BookDetail } from "../api";
import { App } from "../App";
import { audio, audioWithGenerated, hlsInstances, stubMediaPlayback, timeUpdate } from "../test-media";

vi.mock("hls.js", async () => ({ default: (await import("../test-media")).FakeHls }));

// The sidebar's 当前收听 entry (PRD 4.4.1 收听会话 #5, design 05-1 「侧栏 · 当前收听」) and the session coming back
// after a reload, driven through the whole app.

let media: ReturnType<typeof stubMediaPlayback>;
beforeEach(() => {
  hlsInstances.length = 0;
  media = stubMediaPlayback();
  // jsdom does not scroll; the 专注页's reading view asks it to.
  Element.prototype.scrollTo = vi.fn() as never;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.pushState(null, "", "/");
});

const chapter = (id: string, index: number, startMs: number): BookDetail["chapters"][number] => ({
  id,
  index,
  title: `Chapter ${index + 1}`,
  skipped: false,
  audioStatus: "generated",
  sentenceCount: 10,
  durationMs: 600_000,
  startMs,
  waitSeconds: null,
});

const pride: BookDetail = {
  id: "b1",
  title: "Pride and Prejudice",
  author: "Jane Austen",
  status: "ready",
  playable: true,
  failureReason: null,
  coverUrl: "/api/books/b1/cover",
  listening: { sentenceId: "s9", chapterTitle: "Chapter 2", share: 0.6, startMs: 612_500, listenedAt: "2026-11-18T00:00:00.000Z" },
  progress: { generated: 2, narrated: 2 },
  createdAt: "2026-11-18T00:00:00.000Z",
  chapters: [chapter("c1", 0, 0), chapter("c2", 1, 600_000)],
  durationMs: 1_200_000,
};

/** The app's API: the user, the Shelf, Book b1 as `book()` answers, progress reports. Returns the fetch mock. */
function serve(book: () => BookDetail = () => pride) {
  const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url === "/api/me") return Response.json({ id: "u1", email: "allen@vocaleaf.app" });
    if (url === "/api/books") {
      const { chapters: _c, durationMs: _d, ...shelfBook } = book();
      return Response.json([shelfBook satisfies Book]);
    }
    if (url === "/api/books/b1") return Response.json(book());
    if (url.endsWith("/listening") || url === "/api/auth/logout") return new Response(null, { status: 204 });
    if (url.endsWith("/timeline")) {
      const chapters = [
        { id: "c1", startMs: 0, endMs: 600_000 },
        { id: "c2", startMs: 600_000, endMs: 1_200_000 },
      ];
      return Response.json({ sentenceStartsMs: [0, 612_500, 900_000], chapters, complete: true });
    }
    return Response.json([]);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const entry = () => screen.findByRole("region", { name: "当前收听" });

/** Opens the Book's 专注页, plays it to 10:12 and goes back to the Shelf. */
async function listenThenGoBack() {
  window.history.pushState(null, "", "/books/b1/listen");
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "播放" }));
  timeUpdate(612);
  fireEvent.click(screen.getByRole("link", { name: "返回书架" }));
}

describe("the sidebar's 当前收听 entry", () => {
  it("has no entry before any Book is listened to", async () => {
    serve();
    render(<App />);
    await screen.findByText("allen@vocaleaf.app");
    await act(async () => {});
    expect(screen.queryByRole("region", { name: "当前收听" })).toBeNull();
  });

  it("shows the Book, 正在播放 and its Chapter once the user goes back to the Shelf while it plays (AC-PLAY-09)", async () => {
    serve();
    await listenThenGoBack();

    const now = await entry();
    expect(within(now).getByText("Pride and Prejudice")).toBeTruthy();
    expect(within(now).getByText("正在播放")).toBeTruthy();
    expect(within(now).getByText("· Chapter 2")).toBeTruthy();
    expect(now.querySelector("img")?.getAttribute("src")).toBe("/api/books/b1/cover");
    expect(media.pause).not.toHaveBeenCalled();
  });

  it("pauses and plays on from the cover without leaving the page (AC-PLAY-11)", async () => {
    serve();
    await listenThenGoBack();
    const now = await entry();

    fireEvent.click(within(now).getByRole("button", { name: "暂停" }));
    expect(media.pause).toHaveBeenCalledTimes(1);
    expect(within(now).getByText("已暂停")).toBeTruthy();
    expect(window.location.pathname).toBe("/");

    fireEvent.click(within(now).getByRole("button", { name: "继续播放" }));
    expect(within(now).getByText("正在播放")).toBeTruthy();
    expect(window.location.pathname).toBe("/");
  });

  it("goes back to the 专注页 with the position and play state as they were (AC-PLAY-10)", async () => {
    serve();
    await listenThenGoBack();

    fireEvent.click(within(await entry()).getByRole("link", { name: /Pride and Prejudice/ }));

    expect(window.location.pathname).toBe("/books/b1/listen");
    expect(await screen.findByRole("button", { name: "暂停" })).toBeTruthy();
    expect(audio().currentTime).toBe(612);
    expect(media.play).toHaveBeenCalledTimes(1);
    expect(hlsInstances).toHaveLength(1);
  });

  it("syncs, then forgets the session on logging out, so the next login starts without one (G16)", async () => {
    const fetchMock = serve();
    await listenThenGoBack();
    await entry();

    fireEvent.click(screen.getByRole("button", { name: "退出登录" }));
    await screen.findByRole("button", { name: "发送验证码" });

    expect(localStorage.getItem("vocaleaf:listening-book")).toBeNull();
    // Synced while the login still holds.
    const calls = fetchMock.mock.calls.map(([url, init]) => `${url} ${init?.body ?? ""}`);
    const synced = calls.indexOf('/api/books/b1/listening {"positionMs":612000}');
    expect(synced).toBeGreaterThan(-1);
    expect(synced).toBeLessThan(calls.indexOf("/api/auth/logout "));
  });
});

describe("after a reload", () => {
  it("comes back paused at the last synced Sentence, with the entry saying 已暂停", async () => {
    localStorage.setItem("vocaleaf:listening-book", "b1");
    serve();
    render(<App />);

    const now = await entry();
    expect(within(now).getByText("已暂停")).toBeTruthy();
    const { seeks } = audioWithGenerated(1_200);
    expect(seeks).toEqual([612.5]);
    // The seek moves the position as the browser then reports it.
    act(() => audio().dispatchEvent(new Event("timeupdate")));
    expect(within(now).getByText("· Chapter 2")).toBeTruthy();
    expect(media.play).not.toHaveBeenCalled();
  });

  it("plays from where another device paused when the Book is opened from the Shelf (AC-PLAY-05)", async () => {
    localStorage.setItem("vocaleaf:listening-book", "b1");
    // This device synced Chapter 2 earlier; another device then paused at 15:00.
    let listening = pride.listening!;
    serve(() => ({ ...pride, listening }));
    render(<App />);
    await entry();
    const { seeks } = audioWithGenerated(1_200);
    expect(seeks).toEqual([612.5]);

    listening = { ...listening, sentenceId: "s20", startMs: 900_000 };
    fireEvent.click(await screen.findByRole("button", { name: /继续收听/ }));

    await vi.waitFor(() => expect(seeks).toEqual([612.5, 900]));
    expect(media.play).toHaveBeenCalledTimes(1);
  });
});
