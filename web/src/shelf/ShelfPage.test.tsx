// The Shelf and the upload dialog as the user meets them (F3, F4, F2): the API is stubbed at fetch and
// XMLHttpRequest, everything else is the real page.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Book, UploadPolicy } from "../api";
import { stubMediaPlayback } from "../test-media";
import { ShelfPage } from "./ShelfPage";

const MB = 1024 * 1024;

const book = (id: string, rest: Partial<Book> = {}): Book => ({
  id,
  title: `Book ${id}`,
  author: null,
  source: "upload",
  status: "ready",
  playable: true,
  failureReason: null,
  progress: { generated: 6, narrated: 6 },
  coverUrl: null,
  listening: null,
  createdAt: "2026-11-18T00:00:00.000Z",
  ...rest,
});

const listened = (share: number, chapterTitle = "Chapter 1"): Book["listening"] => ({
  sentenceId: "s1",
  chapterTitle,
  share,
  startMs: 1000,
  listenedAt: "2026-11-18T00:00:00.000Z",
});

const policy = (rest: Partial<UploadPolicy> = {}): UploadPolicy => ({
  maxFileBytes: 50 * MB,
  maxBooks: 20,
  uploadedBooks: 0,
  declaration: { version: "1", text: "我确认拥有该文件的合法使用权，文件不含 DRM，仅供本人收听学习", accepted: false },
  ...rest,
});

