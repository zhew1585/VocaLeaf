import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { createApp } from "../src/app.js";
import type { BookDetail, ClaimedJob, ParseResult } from "../src/contract.js";
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

export const TEST_LEASE_MS = 60_000;

/** The real app over an in-process Postgres (PGlite) with the real migrations applied. */
export async function testApp({ leaseMs = TEST_LEASE_MS } = {}) {
  const db = drizzle(new PGlite(), { schema }) as unknown as Db;
  await migrate(db as never, { migrationsFolder: MIGRATIONS_FOLDER });
  const storage = memoryStorage();
  const clock = manualClock();
  const app = createApp({ db, storage, workerToken: WORKER_TOKEN, jobLeaseMs: leaseMs, now: clock.now });
  return { app, db, storage, clock };
}

export type TestApp = Awaited<ReturnType<typeof testApp>>["app"];

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

export function reportFailure(app: TestApp, job: Pick<ClaimedJob, "id" | "attempt">, error: string) {
  return postJson(app, `/api/internal/jobs/${job.id}/failure`, { error, attempt: job.attempt });
}

export async function bookDetail(app: TestApp, id: string) {
  return (await (await app.request(`/api/books/${id}`)).json()) as BookDetail;
}
