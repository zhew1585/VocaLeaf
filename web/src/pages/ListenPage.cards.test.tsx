// Cards on the 专注页 (#15, PRD 4.4.5, 4.5.2, F12, F16) as the user meets them: green underlines under Targets, the
// 卡片浮窗 in the right area, 精读原句, and making a Card by selecting words in 句子精读.
import { resolveTarget } from "@vocaleaf/api/card-target";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CreateCard } from "@vocaleaf/api/contract";
import type { BookDetail, Card, Sentence } from "../api";
import { PlayGuideProvider } from "../guide/PlayGuide";
import { startOutbox, stopOutbox } from "../marks/marks";
import { layoutOf } from "../player/layout";
import { ListeningProvider } from "../player/session";
import { audioWithGenerated, hlsInstances, stubMediaPlayback } from "../test-media";
import { ListenPage } from "./ListenPage";

vi.mock("hls.js", async () => ({ default: (await import("../test-media")).FakeHls }));

const book: BookDetail = {
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
  listening: null,
  progress: { generated: 1, narrated: 1 },
  createdAt: "2026-11-18T00:00:00.000Z",
  chapters: [
    {
      id: "c1",
      index: 0,
      title: "Chapter 1",
      skipped: false,
      audioStatus: "generated",
      sentenceCount: 3,
      durationMs: 12_000,
      startMs: 0,
      waitSeconds: null,
    },
  ],
  durationMs: 12_000,
};

const sentence = (id: string, index: number, text: string): Sentence => ({
  id,
  index,
  paragraphIndex: 0,
  text,
  spokenText: text,
  startMs: index * 4000,
  endMs: index * 4000 + 3700,
  wordTimings: null,
});

const S1 = "She took it for granted that he would come.";
const S2 = "She runs a bakery in the village.";
const S3 = "Come what may, however little known.";
const SENTENCES = [sentence("s1", 0, S1), sentence("s2", 1, S2), sentence("s3", 2, S3)];

function card(id: string, sentenceId: string, text: string, selected: string, back: Card["back"] = null): Card {
  const start = text.indexOf(selected);
  const target = resolveTarget(text, start, start + selected.length)!;
  return {
    id,
    sentenceId,
    targetText: text.slice(target.start, target.end),
    targetKind: target.kind,
    targetStart: target.start,
    targetEnd: target.end,
    sentenceText: text,
    contextBefore: null,
    contextAfter: null,
    bookTitle: book.title,
    back,
    hasAudio: true,
    due: new Date().toISOString(),
    createdAt: "2026-11-18T00:00:00.000Z",
  };
}

const PHRASE_BACK: Card["back"] = { kind: "phrase", meaning: "认为理所当然", usage: "take sth for granted", example: "Never take it for granted." };
const WORD_BACK: Card["back"] = { kind: "word", meaning: "将来", phonetic: "/kʌm/", partOfSpeech: "v.", collocations: ["come back：回来"] };

let cards: Card[];
let marked: Set<string>;
let posts: { url: string; body: unknown }[];
let backFails: boolean;

beforeEach(() => {
  startOutbox("u1");
  hlsInstances.length = 0;
  stubMediaPlayback();
  Element.prototype.scrollTo = vi.fn() as never;
  // s1 has two Cards that do not overlap; s2 has none and a pending Mark.
  cards = [card("k1", "s1", S1, "took it for granted", PHRASE_BACK), card("k2", "s1", S1, "come", WORD_BACK)];
  marked = new Set(["s2"]);
  posts = [];
  backFails = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "POST") posts.push({ url, body: init?.body ? JSON.parse(init.body as string) : null });
      if (url === "/api/cards" && method === "POST") return makeCard(JSON.parse(init!.body as string) as CreateCard);
      const retried = /^\/api\/cards\/([^/]+)\/back$/.exec(url)?.[1];
      if (retried) {
        if (backFails) return Response.json({ error: { code: "card_back_failed", message: "释义生成失败，点击重试" } }, { status: 502 });
        const updated = { ...cards.find((c) => c.id === retried)!, back: WORD_BACK };
        cards = cards.map((c) => (c.id === retried ? updated : c));
        return Response.json(updated);
      }
      if (url === "/api/chapters/c1/sentences") return Response.json(SENTENCES);
      if (url === "/api/books/b1/cards") return Response.json(cards);
      if (url === "/api/books/b1/marks") return Response.json({ pending: [...marked] });
      if (url.endsWith("/explanation")) return Response.json({ content: null, messages: [], aiRemaining: 100 });
      if (url.endsWith("/timeline")) {
        return Response.json({
          sentenceStartsMs: SENTENCES.map((s) => s.startMs),
          sentenceIds: SENTENCES.map((s) => s.id),
          chapters: layoutOf(book),
          complete: true,
          settled: true,
        });
      }
      if (url === "/api/books/b1") return Response.json(book);
      return new Response(null, { status: 204 });
    }),
  );
});

