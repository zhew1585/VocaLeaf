// A Book as the user sees it (contract.ts BookSchema), shared by the Shelf, the Book detail and the upload.
import { inArray } from "drizzle-orm";
import type { AudioStatus, Book, Listening } from "../contract.js";
import type { Db } from "../db/client.js";
import { books, chapters } from "../db/schema.js";
import { hasAudio, type Timeline } from "./timeline.js";

type BookRow = typeof books.$inferSelect;
type Progress = Book["progress"];

export const NO_PROGRESS: Progress = { generated: 0, narrated: 0 };

/** Generated narrated Chapters out of all narrated ones (PRD 4.3.3 进度展示). */
export function progressOf(chapterRows: { skipped: boolean; audioStatus: AudioStatus }[]): Progress {
  const narrated = chapterRows.filter((c) => !c.skipped);
  return { generated: narrated.filter((c) => c.audioStatus === "generated").length, narrated: narrated.length };
}

export async function loadProgress(db: Db, bookIds: string[]): Promise<Map<string, Progress>> {
  if (bookIds.length === 0) return new Map();
  const rows = await db
    .select({ bookId: chapters.bookId, skipped: chapters.skipped, audioStatus: chapters.audioStatus })
    .from(chapters)
    .where(inArray(chapters.bookId, bookIds));
  return new Map([...Map.groupBy(rows, (r) => r.bookId)].map(([id, rs]) => [id, progressOf(rs)]));
}

/** The cover route of a Book whose EPUB had a cover (books/shelf-routes.ts). */
export function coverUrl(row: Pick<BookRow, "id" | "coverType">): string | null {
  return row.coverType ? `/api/books/${row.id}/cover` : null;
}

export function toBook(
  row: BookRow,
  timeline: Timeline | undefined,
  progress: Progress,
  listening: Listening | null = null,
): Book {
  return {
    id: row.id,
    title: row.title,
    author: row.author,
    source: row.source,
    status: row.status,
    playable: timeline ? hasAudio(timeline) : false,
    failureReason: row.failureReason,
    progress,
    coverUrl: coverUrl(row),
    listening,
    createdAt: row.createdAt.toISOString(),
  };
}
