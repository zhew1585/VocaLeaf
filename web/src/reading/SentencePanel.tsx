import { useLayoutEffect, useRef, useState } from "react";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  LeafIcon,
  LocateIcon,
  PanelRightCloseIcon,
  PanelRightIcon,
  TextCursorInputIcon,
  Volume2Icon,
} from "../icons";
import { SentenceChat } from "./SentenceChat";
import "./sentence-panel.css";

/** Opens the 句子精读 panel; shown at the top right of the reading area while it is collapsed (AC-READ-14). */
export function SentencePanelToggle({ onOpen }: { onOpen(): void }) {
  return (
    <button type="button" className="icon-button panel-toggle" aria-label="展开句子精读" title="展开句子精读" onClick={onOpen}>
      <PanelRightIcon />
    </button>
  );
}

/** The Sentence the panel is about. */
export interface PanelSentence {
  id: string;
  text: string;
}

/**
 * The 叶片 (Mark) toggle's state and action. Marks belong to #13; the 专注页 passes null until it wires them, and
 * the leaf is then shown but disabled.
 */
export interface MarkToggle {
  marked: boolean;
  toggle(): void;
}

/** 【试听本句】 of the panel's Sentence: idle, loading (a thin ring) or playing; `play` starts it from its start. */
export interface AuditionControl {
  state: "idle" | "loading" | "playing";
  play(): void;
}

interface Props {
  sentence: PanelSentence | null;
  onClose(): void;
  /** 【定位原文】: scrolls the text to the Sentence, playback untouched. */
  onLocate(): void;
  /** Null when the Sentence has no audio to play yet. */
  audition: AuditionControl | null;
  mark: MarkToggle | null;
}

/** The selected Sentence in large type, folded to four lines when longer (AC-PANEL-11). */
function FixedSentence({ text }: { text: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current!;
    setOverflowing(el.scrollHeight > el.clientHeight + 1);
  }, [text]);
  return (
    <div className="panel-sentence">
      <p ref={ref} className={expanded ? "panel-sentence-text" : "panel-sentence-text is-folded"}>
        {text}
      </p>
      {overflowing && (
        <button type="button" className="panel-sentence-fold" onClick={() => setExpanded((e) => !e)}>
          {expanded ? "收起原句" : "展开原句"}
          {expanded ? <ChevronUpIcon /> : <ChevronDownIcon />}
        </button>
      )}
    </div>
  );
}

function SentenceActions({ onLocate, audition, mark }: Pick<Props, "onLocate" | "audition" | "mark">) {
  return (
    <div className="panel-actions">
      <button
        type="button"
        className="panel-action"
        aria-label="试听本句"
        title="试听本句"
        disabled={audition === null}
        aria-busy={audition?.state === "loading"}
        onClick={audition?.play}
      >
        {audition?.state === "loading" ? <span className="panel-action-ring" aria-hidden="true" /> : <Volume2Icon />}
      </button>
      <button type="button" className="panel-action" aria-label="定位原文" title="定位原文" onClick={onLocate}>
        <LocateIcon />
      </button>
      <span className="panel-actions-spacer" />
      <button
        type="button"
        className={mark?.marked ? "panel-action is-marked" : "panel-action"}
        aria-label={mark?.marked ? "取消标记" : "标记"}
        title={mark?.marked ? "取消标记" : "标记"}
        aria-pressed={mark?.marked ?? false}
        disabled={mark === null}
        onClick={mark?.toggle}
      >
        <LeafIcon size={18} />
      </button>
    </div>
  );
}

/**
 * The 句子精读 sidebar (F11, design 01 ⑤): a fixed area with the selected Sentence and its actions (试听, 定位,
 * 标记), then the chat about it. Without a Sentence it asks the user to pick one. Collapsing it keeps the
 * selection and the chat (they live outside the panel).
 */
export function SentencePanel({ sentence, onClose, onLocate, audition, mark }: Props) {
  return (
    <aside className="sentence-panel" aria-label="句子精读">
      <header className="sentence-panel-header">
        <h2>句子精读</h2>
        <button type="button" className="icon-button" aria-label="收起句子精读" title="收起句子精读" onClick={onClose}>
          <PanelRightCloseIcon />
        </button>
      </header>
      {sentence && (
        <div className="panel-fixed">
          <FixedSentence key={sentence.id} text={sentence.text} />
          <SentenceActions onLocate={onLocate} audition={audition} mark={mark} />
        </div>
      )}
      <SentenceChat key={sentence?.id ?? "none"} sentenceId={sentence?.id ?? null}>
        {!sentence && (
          <div className="sentence-panel-empty">
            <TextCursorInputIcon />
            <p className="sentence-panel-empty-title">选择一句正文</p>
            <p>选中一句原文，在这里试听、解析或提问</p>
          </div>
        )}
      </SentenceChat>
    </aside>
  );
}
