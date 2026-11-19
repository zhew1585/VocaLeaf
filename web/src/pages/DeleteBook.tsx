import { useState } from "react";
import { deleteBook, removeFromShelf, type BookSource } from "../api";
import { ConfirmDialog } from "../ConfirmDialog";
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
  return (
    <ConfirmDialog
      title={removal.title}
      text={removal.text}
      confirmLabel={removal.confirm}
      run={() => removal.run(bookId)}
      failure="删除失败，请稍后再试"
      onCancel={onCancel}
      onDone={() => navigate("/")}
    />
  );
}
