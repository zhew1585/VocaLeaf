import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { createApp } from "../src/app.js";
import type { Mailer } from "../src/auth/mailer.js";
import { SESSION_COOKIE } from "../src/auth/session.js";
import type {
  BookDetail,
  ClaimedJob,
  ClaimedRenderJob,
  ParseFailureReason,
  ParseResult,
  RenderReport,
} from "../src/contract.js";
import { MIGRATIONS_FOLDER, type Db } from "../src/db/client.js";
import * as schema from "../src/db/schema.js";
import type { ObjectStorage } from "../src/storage.js";

export const WORKER_TOKEN = "test-worker-token-0123456789";
export const workerHeaders = { Authorization: `Bearer ${WORKER_TOKEN}` };

/** In-memory object storage for tests. */
export function memoryStorage(): ObjectStorage & { objects: Map<string, Uint8Array> } {
  const objects = new Map<string, Uint8Array>();
  return {
    objects,
    async putObject(key, body) {
      objects.set(key, body);
    },
    async getObject(key) {
      return objects.get(key);
    },
  };
}

/** A clock tests move by hand, so lease expiry needs no sleeping. */
export function manualClock(start = new Date("2026-11-18T00:00:00Z")) {
  let now = start.getTime();
  return {
    now: () => new Date(now),
    advance(ms: number) {
      now += ms;
    },
  };
}

/** Keeps every login code it is asked to send instead of emailing it. */
export function recordingMailer(): Mailer & { sent: { email: string; code: string }[]; lastCode(email: string): string } {
  const sent: { email: string; code: string }[] = [];
  return {
    sent,
    async sendLoginCode(email, code) {
      sent.push({ email, code });
    },
    lastCode(email) {
      const mail = sent.findLast((m) => m.email === email);
      if (!mail) throw new Error(`no code sent to ${email}`);
      return mail.code;
    },
  };
}

export const TEST_LEASE_MS = 60_000;
export const READER_EMAIL = "reader@example.com";

type RawApp = ReturnType<typeof createApp>;
/** Anything that answers requests like the app: the app itself, or the app as a logged-in user. */
export type TestApp = Pick<RawApp, "request">;

/** The `name=value` of the session cookie a response sets, for sending back as a Cookie header. */
export function sessionCookie(res: Response): string {
  const set = res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  if (!set) throw new Error("no session cookie set");
  return set.split(";")[0]!;
}

/** The app as seen by a device holding `cookie`: every request carries it. */
export function withCookie(app: TestApp, cookie: string): TestApp {
  return {
    request: (input, init, ...rest) => {
      const headers = new Headers(init?.headers);
      headers.set("Cookie", cookie);
      return app.request(input, { ...init, headers }, ...rest);
    },
  };
}

export function postAuth(app: TestApp, path: string, body: unknown) {
  return app.request(`/api/auth/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Logs in through the real code flow as an allowlisted email; returns the session cookie. */
export async function logIn(
  { anon, mailer }: { anon: TestApp; mailer: ReturnType<typeof recordingMailer> },
  email: string,
): Promise<string> {
  const sent = await postAuth(anon, "code", { email });
  if (sent.status !== 200) throw new Error(`code request failed: ${sent.status} ${await sent.text()}`);
  const res = await postAuth(anon, "login", { email, code: mailer.lastCode(email) });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${await res.text()}`);
  return sessionCookie(res);
}

/**
 * The real app over an in-process Postgres (PGlite) with the real migrations applied.
 * `app` is a device logged in as READER_EMAIL (every user route needs a session); `anon` has no session.
 */
export async function testApp({ leaseMs = TEST_LEASE_MS, secureCookie = false } = {}) {
  const db = drizzle(new PGlite(), { schema }) as unknown as Db;
  await migrate(db as never, { migrationsFolder: MIGRATIONS_FOLDER });
  const storage = memoryStorage();
  const clock = manualClock();
  const mailer = recordingMailer();
  const anon: RawApp = createApp({
    db,
    storage,
    mailer,
    secureCookie,
    workerToken: WORKER_TOKEN,
    jobLeaseMs: leaseMs,
    now: clock.now,
  });
  await db.insert(schema.allowlist).values({ email: READER_EMAIL });
  const app = withCookie(anon, await logIn({ anon, mailer }, READER_EMAIL));
  return { app, anon, db, storage, clock, mailer };
}

