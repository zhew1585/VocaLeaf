// Marks (PRD 4.4.2) and the Gleanings they make up (PRD 4.4.4). A user may mark any Sentence of a Book on their
// Shelf; every Mark belongs to that user alone, even for a shared Book.
import { and, count, desc, eq } from "drizzle-orm";
import type { Gleaning, MarkResult } from "../contract.js";
import type { Db } from "../db/client.js";
import type { Tx } from "../jobs/lifecycle.js";
import { books, chapters, marks, sentences, shelfEntries } from "../db/schema.js";
import { chapterStartMs, loadTimelines } from "../books/timeline.js";

/** The Book of a Sentence the user may mark (its Book is on their Shelf), or undefined. */
async function markableBookId(db: Db, userId: string, sentenceId: string): Promise<string | undefined> {
  const [row] = await db
    .select({ bookId: chapters.bookId })
    .from(sentences)
    .innerJoin(chapters, eq(chapters.id, sentences.chapterId))
    .innerJoin(shelfEntries, and(eq(shelfEntries.bookId, chapters.bookId), eq(shelfEntries.userId, userId)))
    .where(eq(sentences.id, sentenceId));
  return row?.bookId;
}

/** The user's Mark of a Sentence. */
const markOf = (userId: string, sentenceId: string) => and(eq(marks.userId, userId), eq(marks.sentenceId, sentenceId));

/**
 * Marks a Sentence (PRD 4.4.2 规则 1 to 3): creates a pending Mark, leaves a pending one as it is, and puts a
 * processed or dismissed one back to pending, on top of Gleanings. Undefined when the user may not mark it.
 */
export async function markSentence(
  db: Db,
  userId: string,
  sentenceId: string,
  now: Date,
): Promise<MarkResult["result"] | undefined> {
  const bookId = await markableBookId(db, userId, sentenceId);
  if (!bookId) return undefined;
  return db.transaction(async (tx) => {
    const [existing] = await tx.select({ status: marks.status }).from(marks).where(markOf(userId, sentenceId)).for("update");
    if (existing?.status === "pending") return "already";
    if (existing) {
      await tx.update(marks).set({ status: "pending", updatedAt: now }).where(markOf(userId, sentenceId));
      return "reopened";
    }
    // A concurrent first Mark of the same Sentence (two devices) already made it pending.
    const inserted = await tx
      .insert(marks)
      .values({ userId, sentenceId, bookId, createdAt: now, updatedAt: now })
      .onConflictDoNothing()
      .returning({ sentenceId: marks.sentenceId });
    return inserted.length > 0 ? "created" : "already";
  });
}

/** Undoes a Mark or 取消标记 (PRD 4.4.2 规则 4): the Mark is deleted. Deleting a missing Mark does nothing. */
export async function unmarkSentence(db: Db, userId: string, sentenceId: string): Promise<void> {
  await db.delete(marks).where(markOf(userId, sentenceId));
}

/**
 * Dismisses a pending Mark (PRD 4.4.4): it leaves Gleanings as 已忽略. A Mark that is not pending stays as it is.
 * False when the user has no Mark on the Sentence.
 */
export async function dismissMark(db: Db, userId: string, sentenceId: string, now: Date): Promise<boolean> {
  const dismissed = await db
    .update(marks)
    .set({ status: "dismissed", updatedAt: now })
    .where(and(markOf(userId, sentenceId), eq(marks.status, "pending")))
    .returning({ sentenceId: marks.sentenceId });
  if (dismissed.length > 0) return true;
  const [existing] = await db.select({ status: marks.status }).from(marks).where(markOf(userId, sentenceId));
  return existing !== undefined;
}

/**
 * The seam for making Cards (#15, PRD 4.5.2 #7): a Card made from the Sentence processes its pending Mark, which
 * leaves Gleanings. Does nothing without a pending Mark.
 */
export async function markProcessed(db: Db | Tx, userId: string, sentenceId: string, now: Date): Promise<void> {
  await db
    .update(marks)
    .set({ status: "processed", updatedAt: now })
    .where(and(markOf(userId, sentenceId), eq(marks.status, "pending")));
}

/** Sentences of the Book with a pending Mark of the user. */
export async function pendingInBook(db: Db, userId: string, bookId: string): Promise<string[]> {
  const rows = await db
    .select({ sentenceId: marks.sentenceId })
    .from(marks)
    .where(and(eq(marks.userId, userId), eq(marks.bookId, bookId), eq(marks.status, "pending")));
  return rows.map((r) => r.sentenceId);
}

/** How many Sentences wait in the user's Gleanings. */
export async function gleaningCount(db: Db, userId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(marks)
    .where(and(eq(marks.userId, userId), eq(marks.status, "pending")));
  return row?.n ?? 0;
}

/** The user's Gleanings: every pending Mark across Books, most recently marked first (PRD 4.4.4). */
export async function loadGleanings(db: Db, userId: string): Promise<Gleaning[]> {
  const rows = await db
    .select({
      sentenceId: marks.sentenceId,
      text: sentences.text,
      startMs: sentences.startMs,
      endMs: sentences.endMs,
      bookId: marks.bookId,
      bookTitle: books.title,
      chapterId: chapters.id,
      chapterTitle: chapters.title,
      markedAt: marks.updatedAt,
    })
    .from(marks)
    .innerJoin(sentences, eq(sentences.id, marks.sentenceId))
    .innerJoin(chapters, eq(chapters.id, sentences.chapterId))
    .innerJoin(books, eq(books.id, marks.bookId))
    .where(and(eq(marks.userId, userId), eq(marks.status, "pending")))
    .orderBy(desc(marks.updatedAt), desc(marks.createdAt));
  // Stored times count from the Chapter's start; the Book's audio places the Chapter after the ones before it.
  const timelines = await loadTimelines(db, [...new Set(rows.map((r) => r.bookId))]);
  return rows.map(({ startMs, endMs, markedAt, ...r }) => {
    const timeline = timelines.get(r.bookId);
    const chapterStart = timeline ? chapterStartMs(timeline, r.chapterId) : null;
    return {
      ...r,
      startMs: chapterStart !== null && startMs !== null ? chapterStart + startMs : null,
      endMs: chapterStart !== null && endMs !== null ? chapterStart + endMs : null,
      markedAt: markedAt.toISOString(),
    };
  });
}
