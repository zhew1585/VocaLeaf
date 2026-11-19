// A user's Shelf (PRD 4.2.3) and where they are in each Book on it (PRD 4.4.1 进度同步).
// Progress is kept as a Sentence, so it survives anything that moves audio around (a retried Chapter, a Voice
// change); the player reports a position in the Book's audio and the API turns it into the Sentence there.
import { and, asc, desc, eq, inArray, isNotNull, lte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Listening } from "../contract.js";
import type { Db } from "../db/client.js";
import { books, chapters, sentences, shelfEntries } from "../db/schema.js";
import type { Tx } from "../jobs/lifecycle.js";
import { loadTimeline, type Timeline } from "./timeline.js";

/** Puts a Book on the user's Shelf. */
export async function addToShelf(tx: Tx, userId: string, bookId: string, now: Date): Promise<void> {
  await tx.insert(shelfEntries).values({ userId, bookId, addedAt: now });
}

/**
 * The user's Shelf in display order: Books last listened to most recently first, then the ones never listened to,
 * most recently added first.
 */
export async function shelfBooks(db: Db, userId: string) {
  const rows = await db
    .select({ book: books })
    .from(shelfEntries)
    .innerJoin(books, eq(books.id, shelfEntries.bookId))
    .where(eq(shelfEntries.userId, userId))
    .orderBy(sql`${shelfEntries.lastListenedAt} desc nulls last`, desc(shelfEntries.addedAt));
  return rows.map((r) => r.book);
}

/** Whether the Book is on the user's Shelf. */
export async function onShelf(db: Db, userId: string, bookId: string): Promise<boolean> {
  const [entry] = await db
    .select({ bookId: shelfEntries.bookId })
    .from(shelfEntries)
    .where(and(eq(shelfEntries.userId, userId), eq(shelfEntries.bookId, bookId)));
  return entry !== undefined;
}

/**
 * Where the user is in each of the Books they listened to. `timelines` (of the same Books) place the Sentence in
 * the Book's audio. The share counts the narrated text before that Sentence, by spoken characters: close to the
 * share of the audio, and known before the audio is.
 */
export async function loadListening(
  db: Db,
  userId: string,
  bookIds: string[],
  timelines: Map<string, Timeline>,
): Promise<Map<string, Listening>> {
  if (bookIds.length === 0) return new Map();
  const at = alias(sentences, "at_sentence");
  const atChapter = alias(chapters, "at_chapter");
  const chars = sql`length(${sentences.spokenText})`;
  const before = sql`${chapters.index} < ${atChapter.index} or (${chapters.id} = ${atChapter.id} and ${sentences.index} < ${at.index})`;
  const rows = await db
    .select({
      bookId: shelfEntries.bookId,
      listenedAt: shelfEntries.lastListenedAt,
      sentenceId: at.id,
      sentenceStartMs: at.startMs,
      chapterId: atChapter.id,
      chapterTitle: atChapter.title,
      totalChars: sql<number>`coalesce(sum(${chars}), 0)`.mapWith(Number),
      charsBefore: sql<number>`coalesce(sum(${chars}) filter (where ${before}), 0)`.mapWith(Number),
    })
    .from(shelfEntries)
    .innerJoin(at, eq(at.id, shelfEntries.sentenceId))
    .innerJoin(atChapter, eq(atChapter.id, at.chapterId))
    .leftJoin(chapters, and(eq(chapters.bookId, shelfEntries.bookId), eq(chapters.skipped, false)))
    .leftJoin(sentences, eq(sentences.chapterId, chapters.id))
    .where(
      and(eq(shelfEntries.userId, userId), inArray(shelfEntries.bookId, bookIds), isNotNull(shelfEntries.lastListenedAt)),
    )
    .groupBy(shelfEntries.bookId, shelfEntries.lastListenedAt, at.id, atChapter.id);

  return new Map(
    rows.map((r) => {
      const entry = timelines.get(r.bookId)?.entries.find((e) => e.chapterId === r.chapterId && e.segments.length > 0);
      const startMs = entry && r.sentenceStartMs !== null ? entry.offsetMs + r.sentenceStartMs : null;
      const listening: Listening = {
        sentenceId: r.sentenceId,
        chapterTitle: r.chapterTitle,
        share: r.totalChars > 0 ? Math.min(r.charsBefore / r.totalChars, 1) : 0,
        startMs,
        listenedAt: r.listenedAt!.toISOString(),
      };
      return [r.bookId, listening];
    }),
  );
}

/**
 * Records that the user listened to the Book up to `positionMs` of its audio: the Sentence playing there (the last
 * one starting at or before it, so the pause after a Sentence still belongs to it) becomes where they resume, and
 * the Book moves to the front of the Shelf. Returns false when the Book is not on the user's Shelf.
 */
export async function recordListening(db: Db, userId: string, bookId: string, positionMs: number, now: Date) {
  if (!(await onShelf(db, userId, bookId))) return false;
  const sentenceId = await sentenceAt(db, await loadTimeline(db, bookId), positionMs);
  await db
    .update(shelfEntries)
    .set({ lastListenedAt: now, ...(sentenceId ? { sentenceId } : {}) })
    .where(and(eq(shelfEntries.userId, userId), eq(shelfEntries.bookId, bookId)));
  return true;
}

/** The Sentence playing at a position in the Book's audio, or null when the audio has none there. */
async function sentenceAt(db: Db, timeline: Timeline, positionMs: number): Promise<string | null> {
  const entry = timeline.entries.findLast((e) => e.segments.length > 0 && e.offsetMs <= positionMs);
  if (!entry) return null;
  const [timed] = await db
    .select({ id: sentences.id })
    .from(sentences)
    .where(and(eq(sentences.chapterId, entry.chapterId), lte(sentences.startMs, positionMs - entry.offsetMs)))
    .orderBy(desc(sentences.startMs))
    .limit(1);
  if (timed) return timed.id;
  // Before the first Sentence starts (the pause that opens a Chapter): that first Sentence.
  const [first] = await db
    .select({ id: sentences.id })
    .from(sentences)
    .where(eq(sentences.chapterId, entry.chapterId))
    .orderBy(asc(sentences.index))
    .limit(1);
  return first?.id ?? null;
}
