// The 拾起 page (#13, PRD 4.4.4, F10) inside the app: the list, filtering by Book, 从这里播放, 定位原文, Dismiss with
// its confirmation, and the navigation's count.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Gleaning } from "../api";
import { App } from "../App";
import { audioWithGenerated, hlsInstances, stubMediaPlayback } from "../test-media";

vi.mock("hls.js", async () => ({ default: (await import("../test-media")).FakeHls }));

const gleaning = (sentenceId: string, text: string, book: [string, string], startMs: number | null): Gleaning => ({
  sentenceId,
  text,
  bookId: book[0],
  bookTitle: book[1],
  chapterId: `${book[0]}-c1`,
  chapterTitle: "Chapter 1",
  startMs,
  markedAt: "2026-11-18T00:00:00.000Z",
});

const PRIDE: [string, string] = ["b1", "Pride and Prejudice"];
const WALDEN: [string, string] = ["b2", "Walden"];

let items: Gleaning[];
let count: number | null;
let dismissed: string[];
let media: ReturnType<typeof stubMediaPlayback>;

beforeEach(() => {
  hlsInstances.length = 0;
  media = stubMediaPlayback();
  items = [
    gleaning("s3", "I went to the woods because I wished to live deliberately.", WALDEN, 64_000),
    gleaning("s2", "But it is, returned she.", PRIDE, 4_000),
    gleaning("s1", "It is a truth universally acknowledged.", PRIDE, null),
  ];
  count = null;
  dismissed = [];
  window.history.pushState(null, "", "/gleanings");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/me") return Response.json({ id: "u1", email: "allen@vocaleaf.app" });
      if (url === "/api/gleanings") return Response.json(items);
      if (url === "/api/gleanings/count") return Response.json({ count: count ?? items.length });
      const dismiss = /^\/api\/sentences\/([^/]+)\/mark\/dismiss$/.exec(url)?.[1];
      if (dismiss && init?.method === "POST") {
        dismissed.push(dismiss);
        items = items.filter((g) => g.sentenceId !== dismiss);
        return new Response(null, { status: 204 });
      }
      if (url.endsWith("/timeline")) return Response.json({ sentenceStartsMs: [], sentenceIds: [], chapters: [], complete: true });
      // The 专注页 that 定位原文 opens never loads here.
      return new Promise<Response>(() => {});
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.pushState(null, "", "/");
});

const list = () => screen.getByRole("list", { name: "拾起列表" });
const texts = () => within(list()).getAllByRole("listitem").map((li) => li.querySelector(".gleaning-text")!.textContent);
const badge = () => screen.getByRole("link", { name: /拾起/ }).querySelector(".side-badge")?.textContent ?? null;

async function openPage() {
  render(<App />);
  await screen.findByText("I went to the woods because I wished to live deliberately.");
}

describe("拾起 (F10)", () => {
  it("lists pending Marks newest first with their Book and Chapter, counted in the navigation (AC-GLEAN-01)", async () => {
    await openPage();

    expect(texts()).toEqual([
      "I went to the woods because I wished to live deliberately.",
      "But it is, returned she.",
      "It is a truth universally acknowledged.",
    ]);
    expect(within(list()).getAllByText("Pride and Prejudice · Chapter 1")).toHaveLength(2);
    expect(screen.getByRole("heading", { name: /拾起/ }).textContent).toBe("拾起3");
    await vi.waitFor(() => expect(badge()).toBe("3"));
    expect(screen.getByRole("link", { name: /拾起/ }).getAttribute("aria-current")).toBe("page");
  });

  it("shows 99+ in the navigation above 99", async () => {
    count = 120;
    await openPage();
    await vi.waitFor(() => expect(badge()).toBe("99+"));
  });

  it("filters by Book (AC-GLEAN-05)", async () => {
    await openPage();

    fireEvent.click(screen.getByRole("button", { name: "Pride and Prejudice" }));
    expect(texts()).toEqual(["But it is, returned she.", "It is a truth universally acknowledged."]);

    fireEvent.click(screen.getByRole("button", { name: "全部" }));
    expect(texts()).toHaveLength(3);
  });

  it("keeps the item when the user cancels the confirmation (AC-GLEAN-06)", async () => {
    await openPage();
    await vi.waitFor(() => expect(badge()).toBe("3"));

    fireEvent.click(within(list()).getAllByRole("button", { name: "忽略" })[1]!);
    const dialog = screen.getByRole("alertdialog", { name: "忽略这一句？" });
    expect(dialog.textContent).toContain("不会制作卡片，句子将从拾起移除");
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));

    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(texts()).toHaveLength(3);
    expect(dismissed).toEqual([]);
    expect(badge()).toBe("3");
  });

  it("dismisses an item with × once confirmed: it leaves the list and the count drops (AC-GLEAN-03)", async () => {
    await openPage();
    await vi.waitFor(() => expect(badge()).toBe("3"));

    fireEvent.click(within(list()).getAllByRole("button", { name: "忽略" })[1]!);
    await act(async () => {
      fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "忽略" }));
    });

    expect(dismissed).toEqual(["s2"]);
    expect(texts()).toEqual([
      "I went to the woods because I wished to live deliberately.",
      "It is a truth universally acknowledged.",
    ]);
    await vi.waitFor(() => expect(badge()).toBe("2"));
  });

  it("shows the picked Sentence on the right, which stays after 忽略这一句", async () => {
    await openPage();
    fireEvent.click(screen.getByText("But it is, returned she."));
    const panel = screen.getByRole("complementary", { name: "句子精读" });
    expect(within(panel).getByText("But it is, returned she.")).toBeTruthy();

    fireEvent.click(within(panel).getByRole("button", { name: "忽略这一句" }));
    await act(async () => {
      fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "忽略" }));
    });

    expect(dismissed).toEqual(["s2"]);
    expect(texts()).toHaveLength(2);
    expect(within(panel).getByText("But it is, returned she.")).toBeTruthy();
    expect(within(panel).queryByRole("button", { name: "忽略这一句" })).toBeNull();
  });

  it("plays from the picked Sentence, switching the session to its Book and staying on the page", async () => {
    await openPage();
    fireEvent.click(screen.getByText("I went to the woods because I wished to live deliberately."));

    fireEvent.click(within(list()).getByRole("button", { name: "从这里播放" }));
    expect(hlsInstances.at(-1)?.source).toBe("/api/books/b2/audio.m3u8");
    const { seeks } = audioWithGenerated(600);

    expect(seeks).toEqual([64]);
    expect(media.play).toHaveBeenCalled();
    expect(window.location.pathname).toBe("/gleanings");
  });

  it("offers 从这里播放 only once the Sentence has audio", async () => {
    await openPage();
    fireEvent.click(screen.getByText("It is a truth universally acknowledged."));
    expect(within(list()).getByRole("button", { name: "从这里播放" })).toBeDisabled();
  });

  it("opens the 专注页 at the Sentence with 定位原文", async () => {
    await openPage();
    fireEvent.click(screen.getByText("But it is, returned she."));

    fireEvent.click(screen.getByRole("button", { name: "定位原文" }));

    expect(window.location.pathname).toBe("/books/b1/listen");
    expect(window.location.search).toBe("?locate=s2&locateChapter=b1-c1");
  });

  it("says everything is picked up when nothing waits", async () => {
    items = [];
    render(<App />);
    expect(await screen.findByText("都拾起来了。听书时点标记，句子会出现在这里")).toBeTruthy();
  });
});
