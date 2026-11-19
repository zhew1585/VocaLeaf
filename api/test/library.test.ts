// Functional tests of the Library (PRD 4.2.2, F6, 6.2) through the ingest function and the HTTP API, with the
// worker played over /internal: ingesting from Standard Ebooks (the download is faked), the 书库 list, putting a
// Library Book on the Shelf and taking it off, and what users share of it and what stays theirs.
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Book, BookDetail, LibraryBook, ParseResult, User } from "../src/contract.js";
import { DEFAULT_VOICE } from "../src/contract.js";
import { allowlist, books, jobs } from "../src/db/schema.js";
import { LIBRARY_BOOKS, standardEbooksEpubUrl, type LibraryEntry } from "../src/library/book-list.js";
import { ingestLibrary, type Fetcher } from "../src/library/ingest.js";
import { sourceKey } from "../src/storage.js";
import {
  claimJob,
  logIn,
  renderAll,
  reportFailure,
  reportParse,
  reportRenderResult,
  testApp,
  uploadBook,
  withCookie,
  type TestApp,
} from "./helpers.js";

type T = Awaited<ReturnType<typeof testApp>>;

const EPUB = new Uint8Array(readFileSync(new URL("../../fixtures/short-walk.epub", import.meta.url)));
const sentence = (text: string, paragraphIndex = 0) => ({ paragraphIndex, text, spokenText: text });
const CHAPTERS: ParseResult["chapters"] = [
  { title: "Cover", skipped: true, sentences: [sentence("Cover.")] },
  { title: "I", sentences: [sentence("The road was long."), sentence("They walked on.")] },
  { title: "II", sentences: [sentence("Night came.")] },
];

const entry = (key: string, title: string, difficulty: LibraryEntry["difficulty"], blurb = `${title} 简介`) => ({
  key,
  title,
  difficulty,
  blurb,
});

/** Serves the fixture EPUB for every URL and records what was asked for. */
function fakeFetcher(bytes: Uint8Array = EPUB) {
  const urls: string[] = [];
  const fetcher: Fetcher = async (url) => {
    urls.push(url);
    return bytes;
  };
  return { urls, fetcher };
}

/**
 * Plays the worker until no job is left: parses each Book into CHAPTERS (titled from the parse, as the EPUB's
 * metadata would) and renders every narrated Chapter. The parse checks the Book's original is in storage.
 */
async function runWorker(t: T, titles: Record<string, string> = {}) {
  for (let job = await claimJob(t.app); job; job = await claimJob(t.app)) {
    if (job.type === "parse") {
      expect(await t.storage.getObject(job.sourceKey)).toBeDefined();
      const title = titles[job.bookId] ?? null;
      const res = await reportParse(t.app, job, { parserVersion: "test-1", title, author: "An Author", chapters: CHAPTERS });
      expect(res.status).toBe(204);
    } else {
      expect(job.voice).toBe(DEFAULT_VOICE);
      expect((await reportRenderResult(t.app, job, await renderAll(t.storage, job))).status).toBe(204);
    }
  }
}

async function library(app: TestApp) {
  const res = await app.request("/api/library");
  expect(res.status).toBe(200);
  return (await res.json()) as LibraryBook[];
}

async function shelf(app: TestApp) {
  return (await (await app.request("/api/books")).json()) as Book[];
}

const addToShelf = (app: TestApp, id: string) => app.request(`/api/books/${id}/shelf`, { method: "PUT" });
const removeFromShelf = (app: TestApp, id: string) => app.request(`/api/books/${id}/shelf`, { method: "DELETE" });
const listen = (app: TestApp, id: string, positionMs: number) =>
  app.request(`/api/books/${id}/listening`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ positionMs }),
  });

/** A second user on their own device. */
async function otherUser(t: T, email = "other@example.com") {
  await t.db.insert(allowlist).values({ email });
  return withCookie(t.anon, await logIn(t, email));
}

/** Ingests `entries` and generates them all; returns the Library Book ids by book list key. */
async function readyLibrary(t: T, entries: LibraryEntry[]) {
  const results = await ingestLibrary({ db: t.db, storage: t.storage, fetcher: fakeFetcher().fetcher }, entries);
  const ids = Object.fromEntries(results.map((r) => [r.key, r.outcome === "failed" ? "" : r.bookId]));
  await runWorker(t, Object.fromEntries(entries.map((e) => [ids[e.key]!, e.title])));
  return ids;
}

