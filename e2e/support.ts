// Shared helpers for the end-to-end tests against the running compose stack.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { Book, BookDetail } from "../api/src/contract.js";

export const BASE = process.env.E2E_BASE_URL ?? "http://localhost:8080";
export const ROOT = new URL("..", import.meta.url).pathname;
export const WORKER_TOKEN = process.env.WORKER_TOKEN ?? "dev-worker-token-change-me";
/** Must match the stack's JOB_LEASE_SECONDS; `npm run e2e:up` starts it with 5. */
export const LEASE_SECONDS = Number(process.env.E2E_JOB_LEASE_SECONDS ?? 5);
export const PRIDE_AND_PREJUDICE = new Uint8Array(
  readFileSync(new URL("../fixtures/pride-and-prejudice.epub", import.meta.url)),
);
/** Two short Chapters, about 20 s of audio: small enough to generate completely in a test. */
export const SHORT_WALK = new Uint8Array(readFileSync(new URL("../fixtures/short-walk.epub", import.meta.url)));

export async function api<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}/api${path}`, init);
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

export function upload(name: string, bytes: BlobPart) {
  const form = new FormData();
  form.append("file", new File([bytes], name));
  return api<Book & { error?: { code: string; message: string } }>("/books", { method: "POST", body: form });
}

/** Calls a worker-only route the way the worker does. */
export function asWorker<T>(path: string, body?: unknown) {
  return api<T>(`/internal${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${WORKER_TOKEN}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Polls the Book until it leaves parsing or the timeout passes. */
export async function waitWhileParsing(id: string, timeoutMs = 60_000): Promise<BookDetail> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { body } = await api<BookDetail>(`/books/${id}`);
    if (body.status !== "parsing" || Date.now() > deadline) return body;
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** Polls the Book until `done` holds; returns it, or throws after the timeout. */
export async function waitForBook(
  id: string,
  done: (book: BookDetail) => boolean,
  timeoutMs: number,
  onPoll: (book: BookDetail) => void = () => {},
): Promise<BookDetail> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { body } = await api<BookDetail>(`/books/${id}`);
    onPoll(body);
    if (done(body)) return body;
    if (Date.now() > deadline) throw new Error(`book ${id} still ${body.status} (playable ${body.playable})`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

export function compose(...args: string[]): string {
  return execFileSync("docker", ["compose", ...args], { cwd: ROOT, stdio: "pipe" }).toString();
}

/** Runs SQL in the stack's Postgres and returns the rows as `|`-separated lines. Test-side only. */
export function sql(query: string): string[] {
  const out = compose("exec", "-T", "postgres", "psql", "-U", "vocaleaf", "-At", "-c", query);
  return out.split("\n").filter(Boolean);
}

/**
 * Ends every open job, so the next test starts with an idle worker instead of waiting behind hours of a
 * previous test's Book. Stand-in for deleting a Book (#8): a running job's next heartbeat gets 409 and the
 * worker drops it.
 */
export function endOpenJobs() {
  sql("update jobs set status = 'failed', error = 'e2e cleanup', lease_expires_at = null where status in ('queued', 'running')");
}

/** Bytes of a URL under the web origin, with its content type. */
export async function fetchBytes(path: string) {
  const res = await fetch(`${BASE}${path}`);
  return { status: res.status, type: res.headers.get("content-type"), bytes: new Uint8Array(await res.arrayBuffer()) };
}
