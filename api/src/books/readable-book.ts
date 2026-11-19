import { and, eq, or, type SQL } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { books } from "../db/schema.js";

export const notFound = { error: { code: "not_found", message: "书不存在" } } as const;

/**
 * The Books a user may read and listen to: their own uploads, and every Library Book, whose text and audio all
 * users share (PRD 4.2.2). Changing a Book (deleting it, retrying a Chapter) stays with its uploader.
 */
export function readableBy(userId: string): SQL {
  return or(eq(books.ownerId, userId), eq(books.source, "library"))!;
}

/** A Book the user may read (readableBy), or undefined. */
export async function readableBook(db: Db, id: string, userId: string) {
  const [book] = await db
    .select()
    .from(books)
    .where(and(eq(books.id, id), readableBy(userId)));
  return book;
}