describe("ingesting Library Books (PRD 4.2.2, 6.2)", () => {
  it("downloads each Standard Ebooks EPUB and puts it through the parse and render pipeline with the default Voice", async () => {
    const t = await testApp();
    const { urls, fetcher } = fakeFetcher();
    const results = await ingestLibrary({ db: t.db, storage: t.storage, fetcher }, [
      entry("jane-austen/pride-and-prejudice", "Pride and Prejudice", "intermediate"),
    ]);

    expect(urls).toEqual([
      "https://standardebooks.org/ebooks/jane-austen/pride-and-prejudice/downloads/jane-austen_pride-and-prejudice.epub?source=download",
    ]);
    expect(results).toEqual([{ key: "jane-austen/pride-and-prejudice", outcome: "queued", bookId: expect.any(String) }]);
    const bookId = (results[0] as { bookId: string }).bookId;
    expect(t.storage.objects.get(sourceKey(bookId))).toEqual(EPUB);
    const [row] = await t.db.select().from(books).where(eq(books.id, bookId));
    expect(row).toMatchObject({
      source: "library",
      ownerId: null,
      status: "parsing",
      voice: DEFAULT_VOICE,
      difficulty: "intermediate",
      fileSize: EPUB.length,
    });

    // Not listed while it generates: 【加入书架并播放】 must play at once (AC-LIB-01).
    expect(await library(t.app)).toEqual([]);
    await runWorker(t, { [bookId]: "Pride and Prejudice" });
    expect(await library(t.app)).toEqual([
      {
        id: bookId,
        title: "Pride and Prejudice",
        author: "An Author",
        difficulty: "intermediate",
        blurb: "Pride and Prejudice 简介",
        coverUrl: null,
        onShelf: false,
      },
    ]);
    // A Library Book is on no one's Shelf until they add it.
    expect(await shelf(t.app)).toEqual([]);
  });

  it("does not download a Book again when run twice, but follows the book list's difficulty and blurb", async () => {
    const t = await testApp();
    const { urls, fetcher } = fakeFetcher();
    const first = await ingestLibrary({ db: t.db, storage: t.storage, fetcher }, [entry("a/b", "B", "beginner", "旧")]);
    const again = await ingestLibrary({ db: t.db, storage: t.storage, fetcher }, [entry("a/b", "B", "advanced", "新")]);

    expect(urls).toHaveLength(1);
    expect(again).toEqual([{ key: "a/b", outcome: "updated", bookId: (first[0] as { bookId: string }).bookId }]);
    expect(await t.db.select({ difficulty: books.difficulty, blurb: books.blurb }).from(books)).toEqual([
      { difficulty: "advanced", blurb: "新" },
    ]);
    expect(await t.db.select().from(jobs)).toHaveLength(1);
  });

  it("ingests a Book again whose parse failed, and generates failed Chapters again, when run again", async () => {
    const t = await testApp();
    const { urls, fetcher } = fakeFetcher();
    const list = [entry("k/drm", "Drm", "beginner"), entry("k/flaky", "Flaky", "beginner")];
    const [drm, flaky] = (await ingestLibrary({ db: t.db, storage: t.storage, fetcher }, list)) as { bookId: string }[];
    // The worker refuses the first file and fails every attempt at Chapter II of the second.
    for (let job = await claimJob(t.app); job; job = await claimJob(t.app)) {
      if (job.type === "parse" && job.bookId === drm!.bookId) await reportFailure(t.app, job, "encrypted", "drm");
      else if (job.type === "parse") await reportParse(t.app, job, { parserVersion: "t", title: "Flaky", author: null, chapters: CHAPTERS });
      else if (job.sentences.length === 1) await reportFailure(t.app, job, "tts down");
      else await reportRenderResult(t.app, job, await renderAll(t.storage, job));
    }
    // Ready with a failed Chapter: not listed, and not to be added, since it would stop halfway.
    expect(await library(t.app)).toEqual([]);
    expect((await addToShelf(t.app, flaky!.bookId)).status).toBe(404);

    const again = await ingestLibrary({ db: t.db, storage: t.storage, fetcher }, list);

    expect(again).toEqual([
      { key: "k/drm", outcome: "queued", bookId: expect.not.stringMatching(drm!.bookId) },
      { key: "k/flaky", outcome: "retried", bookId: flaky!.bookId, chapters: 1 },
    ]);
    expect(urls).toHaveLength(3);
    expect(t.storage.objects.has(sourceKey(drm!.bookId))).toBe(false);
    await runWorker(t, { [(again[0] as { bookId: string }).bookId]: "Drm" });
    expect((await library(t.app)).map((b) => b.title)).toEqual(["Drm", "Flaky"]);
  });

  it("reports a failed download or a file that is not an EPUB, creates nothing for it and goes on", async () => {
    const t = await testApp();
    const fetcher: Fetcher = async (url) => {
      if (url.includes("broken")) throw new Error("HTTP 404");
      if (url.includes("html")) return new TextEncoder().encode("<!doctype html>");
      return EPUB;
    };
    const results = await ingestLibrary({ db: t.db, storage: t.storage, fetcher }, [
      entry("x/broken", "Broken", "beginner"),
      entry("x/html", "Html", "beginner"),
      entry("x/fine", "Fine", "beginner"),
    ]);

    expect(results.map((r) => [r.key, r.outcome])).toEqual([
      ["x/broken", "failed"],
      ["x/html", "failed"],
      ["x/fine", "queued"],
    ]);
    expect(results[0]).toMatchObject({ error: "download failed: HTTP 404" });
    expect(results[1]).toMatchObject({ error: "not an EPUB (no ZIP header)" });
    expect(await t.db.select({ key: books.libraryKey }).from(books)).toEqual([{ key: "x/fine" }]);
  });

  it("has a book list of Standard Ebooks Books in every difficulty group, each with a blurb", () => {
    expect(new Set(LIBRARY_BOOKS.map((e) => e.difficulty))).toEqual(new Set(["beginner", "intermediate", "advanced"]));
    expect(new Set(LIBRARY_BOOKS.map((e) => e.key)).size).toBe(LIBRARY_BOOKS.length);
    for (const e of LIBRARY_BOOKS) expect(e.blurb.length).toBeGreaterThan(0);
    expect(standardEbooksEpubUrl("lewis-carroll/alices-adventures-in-wonderland/john-tenniel")).toBe(
      "https://standardebooks.org/ebooks/lewis-carroll/alices-adventures-in-wonderland/john-tenniel/downloads/lewis-carroll_alices-adventures-in-wonderland_john-tenniel.epub?source=download",
    );
  });
});

