import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UNAUTHORIZED_EVENT, type BookDetail } from "./api";
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

  it("shows the app with the account when logged in, and goes back to login when a request answers 401", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ id: "u1", email: "allen@vocaleaf.app" })));
    render(<App />);
    expect(await screen.findByText("allen@vocaleaf.app")).toBeTruthy();
    expect(screen.getByText("上传书籍")).toBeTruthy();

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
    expect(await screen.findByText("上传书籍")).toBeTruthy();
    expect(media.pause).not.toHaveBeenCalled();
    expect(hlsInstances.map((h) => h.destroyed)).toEqual([false]);

    fireEvent.click(screen.getByRole("button", { name: "退出登录" }));
    await screen.findByRole("button", { name: "发送验证码" });
    expect(hlsInstances.map((h) => h.destroyed)).toEqual([true]);
  });
});
