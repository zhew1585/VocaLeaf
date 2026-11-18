import { PanelRightCloseIcon, PanelRightIcon, TextCursorInputIcon } from "../icons";

/** Opens the 句子精读 panel; shown at the top right of the reading area while it is collapsed (AC-READ-14). */
export function SentencePanelToggle({ onOpen }: { onOpen(): void }) {
  return (
    <button type="button" className="icon-button panel-toggle" aria-label="展开句子精读" title="展开句子精读" onClick={onOpen}>
      <PanelRightIcon />
    </button>
  );
}

/**
 * The 句子精读 sidebar (design 01, 侧栏展开与收起), only its frame for now: picking a Sentence to listen to,
 * explain or ask about comes with #14.
 */
export function SentencePanel({ onClose }: { onClose(): void }) {
  return (
    <aside className="sentence-panel" aria-label="句子精读">
      <header className="sentence-panel-header">
        <h2>句子精读</h2>
        <button type="button" className="icon-button" aria-label="收起句子精读" title="收起句子精读" onClick={onClose}>
          <PanelRightCloseIcon />
        </button>
      </header>
      <div className="sentence-panel-empty">
        <TextCursorInputIcon />
        <p className="sentence-panel-empty-title">选择一句正文</p>
        <p>选中一句原文，在这里试听、解析或提问</p>
      </div>
    </aside>
  );
}
