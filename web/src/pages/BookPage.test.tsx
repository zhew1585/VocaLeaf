import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BOOK_DELETED_EVENT, type BookDetail } from "../api";
import { layoutOf } from "../player/layout";
import { ListeningProvider, useListening, type Listening } from "../player/session";
import { audioWithGenerated, hlsInstances, stubMediaPlayback } from "../test-media";
import { BookPage } from "./BookPage";

vi.mock("hls.js", async () => ({ default: (await import("../test-media")).FakeHls }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The page inside the listening session, as the app has it; `session` gets the live session. */
function renderPage(session?: { current: Listening | null }) {
  function Probe() {
    const listening = useListening();
    if (session) session.current = listening;
    return null;
  }
  return render(
    <ListeningProvider>
      <Probe />
      <BookPage id="b1" />
    </ListeningProvider>,
  );
}

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
  source: "upload",
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

/**
 * Answers GET /api/books/b1 with each of `books` in turn (the last one from then on), any other method with
 * `onPost`, and records every call.
 */
function stubApi(books: BookDetail[], onPost: (url: string) => Response = () => new Response(null, { status: 204 })) {
  const queue = [...books];
  let last = queue[0]!;
  const calls: { url: string; method: string; body?: unknown }[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body });
    if (url.endsWith("/timeline")) {
      return Response.json({ sentenceStartsMs: [], chapters: layoutOf(last), complete: true, settled: true });
    }
    if (method !== "GET") return onPost(url);
    last = (queue.length > 1 ? queue.shift() : queue[0])!;
    return Response.json(last);
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

describe("BookPage", () => {
  it("shows the Book and every Chapter with its state (design 04-2)", async () => {
    stubApi([generating]);
    renderPage();

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
    renderPage();

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
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "重试 Chapter Five" }));

    await vi.waitFor(() => expect(rows()[3]).toBe("Chapter Five等待生成"));
    expect(calls.filter((c) => c.method === "POST").map((c) => c.url)).toEqual(["/api/chapters/c5/retry"]);
    expect(screen.queryByRole("button", { name: /^重试/ })).toBeNull();
  });

  it("says so when a retry is refused, and keeps the button", async () => {
    stubApi([generating], () => Response.json({ error: { code: "internal", message: "服务器出错了，请稍后再试" } }, { status: 500 }));
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "重试 Chapter Five" }));

    expect((await screen.findByRole("alert")).textContent).toBe("服务器出错了，请稍后再试");
    expect(screen.getByRole("button", { name: "重试 Chapter Five" })).toBeEnabled();
  });

  describe("turning a Chapter's narration on and off (PRD 4.2.5, design 04-2)", () => {
    const switchOf = (title: string) => screen.getByRole("switch", { name: `朗读 ${title}` });

    it("shows a switch on every Chapter, on for narrated ones and off for Skipped ones", async () => {
      stubApi([generating]);
      renderPage();
      await screen.findByRole("heading", { name: "Pride and Prejudice" });

      expect(screen.getAllByRole("switch").map((s) => [s.getAttribute("aria-label"), s.getAttribute("aria-checked")])).toEqual([
        ["朗读 Titlepage", "false"],
        ["朗读 Chapter One", "true"],
        ["朗读 Chapter Four", "true"],
        ["朗读 Chapter Five", "true"],
        ["朗读 Chapter Six", "true"],
      ]);
    });

    it("hides the switches for a Library Book (AC-LIB-03)", async () => {
      stubApi([{ ...generating, source: "library" as never }]);
      renderPage();
      await screen.findByRole("heading", { name: "Pride and Prejudice" });
      expect(screen.queryByRole("switch")).toBeNull();
    });

    it("narrates a Skipped Chapter: it waits to be generated (AC-BOOK-01)", async () => {
      const narrated = {
        ...generating,
        chapters: generating.chapters.map((c) => (c.id === "t" ? { ...c, skipped: false } : c)),
      };
      const calls = stubApi([generating, narrated]);
      renderPage();
      await screen.findByRole("heading", { name: "Pride and Prejudice" });

      fireEvent.click(switchOf("Titlepage"));

      await vi.waitFor(() => expect(rows()[0]).toBe("Titlepage等待生成"));
      expect(switchOf("Titlepage").getAttribute("aria-checked")).toBe("true");
      expect(calls.filter((c) => c.method === "PUT").map((c) => [c.url, c.body])).toEqual([
        ["/api/chapters/t/skipped", JSON.stringify({ skipped: false })],
      ]);
    });

    it("says so when the change is refused, and leaves the switch as it was", async () => {
      stubApi([generating], () => Response.json({ error: { code: "internal", message: "服务器出错了，请稍后再试" } }, { status: 500 }));
      renderPage();
      await screen.findByRole("heading", { name: "Pride and Prejudice" });

      fireEvent.click(switchOf("Chapter One"));

      expect((await screen.findByRole("alert")).textContent).toBe("服务器出错了，请稍后再试");
      expect(switchOf("Chapter One").getAttribute("aria-checked")).toBe("true");
      expect(switchOf("Chapter One")).toBeEnabled();
    });

    it("moves playback to the start of the next narrated Chapter when the playing one is set Skipped (AC-BOOK-02)", async () => {
      const media = stubMediaPlayback();
      hlsInstances.length = 0;
      // Chapter One (58 minutes) and Chapter Four play; Chapter Four is set Skipped while it plays.
      const ready: BookDetail = {
        ...generating,
        status: "ready",
        chapters: [
          generating.chapters[0]!,
          generating.chapters[1]!,
          { ...generating.chapters[2]!, audioStatus: "generated", durationMs: 600_000 },
          { ...generating.chapters[4]!, audioStatus: "generated", durationMs: 600_000, startMs: 4_080_000, waitSeconds: null },
        ],
      };
      const fourSkipped: BookDetail = {
        ...ready,
        chapters: [
          ready.chapters[0]!,
          ready.chapters[1]!,
          { ...ready.chapters[2]!, skipped: true, startMs: null },
          { ...ready.chapters[3]!, startMs: 3_480_000 },
        ],
      };
      stubApi([ready, fourSkipped]);
      const session: { current: Listening | null } = { current: null };
      renderPage(session);
      await screen.findByRole("heading", { name: "Pride and Prejudice" });
      // The session holds the Book, playing 2 minutes into Chapter Four.
      act(() => session.current!.open("b1"));
      act(() => session.current!.follow(ready));
      audioWithGenerated(4_680).seeks.push(3_600);
      act(() => session.current!.toggle());

      fireEvent.click(switchOf("Chapter Four"));

      await vi.waitFor(() => expect(hlsInstances).toHaveLength(2));
      expect(audioWithGenerated(4_080).seeks).toEqual([3_480]);
      expect(media.play).toHaveBeenCalledTimes(2);
      expect(rows()[2]).toBe("Chapter Four未朗读");
    });
  });

  it("opens the 专注页 at a Chapter when its title is clicked, generated or not; Skipped and failed ones are not links", async () => {
    stubApi([generating]);
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Chapter Six" }));
    expect(window.location.pathname + window.location.search).toBe("/books/b1/listen?chapter=c6");
    window.history.pushState(null, "", "/");

    expect(screen.queryByRole("button", { name: "Titlepage" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Chapter Five" })).toBeNull();
    expect(within(screen.getAllByRole("listitem")[1]!).getByRole("button", { name: "Chapter One" })).toBeTruthy();
  });

  it("shows 解析中 while the worker is still parsing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...book, status: "parsing", chapters: [] })));
    renderPage();
    expect(await screen.findByText("解析中")).toBeTruthy();
  });

  it("shows 解析失败 with its reason", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ ...book, status: "parse_failed", failureReason: "解析超时，请删除后重新上传", chapters: [] }),
      ),
    );
    renderPage();
    expect(await screen.findByText("解析失败")).toBeTruthy();
    expect(screen.getByText("解析超时，请删除后重新上传")).toBeTruthy();
  });

  it("offers 开始收听 only once the Book is playable, and it opens the 专注页", async () => {
    const responses = [book, { ...book, playable: true }];
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(responses.shift() ?? { ...book, playable: true })));
    renderPage();

    expect(await screen.findByRole("button", { name: "开始收听" })).toBeDisabled();
    await vi.waitFor(() => expect(screen.getByRole("button", { name: "开始收听" })).toBeEnabled(), { timeout: 5000 });

    fireEvent.click(screen.getByRole("button", { name: "开始收听" }));
    expect(window.location.pathname).toBe("/books/b1/listen");
    window.history.pushState(null, "", "/");
  });

  it("shows 已就绪 once every narrated Chapter is generated", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...book, status: "ready", playable: true })));
    renderPage();
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
      renderPage();
      expect(await screen.findByRole("button", { name: "删除这本书" })).toBeEnabled();
    });

    it("asks first, and 取消 keeps the Book", async () => {
      const calls = stubApi([generating]);
      renderPage();

      fireEvent.click(await screen.findByRole("button", { name: "删除这本书" }));
      const dialog = screen.getByRole("alertdialog", { name: "删除这本书？" });
      expect(within(dialog).getByText(CONFIRM)).toBeTruthy();

      fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
      expect(screen.queryByRole("alertdialog")).toBeNull();
      expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
    });

    it("closes the question with Escape", async () => {
      stubApi([generating]);
      renderPage();
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
      renderPage();

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
      renderPage();

      fireEvent.click(await screen.findByRole("button", { name: "删除这本书" }));
      fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "删除" }));

      await vi.waitFor(() => expect(window.location.pathname).toBe("/"));
      expect(deleted).toEqual(["b1"]);
      window.removeEventListener(BOOK_DELETED_EVENT, onDeleted);
    });

    it("says so when the deletion fails, and keeps the question open to try again", async () => {
      window.history.pushState(null, "", "/books/b1");
      stubApi([generating], () => Response.json({ error: { code: "internal", message: "服务器出错了，请稍后再试" } }, { status: 500 }));
      renderPage();

      fireEvent.click(await screen.findByRole("button", { name: "删除这本书" }));
      const dialog = screen.getByRole("alertdialog");
      fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));

      expect((await within(dialog).findByRole("alert")).textContent).toBe("服务器出错了，请稍后再试");
      expect(within(dialog).getByRole("button", { name: "删除" })).toBeEnabled();
      expect(window.location.pathname).toBe("/books/b1");
      window.history.pushState(null, "", "/");
    });
  });
});
