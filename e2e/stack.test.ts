// End-to-end functional tests through the running compose stack, from the user's side:
// everything goes through the web origin (nginx → API), and the worker runs for real.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Book, BookDetail, Sentence } from "../api/src/contract.js";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:8080";
const ROOT = new URL("..", import.meta.url).pathname;
const PRIDE_AND_PREJUDICE = new Uint8Array(readFileSync(new URL("../fixtures/pride-and-prejudice.epub", import.meta.url)));

async function api<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}/api${path}`, init);
  return { status: res.status, body: (await res.json()) as T };
}

function upload(name: string, bytes: BlobPart) {
  const form = new FormData();
  form.append("file", new File([bytes], name));
  return api<Book & { error?: { code: string; message: string } }>("/books", { method: "POST", body: form });
}

async function waitWhileParsing(id: string): Promise<BookDetail> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const { body } = await api<BookDetail>(`/books/${id}`);
    if (body.status !== "parsing" || Date.now() > deadline) return body;
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** Runs a Python one-liner inside the worker container; returns its exit status. */
function inWorker(code: string): number {
  try {
    execFileSync("docker", ["compose", "exec", "-T", "worker", "python", "-c", code], { cwd: ROOT, stdio: "pipe" });
    return 0;
  } catch (err) {
    return (err as { status: number }).status;
  }
}

describe("upload a Standard Ebooks EPUB through the stack", () => {
  it("is parsing at first, then generating with all 65 Chapters and their Sentence counts", async () => {
    const created = await upload("pride-and-prejudice.epub", PRIDE_AND_PREJUDICE);
    expect(created.status).toBe(201);
    expect(created.body.status).toBe("parsing");

    const book = await waitWhileParsing(created.body.id);

    expect(book).toMatchObject({ title: "Pride and Prejudice", author: "Jane Austen", status: "generating" });
    expect(book.chapters).toHaveLength(65);
    expect(book.chapters.map((c) => c.title).slice(0, 3)).toEqual(["Titlepage", "Imprint", "I"]);
    expect(book.chapters.map((c) => c.title).slice(-3)).toEqual(["LXI", "Colophon", "Uncopyright"]);
    const body = book.chapters.slice(2, 63);
    expect(body.every((c) => c.sentenceCount > 0)).toBe(true);
    expect(body.reduce((n, c) => n + c.sentenceCount, 0)).toBeGreaterThan(6000);
  });

  it("stores text and spoken_text per Sentence, and Sentence IDs stay the same on every read", async () => {
    const created = await upload("pride-and-prejudice.epub", PRIDE_AND_PREJUDICE);
    const chapterOne = (await waitWhileParsing(created.body.id)).chapters[2]!;

    const first = await api<Sentence[]>(`/chapters/${chapterOne.id}/sentences`);
    expect(first.status).toBe(200);
    expect(first.body).toHaveLength(chapterOne.sentenceCount);
    expect(first.body[1]).toMatchObject({
      text: "It is a truth universally acknowledged, that a single man in possession of a good fortune, must be in want of a wife.",
      spokenText:
        "It is a truth universally acknowledged, that a single man in possession of a good fortune, must be in want of a wife.",
    });

    await new Promise((r) => setTimeout(r, 2500)); // give the worker several poll cycles
    const again = await api<Sentence[]>(`/chapters/${chapterOne.id}/sentences`);
    expect(again.body.map((s) => s.id)).toEqual(first.body.map((s) => s.id));
  });

  it("rejects a non-EPUB file and creates no Book", async () => {
    const before = (await api<Book[]>("/books")).body.length;

    const res = await upload("notes.pdf", new TextEncoder().encode("%PDF-1.7"));

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { code: "unsupported_format", message: "目前只支持 EPUB 格式" } });
    expect((await api<Book[]>("/books")).body.length).toBe(before);
  });
});

describe("the worker only talks to the API", () => {
  it("can reach the API but cannot even resolve the database host", () => {
    expect(inWorker("import socket; socket.create_connection(('api', 3000), 3)")).toBe(0);
    expect(inWorker("import socket; socket.create_connection(('postgres', 5432), 3)")).not.toBe(0);
  });

  it("has no database configuration", () => {
    const env = execFileSync("docker", ["compose", "exec", "-T", "worker", "env"], { cwd: ROOT }).toString();
    expect(env).not.toMatch(/DATABASE|POSTGRES|PG(HOST|USER|PASSWORD)/);
    expect(env).toMatch(/^API_URL=/m);
  });
});