/** POST /api/cards as the API answers it: the same Target opens its Card, another Sentence's Target text asks first. */
function makeCard(body: CreateCard): Response {
  const text = SENTENCES.find((s) => s.id === body.sentenceId)!.text;
  const target = resolveTarget(text, body.start, body.end)!;
  const same = cards.find((c) => c.sentenceId === body.sentenceId && c.targetStart === target.start && c.targetEnd === target.end);
  if (same) return Response.json(same);
  const targetText = text.slice(target.start, target.end);
  if (!body.allowDuplicate && cards.some((c) => c.targetText.toLowerCase() === targetText.toLowerCase())) {
    return Response.json({ error: { code: "duplicate_target", message: `你已有 "${targetText}" 的卡片，仍要创建吗？` } }, { status: 409 });
  }
  const made = card(`k${cards.length + 1}`, body.sentenceId, text, targetText, null);
  cards = [...cards, made];
  marked.delete(body.sentenceId);
  return Response.json(made, { status: 201 });
}

afterEach(() => {
  stopOutbox();
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  window.history.pushState(null, "", "/");
});

async function openPage() {
  render(
    <PlayGuideProvider seen>
      <ListeningProvider>
        <ListenPage id="b1" />
      </ListeningProvider>
    </PlayGuideProvider>,
  );
  await screen.findByText(S3);
  audioWithGenerated(12);
  const count = cards.length;
  await vi.waitFor(() => expect(document.querySelectorAll(".reading .card-target")).toHaveLength(count));
}

const sentenceEl = (id: string) => document.querySelector<HTMLElement>(`.reading [data-sentence-id="${id}"]`)!;
const underlines = (id: string) => [...sentenceEl(id).querySelectorAll(".card-target")].map((el) => el.textContent);
const popover = () => screen.queryByRole("complementary", { name: "卡片浮窗" });
const panel = () => screen.queryByRole("complementary", { name: "句子精读" });
const click = (el: Element) => act(async () => void fireEvent.click(el));

/** Selects the first `selected` in 句子精读's Sentence as a user would, then lets go of the mouse. */
async function selectInPanel(selected: string) {
  const p = panel()!.querySelector(".panel-sentence-text")!;
  const start = p.textContent!.indexOf(selected);
  const point = (at: number): [Node, number] => {
    const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
    let passed = 0;
    for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
      if (at <= passed + n.length) return [n, at - passed];
      passed += n.length;
    }
    throw new Error("out of the text");
  };
  const range = document.createRange();
  range.setStart(...point(start));
  range.setEnd(...point(start + selected.length));
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  await act(async () => void fireEvent.mouseUp(p));
}

describe("Cards in the text (PRD 4.4.5 有 Card)", () => {
  it("underlines each Card's Target on its own, and a pending Mark next to a Target (AC-READ-07, AC-READ-08)", async () => {
    marked.add("s1");
    await openPage();

    expect(underlines("s1")).toEqual(["took it for granted", "come"]);
    expect(underlines("s2")).toEqual([]);
    await vi.waitFor(() => expect(sentenceEl("s1").classList.contains("is-marked")).toBe(true));
  });
});