/** XMLHttpRequest as uploadBook uses it; each upload is answered by hand with `respond`. */
class FakeXhr {
  static last: FakeXhr | null = null;
  upload: { onprogress?: (e: { lengthComputable: boolean; loaded: number; total: number }) => void } = {};
  onload?: () => void;
  onerror?: () => void;
  onabort?: () => void;
  responseType = "";
  status = 0;
  response: unknown = null;
  method = "";
  url = "";
  body: FormData | null = null;
  aborted = false;
  constructor() {
    FakeXhr.last = this;
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  send(body: FormData) {
    this.body = body;
  }
  abort() {
    this.aborted = true;
    act(() => this.onabort?.());
  }
  progress(loaded: number, total: number) {
    act(() => this.upload.onprogress?.({ lengthComputable: true, loaded, total }));
  }
  async respond(status: number, body: unknown) {
    this.status = status;
    this.response = body;
    await act(async () => this.onload?.());
  }
}

/** Answers GET /api/books with each Shelf in turn (the last one from then on) and GET /api/upload-policy. */
function serve(shelves: Book[][], uploadPolicy = policy()) {
  const queue = [...shelves];
  const fetchMock = vi.fn(async (url: string) => {
    if (url === "/api/upload-policy") return Response.json(uploadPolicy);
    if (url === "/api/books") return Response.json(queue.length > 1 ? queue.shift() : queue[0]);
    throw new Error(`unexpected ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function chooseFile(file: File) {
  fireEvent.change(screen.getByLabelText("选择 EPUB 文件"), { target: { files: [file] } });
}

/** A file that reports `size` bytes without holding them. */
function epub(name = "walden.epub", size = 1000) {
  const f = new File(["PK"], name, { type: "application/epub+zip" });
  Object.defineProperty(f, "size", { value: size });
  return f;
}

beforeEach(() => {
  FakeXhr.last = null;
  vi.stubGlobal("XMLHttpRequest", FakeXhr);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  window.history.pushState(null, "", "/");
});

describe("an empty Shelf (AC-GUIDE-01)", () => {
  it("offers the Library and an upload", async () => {
    serve([[]]);
    render(<ShelfPage />);

    expect(await screen.findByText("书架还空着")).toBeTruthy();
    fireEvent.click(screen.getByRole("link", { name: "从书库挑一本开始听" }));
    expect(window.location.pathname).toBe("/library");

    fireEvent.click(screen.getByRole("button", { name: "上传自己的 EPUB" }));
    expect(screen.getByRole("dialog", { name: "上传书籍" })).toBeTruthy();
  });
});

describe("the Shelf (F3)", () => {
  const shelf = [
    book("p", { title: "Pride and Prejudice", author: "Jane Austen", listening: listened(0.34), coverUrl: "/api/books/p/cover" }),
    book("g", { title: "The Great Gatsby", listening: listened(0.62) }),
    book("a", { title: "Alice" }),
    book("r", { title: "A Room of One's Own", status: "generating", progress: { generated: 3, narrated: 6 } }),
    book("m", { title: "Meditations", status: "parsing", playable: false, progress: { generated: 0, narrated: 0 } }),
    book("x", { title: "atomic-habits", status: "parse_failed", playable: false, failureReason: "文件无法读取" }),
  ];

  it("shows the Book listened to last in 【继续收听】, with its Chapter and progress", async () => {
    serve([shelf]);
    render(<ShelfPage />);

    const card = await screen.findByRole("region", { name: "继续收听" });
    expect(within(card).getByRole("heading", { name: "Pride and Prejudice" })).toBeTruthy();
    expect(within(card).getByText("Jane Austen")).toBeTruthy();
    expect(within(card).getByText("Chapter 1 · 34%")).toBeTruthy();
    expect(card.querySelector("img")!.getAttribute("src")).toBe("/api/books/p/cover");
  });

  it("lists the other Books in Shelf order with their progress or processing state (AC-SHELF-01, AC-SHELF-02)", async () => {
    serve([shelf]);
    render(<ShelfPage />);

    const grid = await screen.findByRole("list", { name: "书架上的书" });
    const tiles = within(grid).getAllByRole("link");
    // Text of each tile: a default cover's title, 生成中's n/N on the cover, then title and state.
    expect(tiles.map((t) => t.textContent)).toEqual([
      "The Great GatsbyThe Great Gatsby62%",
      "AliceAlice未开始",
      "A Room of One's Own3 / 6A Room of One's Own生成中",
      "Meditations解析中",
      "atomic-habits解析失败文件无法读取",
    ]);
    // Without a cover image, the cover carries the title.
    expect(tiles[1]!.querySelector(".book-cover-title")!.textContent).toBe("Alice");
  });

  it("opens a playable Book in the 专注页 to play on, and any other in its detail (AC-SHELF-03, AC-SHELF-04)", async () => {
    serve([shelf]);
    render(<ShelfPage />);
    const grid = await screen.findByRole("list", { name: "书架上的书" });

    fireEvent.click(within(grid).getByRole("link", { name: /The Great Gatsby/ }));
    expect(window.location.pathname + window.location.search).toBe("/books/g/listen?autoplay");

    fireEvent.click(within(grid).getByRole("link", { name: /Meditations/ }));
    expect(window.location.pathname + window.location.search).toBe("/books/m");

    fireEvent.click(screen.getByRole("button", { name: "继续收听 Pride and Prejudice" }));
    expect(window.location.pathname + window.location.search).toBe("/books/p/listen?autoplay");
  });

  it("has no 【继续收听】 before anything was listened to", async () => {
    serve([[book("a", { title: "Alice" })]]);
    render(<ShelfPage />);

    await screen.findByText("未开始");
    expect(screen.queryByRole("region", { name: "继续收听" })).toBeNull();
  });

  it("keeps 生成中 n/N current while a Book is generating", async () => {
    const generating = (generated: number) => [
      book("r", { title: "A Room", status: "generating", progress: { generated, narrated: 6 } }),
    ];
    serve([generating(1), generating(2)]);
    render(<ShelfPage />);

    expect(await screen.findByText("1 / 6")).toBeTruthy();
    expect(await screen.findByText("2 / 6", undefined, { timeout: 4000 })).toBeTruthy();
  });
});

describe("the upload dialog (F4)", () => {
  async function openDialog(uploadPolicy = policy(), shelves: Book[][] = [[book("a", { title: "Alice" })]]) {
    const fetchMock = serve(shelves, uploadPolicy);
    render(<ShelfPage />);
    fireEvent.click(await screen.findByRole("button", { name: "上传" }));
    const dialog = screen.getByRole("dialog", { name: "上传书籍" });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/upload-policy", undefined));
    await act(async () => {});
    return { dialog, fetchMock };
  }
  const uploadButton = () => within(screen.getByRole("dialog")).getByRole("button", { name: "上传" });

  it("AC-UP-04: needs a file and the declaration before 上传 can be pressed", async () => {
    await openDialog();
    expect(screen.getByText("最大 50MB")).toBeTruthy();
    expect(uploadButton()).toBeDisabled();

    chooseFile(epub());
    expect(screen.getByText("walden.epub")).toBeTruthy();
    expect(uploadButton()).toBeDisabled();

    fireEvent.click(screen.getByRole("checkbox", { name: "我确认拥有该文件的合法使用权，文件不含 DRM，仅供本人收听学习" }));
    expect(uploadButton()).toBeEnabled();
  });

  it("does not ask for the declaration again once confirmed", async () => {
    await openDialog(policy({ declaration: { ...policy().declaration, accepted: true } }));

    chooseFile(epub());

    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(uploadButton()).toBeEnabled();
  });

  it.each([
    ["AC-UP-01", epub("notes.pdf"), policy(), "目前只支持 EPUB 格式"],
    ["AC-UP-02", epub("big.epub", 60 * MB), policy(), "文件不能超过 50MB"],
    ["AC-UP-03", epub(), policy({ uploadedBooks: 20 }), "内测期最多上传 20 本书，可删除不再听的书后再上传"],
  ])("%s: says why a file is refused as soon as it is chosen, and stays open", async (_, file, uploadPolicy, message) => {
    await openDialog(uploadPolicy);

    chooseFile(file);

    expect(screen.getByRole("alert").textContent).toBe(message);
    expect(uploadButton()).toBeDisabled();
    expect(screen.getByRole("dialog")).toBeTruthy();
    // Choosing a good file clears it.
    if (uploadPolicy.uploadedBooks < uploadPolicy.maxBooks) {
      chooseFile(epub());
      expect(screen.queryByRole("alert")).toBeNull();
    }
  });

  it("uploads with a progress bar, then closes and shows the new Book 解析中 on the Shelf", async () => {
    const before = [book("a", { title: "Alice" })];
    const after = [book("w", { title: "walden", status: "parsing", playable: false }), ...before];
    await openDialog(policy(), [before, after]);
    chooseFile(epub());
    fireEvent.click(screen.getByRole("checkbox"));

    fireEvent.click(uploadButton());
    const xhr = FakeXhr.last!;
    expect([xhr.method, xhr.url]).toEqual(["POST", "/api/books"]);
    expect((xhr.body!.get("file") as File).name).toBe("walden.epub");
    expect(xhr.body!.get("declarationVersion")).toBe("1");
    expect(xhr.body!.get("voice")).toBe("us_female");

    xhr.progress(450, 1000);
    expect(screen.getByRole("progressbar", { name: "上传进度" }).getAttribute("aria-valuenow")).toBe("45");
    expect(screen.getByText("上传中 45%")).toBeTruthy();

    await xhr.respond(201, after[0]);

    expect(screen.queryByRole("dialog")).toBeNull();
    const grid = await screen.findByRole("list", { name: "书架上的书" });
    expect(await within(grid).findByRole("link", { name: /walden解析中/ })).toBeTruthy();
  });

  describe("音色 (design 04-1, PRD 4.2.4)", () => {
    const voices = () =>
      within(screen.getByRole("group", { name: "音色" }))
        .getAllByRole("radio")
        .map((r) => [r.parentElement!.textContent, (r as HTMLInputElement).checked]);

    it("offers the four Voices with 美音女声 chosen, and uploads with the one the user picks", async () => {
      await openDialog(policy({ declaration: { ...policy().declaration, accepted: true } }));
      expect(voices()).toEqual([
        ["美音女声", true],
        ["美音男声", false],
        ["英音女声", false],
        ["英音男声", false],
      ]);

      fireEvent.click(screen.getByRole("radio", { name: "英音男声" }));
      chooseFile(epub());
      fireEvent.click(uploadButton());

      expect(voices().find(([, checked]) => checked)![0]).toBe("英音男声");
      expect(FakeXhr.last!.body!.get("voice")).toBe("uk_male");
    });

    it("plays a Voice's 5-second preview, one at a time, and stops it on a second press or when it ends", async () => {
      const media = stubMediaPlayback();
      await openDialog();

      fireEvent.click(screen.getByRole("button", { name: "试听英音女声" }));
      expect(media.play).toHaveBeenCalledTimes(1);
      const first = media.play.mock.contexts[0] as HTMLAudioElement;
      expect(first.src).toMatch(/\/voices\/uk_female\.m4a$/);
      expect(screen.getByRole("button", { name: "停止试听英音女声" }).getAttribute("aria-pressed")).toBe("true");
      // Previewing is not choosing: the Voice stays 美音女声.
      expect(screen.getByRole("radio", { name: "美音女声" })).toHaveProperty("checked", true);

      fireEvent.click(screen.getByRole("button", { name: "试听美音男声" }));
      expect(media.pause.mock.contexts).toContain(first);
      const second = media.play.mock.contexts[1] as HTMLAudioElement;
      expect(second.src).toMatch(/\/voices\/us_male\.m4a$/);
      expect(screen.getByRole("button", { name: "试听英音女声" })).toBeTruthy();

      act(() => second.dispatchEvent(new Event("ended")));
      expect(screen.getByRole("button", { name: "试听美音男声" }).getAttribute("aria-pressed")).toBe("false");

      fireEvent.click(screen.getByRole("button", { name: "试听美音男声" }));
      fireEvent.click(screen.getByRole("button", { name: "停止试听美音男声" }));
      expect(screen.getByRole("button", { name: "试听美音男声" })).toBeTruthy();
    });
  });

  it("does not send the declaration when it was confirmed before", async () => {
    await openDialog(policy({ declaration: { ...policy().declaration, accepted: true } }));
    chooseFile(epub());

    fireEvent.click(uploadButton());

    expect(FakeXhr.last!.body!.has("declarationVersion")).toBe(false);
  });

  it("shows the API's refusal in the dialog and stays open", async () => {
    await openDialog();
    chooseFile(epub());
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(uploadButton());

    await FakeXhr.last!.respond(409, {
      error: { code: "upload_limit_reached", message: "内测期最多上传 20 本书，可删除不再听的书后再上传" },
    });

    expect(screen.getByRole("alert").textContent).toBe("内测期最多上传 20 本书，可删除不再听的书后再上传");
    expect(uploadButton()).toBeEnabled();
  });

  it("cancels an upload under way and goes back to the chosen file", async () => {
    await openDialog();
    chooseFile(epub());
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(uploadButton());
    const xhr = FakeXhr.last!;

    fireEvent.click(screen.getByRole("button", { name: "取消上传" }));
    await act(async () => {});

    expect(xhr.aborted).toBe(true);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("walden.epub")).toBeTruthy();
    expect(uploadButton()).toBeEnabled();
  });

  it("closes with ✕ or Esc, cancelling an upload under way", async () => {
    await openDialog();
    chooseFile(epub());
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(uploadButton());
    const xhr = FakeXhr.last!;

    fireEvent.keyDown(window, { key: "Escape" });

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(xhr.aborted).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "上传" }));
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
