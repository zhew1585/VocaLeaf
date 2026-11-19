import { useLayoutEffect, useRef, useState } from "react";
import type { BookDetail, ChapterSummary } from "../api";
import { ArrowLeftIcon } from "../icons";
import { navigate } from "../router";

/** 【返回书架】: leaves the 专注页 while the audio goes on (PRD 4.4.1). */
export function BackToShelf({ compact = false }: { compact?: boolean }) {
  return (
    <a
      href="/"
      className={compact ? "shelf-back is-compact" : "shelf-back"}
      aria-label={compact ? "返回书架" : undefined}
      onClick={(e) => {
        e.preventDefault();
        navigate("/");
      }}
    >
      {compact ? (
        <ArrowLeftIcon />
      ) : (
        <>
          <span className="shelf-back-icon" aria-hidden="true">
            <ArrowLeftIcon size={14} />
          </span>
          返回书架
        </>
      )}
    </a>
  );
}

/** A Chapter's state next to its title (G5): not generated yet, or failed. Generated ones need none. */
function chapterTag(c: ChapterSummary): string | null {
  if (c.audioStatus === "failed") return "生成失败";
  if (c.startMs === null) return "生成中";
  return null;
}

/** The playing Chapter's sound wave; it moves while the audio plays. */
function Wave({ moving }: { moving: boolean }) {
  return (
    <span className={moving ? "wave is-moving" : "wave"} aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}

/** The Book's title, scrolling back and forth when it is wider than the directory (design ③). */
function ScrollingTitle({ title }: { title: string }) {
  const box = useRef<HTMLHeadingElement>(null);
  const [overflow, setOverflow] = useState(0);
  useLayoutEffect(() => {
    const el = box.current!;
    setOverflow(Math.max(0, el.scrollWidth - el.clientWidth));
  }, [title]);
  return (
    <h1 ref={box} className="directory-title" title={title}>
      <span
        className={overflow > 0 ? "is-scrolling" : undefined}
        style={overflow > 0 ? ({ "--overflow": `-${overflow}px` } as React.CSSProperties) : undefined}
      >
        {title}
      </span>
    </h1>
  );
}

interface Props {
  book: BookDetail;
  playingChapterId: string | null;
  playing: boolean;
  /** Share of the whole Book listened to, 0 to 1. */
  listened: number;
  onPick(chapter: ChapterSummary): void;
  /** Collapsing: it slides away (usePresence). */
  exiting?: boolean;
}

/**
 * The 专注页's left column (design 01 ①, ③): 【返回书架】, the narrated Chapters (the playing one marked, not
 * generated ones tagged, G5; Skipped ones, such as an imprint or a table of contents, left out, though the text
 * still shows them), and at the bottom the Book with how much of it was listened to.
 * Picking a Chapter plays it from its start, or shows it when it cannot be played.
 */
export function ChapterDirectory({ book, playingChapterId, playing, listened, onPick, exiting = false }: Props) {
  const percent = Math.round(listened * 100);
  return (
    <nav id="chapter-directory" className={exiting ? "directory is-exiting" : "directory"} aria-label="章节目录">
      <BackToShelf />
      <p className="directory-label">章节</p>
      <ol className="directory-list">
        {book.chapters.filter((c) => !c.skipped).map((c) => {
          const isPlaying = c.id === playingChapterId;
          const tag = chapterTag(c);
          return (
            <li key={c.id}>
              <button
                type="button"
                className={isPlaying ? "directory-item is-playing" : "directory-item"}
                aria-current={isPlaying ? "true" : undefined}
                onClick={() => onPick(c)}
              >
                <span className="directory-item-title">{c.title}</span>
                {tag && <span className="chapter-tag">{tag}</span>}
                {isPlaying && <Wave moving={playing} />}
              </button>
            </li>
          );
        })}
      </ol>
      <div className="directory-book">
        <div className="directory-cover" aria-hidden="true">
          {book.coverUrl ? <img src={book.coverUrl} alt="" /> : book.title.slice(0, 1)}
        </div>
        <div className="directory-book-text">
          <ScrollingTitle title={book.title} />
          {book.author && <p className="directory-author">{book.author}</p>}
          <div className="directory-progress">
            <div className="directory-progress-track">
              <div className="directory-progress-fill" style={{ width: `${percent}%` }} />
            </div>
            <span>已听 {percent}%</span>
          </div>
        </div>
      </div>
    </nav>
  );
}
