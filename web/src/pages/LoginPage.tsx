import { useEffect, useRef, useState, type FormEvent } from "react";
import { ApiRequestError, logIn, requestLoginCode, type User } from "../api";
import artUrl from "../assets/login-art.webp";
import logoUrl from "../assets/logo.webp";
import { LockIcon, MailIcon } from "../icons";

/** Login codes are six digits (PRD 4.1.1). */
const CODE_LENGTH = 6;

/** Seconds left until `deadline` (ms timestamp), re-rendering once a second until it passes; 0 after. */
function useSecondsUntil(deadline: number): number {
  const [, tick] = useState(0);
  useEffect(() => {
    if (deadline <= Date.now()) return;
    const timer = setInterval(() => {
      tick((n) => n + 1);
      if (Date.now() >= deadline) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [deadline]);
  return Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
}

/**
 * Login page, design 02-1: an allowlisted email gets a six-digit code, and the right code opens the app (F1).
 * The code field and 【登录】 appear once a code is sent; 重新发送 counts down the resend interval (AC-AUTH-04).
 */
export function LoginPage({ onLoggedIn }: { onLoggedIn: (user: User) => void }) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [resendAt, setResendAt] = useState(0);
  const [pending, setPending] = useState<"send" | "login" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const codeInput = useRef<HTMLInputElement>(null);
  const resendIn = useSecondsUntil(resendAt);

  async function sendCode() {
    setPending("send");
    setError(null);
    try {
      const { resendAfterSeconds } = await requestLoginCode(email.trim());
      setCodeSent(true);
      setResendAt(Date.now() + resendAfterSeconds * 1000);
      setCode("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "验证码发送失败，请稍后再试");
      // Asked again too soon: a code is already on its way, so let the user type it while the wait runs out.
      if (err instanceof ApiRequestError && err.retryAfterSeconds !== null) {
        setCodeSent(true);
        setResendAt(Date.now() + err.retryAfterSeconds * 1000);
      }
    } finally {
      setPending(null);
    }
  }

  async function submitCode() {
    setPending("login");
    setError(null);
    try {
      onLoggedIn(await logIn(email.trim(), code));
    } catch (err) {
      setError(err instanceof Error ? err.message : "登录失败，请稍后再试");
      setPending(null);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (pending) return;
    if (codeSent) void submitCode();
    else void sendCode();
  }

  useEffect(() => {
    if (codeSent) codeInput.current?.focus();
  }, [codeSent]);

  return (
    <div className="login">
      <aside className="login-art" style={{ backgroundImage: `url(${artUrl})` }}>
        <blockquote className="login-quote">
          “It is a truth universally acknowledged, that a single man in possession of a good fortune, must be in want
          of a wife.”
        </blockquote>
        <p className="login-quote-source">Jane Austen · Pride and Prejudice</p>
      </aside>
      <section className="login-panel">
        <div className="login-column">
          <div className="login-brand">
            <img className="login-logo" src={logoUrl} alt="" width={56} height={56} />
            <div className="login-titles">
              <h1 className="login-name">拾页</h1>
              <p className="login-tagline">听原版书，拾起每一句没听懂的。</p>
            </div>
          </div>
          <form className="login-form" onSubmit={onSubmit} noValidate>
            <label className="login-field">
              <MailIcon />
              <input
                type="email"
                name="email"
                autoComplete="email"
                placeholder="受邀邮箱"
                aria-label="邮箱"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  // A code belongs to the email it was sent to; a different email starts over.
                  setCodeSent(false);
                  setError(null);
                }}
              />
            </label>
            {codeSent && (
              <label className="login-field">
                <input
                  ref={codeInput}
                  name="code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder={`${CODE_LENGTH} 位验证码`}
                  aria-label="验证码"
                  maxLength={CODE_LENGTH}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                />
                <button type="button" className="login-resend" disabled={pending !== null || resendIn > 0} onClick={sendCode}>
                  {pending === "send" ? "发送中…" : resendIn > 0 ? `${resendIn} 秒后重发` : "重新发送"}
                </button>
              </label>
            )}
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            {codeSent ? (
              <button type="submit" className="primary-button" disabled={pending !== null || code.length !== CODE_LENGTH}>
                {pending === "login" ? "登录中…" : "登录"}
              </button>
            ) : (
              <button type="submit" className="primary-button" disabled={pending !== null || email.trim() === ""}>
                {pending === "send" ? "发送中…" : "发送验证码"}
              </button>
            )}
          </form>
        </div>
        <p className="login-note">
          <LockIcon />
          内测期间仅限受邀邮箱
        </p>
      </section>
    </div>
  );
}
