// Today's Review queue (PRD 4.5.3 今日队列) and rating its Cards. A day runs from 00:00 to 00:00 Asia/Shanghai, as
// the daily AI limit's does (explanations/quota.ts).
import { and, asc, count, eq, gte, lt, ne } from "drizzle-orm";
import { DAILY_NEW_CARDS, type Rating, type ReviewItem } from "../contract.js";
import type { Db } from "../db/client.js";
import { cards } from "../db/schema.js";
import { toCard } from "../cards/cards.js";
import { beijingDay } from "../explanations/quota.js";
import { nextIntervals, rateSchedule } from "./schedule.js";

type CardRow = typeof cards.$inferSelect;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Start and end of the Asia/Shanghai day `now` falls on. */
function today(now: Date): { start: Date; end: Date } {
  const start = new Date(`${beijingDay(now)}T00:00:00+08:00`);
  return { start, end: new Date(start.getTime() + DAY_MS) };
}

const ofUser = (userId: string) => eq(cards.userId, userId);
const learnedDueBy = (end: Date) => and(ne(cards.state, "new"), lt(cards.due, end));

/** New Cards the user's Review may still take in today: the daily limit less those first rated today. */
async function newCardsLeft(db: Db, userId: string, day: { start: Date; end: Date }): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(cards)
    .where(and(ofUser(userId), gte(cards.firstReviewedAt, day.start), lt(cards.firstReviewedAt, day.end)));
  return Math.max(0, DAILY_NEW_CARDS - (row?.n ?? 0));
}

const byDue = (a: CardRow, b: CardRow) =>
  a.due.getTime() - b.due.getTime() || a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id);

/**
 * The user's queue: learned Cards due by the end of today, plus new Cards by creation up to what the day's limit
 * has left, all by due date. A Card rated today and due again today (a learning step) is in it again.
 */
export async function reviewQueue(db: Db, userId: string, now: Date): Promise<ReviewItem[]> {
  const day = today(now);
  const newLeft = await newCardsLeft(db, userId, day);
  const learned = await db.select().from(cards).where(and(ofUser(userId), learnedDueBy(day.end)));
  const fresh =
    newLeft === 0
      ? []
      : await db
          .select()
          .from(cards)
          .where(and(ofUser(userId), eq(cards.state, "new")))
          .orderBy(asc(cards.createdAt), asc(cards.id))
          .limit(newLeft);
  return [...learned, ...fresh].sort(byDue).map((row) => ({ card: toCard(row), intervalsMs: nextIntervals(row, now) }));
}

/** How many Cards the user's queue holds (the navigation's 复习 badge). */
export async function reviewCount(db: Db, userId: string, now: Date): Promise<number> {
  const day = today(now);
  const newLeft = await newCardsLeft(db, userId, day);
  const counted = async (condition: ReturnType<typeof and>) =>
    (await db.select({ n: count() }).from(cards).where(and(ofUser(userId), condition)))[0]?.n ?? 0;
  return (await counted(learnedDueBy(day.end))) + Math.min(newLeft, await counted(eq(cards.state, "new")));
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
