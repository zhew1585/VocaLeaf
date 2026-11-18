import { useState } from "react";
import { retryChapter, type ChapterSummary } from "../api";
import { chapterListenPath, formatChapterLength, isPlayableChapter } from "../chapters";
import { CircleAlertIcon, LoaderIcon, RotateCwIcon } from "../icons";
import { navigate } from "../router";

/** A Chapter's state on the right of its row (design 04-2). */
function ChapterState({ chapter }: { chapter: ChapterSummary }) {
  if (chapter.skipped) return <span className="chapter-meta">未朗读</span>;
  switch (chapter.audioStatus) {
    case "generated":
      return <span className="chapter-meta">{formatChapterLength(chapter.durationMs ?? 0)}</span>;
    case "generating":
      return (
        <span className="chapter-meta chapter-generating">
          <LoaderIcon />
          生成中
        </span>
      );
    case "pending":
      return <span className="chapter-meta">等待生成</span>;
    case "failed":
      return (
        <span className="chapter-meta chapter-failed">
          <CircleAlertIcon />
          生成失败
        </span>
      );
  }
}

/** The 重试 of a 生成失败 Chapter (PRD 4.3.5 #9); `onRetried` reloads the Book to show it 待生成. */
function RetryButton({ chapter, onRetried }: { chapter: ChapterSummary; onRetried: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function retry() {
    setBusy(true);
    setError(null);
    try {
      await retryChapter(chapter.id);
      onRetried();
    } catch (err) {
      setError(err instanceof Error ? err.message : "重试失败，请稍后再试");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" className="retry-button" disabled={busy} onClick={retry} aria-label={`重试 ${chapter.title}`}>
        <RotateCwIcon />
        重试
      </button>
      {error && (
        <p className="form-error chapter-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

/**
 * The Book's Chapters with their state (design 04-2). A narrated Chapter's title plays the Book from its start
 * on the 专注页, which waits for it if it is not generated yet (PRD 4.3.4).
 */
export function ChapterList({
  bookId,
  chapters,
  onRetried,
}: {
  bookId: string;
  chapters: ChapterSummary[];
  onRetried: () => void;
}) {
  return (
    <ol className="chapters" aria-label="章节">
      {chapters.map((c) => (
        <li key={c.id} className={`chapter-row${c.skipped ? " is-skipped" : ""}`}>
          {isPlayableChapter(c) ? (
            <button type="button" className="chapter-title" onClick={() => navigate(chapterListenPath(bookId, c.id))}>
              {c.title}
            </button>
          ) : (
            <span className="chapter-title">{c.title}</span>
          )}
          <ChapterState chapter={c} />
          {c.audioStatus === "failed" && !c.skipped && <RetryButton chapter={c} onRetried={onRetried} />}
        </li>
      ))}
    </ol>
  );
}
