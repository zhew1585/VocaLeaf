// The settings page (#18, PRD F15) inside the app: reached from the sidebar's account entry, it shows the account,
// today's AI calls left and the uploads held (AC-SET-01), reopens the first-play guide, lists the shortcuts and logs
// this device out (AC-SET-02).
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BookDetail, Usage } from "../api";
import { App } from "../App";
import { hlsInstances, stubMediaPlayback } from "../test-media";

vi.mock("hls.js", async () => ({ default: (await import("../test-media")).FakeHls }));

const me = { id: "u1", email: "allen@vocaleaf.app", playGuideSeen: true };

let usage: Usage | "fails";
let fetchMock: ReturnType<typeof vi.fn>;

function stubApi(extra: (url: string, init?: RequestInit) => Response | undefined = () => undefined) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const answer = extra(url, init);
    if (answer) return answer;
    if (url === "/api/me") return Response.json(me);
    if (url === "/api/me/usage") {
      return usage === "fails"
        ? Response.json({ error: { code: "internal", message: "服务器出错了，请稍后再试" } }, { status: 500 })
        : Response.json(usage);
    }
    if (url === "/api/auth/logout") return new Response(null, { status: 204 });
    if (url === "/api/me/play-guide") return new Response(null, { status: 204 });
    if (url === "/api/gleanings/count") return Response.json({ count: 0 });
    return Response.json([]);
  });
  vi.stubGlobal("fetch", fetchMock);
}

beforeEach(() => {
  usage = { aiRemaining: 95, aiDailyLimit: 100, uploadedBooks: 3, maxUploadedBooks: 20 };
  window.history.pushState(null, "", "/settings");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.pushState(null, "", "/");
});

const meter = (name: string) => screen.getByRole("meter", { name });

describe("设置页", () => {
  it("opens from the sidebar's account entry, which marks it as the current page", async () => {
    window.history.pushState(null, "", "/");
    stubApi();
    render(<App />);

    fireEvent.click(await screen.findByRole("link", { name: "设置" }));

    expect(window.location.pathname).toBe("/settings");
    expect(await screen.findByRole("heading", { name: "设置", level: 1 })).toBeTruthy();
    expect(screen.getByRole("link", { name: "设置" }).getAttribute("aria-current")).toBe("page");
    // 退出登录 lives on the settings page now, not in the sidebar.
    expect(within(screen.getByRole("complementary")).queryByRole("button", { name: "退出登录" })).toBeNull();
  });

  it("shows the account email (AC-SET-01)", async () => {
    stubApi();
    render(<App />);
    const main = await screen.findByRole("main");
    expect(await within(main).findByText("allen@vocaleaf.app")).toBeTruthy();
    expect(within(main).getByText("内测用户")).toBeTruthy();
  });

  it("shows 95 AI calls left of 100 and 3 of 20 uploads (AC-SET-01)", async () => {
    stubApi();
    render(<App />);
    await screen.findByText("95");

    const ai = meter("今日剩余解析");
    expect(ai.textContent).toContain("95");
    expect(ai.textContent).toContain("/ 100");
    expect(ai.getAttribute("aria-valuetext")).toBe("剩余 95 次");
    const uploads = meter("上传书籍");
    expect(uploads.textContent).toContain("3");
    expect(uploads.textContent).toContain("/ 20");
    expect(uploads.getAttribute("aria-valuetext")).toBe("3 / 20");
    expect(fetchMock).toHaveBeenCalledWith("/api/me/usage", undefined);
  });

  it("says so when the quotas cannot be loaded, and the rest of the page still works", async () => {
    usage = "fails";
    stubApi();
    render(<App />);

    expect((await screen.findByRole("alert")).textContent).toBe("服务器出错了，请稍后再试");
    expect(screen.getByRole("button", { name: "操作说明" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "退出登录" })).toBeTruthy();
  });

  it("reopens the first-play guide from 【操作说明】; 【开始听】 closes it without recording anything again", async () => {
    stubApi();
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "操作说明" }));
    const dialog = screen.getByRole("dialog", { name: "没听懂？按一下" });
    fireEvent.click(within(dialog).getByRole("button", { name: "开始听" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(window.location.pathname).toBe("/settings");
    expect(fetchMock).not.toHaveBeenCalledWith("/api/me/play-guide", expect.anything());
  });

  it("lists the playing and the review shortcuts", async () => {
    stubApi();
    render(<App />);
    const list = await screen.findByRole("list", { name: "快捷键" });

    const rows = within(list)
      .getAllByRole("listitem")
      .map((li) => [li.querySelector(".shortcut-name")!.textContent, [...li.querySelectorAll("kbd")].map((k) => k.textContent)]);
    expect(rows).toEqual([
      ["播放 / 暂停", ["空格"]],
      ["重听", ["←"]],
      ["下一句", ["→"]],
      ["标记", ["M"]],
      ["显示答案", ["空格"]],
      ["评分", ["1", "2", "3", "4"]],
    ]);
  });

  it("logs this device out and returns to the login page at / (AC-SET-02)", async () => {
    stubApi();
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "退出登录" }));

    expect(await screen.findByRole("button", { name: "发送验证码" })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/logout", { method: "POST" });
    expect(window.location.pathname).toBe("/");
  });

  it("stays logged in when logging out fails, so the button can be pressed again", async () => {
    stubApi((url) => (url === "/api/auth/logout" ? Response.json({ error: { code: "x", message: "x" } }, { status: 500 }) : undefined));
    render(<App />);
    const button = await screen.findByRole("button", { name: "退出登录" });

    fireEvent.click(button);

    await vi.waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByRole("heading", { name: "设置", level: 1 })).toBeTruthy();
  });

  it("ends the listening session on logging out", async () => {
    stubMediaPlayback();
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
      voice: "us_female",
      voiceChange: null,
      voiceChangeable: true,
      progress: { generated: 1, narrated: 1 },
      createdAt: "2026-11-18T00:00:00.000Z",
      chapters: [],
      durationMs: 600_000,
    };
    window.history.pushState(null, "", "/books/b1/listen");
    stubApi((url) => {
      if (url === "/api/books/b1") return Response.json(book);
      if (url.endsWith("/timeline")) return Response.json({ sentenceStartsMs: [], chapters: [], complete: true });
      return undefined;
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "播放" }));
    fireEvent.click(screen.getByRole("link", { name: "返回书架" }));
    fireEvent.click(await screen.findByRole("link", { name: "设置" }));
    expect(hlsInstances.map((h) => h.destroyed)).toEqual([false]);

    fireEvent.click(await screen.findByRole("button", { name: "退出登录" }));

    await screen.findByRole("button", { name: "发送验证码" });
    expect(hlsInstances.map((h) => h.destroyed)).toEqual([true]);
  });
});
