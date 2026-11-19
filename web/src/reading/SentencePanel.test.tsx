// 句子精读 (F11) as the user meets it: the fixed Sentence and its actions, AI 解析 and follow-up questions streamed
// from the API (fetch stubbed with NDJSON streams), stopping, the daily limit and failures.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExplainEvent, Explanation } from "../api";
import { resetSentenceChats } from "./chatStore";
import { SentencePanel, type AuditionControl, type MarkToggle, type PanelSentence } from "./SentencePanel";

const S1: PanelSentence = { id: "s1", text: "“You want to tell me, and I have no objection to hearing it.”" };
const S2: PanelSentence = { id: "s2", text: "This was invitation enough." };

const EXPLANATION = "## 句意\n你想说就说吧，我不反对听一听。\n\n## 结构\n两个分句由 and 并列。\n\n## 短语与习语\n- have no objection to：不反对";

/** A streamed answer the test feeds event by event; the client stopping it errors the stream like fetch does. */
interface Stream {
  body: unknown;
  push(event: ExplainEvent): Promise<void>;
  end(): Promise<void>;
  stopped: boolean;
}

let saved: Record<string, Partial<Explanation>>;
let streams: Stream[];
let fetchMock: ReturnType<typeof vi.fn>;

function serveStream(init: RequestInit): Response {
  let out!: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  const stream: Stream = {
    body: JSON.parse(init.body as string),
    stopped: false,
    push: async (event) => {
      await act(async () => out.enqueue(encoder.encode(`${JSON.stringify(event)}\n`)));
    },
    end: async () => {
      await act(async () => out.close());
    },
  };
  const body = new ReadableStream<Uint8Array>({ start: (c) => void (out = c) });
  init.signal?.addEventListener("abort", () => {
    stream.stopped = true;
    out.error(new DOMException("The user aborted a request.", "AbortError"));
  });
  streams.push(stream);
  return new Response(body, { headers: { "Content-Type": "application/x-ndjson" } });
}

beforeEach(() => {
  saved = {};
  streams = [];
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const id = /^\/api\/sentences\/([^/]+)\/explanation$/.exec(url)?.[1];
    if (!id) return new Response(null, { status: 404 });
    if (init?.method === "POST") {
      if (saved[id]?.aiRemaining === 0) {
        return Response.json({ error: { code: "ai_quota_exhausted", message: "今日 AI 解析次数已用完，明天再来" } }, { status: 429 });
      }
      return serveStream(init);
    }
    return Response.json({ content: null, messages: [], aiRemaining: 100, ...saved[id] });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  resetSentenceChats();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

interface Options {
  sentence?: PanelSentence | null;
  audition?: AuditionControl | null;
  mark?: MarkToggle | null;
  onLocate?: () => void;
}

function panel({ sentence = S1, audition = null, mark = null, onLocate = () => {} }: Options = {}) {
  return <SentencePanel sentence={sentence} onClose={() => {}} onLocate={onLocate} audition={audition} mark={mark} />;
}

async function renderPanel(options?: Options) {
  const view = render(panel(options));
  await act(async () => {});
  return view;
}

const input = () => screen.getByRole("textbox", { name: "提问" }) as HTMLInputElement;
const send = () => screen.getByRole("button", { name: "发送" }) as HTMLButtonElement;
const log = () => screen.getByRole("log", { name: "聊天记录" });
const posts = () => fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "POST");

async function ask(question: string) {
  fireEvent.change(input(), { target: { value: question } });
  await act(async () => fireEvent.click(send()));
}

async function explainClicked() {
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "AI 解析" })));
  return streams.at(-1)!;
}

describe("SentencePanel without a Sentence", () => {
  it("asks for one and keeps asking and sending off", async () => {
    await renderPanel({ sentence: null });

    expect(screen.getByText("选择一句正文")).toBeTruthy();
    expect(input()).toBeDisabled();
    expect(send()).toBeDisabled();
    expect(screen.queryByRole("button", { name: "AI 解析" })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("the fixed area", () => {
  it("shows the Sentence with 试听本句, 定位原文 and the leaf (AC-PANEL-12)", async () => {
    const onLocate = vi.fn();
    const play = vi.fn();
    await renderPanel({ onLocate, audition: { state: "idle", play } });

    expect(screen.getByText(S1.text)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "定位原文" }));
    fireEvent.click(screen.getByRole("button", { name: "试听本句" }));
    expect(onLocate).toHaveBeenCalledOnce();
    expect(play).toHaveBeenCalledOnce();
  });

  it("shows a thin ring while the 试听 loads, and no 试听 for a Sentence without audio", async () => {
    const view = await renderPanel({ audition: { state: "loading", play: () => {} } });
    expect(screen.getByRole("button", { name: "试听本句" }).getAttribute("aria-busy")).toBe("true");

    view.rerender(panel({ audition: null }));
    expect(screen.getByRole("button", { name: "试听本句" })).toBeDisabled();
  });

  it("folds a Sentence longer than four lines and unfolds it on request (AC-PANEL-11)", async () => {
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("panel-sentence-text") ? 260 : 0;
    });
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("is-folded") ? 130 : 0;
    });
    await renderPanel();
    const text = screen.getByText(S1.text);
    expect(text.classList.contains("is-folded")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "展开原句" }));
    expect(text.classList.contains("is-folded")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "收起原句" }));
    expect(text.classList.contains("is-folded")).toBe(true);
  });

  it("does not fold a short Sentence", async () => {
    await renderPanel();
    expect(screen.queryByRole("button", { name: "展开原句" })).toBeNull();
  });

  it("toggles the Mark through the seam without calling the AI (AC-PANEL-13)", async () => {
    const toggle = vi.fn();
    const view = await renderPanel({ mark: { marked: false, toggle } });
    fireEvent.click(screen.getByRole("button", { name: "标记" }));
    expect(toggle).toHaveBeenCalledOnce();

    view.rerender(panel({ mark: { marked: true, toggle } }));
    expect(screen.getByRole("button", { name: "取消标记" }).getAttribute("aria-pressed")).toBe("true");
    expect(posts()).toHaveLength(0);
  });

  it("shows the leaf disabled until Marks are wired", async () => {
    await renderPanel({ mark: null });
    expect(screen.getByRole("button", { name: "标记" })).toBeDisabled();
  });
});

