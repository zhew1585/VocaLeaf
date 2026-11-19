// Ingesting Library Books (PRD 4.2.2, 6.2): download each EPUB of the book list and put it through the same pipeline as an
// upload (parse job, then one render job per narrated Chapter, by the worker) with the default Voice. The audio is
// generated once and shared by every user.
import { and, eq } from "drizzle-orm";
import { MAX_UPLOAD_BYTES } from "../contract.js";
import type { Db } from "../db/client.js";
import { books, chapters, jobs } from "../db/schema.js";
import { retryFailedChapter } from "../jobs/lifecycle.js";
import { bookPrefix, sourceKey, type ObjectStorage } from "../storage.js";
import { standardEbooksEpubUrl, type LibraryEntry } from "./book-list.js";

/** Downloads a file; injectable so tests need no network. Rejects when the download fails. */
export type Fetcher = (url: string) => Promise<Uint8Array>;

export type IngestResult =
  /** Downloaded and queued for parsing: the worker parses and narrates it from here. */
  | { key: string; outcome: "queued"; bookId: string }
  /** In the Library already: only its difficulty and blurb were brought up to date with the book list. */
  | { key: string; outcome: "updated"; bookId: string }
  /** In the Library with Chapters whose generation failed: those were queued again, as 重试 does for an upload. */
  | { key: string; outcome: "retried"; bookId: string; chapters: number }
  | { key: string; outcome: "failed"; error: string };

/** Every EPUB is a ZIP archive, which starts with these bytes. */
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
const DOWNLOAD_TIMEOUT_MS = 120_000;

/** Fetches over HTTP(S) with a timeout, refusing anything but a 200. */
export const httpFetcher: Fetcher = async (url) => {
  const res = await fetch(url, {
    headers: { "User-Agent": "VocaLeaf library ingest" },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
};

function checkEpub(bytes: Uint8Array): string | null {
  if (bytes.length > MAX_UPLOAD_BYTES) return `larger than ${MAX_UPLOAD_BYTES} bytes`;
  if (!ZIP_MAGIC.every((b, i) => bytes[i] === b)) return "not an EPUB (no ZIP header)";
  return null;
}

/**
 * Brings a Book already in the Library up to date: a failed parse is dropped (with its objects) so the entry is
 * ingested afresh, failed Chapters are queued again, and the difficulty and blurb follow the book list. Returns
 * null when the entry is to be ingested from scratch.
 */
async function refresh(db: Db, storage: ObjectStorage, entry: LibraryEntry): Promise<IngestResult | null> {
  const [existing] = await db
    .select({ id: books.id, status: books.status })
    .from(books)
    .where(eq(books.libraryKey, entry.key));
  if (!existing) return null;
  if (existing.status === "parse_failed") {
    await db.delete(books).where(eq(books.id, existing.id));
    await storage.deletePrefix(bookPrefix(existing.id));
    return null;
  }
  const retried = await db.transaction(async (tx) => {
    await tx.update(books).set({ difficulty: entry.difficulty, blurb: entry.blurb }).where(eq(books.id, existing.id));
    const failed = await tx
      .select({ id: chapters.id })
      .from(chapters)
      .where(and(eq(chapters.bookId, existing.id), eq(chapters.audioStatus, "failed")));
    for (const c of failed) await retryFailedChapter(tx, c.id);
    return failed.length;
  });
  return retried > 0
    ? { key: entry.key, outcome: "retried", bookId: existing.id, chapters: retried }
    : { key: entry.key, outcome: "updated", bookId: existing.id };
}

async function ingestOne(db: Db, storage: ObjectStorage, fetcher: Fetcher, entry: LibraryEntry): Promise<IngestResult> {
  const refreshed = await refresh(db, storage, entry);
  if (refreshed) return refreshed;

  let bytes: Uint8Array;
  try {
    bytes = await fetcher(standardEbooksEpubUrl(entry.key));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { key: entry.key, outcome: "failed", error: `download failed: ${reason}` };
  }
  const invalid = checkEpub(bytes);
  if (invalid) return { key: entry.key, outcome: "failed", error: invalid };

  const id = crypto.randomUUID();
  // Stored before the parse job is queued, so the job never points at a missing object (as an upload).
  await storage.putObject(sourceKey(id), bytes, "application/epub+zip");
  await db.transaction(async (tx) => {
    await tx.insert(books).values({
      id,
      source: "library",
      ownerId: null,
      libraryKey: entry.key,
      difficulty: entry.difficulty,
      blurb: entry.blurb,
      title: entry.title,
      fileSize: bytes.length,
    });
    await tx.insert(jobs).values({ bookId: id, type: "parse" });
  });
  return { key: entry.key, outcome: "queued", bookId: id };
}

/**
 * Ingests the book list entries one after another. An entry already in the Library is not downloaded again (running
 * the script twice is safe) unless its parse failed; its failed Chapters are generated again. An entry that fails
 * is reported and the others go on.
 */
export async function ingestLibrary(
  deps: { db: Db; storage: ObjectStorage; fetcher?: Fetcher },
  entries: readonly LibraryEntry[],
  onResult: (result: IngestResult) => void = () => {},
): Promise<IngestResult[]> {
  const results: IngestResult[] = [];
  for (const entry of entries) {
    const result = await ingestOne(deps.db, deps.storage, deps.fetcher ?? httpFetcher, entry);
    onResult(result);
    results.push(result);
  }
  return results;
}
