import { z } from "zod";
import type { S3Config } from "./storage.js";

const EnvSchema = z.object({
  PORT: z.coerce.number().int().default(3000),
  DATABASE_URL: z.string().min(1),
  S3_ENDPOINT: z.url(),
  S3_REGION: z.string().default("auto"),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  WORKER_TOKEN: z.string().min(16),
  // development: login codes also go to the log and the session cookie works over plain http.
  APP_ENV: z.enum(["development", "production"]).default("production"),
  // Where login codes are sent: a nodemailer SMTP URL, e.g. smtp://mailpit:1025 or smtps://user:pass@smtp.example.com:465.
  SMTP_URL: z.string().min(1),
  MAIL_FROM: z.string().min(1),
  // Technical config: how long a worker holds a claimed job before it may be claimed again.
  JOB_LEASE_SECONDS: z.coerce.number().int().positive().default(600),
});

export type Env = z.infer<typeof EnvSchema>;

/** Reads and validates configuration from the environment; exits early with a clear message. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`Invalid environment:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

/** The object storage settings (ADR 0003: S3-compatible config only). */
export function s3Config(env: Env): S3Config {
  return {
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    bucket: env.S3_BUCKET,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  };
}
