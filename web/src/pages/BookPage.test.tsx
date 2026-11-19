import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BookDetail } from "../api";
import { BookPage } from "./BookPage";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

type Chapter = BookDetail["chapters"][number];
const chapter = (id: string, index: number, title: string, rest: Partial<Chapter> = {}): Chapter => ({
  id,
  index,
  title,
  skipped: false,
  audioStatus: "pending",
  sentenceCount: 10,
  durationMs: null,
  startMs: null,
  waitSeconds: null,
  ...rest,
});

const book: BookDetail = {
  id: "b1",
  title: "Pride and Prejudice",
  author: "Jane Austen",
  status: "generating",
  playable: false,
  failureReason: null,
  coverUrl: null,
  listening: null,
  progress: { generated: 0, narrated: 2 },
  createdAt: "2026-11-18T00:00:00.000Z",
  chapters: [chapter("c0", 0, "Titlepage", { sentenceCount: 3 }), chapter("c1", 1, "I", { sentenceCount: 42 })],
  durationMs: null,
};

/** Design 04-2's example: one Chapter in each state. */
const generating: BookDetail = {
  ...book,
  playable: true,
  progress: { generated: 3, narrated: 6 },
  chapters: [
    chapter("t", 0, "Titlepage", { skipped: true }),
    chapter("c1", 1, "Chapter One", { audioStatus: "generated", durationMs: 58 * 60_000, startMs: 0 }),
    chapter("c4", 2, "Chapter Four", { audioStatus: "generating", startMs: 3_480_000 }),
    chapter("c5", 3, "Chapter Five", { audioStatus: "failed" }),
    chapter("c6", 4, "Chapter Six", { waitSeconds: 300 }),
  ],
};

/** Each row's title and the state on its right. */
function rows() {
  return screen.getAllByRole("listitem").map((li) => li.textContent);
}

/** Answers GET /api/books/b1 with each of `books` in turn (the last one from then on) and records every call. */
function stubApi(books: BookDetail[], onPost: (url: string) => Response = () => new Response(null, { status: 204 })) {
  const queue = [...books];
  const calls: { url: string; method: string }[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    if (method === "POST") return onPost(url);
    return Response.json(queue.length > 1 ? queue.shift() : queue[0]);
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

describe("BookPage", () => {
  it("shows the Book and every Chapter with its state (design 04-2)", async () => {
    stubApi([generating]);
    render(<BookPage id="b1" />);

    expect(await screen.findByRole("heading", { name: "Pride and Prejudice" })).toBeTruthy();
    expect(screen.getByText("Jane Austen")).toBeTruthy();
    expect(rows()).toEqual([
      "Titlepage未朗读",
      "Chapter One58 分钟",
      "Chapter Four生成中",
      "Chapter Five生成失败重试",
      "Chapter Six等待生成",
    ]);
  });

  it("shows 生成中 with generated / narrated Chapters, and keeps it current as Chapters finish (AC-SHELF-02)", async () => {
    // Not playable yet, so the page checks every 1.5 seconds.
    const waiting = { ...generating, playable: false };
    stubApi([waiting, { ...waiting, progress: { generated: 4, narrated: 6 } }]);
    render(<BookPage id="b1" />);

    expect((await screen.findByLabelText("生成进度")).textContent).toBe("3 / 6");
    expect(screen.getByText("生成中", { selector: ".status" })).toBeTruthy();
    await vi.waitFor(() => expect(screen.getByLabelText("生成进度").textContent).toBe("4 / 6"), { timeout: 4000 });
  });

  it("retries a 生成失败 Chapter and shows it waiting again (AC-BOOK-04)", async () => {
    const retried = {
      ...generating,
      chapters: generating.chapters.map((c) => (c.id === "c5" ? { ...c, audioStatus: "pending" as const } : c)),
    };
    const calls = stubApi([generating, retried]);
    render(<BookPage id="b1" />);

    fireEvent.click(await screen.findByRole("button", { name: "重试 Chapter Five" }));

    await vi.waitFor(() => expect(rows()[3]).toBe("Chapter Five等待生成"));
    expect(calls.filter((c) => c.method === "POST").map((c) => c.url)).toEqual(["/api/chapters/c5/retry"]);
    expect(screen.queryByRole("button", { name: /^重试/ })).toBeNull();
  });

  it("says so when a retry is refused, and keeps the button", async () => {
    stubApi([generating], () => Response.json({ error: { code: "internal", message: "服务器出错了，请稍后再试" } }, { status: 500 }));
    render(<BookPage id="b1" />);

    fireEvent.click(await screen.findByRole("button", { name: "重试 Chapter Five" }));

    expect((await screen.findByRole("alert")).textContent).toBe("服务器出错了，请稍后再试");
    expect(screen.getByRole("button", { name: "重试 Chapter Five" })).toBeEnabled();
  });

  it("opens the 专注页 at a Chapter when its title is clicked, generated or not; Skipped and failed ones are not links", async () => {
    stubApi([generating]);
    render(<BookPage id="b1" />);

    fireEvent.click(await screen.findByRole("button", { name: "Chapter Six" }));
    expect(window.location.pathname + window.location.search).toBe("/books/b1/listen?chapter=c6");
    window.history.pushState(null, "", "/");

    expect(screen.queryByRole("button", { name: "Titlepage" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Chapter Five" })).toBeNull();
    expect(within(screen.getAllByRole("listitem")[1]!).getByRole("button", { name: "Chapter One" })).toBeTruthy();
  });

  it("shows 解析中 while the worker is still parsing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...book, status: "parsing", chapters: [] })));
    render(<BookPage id="b1" />);
    expect(await screen.findByText("解析中")).toBeTruthy();
  });

  it("shows 解析失败 with its reason", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ ...book, status: "parse_failed", failureReason: "解析超时，请删除后重新上传", chapters: [] }),
      ),
    );
    render(<BookPage id="b1" />);
    expect(await screen.findByText("解析失败")).toBeTruthy();
    expect(screen.getByText("解析超时，请删除后重新上传")).toBeTruthy();
  });

  it("offers 开始收听 only once the Book is playable, and it opens the 专注页", async () => {
    const responses = [book, { ...book, playable: true }];
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(responses.shift() ?? { ...book, playable: true })));
    render(<BookPage id="b1" />);

    expect(await screen.findByRole("button", { name: "开始收听" })).toBeDisabled();
    await vi.waitFor(() => expect(screen.getByRole("button", { name: "开始收听" })).toBeEnabled(), { timeout: 5000 });

    fireEvent.click(screen.getByRole("button", { name: "开始收听" }));
    expect(window.location.pathname).toBe("/books/b1/listen");
    window.history.pushState(null, "", "/");
  });

  it("shows 已就绪 once every narrated Chapter is generated", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...book, status: "ready", playable: true })));
    render(<BookPage id="b1" />);
    expect(await screen.findByText("已就绪")).toBeTruthy();
    expect(screen.getByRole("button", { name: "开始收听" })).toBeEnabled();
  });
});
