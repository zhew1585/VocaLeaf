import { useState } from "react";
import type { BookDetail, ChapterSummary } from "../api";
import { isPlayableChapter, waitMessage } from "../chapters";
import { ChevronLeftIcon } from "../icons";
import { Player } from "../player/Player";
import { navigate } from "../router";
import { useBook } from "../useBook";

/** The Chapter the 专注页 was opened to play (`?chapter=`), if the URL names one. */
function chapterInUrl(): string | null {
  return new URLSearchParams(window.location.search).get("chapter");
}

/**
 * The next Chapter playback will reach that has no audio yet: the first one with a wait estimate after the
 * last Chapter in the playlist.
 */
function nextToGenerate(book: BookDetail): Pick<ChapterSummary, "waitSeconds"> {
  const lastPlaced = book.chapters.findLast((c) => c.startMs !== null)?.index ?? -1;
  return book.chapters.find((c) => c.index > lastPlaced && c.waitSeconds !== null) ?? { waitSeconds: null };
}

/**
 * 专注页 (design 01), minimal: the Book and its floating player. The Chapter directory, reading view and
 * 句子精读 come with #4 and #14. Until the first segment exists the page waits and checks again; the Book's
 * length is refreshed while it generates.
 * Opened for one Chapter (from the Chapter list), it plays from that Chapter's start; if the Chapter is not
 * generated yet it says how long that takes and starts by itself once it is (PRD 4.3.4, AC-BOOK-03). Playback
 * that catches up with the generated audio waits the same way and goes on by itself.
 */
export function ListenPage({ id }: { id: string }) {
  const [requested, setRequested] = useState(chapterInUrl);
  const [waitingForAudio, setWaitingForAudio] = useState(false);
  const { book, error } = useBook(id, { eager: requested !== null || waitingForAudio });
  const detailPath = `/books/${id}`;

  const chapter = book?.chapters.find((c) => c.id === requested);
  const target = chapter && isPlayableChapter(chapter) ? chapter : undefined;
  const targetPending = target !== undefined && target.startMs === null;

  /** The Chapter has started, or the user took over: the page no longer waits for it, nor does a reload. */
  const settleRequest = () => {
    setRequested(null);
    window.history.replaceState(null, "", window.location.pathname);
  };

  let notice: string | null = null;
  if (targetPending) notice = waitMessage(target);
  else if (book && waitingForAudio) notice = waitMessage(nextToGenerate(book));

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
              <Player
                src={`/api/books/${id}/audio.m3u8`}
                totalSeconds={book.durationMs === null ? null : book.durationMs / 1000}
                startAt={target ? { id: target.id, seconds: target.startMs === null ? null : target.startMs / 1000 } : null}
                onStartSettled={settleRequest}
                onWaitingForAudio={setWaitingForAudio}
                notice={notice}
              />
            </div>
          ) : (
            <p className="listen-wait">
              {targetPending
                ? notice
                : book.status === "generating" || book.status === "parsing"
                  ? "正在生成第一段音频，稍候即可收听"
                  : "这本书没有可播放的音频"}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
