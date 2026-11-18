// Functional tests at the API seam: the user's path from upload to Book detail,
// with the worker side driven only through the /internal HTTP protocol.
import { describe, expect, it } from "vitest";
import type { Book, BookDetail, ClaimedJob, ParseResult, Sentence } from "../src/contract.js";
import { claim, epubForm, postJson, testApp, uploadBook, type TestApp } from "./helpers.js";

const parsed: ParseResult = {
  parserVersion: "test-1",
  title: "Pride and Prejudice",
  author: "Jane Austen",
  chapters: [
    { title: "Titlepage", sentences: [{ paragraphIndex: 0, text: "Pride and Prejudice.", spokenText: "Pride and Prejudice." }] },
    {
      title: "Chapter 1",
      sentences: [
        { paragraphIndex: 0, text: "It is a truth universally acknowledged.", spokenText: "It is a truth universally acknowledged." },
        { paragraphIndex: 0, text: "However little known.", spokenText: "However little known." },
        { paragraphIndex: 1, text: "“My dear Mr. Bennet,” said his lady.", spokenText: "“My dear Mr. Bennet,” said his lady." },
      ],
    },
  ],
};

async function get<T>(app: TestApp, path: string) {
  const res = await app.request(path);
  expect(res.status).toBe(200);
  return (await res.json()) as T;
}

describe("upload an EPUB and see its Chapters", () => {
  it("goes parsing → (worker claims and reports) → generating with every Chapter and its Sentence count", async () => {
    const { app } = await testApp();

    const uploaded = await uploadBook(app, "pride-and-prejudice.epub");
    expect(uploaded.status).toBe("parsing");
    expect((await get<Book[]>(app, "/api/books")).map((b) => [b.id, b.status])).toEqual([[uploaded.id, "parsing"]]);

    const job = (await (await claim(app)).json()) as ClaimedJob;
    expect(job.bookId).toBe(uploaded.id);
    expect((await postJson(app, `/api/internal/jobs/${job.id}/parse-result`, parsed)).status).toBe(204);

    const detail = await get<BookDetail>(app, `/api/books/${uploaded.id}`);
    expect(detail).toMatchObject({ title: "Pride and Prejudice", author: "Jane Austen", status: "generating" });
    expect(detail.chapters.map((c) => [c.title, c.sentenceCount])).toEqual([
      ["Titlepage", 1],
      ["Chapter 1", 3],
    ]);
  });

  it("serves a Chapter's Sentences with text, spoken_text and IDs that never change", async () => {
    const { app } = await testApp();
    const uploaded = await uploadBook(app);
    const job = (await (await claim(app)).json()) as ClaimedJob;
    await postJson(app, `/api/internal/jobs/${job.id}/parse-result`, parsed);
    const chapter = (await get<BookDetail>(app, `/api/books/${uploaded.id}`)).chapters[1]!;

    const first = await get<Sentence[]>(app, `/api/chapters/${chapter.id}/sentences`);
    expect(first.map((s) => [s.index, s.paragraphIndex, s.text, s.spokenText])).toEqual([
      [0, 0, "It is a truth universally acknowledged.", "It is a truth universally acknowledged."],
      [1, 0, "However little known.", "However little known."],
      [2, 1, "“My dear Mr. Bennet,” said his lady.", "“My dear Mr. Bennet,” said his lady."],
    ]);

    // A late duplicate report from the worker must not re-split the Book.
    expect((await postJson(app, `/api/internal/jobs/${job.id}/parse-result`, parsed)).status).toBe(409);
    const again = await get<Sentence[]>(app, `/api/chapters/${chapter.id}/sentences`);
    expect(again.map((s) => s.id)).toEqual(first.map((s) => s.id));
  });

  it("rejects a non-EPUB file without creating a Book or queuing a job", async () => {
    const { app, storage } = await testApp();
    const res = await app.request("/api/books", { method: "POST", body: epubForm("notes.pdf") });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: "unsupported_format", message: "目前只支持 EPUB 格式" } });
    expect(await get<Book[]>(app, "/api/books")).toEqual([]);
    expect((await claim(app)).status).toBe(204);
    expect(storage.objects.size).toBe(0);
  });

  it("does not serve Sentences of an unknown Chapter", async () => {
    const { app } = await testApp();
    expect((await app.request(`/api/chapters/${crypto.randomUUID()}/sentences`)).status).toBe(404);
  });
});
