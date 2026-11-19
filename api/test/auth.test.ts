// Email one-time-code login, sessions and the allowlist (PRD 4.1.1, F1, AC-AUTH-01 to 05, AC-SET-02).
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { addToAllowlist, parseEmails, removeFromAllowlist } from "../src/allowlist.js";
import type { User } from "../src/contract.js";
import { allowlist, auditLog, loginCodes, users } from "../src/db/schema.js";
import { epubForm, logIn, postAuth, READER_EMAIL, sessionCookie, testApp, withCookie, WORKER_TOKEN } from "./helpers.js";

const GUEST = "guest@example.com";

async function invitedApp() {
  const t = await testApp();
  await t.db.insert(allowlist).values({ email: GUEST });
  return t;
}

describe("POST /api/auth/code", () => {
  it("emails a six-digit code to an allowlisted email", async () => {
    const { anon, mailer } = await invitedApp();
    const res = await postAuth(anon, "code", { email: GUEST });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ resendAfterSeconds: 60 });
    expect(mailer.lastCode(GUEST)).toMatch(/^\d{6}$/);
  });

  it("refuses an email that is not on the allowlist and sends nothing (AC-AUTH-02)", async () => {
    const { anon, mailer, db } = await testApp();
    const before = mailer.sent.length;
    const res = await postAuth(anon, "code", { email: "stranger@example.com" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: { code: "not_invited", message: "该邮箱暂未获得内测资格" } });
    expect(mailer.sent.length).toBe(before);
    expect(await db.select().from(loginCodes).where(eq(loginCodes.email, "stranger@example.com"))).toEqual([]);
  });

  it("refuses a second code within 60 seconds, then sends one that replaces the first (AC-AUTH-04)", async () => {
    const { anon, mailer, clock } = await invitedApp();
    await postAuth(anon, "code", { email: GUEST });
    const first = mailer.lastCode(GUEST);

    clock.advance(59_000);
    const early = await postAuth(anon, "code", { email: GUEST });
    expect(early.status).toBe(429);
    expect(early.headers.get("Retry-After")).toBe("1");
    expect(mailer.sent.filter((m) => m.email === GUEST)).toHaveLength(1);

    clock.advance(1_000);
    expect((await postAuth(anon, "code", { email: GUEST })).status).toBe(200);
    const second = mailer.lastCode(GUEST);
    if (second !== first) {
      expect((await postAuth(anon, "login", { email: GUEST, code: first })).status).toBe(400);
    }
    expect((await postAuth(anon, "login", { email: GUEST, code: second })).status).toBe(200);
  });

  it("lets the user ask again at once when the email could not be sent", async () => {
    const { anon, mailer } = await invitedApp();
    const send = mailer.sendLoginCode;
    mailer.sendLoginCode = async () => {
      throw new Error("smtp down");
    };
    const failed = await postAuth(anon, "code", { email: GUEST });
    expect(failed.status).toBe(502);
    expect(await failed.json()).toMatchObject({ error: { code: "mail_failed" } });

    mailer.sendLoginCode = send;
    expect((await postAuth(anon, "code", { email: GUEST })).status).toBe(200);
  });

  it("rejects something that is not an email", async () => {
    const { anon } = await testApp();
    expect((await postAuth(anon, "code", { email: "nope" })).status).toBe(400);
  });
});

