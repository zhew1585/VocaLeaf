import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LoginPage } from "./LoginPage";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const user = { id: "u1", email: "allen@vocaleaf.app" };
const error = (code: string, message: string, status: number, headers?: HeadersInit) =>
  Response.json({ error: { code, message } }, { status, headers });

/** Answers each API path with the given responses in turn; records every call. */
function stubApi(routes: Record<string, (() => Response)[]>) {
  const calls: { path: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.replace(/^\/api/, "");
      calls.push({ path, body: init?.body ? JSON.parse(init.body as string) : undefined });
      const next = routes[path]?.shift();
      if (!next) throw new Error(`unexpected ${path}`);
      return next();
    }),
  );
  return calls;
}

const codeSent = () => Response.json({ resendAfterSeconds: 60 });

async function sendCodeTo(email: string) {
  fireEvent.change(screen.getByLabelText("邮箱"), { target: { value: email } });
  fireEvent.click(screen.getByRole("button", { name: "发送验证码" }));
}

describe("LoginPage", () => {
  it("sends a code, then shows the code field and a 60-second resend countdown (AC-AUTH-04)", async () => {
    const calls = stubApi({ "/auth/code": [codeSent] });
    render(<LoginPage onLoggedIn={() => {}} />);
    expect(screen.getByRole("button", { name: "发送验证码" })).toBeDisabled();

    await sendCodeTo(" allen@vocaleaf.app ");

    expect(await screen.findByLabelText("验证码")).toBeTruthy();
    expect(calls).toEqual([{ path: "/auth/code", body: { email: "allen@vocaleaf.app" } }]);
    expect(screen.getByRole("button", { name: "60 秒后重发" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "登录" })).toBeDisabled();
  });

  it("enables 重新发送 once the countdown runs out", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    stubApi({ "/auth/code": [codeSent] });
    render(<LoginPage onLoggedIn={() => {}} />);
    await sendCodeTo("allen@vocaleaf.app");
    await screen.findByLabelText("验证码");

    act(() => vi.advanceTimersByTime(59_000));
    expect(screen.getByRole("button", { name: /秒后重发/ })).toBeDisabled();
    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.getByRole("button", { name: "重新发送" })).toBeEnabled();
  });

  it("tells an email that is not invited, and asks for no code (AC-AUTH-02)", async () => {
    stubApi({ "/auth/code": [() => error("not_invited", "该邮箱暂未获得内测资格", 403)] });
    render(<LoginPage onLoggedIn={() => {}} />);

    await sendCodeTo("stranger@example.com");

    expect(await screen.findByText("该邮箱暂未获得内测资格")).toBeTruthy();
    expect(screen.queryByLabelText("验证码")).toBeNull();
  });

  it("asked again too soon, shows the code field with the wait the API names", async () => {
    stubApi({ "/auth/code": [() => error("resend_too_soon", "请 42 秒后再试", 429, { "Retry-After": "42" })] });
    render(<LoginPage onLoggedIn={() => {}} />);

    await sendCodeTo("allen@vocaleaf.app");

    expect(await screen.findByLabelText("验证码")).toBeTruthy();
    expect(screen.getByRole("button", { name: "42 秒后重发" })).toBeDisabled();
  });

  it("shows the error for a wrong code (AC-AUTH-03), then logs in with the right one (AC-AUTH-01)", async () => {
    const calls = stubApi({
      "/auth/code": [codeSent],
      "/auth/login": [() => error("invalid_code", "验证码错误或已过期", 400), () => Response.json(user)],
    });
    const onLoggedIn = vi.fn();
    render(<LoginPage onLoggedIn={onLoggedIn} />);
    await sendCodeTo("allen@vocaleaf.app");
    const code = await screen.findByLabelText("验证码");

    fireEvent.change(code, { target: { value: "12a34 5" } });
    expect((code as HTMLInputElement).value).toBe("12345");
    fireEvent.change(code, { target: { value: "000000" } });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));
    expect(await screen.findByText("验证码错误或已过期")).toBeTruthy();
    expect(onLoggedIn).not.toHaveBeenCalled();

    fireEvent.change(code, { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));
    await vi.waitFor(() => expect(onLoggedIn).toHaveBeenCalledWith(user));
    expect(calls.at(-1)).toEqual({ path: "/auth/login", body: { email: "allen@vocaleaf.app", code: "123456" } });
  });

  it("starts over when the email is changed after a code was sent", async () => {
    stubApi({ "/auth/code": [codeSent] });
    render(<LoginPage onLoggedIn={() => {}} />);
    await sendCodeTo("allen@vocaleaf.app");
    await screen.findByLabelText("验证码");

    fireEvent.change(screen.getByLabelText("邮箱"), { target: { value: "other@vocaleaf.app" } });

    expect(screen.queryByLabelText("验证码")).toBeNull();
    expect(screen.getByRole("button", { name: "发送验证码" })).toBeEnabled();
  });
});
