// Marks on this device (PRD 4.4.2, F8 异常处理). Marking and unmarking go to the API at once; while the network is
// down they wait in the logged-in user's outbox in localStorage and go out once it is back (the browser says so, or
// a retry a little later gets through), without bothering the user if that fails. Every change is announced on window (MARKS_CHANGED_EVENT), so each view
// of Marks follows: the reading view's underlines, 句子精读's leaf, the navigation's count.
import { ApiRequestError, deleteMark, dismissMark, putMark, type MarkResult } from "../api";

export const MARKS_CHANGED_EVENT = "vocaleaf:marks-changed";

/** MARKS_CHANGED_EVENT's detail: one Sentence's Mark became pending or stopped being; null when anything may have. */
export type MarksChange = { sentenceId: string; pending: boolean } | null;

/** What marking did; `queued` when it waits in the outbox for the network. */
export type MarkOutcome = MarkResult["result"] | "queued";

interface QueuedOp {
  sentenceId: string;
  op: "mark" | "unmark";
}

/** How long a failed send waits before the outbox tries again, for outages the browser does not notice. */
const RETRY_MS = 30_000;

/** The outbox of the user logged in on this device (startOutbox); null while nobody is. */
let outboxKey: string | null = null;

function announce(change: MarksChange): void {
  window.dispatchEvent(new CustomEvent<MarksChange>(MARKS_CHANGED_EVENT, { detail: change }));
}

/** A failure worth trying again later: the request never reached the API. */
function retryable(err: unknown): boolean {
  return err instanceof ApiRequestError && err.status === null;
}

function readOutbox(): QueuedOp[] {
  if (outboxKey === null) return [];
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(outboxKey) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter(isQueuedOp) : [];
  } catch {
    return [];
  }
}

function isQueuedOp(value: unknown): value is QueuedOp {
  const op = value as QueuedOp | null;
  return typeof op?.sentenceId === "string" && (op.op === "mark" || op.op === "unmark");
}

function writeOutbox(ops: QueuedOp[]): void {
  if (outboxKey === null) return;
  try {
    if (ops.length === 0) localStorage.removeItem(outboxKey);
    else localStorage.setItem(outboxKey, JSON.stringify(ops));
  } catch (err) {
    // Storage full or blocked: the op is lost, as it would be without an outbox.
    console.warn("saving the mark outbox failed", err);
  }
}

/** The latest op on a Sentence replaces any older one still waiting, so the outbox replays only the last word. */
function dropQueued(sentenceId: string): void {
  const ops = readOutbox();
  if (ops.some((o) => o.sentenceId === sentenceId)) writeOutbox(ops.filter((o) => o.sentenceId !== sentenceId));
}

function enqueue(op: QueuedOp): void {
  writeOutbox([...readOutbox().filter((o) => o.sentenceId !== op.sentenceId), op]);
  retryLater();
}

let retryTimer: ReturnType<typeof setTimeout> | undefined;

/** Tries the outbox again in a while, unless a try is already planned. */
function retryLater(): void {
  if (retryTimer !== undefined) return;
  retryTimer = setTimeout(() => {
    retryTimer = undefined;
    void flushOutbox();
  }, RETRY_MS);
}

/**
 * Applies the ops still waiting to a set of pending Sentences loaded from the API, so a reload while offline still
 * shows the Marks made on this device.
 */
export function withQueued(pending: Iterable<string>): Set<string> {
  const out = new Set(pending);
  for (const { sentenceId, op } of readOutbox()) {
    if (op === "mark") out.add(sentenceId);
    else out.delete(sentenceId);
  }
  return out;
}

let flushing: Promise<void> | null = null;

/**
 * Sends what waits in the outbox, oldest first. An op the API refuses is dropped; at the first one that does not
 * reach the API, the rest stay for a later try.
 */
export function flushOutbox(): Promise<void> {
  // Cleared in finally, which runs after this assignment even when there is nothing to send.
  if (flushing === null) flushing = sendQueued().finally(() => (flushing = null));
  return flushing;
}

async function sendQueued(): Promise<void> {
  let replayed = false;
  for (let ops = readOutbox(); ops.length > 0; ops = readOutbox()) {
    const next = ops[0]!;
    try {
      if (next.op === "mark") await putMark(next.sentenceId);
      else await deleteMark(next.sentenceId);
    } catch (err) {
      if (retryable(err)) return retryLater();
      // PRD F8: a replay that fails does not bother the user (the Sentence's Book may be gone).
      console.warn(`replaying a queued ${next.op} of Sentence ${next.sentenceId} failed`, err);
    }
    replayed = true;
    // A newer op on the Sentence may have replaced this one meanwhile; leave that one waiting.
    writeOutbox(readOutbox().filter((o) => !(o.sentenceId === next.sentenceId && o.op === next.op)));
  }
  // The API has the last word now, also on ops it refused; let every view load its Marks again.
  if (replayed) announce(null);
}

let watching = false;

/** Sends the outbox whenever the network comes back. Idempotent. */
function watchNetwork(): void {
  if (watching) return;
  watching = true;
  window.addEventListener("online", () => void flushOutbox());
}

/**
 * Starts the outbox of the user logged in on this device: sends what their previous visit left, and from then on
 * after outages. Each user has their own, so nobody replays another user's Marks.
 */
export function startOutbox(userId: string): void {
  outboxKey = `vocaleaf:mark-outbox:${userId}`;
  watchNetwork();
  void flushOutbox();
}

/** Logged out: what waits stays for that user's next login on this device. */
export function stopOutbox(): void {
  outboxKey = null;
  clearTimeout(retryTimer);
  retryTimer = undefined;
}

/**
 * Marks a Sentence (PRD 4.4.2). Announced as pending at once; waits in the outbox when the network is down.
 * Rejects (and takes the Mark back) when the API refuses it.
 */
export async function markSentence(sentenceId: string): Promise<MarkOutcome> {
  dropQueued(sentenceId);
  announce({ sentenceId, pending: true });
  try {
    return (await putMark(sentenceId)).result;
  } catch (err) {
    if (retryable(err)) {
      enqueue({ sentenceId, op: "mark" });
      return "queued";
    }
    announce({ sentenceId, pending: false });
    throw err;
  }
}

/** Deletes a Sentence's Mark (撤销, 取消标记). Announced at once; waits in the outbox when the network is down. */
export async function unmarkSentence(sentenceId: string): Promise<void> {
  dropQueued(sentenceId);
  announce({ sentenceId, pending: false });
  try {
    await deleteMark(sentenceId);
  } catch (err) {
    if (!retryable(err)) throw err;
    enqueue({ sentenceId, op: "unmark" });
  }
}

/** A Card was made of the Sentence: the API processed its pending Mark (PRD 4.5.2 规则 7), so it is pending no more. */
export function announceCardMade(sentenceId: string): void {
  announce({ sentenceId, pending: false });
}

/** Dismisses the pending Mark of a Sentence (PRD 4.4.4); needs the network, the caller shows a failure. */
export async function dismissFromGleanings(sentenceId: string): Promise<void> {
  await dismissMark(sentenceId);
  announce({ sentenceId, pending: false });
}
