// Making and reading Cards (PRD 4.5.2, F12, F16). A user makes Cards of Sentences of Books on their Shelf; every
// Card belongs to that user alone and keeps its own copy of what it needs (text, neighbours, title, audio), so
// Review (#16) and the Card list (#17) never need the Book.
import { and, asc, eq, sql } from "drizzle-orm";
import type { AiProvider } from "../ai/provider.js";
import type { Card } from "../contract.js";
import type { Db } from "../db/client.js";
import { audioSegments, books, cards, chapters, sentences, shelfEntries } from "../db/schema.js";
import { markProcessed } from "../marks/marks.js";
import { cardAudioKey, type ObjectStorage } from "../storage.js";
import { cutClip } from "./audio-clip.js";
import { generateBack, type BackContext } from "./back.js";
import { resolveTarget } from "./target.js";

type CardRow = typeof cards.$inferSelect;

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
    const needed: { bytes: Uint8Array; startMs: number }[] = [];
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

/**
 * Makes a Card of a selection of a Sentence (PRD 4.5.2 制卡规则): widened to whole words; the Card of the same
 * Target of the Sentence when there is one (规则 3); refused as a duplicate when the user has a Card of the same
 * Target text in another Sentence, unless allowed (规则 4). A new Card copies the Sentence and its audio and gets its
 * back from the AI, which may fail (规则 5, 6); then the Sentence's pending Mark is processed (规则 7, PRD 4.4.4).
 */
export async function createCard(
  deps: { db: Db; storage: ObjectStorage; ai: AiProvider },
  userId: string,
  input: CreateCardInput,
  now: Date,
): Promise<CreateCardOutcome> {
  const { db, storage, ai } = deps;
  const sentence = await cardableSentence(db, userId, input.sentenceId);
  if (!sentence) return { result: "not_found" };
  const target = resolveTarget(sentence.text, input.start, input.end);
  if (!target) return { result: "no_words" };
  const targetText = sentence.text.slice(target.start, target.end);

  const sameTarget = and(
    eq(cards.userId, userId),
    eq(cards.sentenceId, sentence.id),
    eq(cards.targetStart, target.start),
    eq(cards.targetEnd, target.end),
  );
  const [existing] = await db.select().from(cards).where(sameTarget);
  if (existing) return { result: "existing", card: toCard(existing) };

  if (!input.allowDuplicate) {
    const [twin] = await db
      .select({ id: cards.id })
      .from(cards)
      .where(
        and(
          eq(cards.userId, userId),
          sql`lower(${cards.targetText}) = lower(${targetText})`,
          sql`${cards.sentenceId} is distinct from ${sentence.id}`,
        ),
      )
      .limit(1);
    if (twin) return { result: "duplicate", targetText };
  }

  const id = crypto.randomUUID();
  const { before, after } = await neighbours(db, sentence);
  const context: BackContext = {
    bookTitle: sentence.bookTitle,
    sentence: sentence.text,
    before,
    after,
    target: targetText,
    targetKind: target.kind,
  };
  const [audio, back] = await Promise.all([sentenceAudio(db, storage, sentence), generateBack(ai, context)]);
  const audioKey = audio ? cardAudioKey(id) : null;
  if (audio && audioKey) await storage.putObject(audioKey, audio, "audio/aac");

  const [inserted] = await db
    .insert(cards)
    .values({
      id,
      userId,
      sentenceId: sentence.id,
      targetText,
      targetKind: target.kind,
      targetStart: target.start,
      targetEnd: target.end,
      sentenceText: sentence.text,
      contextBefore: before,
      contextAfter: after,
      audioKey,
      bookTitle: sentence.bookTitle,
      back,
      due: now,
      createdAt: now,
    })
    .onConflictDoNothing()
    .returning();
  if (!inserted) {
    // The same Target was made meanwhile (a double click, another device): that Card stands.
    if (audioKey) await storage.deleteObjects([audioKey]);
    const [winner] = await db.select().from(cards).where(sameTarget);
    if (!winner) throw new Error(`Card of Sentence ${sentence.id} clashed but is not there`);
    return { result: "existing", card: toCard(winner) };
  }
  await markProcessed(db, userId, sentence.id, now);
  return { result: "created", card: toCard(inserted) };
}

/**
 * Generates the Card's back again from its own snapshot (【释义生成失败，点击重试】, later 【重新生成】 in the Card
 * list), replacing the old one; not counted against the daily AI limit. Undefined when the AI failed again.
 */
export async function regenerateBack(db: Db, ai: AiProvider, card: CardRow): Promise<Card | undefined> {
  const back = await generateBack(ai, {
    bookTitle: card.bookTitle,
    sentence: card.sentenceText,
    before: card.contextBefore,
    after: card.contextAfter,
    target: card.targetText,
    targetKind: card.targetKind,
  });
  if (!back) return undefined;
  const [updated] = await db.update(cards).set({ back }).where(eq(cards.id, card.id)).returning();
  return updated && toCard(updated);
}
