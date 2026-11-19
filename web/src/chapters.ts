// Wording shared by the screens that list or play Chapters.
import type { ChapterSummary } from "./api";

/** "58 分钟": a generated Chapter's length in the Chapter list (design 04-2). */
export function formatChapterLength(ms: number): string {
  return ms < 60_000 ? "不到 1 分钟" : `${Math.round(ms / 60_000)} 分钟`;
}

/** What the user is told while a Chapter they want to hear has no audio yet (PRD 4.3.4). */
export function waitMessage(chapter: Pick<ChapterSummary, "waitSeconds">): string {
  return chapter.waitSeconds === null
    ? "该章节生成中，生成后自动播放"
    : `该章节生成中，预计约 ${chapter.waitSeconds} 秒`;
}

/** Whether the Chapter can be asked to play: it is narrated and is, or will be, generated. */
export function isPlayableChapter(chapter: ChapterSummary): boolean {
  return !chapter.skipped && chapter.audioStatus !== "failed";
}

/** The 专注页 starting at a Chapter's beginning. */
export function chapterListenPath(bookId: string, chapterId: string): string {
  return `/books/${bookId}/listen?chapter=${chapterId}`;
}

/** The 专注页 opened from the Shelf: it resumes at the last Sentence listened to and plays at once (PRD 4.4.1 #3). */
export function shelfListenPath(bookId: string): string {
  return `/books/${bookId}/listen?autoplay`;
}

/**
 * The 专注页 opened by 【定位原文】 (F10): scrolled to the Sentence, playback kept to PRD 4.4.1 收听会话 #3 (paused, at
 * the Book's last progress rather than the Sentence).
 */
export function locatePath(bookId: string, chapterId: string, sentenceId: string): string {
  return `/books/${bookId}/listen?${new URLSearchParams({ locate: sentenceId, locateChapter: chapterId })}`;
}
