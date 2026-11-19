import { useState } from "react";
import type { Book, Listening } from "../api";
import alice from "../assets/empty-alice.webp";
import gatsby from "../assets/empty-gatsby.webp";
import pride from "../assets/empty-pride.webp";
import { AudioLinesIcon, CircleAlertIcon, HeadphonesIcon, LoaderIcon, PlaySolidIcon, PlusIcon, UploadIcon } from "../icons";
import { shelfListenPath } from "../chapters";
import { followLink, navigate } from "../router";
import { BookCover } from "./BookCover";
import "./shelf.css";
import { UploadDialog } from "./UploadDialog";
import { useShelf } from "./useShelf";

/** Where a Book on the Shelf leads: a playable one to its 专注页, playing (AC-SHELF-04); any other to its detail (AC-SHELF-03). */
function bookPath(book: Book): string {
  return book.playable ? shelfListenPath(book.id) : `/books/${book.id}`;
}

function percent(listening: Listening): number {
  return Math.round(listening.share * 100);
}

/** The page title's two tabs, 书架 and 书库 (F3), and 【上传】 when the page offers it. */
export function ShelfHeader({ active, onUpload }: { active: "shelf" | "library"; onUpload?: () => void }) {
  const tab = (name: typeof active, href: string, label: string) => (
    <a
      href={href}
      className={name === active ? "shelf-tab is-active" : "shelf-tab"}
      aria-current={name === active ? "page" : undefined}
      onClick={followLink}
    >
      {label}
    </a>
  );
  return (
    <header className="shelf-header">
      <nav className="shelf-tabs" aria-label="书架与书库">
        {tab("shelf", "/", "书架")}
        {tab("library", "/library", "书库")}
      </nav>
      {onUpload && (
        <button type="button" className="upload-button" onClick={onUpload}>
          <PlusIcon />
          上传
        </button>
      )}
    </header>
  );
}

/** 【继续收听】 (design 03-2): the Book listened to last; its play button resumes at the last Sentence. */
function ContinueCard({ book, listening }: { book: Book; listening: Listening }) {
  const pct = percent(listening);
  return (
    <section className="continue-card" aria-label="继续收听">
      <BookCover book={book} className="is-small" />
      <div className="continue-info">
        <div className="continue-titles">
          <p className="continue-label">继续收听</p>
          <h2 className="continue-title">{book.title}</h2>
          {book.author && <p className="continue-author">{book.author}</p>}
        </div>
        <div className="continue-progress">
          <span>
            {listening.chapterTitle} · {pct}%
          </span>
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${pct}%` }} />
          </div>
        </div>
      </div>
      <button
        type="button"
        className="continue-play"
        aria-label={`继续收听 ${book.title}`}
        onClick={() => navigate(shelfListenPath(book.id))}
      >
        <PlaySolidIcon size={26} />
      </button>
    </section>
  );
}

/** Under a cover: how much was listened to, or where the Book is in processing (F3, PRD 4.3.3). */
function BookState({ book }: { book: Book }) {
  if (book.status === "parse_failed") {
    return (
      <span className="status status-parse_failed">
        <CircleAlertIcon />
        解析失败
      </span>
    );
  }
  if (book.status === "parsing") {
    return (
      <span className="status status-parsing">
        <LoaderIcon />
        解析中
      </span>
    );
  }
  if (book.status === "generating") {
    return (
      <span className="status status-generating">
        <AudioLinesIcon size={12} />
        生成中
      </span>
    );
  }
  if (!book.listening) return <span className="shelf-book-unstarted">未开始</span>;
  const pct = percent(book.listening);
  return (
    <span className="shelf-book-listened" aria-label={`已听 ${pct}%`}>
      <span className="progress-track">
        <span className="progress-fill" style={{ width: `${pct}%` }} />
      </span>
      {pct}%
    </span>
  );
}

function BookTile({ book }: { book: Book }) {
  return (
    <li>
      <a href={bookPath(book)} className="shelf-book" onClick={followLink}>
        <BookCover book={book} />
        <span className="shelf-book-meta">
          <span className="shelf-book-title">{book.title}</span>
          <BookState book={book} />
        </span>
      </a>
    </li>
  );
}

/** First visit with nothing on the Shelf (design 03-1, AC-GUIDE-01): the Library or an upload. */
function EmptyShelf({ onUpload }: { onUpload: () => void }) {
  return (
    <section className="empty-shelf">
      <div className="cover-fan" aria-hidden="true">
        <img src={alice} alt="" className="fan-left" />
        <img src={gatsby} alt="" className="fan-right" />
        <img src={pride} alt="" className="fan-center" />
      </div>
      <h2 className="empty-title">书架还空着</h2>
      <div className="empty-actions">
        <a href="/library" className="pill-button is-primary" onClick={followLink}>
          <HeadphonesIcon />
          从书库挑一本开始听
        </a>
        <button type="button" className="pill-button" onClick={onUpload}>
          <UploadIcon size={18} />
          上传自己的 EPUB
        </button>
      </div>
    </section>
  );
}

/**
 * 书架 (F3, designs 03-1 and 03-2): 【继续收听】 for the Book listened to last, then every other Book on the Shelf
 * with its cover and how far it was listened to or processed, in Shelf order (AC-SHELF-01). Empty, it points to
 * the Library and to uploading. 【上传】 opens the upload dialog (04-1); an uploaded Book shows up 解析中.
 */
export function ShelfPage() {
  const { books, error, reload } = useShelf();
  const [uploading, setUploading] = useState(false);
  const openUpload = () => setUploading(true);

  // The Shelf is in order, so a Book listened to is first when there is one.
  const head = books?.[0];
  const continuing = head?.listening && head.playable ? { book: head, listening: head.listening } : null;
  const others = continuing ? books!.slice(1) : (books ?? []);

  return (
    <div className="shelf-page">
      <ShelfHeader active="shelf" onUpload={openUpload} />
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {books?.length === 0 && <EmptyShelf onUpload={openUpload} />}
      {continuing && <ContinueCard {...continuing} />}
      {others.length > 0 && (
        <ul className="shelf-grid" aria-label="书架上的书">
          {others.map((b) => (
            <BookTile key={b.id} book={b} />
          ))}
        </ul>
      )}
      {uploading && (
        <UploadDialog
          onClose={() => setUploading(false)}
          onUploaded={() => {
            setUploading(false);
            reload();
          }}
        />
      )}
    </div>
  );
}