describe("the 书库 (F6, PRD 4.2.2)", () => {
  it("groups Books as 入门, 中级, 进阶 and sorts each group by title", async () => {
    const t = await testApp();
    await readyLibrary(t, [
      entry("k/walden", "Walden", "advanced"),
      entry("k/pride", "Pride and Prejudice", "intermediate"),
      entry("k/oz", "The Wonderful Wizard of Oz", "beginner"),
      entry("k/gatsby", "great Gatsby", "intermediate"),
      entry("k/alice", "Alice", "beginner"),
      entry("k/frank", "Frankenstein", "advanced"),
    ]);

    expect((await library(t.app)).map((b) => `${b.difficulty} ${b.title}`)).toEqual([
      "beginner Alice",
      "beginner The Wonderful Wizard of Oz",
      "intermediate great Gatsby",
      "intermediate Pride and Prejudice",
      "advanced Frankenstein",
      "advanced Walden",
    ]);
  });

  it("puts a Library Book on the Shelf and plays it at once; the 书库 then shows it 已在书架 (AC-LIB-01, AC-LIB-02)", async () => {
    const t = await testApp();
    const { "k/walk": id } = await readyLibrary(t, [entry("k/walk", "A Short Walk", "beginner")]);

    expect((await addToShelf(t.app, id!)).status).toBe(204);
    expect(await library(t.app)).toMatchObject([{ id, onShelf: true }]);
    const [onShelf] = await shelf(t.app);
    expect(onShelf).toMatchObject({ id, source: "library", status: "ready", playable: true, listening: null });

    // The 专注页's requests all work for it: detail, playlist, segments, timeline, Sentences.
    const detail = (await (await t.app.request(`/api/books/${id}`)).json()) as BookDetail;
    expect(detail).toMatchObject({ source: "library", status: "ready" });
    const playlist = await t.app.request(`/api/books/${id}/audio.m3u8`);
    expect(playlist.status).toBe(200);
    const segment = (await playlist.text()).split("\n").find((l) => l.endsWith(".ts"))!;
    expect((await t.app.request(`/api/books/${id}/${segment}`)).status).toBe(200);
    expect((await t.app.request(`/api/books/${id}/timeline`)).status).toBe(200);
    expect((await t.app.request(`/api/chapters/${detail.chapters[1]!.id}/sentences`)).status).toBe(200);

    // Adding again keeps the place the user is at.
    expect((await listen(t.app, id!, 4500)).status).toBe(204);
    expect((await addToShelf(t.app, id!)).status).toBe(204);
    expect((await shelf(t.app))[0]!.listening).toMatchObject({ startMs: 4000 });
  });

  it("shares a Library Book's text and audio while each user keeps their own Shelf and progress (PRD 4.2.2)", async () => {
    const t = await testApp();
    const { "k/walk": id } = await readyLibrary(t, [entry("k/walk", "A Short Walk", "beginner")]);
    const other = await otherUser(t);

    // Readable before it is on the Shelf, as the 书库 shows its cover.
    expect((await other.request(`/api/books/${id}`)).status).toBe(200);
    await addToShelf(t.app, id!);
    await addToShelf(other, id!);
    await listen(t.app, id!, 4500);

    expect((await shelf(t.app))[0]!.listening).toMatchObject({ startMs: 4000 });
    expect((await shelf(other))[0]!.listening).toBeNull();
    // One Book, generated once.
    expect(await t.db.select({ id: books.id }).from(books)).toHaveLength(1);
  });

  it("takes a Library Book off the Shelf with the user's progress and keeps it for everyone else (PRD 4.2.3)", async () => {
    const t = await testApp();
    const { "k/walk": id } = await readyLibrary(t, [entry("k/walk", "A Short Walk", "beginner")]);
    const other = await otherUser(t);
    await addToShelf(t.app, id!);
    await addToShelf(other, id!);
    await listen(t.app, id!, 4500);
    await listen(other, id!, 4500);

    expect((await removeFromShelf(t.app, id!)).status).toBe(204);
    expect(await shelf(t.app)).toEqual([]);
    expect(await library(t.app)).toMatchObject([{ id, onShelf: false }]);
    expect((await shelf(other))[0]!.listening).toMatchObject({ startMs: 4000 });
    expect((await other.request(`/api/books/${id}/audio.m3u8`)).status).toBe(200);

    // Added back, it starts over.
    await addToShelf(t.app, id!);
    expect((await shelf(t.app))[0]!.listening).toBeNull();
  });

  it("lets no user delete a Library Book or retry its Chapters, and keeps uploads apart from it", async () => {
    const t = await testApp();
    const { "k/walk": id } = await readyLibrary(t, [entry("k/walk", "A Short Walk", "beginner")]);
    const chapterId = ((await (await t.app.request(`/api/books/${id}`)).json()) as BookDetail).chapters[1]!.id;

    expect((await t.app.request(`/api/books/${id}`, { method: "DELETE" })).status).toBe(404);
    expect((await t.app.request(`/api/chapters/${chapterId}/retry`, { method: "POST" })).status).toBe(404);

    // An uploaded Book is deleted, not taken off the Shelf; another user's upload is not theirs to add.
    const upload = await uploadBook(t.app);
    expect((await removeFromShelf(t.app, upload.id)).status).toBe(409);
    const other = await otherUser(t);
    expect((await addToShelf(other, upload.id)).status).toBe(404);
    expect((await other.request(`/api/books/${upload.id}`)).status).toBe(404);
    expect((await addToShelf(t.app, crypto.randomUUID())).status).toBe(404);
    // Library Books do not count against the upload quota.
    await addToShelf(t.app, id!);
    expect(await (await t.app.request("/api/upload-policy")).json()).toMatchObject({ uploadedBooks: 1 });
  });
});

describe("first-play guide (F2, AC-GUIDE-02)", () => {
  it("is unseen for a new user and seen once they closed it, on every device", async () => {
    const t = await testApp();
    const me = async (app: TestApp) => (await (await app.request("/api/me")).json()) as User;
    expect(await me(t.app)).toMatchObject({ playGuideSeen: false });

    expect((await t.app.request("/api/me/play-guide", { method: "PUT" })).status).toBe(204);
    expect(await me(t.app)).toMatchObject({ playGuideSeen: true });
    const laptop = withCookie(t.anon, await logIn(t, "reader@example.com"));
    expect(await me(laptop)).toMatchObject({ playGuideSeen: true });
    // Closing it again (reopened from the settings) changes nothing.
    expect((await laptop.request("/api/me/play-guide", { method: "PUT" })).status).toBe(204);
  });
});
