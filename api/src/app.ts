import { OpenAPIHono } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import type { AiProvider } from "./ai/provider.js";
import type { Mailer } from "./auth/mailer.js";
import { authRoutes } from "./auth/routes.js";
import { requireSession } from "./auth/session.js";
import { audioRoutes } from "./books/audio-routes.js";
import { deleteBookRoutes } from "./books/delete.js";
import { libraryRoutes } from "./books/library-routes.js";
import { bookRoutes } from "./books/routes.js";
import { cardRoutes } from "./cards/routes.js";
import { bookTimelineRoutes } from "./books/timeline-routes.js";
import { shelfRoutes } from "./books/shelf-routes.js";
import { skipRoutes } from "./books/skip.js";
import { uploadRoutes } from "./books/upload-routes.js";
import { voiceRoutes } from "./books/voice-routes.js";
import type { Db } from "./db/client.js";
import { explanationRoutes } from "./explanations/routes.js";
import { jobRoutes } from "./jobs/routes.js";
import { markRoutes } from "./marks/routes.js";
import { reviewRoutes } from "./review/routes.js";
import { usageRoutes } from "./settings/usage-routes.js";
import type { ObjectStorage } from "./storage.js";

export interface AppDeps {
  db: Db;
  storage: ObjectStorage;
  /** Shared secret the worker presents as a bearer token on /internal routes. */
  workerToken: string;
  /** Sends login codes by email. */
  mailer: Mailer;
  /** Whether the session cookie is Secure (HTTPS only); false only in development over plain http. */
  secureCookie: boolean;
  /** How long a claimed job stays with its worker before another worker may claim it. */
  jobLeaseMs: number;
  /** Writes Explanations, answers follow-up questions and writes Card backs (ai/provider.ts). */
  ai: AiProvider;
  /** Current time; injectable so tests can expire leases and login codes without waiting. */
  now?: () => Date;
}

/**
 * Builds the HTTP app. Every route lives under /api; the OpenAPI document is /api/openapi.json.
 * Every route needs a session except login, health, the document and the worker's /internal routes.
 */
export function createApp(deps: AppDeps) {
  const app = new OpenAPIHono().basePath("/api");
  app.openAPIRegistry.registerComponent("securitySchemes", "workerToken", { type: "http", scheme: "bearer" });
  app.use("*", requireSession(deps.db));
  app.get("/health", (c) => c.json({ ok: true }));
  app.route("/", authRoutes(deps));
  app.route("/", uploadRoutes(deps));
  app.route("/", shelfRoutes(deps));
  app.route("/", libraryRoutes(deps));
  app.route("/", bookRoutes(deps));
  app.route("/", skipRoutes(deps));
  app.route("/", bookTimelineRoutes(deps));
  app.route("/", deleteBookRoutes(deps));
  app.route("/", voiceRoutes(deps));
  app.route("/", audioRoutes(deps));
  app.route("/", markRoutes(deps));
  app.route("/", explanationRoutes(deps));
  app.route("/", usageRoutes(deps));
  app.route("/", cardRoutes(deps));
  app.route("/", reviewRoutes(deps));
  app.route("/", jobRoutes(deps));
  app.doc31("/openapi.json", { openapi: "3.1.0", info: { title: "VocaLeaf API", version: "0.1.0" } });
  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    console.error(err);
    return c.json({ error: { code: "internal", message: "服务器出错了，请稍后再试" } }, 500);
  });
  return app;
}
