import { OpenAPIHono } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { bookRoutes } from "./books/routes.js";
import type { Db } from "./db/client.js";
import { jobRoutes } from "./jobs/routes.js";
import type { ObjectStorage } from "./storage.js";

export interface AppDeps {
  db: Db;
  storage: ObjectStorage;
  /** Shared secret the worker presents as a bearer token on /internal routes. */
  workerToken: string;
}

/** Builds the HTTP app. Every route lives under /api; the OpenAPI document is /api/openapi.json. */
export function createApp(deps: AppDeps) {
  const app = new OpenAPIHono().basePath("/api");
  app.openAPIRegistry.registerComponent("securitySchemes", "workerToken", { type: "http", scheme: "bearer" });
  app.get("/health", (c) => c.json({ ok: true }));
  app.route("/", bookRoutes(deps));
  app.route("/", jobRoutes(deps));
  app.doc31("/openapi.json", { openapi: "3.1.0", info: { title: "VocaLeaf API", version: "0.1.0" } });
  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    console.error(err);
    return c.json({ error: { code: "internal", message: "服务器出错了，请稍后再试" } }, 500);
  });
  return app;
}
