import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BookDetail } from "../api";
import { ListenPage } from "./ListenPage";

vi.mock("hls.js", () => ({
  default: class {
    static isSupported = () => true;
    static Events = { ERROR: "hlsError" };
    on() {}
    loadSource() {}
    attachMedia() {}
    destroy() {}
  },
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const book: BookDetail = {
  id: "b1",
  title: "Pride and Prejudice",
  author: "Jane Austen",
  status: "generating",
  playable: true,
  failureReason: null,
  createdAt: "2026-11-18T00:00:00.000Z",
  chapters: [],
  durationMs: 41_752_000,
};

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
});
