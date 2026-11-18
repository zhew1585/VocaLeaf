import { createTransport } from "nodemailer";
import { LOGIN_CODE_TTL_MS } from "./login.js";

/** Sends login codes. SMTP in the app (Mailpit in development, ADR 0003); a recorder in tests. */
export interface Mailer {
  sendLoginCode(email: string, code: string): Promise<void>;
}

/** Mailer over SMTP; `url` is a nodemailer connection URL such as smtp://mailpit:1025 or smtps://user:pass@host:465. */
export function smtpMailer(url: string, from: string): Mailer {
  const transport = createTransport(url);
  return {
    async sendLoginCode(email, code) {
      await transport.sendMail({
        from,
        to: email,
        subject: `拾页登录验证码：${code}`,
        text: `你的拾页登录验证码是 ${code}，${LOGIN_CODE_TTL_MS / 60_000} 分钟内有效。\n如果不是你本人在登录，请忽略这封邮件。`,
      });
    },
  };
}

/** Development only: also writes each code to the API log, so logging in needs no mailbox at all. */
export function loggingMailer(inner: Mailer): Mailer {
  return {
    async sendLoginCode(email, code) {
      console.log(`login code for ${email}: ${code}`);
      await inner.sendLoginCode(email, code);
    },
  };
}
