// 制作卡片 (F12, PRD 4.5.2): selecting text of 句子精读's Sentence widens the selection to whole words and floats
// 【制作卡片】 under it; the API makes the Card (or finds the one of the same Target), asking first when the user has a
// Card of the same Target in another Sentence.
import { resolveTarget, type Target } from "@vocaleaf/api/card-target";
import { useEffect, useRef, useState, type RefObject } from "react";
import { ApiRequestError, createCard, type MadeCard } from "../api";
import { PlusIcon } from "../icons";

/** Characters of `container`'s text before (node, offset). */
function charOffset(container: Node, node: Node, offset: number): number {
  const before = document.createRange();
  before.selectNodeContents(container);
  before.setEnd(node, offset);
  return before.toString().length;
}

/** The text node and offset in it at character `at` of `container`'s text. */
function pointAt(container: Node, at: number): [Node, number] {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let passed = 0;
  let last: Text | null = null;
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    if (at <= passed + node.length) return [node, at - passed];
    passed += node.length;
    last = node;
  }
  return last ? [last, last.length] : [container, 0];
}

/** A selection of the Sentence widened to its Target, and where its button goes (relative to the container's parent). */
export interface SelectedTarget extends Target {
  /** Below the selection's start; null when the browser cannot measure it. */
  place: { top: number; left: number } | null;
}

/**
 * Follows the user's selection in `container`, which shows exactly `text`: on mouse up or a key, a selection of words
 * is widened to whole words on screen too (制卡规则 2); collapsing it or selecting elsewhere drops it.
 */
export function useTextSelection(container: RefObject<HTMLElement | null>, text: string) {
  const [selected, setSelected] = useState<SelectedTarget | null>(null);

  useEffect(() => {
    const onChange = () => {
      const sel = window.getSelection();
      const el = container.current;
      if (!sel || sel.isCollapsed || !el || sel.rangeCount === 0 || !el.contains(sel.getRangeAt(0).commonAncestorContainer)) {
        setSelected(null);
      }
    };
    document.addEventListener("selectionchange", onChange);
    return () => document.removeEventListener("selectionchange", onChange);
  }, [container]);

  /** Reads the selection once the user let go of it. */
  const update = () => {
    const sel = window.getSelection();
    const el = container.current;
    if (!sel || !el || sel.isCollapsed || sel.rangeCount === 0) return setSelected(null);
    const range = sel.getRangeAt(0);
    if (!el.contains(range.commonAncestorContainer)) return setSelected(null);
    const target = resolveTarget(
      text,
      charOffset(el, range.startContainer, range.startOffset),
      charOffset(el, range.endContainer, range.endOffset),
    );
    if (!target) return setSelected(null);
    const widened = document.createRange();
    widened.setStart(...pointAt(el, target.start));
    widened.setEnd(...pointAt(el, target.end));
    sel.removeAllRanges();
    sel.addRange(widened);
    setSelected({ ...target, place: placeBelow(el, widened) });
  };

  const clear = () => {
    window.getSelection()?.removeAllRanges();
    setSelected(null);
  };

  return { selected, update, clear };
}

/** Where the button goes: under the selection's first line, from its left, relative to the text's parent. */
function placeBelow(el: HTMLElement, range: Range): SelectedTarget["place"] {
  const rects = range.getClientRects?.();
  const parent = el.parentElement;
  if (!rects || rects.length === 0 || !parent) return null;
  const box = parent.getBoundingClientRect();
  const last = rects[rects.length - 1]!;
  return { top: last.bottom - box.top + 8, left: Math.max(0, rects[0]!.left - box.left) };
}

interface Props {
  sentenceId: string;
  selected: SelectedTarget;
  /**
   * Called with true once making starts: the button, its error and the duplicate prompt then stay, even when the
   * selection goes (the prompt takes the focus); false when the prompt is cancelled.
   */
  onHold(held: boolean): void;
  /** The Card made, or the Sentence's Card of the same Target (制卡规则 3). */
  onMade(made: MadeCard): void;
}

/** 【制作卡片】 under a selection: loading while the Card is made (F12), then hands it over; asks on a duplicate. */
export function MakeCardButton({ sentenceId, selected, onHold, onMade }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<string | null>(null);

  const make = async (allowDuplicate: boolean) => {
    onHold(true);
    setBusy(true);
    setError(null);
    setDuplicate(null);
    try {
      const body = { sentenceId, start: selected.start, end: selected.end };
      onMade(await createCard(allowDuplicate ? { ...body, allowDuplicate } : body));
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 409) setDuplicate(err.message);
      else setError(err instanceof Error ? err.message : "制作失败，请稍后再试");
      setBusy(false);
    }
  };

  return (
    <>
      <div className="make-card" style={selected.place ?? undefined}>
        <button
          type="button"
          className="make-card-button"
          disabled={busy}
          aria-busy={busy}
          // Pressing it must not drop the selection it is about.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => void make(false)}
        >
          {busy ? <span className="make-card-ring" aria-hidden="true" /> : <PlusIcon size={16} />}
          制作卡片
        </button>
        {error && (
          <p className="make-card-error" role="alert">
            {error}
          </p>
        )}
      </div>
      {duplicate && (
        <ConfirmDuplicate
          message={duplicate}
          onCancel={() => {
            setDuplicate(null);
            onHold(false);
          }}
          onConfirm={() => void make(true)}
        />
      )}
    </>
  );
}

/** 重复提示 (PRD 4.5.2 规则 4): the Target has a Card in another Sentence; 仍要创建 makes another, never merged. */
function ConfirmDuplicate({ message, onCancel, onConfirm }: { message: string; onCancel(): void; onConfirm(): void }) {
  const cancelButton = useRef<HTMLButtonElement>(null);
  useEffect(() => cancelButton.current?.focus(), []);
  return (
    <div
      className="confirm-backdrop"
      // Clicks here keep the Sentence's selection, which the dialog is about.
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => e.target === e.currentTarget && onCancel()}
    >
      <div
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="duplicate-card-title"
        onKeyDown={(e) => e.key === "Escape" && onCancel()}
      >
        <h2 id="duplicate-card-title" className="confirm-title">
          {message}
        </h2>
        <div className="confirm-actions">
          <button ref={cancelButton} type="button" className="secondary-button" onClick={onCancel}>
            取消
          </button>
          <button type="button" className="confirm-button" onClick={onConfirm}>
            仍要创建
          </button>
        </div>
      </div>
    </div>
  );
}
