// 句子精读's conversation per Sentence (PRD 4.5.1, F11), kept outside React so a reply goes on streaming into its
// own Sentence after the user selects another one (AC-PANEL-14), and shows complete when they come back.
import { useEffect, useSyncExternalStore } from "react";
import { ApiRequestError, getExplanation, streamExplanation, type ChatMessage, type ExplainEvent } from "../api";

export const AI_QUOTA_MESSAGE = "今日 AI 解析次数已用完，明天再来";
export const AI_FAILED_MESSAGE = "解析失败，请重试";

/** A reply being generated: to 【AI 解析】 (or regenerate), or to a question. */
export interface PendingReply {
  kind: "explain" | "ask";
  question?: string;
  text: string;
}

export interface SentenceChat {
  /** False until the saved conversation arrived. */
  loaded: boolean;
  /** The saved Explanation (Markdown), or null. */
  content: string | null;
  /** An Explanation the user stopped: shown in the chat, never saved (PRD 4.5.1 #7). */
  stoppedExplanation: string | null;
  /** Saved follow-up questions and answers. */
  messages: ChatMessage[];
  pending: PendingReply | null;
  /** What went wrong with the last call (failed, or no calls left), shown at the end of the chat. */
  error: string | null;
}

const EMPTY: SentenceChat = { loaded: false, content: null, stoppedExplanation: null, messages: [], pending: null, error: null };

let chats = new Map<string, SentenceChat>();
/** AI calls left today; null until the API said. */
let remaining: number | null = null;
const listeners = new Set<() => void>();
const running = new Map<string, AbortController>();
/** Counts calls started per Sentence, so a load answering after a call started does not overwrite its result. */
const calls = new Map<string, number>();

function emit() {
  for (const listener of listeners) listener();
}

function update(sentenceId: string, change: (chat: SentenceChat) => SentenceChat) {
  chats = new Map(chats).set(sentenceId, change(chats.get(sentenceId) ?? EMPTY));
  emit();
}

function setRemaining(value: number) {
  remaining = value;
  emit();
}

/** Loads a Sentence's saved conversation, unless a reply for it is being generated. */
async function load(sentenceId: string) {
  if (running.has(sentenceId)) return;
  const startedCalls = calls.get(sentenceId) ?? 0;
  try {
    const saved = await getExplanation(sentenceId);
    if ((calls.get(sentenceId) ?? 0) !== startedCalls) return;
    update(sentenceId, (chat) => ({ ...chat, loaded: true, content: saved.content, messages: saved.messages }));
    setRemaining(saved.aiRemaining);
  } catch (err) {
    console.warn(`Loading the conversation of Sentence ${sentenceId} failed`, err);
    update(sentenceId, (chat) => ({ ...chat, loaded: true }));
  }
}

/** Streams one reply into the Sentence's chat, then keeps it as the API saved it. */
async function call(sentenceId: string, reply: PendingReply) {
  if (running.has(sentenceId)) return;
  const stop = new AbortController();
  running.set(sentenceId, stop);
  calls.set(sentenceId, (calls.get(sentenceId) ?? 0) + 1);
  update(sentenceId, (chat) => ({ ...chat, pending: reply, error: null }));
  let text = "";
  let outcome: ExplainEvent | null = null;
  try {
    await streamExplanation(
      sentenceId,
      reply.kind === "ask" ? { kind: "ask", question: reply.question! } : { kind: "explain" },
      {
        signal: stop.signal,
        onEvent: (event) => {
          if (event.type === "delta") {
            text += event.text;
            update(sentenceId, (chat) => ({ ...chat, pending: { ...reply, text } }));
          } else outcome = event;
        },
      },
    );
  } catch (err) {
    if (!stop.signal.aborted) {
      const quota = err instanceof ApiRequestError && err.status === 429;
      if (quota) setRemaining(0);
      outcome = { type: "error", message: quota ? AI_QUOTA_MESSAGE : AI_FAILED_MESSAGE };
    }
  } finally {
    running.delete(sentenceId);
  }
  const done = outcome as ExplainEvent | null;
  if (done?.type === "error") {
    update(sentenceId, (chat) => ({ ...chat, pending: null, error: done.message }));
    return;
  }
  // Finished, or stopped by the user: a stopped call still counts (PRD 4.5.1 #8).
  if (done?.type === "done") setRemaining(done.aiRemaining);
  else if (remaining !== null) setRemaining(Math.max(0, remaining - 1));
  const stopped = done === null;
  update(sentenceId, (chat) => {
    const settled = { ...chat, pending: null };
    if (reply.kind === "explain") {
      return stopped ? { ...settled, stoppedExplanation: text } : { ...settled, content: text, stoppedExplanation: null };
    }
    // A stopped answer that said nothing is not kept (the API keeps it the same way).
    if (stopped && text === "") return settled;
    return {
      ...settled,
      messages: [...chat.messages, { role: "user", content: reply.question! }, { role: "assistant", content: text }],
    };
  });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The conversation about one Sentence (null: none selected), loaded when it is first shown, with today's AI calls
 * left and what the panel can do with it.
 */
export function useSentenceChat(sentenceId: string | null) {
  const chat = useSyncExternalStore(subscribe, () => (sentenceId ? (chats.get(sentenceId) ?? EMPTY) : EMPTY));
  const left = useSyncExternalStore(subscribe, () => remaining);
  useEffect(() => {
    if (sentenceId) void load(sentenceId);
  }, [sentenceId]);
  return {
    chat,
    remaining: left,
    /** 【AI 解析】 or regenerate: sent as the user message 解析这句话. */
    explain: () => sentenceId && void call(sentenceId, { kind: "explain", text: "" }),
    ask: (question: string) => sentenceId && void call(sentenceId, { kind: "ask", question, text: "" }),
    /** 【停止】: what was generated stays in the chat. */
    stop: () => sentenceId && running.get(sentenceId)?.abort(),
  };
}

/** Forgets every conversation and stops every reply: on logging out, and between tests. */
export function resetSentenceChats() {
  for (const stop of running.values()) stop.abort();
  running.clear();
  calls.clear();
  chats = new Map();
  remaining = null;
  emit();
}
