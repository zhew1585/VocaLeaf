import { useBook } from "../useBook";
import { ChevronLeftIcon } from "../icons";
import { Player } from "../player/Player";
import { navigate } from "../router";

/**
 * 专注页 (design 01), minimal: the Book and its floating player. The Chapter directory, reading view and
 * 句子精读 come with #4 and #14. Until the first segment exists the page waits and checks again.
 */
export function ListenPage({ id }: { id: string }) {
  const { book, error } = useBook(id, (b) => !b.playable);
  const detailPath = `/books/${id}`;

  return (
    <div className="listen-layout">
      <a
        href={detailPath}
        className="back-link"
        onClick={(e) => {
          e.preventDefault();
          navigate(detailPath);
        }}
      >
        <ChevronLeftIcon />
        书籍详情
      </a>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {book && (
        <div className="listen-column">
          <div className="book-titles">
            <h1 className="book-title">{book.title}</h1>
            {book.author && <p className="book-author">{book.author}</p>}
          </div>
          {book.playable ? (
            <div className="player-dock">
              <Player src={`/api/books/${id}/audio.m3u8`} />
            </div>
          ) : (
            <p className="listen-wait">正在生成第一段音频，稍候即可收听</p>
          )}
        </div>
      )}
    </div>
  );
}
