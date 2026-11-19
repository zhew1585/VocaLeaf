// Shared helpers for the end-to-end tests against the running compose stack.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { Book, BookDetail, UploadPolicy, Voice } from "../api/src/contract.js";

export const BASE = process.env.E2E_BASE_URL ?? "http://localhost:8080";
/** Mailpit's web UI and API, where the stack's login code emails land. */
export const MAILPIT = process.env.E2E_MAILPIT_URL ?? "http://localhost:8025";
export const ROOT = new URL("..", import.meta.url).pathname;
export const WORKER_TOKEN = process.env.WORKER_TOKEN ?? "dev-worker-token-change-me";
/** Must match the stack's JOB_LEASE_SECONDS; `npm run e2e:up` starts it with 5. */
export const LEASE_SECONDS = Number(process.env.E2E_JOB_LEASE_SECONDS ?? 5);
export const PRIDE_AND_PREJUDICE = new Uint8Array(
  readFileSync(new URL("../fixtures/pride-and-prejudice.epub", import.meta.url)),
);
/** The parsing rules sample (worker/tests/sample_epubs.py): Skipped front and back matter, a Preface, Chapter I. */
export const PARSE_RULES = new Uint8Array(readFileSync(new URL("../fixtures/parse-rules.epub", import.meta.url)));
/** Two short Chapters, about 20 s of audio: small enough to generate completely in a test. */
export const SHORT_WALK = new Uint8Array(readFileSync(new URL("../fixtures/short-walk.epub", import.meta.url)));

export async function anonApi<T>(path: string, init?: RequestInit): Promise<{ status: number; res: Response; body: T }> {
  const res = await fetch(`${BASE}/api${path}`, init);
  const text = await res.text();
  return { status: res.status, res, body: (text ? JSON.parse(text) : null) as T };
}

/** Adds emails to the stack's allowlist with the operator script, as an operator would. */
export function allowlist(command: "add" | "remove", email: string): string {
  return compose("exec", "-T", "api", "node", "dist/scripts/allowlist.js", command, email, "--by", "e2e");
}

/** A fresh address for each run, so no earlier run's resend interval or account gets in the way. */
export function freshEmail(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@vocaleaf.test`;
}

async function mailsTo(email: string) {
  const res = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`);
  return (await res.json()) as { messages_count: number; messages: { Subject: string }[] };
}

/** How many emails Mailpit has caught for `email`. */
export async function mailCount(email: string): Promise<number> {
  return (await mailsTo(email)).messages_count;
}

/** The code in the login email that arrives for `email` after the first `seen` ones; waits briefly for it. */
export async function codeFromMailpit(email: string, seen = 0): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const { messages_count, messages } = await mailsTo(email);
    // Newest first.
    const code = messages_count > seen ? messages[0]?.Subject.match(/\d{6}/)?.[0] : undefined;
    if (code) return code;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`no new login email for ${email}`);
}

/** Logs in through the stack exactly as a user does (allowlist, code by email, login); returns the cookie. */
export async function logIn(email: string): Promise<string> {
  const json = (body: unknown) => ({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const seen = await mailCount(email);
  const sent = await anonApi("/auth/code", json({ email }));
  if (sent.status !== 200) throw new Error(`code request failed: ${sent.status}`);
  const res = await anonApi("/auth/login", json({ email, code: await codeFromMailpit(email, seen) }));
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
  return res.res.headers.getSetCookie()[0]!.split(";")[0]!;
}

let session: Promise<string> | undefined;

/** The session cookie of this test file's own user, logged in on first use. */
export function sessionCookie(): Promise<string> {
  session ??= (async () => {
    const email = freshEmail("e2e");
    allowlist("add", email);
    return logIn(email);
  })();
  return session;
}

type UploadResult = Book & { error?: { code: string; message: string } };

/**
 * A user's view of the API: `api` calls a user route with their session, `upload` uploads a file as the dialog
 * does, confirming the upload declaration (PRD 4.1.2) unless `declare` is false.
 */
export function userApi(cookie: () => Promise<string>) {
  async function api<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
    const headers = new Headers(init?.headers);
    headers.set("Cookie", await cookie());
    const { status, body } = await anonApi<T>(path, { ...init, headers });
    return { status, body };
  }
  async function upload(name: string, bytes: BlobPart, { declare = true, voice }: { declare?: boolean; voice?: Voice } = {}) {
    const form = new FormData();
    form.append("file", new File([bytes], name));
    if (voice) form.append("voice", voice);
    if (declare) form.append("declarationVersion", (await api<UploadPolicy>("/upload-policy")).body.declaration.version);
    return api<UploadResult>("/books", { method: "POST", body: form });
  }
  return { api, upload };
}

/** A user of their own, logged in through the stack, for tests that need an empty Shelf or a fresh quota. */
export async function newUser(label: string) {
  const email = freshEmail(label);
  allowlist("add", email);
  const cookie = await logIn(email);
  return { email, cookie, ...userApi(async () => cookie) };
}

const fileUser = userApi(sessionCookie);

/** Calls a user route as this test file's logged-in user. */
export const api = fileUser.api;

/** Uploads a file as this test file's logged-in user. */
export const upload = fileUser.upload;

/** Calls a worker-only route the way the worker does. */
export function asWorker<T>(path: string, body?: unknown) {
  return anonApi<T>(`/internal${path}`, {
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

/** Bytes of a URL under the web origin as the logged-in user's browser gets them, with the content type. */
export async function fetchBytes(path: string, cookie?: string) {
  const res = await fetch(`${BASE}${path}`, { headers: { Cookie: cookie ?? (await sessionCookie()) } });
  return { status: res.status, type: res.headers.get("content-type"), bytes: new Uint8Array(await res.arrayBuffer()) };
}
