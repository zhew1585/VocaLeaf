import { useEffect, useState } from "react";
import { getBook, type BookDetail } from "../api";
import { PauseSolidIcon, PlaySolidIcon } from "../icons";
import { usePresence } from "../motion";
import { followLink } from "../router";
import { defaultCoverColor } from "../shelf/BookCover";
import { useListening } from "./session";

/**
 * The session's Book (title, cover, Chapter titles), loaded once per Book; null while loading or without a
 * session. Which Chapter plays comes from the session's timeline, which follows a Book still generating.
 */
function useSessionBook(bookId: string | null): BookDetail | null {
  const [book, setBook] = useState<BookDetail | null>(null);
  useEffect(() => {
    if (bookId === null) return;
    let active = true;
    getBook(bookId).then(
      (loaded) => active && setBook(loaded),
      // Without its Book the entry stays hidden; playback itself is not affected.
      (err: unknown) => console.warn("loading the listening session's Book failed", err),
    );
    return () => {
      active = false;
    };
  }, [bookId]);
  return book?.id === bookId ? book : null;
}

/**
 * The sidebar's 当前收听 entry (PRD 4.4.1 收听会话 #5, design 05-1 「侧栏 · 当前收听」): while there is a listening
 * session, the Book's cover, title, 正在播放 or 已暂停, and the Chapter playing. The cover pauses or plays on (its
 * control shows on hover and keyboard focus); the rest goes back to the 专注页, where playback is as it was.
 */
export function NowListening() {
  const { bookId, playing, chapterId, toggle } = useListening();
  // It rises in once the session's Book is loaded, and sinks away when the session ends.
  const { value: book, exiting } = usePresence(useSessionBook(bookId));
  if (!book) return null;

  const chapter = book.chapters.find((c) => c.id === chapterId)?.title;
  return (
    <section
      className={["now-listening", playing && "is-playing", exiting && "is-exiting"].filter(Boolean).join(" ")}
      aria-label="当前收听"
    >
      <button type="button" className="now-cover" aria-label={playing ? "暂停" : "继续播放"} onClick={toggle}>
        <span className="now-cover-art" style={book.coverUrl ? undefined : { background: defaultCoverColor(book.id) }}>
          {book.coverUrl && <img src={book.coverUrl} alt="" />}
          <span className="now-cover-control">
            <span key={playing ? "pause" : "play"} className="icon-swap">
              {playing ? <PauseSolidIcon size={15} /> : <PlaySolidIcon size={15} />}
            </span>
          </span>
        </span>
      </button>
      <a href={`/books/${book.id}/listen`} className="now-info" title={book.title} onClick={followLink}>
        <span className="now-title">{book.title}</span>
        <span className="now-state">
          <span className="now-dot" aria-hidden="true" />
          {playing ? "正在播放" : "已暂停"}
          {chapter && <span className="now-chapter">· {chapter}</span>}
        </span>
      </a>
    </section>
  );
}
