import { useEffect, useState } from "react";
import { addToShelf, getLibrary, type Difficulty, type LibraryBook } from "../api";
import { shelfListenPath } from "../chapters";
import { CheckIcon, PlayIcon, PlaySolidIcon } from "../icons";
import { navigate } from "../router";
import { BookCover } from "./BookCover";
import "./shelf.css";
import { ShelfHeader } from "./ShelfPage";

/** The groups of the 书库 in display order (PRD 4.2.2); the API lists Books in the same order. */
const GROUPS: { difficulty: Difficulty; label: string }[] = [
  { difficulty: "beginner", label: "入门" },
  { difficulty: "intermediate", label: "中级" },
  { difficulty: "advanced", label: "进阶" },
];

function useLibrary() {
  const [books, setBooks] = useState<LibraryBook[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    getLibrary().then(
      (next) => active && setBooks(next),
      (err: unknown) => active && setError(err instanceof Error ? err.message : "加载失败"),
    );
    return () => {
      active = false;
    };
  }, []);
  return { books, error };
}

/**
 * One Book of the 书库 (design 03-3): cover, title, author and blurb, then 【加入书架并播放】, or 【继续收听】 and
 * 已在书架 once it is on the Shelf (AC-LIB-02). Both open the 专注页 playing (AC-LIB-01), from where the user
 * left off.
 */
function LibraryItem({ book }: { book: LibraryBook }) {
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function addAndPlay() {
    setAdding(true);
    setError(null);
    try {
      await addToShelf(book.id);
      navigate(shelfListenPath(book.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "加入书架失败，请稍后再试");
      setAdding(false);
    }
  }

  return (
    <li className="library-book">
      <BookCover book={book} className="library-cover" />
      <div className="library-info">
        <div className="library-titles">
          <h3 className="library-title">{book.title}</h3>
          {book.author && <p className="library-author">{book.author}</p>}
          <p className="library-blurb">{book.blurb}</p>
        </div>
        <div className="library-action">
          {book.onShelf ? (
            <>
              <button
                type="button"
                className="library-button is-continue"
                aria-label={`继续收听 ${book.title}`}
                onClick={() => navigate(shelfListenPath(book.id))}
              >
                <PlayIcon />
                继续收听
              </button>
              <span className="library-on-shelf">
                <CheckIcon size={12} />
                已在书架
              </span>
            </>
          ) : (
            <button
              type="button"
              className="library-button"
              aria-label={`加入书架并播放 ${book.title}`}
              disabled={adding}
              onClick={addAndPlay}
            >
              <PlaySolidIcon size={12} />
              加入书架并播放
            </button>
          )}
        </div>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </li>
  );
}

/** 书库 (F6, design 03-3): the Library's Books grouped as 入门, 中级, 进阶, each group by title (PRD 4.2.2). */
export function LibraryPage() {
  const { books, error } = useLibrary();
  return (
    <div className="shelf-page">
      <ShelfHeader active="library" />
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {books?.length === 0 && <p className="library-soon">书库正在准备中，很快就能从这里挑一本公版书开始听。</p>}
      {books &&
        GROUPS.map(({ difficulty, label }) => {
          const group = books.filter((b) => b.difficulty === difficulty);
          if (group.length === 0) return null;
          return (
            <section key={difficulty} className="library-group" aria-labelledby={`library-${difficulty}`}>
              <div className="library-group-header">
                <h2 id={`library-${difficulty}`}>{label}</h2>
              </div>
              <ul className="library-row">
                {group.map((b) => (
                  <LibraryItem key={b.id} book={b} />
                ))}
              </ul>
            </section>
          );
        })}
    </div>
  );
}
