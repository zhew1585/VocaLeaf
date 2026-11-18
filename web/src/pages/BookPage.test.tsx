import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BookDetail } from "../api";
import { BookPage } from "./BookPage";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const book: BookDetail = {
  id: "b1",
  title: "Pride and Prejudice",
  author: "Jane Austen",
  status: "generating",
  createdAt: "2026-11-18T00:00:00.000Z",
  chapters: [
    { id: "c0", index: 0, title: "Titlepage", skipped: false, audioStatus: "pending", sentenceCount: 3 },
    { id: "c1", index: 1, title: "I", skipped: false, audioStatus: "pending", sentenceCount: 42 },
  ],
};

describe("BookPage", () => {
  it("shows the Book, its status and every Chapter with its Sentence count", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(book)));
    render(<BookPage id="b1" />);

    expect(await screen.findByRole("heading", { name: "Pride and Prejudice" })).toBeTruthy();
    expect(screen.getByText("Jane Austen")).toBeTruthy();
    expect(screen.getByText("生成中")).toBeTruthy();
    const rows = screen.getAllByRole("listitem").map((li) => [
      within(li).getByText(/^(Titlepage|I)$/).textContent,
      within(li).getByText(/句$/).textContent,
    ]);
    expect(rows).toEqual([
      ["Titlepage", "3 句"],
      ["I", "42 句"],
    ]);
  });

  it("shows 解析中 while the worker is still parsing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...book, status: "parsing", chapters: [] })));
    render(<BookPage id="b1" />);
    expect(await screen.findByText("解析中")).toBeTruthy();
  });
});
