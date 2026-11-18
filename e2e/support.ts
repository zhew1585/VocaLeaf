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

export function compose(...args: string[]): string {
  return execFileSync("docker", ["compose", ...args], { cwd: ROOT, stdio: "pipe" }).toString();
}