describe("POST /api/auth/login", () => {
  it("logs in with the right code, creates the account once and sets a long-lived HttpOnly cookie (AC-AUTH-01)", async () => {
    const t = await invitedApp();
    await postAuth(t.anon, "code", { email: GUEST });
    const res = await postAuth(t.anon, "login", { email: GUEST, code: t.mailer.lastCode(GUEST) });

    expect(res.status).toBe(200);
    const user = (await res.json()) as User;
    expect(user.email).toBe(GUEST);
    const cookie = res.headers.getSetCookie()[0]!;
    expect(cookie).toMatch(/^vl_session=[\w-]{43}; Max-Age=34560000; Path=\/; HttpOnly; SameSite=Lax$/);

    const me = await withCookie(t.anon, sessionCookie(res)).request("/api/me");
    expect(await me.json()).toEqual(user);
    expect(await t.db.select().from(users).where(eq(users.email, GUEST))).toHaveLength(1);
  });

  it("marks the cookie Secure outside development", async () => {
    const t = await testApp({ secureCookie: true });
    await t.db.insert(allowlist).values({ email: GUEST });
    await postAuth(t.anon, "code", { email: GUEST });
    const res = await postAuth(t.anon, "login", { email: GUEST, code: t.mailer.lastCode(GUEST) });
    expect(res.headers.getSetCookie()[0]).toContain("; Secure");
  });

  it("treats the email case- and space-insensitively", async () => {
    const t = await invitedApp();
    await postAuth(t.anon, "code", { email: " Guest@Example.COM " });
    const res = await postAuth(t.anon, "login", { email: "GUEST@example.com", code: t.mailer.lastCode(GUEST) });
    expect(await res.json()).toMatchObject({ email: GUEST });
  });

  it("refuses a wrong code (AC-AUTH-03), an expired one, and a used one", async () => {
    const t = await invitedApp();
    const badCode = { error: { code: "invalid_code", message: "验证码错误或已过期" } };
    await postAuth(t.anon, "code", { email: GUEST });
    const code = t.mailer.lastCode(GUEST);
    const wrong = code === "000000" ? "111111" : "000000";

    const res = await postAuth(t.anon, "login", { email: GUEST, code: wrong });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(badCode);
    expect(res.headers.getSetCookie()).toEqual([]);

    expect((await postAuth(t.anon, "login", { email: GUEST, code })).status).toBe(200);
    expect((await postAuth(t.anon, "login", { email: GUEST, code })).status).toBe(400);

    t.clock.advance(60_000);
    await postAuth(t.anon, "code", { email: GUEST });
    t.clock.advance(10 * 60_000);
    const expired = await postAuth(t.anon, "login", { email: GUEST, code: t.mailer.lastCode(GUEST) });
    expect(expired.status).toBe(400);
    expect(await expired.json()).toEqual(badCode);
  });

  it("stops taking a code after five wrong guesses, and holds back the next code for the resend interval", async () => {
    const t = await invitedApp();
    await postAuth(t.anon, "code", { email: GUEST });
    const code = t.mailer.lastCode(GUEST);
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) await postAuth(t.anon, "login", { email: GUEST, code: wrong });

    expect((await postAuth(t.anon, "login", { email: GUEST, code })).status).toBe(400);
    expect((await postAuth(t.anon, "code", { email: GUEST })).status).toBe(429);
  });

  it("refuses a code once its email has been taken off the allowlist", async () => {
    const t = await invitedApp();
    await postAuth(t.anon, "code", { email: GUEST });
    await removeFromAllowlist(t.db, [GUEST], "allen");
    expect((await postAuth(t.anon, "login", { email: GUEST, code: t.mailer.lastCode(GUEST) })).status).toBe(400);
  });

  it("keeps both devices logged in when the same account logs in twice (AC-AUTH-05)", async () => {
    const t = await invitedApp();
    const laptop = withCookie(t.anon, await logIn(t, GUEST));
    t.clock.advance(60_000);
    const phone = withCookie(t.anon, await logIn(t, GUEST));

    expect((await laptop.request("/api/me")).status).toBe(200);
    expect((await phone.request("/api/me")).status).toBe(200);
  });
});

