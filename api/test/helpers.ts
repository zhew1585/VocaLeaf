import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { createApp } from "../src/app.js";
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

/** The real app over an in-process Postgres (PGlite) with the real migrations applied. */
export async function testApp() {
  const db = drizzle(new PGlite(), { schema }) as unknown as Db;
  await migrate(db as never, { migrationsFolder: MIGRATIONS_FOLDER });
  const storage = memoryStorage();
  const app = createApp({ db, storage, workerToken: WORKER_TOKEN });
  return { app, db, storage };
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
