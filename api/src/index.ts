import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { connectDb } from "./db/client.js";
import { loadEnv } from "./env.js";
import { ensureBucket, s3Storage, type S3Config } from "./storage.js";

const env = loadEnv();
const db = await connectDb(env.DATABASE_URL);
const s3: S3Config = {
  endpoint: env.S3_ENDPOINT,
  region: env.S3_REGION,
  bucket: env.S3_BUCKET,
  accessKeyId: env.S3_ACCESS_KEY_ID,
  secretAccessKey: env.S3_SECRET_ACCESS_KEY,
};
await ensureBucket(s3);
const storage = s3Storage(s3);
const app = createApp({ db, storage, workerToken: env.WORKER_TOKEN, jobLeaseMs: env.JOB_LEASE_SECONDS * 1000 });

serve({ fetch: app.fetch, port: env.PORT }, ({ port }) => console.log(`api listening on :${port}`));
