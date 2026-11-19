// Making and reading Cards (PRD 4.5.2, F12, F16). A user makes Cards of Sentences of Books on their Shelf; every
// Card belongs to that user alone and keeps its own copy of what it needs (text, neighbours, title, audio), so
// Review (#16) and the Card list (F14) never need the Book.
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { AiProvider } from "../ai/provider.js";
import type { Card, CardListItem } from "../contract.js";
import type { Db } from "../db/client.js";
import { audioSegments, books, cards, chapters, sentences, shelfEntries } from "../db/schema.js";
import { markProcessed } from "../marks/marks.js";
import { cardAudioKey, type ObjectStorage } from "../storage.js";
import { cutClip, type ClipSegment } from "./audio-clip.js";
import { generateBack, type BackContext } from "./back.js";
import { resolveTarget, type Target } from "./target.js";

export type CardRow = typeof cards.$inferSelect;

/** A Card as the API returns it. */
export function toCard(row: CardRow): Card {
  return {
    id: row.id,
    sentenceId: row.sentenceId,
    targetText: row.targetText,
    targetKind: row.targetKind,
    targetStart: row.targetStart,
    targetEnd: row.targetEnd,
    sentenceText: row.sentenceText,
    contextBefore: row.contextBefore,
    contextAfter: row.contextAfter,
    bookTitle: row.bookTitle,
    back: row.back,
    hasAudio: row.audioKey !== null,
    due: row.due.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

/** The user's Card, or undefined. */
export async function ownCard(db: Db, userId: string, cardId: string): Promise<CardRow | undefined> {
  const [row] = await db
    .select()
    .from(cards)
    .where(and(eq(cards.id, cardId), eq(cards.userId, userId)));
  return row;
}

/** The user's Cards of the Book's Sentences, in reading order (the reading view's green underlines, PRD 4.4.5). */
export async function bookCards(db: Db, userId: string, bookId: string): Promise<Card[]> {
  const rows = await db
    .select({ card: cards })
    .from(cards)
    .innerJoin(sentences, eq(sentences.id, cards.sentenceId))
    .innerJoin(chapters, eq(chapters.id, sentences.chapterId))
    .where(and(eq(cards.userId, userId), eq(chapters.bookId, bookId)))
    .orderBy(asc(chapters.index), asc(sentences.index), asc(cards.targetStart), asc(cards.targetEnd));
  return rows.map((r) => toCard(r.card));
}

/**
 * Every Card of the user, soonest due first and newest first among equals (the Card list, F14), each with the Book
 * it came from while that Book is on the user's Shelf; null once it was deleted or taken off (AC-CLIST-03).
 */
export async function userCards(db: Db, userId: string): Promise<CardListItem[]> {
  const rows = await db
    .select({ card: cards, bookId: shelfEntries.bookId })
    .from(cards)
    .leftJoin(sentences, eq(sentences.id, cards.sentenceId))
    .leftJoin(chapters, eq(chapters.id, sentences.chapterId))
    .leftJoin(shelfEntries, and(eq(shelfEntries.bookId, chapters.bookId), eq(shelfEntries.userId, userId)))
    .where(eq(cards.userId, userId))
    .orderBy(asc(cards.due), desc(cards.createdAt), asc(cards.id));
  return rows.map((r) => ({ ...toCard(r.card), bookId: r.bookId }));
}

/**
 * Deletes the user's Card for good (PRD 4.5.2 删除), then its audio; false when they have no such Card. Its
 * Sentence's Mark stays as it is. A failure deleting the audio only leaves an object nothing points to.
 */
export async function deleteCard({ db, storage }: Pick<CardDeps, "db" | "storage">, userId: string, cardId: string): Promise<boolean> {
  const [row] = await db
    .delete(cards)
    .where(and(eq(cards.id, cardId), eq(cards.userId, userId)))
    .returning({ audioKey: cards.audioKey });
  if (!row) return false;
  if (row.audioKey) {
    try {
      await storage.deleteObjects([row.audioKey]);
    } catch (err) {
      console.error(`card_delete: audio ${row.audioKey} of Card ${cardId} not deleted`, err);
    }
  }
  return true;
}

/** A Sentence the user may make Cards of (its Book is on their Shelf), with what a Card copies from it. */
async function cardableSentence(db: Db, userId: string, sentenceId: string) {
  const [row] = await db
    .select({
      id: sentences.id,
      text: sentences.text,
      index: sentences.index,
      startMs: sentences.startMs,
      endMs: sentences.endMs,
      chapterId: sentences.chapterId,
      bookTitle: books.title,
      voice: books.voice,
    })
    .from(sentences)
    .innerJoin(chapters, eq(chapters.id, sentences.chapterId))
    .innerJoin(books, eq(books.id, chapters.bookId))
    .innerJoin(shelfEntries, and(eq(shelfEntries.bookId, books.id), eq(shelfEntries.userId, userId)))
    .where(eq(sentences.id, sentenceId));
  return row;
}

type CardableSentence = NonNullable<Awaited<ReturnType<typeof cardableSentence>>>;

/** The texts of the Sentences just before and after it in its Chapter (PRD 4.5.2 context_before / context_after). */
async function neighbours(db: Db, s: CardableSentence): Promise<{ before: string | null; after: string | null }> {
  const rows = await db
    .select({ index: sentences.index, text: sentences.text })
    .from(sentences)
    .where(and(eq(sentences.chapterId, s.chapterId), sql`${sentences.index} in (${s.index - 1}, ${s.index + 1})`));
  const at = (index: number) => rows.find((r) => r.index === index)?.text ?? null;
  return { before: at(s.index - 1), after: at(s.index + 1) };
}

/**
 * The Sentence's audio in the Voice that plays now, cut from its Chapter's segments by the Sentence's timeline
 * (audio-clip.ts). Null when it has no audio yet, or cutting failed (the Card is made without it).
 */
async function sentenceAudio(db: Db, storage: ObjectStorage, s: CardableSentence): Promise<Uint8Array | null> {
  if (s.startMs === null || s.endMs === null) return null;
  const segments = await db
    .select({ key: audioSegments.key, durationMs: audioSegments.durationMs })
    .from(audioSegments)
    .where(and(eq(audioSegments.chapterId, s.chapterId), eq(audioSegments.voice, s.voice)))
    .orderBy(asc(audioSegments.index));
  try {
    const needed: ClipSegment[] = [];
    let startMs = 0;
    for (const seg of segments) {
      if (startMs < s.endMs && startMs + seg.durationMs > s.startMs) {
        const bytes = await storage.getObject(seg.key);
        if (!bytes) throw new Error(`segment ${seg.key} is missing`);
        needed.push({ bytes, startMs });
      }
      startMs += seg.durationMs;
    }
    const clip = cutClip(needed, s.startMs, s.endMs);
    return clip.length > 0 ? clip : null;
  } catch (err) {
    console.error(`Cutting the audio of Sentence ${s.id} for a Card failed`, err);
    return null;
  }
}

/** What a back is generated from, out of a Card's snapshot. */
function backContextOf(card: Pick<CardRow, "bookTitle" | "sentenceText" | "contextBefore" | "contextAfter" | "targetText" | "targetKind">): BackContext {
  return {
    bookTitle: card.bookTitle,
    sentence: card.sentenceText,
    before: card.contextBefore,
    after: card.contextAfter,
    target: card.targetText,
    targetKind: card.targetKind,
  };
}

/** The user's Card of this Target of the Sentence (PRD 4.5.2 规则 3), as a condition. */
function sameTarget(userId: string, sentenceId: string, target: Target) {
  return and(
    eq(cards.userId, userId),
    eq(cards.sentenceId, sentenceId),
    eq(cards.targetStart, target.start),
    eq(cards.targetEnd, target.end),
  );
}

/** Whether the user has a Card of the same Target text, ignoring case, from another Sentence (PRD 4.5.2 规则 4). */
async function hasTwin(db: Db, userId: string, sentenceId: string, targetText: string): Promise<boolean> {
  const [twin] = await db
    .select({ id: cards.id })
    .from(cards)
    .where(
      and(
        eq(cards.userId, userId),
        sql`lower(${cards.targetText}) = lower(${targetText})`,
        sql`${cards.sentenceId} is distinct from ${sentenceId}`,
      ),
    )
    .limit(1);
  return twin !== undefined;
}

export type CreateCardOutcome =
  | { result: "created" | "existing"; card: Card }
  | { result: "duplicate"; targetText: string }
  | { result: "not_found" | "no_words" };

export interface CreateCardInput {
  sentenceId: string;
  start: number;
  end: number;
  allowDuplicate?: boolean;
}

/** What creating a Card needs. */
export interface CardDeps {
  db: Db;
  storage: ObjectStorage;
  ai: AiProvider;
}

/**
 * Makes a Card of a selection of a Sentence (PRD 4.5.2 制卡规则): widened to whole words; the Card of the same
 * Target of the Sentence when there is one (规则 3); refused as a duplicate when the user has a Card of the same
 * Target text in another Sentence, unless allowed (规则 4). A new Card copies the Sentence and its audio and gets its
 * back from the AI, which may fail (规则 5, 6); then the Sentence's pending Mark is processed (规则 7, PRD 4.4.4).
 */
export async function createCard(deps: CardDeps, userId: string, input: CreateCardInput, now: Date): Promise<CreateCardOutcome> {
  const { db, storage, ai } = deps;
  const sentence = await cardableSentence(db, userId, input.sentenceId);
  if (!sentence) return { result: "not_found" };
  const target = resolveTarget(sentence.text, input.start, input.end);
  if (!target) return { result: "no_words" };
  const targetText = sentence.text.slice(target.start, target.end);

  const [existing] = await db.select().from(cards).where(sameTarget(userId, sentence.id, target));
  if (existing) return { result: "existing", card: toCard(existing) };
  if (!input.allowDuplicate && (await hasTwin(db, userId, sentence.id, targetText))) return { result: "duplicate", targetText };

  const { before, after } = await neighbours(db, sentence);
  const snapshot = {
    id: crypto.randomUUID(),
    userId,
    sentenceId: sentence.id,
    targetText,
    targetKind: target.kind,
    targetStart: target.start,
    targetEnd: target.end,
    sentenceText: sentence.text,
    contextBefore: before,
    contextAfter: after,
    bookTitle: sentence.bookTitle,
    due: now,
    createdAt: now,
  };
  const [audio, back] = await Promise.all([sentenceAudio(db, storage, sentence), generateBack(ai, backContextOf(snapshot))]);
  const inserted = await insertCard(deps, { ...snapshot, back }, audio, now);
  if (inserted) return { result: "created", card: toCard(inserted) };
  // The same Target was made meanwhile (a double click, another device): that Card stands.
  const [winner] = await db.select().from(cards).where(sameTarget(userId, sentence.id, target));
  if (!winner) throw new Error(`Card of Sentence ${sentence.id} clashed but is not there`);
  return { result: "existing", card: toCard(winner) };
}

/**
 * Stores the Card's audio, then the Card and its Sentence's processed Mark in one transaction. Undefined when the
 * same Target's Card got there first. The audio goes again unless the Card holding it is in.
 */
async function insertCard(
  { db, storage }: CardDeps,
  values: Omit<typeof cards.$inferInsert, "audioKey"> & { id: string; sentenceId: string },
  audio: Uint8Array | null,
  now: Date,
): Promise<CardRow | undefined> {
  const audioKey = audio ? cardAudioKey(values.id) : null;
  if (audio && audioKey) await storage.putObject(audioKey, audio, "audio/aac");
  let inserted: CardRow | undefined;
  try {
    inserted = await db.transaction(async (tx) => {
      const [row] = await tx.insert(cards).values({ ...values, audioKey }).onConflictDoNothing().returning();
      if (row) await markProcessed(tx, values.userId, values.sentenceId, now);
      return row;
    });
  } finally {
    if (!inserted && audioKey) await storage.deleteObjects([audioKey]);
  }
  return inserted;
}

/**
 * Generates the Card's back again from its own snapshot (【释义生成失败，点击重试】, later 【重新生成】 in the Card
 * list), replacing the old one; not counted against the daily AI limit. Undefined when the AI failed again.
 */
export async function regenerateBack({ db, ai }: Pick<CardDeps, "db" | "ai">, card: CardRow): Promise<Card | undefined> {
  const back = await generateBack(ai, backContextOf(card));
  if (!back) return undefined;
  const [updated] = await db.update(cards).set({ back }).where(eq(cards.id, card.id)).returning();
  return updated && toCard(updated);
}
