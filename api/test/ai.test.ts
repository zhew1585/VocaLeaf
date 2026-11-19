// Unit tests of the AI seam: which provider the environment picks, the fake's behaviour, and the quota's day.
import { describe, expect, it } from "vitest";
import { DEFAULT_ANTHROPIC_MODEL } from "../src/ai/anthropic.js";
import { FAKE_FAILURE_MARKER, FAKE_MODEL, fakeAiProvider } from "../src/ai/fake.js";
import { aiProviderFromEnv } from "../src/ai/from-env.js";
import type { AiRequest } from "../src/ai/provider.js";
import { loadEnv } from "../src/env.js";
import { beijingDay } from "../src/explanations/quota.js";

const BASE = {
  DATABASE_URL: "postgres://x",
  S3_ENDPOINT: "http://s3.local",
  S3_BUCKET: "b",
  S3_ACCESS_KEY_ID: "k",
  S3_SECRET_ACCESS_KEY: "s",
  WORKER_TOKEN: "0123456789abcdef",
  SMTP_URL: "smtp://mail",
  MAIL_FROM: "x@example.com",
};

const ask = (question: string): AiRequest => ({
  system: "",
  messages: [{ role: "user", content: question }],
  hint: { kind: "ask", sentence: "It is a truth.", question },
});

async function collect(iter: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const chunk of iter) out.push(chunk);
  return out;
}

describe("aiProviderFromEnv", () => {
  it("answers with the fake when no key is configured, so no secret is needed", () => {
    expect(aiProviderFromEnv(loadEnv(BASE)).model).toBe(FAKE_MODEL);
    expect(aiProviderFromEnv(loadEnv({ ...BASE, AI_PROVIDER: "", ANTHROPIC_API_KEY: "", AI_MODEL: "" })).model).toBe(FAKE_MODEL);
  });

  it("uses Claude, by default the latest Sonnet, once a key is configured", () => {
    expect(aiProviderFromEnv(loadEnv({ ...BASE, ANTHROPIC_API_KEY: "test-key" })).model).toBe(DEFAULT_ANTHROPIC_MODEL);
    expect(aiProviderFromEnv(loadEnv({ ...BASE, ANTHROPIC_API_KEY: "test-key", AI_MODEL: "claude-haiku-5-5" })).model).toBe(
      "claude-haiku-5-5",
    );
  });

  it("refuses AI_PROVIDER=anthropic without a key, and lets AI_PROVIDER=fake win over a key", () => {
    expect(() => aiProviderFromEnv(loadEnv({ ...BASE, AI_PROVIDER: "anthropic" }))).toThrow(/ANTHROPIC_API_KEY/);
    expect(aiProviderFromEnv(loadEnv({ ...BASE, AI_PROVIDER: "fake", ANTHROPIC_API_KEY: "k" })).model).toBe(FAKE_MODEL);
  });
});

describe("fakeAiProvider", () => {
  it("streams the same answer in several chunks every time", async () => {
    const ai = fakeAiProvider();
    const first = await collect(ai.stream(ask("why?"), new AbortController().signal));
    expect(first.length).toBeGreaterThan(1);
    expect(await collect(ai.stream(ask("why?"), new AbortController().signal))).toEqual(first);
  });

  it("fails mid-answer when asked to", async () => {
    const ai = fakeAiProvider();
    await expect(collect(ai.stream(ask(`why ${FAKE_FAILURE_MARKER}`), new AbortController().signal))).rejects.toThrow();
  });

  it("stops once aborted", async () => {
    const stop = new AbortController();
    stop.abort();
    expect(await collect(fakeAiProvider().stream(ask("why?"), stop.signal))).toEqual([]);
  });
});

describe("beijingDay", () => {
  it("turns over at 00:00 in Asia/Shanghai (16:00 UTC)", () => {
    expect(beijingDay(new Date("2026-11-18T15:59:59Z"))).toBe("2026-11-18");
    expect(beijingDay(new Date("2026-11-18T16:00:00Z"))).toBe("2026-11-19");
  });
});