describe("AI 解析", () => {
  it("offers the quick action with today's calls left on a Sentence not explained yet", async () => {
    await renderPanel();

    expect(screen.getByRole("button", { name: "AI 解析" })).toBeEnabled();
    expect(screen.getByText("今日剩余 100")).toBeTruthy();
    expect(input().placeholder).toBe("问问这一句");
    expect(send()).toBeDisabled();
  });

  it("sends 解析这句话, streams the sections, and offers to stop meanwhile (AC-PANEL-01, AC-PANEL-07)", async () => {
    await renderPanel();
    const stream = await explainClicked();

    expect(stream.body).toEqual({ kind: "explain" });
    expect(within(log()).getByText("解析这句话")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "AI 解析" })).toBeNull();
    expect(screen.getByRole("button", { name: "停止" })).toBeTruthy();
    expect(input()).toBeDisabled();
    expect(input().placeholder).toBe("正在解析…");

    await stream.push({ type: "delta", text: "## 句意\n你想说就说吧，" });
    expect(within(log()).getByRole("heading", { name: "句意" })).toBeTruthy();
    expect(within(log()).getByText("你想说就说吧，")).toBeTruthy();
    expect(within(log()).getByText("AI 正在回复")).toBeTruthy();

    await stream.push({ type: "delta", text: EXPLANATION.slice("## 句意\n你想说就说吧，".length) });
    await stream.push({ type: "done", aiRemaining: 99 });
    await stream.end();

    expect(within(log()).getByRole("heading", { name: "结构" })).toBeTruthy();
    expect(within(log()).getByRole("heading", { name: "短语与习语" })).toBeTruthy();
    expect(within(log()).queryByText("AI 正在回复")).toBeNull();
    expect(screen.queryByRole("button", { name: "停止" })).toBeNull();
    expect(screen.queryByRole("button", { name: "AI 解析" })).toBeNull();
    expect(screen.getByRole("button", { name: "重新生成解析" })).toBeTruthy();
    expect(input().placeholder).toBe("追问这一句");
  });

  it("shows a saved Explanation at once, without calling the AI (AC-PANEL-02)", async () => {
    saved.s1 = { content: EXPLANATION, aiRemaining: 97 };
    await renderPanel();

    expect(within(log()).getByText("你想说就说吧，我不反对听一听。")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "AI 解析" })).toBeNull();
    expect(posts()).toHaveLength(0);
  });

  it("regenerates the Explanation, keeping the follow-ups (AC-PANEL-03)", async () => {
    saved.s1 = { content: EXPLANATION, messages: [{ role: "user", content: "问" }, { role: "assistant", content: "答" }] };
    await renderPanel();

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "重新生成解析" })));
    const stream = streams.at(-1)!;
    await stream.push({ type: "delta", text: "## 句意\n新的意译" });
    await stream.push({ type: "done", aiRemaining: 99 });
    await stream.end();

    expect(stream.body).toEqual({ kind: "explain" });
    expect(within(log()).getByText("新的意译")).toBeTruthy();
    expect(within(log()).queryByText("你想说就说吧，我不反对听一听。")).toBeNull();
    expect(within(log()).getByText("答")).toBeTruthy();
  });

  it("keeps what was generated when stopped and offers AI 解析 again; the call counts (AC-PANEL-08)", async () => {
    await renderPanel();
    const stream = await explainClicked();
    await stream.push({ type: "delta", text: "## 句意\n你想说" });

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "停止" })));

    expect(stream.stopped).toBe(true);
    expect(within(log()).getByText("你想说")).toBeTruthy();
    expect(screen.getByRole("button", { name: "AI 解析" })).toBeEnabled();
    expect(screen.getByText("今日剩余 99")).toBeTruthy();
    expect(input()).toBeEnabled();
  });

  it("says 解析失败，请重试 when the AI fails, and the call does not count (AC-PANEL-06)", async () => {
    await renderPanel();
    const stream = await explainClicked();
    await stream.push({ type: "delta", text: "## 句意" });
    await stream.push({ type: "error", message: "解析失败，请重试" });
    await stream.end();

    expect(screen.getByRole("alert").textContent).toBe("解析失败，请重试");
    expect(screen.getByRole("button", { name: "AI 解析" })).toBeEnabled();
    expect(screen.getByText("今日剩余 100")).toBeTruthy();
  });
});

