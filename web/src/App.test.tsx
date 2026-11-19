import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UNAUTHORIZED_EVENT, type Book, type BookDetail, type LibraryBook } from "./api";
import { App } from "./App";
import { audioWithGenerated, hlsInstances, stubMediaPlayback } from "./test-media";

vi.mock("hls.js", async () => ({ default: (await import("./test-media")).FakeHls }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.pushState(null, "", "/");
});

/** The logged-in user of these tests, who has played before (the first-play guide is tested on its own). */
const me = { id: "u1", email: "allen@vocaleaf.app", playGuideSeen: true };

const unauthenticated = () => Response.json({ error: { code: "unauthenticated", message: "请先登录" } }, { status: 401 });

describe("App", () => {
  it("shows the login page when this device has no session", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => unauthenticated()));
    render(<App />);
    expect(await screen.findByRole("button", { name: "发送验证码" })).toBeTruthy();
  });

  it("shows the Shelf with the account when logged in, and goes back to login when a request answers 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url === "/api/me" ? Response.json(me) : Response.json([]),
      ),
    );
    render(<App />);
    expect(await screen.findByText("allen@vocaleaf.app")).toBeTruthy();
    expect(await screen.findByText("书架还空着")).toBeTruthy();

    act(() => {
      window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    });
    expect(screen.getByRole("button", { name: "发送验证码" })).toBeTruthy();
  });

  it("logs this device out and returns to the login page at / (AC-SET-02)", async () => {
    window.history.pushState(null, "", "/books/b1");
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/api/me") return Response.json(me);
      if (url === "/api/auth/logout") return new Response(null, { status: 204 });
      return new Promise<Response>(() => {}); // the Book page's load never answers here
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "退出登录" }));

    expect(await screen.findByRole("button", { name: "发送验证码" })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/logout", { method: "POST" });
    expect(window.location.pathname).toBe("/");
  });

  it("keeps playing when the user goes back to the shelf from the 专注页, and stops on logging out", async () => {
    const media = stubMediaPlayback();
    hlsInstances.length = 0;
    const book: BookDetail = {
      id: "b1",
      source: "upload",
      title: "Pride and Prejudice",
      author: "Jane Austen",
      status: "ready",
      playable: true,
      failureReason: null,
      coverUrl: null,
      listening: null,
      progress: { generated: 1, narrated: 1 },
      createdAt: "2026-11-18T00:00:00.000Z",
      chapters: [],
      durationMs: 600_000,
    };
    window.history.pushState(null, "", "/books/b1/listen");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/me") return Response.json(me);
        if (url === "/api/books/b1") return Response.json(book);
        if (url === "/api/auth/logout") return new Response(null, { status: 204 });
        if (url.endsWith("/timeline")) return Response.json({ sentenceStartsMs: [], chapters: [], complete: true });
        return Response.json([]);
      }),
    );
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "播放" }));

    fireEvent.click(screen.getByRole("link", { name: "返回书架" }));

    expect(window.location.pathname).toBe("/");
    expect(await screen.findByText("书架还空着")).toBeTruthy();
    expect(media.pause).not.toHaveBeenCalled();
    expect(hlsInstances.map((h) => h.destroyed)).toEqual([false]);

    fireEvent.click(screen.getByRole("button", { name: "退出登录" }));
    await screen.findByRole("button", { name: "发送验证码" });
    expect(hlsInstances.map((h) => h.destroyed)).toEqual([true]);
  });

  describe("deleting a Book from its detail (#8)", () => {
    const shelfBook = (id: string, title: string, rest: Partial<Book>): Book => ({
      id,
      title,
      author: null,
      source: "upload",
      status: "ready",
      playable: true,
      failureReason: null,
      progress: { generated: 0, narrated: 0 },
      coverUrl: null,
      listening: null,
      createdAt: "2026-11-18T00:00:00.000Z",
      ...rest,
    });

    it.each([
      ["解析中", { status: "parsing", playable: false } as const],
      ["生成中", { status: "generating", playable: false, progress: { generated: 0, narrated: 3 } } as const],
    ])("opens a %s Book from the Shelf, deletes it and is back on the Shelf without it", async (label, state) => {
      const doomed = shelfBook("b1", "Emma", state);
      const kept = shelfBook("b2", "Persuasion", {});
      let deleted = false;
      const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/me") return Response.json(me);
        if (url === "/api/books") return Response.json(deleted ? [kept] : [doomed, kept]);
        if (url === "/api/books/b1" && init?.method === "DELETE") {
          deleted = true;
          return new Response(null, { status: 204 });
        }
        if (url === "/api/books/b1") return Response.json({ ...doomed, chapters: [], durationMs: null });
        return Response.json({});
      });
      vi.stubGlobal("fetch", fetchMock);
      render(<App />);

      // The default cover repeats the title, so the title shows twice in the Book's link.
      fireEvent.click((await screen.findAllByText("Emma"))[0]!);
      expect(window.location.pathname).toBe("/books/b1");
      expect(await screen.findByText(label, { selector: ".status" })).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: "删除这本书" }));
      fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "删除" }));

      expect((await screen.findAllByText("Persuasion")).length).toBeGreaterThan(0);
      expect(window.location.pathname).toBe("/");
      expect(screen.queryAllByText("Emma")).toEqual([]);
      expect(fetchMock).toHaveBeenCalledWith("/api/books/b1", { method: "DELETE" });
    });
  });
  describe("from the 书库 to the first play (F6, F2)", () => {
    const libraryBook = (id: string, title: string, rest: Partial<LibraryBook> = {}): LibraryBook => ({
      id,
      title,
      author: "An Author",
      difficulty: "beginner",
      blurb: `${title} 的简介`,
      coverUrl: null,
      onShelf: false,
      ...rest,
    });
    const detail: BookDetail = {
      id: "oz",
      title: "The Wonderful Wizard of Oz",
      author: "L. Frank Baum",
      source: "library",
      status: "ready",
      playable: true,
      failureReason: null,
      coverUrl: null,
      listening: null,
      progress: { generated: 1, narrated: 1 },
      createdAt: "2026-11-18T00:00:00.000Z",
      chapters: [],
      durationMs: 600_000,
    };

    it("adds a Library Book to the Shelf and plays it after the first-play guide (AC-LIB-01, AC-GUIDE-02)", async () => {
      const media = stubMediaPlayback();
      const calls: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
          calls.push(`${init?.method ?? "GET"} ${url}`);
          if (url === "/api/me") return Response.json({ ...me, playGuideSeen: false });
          if (url === "/api/library") return Response.json([libraryBook("oz", "The Wonderful Wizard of Oz")]);
          if (url === "/api/books/oz/shelf" || url === "/api/me/play-guide") return new Response(null, { status: 204 });
          if (url === "/api/books/oz") return Response.json(detail);
          if (url.endsWith("/timeline")) return Response.json({ sentenceStartsMs: [], chapters: [], complete: true });
          return Response.json([]);
        }),
      );
      window.history.pushState(null, "", "/library");
      render(<App />);

      fireEvent.click(await screen.findByRole("button", { name: "加入书架并播放 The Wonderful Wizard of Oz" }));

      const dialog = await screen.findByRole("dialog", { name: "没听懂？按一下" });
      expect(window.location.pathname).toBe("/books/oz/listen");
      expect(calls).toContain("PUT /api/books/oz/shelf");
      const { seeks } = audioWithGenerated(600);
      expect(media.play).not.toHaveBeenCalled();

      fireEvent.click(within(dialog).getByRole("button", { name: "开始听" }));

      expect(seeks).toEqual([0]);
      expect(media.play).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(calls).toContain("PUT /api/me/play-guide"));

      // Shown once: the next Book opened plays without it.
      fireEvent.click(screen.getByRole("link", { name: "返回书架" }));
      window.history.pushState(null, "", "/library");
      act(() => {
        window.dispatchEvent(new PopStateEvent("popstate"));
      });
      fireEvent.click(await screen.findByRole("button", { name: "加入书架并播放 The Wonderful Wizard of Oz" }));
      await screen.findByRole("button", { name: /暂停|播放/ });
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("takes a Library Book off the Shelf from its detail, without deleting it (PRD 4.2.3, AC-LIB-03)", async () => {
      const calls: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
          calls.push(`${init?.method ?? "GET"} ${url}`);
          if (url === "/api/me") return Response.json(me);
          if (url === "/api/books/oz/shelf") return new Response(null, { status: 204 });
          if (url === "/api/books/oz") {
            return Response.json({
              ...detail,
              chapters: [
                {
                  id: "c1",
                  index: 0,
                  title: "Chapter 1",
                  skipped: false,
                  audioStatus: "failed",
                  sentenceCount: 3,
                  durationMs: null,
                  startMs: null,
                  waitSeconds: null,
                },
              ],
            });
          }
          return Response.json([]);
        }),
      );
      window.history.pushState(null, "", "/books/oz");
      render(<App />);

      fireEvent.click(await screen.findByRole("button", { name: "移出书架" }));
      // A shared Book offers no retry (nor, later, Voice or Skipped controls).
      expect(screen.queryByRole("button", { name: /重试/ })).toBeNull();
      expect(screen.queryByRole("button", { name: "删除这本书" })).toBeNull();
      const confirm = screen.getByRole("alertdialog", { name: "移出书架？" });
      expect(within(confirm).getByText("移出后收听进度、标记和解析将被清除，已做的卡片会保留")).toBeTruthy();
      fireEvent.click(within(confirm).getByRole("button", { name: "移出" }));

      await waitFor(() => expect(window.location.pathname).toBe("/"));
      expect(calls).toContain("DELETE /api/books/oz/shelf");
      expect(calls).not.toContain("DELETE /api/books/oz");
    });
  });
});
