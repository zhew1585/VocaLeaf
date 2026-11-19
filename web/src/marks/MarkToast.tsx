import { useEffect, useRef, useState, type ReactNode } from "react";
import { LeafIcon } from "../icons";
import type { BookMarks } from "./useMarks";

/** How long a Mark's Toast stays (PRD 4.4.2 前台反馈). */
const TOAST_MS = 4000;
/** The Toast shows this many characters of the Sentence (PRD 4.4.2 规则 5). */
const PREVIEW_CHARS = 30;

/** 已标记：{the Sentence's first 30 characters}…, without the ellipsis when the Sentence is that short. */
export function markedText(sentence: string | undefined): string {
  if (sentence === undefined) return "已标记";
  const chars = [...sentence];
  return `已标记：${chars.length > PREVIEW_CHARS ? `${chars.slice(0, PREVIEW_CHARS).join("")}…` : sentence}`;
}

type Shown = { n: number; text: string; undo?: () => void };

interface Options {
  /** The Sentence a press marks now (the session's markTarget). */
  target(): Promise<string | null>;
  /** The text of a loaded Sentence, for the Toast. */
  textOf(sentenceId: string): string | undefined;
  marks: BookMarks;
}

/**
 * 【标记】 and M (PRD 4.4.2, F8): marks the target Sentence and says so in a Toast with 撤销, or says 【已标记】 when it
 * is pending already (AC-MARK-03). Returns the press and the Toast to render.
 */
export function useMarkPress({ target, textOf, marks }: Options): { press(): void; toast: ReactNode } {
  const [shown, setShown] = useState<Shown | null>(null);
  const count = useRef(0);
  const latest = useRef({ target, textOf, marks });
  latest.current = { target, textOf, marks };

  useEffect(() => {
    if (!shown) return;
    const timer = setTimeout(() => setShown(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [shown]);

  const show = (text: string, undo?: () => void) => setShown({ n: ++count.current, text, undo });

  const press = async () => {
    const { target, textOf, marks } = latest.current;
    const id = await target();
    if (id === null) return;
    if (marks.isMarked(id)) return show("已标记");
    const text = textOf(id);
    try {
      const outcome = await marks.mark(id);
      if (outcome === "already") return show("已标记");
      show(markedText(text), () => {
        setShown(null);
        marks.unmark(id).catch((err: unknown) => console.warn("undoing a Mark failed", err));
      });
    } catch (err) {
      // Refused by the API (the Sentence is gone); the leaf and underline were taken back.
      console.warn("marking failed", err);
    }
  };

  const toast = shown && (
    <div key={shown.n} className="mark-toast" role="status" aria-label="标记提示">
      <LeafIcon size={16} />
      <span className="mark-toast-text">{shown.text}</span>
      {shown.undo && (
        <button type="button" className="mark-toast-undo" onClick={shown.undo}>
          撤销
        </button>
      )}
    </div>
  );

  return { press: () => void press(), toast };
}
