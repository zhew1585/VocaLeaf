import { useEffect, useRef, useState } from "react";
import { dismissFromGleanings } from "./marks";

interface Props {
  sentenceId: string;
  onCancel(): void;
  /** Called once the Mark is Dismissed. */
  onDismissed(): void;
}

/**
 * The second confirmation of Dismiss (F10, PRD V1.4): 取消 (also Escape or a click outside) keeps the item, 忽略
 * Dismisses it. Shared by × in the list and 【忽略这一句】 in 句子精读.
 */
export function ConfirmDismiss({ sentenceId, onCancel, onDismissed }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);

  // The safe choice has the focus, so Enter right after the click does not Dismiss.
  useEffect(() => cancelButton.current?.focus(), []);

  async function onConfirm() {
    setBusy(true);
    setError(null);
    try {
      await dismissFromGleanings(sentenceId);
      onDismissed();
    } catch (err) {
      setError(err instanceof Error ? err.message : "忽略失败，请稍后再试");
      setBusy(false);
    }
  }

  const cancel = () => {
    if (!busy) onCancel();
  };

  return (
    <div className="confirm-backdrop" onClick={(e) => e.target === e.currentTarget && cancel()}>
      <div
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="dismiss-title"
        aria-describedby="dismiss-text"
        onKeyDown={(e) => e.key === "Escape" && cancel()}
      >
        <h2 id="dismiss-title" className="confirm-title">
          忽略这一句？
        </h2>
        <p id="dismiss-text" className="confirm-text">
          不会制作卡片，句子将从拾起移除
        </p>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="confirm-actions">
          <button ref={cancelButton} type="button" className="secondary-button" disabled={busy} onClick={cancel}>
            取消
          </button>
          <button type="button" className="confirm-button" disabled={busy} onClick={onConfirm}>
            忽略
          </button>
        </div>
      </div>
    </div>
  );
}
