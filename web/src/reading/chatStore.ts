// 句子精读's conversation per Sentence (PRD 4.5.1, F11), kept outside React so a reply goes on streaming into its
// own Sentence after the user selects another one (AC-PANEL-14), and shows complete when they come back.
import { useEffect, useSyncExternalStore } from "react";
import { ApiRequestError, getExplanation, streamExplanation, type ChatMessage, type ExplainRequest } from "../api";

/** Shown while no call was refused yet; the same text as the API's AI_QUOTA_MESSAGE (contract.ts). */
export const AI_QUOTA_MESSAGE = "今日 AI 解析次数已用完，明天再来";
/** The API's AI_FAILED_MESSAGE (contract.ts), for failures the API could not report itself (network). */
export const AI_FAILED_MESSAGE = "解析失败，请重试";

/** A reply being generated, to the request it answers: 【AI 解析】 (or regenerate), or a question. */
export type PendingReply = ExplainRequest & { text: string };

/** How a call ended: finished (the API saved it), stopped by the user, or failed. */
type Outcome = { type: "done"; aiRemaining: number } | { type: "stopped" } | { type: "error"; message: string };

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
    // A reply finishing meanwhile knows the count better.
    if (running.size === 0) setRemaining(saved.aiRemaining);
  } catch (err) {
    console.warn(`Loading the conversation of Sentence ${sentenceId} failed`, err);
    update(sentenceId, (chat) => ({ ...chat, loaded: true }));
  }
}

/** Streams the reply into the Sentence's pending text; resolves with what it said and how the call ended. */
async function streamReply(sentenceId: string, reply: PendingReply, stop: AbortController) {
  let text = "";
  let outcome: Outcome | null = null;
  const { text: _, ...request } = reply;
  try {
    await streamExplanation(sentenceId, request, {
      signal: stop.signal,
      onEvent: (event) => {
        if (event.type !== "delta") return void (outcome = event);
        text += event.text;
        update(sentenceId, (chat) => ({ ...chat, pending: { ...reply, text } }));
      },
    });
  } catch (err) {
    if (!stop.signal.aborted) {
      const quota = err instanceof ApiRequestError && err.status === 429;
      if (quota) setRemaining(0);
      outcome = { type: "error", message: quota ? err.message : AI_FAILED_MESSAGE };
    }
  }
  // Set from the event callback, which TypeScript's narrowing does not see.
  const ended = outcome as Outcome | null;
  // Ended with neither done nor error, unasked: the connection broke, which is a failure, not a stop.
  const failed: Outcome = { type: "error", message: AI_FAILED_MESSAGE };
  return { text, outcome: ended ?? (stop.signal.aborted ? ({ type: "stopped" } as const) : failed) };
}

/** Keeps a finished or stopped reply in the chat, as the API keeps it, and counts it (PRD 4.5.1 #7, #8). */
function settle(chat: SentenceChat, reply: PendingReply, text: string, stopped: boolean): SentenceChat {
  const settled = { ...chat, pending: null };
  if (reply.kind === "explain") {
    return stopped ? { ...settled, stoppedExplanation: text } : { ...settled, content: text, stoppedExplanation: null };
  }
  // A stopped answer that said nothing is not kept (the API keeps it the same way).
  if (stopped && text === "") return settled;
  const turns: ChatMessage[] = [
    { role: "user", content: reply.question },
    { role: "assistant", content: text },
  ];
  return { ...settled, messages: [...chat.messages, ...turns] };
}

/** Streams one reply into the Sentence's chat, then keeps it as the API saved it. */
async function call(sentenceId: string, reply: PendingReply) {
  if (running.has(sentenceId)) return;
  const stop = new AbortController();
  running.set(sentenceId, stop);
  calls.set(sentenceId, (calls.get(sentenceId) ?? 0) + 1);
  update(sentenceId, (chat) => ({ ...chat, pending: reply, error: null }));
  const { text, outcome } = await streamReply(sentenceId, reply, stop).finally(() => running.delete(sentenceId));
  if (outcome.type === "error") {
    update(sentenceId, (chat) => ({ ...chat, pending: null, error: outcome.message }));
    return;
  }
  // A stopped call still counts.
  if (outcome.type === "done") setRemaining(outcome.aiRemaining);
  else if (remaining !== null) setRemaining(Math.max(0, remaining - 1));
  update(sentenceId, (chat) => settle(chat, reply, text, outcome.type === "stopped"));
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
