// Functional tests of the Shelf (PRD 4.2.3, F3) through the HTTP API, with the worker played over /internal:
// its order (AC-SHELF-01), where the user is in each Book (AC-SHELF-04) and its covers.
import { describe, expect, it } from "vitest";
import type { Book, BookDetail, ClaimedParseJob, ParseResult } from "../src/contract.js";
import {
  claimJob,
  generatedBook,
  logIn,
  reportParse,
  testApp,
  uploadBook,
  withCookie,
  type TestApp,
} from "./helpers.js";
import { allowlist, shelfEntries } from "../src/db/schema.js";

type T = Awaited<ReturnType<typeof testApp>>;
const sentence = (text: string, paragraphIndex = 0) => ({ paragraphIndex, text, spokenText: text });

/** Rendered 4 s per Sentence: I runs 0 to 8 s, the Skipped Imprint has no audio, II runs 8 to 20 s. */
const CHAPTERS: ParseResult["chapters"] = [
  { title: "I", sentences: [sentence("It is a truth universally acknowledged."), sentence("However little known.")] },
  { title: "Imprint", skipped: true, sentences: [sentence("This ebook is in the public domain.")] },
  {
    title: "II",
    sentences: [sentence("Mr. Bennet was among the earliest."), sentence("He had always intended."), sentence("Observing.", 1)],
  },
];
const NARRATED_CHARS = [CHAPTERS[0]!, CHAPTERS[2]!].flatMap((c) => c.sentences).reduce((n, s) => n + s.spokenText.length, 0);
const charsOf = (sentences: { spokenText: string }[]) => sentences.reduce((n, s) => n + s.spokenText.length, 0);

async function shelf(app: TestApp) {
  const res = await app.request("/api/books");
  expect(res.status).toBe(200);
  return (await res.json()) as Book[];
}

function listen(app: TestApp, bookId: string, positionMs: number) {
  return app.request(`/api/books/${bookId}/listening`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ positionMs }),
  });
}

async function detail(app: TestApp, id: string) {
  return (await (await app.request(`/api/books/${id}`)).json()) as BookDetail;
}

async function sentenceIds(app: TestApp, chapterId: string): Promise<string[]> {
  return ((await (await app.request(`/api/chapters/${chapterId}/sentences`)).json()) as { id: string }[]).map((s) => s.id);
}

describe("Shelf order (AC-SHELF-01, PRD 4.2.3)", () => {
  it("lists listened Books by when they were last listened to, then the others newest first", async () => {
    const t = await testApp();
    const titles = async () => (await shelf(t.app)).map((b) => b.title);
    const ids: Record<string, string> = {};
    for (const name of ["A", "B", "C", "D"]) {
      ids[name] = (await generatedBook(t, name, CHAPTERS)).id;
      t.clock.advance(1000);
    }
    expect(await titles()).toEqual(["D", "C", "B", "A"]);

    expect((await listen(t.app, ids.A!, 0)).status).toBe(204);
    t.clock.advance(1000);
    expect((await listen(t.app, ids.B!, 0)).status).toBe(204);
    expect(await titles()).toEqual(["B", "A", "D", "C"]);

    // Listening to A again puts it back in front.
    t.clock.advance(1000);
    await listen(t.app, ids.A!, 9000);
    expect(await titles()).toEqual(["A", "B", "D", "C"]);
  });

  it("holds only the user's own Books", async () => {
    const t = await testApp();
    await t.db.insert(allowlist).values({ email: "other@example.com" });
    const other = withCookie(t.anon, await logIn(t, "other@example.com"));
    await uploadBook(other, "Theirs.epub");
    await uploadBook(t.app, "Mine.epub");

    expect((await shelf(t.app)).map((b) => b.title)).toEqual(["Mine"]);
  });
});

