// Functional tests of uploading (PRD 4.1.2, 4.3.2, F4) through the HTTP API: the checks that refuse a file before
// any Book exists (AC-UP-01 to AC-UP-04), and the upload rights declaration with its audit log entry.
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  MAX_UPLOAD_BYTES,
  MAX_UPLOADED_BOOKS,
  UPLOAD_DECLARATION,
  type Book,
  type UploadPolicy,
} from "../src/contract.js";
import { allowlist, auditLog, books, users } from "../src/db/schema.js";
import { claim, epubForm, logIn, READER_EMAIL, testApp, uploadBook, withCookie, type TestApp } from "./helpers.js";

function upload(app: TestApp, form: FormData) {
  return app.request("/api/books", { method: "POST", body: form });
}

async function shelf(app: TestApp) {
  return (await (await app.request("/api/books")).json()) as Book[];
}

async function policy(app: TestApp) {
  const res = await app.request("/api/upload-policy");
  expect(res.status).toBe(200);
  return (await res.json()) as UploadPolicy;
}

/** Nothing of a refused upload is left anywhere: no Book, no job, no stored file. */
async function expectNothingCreated(t: Awaited<ReturnType<typeof testApp>>) {
  expect(await shelf(t.app)).toEqual([]);
  expect((await claim(t.app)).status).toBe(204);
  expect(t.storage.objects.size).toBe(0);
}

describe("refused uploads (PRD 4.3.2, 4.3.5 #1 to #3)", () => {
  it.each(["notes.pdf", "notes.txt", "book.epub.zip"])("AC-UP-01: refuses %s as not EPUB", async (name) => {
    const t = await testApp();

    const res = await upload(t.app, epubForm(name));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: "unsupported_format", message: "目前只支持 EPUB 格式" } });
    await expectNothingCreated(t);
  });

  it("AC-UP-02: refuses an EPUB over 50MB", async () => {
    const t = await testApp();

    const res = await upload(t.app, epubForm("big.epub", new Uint8Array(MAX_UPLOAD_BYTES + 1)));

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: { code: "file_too_large", message: "文件不能超过 50MB" } });
    await expectNothingCreated(t);
  });

  it("accepts an EPUB of exactly 50MB", async () => {
    const t = await testApp();

    const res = await upload(t.app, epubForm("big.epub", new Uint8Array(MAX_UPLOAD_BYTES)));

    expect(res.status).toBe(201);
  });

  it("AC-UP-03: refuses the 21st uploaded Book, and counts only the user's own", async () => {
    const t = await testApp();
    // Another user's Books do not count against the reader's quota.
    await t.db.insert(allowlist).values({ email: "other@example.com" });
    const other = withCookie(t.anon, await logIn(t, "other@example.com"));
    await uploadBook(other, "theirs.epub");
    for (let i = 0; i < MAX_UPLOADED_BOOKS; i++) await uploadBook(t.app, `book-${i}.epub`);
    const objects = t.storage.objects.size;

    const res = await upload(t.app, epubForm("one-more.epub"));

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: { code: "upload_limit_reached", message: "内测期最多上传 20 本书，可删除不再听的书后再上传" },
    });
    expect(await shelf(t.app)).toHaveLength(MAX_UPLOADED_BOOKS);
    expect(t.storage.objects.size).toBe(objects);
  });

  it("checks the format before the quota", async () => {
    const t = await testApp();
    for (let i = 0; i < MAX_UPLOADED_BOOKS; i++) await uploadBook(t.app, `book-${i}.epub`);

    const res = await upload(t.app, epubForm("notes.pdf"));

    expect(await res.json()).toMatchObject({ error: { code: "unsupported_format" } });
  });
});

describe("upload rights declaration (PRD 4.1.2)", () => {
  it("is required for the first upload; nothing is created without it", async () => {
    const t = await testApp();
    expect((await policy(t.app)).declaration).toEqual({ ...UPLOAD_DECLARATION, accepted: false });

    const res = await upload(t.app, epubForm("first.epub", undefined, { declaration: null }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: "declaration_required", message: "请先确认上传权利声明" } });
    await expectNothingCreated(t);
    expect(await t.db.select().from(auditLog)).toEqual([]);
  });

  it("is refused when an outdated version is confirmed", async () => {
    const t = await testApp();

    const res = await upload(t.app, epubForm("first.epub", undefined, { declaration: "0" }));

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "declaration_required" } });
  });

  it("is recorded in the audit log once (user, time, version), and not asked again", async () => {
    const t = await testApp();

    expect((await upload(t.app, epubForm("first.epub"))).status).toBe(201);
    expect((await upload(t.app, epubForm("second.epub", undefined, { declaration: null }))).status).toBe(201);

    const log = await t.db.select().from(auditLog);
    expect(log).toMatchObject([
      { actor: READER_EMAIL, action: "upload_declaration_accept", target: UPLOAD_DECLARATION.version, result: "ok" },
    ]);
    expect(log[0]!.createdAt).toBeInstanceOf(Date);
    expect((await policy(t.app)).declaration.accepted).toBe(true);
  });

  it("is asked again after its version changes", async () => {
    const t = await testApp();
    await uploadBook(t.app, "first.epub");
    // As if the user confirmed an earlier version of the text.
    await t.db.update(users).set({ uploadDeclarationVersion: "0" }).where(eq(users.email, READER_EMAIL));

    expect((await policy(t.app)).declaration.accepted).toBe(false);
    expect((await upload(t.app, epubForm("second.epub", undefined, { declaration: null }))).status).toBe(400);
    expect((await upload(t.app, epubForm("second.epub"))).status).toBe(201);
    expect(await t.db.select().from(auditLog)).toHaveLength(2);
  });
});

describe("GET /api/upload-policy", () => {
  it("gives the limits and how many Books the user uploaded so far", async () => {
    const t = await testApp();
    await uploadBook(t.app, "one.epub");
    await uploadBook(t.app, "two.epub");

    expect(await policy(t.app)).toEqual({
      maxFileBytes: MAX_UPLOAD_BYTES,
      maxBooks: MAX_UPLOADED_BOOKS,
      uploadedBooks: 2,
      declaration: { ...UPLOAD_DECLARATION, accepted: true },
    });
  });

  it("needs a session", async () => {
    const t = await testApp();
    expect((await t.anon.request("/api/upload-policy")).status).toBe(401);
  });
});

describe("a successful upload", () => {
  it("puts the new Book on the uploader's Shelf, 解析中", async () => {
    const t = await testApp();

    const book = await uploadBook(t.app, "Walden.epub");

    expect(await shelf(t.app)).toMatchObject([{ id: book.id, title: "Walden", status: "parsing", listening: null }]);
    expect(await t.db.select({ id: books.id }).from(books)).toHaveLength(1);
  });
});
