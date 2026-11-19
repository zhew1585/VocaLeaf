// The 书库 as the user meets it (F6, design 03-3): the API is stubbed at fetch, everything else is the real page.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LibraryBook } from "../api";
import { LibraryPage } from "./LibraryPage";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.pushState(null, "", "/");
});

const book = (id: string, title: string, difficulty: LibraryBook["difficulty"], rest: Partial<LibraryBook> = {}) => ({
  id,
  title,
  author: `${title} Author`,
  difficulty,
  blurb: `${title} 简介`,
  coverUrl: null,
  onShelf: false,
  ...rest,
});

/** Serves the Library and answers PUT /books/:id/shelf with `addStatus`; returns the requests made. */
function serve(books: LibraryBook[], addStatus = 204) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url === "/api/library") return Response.json(books);
      if (addStatus === 204) return new Response(null, { status: 204 });
      return Response.json({ error: { code: "internal", message: "服务器出错了，请稍后再试" } }, { status: addStatus });
    }),
  );
  return calls;
}

describe("LibraryPage (书库)", () => {
  it("shows the Books in 入门, 中级 and 进阶 groups, in the order the API sorted them (PRD 4.2.2)", async () => {
    serve([
      book("a", "Alice", "beginner"),
      book("oz", "The Wonderful Wizard of Oz", "beginner"),
      book("p", "Pride and Prejudice", "intermediate"),
      book("w", "Walden", "advanced"),
    ]);
    render(<LibraryPage />);

    const groups = await screen.findAllByRole("region");
    expect(groups.map((g) => [within(g).getByRole("heading", { level: 2 }).textContent, within(g).getAllByRole("heading", { level: 3 }).map((h) => h.textContent)])).toEqual([
      ["入门", ["Alice", "The Wonderful Wizard of Oz"]],
      ["中级", ["Pride and Prejudice"]],
      ["进阶", ["Walden"]],
    ]);
    expect(screen.getByText("Alice 简介")).toBeTruthy();
    expect(screen.getByText("Alice Author")).toBeTruthy();
  });

  it("leaves out a group without Books", async () => {
    serve([book("w", "Walden", "advanced")]);
    render(<LibraryPage />);
    await screen.findByRole("heading", { name: "进阶" });
    expect(screen.queryByRole("heading", { name: "入门" })).toBeNull();
  });

  it("shows 已在书架 and 继续收听 for a Book on the Shelf, which plays on where the user left off (AC-LIB-02)", async () => {
    const calls = serve([book("p", "Pride and Prejudice", "intermediate", { onShelf: true })]);
    render(<LibraryPage />);

    fireEvent.click(await screen.findByRole("button", { name: "继续收听 Pride and Prejudice" }));

    expect(screen.getByText("已在书架")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /加入书架并播放/ })).toBeNull();
    expect(window.location.pathname + window.location.search).toBe("/books/p/listen?autoplay");
    // Already on the Shelf: nothing to add.
    expect(calls).toEqual(["GET /api/library"]);
  });

  it("puts a Book on the Shelf and opens it playing (AC-LIB-01)", async () => {
    const calls = serve([book("oz", "The Wonderful Wizard of Oz", "beginner")]);
    render(<LibraryPage />);

    fireEvent.click(await screen.findByRole("button", { name: "加入书架并播放 The Wonderful Wizard of Oz" }));

    await vi.waitFor(() => expect(window.location.pathname + window.location.search).toBe("/books/oz/listen?autoplay"));
    expect(calls).toEqual(["GET /api/library", "PUT /api/books/oz/shelf"]);
  });

  it("says so and stays when the Book cannot be added", async () => {
    serve([book("oz", "The Wonderful Wizard of Oz", "beginner")], 500);
    render(<LibraryPage />);

    const add = await screen.findByRole("button", { name: "加入书架并播放 The Wonderful Wizard of Oz" });
    fireEvent.click(add);

    expect((await screen.findByRole("alert")).textContent).toBe("服务器出错了，请稍后再试");
    expect(window.location.pathname).toBe("/");
    expect(add).toBeEnabled();
  });

  it("says the Library is being prepared while it has no Book ready", async () => {
    serve([]);
    render(<LibraryPage />);
    expect(await screen.findByText("书库正在准备中，很快就能从这里挑一本公版书开始听。")).toBeTruthy();
  });
});
