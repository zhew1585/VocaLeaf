import type { BookStatus } from "../api";
import { AudioLinesIcon, ChevronLeftIcon, CircleAlertIcon, LoaderIcon, PlaySolidIcon } from "../icons";
import { navigate } from "../router";
import { useBook } from "../useBook";

const STATUS_LABEL: Record<BookStatus, string> = {
  parsing: "解析中",
  generating: "生成中",
  ready: "已就绪",
  parse_failed: "解析失败",
};

function StatusBadge({ status }: { status: BookStatus }) {
  const icon =
    status === "parse_failed" ? <CircleAlertIcon /> : status === "parsing" ? <LoaderIcon /> : <AudioLinesIcon size={12} />;
  return (
    <span className={`status status-${status}`}>
      {icon}
      {STATUS_LABEL[status]}
    </span>
  );
}

/**
 * Book detail, design 04-2: the Book's status, 开始收听 once it is playable, and its Chapter list with Sentence
 * counts. Polls while the worker is parsing or no audio exists yet.
 */
export function BookPage({ id }: { id: string }) {
  const { book, error } = useBook(id, (b) => !b.playable);

  return (
    <div className="book-layout">
      <aside className="book-column">
        <a
          href="/"
          className="back-link"
          onClick={(e) => {
            e.preventDefault();
            navigate("/");
          }}
        >
          <ChevronLeftIcon />
          上传
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
              <StatusBadge status={book.status} />
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
          </>
        )}
      </aside>
      {book && book.chapters.length > 0 && (
        <ol className="chapters" aria-label="章节">
          {book.chapters.map((c) => (
            <li key={c.id} className="chapter-row">
              <span className="chapter-title">{c.title}</span>
              <span className="chapter-meta">{c.sentenceCount} 句</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
