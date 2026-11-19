// The daily limit of AI calls (PRD 4.7.2): DAILY_AI_CALLS per user per day in Asia/Shanghai. A call takes its place
// before the model is called, so two calls at once cannot both take the last one; a failed call gives it back.
import { and, eq, sql } from "drizzle-orm";
import { DAILY_AI_CALLS } from "../contract.js";
import type { Db } from "../db/client.js";
import { aiUsage } from "../db/schema.js";

const BEIJING_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" });

/** The day `now` falls on in Asia/Shanghai, as YYYY-MM-DD: the limit resets at 00:00 Beijing time. */
export function beijingDay(now: Date): string {
  return BEIJING_DAY.format(now);
}

/** AI calls the user has left on `day`. */
export async function aiCallsLeft(db: Db, userId: string, day: string): Promise<number> {
  const [row] = await db
    .select({ count: aiUsage.count })
    .from(aiUsage)
    .where(and(eq(aiUsage.userId, userId), eq(aiUsage.day, day)));
  return Math.max(0, DAILY_AI_CALLS - (row?.count ?? 0));
}

/** Takes one of the user's calls for `day`; false when none is left. */
export async function takeAiCall(db: Db, userId: string, day: string): Promise<boolean> {
  const rows = await db
    .insert(aiUsage)
    .values({ userId, day, count: 1 })
    .onConflictDoUpdate({
      target: [aiUsage.userId, aiUsage.day],
      set: { count: sql`${aiUsage.count} + 1` },
      setWhere: sql`${aiUsage.count} < ${DAILY_AI_CALLS}`,
    })
    .returning({ count: aiUsage.count });
  return rows.length > 0;
}

/** Gives back a call taken on `day` whose AI call failed (failed calls are not counted). */
export async function returnAiCall(db: Db, userId: string, day: string): Promise<void> {
  await db
    .update(aiUsage)
    .set({ count: sql`greatest(${aiUsage.count} - 1, 0)` })
    .where(and(eq(aiUsage.userId, userId), eq(aiUsage.day, day)));
}
