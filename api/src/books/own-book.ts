import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { books } from "../db/schema.js";

export const notFound = { error: { code: "not_found", message: "书不存在" } } as const;

/** The current user's Book, or undefined. */
export async function ownBook(db: Db, id: string, userId: string) {
  const [book] = await db
    .select()
    .from(books)
    .where(and(eq(books.id, id), eq(books.ownerId, userId)));
  return book;
}