describe("POST /api/auth/logout", () => {
  it("ends this device's session only (AC-SET-02)", async () => {
    const t = await invitedApp();
    const laptopCookie = await logIn(t, GUEST);
    t.clock.advance(60_000);
    const phone = withCookie(t.anon, await logIn(t, GUEST));
    const laptop = withCookie(t.anon, laptopCookie);

    const res = await laptop.request("/api/auth/logout", { method: "POST" });
    expect(res.status).toBe(204);
    expect(res.headers.getSetCookie()[0]).toMatch(/^vl_session=; Max-Age=0; Path=\//);

    expect((await laptop.request("/api/me")).status).toBe(401);
    expect((await phone.request("/api/me")).status).toBe(200);
  });
});

describe("sessions on every route", () => {
  it("answers 401 on every user route without a session, or with an unknown one", async () => {
    const { app, anon } = await testApp();
    const book = (await (await app.request("/api/books", { method: "POST", body: epub() })).json()) as { id: string };
    const forged = withCookie(anon, "vl_session=not-a-real-token");
    const routes: [string, RequestInit?][] = [
      ["/api/me"],
      ["/api/books"],
      ["/api/books", { method: "POST", body: epub() }],
      [`/api/books/${book.id}`],
      [`/api/chapters/${crypto.randomUUID()}/sentences`],
      [`/api/books/${book.id}/audio.m3u8`],
      [`/api/books/${book.id}/segments/${crypto.randomUUID()}.ts`],
    ];
    for (const client of [anon, forged]) {
      for (const [path, init] of routes) {
        const res = await client.request(path, init);
        expect(res.status, `${init?.method ?? "GET"} ${path}`).toBe(401);
        expect(await res.json()).toEqual({ error: { code: "unauthenticated", message: "请先登录" } });
      }
    }
  });

  it("leaves health, the API document and the worker's routes outside the session", async () => {
    const { anon } = await testApp();
    expect((await anon.request("/api/health")).status).toBe(200);
    expect((await anon.request("/api/openapi.json")).status).toBe(200);
    const claim = await anon.request("/api/internal/jobs/claim", {
      method: "POST",
      headers: { Authorization: `Bearer ${WORKER_TOKEN}` },
    });
    expect(claim.status).toBe(204);
    expect((await anon.request("/api/internal/jobs/claim", { method: "POST" })).status).toBe(401);
  });

  it("renews the cookie on /api/me", async () => {
    const { app } = await testApp();
    const res = await app.request("/api/me");
    expect(res.headers.getSetCookie()[0]).toMatch(/^vl_session=[\w-]+; Max-Age=34560000;/);
    expect(await res.json()).toMatchObject({ email: READER_EMAIL });
  });
});

describe("allowlist script", () => {
  it("adds and removes emails, writing every change to the audit log", async () => {
    const { db } = await testApp();
    expect(await addToAllowlist(db, ["a@example.com", READER_EMAIL], "allen")).toEqual([
      { email: "a@example.com", result: "added" },
      { email: READER_EMAIL, result: "already_listed" },
    ]);
    expect(await removeFromAllowlist(db, ["a@example.com", "b@example.com"], "allen")).toEqual([
      { email: "a@example.com", result: "removed" },
      { email: "b@example.com", result: "not_listed" },
    ]);

    const log = await db.select().from(auditLog);
    expect(log.map(({ actor, action, target, result }) => ({ actor, action, target, result }))).toEqual([
      { actor: "allen", action: "allowlist_add", target: "a@example.com", result: "added" },
      { actor: "allen", action: "allowlist_add", target: READER_EMAIL, result: "already_listed" },
      { actor: "allen", action: "allowlist_remove", target: "a@example.com", result: "removed" },
      { actor: "allen", action: "allowlist_remove", target: "b@example.com", result: "not_listed" },
    ]);
    expect(log.every((row) => row.createdAt instanceof Date)).toBe(true);
  });

  it("logs a removed user out everywhere and refuses them a new code", async () => {
    const { app, anon, db } = await testApp();
    await removeFromAllowlist(db, [READER_EMAIL], "allen");
    expect((await app.request("/api/me")).status).toBe(401);
    expect((await postAuth(anon, "code", { email: READER_EMAIL })).status).toBe(403);
  });

  it("normalizes emails and rejects anything else", () => {
    expect(parseEmails([" Allen@Example.com"])).toEqual(["allen@example.com"]);
    expect(() => parseEmails(["allen"])).toThrow("not an email: allen");
  });
});

function epub() {
  return epubForm("x.epub");
}
