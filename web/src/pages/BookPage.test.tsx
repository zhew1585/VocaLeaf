import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BOOK_DELETED_EVENT, type BookDetail } from "../api";
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
  voice: "us_female",
  voiceChange: null,
  voiceChangeable: true,
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

/**
 * Answers GET /api/books/b1 with each of `books` in turn (the last one from then on), any other method with
 * `onPost`, and records every call.
 */
function stubApi(books: BookDetail[], onPost: (url: string) => Response = () => new Response(null, { status: 204 })) {
  const queue = [...books];
  const calls: { url: string; method: string }[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    if (method !== "GET") return onPost(url);
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

  describe("删除这本书 (#8, PRD 4.3.6)", () => {
    const CONFIRM = "删除后音频、标记和解析将被清除，已做的卡片会保留";

    it.each([
      ["解析中", { ...book, status: "parsing" as const, chapters: [] }],
      ["生成中", generating],
      ["解析失败", { ...book, status: "parse_failed" as const, failureReason: "文件无法读取，可能已损坏", chapters: [] }],
      ["已就绪", { ...book, status: "ready" as const, playable: true }],
    ])("is offered for a %s Book", async (_, detail) => {
      stubApi([detail]);
      render(<BookPage id="b1" />);
      expect(await screen.findByRole("button", { name: "删除这本书" })).toBeEnabled();
    });

    it("asks first, and 取消 keeps the Book", async () => {
      const calls = stubApi([generating]);
      render(<BookPage id="b1" />);

      fireEvent.click(await screen.findByRole("button", { name: "删除这本书" }));
      const dialog = screen.getByRole("alertdialog", { name: "删除这本书？" });
      expect(within(dialog).getByText(CONFIRM)).toBeTruthy();

      fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
      expect(screen.queryByRole("alertdialog")).toBeNull();
      expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
    });

    it("closes the question with Escape", async () => {
      stubApi([generating]);
      render(<BookPage id="b1" />);
      fireEvent.click(await screen.findByRole("button", { name: "删除这本书" }));

      fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });

    it("deletes the Book once confirmed, ends its listening session and goes back to the start page", async () => {
      window.history.pushState(null, "", "/books/b1");
      const calls = stubApi([generating]);
      const deleted: unknown[] = [];
      const onDeleted = (e: Event) => deleted.push((e as CustomEvent).detail);
      window.addEventListener(BOOK_DELETED_EVENT, onDeleted);
      render(<BookPage id="b1" />);

      fireEvent.click(await screen.findByRole("button", { name: "删除这本书" }));
      fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "删除" }));

      await vi.waitFor(() => expect(window.location.pathname).toBe("/"));
      expect(calls.filter((c) => c.method !== "GET")).toEqual([{ url: "/api/books/b1", method: "DELETE" }]);
      expect(deleted).toEqual(["b1"]);
      window.removeEventListener(BOOK_DELETED_EVENT, onDeleted);
    });

    it("takes a Book already deleted elsewhere (404) as deleted", async () => {
      window.history.pushState(null, "", "/books/b1");
      stubApi([generating], () => Response.json({ error: { code: "not_found", message: "书不存在" } }, { status: 404 }));
      const deleted: unknown[] = [];
      const onDeleted = (e: Event) => deleted.push((e as CustomEvent).detail);
      window.addEventListener(BOOK_DELETED_EVENT, onDeleted);
      render(<BookPage id="b1" />);

      fireEvent.click(await screen.findByRole("button", { name: "删除这本书" }));
      fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "删除" }));

      await vi.waitFor(() => expect(window.location.pathname).toBe("/"));
      expect(deleted).toEqual(["b1"]);
      window.removeEventListener(BOOK_DELETED_EVENT, onDeleted);
    });

    it("says so when the deletion fails, and keeps the question open to try again", async () => {
      window.history.pushState(null, "", "/books/b1");
      stubApi([generating], () => Response.json({ error: { code: "internal", message: "服务器出错了，请稍后再试" } }, { status: 500 }));
      render(<BookPage id="b1" />);

      fireEvent.click(await screen.findByRole("button", { name: "删除这本书" }));
      const dialog = screen.getByRole("alertdialog");
      fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));

      expect((await within(dialog).findByRole("alert")).textContent).toBe("服务器出错了，请稍后再试");
      expect(within(dialog).getByRole("button", { name: "删除" })).toBeEnabled();
      expect(window.location.pathname).toBe("/books/b1");
      window.history.pushState(null, "", "/");
    });
  });

  describe("the Book's Voice (design 04-2, PRD 4.2.4, F5 更换音色)", () => {
    const finished: BookDetail = {
      ...generating,
      status: "ready",
      progress: { generated: 3, narrated: 3 },
      chapters: [chapter("c1", 0, "Chapter One", { audioStatus: "generated", durationMs: 600_000, startMs: 0 })],
    };
    const changing: BookDetail = { ...finished, voiceChange: { to: "uk_female", status: "running" } };
    const voiceButton = () => screen.getByRole("button", { name: /^音色：/ });

    it("changes the Voice from its menu, then says the old one plays until the new audio is complete", async () => {
      const calls: { url: string; body: unknown }[] = [];
      const queue = [finished, changing];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
          if (init?.method === "POST") {
            calls.push({ url, body: JSON.parse(init.body as string) });
            return new Response(null, { status: 202 });
          }
          return Response.json(queue.length > 1 ? queue.shift() : queue[0]);
        }),
      );
      render(<BookPage id="b1" />);

      fireEvent.click(await screen.findByRole("button", { name: "音色：美音女声" }));
      const menu = screen.getByRole("menu", { name: "更换音色" });
      expect(within(menu).getAllByRole("menuitemradio").map((o) => [o.textContent, o.getAttribute("aria-checked")])).toEqual([
        ["美音女声", "true"],
        ["美音男声", "false"],
        ["英音女声", "false"],
        ["英音男声", "false"],
      ]);
      fireEvent.click(within(menu).getByRole("menuitemradio", { name: "英音女声" }));

      expect((await screen.findByRole("status")).textContent).toBe("正在更换为 英音女声，完成前仍使用原音色");
      expect(calls).toEqual([{ url: "/api/books/b1/voice", body: { voice: "uk_female" } }]);
      // Still the old Voice, and no second change until this one is done.
      expect(voiceButton().textContent).toBe("美音女声");
      expect(voiceButton()).toBeDisabled();
      expect(screen.queryByRole("menu")).toBeNull();
    });

    it("shows the new Voice once the change is complete, checking while it runs", async () => {
      stubApi([changing, { ...finished, voice: "uk_female" }]);
      render(<BookPage id="b1" />);

      expect((await screen.findByRole("status")).textContent).toBe("正在更换为 英音女声，完成前仍使用原音色");
      await vi.waitFor(() => expect(voiceButton().textContent).toBe("英音女声"), { timeout: 7000 });
      expect(screen.queryByRole("status")).toBeNull();
      expect(voiceButton()).toBeEnabled();
    }, 10_000);

    it("says the old Voice was kept when the change failed (PRD 4.3.5 #11)", async () => {
      stubApi([{ ...finished, voiceChange: { to: "uk_female", status: "failed" } }]);
      render(<BookPage id="b1" />);

      expect(await screen.findByText("音色更换失败，已保留原音色")).toBeTruthy();
      expect(voiceButton().textContent).toBe("美音女声");
      expect(voiceButton()).toBeEnabled();
    });

    it("says why a change was refused", async () => {
      stubApi([finished], () => Response.json({ error: { code: "voice_change_running", message: "正在更换音色，完成前不能再次更换" } }, { status: 409 }));
      render(<BookPage id="b1" />);

      fireEvent.click(await screen.findByRole("button", { name: "音色：美音女声" }));
      fireEvent.click(screen.getByRole("menuitemradio", { name: "美音男声" }));
      expect((await screen.findByRole("alert")).textContent).toBe("正在更换音色，完成前不能再次更换");
    });

    it("cannot be changed before the Book is 已就绪, and is not offered for a Library Book", async () => {
      stubApi([generating]);
      const { unmount } = render(<BookPage id="b1" />);
      expect((await screen.findByRole("button", { name: "音色：美音女声" })).getAttribute("title")).toBe(
        "这本书生成完成后才能更换音色",
      );
      expect(voiceButton()).toBeDisabled();
      unmount();

      // A 已就绪 Book with a retried Chapter still generating.
      stubApi([{ ...finished, chapters: [{ ...finished.chapters[0]!, audioStatus: "pending" }] }]);
      const retrying = render(<BookPage id="b1" />);
      expect(await screen.findByRole("button", { name: "音色：美音女声" })).toBeDisabled();
      retrying.unmount();

      stubApi([{ ...finished, voiceChangeable: false }]);
      render(<BookPage id="b1" />);
      await screen.findByRole("button", { name: /开始收听/ });
      expect(screen.queryByRole("button", { name: /^音色：/ })).toBeNull();
    });
  });
});
