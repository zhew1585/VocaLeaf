import Anthropic from "@anthropic-ai/sdk";
import type { AiProvider } from "./provider.js";

/** The default model: the latest Sonnet, fast enough for a chat that streams. */
export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5-5";
/** Room for a long Explanation; hitting the cap would cut the answer off. */
const MAX_TOKENS = 16_000;

/**
 * Claude through the Anthropic SDK. The key stays on the server (env), never in the web client. For the default
 * model a refusal is retried server-side on Anthropic's recommended fallback model; a refusal that still stands
 * counts as a failed call.
 */
export function anthropicProvider({ apiKey, model }: { apiKey: string; model: string }): AiProvider {
  const client = new Anthropic({ apiKey });
  const fallback = model === DEFAULT_ANTHROPIC_MODEL;
  return {
    model,
    async *stream({ system, messages }, signal) {
      const stream = client.beta.messages.stream(
        {
          model,
          max_tokens: MAX_TOKENS,
          // A chat explaining one sentence does not need deep thinking; low effort answers sooner.
          output_config: { effort: "low" },
          system,
          messages,
          ...(fallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
        },
        { signal },
      );
      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") yield event.delta.text;
      }
      const final = await stream.finalMessage();
      if (final.stop_reason === "refusal") throw new Error(`the model refused: ${final.stop_details?.category ?? "unknown"}`);
    },
  };
}
