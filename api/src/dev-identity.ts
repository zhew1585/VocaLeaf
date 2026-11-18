import { createMiddleware } from "hono/factory";

// TEMPORARY dev identity, replaced by email one-time-code login in #6.
// Every request acts as this one fixed user. To replace: swap `currentUser` for real
// session middleware that sets the same `userId` variable; route handlers stay unchanged.
export const DEV_USER_ID = "00000000-0000-4000-8000-000000000001";

export type UserEnv = { Variables: { userId: string } };

export const currentUser = createMiddleware<UserEnv>(async (c, next) => {
  c.set("userId", DEV_USER_ID);
  await next();
});