describe("asking about the Sentence", () => {
  it("answers a question asked before any Explanation and keeps AI 解析 offered (AC-PANEL-09)", async () => {
    await renderPanel();

    await ask("  hearing 是什么词性？ ");
    const stream = streams.at(-1)!;
    expect(stream.body).toEqual({ kind: "ask", question: "hearing 是什么词性？" });
    expect(input().value).toBe("");
    expect(input().placeholder).toBe("正在回复…");
    await stream.push({ type: "delta", text: "这里是动名词。" });
    await stream.push({ type: "done", aiRemaining: 99 });
    await stream.end();

    expect(within(log()).getByText("hearing 是什么词性？")).toBeTruthy();
    expect(within(log()).getByText("这里是动名词。")).toBeTruthy();
    expect(screen.getByRole("button", { name: "AI 解析" })).toBeEnabled();
    expect(screen.getByText("今日剩余 99")).toBeTruthy();
  });

  it("only sends real text", async () => {
    await renderPanel();
    fireEvent.change(input(), { target: { value: "   " } });
    expect(send()).toBeDisabled();
    fireEvent.change(input(), { target: { value: "why?" } });
    expect(send()).toBeEnabled();
  });

  it("shows earlier questions and answers after the Explanation", async () => {
    saved.s1 = { content: EXPLANATION, messages: [{ role: "user", content: "为什么是 hearing？" }, { role: "assistant", content: "to 是介词。" }] };
    await renderPanel();

    const texts = within(log()).getAllByText(/解析这句话|为什么是 hearing？|to 是介词。/).map((el) => el.textContent);
    expect(texts).toEqual(["解析这句话", "为什么是 hearing？", "to 是介词。"]);
  });
});

describe("the daily limit", () => {
  it("greys out AI 解析 and sending once the day's calls are used up (AC-PANEL-04)", async () => {
    saved.s1 = { aiRemaining: 0 };
    await renderPanel();

    expect(screen.getByRole("button", { name: "AI 解析" })).toBeDisabled();
    expect(screen.getByText("今日 AI 解析次数已用完，明天再来")).toBeTruthy();
    fireEvent.change(input(), { target: { value: "why?" } });
    expect(send()).toBeDisabled();
  });

  it("says so when the API refuses a call for the limit", async () => {
    await renderPanel();
    saved.s1 = { aiRemaining: 0 };

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "AI 解析" })));

    expect(screen.getByRole("alert").textContent).toBe("今日 AI 解析次数已用完，明天再来");
    expect(screen.getByRole("button", { name: "AI 解析" })).toBeDisabled();
  });
});

describe("while a reply is generated", () => {
  it("keeps generating it for its Sentence after switching to another one (AC-PANEL-14)", async () => {
    const view = await renderPanel();
    const stream = await explainClicked();
    await stream.push({ type: "delta", text: "## 句意\n你想说" });

    view.rerender(panel({ sentence: S2 }));
    await act(async () => {});
    expect(screen.getByText(S2.text)).toBeTruthy();
    expect(within(log()).queryByText("你想说")).toBeNull();
    expect(screen.getByRole("button", { name: "AI 解析" })).toBeEnabled();
    await stream.push({ type: "delta", text: "就说吧" });
    await stream.push({ type: "done", aiRemaining: 99 });
    await stream.end();
    // As the API saved it; coming back loads the conversation again.
    saved.s1 = { content: "## 句意\n你想说就说吧", aiRemaining: 99 };

    view.rerender(panel({ sentence: S1 }));
    await act(async () => {});
    expect(stream.stopped).toBe(false);
    expect(within(log()).getByText("你想说就说吧")).toBeTruthy();
  });

  it("does not jump to the bottom while the user reads back, and offers 新回复 (AC-PANEL-10)", async () => {
    await renderPanel();
    const stream = await explainClicked();
    const el = log();
    Object.defineProperty(el, "scrollHeight", { value: 1000, configurable: true });
    Object.defineProperty(el, "clientHeight", { value: 400, configurable: true });
    el.scrollTop = 100;
    fireEvent.scroll(el);

    await stream.push({ type: "delta", text: "## 句意\n更多" });

    expect(el.scrollTop).toBe(100);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "新回复" })));
    expect(el.scrollTop).toBe(1000);
    expect(screen.queryByRole("button", { name: "新回复" })).toBeNull();
  });
});
