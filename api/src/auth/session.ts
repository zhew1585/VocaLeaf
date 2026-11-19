// Sessions: an opaque random token in an HttpOnly cookie, stored only as its hash. A cookie rather than a bearer
// header because the browser fetches HLS audio by itself (native HLS on iOS Safari cannot add headers).
import { createHash, randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import type { Db } from "../db/client.js";
import { sessions, users } from "../db/schema.js";

export const SESSION_COOKIE = "vl_session";
/** Browsers cap cookie lifetime at 400 days; /api/me renews it, so an active device stays logged in (PRD 4.1.1). */
const COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;

export type UserEnv = { Variables: { userId: string } };

export const unauthenticated = { error: { code: "unauthenticated", message: "请先登录" } } as const;

/** The columns of a user as the API returns them (contract.ts UserSchema). */
export const userFields = {
  id: users.id,
  email: users.email,
  playGuideSeen: sql<boolean>`${users.playGuideSeenAt} is not null`.mapWith(Boolean),
};

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Starts a session for the user and returns the token for the cookie. */
export async function createSession(db: Db, userId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await db.insert(sessions).values({ tokenHash: sha256(token), userId });
  return token;
}

/** The user behind the request's session cookie, or undefined. */
export async function sessionUser(db: Db, c: Context) {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return undefined;
  const [row] = await db
    .select(userFields)
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.tokenHash, sha256(token)));
  return row;
}

/** Ends this device's session only; the user's other devices stay logged in. */
export async function endSession(db: Db, c: Context): Promise<void> {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await db.delete(sessions).where(eq(sessions.tokenHash, sha256(token)));
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

/**
 * Sets the session cookie. SameSite=Lax keeps it off cross-site POSTs (CSRF). `secure` is off only in development,
 * where the stack is served over plain http.
 */
export function setSessionCookie(c: Context, token: string, secure: boolean): void {
  setCookie(c, SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
    secure,
    maxAge: COOKIE_MAX_AGE_SECONDS,
  });
}

/** Sends the request's session cookie back with a fresh lifetime. */
export function renewSessionCookie(c: Context, secure: boolean): void {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) setSessionCookie(c, token, secure);
}

/** Paths that work without a session: login itself, health, the API document and the worker's bearer-token routes. */
const PUBLIC_PATHS = [/^\/api\/health$/, /^\/api\/openapi\.json$/, /^\/api\/auth\//, /^\/api\/internal\//];

/** Every other path requires a session and gets its user as `userId`; without one it is 401. */
export function requireSession(db: Db) {
  return createMiddleware<UserEnv>(async (c, next) => {
    if (PUBLIC_PATHS.some((p) => p.test(c.req.path))) return next();
    const user = await sessionUser(db, c);
    if (!user) return c.json(unauthenticated, 401);
    c.set("userId", user.id);
    await next();
  });
}
