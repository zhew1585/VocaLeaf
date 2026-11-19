import { useEffect, useRef, useState } from "react";
import { deleteBook } from "../api";
import { TrashIcon } from "../icons";
import { navigate } from "../router";

/** PRD 4.3.6: what deleting takes away, and what it keeps. */
const CONFIRM_TEXT = "删除后音频、标记和解析将被清除，已做的卡片会保留";

/**
 * 删除这本书 on the Book detail (design 04-2), for an uploaded Book in any state. Asks first; once deleted, the
 * app goes back to the Shelf, which loads without it.
 */
export function DeleteBookButton({ bookId }: { bookId: string }) {
  const [asking, setAsking] = useState(false);
  return (
    <>
      <button type="button" className="delete-book-button" onClick={() => setAsking(true)}>
        <TrashIcon />
        删除这本书
      </button>
      {asking && <ConfirmDelete bookId={bookId} onCancel={() => setAsking(false)} />}
    </>
  );
}

/** The confirmation: 取消 (also Escape or a click outside) keeps the Book, 删除 deletes it. */
function ConfirmDelete({ bookId, onCancel }: { bookId: string; onCancel(): void }) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);

  // The safe choice has the focus, so Enter right after the click does not delete.
  useEffect(() => cancelButton.current?.focus(), []);

  async function onConfirm() {
    setDeleting(true);
    setError(null);
    try {
      await deleteBook(bookId);
      navigate("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "删除失败，请稍后再试");
      setDeleting(false);
    }
  }

  const cancel = () => {
    if (!deleting) onCancel();
  };

  return (
    <div className="confirm-backdrop" onClick={(e) => e.target === e.currentTarget && cancel()}>
      <div
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-book-title"
        aria-describedby="delete-book-text"
        onKeyDown={(e) => e.key === "Escape" && cancel()}
      >
        <h2 id="delete-book-title" className="confirm-title">
          删除这本书？
        </h2>
        <p id="delete-book-text" className="confirm-text">
          {CONFIRM_TEXT}
        </p>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="confirm-actions">
          <button ref={cancelButton} type="button" className="secondary-button" disabled={deleting} onClick={cancel}>
            取消
          </button>
          <button type="button" className="confirm-button" disabled={deleting} onClick={onConfirm}>
            删除
          </button>
        </div>
      </div>
    </div>
  );
}
