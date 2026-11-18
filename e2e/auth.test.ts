// End-to-end: email one-time-code login on the running compose stack (F1, AC-AUTH-01 to 05, AC-SET-02).
// Codes are emailed for real over SMTP to Mailpit, and read back from Mailpit's API.
import { describe, expect, it } from "vitest";
import type { User } from "../api/src/contract.js";
import { allowlist, anonApi, codeFromMailpit, compose, freshEmail, logIn, mailCount, sql } from "./support.js";

const json = (body: unknown) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

const me = (cookie: string) => anonApi<User>("/me", { headers: { Cookie: cookie } });

describe("login through the stack", () => {
  it("refuses an email that is not invited and sends it nothing (AC-AUTH-02)", async () => {
    const email = freshEmail("stranger");
    const res = await anonApi("/auth/code", json({ email }));

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: { code: "not_invited", message: "该邮箱暂未获得内测资格" } });
    expect(await mailCount(email)).toBe(0);
  });

  it("emails an invited user a code through Mailpit, logs the code too, and logs in with it (AC-AUTH-01)", async () => {
    const email = freshEmail("invited");
    expect(allowlist("add", email)).toContain(`${email}\tadded`);

    expect((await anonApi("/auth/code", json({ email }))).status).toBe(200);
    const code = await codeFromMailpit(email);
    expect(compose("logs", "api")).toContain(`login code for ${email}: ${code}`);

    const wrong = code === "000000" ? "111111" : "000000";
    const bad = await anonApi("/auth/login", json({ email, code: wrong }));
    expect(bad.status).toBe(400);
    expect(bad.body).toEqual({ error: { code: "invalid_code", message: "验证码错误或已过期" } });

    const ok = await anonApi<User>("/auth/login", json({ email, code }));
    expect(ok.status).toBe(200);
    const cookie = ok.res.headers.getSetCookie()[0]!;
    expect(cookie).toMatch(/^vl_session=[\w-]+; Max-Age=34560000; Path=\/; HttpOnly; SameSite=Lax$/);
    expect((await me(cookie.split(";")[0]!)).body).toEqual(ok.body);
  });

  it("refuses a second code within 60 seconds (AC-AUTH-04)", async () => {
    const email = freshEmail("resend");
    allowlist("add", email);
    await anonApi("/auth/code", json({ email }));
    const again = await anonApi("/auth/code", json({ email }));
    expect(again.status).toBe(429);
    expect(Number(again.res.headers.get("Retry-After"))).toBeGreaterThan(55);
  });

  it("keeps two devices logged in, and logging out one leaves the other (AC-AUTH-05, AC-SET-02)", async () => {
    const email = freshEmail("devices");
    allowlist("add", email);
    // A used code is gone, so the second device can ask for its own straight away.
    const laptop = await logIn(email);
    const phone = await logIn(email);

    expect((await me(laptop)).status).toBe(200);
    expect((await me(phone)).status).toBe(200);

    expect((await anonApi("/auth/logout", { method: "POST", headers: { Cookie: laptop } })).status).toBe(204);
    expect((await me(laptop)).status).toBe(401);
    expect((await me(phone)).status).toBe(200);
  });

  it("answers 401 on user routes without a session", async () => {
    expect((await anonApi("/books")).status).toBe(401);
    expect((await anonApi("/me")).status).toBe(401);
  });
});

describe("allowlist script", () => {
  it("writes each change to the audit log, and removing an email logs that user out", async () => {
    const email = freshEmail("audit");
    allowlist("add", email);
    const cookie = await logIn(email);
    expect(allowlist("remove", email)).toContain(`${email}\tremoved`);

    expect(sql(`select actor, action, result from audit_log where target = '${email}' order by created_at`)).toEqual([
      "e2e|allowlist_add|added",
      "e2e|allowlist_remove|removed",
    ]);
    expect((await me(cookie)).status).toBe(401);
    expect((await anonApi("/auth/code", json({ email }))).status).toBe(403);
  });

  it("requires the operator's name", () => {
    expect(() => compose("exec", "-T", "api", "node", "dist/scripts/allowlist.js", "add", "x@vocaleaf.test")).toThrow();
  });
});
