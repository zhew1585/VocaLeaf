import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Book, BookDetail } from "../src/contract.js";
import { books, jobs } from "../src/db/schema.js";
import { DEV_USER_ID } from "../src/dev-identity.js";
import { epubForm, testApp, uploadBook } from "./helpers.js";

describe("POST /api/books", () => {
  it("stores the file, creates a parsing Book owned by the dev user and queues a parse job", async () => {
    const { app, db, storage } = await testApp();
    const res = await app.request("/api/books", { method: "POST", body: epubForm("Pride and Prejudice.epub") });

    expect(res.status).toBe(201);
    const book = (await res.json()) as Book;
    expect(book).toMatchObject({ title: "Pride and Prejudice", author: null, status: "parsing" });
    expect(storage.objects.get(`books/${book.id}/source.epub`)).toEqual(new Uint8Array([80, 75, 3, 4]));

    const [row] = await db.select().from(books).where(eq(books.id, book.id));
    expect(row).toMatchObject({ ownerId: DEV_USER_ID, fileSize: 4, format: "epub", source: "upload" });
    const queued = await db.select().from(jobs).where(eq(jobs.bookId, book.id));
    expect(queued).toMatchObject([{ type: "parse", status: "queued", attempt: 0 }]);
  });

  it("rejects a request without a file", async () => {
    const { app } = await testApp();
    const res = await app.request("/api/books", { method: "POST", body: new FormData() });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "invalid_request" } });
  });
});

describe("GET /api/books/:id", () => {
  it("returns the Book with no Chapters while parsing", async () => {
    const { app } = await testApp();
    const uploaded = await uploadBook(app);
    const res = await app.request(`/api/books/${uploaded.id}`);
    expect(res.status).toBe(200);
    const detail = (await res.json()) as BookDetail;
    expect(detail).toMatchObject({ id: uploaded.id, status: "parsing", chapters: [] });
  });

  it("returns 404 for an unknown id and for another user's Book", async () => {
    const { app, db } = await testApp();
    expect((await app.request(`/api/books/${crypto.randomUUID()}`)).status).toBe(404);

    const otherId = crypto.randomUUID();
    await db.insert(books).values({ id: otherId, ownerId: crypto.randomUUID(), title: "x", fileSize: 1 });
    expect((await app.request(`/api/books/${otherId}`)).status).toBe(404);
  });

  it("rejects a malformed id", async () => {
    const { app } = await testApp();
    expect((await app.request("/api/books/not-a-uuid")).status).toBe(400);
  });
});

describe("GET /api/openapi.json", () => {
  it("documents the book and worker routes", async () => {
    const { app } = await testApp();
    const doc = (await (await app.request("/api/openapi.json")).json()) as { paths: Record<string, unknown> };
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining([
        "/api/books",
        "/api/books/{id}",
        "/api/internal/jobs/claim",
        "/api/internal/jobs/{id}/parse-result",
        "/api/internal/jobs/{id}/failure",
        "/api/internal/jobs/{id}/heartbeat",
        "/api/internal/jobs/{id}/render-progress",
        "/api/internal/jobs/{id}/render-result",
        "/api/books/{id}/audio.m3u8",
        "/api/books/{id}/segments/{segment}",
      ]),
    );
  });
});
