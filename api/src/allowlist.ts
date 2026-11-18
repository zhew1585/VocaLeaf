// The invite allowlist (PRD 4.1.1), changed only by operators through scripts/allowlist.ts.
// Every change is written to the audit log (PRD 4.6.2), including ones that changed nothing.
import { asc, eq, inArray } from "drizzle-orm";
import { EmailSchema } from "./contract.js";
import type { Db } from "./db/client.js";
import { allowlist, auditLog, sessions, users } from "./db/schema.js";

export type AllowlistChange = { email: string; result: "added" | "already_listed" | "removed" | "not_listed" };

/** Normalizes emails the way login reads them; throws on anything that is not an email. */
export function parseEmails(raw: string[]): string[] {
  return raw.map((e) => {
    const parsed = EmailSchema.safeParse(e);
    if (!parsed.success) throw new Error(`not an email: ${e}`);
    return parsed.data;
  });
}

/** Adds emails to the allowlist on behalf of `actor`. */
export async function addToAllowlist(db: Db, emails: string[], actor: string): Promise<AllowlistChange[]> {
  return db.transaction(async (tx) => {
    const changes: AllowlistChange[] = [];
    for (const email of emails) {
      const inserted = await tx.insert(allowlist).values({ email }).onConflictDoNothing().returning();
      const result = inserted.length > 0 ? "added" : "already_listed";
      await tx.insert(auditLog).values({ actor, action: "allowlist_add", target: email, result });
      changes.push({ email, result });
    }
    return changes;
  });
}

/**
 * Removes emails from the allowlist on behalf of `actor`. Their sessions end too, so a removed user is logged out
 * everywhere; the account and its Books stay.
 */
export async function removeFromAllowlist(db: Db, emails: string[], actor: string): Promise<AllowlistChange[]> {
  return db.transaction(async (tx) => {
    const changes: AllowlistChange[] = [];
    for (const email of emails) {
      const deleted = await tx.delete(allowlist).where(eq(allowlist.email, email)).returning();
      const ids = tx.select({ id: users.id }).from(users).where(eq(users.email, email));
      await tx.delete(sessions).where(inArray(sessions.userId, ids));
      const result = deleted.length > 0 ? "removed" : "not_listed";
      await tx.insert(auditLog).values({ actor, action: "allowlist_remove", target: email, result });
      changes.push({ email, result });
    }
    return changes;
  });
}

export async function listAllowlist(db: Db) {
  return db.select().from(allowlist).orderBy(asc(allowlist.email));
}
