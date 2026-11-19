// Marks on this device (PRD 4.4.2, F8 异常处理). Marking and unmarking go to the API at once; while the network is
// down (or the API fails for a moment) they wait in an outbox in localStorage and go out once the network is back,
// without bothering the user if that fails. Every change is announced on window (MARKS_CHANGED_EVENT), so each view
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

const OUTBOX_KEY = "vocaleaf:mark-outbox";

function announce(change: MarksChange): void {
  window.dispatchEvent(new CustomEvent<MarksChange>(MARKS_CHANGED_EVENT, { detail: change }));
}

/** A failure worth trying again later: no network, or the API failing for a moment. */
function retryable(err: unknown): boolean {
  return err instanceof ApiRequestError && (err.status === null || err.status >= 500);
}

function readOutbox(): QueuedOp[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(OUTBOX_KEY) ?? "[]");
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
  try {
    if (ops.length === 0) localStorage.removeItem(OUTBOX_KEY);
    else localStorage.setItem(OUTBOX_KEY, JSON.stringify(ops));
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
  watchNetwork();
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

/** Sends what waits in the outbox, oldest first; stops at the first retryable failure and drops the others. */
export function flushOutbox(): Promise<void> {
  flushing ??= (async () => {
    try {
      let sent = false;
      for (let ops = readOutbox(); ops.length > 0; ops = readOutbox()) {
        const next = ops[0]!;
        try {
          if (next.op === "mark") await putMark(next.sentenceId);
          else await deleteMark(next.sentenceId);
          sent = true;
        } catch (err) {
          if (retryable(err)) return;
          // PRD F8: a replay that fails does not bother the user (the Sentence's Book may be gone).
          console.warn(`replaying a queued ${next.op} of Sentence ${next.sentenceId} failed`, err);
        }
        const now = readOutbox();
        // A newer op on the Sentence may have replaced this one meanwhile; leave that one waiting.
        writeOutbox(now.filter((o) => !(o.sentenceId === next.sentenceId && o.op === next.op)));
      }
      // The API now knows; let every view load its Marks again.
      if (sent) announce(null);
    } finally {
      flushing = null;
    }
  })();
  return flushing;
}

let watching = false;

/** Sends the outbox whenever the network comes back. Idempotent. */
function watchNetwork(): void {
  if (watching) return;
  watching = true;
  window.addEventListener("online", () => void flushOutbox());
}

/** Starts the outbox for the logged-in app: sends what a previous visit left, and from then on after outages. */
export function startOutbox(): void {
  watchNetwork();
  void flushOutbox();
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

/** Dismisses a pending Mark (PRD 4.4.4); needs the network, the caller shows a failure. */
export async function dismissSentence(sentenceId: string): Promise<void> {
  await dismissMark(sentenceId);
  announce({ sentenceId, pending: false });
}
