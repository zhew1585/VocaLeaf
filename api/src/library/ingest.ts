// Ingesting Library Books (PRD 4.2.2, 6.2): download each catalog EPUB and put it through the same pipeline as an
// upload (parse job, then one render job per narrated Chapter, by the worker) with the default Voice. The audio is
// generated once and shared by every user.
import { eq } from "drizzle-orm";
import { MAX_UPLOAD_BYTES } from "../contract.js";
import type { Db } from "../db/client.js";
import { books, jobs } from "../db/schema.js";
import { sourceKey, type ObjectStorage } from "../storage.js";
import { standardEbooksEpubUrl, type CatalogEntry } from "./catalog.js";

/** Downloads a file; injectable so tests need no network. Rejects when the download fails. */
export type Fetcher = (url: string) => Promise<Uint8Array>;

export type IngestResult =
  /** Downloaded and queued for parsing: the worker parses and narrates it from here. */
  | { key: string; outcome: "queued"; bookId: string }
  /** In the Library already: only its difficulty and blurb were brought up to date with the catalog. */
  | { key: string; outcome: "updated"; bookId: string }
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

async function ingestOne(db: Db, storage: ObjectStorage, fetcher: Fetcher, entry: CatalogEntry): Promise<IngestResult> {
  const [existing] = await db.select({ id: books.id }).from(books).where(eq(books.libraryKey, entry.key));
  if (existing) {
    await db.update(books).set({ difficulty: entry.difficulty, blurb: entry.blurb }).where(eq(books.id, existing.id));
    return { key: entry.key, outcome: "updated", bookId: existing.id };
  }

  let bytes: Uint8Array;
  try {
    bytes = await fetcher(standardEbooksEpubUrl(entry.key));
  } catch (err) {
    return { key: entry.key, outcome: "failed", error: `download failed: ${(err as Error).message}` };
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
 * Ingests the catalog entries one after another. An entry already in the Library is not downloaded again (running
 * the script twice is safe); one that fails is reported and the others go on.
 */
export async function ingestLibrary(
  deps: { db: Db; storage: ObjectStorage; fetcher?: Fetcher },
  entries: readonly CatalogEntry[],
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
