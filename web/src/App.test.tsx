import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UNAUTHORIZED_EVENT } from "./api";
import { App } from "./App";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.pushState(null, "", "/");
});

const unauthenticated = () => Response.json({ error: { code: "unauthenticated", message: "请先登录" } }, { status: 401 });

describe("App", () => {
  it("shows the login page when this device has no session", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => unauthenticated()));
    render(<App />);
    expect(await screen.findByRole("button", { name: "发送验证码" })).toBeTruthy();
  });

  it("shows the app with the account when logged in, and goes back to login when a request answers 401", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ id: "u1", email: "allen@vocaleaf.app" })));
    render(<App />);
    expect(await screen.findByText("allen@vocaleaf.app")).toBeTruthy();
    expect(screen.getByText("上传书籍")).toBeTruthy();

    act(() => {
      window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    });
    expect(screen.getByRole("button", { name: "发送验证码" })).toBeTruthy();
  });

  it("logs this device out and returns to the login page at / (AC-SET-02)", async () => {
    window.history.pushState(null, "", "/books/b1");
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/api/me") return Response.json({ id: "u1", email: "allen@vocaleaf.app" });
      if (url === "/api/auth/logout") return new Response(null, { status: 204 });
      return new Promise<Response>(() => {}); // the Book page's load never answers here
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "退出登录" }));

    expect(await screen.findByRole("button", { name: "发送验证码" })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/logout", { method: "POST" });
    expect(window.location.pathname).toBe("/");
  });
});
