import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { and, eq, isNull } from "drizzle-orm";
import type { AppDeps } from "../app.js";
import {
  CodeSentSchema,
  ErrorSchema,
  LOGIN_CODE_RESEND_SECONDS,
  LoginSchema,
  RequestCodeSchema,
  UserSchema,
} from "../contract.js";
import { users } from "../db/schema.js";
import { validationHook } from "../validation.js";
import { issueCode, logIn } from "./login.js";
import { endSession, renewSessionCookie, sessionUser, setSessionCookie, unauthenticated, type UserEnv } from "./session.js";

const json = (schema: typeof ErrorSchema | typeof UserSchema | typeof CodeSentSchema, description: string) => ({
  description,
  content: { "application/json": { schema } },
});

const requestCodeRoute = createRoute({
  method: "post",
  path: "/auth/code",
  summary: "Email a login code to an allowlisted address (PRD 4.1.1)",
  request: { body: { required: true, content: { "application/json": { schema: RequestCodeSchema } } } },
  responses: {
    200: json(CodeSentSchema, "Code sent"),
    400: json(ErrorSchema, "Invalid email"),
    403: json(ErrorSchema, "Email is not on the allowlist; nothing is sent"),
    429: { ...json(ErrorSchema, "A code was sent less than a minute ago"), headers: { "Retry-After": { schema: { type: "integer" } } } },
    502: json(ErrorSchema, "The email could not be sent; may be retried at once"),
  },
});

const loginRoute = createRoute({
  method: "post",
  path: "/auth/login",
  summary: "Log in with the emailed code; sets the session cookie",
  request: { body: { required: true, content: { "application/json": { schema: LoginSchema } } } },
  responses: {
    200: json(UserSchema, "Logged in"),
    400: json(ErrorSchema, "Wrong or expired code"),
  },
});

const logoutRoute = createRoute({
  method: "post",
  path: "/auth/logout",
  summary: "End this device's session; other devices stay logged in",
  responses: { 204: { description: "Logged out" } },
});

const meRoute = createRoute({
  method: "get",
  path: "/me",
  summary: "The logged-in user; also renews the session cookie",
  responses: { 200: json(UserSchema, "Current user"), 401: json(ErrorSchema, "Not logged in") },
});

const playGuideRoute = createRoute({
  method: "put",
  path: "/me/play-guide",
  summary: "Records that the user saw the first-play guide (F2, AC-GUIDE-02), so it does not show on their next play",
  responses: { 204: { description: "Recorded" } },
});

const badCode = { error: { code: "invalid_code", message: "验证码错误或已过期" } } as const;

/** Login, logout, the current user and what the app remembers about them. */
export function authRoutes({ db, mailer, secureCookie, now = () => new Date() }: AppDeps) {
  const app = new OpenAPIHono<UserEnv>({ defaultHook: validationHook });

  app.openapi(requestCodeRoute, async (c) => {
    const { email } = c.req.valid("json");
    let result;
    try {
      result = await issueCode(db, mailer, email, now());
    } catch (err) {
      console.error("sending login code failed", err);
      return c.json({ error: { code: "mail_failed", message: "验证码发送失败，请稍后再试" } }, 502);
    }
    if (result.ok) return c.json({ resendAfterSeconds: LOGIN_CODE_RESEND_SECONDS }, 200);
    if (result.reason === "not_invited") {
      return c.json({ error: { code: "not_invited", message: "该邮箱暂未获得内测资格" } }, 403);
    }
    return c.json(
      { error: { code: "resend_too_soon", message: `请 ${result.retryAfterSeconds} 秒后再试` } },
      429,
      { "Retry-After": String(result.retryAfterSeconds) },
    );
  });

  app.openapi(loginRoute, async (c) => {
    const { email, code } = c.req.valid("json");
    const session = await logIn(db, email, code, now());
    if (!session) return c.json(badCode, 400);
    setSessionCookie(c, session.token, secureCookie);
    return c.json(session.user, 200);
  });

  app.openapi(logoutRoute, async (c) => {
    await endSession(db, c);
    return c.body(null, 204);
  });

  // Behind requireSession like every non-auth route; looks the session up again for the user's email.
  app.openapi(meRoute, async (c) => {
    const user = await sessionUser(db, c);
    if (!user) return c.json(unauthenticated, 401);
    renewSessionCookie(c, secureCookie);
    return c.json(user, 200);
  });

  app.openapi(playGuideRoute, async (c) => {
    // The first time counts; reopening the guide later (settings, #18) changes nothing.
    await db
      .update(users)
      .set({ playGuideSeenAt: now() })
      .where(and(eq(users.id, c.get("userId")), isNull(users.playGuideSeenAt)));
    return c.body(null, 204);
  });

  return app;
}
