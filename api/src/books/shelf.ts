// A user's Shelf (PRD 4.2.3) and where they are in each Book on it (PRD 4.4.1 进度同步).
// Progress is kept as a Sentence, so it survives anything that moves audio around (a retried Chapter, a Voice
// change); the player reports a position in the Book's audio and the API turns it into the Sentence there.
import { and, asc, desc, eq, inArray, isNotNull, lte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Listening, Voice } from "../contract.js";
import type { Db } from "../db/client.js";
import { books, chapters, sentences, shelfEntries } from "../db/schema.js";
import type { Tx } from "../jobs/lifecycle.js";
import { estimateDurationMs, loadTimeline, type Timeline } from "./timeline.js";

/** Puts a Book on the user's Shelf; one already there stays as it is, with its progress. */
export async function addToShelf(tx: Db | Tx, userId: string, bookId: string, now: Date): Promise<void> {
  await tx.insert(shelfEntries).values({ userId, bookId, addedAt: now }).onConflictDoNothing();
}

/**
 * Takes a Library Book off the user's Shelf (PRD 4.2.3 移出规则): their progress goes with the Shelf entry, while the
 * shared text and audio stay for everyone. The user's Marks and Explanations on it go too once they exist; Cards
 * stay (PRD 4.5.2).
 */
export async function removeFromShelf(db: Db, userId: string, bookId: string): Promise<void> {
  await db.delete(shelfEntries).where(and(eq(shelfEntries.userId, userId), eq(shelfEntries.bookId, bookId)));
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

/** Where playback resumes: a position in the Book's audio (null while it has none there), in a Chapter. */
interface ResumeAt {
  startMs: number | null;
  chapterTitle: string;
}

/**
 * Where a Chapter set Skipped resumes (PRD 4.2.5): the start of the next narrated Chapter in the playlist, or null
 * while there is none yet.
 */
async function nextNarratedChapters(
  db: Db,
  skippedAt: { bookId: string; chapterIndex: number }[],
  timelines: Map<string, Timeline>,
): Promise<Map<string, ResumeAt | null>> {
  if (skippedAt.length === 0) return new Map();
  const rows = await db
    .select({ id: chapters.id, index: chapters.index, title: chapters.title })
    .from(chapters)
    .where(inArray(chapters.bookId, skippedAt.map((s) => s.bookId)));
  const byId = new Map(rows.map((r) => [r.id, r]));
  return new Map(
    skippedAt.map(({ bookId, chapterIndex }) => {
      const next = timelines.get(bookId)?.entries.find((e) => {
        const chapter = byId.get(e.chapterId);
        return e.segments.length > 0 && chapter !== undefined && chapter.index > chapterIndex;
      });
      return [bookId, next ? { startMs: next.offsetMs, chapterTitle: byId.get(next.chapterId)!.title } : null];
    }),
  );
}

/**
 * Where the user is in each of the Books they listened to. `timelines` (of the same Books) place the Sentence in
 * the Book's audio; a Sentence of a Chapter set Skipped since resumes at the next narrated Chapter's start. The
 * share is of the Book's audio up to there, as the 专注页 shows how much was listened to; while that has no audio
 * in the playlist, it is the share of the narrated text before the Sentence.
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
      chapterIndex: atChapter.index,
      chapterSkipped: atChapter.skipped,
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

  const durations = await loadDurations(db, rows.map((r) => r.bookId));
  const skippedResumes = await nextNarratedChapters(db, rows.filter((r) => r.chapterSkipped), timelines);
  /** The Sentence's own place, while its Chapter is narrated. */
  const ownPlace = (r: (typeof rows)[number]): ResumeAt => {
    const entry = timelines.get(r.bookId)?.entries.find((e) => e.chapterId === r.chapterId && e.segments.length > 0);
    const startMs = entry && r.sentenceStartMs !== null ? entry.offsetMs + r.sentenceStartMs : null;
    return { startMs, chapterTitle: r.chapterTitle };
  };
  return new Map(
    rows.map((r) => {
      const resume = r.chapterSkipped
        ? (skippedResumes.get(r.bookId) ?? { startMs: null, chapterTitle: r.chapterTitle })
        : ownPlace(r);
      const startMs = resume.startMs;
      const durationMs = durations.get(r.bookId) ?? null;
      const share =
        startMs !== null && durationMs ? startMs / durationMs : r.totalChars > 0 ? r.charsBefore / r.totalChars : 0;
      const listening: Listening = {
        sentenceId: r.sentenceId,
        chapterTitle: resume.chapterTitle,
        share: Math.min(share, 1),
        startMs,
        listenedAt: r.listenedAt!.toISOString(),
      };
      return [r.bookId, listening];
    }),
  );
}

/** Length of each Book's whole audio, estimated while it generates (as the 专注页's total, books/timeline.ts). */
async function loadDurations(db: Db, bookIds: string[]): Promise<Map<string, number | null>> {
  if (bookIds.length === 0) return new Map();
  const rows = await db
    .select({
      bookId: chapters.bookId,
      skipped: chapters.skipped,
      audioStatus: chapters.audioStatus,
      durationMs: chapters.durationMs,
      spokenChars: sql<number>`coalesce(sum(length(${sentences.spokenText})), 0)`.mapWith(Number),
    })
    .from(chapters)
    .leftJoin(sentences, eq(sentences.chapterId, chapters.id))
    .where(inArray(chapters.bookId, bookIds))
    .groupBy(chapters.id);
  return new Map([...Map.groupBy(rows, (r) => r.bookId)].map(([id, rs]) => [id, estimateDurationMs(rs)]));
}

/**
 * Records that the user listened to the Book up to `positionMs` of its audio: the Sentence playing there (the last
 * one starting at or before it, so the pause after a Sentence still belongs to it) becomes where they resume, and
 * the Book moves to the front of the Shelf. A position in audio of a `voice` the Book no longer has is not placed
 * (its times are the old Voice's); the resume Sentence stays. Returns false when the Book is not on the user's Shelf.
 */
export async function recordListening(
  db: Db,
  userId: string,
  bookId: string,
  positionMs: number,
  now: Date,
  voice?: Voice,
) {
  if (!(await onShelf(db, userId, bookId))) return false;
  const [book] = await db.select({ voice: books.voice }).from(books).where(eq(books.id, bookId));
  const placeable = voice === undefined || voice === book!.voice;
  const sentenceId = placeable ? await sentenceAt(db, await loadTimeline(db, bookId), positionMs) : null;
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
