// Operator script for the Library (PRD 4.2.2, 6.2). Runs inside the api container, which has the database and
// object storage settings and can reach standardebooks.org:
//   docker compose exec api node dist/scripts/library.js ingest [<key>...]
//   docker compose exec api node dist/scripts/library.js list
// ingest downloads every Book of library/catalog.ts (or only the given keys) and queues it for parsing; the worker
// then parses it and generates its audio with the default Voice, as for an upload. A Book already in the Library is
// not downloaded again, only its difficulty and blurb follow the catalog. list shows each Library Book's progress.
import { eq } from "drizzle-orm";
import { connectDb } from "../db/client.js";
import { books } from "../db/schema.js";
import { loadEnv, s3Config } from "../env.js";
import { loadProgress } from "../books/view.js";
import { LIBRARY_CATALOG } from "../library/catalog.js";
import { ingestLibrary } from "../library/ingest.js";
import { ensureBucket, s3Storage } from "../storage.js";

const USAGE = "usage: library.js ingest [<key>...]\n       library.js list";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const [command, ...keys] = process.argv.slice(2);
const env = loadEnv();

if (command === "ingest") {
  const unknown = keys.filter((k) => !LIBRARY_CATALOG.some((e) => e.key === k));
  if (unknown.length > 0) fail(`not in library/catalog.ts: ${unknown.join(", ")}`);
  const entries = keys.length > 0 ? LIBRARY_CATALOG.filter((e) => keys.includes(e.key)) : LIBRARY_CATALOG;
  await ensureBucket(s3Config(env));
  const db = await connectDb(env.DATABASE_URL);
  const results = await ingestLibrary({ db, storage: s3Storage(s3Config(env)) }, entries, (r) =>
    console.log(`${r.key}\t${r.outcome}\t${r.outcome === "failed" ? r.error : r.bookId}`),
  );
  if (results.some((r) => r.outcome === "failed")) process.exit(1);
} else if (command === "list") {
  const db = await connectDb(env.DATABASE_URL);
  const rows = await db
    .select({ id: books.id, key: books.libraryKey, title: books.title, difficulty: books.difficulty, status: books.status })
    .from(books)
    .where(eq(books.source, "library"))
    .orderBy(books.difficulty, books.title);
  const progress = await loadProgress(db, rows.map((r) => r.id));
  for (const r of rows) {
    const p = progress.get(r.id);
    console.log(`${r.key}\t${r.difficulty}\t${r.status}\t${p ? `${p.generated}/${p.narrated}` : "-"}\t${r.title}\t${r.id}`);
  }
} else {
  fail(USAGE);
}
process.exit(0);
