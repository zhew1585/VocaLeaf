// The one seam to the language model (ADR 0003): Explanations and follow-up answers go through an AiProvider.
// Which provider and model is deployment configuration (PRD 4.7.2); without a key a deterministic fake answers,
// so development, tests and the e2e stack need no secret.
import type { ChatMessage } from "../contract.js";

/** One call to the model: a system prompt and the conversation so far, ending with the user's turn. */
export interface AiRequest {
  system: string;
  messages: ChatMessage[];
  /** What is asked, for deterministic fakes only; real providers answer from `system` and `messages`. */
  hint: { kind: "explain" | "ask"; sentence: string; question?: string };
}

export interface AiProvider {
  /** The model answers are generated with, stored with each Explanation. */
  readonly model: string;
  /**
   * Streams the answer's text as it is generated. Throws when the call fails; stops (and the iteration ends or
   * throws) once `signal` aborts.
   */
  stream(request: AiRequest, signal: AbortSignal): AsyncIterable<string>;
}
