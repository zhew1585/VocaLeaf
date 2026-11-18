// Email one-time-code login (PRD 4.1.1, F1; ADR 0003): only allowlisted emails get a code, and a correct code
// creates the account on first login and starts a session.
import { randomInt } from "node:crypto";
import { eq } from "drizzle-orm";
import { LOGIN_CODE_LENGTH, LOGIN_CODE_RESEND_SECONDS } from "../contract.js";
import type { Db } from "../db/client.js";
import type { Tx } from "../jobs/lifecycle.js";
import { allowlist, loginCodes, users } from "../db/schema.js";
import type { Mailer } from "./mailer.js";
import { createSession, sha256 } from "./session.js";

/** How long a code can be used. Stated in the email (auth/mailer.ts). */
export const LOGIN_CODE_TTL_MS = 10 * 60 * 1000;
/**
 * Wrong guesses allowed per code; after them the code no longer works and a new one must be sent. With the resend
 * interval this caps guessing at five a minute per email.
 */
export const MAX_FAILED_ATTEMPTS = 5;

export type IssueResult = { ok: true } | { ok: false; reason: "not_invited" } | { ok: false; reason: "too_soon"; retryAfterSeconds: number };

async function isInvited(db: Db | Tx, email: string): Promise<boolean> {
  const [row] = await db.select({ email: allowlist.email }).from(allowlist).where(eq(allowlist.email, email));
  return row !== undefined;
}

function codeHash(email: string, code: string): string {
  return sha256(`${email}:${code}`);
}

/**
 * Sends a new code to an allowlisted email, replacing any earlier one. Nothing is sent to other emails
 * (AC-AUTH-02), nor within the resend interval of the previous code (AC-AUTH-04).
 */
export async function issueCode(db: Db, mailer: Mailer, email: string, now: Date): Promise<IssueResult> {
  if (!(await isInvited(db, email))) return { ok: false, reason: "not_invited" };

  const [previous] = await db.select({ sentAt: loginCodes.sentAt }).from(loginCodes).where(eq(loginCodes.email, email));
  const waitMs = previous ? previous.sentAt.getTime() + LOGIN_CODE_RESEND_SECONDS * 1000 - now.getTime() : 0;
  if (waitMs > 0) return { ok: false, reason: "too_soon", retryAfterSeconds: Math.ceil(waitMs / 1000) };

  const code = String(randomInt(10 ** LOGIN_CODE_LENGTH)).padStart(LOGIN_CODE_LENGTH, "0");
  const row = { codeHash: codeHash(email, code), sentAt: now, expiresAt: new Date(now.getTime() + LOGIN_CODE_TTL_MS), failedAttempts: 0 };
  await db.insert(loginCodes).values({ email, ...row }).onConflictDoUpdate({ target: loginCodes.email, set: row });
  try {
    await mailer.sendLoginCode(email, code);
  } catch (err) {
    // The user never got this code, so do not make them wait out the resend interval for it.
    await db.delete(loginCodes).where(eq(loginCodes.email, email));
    throw err;
  }
  return { ok: true };
}

/**
 * Checks a code and, when it is right, consumes it, creates the account on first login and starts a session.
 * Undefined for a wrong, expired, used or exhausted code, or an email no longer on the allowlist.
 */
export async function logIn(db: Db, email: string, code: string, now: Date) {
  const user = await db.transaction(async (tx) => {
    const [stored] = await tx.select().from(loginCodes).where(eq(loginCodes.email, email)).for("update");
    if (!stored || stored.expiresAt <= now || stored.failedAttempts >= MAX_FAILED_ATTEMPTS) return undefined;
    if (stored.codeHash !== codeHash(email, code)) {
      // Kept rather than deleted once exhausted, so its send time still holds back the next code.
      await tx.update(loginCodes).set({ failedAttempts: stored.failedAttempts + 1 }).where(eq(loginCodes.email, email));
      return undefined;
    }
    await tx.delete(loginCodes).where(eq(loginCodes.email, email));
    if (!(await isInvited(tx, email))) return undefined;
    await tx.insert(users).values({ email }).onConflictDoNothing();
    const [row] = await tx.select({ id: users.id, email: users.email }).from(users).where(eq(users.email, email));
    return row!;
  });
  if (!user) return undefined;
  return { user, token: await createSession(db, user.id) };
}
