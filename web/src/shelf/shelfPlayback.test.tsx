import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Book, BookDetail } from "../api";
import { App } from "../App";
import { audioWithGenerated, hlsInstances, stubMediaPlayback } from "../test-media";

vi.mock("hls.js", async () => ({ default: (await import("../test-media")).FakeHls }));

// Playing from the Shelf without leaving it: 【继续收听】's play button and 播放 on a cover start the Book at its last
// Sentence or pause it, and every control shows the one listening session (the sidebar's 当前收听 too).

let media: ReturnType<typeof stubMediaPlayback>;
beforeEach(() => {
  hlsInstances.length = 0;
  media = stubMediaPlayback();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  window.history.pushState(null, "", "/");
});

const pride: BookDetail = {
  id: "b1",
  title: "Pride and Prejudice",
  source: "upload",
  voice: "us_female",
  voiceChange: null,
  voiceChangeable: true,
  author: "Jane Austen",
  status: "ready",
  playable: true,
  failureReason: null,
  coverUrl: null,
  listening: { sentenceId: "s9", chapterTitle: "Chapter 2", share: 0.6, startMs: 612_500, listenedAt: "2026-11-18T00:00:00.000Z" },
  progress: { generated: 2, narrated: 2 },
  createdAt: "2026-11-18T00:00:00.000Z",
  chapters: [
    { id: "c1", index: 0, title: "Chapter 1", skipped: false, audioStatus: "generated", sentenceCount: 10, durationMs: 600_000, startMs: 0, waitSeconds: null },
    { id: "c2", index: 1, title: "Chapter 2", skipped: false, audioStatus: "generated", sentenceCount: 10, durationMs: 600_000, startMs: 600_000, waitSeconds: null },
  ],
  durationMs: 1_200_000,
};

function serve() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/api/me") return Response.json({ id: "u1", email: "allen@vocaleaf.app", playGuideSeen: true });
      if (url === "/api/books") {
        const { chapters: _c, durationMs: _d, ...shelfBook } = pride;
        return Response.json([shelfBook satisfies Book]);
      }
      if (url === "/api/books/b1") return Response.json(pride);
      if (url.endsWith("/listening")) return new Response(null, { status: 204 });
      if (url.endsWith("/timeline")) {
        const chapters = [
          { id: "c1", startMs: 0, endMs: 600_000 },
          { id: "c2", startMs: 600_000, endMs: 1_200_000 },
        ];
        return Response.json({ sentenceStartsMs: [0, 612_500, 900_000], chapters, complete: true });
      }
      return Response.json([]);
    }),
  );
}

const card = () => screen.findByRole("region", { name: "继续收听" });
const grid = () => screen.getByRole("list", { name: "书架上的书" });

describe("playing from the Shelf", () => {
  it("starts the Book at its last Sentence from 【继续收听】 and stays on the Shelf", async () => {
    serve();
    render(<App />);

    fireEvent.click(within(await card()).getByRole("button", { name: "继续收听 Pride and Prejudice" }));
    await vi.waitFor(() => expect(hlsInstances).toHaveLength(1));
    const { seeks } = audioWithGenerated(1_200);

    await vi.waitFor(() => expect(seeks).toEqual([612.5]));
    expect(media.play).toHaveBeenCalledTimes(1);
    expect(window.location.pathname).toBe("/");
    const now = await screen.findByRole("region", { name: "当前收听" });
    expect(within(now).getByText("正在播放")).toBeTruthy();
  });

  it("shows the one session everywhere: pausing in one place shows paused in all", async () => {
    serve();
    render(<App />);
    fireEvent.click(within(await card()).getByRole("button", { name: "继续收听 Pride and Prejudice" }));
    await vi.waitFor(() => expect(hlsInstances).toHaveLength(1));
    audioWithGenerated(1_200);
    await vi.waitFor(() => expect(media.play).toHaveBeenCalledTimes(1));

    // Playing: the card, the cover in the grid and the sidebar all offer to pause.
    expect(within(await card()).getByRole("button", { name: "暂停 Pride and Prejudice" })).toBeTruthy();
    expect(within(grid()).getByRole("button", { name: "暂停 Pride and Prejudice" })).toBeTruthy();

    // Paused from the sidebar: the Shelf follows.
    const now = await screen.findByRole("region", { name: "当前收听" });
    fireEvent.click(within(now).getByRole("button", { name: "暂停" }));
    expect(media.pause).toHaveBeenCalledTimes(1);
    expect(within(await card()).getByRole("button", { name: "继续收听 Pride and Prejudice" })).toBeTruthy();
    expect(within(grid()).getByRole("button", { name: "播放 Pride and Prejudice" })).toBeTruthy();

    // Played on from the grid's cover, where it was, without leaving the Shelf.
    fireEvent.click(within(grid()).getByRole("button", { name: "播放 Pride and Prejudice" }));
    await vi.waitFor(() => expect(media.play).toHaveBeenCalledTimes(2));
    expect(within(now).getByText("正在播放")).toBeTruthy();
    expect(window.location.pathname).toBe("/");

    // Paused from the card.
    fireEvent.click(within(await card()).getByRole("button", { name: "暂停 Pride and Prejudice" }));
    expect(media.pause).toHaveBeenCalledTimes(2);
    expect(within(now).getByText("已暂停")).toBeTruthy();
    await act(async () => {});
  });
});