describe("where the user is in a Book (AC-SHELF-04)", () => {
  it("records the Sentence at the reported position, and resumes at that Sentence's start", async () => {
    const t = await testApp();
    const book = await generatedBook(t, "Pride and Prejudice", CHAPTERS);
    const chapterTwo = book.chapters.find((c) => c.title === "II")!;
    const [first, second] = await sentenceIds(t.app, chapterTwo.id);
    expect(book.listening).toBeNull();

    // 13 s is 5 s into II: inside its second Sentence (4 to 8 s of the Chapter).
    expect((await listen(t.app, book.id, 13_000)).status).toBe(204);

    // The share is of the Book's audio (20 s), as the 专注页 shows it: 12 s in.
    const listening = {
      sentenceId: second,
      chapterTitle: "II",
      share: 12_000 / 20_000,
      startMs: 12_000,
      listenedAt: t.clock.now().toISOString(),
    };
    expect((await detail(t.app, book.id)).listening).toEqual(listening);
    expect((await shelf(t.app))[0]!.listening).toEqual(listening);

    // The first Sentence of II starts where the Chapter does.
    await listen(t.app, book.id, 8_000);
    expect((await detail(t.app, book.id)).listening).toMatchObject({ sentenceId: first, startMs: 8_000, share: 0.4 });
  });

  it("takes the very start as the first Sentence, with nothing listened before it", async () => {
    const t = await testApp();
    const book = await generatedBook(t, "Pride and Prejudice", CHAPTERS);
    const [first] = await sentenceIds(t.app, book.chapters[0]!.id);

    await listen(t.app, book.id, 0);
    expect((await detail(t.app, book.id)).listening).toMatchObject({ sentenceId: first, share: 0, startMs: 0 });
  });

  it("takes a position past the end as the last Sentence", async () => {
    const t = await testApp();
    const book = await generatedBook(t, "Pride and Prejudice", CHAPTERS);
    const ids = await sentenceIds(t.app, book.chapters[2]!.id);

    await listen(t.app, book.id, 999_000);
    expect((await detail(t.app, book.id)).listening).toMatchObject({ sentenceId: ids.at(-1), chapterTitle: "II" });
  });

  it("is kept per user: another user cannot report on the reader's Book", async () => {
    const t = await testApp();
    const book = await generatedBook(t, "Pride and Prejudice", CHAPTERS);
    await t.db.insert(allowlist).values({ email: "other@example.com" });
    const other = withCookie(t.anon, await logIn(t, "other@example.com"));

    expect((await listen(other, book.id, 0)).status).toBe(404);
    expect((await listen(t.app, crypto.randomUUID(), 0)).status).toBe(404);
    expect((await detail(t.app, book.id)).listening).toBeNull();
  });

  it("counts the share by text while the Sentence has no audio in the Book's playlist", async () => {
    const t = await testApp();
    const book = await uploadBook(t.app);
    const parse = (await claimJob(t.app))!;
    await reportParse(t.app, parse, { parserVersion: "t", title: "T", author: null, chapters: CHAPTERS });
    const chapterTwo = (await detail(t.app, book.id)).chapters[2]!;
    const [, second] = await sentenceIds(t.app, chapterTwo.id);
    // As if it was listened to before its Chapter dropped out of the playlist (a retried Chapter).
    await t.db.update(shelfEntries).set({ sentenceId: second, lastListenedAt: t.clock.now() });

    const before = charsOf(CHAPTERS[0]!.sentences) + charsOf(CHAPTERS[2]!.sentences.slice(0, 1));
    expect((await detail(t.app, book.id)).listening).toMatchObject({ startMs: null, share: before / NARRATED_CHARS });
  });

  it("refuses a negative position", async () => {
    const t = await testApp();
    const book = await uploadBook(t.app);
    expect((await listen(t.app, book.id, -1)).status).toBe(400);
  });
});

describe("covers", () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

  async function parseWithCover(t: T, cover: { contentType: "image/png" } | null) {
    const book = await uploadBook(t.app);
    const job = (await claimJob(t.app)) as ClaimedParseJob;
    expect(job.coverKey).toBe(`books/${book.id}/cover`);
    if (cover) await t.storage.putObject(job.coverKey, PNG, cover.contentType);
    expect((await reportParse(t.app, job, { parserVersion: "t", title: "T", author: null, chapters: CHAPTERS, cover })).status).toBe(204);
    return book;
  }

  it("serves the cover the worker stored, to the Book's owner only", async () => {
    const t = await testApp();
    const book = await parseWithCover(t, { contentType: "image/png" });

    const [onShelf] = await shelf(t.app);
    expect(onShelf!.coverUrl).toBe(`/api/books/${book.id}/cover`);
    const res = await t.app.request(onShelf!.coverUrl!);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);

    await t.db.insert(allowlist).values({ email: "other@example.com" });
    const other = withCookie(t.anon, await logIn(t, "other@example.com"));
    expect((await other.request(onShelf!.coverUrl!)).status).toBe(404);
  });

  it("has no cover URL before parsing or when the EPUB has none", async () => {
    const t = await testApp();
    const parsing = await uploadBook(t.app);
    expect(parsing.coverUrl).toBeNull();
    expect((await t.app.request(`/api/books/${parsing.id}/cover`)).status).toBe(404);

    const t2 = await testApp();
    const book = await parseWithCover(t2, null);
    expect((await detail(t2.app, book.id)).coverUrl).toBeNull();
  });
});