describe("the 卡片浮窗 (F16)", () => {
  it("shows the one Card of the underline clicked, in place of 句子精读 (AC-POP-01, AC-READ-09)", async () => {
    await openPage();

    await click(within(sentenceEl("s1")).getByText("come"));

    const shown = popover()!;
    expect(panel()).toBeNull();
    expect(sentenceEl("s1").classList.contains("is-selected")).toBe(true);
    expect(within(shown).getByText("单词 · 今天复习")).toBeTruthy();
    expect(within(shown).getByText("将来")).toBeTruthy();
    expect(within(shown).getByText("/kʌm/ · v.")).toBeTruthy();
    expect(shown.querySelector(".card-highlight")!.textContent).toBe("come");
  });

  it("lists every Card of a Sentence clicked off its underlines, each opening in place (AC-POP-07, AC-POP-02)", async () => {
    await openPage();

    await click(within(sentenceEl("s1")).getByText(/that he would/));

    const shown = popover()!;
    expect(within(shown).getByText("这里有 2 张卡片")).toBeTruthy();
    const rows = within(shown).getAllByRole("button", { name: /今天/ });
    expect(rows.map((r) => r.querySelector(".card-row-target")!.textContent)).toEqual(["took it for granted", "come"]);

    await click(rows[0]!);
    expect(within(shown).getByText("认为理所当然")).toBeTruthy();
    expect(within(shown).getByText("Never take it for granted.")).toBeTruthy();

    await click(within(shown).getByRole("button", { name: "返回列表" }));
    expect(within(shown).getByText("这里有 2 张卡片")).toBeTruthy();
  });

  it("goes back to 句子精读 as it was when closed with Esc or X (AC-POP-04, AC-POP-08)", async () => {
    await openPage();
    await click(within(sentenceEl("s2")).getByText(S2));
    expect(within(panel()!).getByText(S2)).toBeTruthy();

    await click(within(sentenceEl("s1")).getByText("come"));
    expect(panel()).toBeNull();
    await act(async () => void fireEvent.keyDown(document.body, { key: "Escape" }));

    expect(popover()).toBeNull();
    // Still the Sentence clicked last, as 句子精读 keeps the selection.
    expect(panel()!.querySelector(".panel-sentence-text")!.textContent).toBe(S1);

    await click(within(sentenceEl("s1")).getByText("come"));
    await click(within(popover()!).getByRole("button", { name: "关闭卡片浮窗" }));
    expect(popover()).toBeNull();
    expect(panel()).not.toBeNull();
  });

  it("stays collapsed after closing when 句子精读 was collapsed", async () => {
    await openPage();
    expect(panel()).toBeNull();

    await click(within(sentenceEl("s1")).getByText("come"));
    await act(async () => void fireEvent.mouseDown(document.body));

    expect(popover()).toBeNull();
    expect(panel()).toBeNull();
  });

  it("opens 句子精读 on the Sentence with 精读原句, without asking the AI (AC-POP-03)", async () => {
    await openPage();
    await click(within(sentenceEl("s1")).getByText("come"));

    await click(within(popover()!).getByRole("button", { name: "精读原句" }));

    expect(popover()).toBeNull();
    expect(within(panel()!).getByText("come")).toBeTruthy();
    expect(sentenceEl("s1").classList.contains("is-selected")).toBe(true);
    expect(posts).toEqual([]);
  });

  it("opens a Card from 句子精读's own underline (F11)", async () => {
    await openPage();
    await click(within(sentenceEl("s1")).getByText("come"));
    await click(within(popover()!).getByRole("button", { name: "精读原句" }));

    await click(within(panel()!).getByText("took it for granted"));

    expect(within(popover()!).getByText("认为理所当然")).toBeTruthy();
  });

  it("generates a failed back again on 释义生成失败，点击重试 (PRD 4.5.2 规则 6)", async () => {
    cards = [card("k1", "s1", S1, "come", null)];
    backFails = true;
    await openPage();
    await click(within(sentenceEl("s1")).getByText("come"));

    await click(within(popover()!).getByRole("button", { name: "释义生成失败，点击重试" }));
    expect(within(popover()!).getByRole("button", { name: "释义生成失败，点击重试" })).toBeEnabled();

    backFails = false;
    await click(within(popover()!).getByRole("button", { name: "释义生成失败，点击重试" }));
    expect(within(popover()!).getByText("将来")).toBeTruthy();
    expect(posts.map((p) => p.url)).toEqual(["/api/cards/k1/back", "/api/cards/k1/back"]);
  });

  it("plays the Card's own audio with 卡片原声 (AC-POP-05)", async () => {
    await openPage();
    await click(within(sentenceEl("s1")).getByText("come"));

    await click(within(popover()!).getByRole("button", { name: "卡片原声" }));

    const clip = [...document.querySelectorAll("audio")].find((a) => a.getAttribute("src") === "/api/cards/k2/audio");
    expect(clip).toBeTruthy();
    expect(clip!.paused).toBe(false);
  });
});

