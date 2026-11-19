import type { AiProvider, AiRequest } from "./provider.js";

export const FAKE_MODEL = "fake";
/** A question containing this makes the fake fail after its first chunk, to try the failure path by hand or in e2e. */
export const FAKE_FAILURE_MARKER = "#fail";
/** Characters per streamed chunk. */
const CHUNK_CHARS = 6;

/** The fake's whole answer: an Explanation in the fixed sections, or an answer quoting the question. */
export function fakeAnswer({ hint }: AiRequest): string {
  if (hint.kind === "ask") return `（示例回答）关于「${hint.question}」：这是开发环境的示例回答，未调用大模型。`;
  return [
    "## 句意",
    `（示例解析）${hint.sentence}`,
    "",
    "## 结构",
    "开发环境的示例结构拆解，未调用大模型。",
    "",
    "## 短语与习语",
    "- 示例短语：示例释义。",
  ].join("\n");
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });
}

/**
 * Answers without a model: the same text for the same request, streamed in small chunks `delayMs` apart (so
 * stopping and following a reply can be tried). Fails mid-answer when the question contains FAKE_FAILURE_MARKER.
 */
export function fakeAiProvider({ delayMs = 0 }: { delayMs?: number } = {}): AiProvider {
  return {
    model: FAKE_MODEL,
    async *stream(request, signal) {
      const text = fakeAnswer(request);
      for (let i = 0; i < text.length; i += CHUNK_CHARS) {
        if (signal.aborted) return;
        if (i > 0 && request.hint.question?.includes(FAKE_FAILURE_MARKER)) throw new Error("fake AI failure");
        yield text.slice(i, i + CHUNK_CHARS);
        await sleep(delayMs, signal);
      }
    },
  };
}