export function epubForm(name = "Pride and Prejudice.epub", bytes = new Uint8Array([80, 75, 3, 4])) {
  const form = new FormData();
  form.append("file", new File([bytes], name, { type: "application/epub+zip" }));
  return form;
}

export async function uploadBook(app: TestApp, name?: string) {
  const res = await app.request("/api/books", { method: "POST", body: epubForm(name) });
  if (res.status !== 201) throw new Error(`upload failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as { id: string; title: string; status: string };
}

export async function claim(app: TestApp) {
  return app.request("/api/internal/jobs/claim", { method: "POST", headers: workerHeaders });
}

export function postJson(app: TestApp, path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { ...workerHeaders, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Claims the next job as a worker would; undefined when none is handed out. */
export async function claimJob(app: TestApp): Promise<ClaimedJob | undefined> {
  const res = await claim(app);
  return res.status === 200 ? ((await res.json()) as ClaimedJob) : undefined;
}

/** Reports a parse result for a claimed job, carrying the attempt it was claimed with. */
export function reportParse(app: TestApp, job: Pick<ClaimedJob, "id" | "attempt">, result: Omit<ParseResult, "attempt">) {
  return postJson(app, `/api/internal/jobs/${job.id}/parse-result`, { ...result, attempt: job.attempt });
}

export function reportFailure(
  app: TestApp,
  job: Pick<ClaimedJob, "id" | "attempt">,
  error: string,
  reason?: ParseFailureReason,
) {
  return postJson(app, `/api/internal/jobs/${job.id}/failure`, { error, attempt: job.attempt, reason });
}

export async function bookDetail(app: TestApp, id: string) {
  return (await (await app.request(`/api/books/${id}`)).json()) as BookDetail;
}

/** Sends a heartbeat for a claimed job, keeping its lease. */
export function heartbeat(app: TestApp, job: Pick<ClaimedJob, "id" | "attempt">) {
  return postJson(app, `/api/internal/jobs/${job.id}/heartbeat`, { attempt: job.attempt });
}

type Report = Omit<RenderReport, "attempt">;

/** Reports segments and Sentences rendered so far, with the Chapter still generating. */
export function reportRenderProgress(app: TestApp, job: Pick<ClaimedJob, "id" | "attempt">, report: Report) {
  return postJson(app, `/api/internal/jobs/${job.id}/render-progress`, { ...report, attempt: job.attempt });
}

/** Reports the last segments and Sentences of a Chapter and finishes it. */
export function reportRenderResult(app: TestApp, job: Pick<ClaimedJob, "id" | "attempt">, report: Report) {
  return postJson(app, `/api/internal/jobs/${job.id}/render-result`, { ...report, attempt: job.attempt });
}

/**
 * Plays the worker's part for one claimed render job: writes one segment per Sentence into storage
 * (each Sentence lasts `sentenceMs`) and returns the matching report.
 */
export async function renderAll(
  storage: ObjectStorage,
  job: ClaimedRenderJob,
  sentenceMs = 4000,
): Promise<Report> {
  const segments = [];
  const sentences = [];
  for (const [i, s] of job.sentences.entries()) {
    const key = `${job.audioPrefix}seg-${String(i).padStart(5, "0")}.ts`;
    await storage.putObject(key, new TextEncoder().encode(`audio of ${s.id}`), "video/mp2t");
    segments.push({ index: i, key, durationMs: sentenceMs });
    sentences.push({
      id: s.id,
      startMs: i * sentenceMs,
      endMs: (i + 1) * sentenceMs - 300,
      wordTimings: [{ word: s.spokenText.split(" ")[0]!, startMs: 0, endMs: 400 }],
    });
  }
  return { segments, sentences };
}
