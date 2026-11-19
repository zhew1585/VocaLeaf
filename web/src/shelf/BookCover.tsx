import type { Book } from "../api";
import { FileXIcon, LoaderIcon } from "../icons";

/** Muted cloth colours for a Book without a cover image, picked by its ID so a Book keeps its colour. */
const DEFAULT_COVER_COLORS = ["#7B4A38", "#2E5B45", "#5B4E6B", "#6B5B3E", "#3F5560"];

export function defaultCoverColor(id: string): string {
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return DEFAULT_COVER_COLORS[hash % DEFAULT_COVER_COLORS.length]!;
}

/** What a cover needs: a Book on the Shelf, or a Library Book (always generated, so without status). */
type CoverBook = Pick<Book, "id" | "title" | "coverUrl"> & Partial<Pick<Book, "status" | "progress">>;

/**
 * A Book's cover on the Shelf and in the 书库 (design 03-2): its EPUB's cover image, or a cloth-coloured cover with its title. A
 * Book being parsed shows a spinner, one that failed a file icon, and one generating its audio carries 生成中 n/N.
 */
export function BookCover({ book, className = "" }: { book: CoverBook; className?: string }) {
  if (book.status === "parsing") {
    return (
      <div className={`book-cover is-parsing ${className}`} aria-hidden="true">
        <LoaderIcon size={26} />
      </div>
    );
  }
  if (book.status === "parse_failed") {
    return (
      <div className={`book-cover is-failed ${className}`} aria-hidden="true">
        <FileXIcon />
      </div>
    );
  }
  return (
    <div className={`book-cover ${className}`} style={book.coverUrl ? undefined : { background: defaultCoverColor(book.id) }}>
      {book.coverUrl ? (
        <img src={book.coverUrl} alt="" loading="lazy" />
      ) : (
        <span className="book-cover-title" aria-hidden="true">
          {book.title}
        </span>
      )}
      {book.status === "generating" && book.progress && (
        <span className="book-cover-strip" aria-label="生成进度">
          <LoaderIcon size={12} />
          {book.progress.generated} / {book.progress.narrated}
        </span>
      )}
    </div>
  );
}
