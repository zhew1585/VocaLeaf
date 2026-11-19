import type { Env } from "../env.js";
import { anthropicProvider, DEFAULT_ANTHROPIC_MODEL } from "./anthropic.js";
import { fakeAiProvider } from "./fake.js";
import type { AiProvider } from "./provider.js";

/** The configured AI provider (env.ts AI_*); fails fast when anthropic is asked for without a key. */
export function aiProviderFromEnv(env: Env): AiProvider {
  const kind = env.AI_PROVIDER ?? (env.ANTHROPIC_API_KEY ? "anthropic" : "fake");
  if (kind === "fake") {
    console.warn("AI_PROVIDER is fake: Explanations are canned text, no model is called");
    return fakeAiProvider({ delayMs: env.AI_FAKE_DELAY_MS });
  }
  if (!env.ANTHROPIC_API_KEY) throw new Error("AI_PROVIDER=anthropic needs ANTHROPIC_API_KEY");
  return anthropicProvider({ apiKey: env.ANTHROPIC_API_KEY, model: env.AI_MODEL ?? DEFAULT_ANTHROPIC_MODEL });
}
