// Book text in prompts (F11 风险: prompt injection): it goes in as data inside tags the system prompt names, so
// instructions written in a Book are explained, not followed. Shared by Explanations and Card backs.

/** Every tag a prompt wraps data in. */
const TAGS = ["book", "title", "author", "before", "paragraph", "after", "target_sentence", "target", "explanation"];
const TAG_PATTERN = new RegExp(`</?\\s*(?:${TAGS.join("|")})\\b[^>]*>`, "gi");

/** Removes anything in Book text (or an earlier answer) that would open or close one of the prompts' tags. */
export function asData(text: string): string {
  return text.replace(TAG_PATTERN, "");
}

/** `text` as data in a tag; nothing when there is no text. */
export function tag(name: string, text: string | null): string[] {
  return text === null ? [] : [`<${name}>${asData(text)}</${name}>`];
}
