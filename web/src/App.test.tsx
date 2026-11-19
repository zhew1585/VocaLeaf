import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UNAUTHORIZED_EVENT, type Book, type BookDetail } from "./api";
import { App } from "./App";
import { hlsInstances, stubMediaPlayback } from "./test-media";

vi.mock("hls.js", async () => ({ default: (await import("./test-media")).FakeHls }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.pushState(null, "", "/");
});

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
        url === "/api/me" ? Response.json({ id: "u1", email: "allen@vocaleaf.app" }) : Response.json([]),
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
      if (url === "/api/me") return Response.json({ id: "u1", email: "allen@vocaleaf.app" });
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
      title: "Pride and Prejudice",
      author: "Jane Austen",
      status: "ready",
      playable: true,
      failureReason: null,
      coverUrl: null,
      listening: null,
      voice: "us_female",
      voiceChange: null,
      voiceChangeable: true,
      progress: { generated: 1, narrated: 1 },
      createdAt: "2026-11-18T00:00:00.000Z",
      chapters: [],
      durationMs: 600_000,
    };
    window.history.pushState(null, "", "/books/b1/listen");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/me") return Response.json({ id: "u1", email: "allen@vocaleaf.app" });
        if (url === "/api/books/b1") return Response.json(book);
        if (url === "/api/auth/logout") return new Response(null, { status: 204 });
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
        if (url === "/api/me") return Response.json({ id: "u1", email: "allen@vocaleaf.app" });
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
});
