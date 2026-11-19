import { useState } from "react";
import { retryChapter, setChapterSkipped, type ChapterSummary } from "../api";
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

/**
 * Runs a change to a Chapter, then `onChanged` (which reloads the Book). `busy` while it runs; `error` holds why
 * the last one failed, or `fallback`.
 */
function useChapterAction(onChanged: () => void, fallback: string) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : fallback);
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run };
}

function ChapterError({ error }: { error: string | null }) {
  return error ? (
    <p className="form-error chapter-error" role="alert">
      {error}
    </p>
  ) : null;
}

/** The 重试 of a 生成失败 Chapter (PRD 4.3.5 #9); `onChanged` reloads the Book to show it 待生成. */
function RetryButton({ chapter, onChanged }: { chapter: ChapterSummary; onChanged: () => void }) {
  const { busy, error, run } = useChapterAction(onChanged, "重试失败，请稍后再试");
  return (
    <>
      <button
        type="button"
        className="retry-button"
        disabled={busy}
        onClick={() => run(() => retryChapter(chapter.id))}
        aria-label={`重试 ${chapter.title}`}
      >
        <RotateCwIcon />
        重试
      </button>
      <ChapterError error={error} />
    </>
  );
}

/**
 * Whether the Chapter is narrated (on) or Skipped (off), design 04-2 and PRD 4.2.5. `onChanged` reloads the Book,
 * which shows the Chapter's new state and lets the listening session follow its playlist.
 */
/** The 朗读 switch of a Chapter; `locked` while the Book's Voice changes, as the API refuses changes then. */
function NarrationSwitch({ chapter, locked, onChanged }: { chapter: ChapterSummary; locked: boolean; onChanged: () => void }) {
  const { busy, error, run } = useChapterAction(onChanged, "修改失败，请稍后再试");
  return (
    <>
      <button
        type="button"
        role="switch"
        className="narration-switch"
        aria-checked={!chapter.skipped}
        aria-label={`朗读 ${chapter.title}`}
        disabled={busy || locked}
        title={locked ? "正在更换音色，完成后再调整" : undefined}
        onClick={() => run(() => setChapterSkipped(chapter.id, !chapter.skipped))}
      >
        <span className="narration-knob" />
      </button>
      <ChapterError error={error} />
    </>
  );
}

/**
 * The Book's Chapters with their state (design 04-2). A narrated Chapter's title plays the Book from its start
 * on the 专注页, which waits for it if it is not generated yet (PRD 4.3.4). When `editable` (an uploaded Book, not
 * a Library one) a failed Chapter can be retried and each Chapter set Skipped or narrated.
 */
export function ChapterList({
  bookId,
  chapters,
  editable,
  voiceChanging = false,
  onChanged,
}: {
  bookId: string;
  chapters: ChapterSummary[];
  /** An uploaded Book's: offers 重试 on 生成失败 Chapters and the 朗读 switches; a Library Book's has neither. */
  editable: boolean;
  /** The Book's Voice is changing (#19): the 朗读 switches wait until it is done. */
  voiceChanging?: boolean;
  /** Reloads the Book after a retry or a switch. */
  onChanged: () => void;
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
          {/* Keyed by state, so a new state fades in (a retried Chapter going 等待生成, 生成中, …). */}
          <ChapterState key={c.skipped ? "skipped" : c.audioStatus} chapter={c} />
          {editable && c.audioStatus === "failed" && !c.skipped && <RetryButton chapter={c} onChanged={onChanged} />}
          {editable && <NarrationSwitch chapter={c} locked={voiceChanging} onChanged={onChanged} />}
        </li>
      ))}
    </ol>
  );
}
