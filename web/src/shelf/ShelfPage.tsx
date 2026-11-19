import { useState, type ReactNode } from "react";
import type { Book, Listening } from "../api";
import alice from "../assets/empty-alice.webp";
import gatsby from "../assets/empty-gatsby.webp";
import pride from "../assets/empty-pride.webp";
import { HeadphonesIcon, InfoIcon, PauseSolidIcon, PlaySolidIcon, PlusIcon, UploadIcon } from "../icons";
import { shelfListenPath } from "../chapters";
import { usePresence } from "../motion";
import { followLink, navigate } from "../router";
import { StatusBadge } from "../StatusBadge";
import { BookCover } from "./BookCover";
import "./shelf.css";
import { UploadDialog } from "./UploadDialog";
import { useShelf } from "./useShelf";
import { useShelfPlay } from "./useShelfPlay";

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

/** 详情 on a cover: the Book's detail (F5), where it is deleted, its Voice changed and its Chapters managed. */
function DetailButton({ book }: { book: Book }) {
  return (
    <button type="button" className="cover-action" aria-label={`${book.title} 详情`} onClick={() => navigate(`/books/${book.id}`)}>
      <InfoIcon size={14} />
      详情
    </button>
  );
}

/**
 * Over a cover, shown under the pointer: its buttons, on the cover darkened. Elsewhere on it a click goes to `href`,
 * as clicking the Book does (keyboard users have the Book's own link).
 */
function CoverActions({ href, stacked = false, children }: { href: string; stacked?: boolean; children: ReactNode }) {
  return (
    <div
      className={stacked ? "cover-actions is-stacked" : "cover-actions"}
      onClick={(e) => e.target === e.currentTarget && navigate(href)}
    >
      {children}
    </div>
  );
}

/**
 * 【继续收听】 (design 03-2): the Book listened to last. Anywhere on the card opens its 专注页 with playback as it
 * was, like the sidebar's 当前收听; the play button only plays or pauses, as the session shows it; 详情 shows on
 * the cover under the pointer.
 */
function ContinueCard({ book, listening }: { book: Book; listening: Listening }) {
  const pct = percent(listening);
  const { playing, toggle } = useShelfPlay(book);
  return (
    <section className="continue-card" aria-label="继续收听">
      <div className="continue-cover">
        <BookCover book={book} className="is-small" />
        <CoverActions href={`/books/${book.id}/listen`}>
          <DetailButton book={book} />
        </CoverActions>
      </div>
      <a href={`/books/${book.id}/listen`} className="continue-link" onClick={followLink}>
        <span className="continue-titles">
          <span className="continue-label">继续收听</span>
          <span className="continue-title" role="heading" aria-level={2}>
            {book.title}
          </span>
          {book.author && <span className="continue-author">{book.author}</span>}
        </span>
        <span className="continue-progress">
          <span>
            {listening.chapterTitle} · {pct}%
          </span>
          <span className="progress-track">
            <span className="progress-fill" style={{ width: `${pct}%` }} />
          </span>
        </span>
      </a>
      <button
        type="button"
        className="continue-play"
        aria-label={`${playing ? "暂停" : "继续收听"} ${book.title}`}
        onClick={toggle}
      >
        <span key={playing ? "pause" : "play"} className="icon-swap">
          {playing ? <PauseSolidIcon size={20} /> : <PlaySolidIcon size={20} />}
        </span>
      </button>
    </section>
  );
}

/**
 * Under a cover: where the Book is in processing (F3, PRD 4.3.3), with why parsing failed (4.3.5), or how much of
 * it was listened to.
 */
function BookState({ book }: { book: Book }) {
  if (book.status === "parse_failed") {
    return (
      <>
        <StatusBadge status={book.status} />
        {book.failureReason && <span className="shelf-book-reason">{book.failureReason}</span>}
      </>
    );
  }
  if (book.status !== "ready") return <StatusBadge status={book.status} />;
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

/** 播放 or 暂停 on a playable Book's cover: plays it where it was left, or pauses it, staying on the Shelf. */
function PlayButton({ book }: { book: Book }) {
  const { playing, toggle } = useShelfPlay(book);
  return (
    <button type="button" className="cover-action is-play" aria-label={`${playing ? "暂停" : "播放"} ${book.title}`} onClick={toggle}>
      <span key={playing ? "pause" : "play"} className="icon-swap">
        {playing ? <PauseSolidIcon size={12} /> : <PlaySolidIcon size={12} />}
      </span>
      {playing ? "暂停" : "播放"}
    </button>
  );
}

/** A Book in the grid; under the pointer its cover darkens and offers 播放 (when playable) and 详情. */
function BookTile({ book }: { book: Book }) {
  return (
    <li className="shelf-tile">
      <a href={bookPath(book)} className="shelf-book" onClick={followLink}>
        <BookCover book={book} />
        <span className="shelf-book-meta">
          <span className="shelf-book-title">{book.title}</span>
          <BookState book={book} />
        </span>
      </a>
      <CoverActions href={bookPath(book)} stacked>
        {book.playable && <PlayButton book={book} />}
        <DetailButton book={book} />
      </CoverActions>
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
  const dialog = usePresence(uploading);
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
      {dialog.value && (
        <UploadDialog
          exiting={dialog.exiting}
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
