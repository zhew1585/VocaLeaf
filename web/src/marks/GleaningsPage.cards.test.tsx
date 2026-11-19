// 拾起's right side (#15, F10, F11, F12): 句子精读 of the picked Sentence, where a Card is made; the item then leaves
// Gleanings (gleaning_resolved: card) while the right side previews the Card and keeps the Sentence.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Card, Gleaning } from "../api";
import { App } from "../App";
import { stubMediaPlayback } from "../test-media";

vi.mock("hls.js", async () => ({ default: (await import("../test-media")).FakeHls }));

const TEXT = "She runs a bakery in the village.";
const OTHER = "I went to the woods because I wished to live deliberately.";

const gleaning = (sentenceId: string, text: string, bookId: string): Gleaning => ({
  sentenceId,
  text,
  bookId,
  bookTitle: bookId === "b1" ? "Pride and Prejudice" : "Walden",
  chapterId: `${bookId}-c1`,
  chapterTitle: "Chapter 1",
  startMs: 4_000,
  markedAt: "2026-11-18T00:00:00.000Z",
});

const madeCard: Card = {
  id: "k1",
  sentenceId: "s2",
  targetText: "bakery",
  targetKind: "word",
  targetStart: 11,
  targetEnd: 17,
  sentenceText: TEXT,
  contextBefore: null,
  contextAfter: null,
  bookTitle: "Pride and Prejudice",
  back: { kind: "word", meaning: "面包店", phonetic: "/ˈbeɪkəri/", partOfSpeech: "n.", collocations: [] },
  hasAudio: true,
  due: new Date().toISOString(),
  createdAt: "2026-11-18T00:00:00.000Z",
};

let items: Gleaning[];
let requests: string[];

beforeEach(() => {
  stubMediaPlayback();
  items = [gleaning("s9", OTHER, "b2"), gleaning("s2", TEXT, "b1")];
  requests = [];
  window.history.pushState(null, "", "/gleanings");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      requests.push(`${method} ${url}`);
      if (url === "/api/me") return Response.json({ id: "u1", email: "allen@vocaleaf.app", playGuideSeen: true });
      if (url === "/api/gleanings") return Response.json(items);
      if (url === "/api/gleanings/count") return Response.json({ count: items.length });
      if (url.endsWith("/cards") && method === "GET") return Response.json([]);
      if (url === "/api/cards" && method === "POST") {
        items = items.filter((g) => g.sentenceId !== "s2");
        return Response.json(madeCard, { status: 201 });
      }
      if (url === "/api/sentences/s2/mark" && method === "DELETE") {
        items = items.filter((g) => g.sentenceId !== "s2");
        return new Response(null, { status: 204 });
      }
      if (url.endsWith("/explanation")) return Response.json({ content: null, messages: [], aiRemaining: 100 });
      if (url.endsWith("/timeline")) return Response.json({ sentenceStartsMs: [], sentenceIds: [], chapters: [], complete: true });
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
const listed = () => within(list()).queryAllByRole("listitem").map((li) => li.querySelector(".gleaning-text")!.textContent);
const badge = () => screen.getByRole("link", { name: /拾起/ }).querySelector(".side-badge")?.textContent ?? null;
const panel = () => screen.queryByRole("complementary", { name: "句子精读" });
const popover = () => screen.queryByRole("complementary", { name: "卡片浮窗" });
const click = (el: Element) => act(async () => void fireEvent.click(el));

async function pick(text: string) {
  render(<App />);
  await screen.findByText(OTHER);
  await vi.waitFor(() => expect(badge()).toBe("2"));
  await click(within(list()).getByText(text));
}

/** Selects `selected` in 句子精读's Sentence (one text node, no Cards yet) and lets go of the mouse. */
async function selectInPanel(selected: string) {
  const p = panel()!.querySelector(".panel-sentence-text")!;
  const node = p.firstChild!;
  const start = node.textContent!.indexOf(selected);
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, start + selected.length);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  await act(async () => void fireEvent.mouseUp(p));
}

describe("句子精读 in 拾起 (F10, F11)", () => {
  it("shows the picked Sentence with 定位原文, the leaf and 忽略这一句, and the AI chat", async () => {
    await pick(TEXT);

    const shown = panel()!;
    expect(shown.querySelector(".panel-sentence-text")!.textContent).toBe(TEXT);
    expect(within(shown).getByRole("button", { name: "定位原文" })).toBeTruthy();
    expect(within(shown).getByRole("button", { name: "取消标记" })).toBeTruthy();
    expect(within(shown).getByRole("button", { name: "忽略这一句" })).toBeTruthy();
    expect(await within(shown).findByRole("button", { name: "AI 解析" })).toBeTruthy();
  });

  it("takes the item out of Gleanings when the leaf takes the Mark back", async () => {
    await pick(TEXT);

    await click(within(panel()!).getByRole("button", { name: "取消标记" }));

    expect(requests).toContain("DELETE /api/sentences/s2/mark");
    expect(listed()).toEqual([OTHER]);
    expect(within(panel()!).getByRole("button", { name: "标记" })).toBeTruthy();
    expect(within(panel()!).queryByRole("button", { name: "忽略这一句" })).toBeNull();
  });
});

describe("making a Card from 拾起 (F12, AC-CARD-06)", () => {
  it("takes the item out of Gleanings, previews the Card, and keeps 句子精读 on the Sentence", async () => {
    await pick(TEXT);

    await selectInPanel("bake");
    await click(within(panel()!).getByRole("button", { name: "制作卡片" }));

    expect(requests).toContain("POST /api/cards");
    expect(within(popover()!).getByText("面包店")).toBeTruthy();
    expect(listed()).toEqual([OTHER]);
    await vi.waitFor(() => expect(badge()).toBe("1"));

    await click(within(popover()!).getByRole("button", { name: "精读原句" }));

    expect(popover()).toBeNull();
    const shown = panel()!;
    expect([...shown.querySelectorAll(".card-target")].map((el) => el.textContent)).toEqual(["bakery"]);
    // Made into a Card, the Sentence is no longer in Gleanings: the leaf is off and there is nothing to Dismiss.
    expect(within(shown).getByRole("button", { name: "标记" })).toBeTruthy();
    expect(within(shown).queryByRole("button", { name: "忽略这一句" })).toBeNull();
  });

  it("closes the preview with Esc, back to 句子精读", async () => {
    await pick(TEXT);
    await selectInPanel("bakery");
    await click(within(panel()!).getByRole("button", { name: "制作卡片" }));

    await act(async () => void fireEvent.keyDown(window, { key: "Escape" }));

    expect(popover()).toBeNull();
    expect(panel()!.querySelector(".panel-sentence-text")!.textContent).toBe(TEXT);
  });
});
