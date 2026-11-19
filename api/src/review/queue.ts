// Today's Review queue (PRD 4.5.3 今日队列) and rating its Cards. A day runs from 00:00 to 00:00 Asia/Shanghai, as
// the daily AI limit's does (explanations/quota.ts).
import { and, asc, count, eq, gte, lt, ne } from "drizzle-orm";
import { DAILY_NEW_CARDS, type Rating, type ReviewQueue } from "../contract.js";
import type { Db } from "../db/client.js";
import { cards } from "../db/schema.js";
import { toCard, type CardRow } from "../cards/cards.js";
import { beijingDayBounds } from "../explanations/quota.js";
import { nextIntervals, rateSchedule } from "./schedule.js";

type Day = ReturnType<typeof beijingDayBounds>;

const ofUser = (userId: string) => eq(cards.userId, userId);
const within = (column: typeof cards.firstReviewedAt | typeof cards.lastReviewedAt, day: Day) => and(gte(column, day.start), lt(column, day.end));

/** How many of the user's Cards match `condition`. */
async function countCards(db: Db, userId: string, condition: ReturnType<typeof and>): Promise<number> {
  const [row] = await db.select({ n: count() }).from(cards).where(and(ofUser(userId), condition));
  return row?.n ?? 0;
}

const byDue = (a: CardRow, b: CardRow) =>
  a.due.getTime() - b.due.getTime() || a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id);

/**
 * The Cards of the user's queue: learned Cards due by the end of the day, plus new Cards by creation up to what the
 * day's limit has left (less those first rated today), all by due date. A Card rated today and due again today
 * (a learning step) is in it again.
 */
async function queueRows(db: Db, userId: string, day: Day): Promise<CardRow[]> {
  const newLeft = Math.max(0, DAILY_NEW_CARDS - (await countCards(db, userId, within(cards.firstReviewedAt, day))));
  const learned = await db
    .select()
    .from(cards)
    .where(and(ofUser(userId), ne(cards.state, "new"), lt(cards.due, day.end)));
  const unseen =
    newLeft === 0
      ? []
      : await db
          .select()
          .from(cards)
          .where(and(ofUser(userId), eq(cards.state, "new")))
          .orderBy(asc(cards.createdAt), asc(cards.id))
          .limit(newLeft);
  return [...learned, ...unseen].sort(byDue);
}

/** The user's queue, each Card with its rating buttons' intervals, and how many Cards they rated today. */
export async function reviewQueue(db: Db, userId: string, now: Date): Promise<ReviewQueue> {
  const day = beijingDayBounds(now);
  const rows = await queueRows(db, userId, day);
  return {
    cards: rows.map((row) => ({ card: toCard(row), intervalsMs: nextIntervals(row, now) })),
    reviewedToday: await countCards(db, userId, within(cards.lastReviewedAt, day)),
  };
}

/** How many Cards the user's queue holds (the navigation's 复习 badge). */
export async function reviewCount(db: Db, userId: string, now: Date): Promise<number> {
  return (await queueRows(db, userId, beijingDayBounds(now))).length;
}

/** Rates the user's Card (PRD 4.5.3 自评) and schedules it by FSRS; false when they have no such Card. */
export async function rateCard(db: Db, userId: string, cardId: string, rating: Rating, now: Date): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(cards)
      .where(and(eq(cards.id, cardId), ofUser(userId)))
      .for("update");
    if (!row) return false;
    await tx.update(cards).set(rateSchedule(row, rating, now)).where(eq(cards.id, cardId));
    return true;
  });
}
