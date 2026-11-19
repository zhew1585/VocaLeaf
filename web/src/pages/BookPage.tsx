import type { Book } from "../api";
import { AudioLinesIcon, ChevronLeftIcon, PlaySolidIcon } from "../icons";
import { followLink, navigate } from "../router";
import { StatusBadge } from "../StatusBadge";
import { useBook } from "../useBook";
import { ChapterList } from "./ChapterList";
import { DeleteBookButton } from "./DeleteBook";

/** 生成中 with generated / narrated Chapters and a bar (design 04-2, PRD 4.3.3 进度展示). */
function GenerationProgress({ progress }: { progress: Book["progress"] }) {
  const { generated, narrated } = progress;
  return (
    <div className="generation">
      <div className="generation-label">
        <span className="status status-generating">
          <AudioLinesIcon size={14} />
          生成中
        </span>
        <span className="generation-count" aria-label="生成进度">
          {generated} / {narrated}
        </span>
      </div>
      <div className="generation-track">
        <div className="generation-fill" style={{ width: `${narrated > 0 ? (generated / narrated) * 100 : 0}%` }} />
      </div>
    </div>
  );
}

/**
 * Book detail, design 04-2: the Book's status or generation progress, 开始收听 once it is playable, and its
 * Chapters with their state; a 生成失败 one can be retried. Kept current while the worker parses and generates.
 * 删除这本书 is there in every state, 解析中 and 生成中 included (PRD 4.3.6); a Library Book has 移出书架 instead.
 * A Library Book never offers Voice changes or Skipped toggles (AC-LIB-03): those controls (#19, #20) show only
 * for `source === "upload"`.
 */
export function BookPage({ id }: { id: string }) {
  const { book, error, reload } = useBook(id);

  return (
    <div className="book-layout">
      <aside className="book-column">
        <a
          href="/"
          className="back-link"
          onClick={followLink}
        >
          <ChevronLeftIcon />
          书架
        </a>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {book && (
          <>
            <div className="book-titles">
              <h1 className="book-title">{book.title}</h1>
              {book.author && <p className="book-author">{book.author}</p>}
            </div>
            <div className="book-status">
              {book.status === "generating" ? (
                <GenerationProgress progress={book.progress} />
              ) : (
                <StatusBadge status={book.status} />
              )}
              {book.status === "parse_failed" && book.failureReason && (
                <p className="form-error">{book.failureReason}</p>
              )}
            </div>
            {book.status !== "parse_failed" && (
              <button
                type="button"
                className="primary-button listen-button"
                disabled={!book.playable}
                onClick={() => navigate(`/books/${id}/listen`)}
              >
                <PlaySolidIcon size={18} />
                开始收听
              </button>
            )}
            <DeleteBookButton bookId={id} source={book.source} />
          </>
        )}
      </aside>
      {book && book.chapters.length > 0 && (
        <ChapterList
          bookId={id}
          chapters={book.chapters}
          // A Library Book's generation is the operators' job (PRD 6.2).
          onRetried={book.source === "upload" ? reload : undefined}
        />
      )}
    </div>
  );
}
