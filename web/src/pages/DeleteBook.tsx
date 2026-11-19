import { useEffect, useRef, useState } from "react";
import { deleteBook, removeFromShelf, type BookSource } from "../api";
import { TrashIcon } from "../icons";
import { navigate } from "../router";

/**
 * How a Book leaves the Shelf, by where it comes from. An uploaded Book is deleted (PRD 4.3.6); a Library Book is
 * only taken off this user's Shelf with their progress, Marks and Explanations, its shared audio staying (PRD 4.2.3).
 */
const REMOVAL: Record<BookSource, { button: string; title: string; text: string; confirm: string; run(id: string): Promise<void> }> = {
  upload: {
    button: "删除这本书",
    title: "删除这本书？",
    text: "删除后音频、标记和解析将被清除，已做的卡片会保留",
    confirm: "删除",
    run: deleteBook,
  },
  library: {
    button: "移出书架",
    title: "移出书架？",
    text: "移出后收听进度、标记和解析将被清除，已做的卡片会保留",
    confirm: "移出",
    run: removeFromShelf,
  },
};

/**
 * 删除这本书 on the Book detail (design 04-2) for an uploaded Book in any state, 移出书架 for a Library Book (F5).
 * Asks first; once done, the app goes back to the Shelf, which loads without it.
 */
export function DeleteBookButton({ bookId, source = "upload" }: { bookId: string; source?: BookSource }) {
  const [asking, setAsking] = useState(false);
  return (
    <>
      <button type="button" className="delete-book-button" onClick={() => setAsking(true)}>
        <TrashIcon />
        {REMOVAL[source].button}
      </button>
      {asking && <ConfirmDelete bookId={bookId} source={source} onCancel={() => setAsking(false)} />}
    </>
  );
}

/** The confirmation: 取消 (also Escape or a click outside) keeps the Book, 删除 or 移出 goes ahead. */
function ConfirmDelete({ bookId, source, onCancel }: { bookId: string; source: BookSource; onCancel(): void }) {
  const removal = REMOVAL[source];
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);

  // The safe choice has the focus, so Enter right after the click does not delete.
  useEffect(() => cancelButton.current?.focus(), []);

  async function onConfirm() {
    setDeleting(true);
    setError(null);
    try {
      await removal.run(bookId);
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
          {removal.title}
        </h2>
        <p id="delete-book-text" className="confirm-text">
          {removal.text}
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
            {removal.confirm}
          </button>
        </div>
      </div>
    </div>
  );
}
