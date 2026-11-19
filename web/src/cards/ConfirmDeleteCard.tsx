import { useEffect, useRef, useState } from "react";
import { deleteCard } from "../api";

interface Props {
  cardId: string;
  onCancel(): void;
  /** Called once the Card is deleted. */
  onDeleted(): void;
}

/**
 * The second confirmation of deleting a Card (PRD 4.5.2 删除): 取消 (also Escape or a click outside) keeps it, 删除
 * deletes it for good.
 */
export function ConfirmDeleteCard({ cardId, onCancel, onDeleted }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);

  // The safe choice has the focus, so Enter right after the click does not delete.
  useEffect(() => cancelButton.current?.focus(), []);

  async function onConfirm() {
    setBusy(true);
    setError(null);
    try {
      await deleteCard(cardId);
      onDeleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "删除失败，请稍后再试");
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
        aria-labelledby="delete-card-title"
        aria-describedby="delete-card-text"
        onKeyDown={(e) => e.key === "Escape" && cancel()}
      >
        <h2 id="delete-card-title" className="confirm-title">
          删除这张卡片？
        </h2>
        <p id="delete-card-text" className="confirm-text">
          删除后不可恢复，复习中也不会再出现
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
            删除
          </button>
        </div>
      </div>
    </div>
  );
}
