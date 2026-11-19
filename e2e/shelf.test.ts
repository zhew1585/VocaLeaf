// End-to-end: the Shelf and uploading (#7) through the running compose stack, from the user's side. Every call
// goes through the web origin (nginx → API) and the worker parses and narrates for real.
// Needs `npm run e2e:up`.
import { afterAll, describe, expect, it } from "vitest";
import type { Book, BookDetail, Sentence, UploadPolicy } from "../api/src/contract.js";
import {
  endOpenJobs,
  fetchBytes,
  newUser,
  PRIDE_AND_PREJUDICE,
  SHORT_WALK,
  sql,
  upload,
  waitWhileParsing,
} from "./support.js";

// Books uploaded here would otherwise go on generating audio after the tests.
afterAll(() => endOpenJobs());

/** Not a real EPUB: its parse fails at once, so it costs the worker nothing. */
const TINY = new Uint8Array([80, 75, 3, 4]);
const MB = 1024 * 1024;

type User = Awaited<ReturnType<typeof newUser>>;

/** Polls the user's Book until `done` holds. */
async function waitFor(user: User, id: string, done: (b: BookDetail) => boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { body } = await user.api<BookDetail>(`/books/${id}`);
    if (done(body)) return body;
    if (Date.now() > deadline) throw new Error(`book ${id} still ${body.status}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

function listen(user: User, id: string, positionMs: number) {
  return user.api(`/books/${id}/listening`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ positionMs }),
  });
}

async function shelfTitles(user: User) {
  return (await user.api<Book[]>("/books")).body.map((b) => `${b.title}#${b.id.slice(0, 4)}`);
}

describe("uploading (AC-UP-01 to AC-UP-04, PRD 4.1.2)", () => {
  it("asks a new user for the declaration once, logs it, and refuses what the PRD refuses", async () => {
    const user = await newUser("upload");
    const policy = await user.api<UploadPolicy>("/upload-policy");
    expect(policy.body).toMatchObject({ maxFileBytes: 50 * MB, maxBooks: 20, uploadedBooks: 0 });
    expect(policy.body.declaration.accepted).toBe(false);
    expect((await user.api<Book[]>("/books")).body).toEqual([]);

    // AC-UP-04: not confirmed, nothing is created.
    const undeclared = await user.upload("first.epub", TINY, { declare: false });
    expect(undeclared).toMatchObject({ status: 400, body: { error: { code: "declaration_required" } } });

    // AC-UP-01, AC-UP-02: refused with the PRD's message; 60MB goes through nginx and is stopped by the API.
    const pdf = await user.upload("notes.pdf", new TextEncoder().encode("%PDF-1.7"));
    expect(pdf).toMatchObject({ status: 400, body: { error: { message: "目前只支持 EPUB 格式" } } });
    const big = await user.upload("big.epub", new Uint8Array(60 * MB));
    expect(big).toMatchObject({ status: 413, body: { error: { message: "文件不能超过 50MB" } } });
    expect((await user.api<Book[]>("/books")).body).toEqual([]);

    // Confirmed with the first upload, into the audit log: who, when, which version.
    expect((await user.upload("first.epub", TINY)).status).toBe(201);
    expect(sql(`select action, target, result from audit_log where actor = '${user.email}'`)).toEqual([
      `upload_declaration_accept|${policy.body.declaration.version}|ok`,
    ]);
    expect((await user.api<UploadPolicy>("/upload-policy")).body.declaration.accepted).toBe(true);

    // AC-UP-03: the 21st upload is refused; the second upload on needs no declaration.
    for (let i = 2; i <= 20; i++) expect((await user.upload(`book-${i}.epub`, TINY, { declare: false })).status).toBe(201);
    const over = await user.upload("one-more.epub", TINY, { declare: false });
    expect(over).toMatchObject({
      status: 409,
      body: { error: { message: "内测期最多上传 20 本书，可删除不再听的书后再上传" } },
    });
    expect((await user.api<Book[]>("/books")).body).toHaveLength(20);
    expect(sql(`select count(*) from audit_log where actor = '${user.email}'`)).toEqual(["1"]);
  });
});

describe("an uploaded Standard Ebooks EPUB on the Shelf", () => {
  it("is 解析中 at first, then shows its cover to its owner only", async () => {
    const created = await upload("pride-and-prejudice.epub", PRIDE_AND_PREJUDICE);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ status: "parsing", coverUrl: null, listening: null });

    const book = await waitWhileParsing(created.body.id);
    expect(book.coverUrl).toBe(`/api/books/${book.id}/cover`);

    const cover = await fetchBytes(book.coverUrl!);
    expect(cover.status).toBe(200);
    expect(cover.type).toBe("image/jpeg");
    expect([...cover.bytes.slice(0, 3)]).toEqual([0xff, 0xd8, 0xff]);

    const other = await newUser("other");
    expect((await fetchBytes(book.coverUrl!, other.cookie)).status).toBe(404);
    endOpenJobs();
  });
});

describe("listening orders the Shelf and is where a Book resumes (AC-SHELF-01, AC-SHELF-04)", () => {
  it("puts the Book listened to last first, and resumes it at the Sentence reported", async () => {
    const user = await newUser("shelf");
    const a = (await user.upload("short-walk.epub", SHORT_WALK)).body;
    const b = (await user.upload("short-walk.epub", SHORT_WALK)).body;
    const ready = (x: BookDetail) => x.status === "ready";
    const bookA = await waitFor(user, a.id, ready, 150_000);
    await waitFor(user, b.id, ready, 150_000);
    const name = (x: { id: string }) => `${bookA.title}#${x.id.slice(0, 4)}`;
    // Never listened to: newest first.
    expect(await shelfTitles(user)).toEqual([name(b), name(a)]);

    // The player reports a position inside A's second Sentence.
    const sentences = (await user.api<Sentence[]>(`/chapters/${bookA.chapters[0]!.id}/sentences`)).body;
    const second = sentences[1]!;
    expect((await listen(user, a.id, second.startMs! + 200)).status).toBe(204);
    expect(await shelfTitles(user)).toEqual([name(a), name(b)]);

    expect((await listen(user, b.id, 0)).status).toBe(204);
    expect(await shelfTitles(user)).toEqual([name(b), name(a)]);

    // Opening A again resumes it at the start of that Sentence.
    const resumed = (await user.api<BookDetail>(`/books/${a.id}`)).body.listening;
    expect(resumed).toMatchObject({ sentenceId: second.id, startMs: second.startMs, chapterTitle: bookA.chapters[0]!.title });
    expect(resumed!.share).toBeGreaterThan(0);
    expect(resumed!.share).toBeLessThan(1);
  }, 360_000);
});
