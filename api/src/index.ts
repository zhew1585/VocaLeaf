import { serve } from "@hono/node-server";
import { aiProviderFromEnv } from "./ai/from-env.js";
import { createApp } from "./app.js";
import { loggingMailer, smtpMailer } from "./auth/mailer.js";
import { connectDb } from "./db/client.js";
import { loadEnv, s3Config } from "./env.js";
import { ensureBucket, s3Storage } from "./storage.js";

const env = loadEnv();
const db = await connectDb(env.DATABASE_URL);
const s3 = s3Config(env);
await ensureBucket(s3);
const storage = s3Storage(s3);
const dev = env.APP_ENV === "development";
const smtp = smtpMailer(env.SMTP_URL, env.MAIL_FROM);
const app = createApp({
  db,
  storage,
  mailer: dev ? loggingMailer(smtp) : smtp,
  secureCookie: !dev,
  workerToken: env.WORKER_TOKEN,
  jobLeaseMs: env.JOB_LEASE_SECONDS * 1000,
  ai: aiProviderFromEnv(env),
});

serve({ fetch: app.fetch, port: env.PORT }, ({ port }) => console.log(`api listening on :${port}`));
