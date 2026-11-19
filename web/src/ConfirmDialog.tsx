import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface Props {
  title: string;
  text: string;
  /** The confirm button's label: 删除, 忽略, 移出, … */
  confirmLabel: string;
  /** What confirming does; while it runs both buttons wait, and a failure shows its message. */
  run(): Promise<void>;
  /** Shown when `run` fails without a message of its own. */
  failure: string;
  onCancel(): void;
  /** Called once `run` succeeded. */
  onDone(): void;
  /** On its way out (usePresence): it fades away and takes no clicks. */
  exiting?: boolean;
}

/**
 * A second confirmation in the design's shared dialog style (paper, 取消 sunken + ink confirm): 取消 (also Escape or a
 * click outside) keeps things as they are, the confirm button runs the action. Used by deleting a Book or a Card and
 * by Dismiss. Rendered over the whole page (in the body), so nothing around where it is used, such as a panel
 * sliding away, moves or fades it.
 */
export function ConfirmDialog({ title, text, confirmLabel, run, failure, onCancel, onDone, exiting = false }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const id = useId();

  // The safe choice has the focus, so Enter right after the click does not confirm.
  useEffect(() => cancelButton.current?.focus(), []);

  async function onConfirm() {
    setBusy(true);
    setError(null);
    try {
      await run();
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : failure);
      setBusy(false);
    }
  }

  const cancel = () => {
    if (!busy) onCancel();
  };

  return createPortal(
    <div
      className={exiting ? "confirm-backdrop is-exiting" : "confirm-backdrop"}
      onClick={(e) => e.target === e.currentTarget && cancel()}
    >
      <div
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-text`}
        onKeyDown={(e) => e.key === "Escape" && cancel()}
      >
        <h2 id={`${id}-title`} className="confirm-title">
          {title}
        </h2>
        <p id={`${id}-text`} className="confirm-text">
          {text}
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
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