describe("making a Card in 句子精读 (F12)", () => {
  it("widens the selection to whole words, makes the Card and previews it; the Mark's dashes go (AC-CARD-01, AC-CARD-08, AC-CARD-10)", async () => {
    await openPage();
    await vi.waitFor(() => expect(sentenceEl("s2").classList.contains("is-marked")).toBe(true));
    await click(within(sentenceEl("s2")).getByText(S2));
    expect(within(panel()!).getByRole("button", { name: "取消标记" })).toBeTruthy();

    await selectInPanel("ak");
    expect(window.getSelection()!.toString()).toBe("bakery");
    await click(within(panel()!).getByRole("button", { name: "制作卡片" }));

    expect(posts).toEqual([{ url: "/api/cards", body: { sentenceId: "s2", start: 11, end: 17 } }]);
    expect(within(popover()!).getByText("单词 · 今天复习")).toBeTruthy();
    expect(underlines("s2")).toEqual(["bakery"]);
    expect(sentenceEl("s2").classList.contains("is-marked")).toBe(false);

    await act(async () => void fireEvent.keyDown(document.body, { key: "Escape" }));
    expect(within(panel()!).getByRole("button", { name: "标记" })).toBeTruthy();
    expect([...panel()!.querySelectorAll(".card-target")].map((el) => el.textContent)).toEqual(["bakery"]);
  });

  it("opens the Sentence's Card of the same Target instead of making one (AC-CARD-09)", async () => {
    await openPage();
    await click(within(sentenceEl("s1")).getByText("come"));
    await click(within(popover()!).getByRole("button", { name: "精读原句" }));

    await selectInPanel("com");
    await click(within(panel()!).getByRole("button", { name: "制作卡片" }));

    expect(within(popover()!).getByText("将来")).toBeTruthy();
    expect(cards).toHaveLength(2);
  });

  it("asks before making a second Card of a Target from another Sentence, then makes it (AC-CARD-05)", async () => {
    await openPage();
    await click(within(sentenceEl("s3")).getByText(S3));

    await selectInPanel("Come");
    await click(within(panel()!).getByRole("button", { name: "制作卡片" }));
    const dialog = screen.getByRole("alertdialog", { name: '你已有 "Come" 的卡片，仍要创建吗？' });
    expect(underlines("s3")).toEqual([]);

    await click(within(dialog).getByRole("button", { name: "仍要创建" }));

    expect(posts.map((p) => p.body)).toEqual([
      { sentenceId: "s3", start: 0, end: 4 },
      { sentenceId: "s3", start: 0, end: 4, allowDuplicate: true },
    ]);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(underlines("s3")).toEqual(["Come"]);
    expect(underlines("s1")).toEqual(["took it for granted", "come"]);
  });

  it("makes nothing when the duplicate prompt is cancelled", async () => {
    await openPage();
    await click(within(sentenceEl("s3")).getByText(S3));
    await selectInPanel("Come");
    await click(within(panel()!).getByRole("button", { name: "制作卡片" }));

    await click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "取消" }));

    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(posts).toHaveLength(1);
    expect(underlines("s3")).toEqual([]);
  });

  it("offers nothing for a selection without a word", async () => {
    await openPage();
    await click(within(sentenceEl("s2")).getByText(S2));
    await selectInPanel(".");
    expect(within(panel()!).queryByRole("button", { name: "制作卡片" })).toBeNull();
  });
});
