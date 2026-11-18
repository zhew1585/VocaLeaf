import { useEffect, useLayoutEffect, useRef } from "react";
import type { BookDetail, ChapterSummary } from "../api";
import { ArrowLeftIcon, PlayingWave } from "../icons";

/** Why a Chapter cannot be played from the directory, shown as its tag (PRD 6.5 G5); null when it can. */
export function chapterTag(c: ChapterSummary): string | null {
  if (c.skipped) return "未朗读";
  if (c.startMs !== null) return null;
  return c.audioStatus === "failed" ? "生成失败" : "生成中";
}

interface Props {
  book: BookDetail;
  playingChapterId: string | null;
  playing: boolean;
  /** Share of the whole Book listened to, 0 to 1. */
  progress: number;
  onShelf(): void;
  onChapter(chapter: ChapterSummary): void;
}

/**
 * Left sidebar of the 专注页 (design 01 ① and ③): 【返回书架】, every Chapter in Book order with the playing one
 * highlighted, and the Book with its overall progress fixed at the bottom. Only the Chapter list scrolls.
 */
export function ChapterDirectory({ book, playingChapterId, playing, progress, onShelf, onChapter }: Props) {
  const playingRow = useRef<HTMLButtonElement>(null);
  // Keep the playing Chapter in sight as playback moves on.
  useEffect(() => {
    playingRow.current?.scrollIntoView?.({ block: "nearest" });
  }, [playingChapterId]);

  return (
    <nav className="directory" aria-label="章节目录">
      <a
        href="/"
        className="shelf-link"
        onClick={(e) => {
          e.preventDefault();
          onShelf();
        }}
      >
        <span className="shelf-circle">
          <ArrowLeftIcon />
        </span>
        返回书架
      </a>
      <div className="directory-heading">章节</div>
      <ol className="directory-list">
        {book.chapters.map((c) => {
          const isPlaying = c.id === playingChapterId;
          const tag = chapterTag(c);
          return (
            <li key={c.id}>
              <button
                type="button"
                ref={isPlaying ? playingRow : undefined}
                className={`directory-row${isPlaying ? " is-playing" : ""}`}
                aria-current={isPlaying ? "true" : undefined}
                onClick={() => onChapter(c)}
              >
                <span className="directory-title">{c.title}</span>
                {tag && <span className="directory-tag">{tag}</span>}
                {isPlaying && <PlayingWave playing={playing} />}
              </button>
            </li>
          );
        })}
      </ol>
      <div className="book-identity">
        <div className="book-identity-row">
          <div className="book-cover" aria-hidden="true">
            {book.title.trim().charAt(0)}
          </div>
          <div className="book-identity-text">
            <Marquee text={book.title} />
            {book.author && <p className="book-identity-author">{book.author}</p>}
          </div>
        </div>
        <div className="book-identity-progress">
          <span className="book-identity-percent">{Math.floor(progress * 100)}%</span>
          <div className="book-identity-track" role="progressbar" aria-label="本书进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.floor(progress * 100)}>
            <div style={{ width: `${progress * 100}%` }} />
          </div>
        </div>
      </div>
    </nav>
  );
}

/** Pause before a long title starts moving, its speed, and the pause at its end (design 01 ③). */
const MARQUEE_HOLD_START_MS = 2000;
const MARQUEE_PX_PER_S = 18;
const MARQUEE_HOLD_END_MS = 1500;

/**
 * The Book's title on one line. One that overflows (by its real width, not its length) scrolls left, pauses at
 * its end and starts over; a short one stays still. Users who prefer reduced motion get an ellipsis instead.
 */
function Marquee({ text }: { text: string }) {
  const box = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    let animation: Animation | undefined;
    let cancelled = false;
    const start = () => {
      const overflow = box.current!.scrollWidth - box.current!.clientWidth;
      if (cancelled || overflow <= 0 || !inner.current!.animate) return;
      if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
      const moveMs = (overflow / MARQUEE_PX_PER_S) * 1000;
      const total = MARQUEE_HOLD_START_MS + moveMs + MARQUEE_HOLD_END_MS;
      const end = `translateX(${-overflow}px)`;
      animation = inner.current!.animate(
        [
          { transform: "translateX(0)", offset: 0 },
          { transform: "translateX(0)", offset: MARQUEE_HOLD_START_MS / total },
          { transform: end, offset: (MARQUEE_HOLD_START_MS + moveMs) / total },
          { transform: end, offset: 1 },
        ],
        { duration: total, iterations: Infinity },
      );
      box.current!.classList.add("is-moving");
    };
    // Widths are right only once the web fonts are in.
    void (document.fonts?.ready ?? Promise.resolve()).then(start);
    return () => {
      cancelled = true;
      animation?.cancel();
      box.current?.classList.remove("is-moving");
    };
  }, [text]);

  return (
    <div ref={box} className="marquee">
      <span ref={inner} className="book-identity-title">
        {text}
      </span>
    </div>
  );
}
