import { useEffect, useState } from "react";
import { getBook, type BookDetail, type BookStatus } from "../api";
import { AudioLinesIcon, ChevronLeftIcon, CircleAlertIcon, LoaderIcon } from "../icons";
import { navigate } from "../router";

const POLL_MS = 1500;

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

/** Book detail, design 04-2: the Book's status and its Chapter list with Sentence counts. */
export function BookPage({ id }: { id: string }) {
  const [book, setBook] = useState<BookDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Poll while the worker is parsing; the Chapter list appears once parsing is done.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active = true;
    const load = async () => {
      try {
        const next = await getBook(id);
        if (!active) return;
        setBook(next);
        setError(null);
        if (next.status === "parsing") timer = setTimeout(load, POLL_MS);
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : "加载失败");
      }
    };
    void load();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [id]);

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
            <StatusBadge status={book.status} />
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
