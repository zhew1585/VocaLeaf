import { useState } from "react";
import type { BookDetail, ChapterSummary } from "../api";
import { isPlayableChapter, waitMessage } from "../chapters";
import { ChevronLeftIcon } from "../icons";
import { Player, type StartRequest } from "../player/Player";
import { navigate } from "../router";
import { useBook } from "../useBook";
import { usePlaylist } from "./usePlaylist";

/**
 * The Chapter the 专注页 was opened to play (`?chapter=`), until it has started or the user took over;
 * `settle` then forgets it, in the URL too, so a reload does not jump there again.
 */
function useRequestedChapter() {
  const [id, setId] = useState(() => new URLSearchParams(window.location.search).get("chapter"));
  const settle = () => {
    setId(null);
    window.history.replaceState(null, "", window.location.pathname);
  };
  /** The Chapter if the Book has it and it can be played. */
  const find = (book: BookDetail | null) => {
    const chapter = book?.chapters.find((c) => c.id === id);
    return chapter && isPlayableChapter(chapter) ? chapter : undefined;
  };
  return { requested: id !== null, find, settle };
}

/**
 * The Chapter playback waits for once it catches up with the generated audio: the last one in the playlist
 * while it is still generating, otherwise the next one with a wait estimate.
 */
function nextToGenerate(book: BookDetail): Pick<ChapterSummary, "waitSeconds"> {
  const last = book.chapters.findLast((c) => c.startMs !== null);
  if (last && (last.audioStatus === "pending" || last.audioStatus === "generating")) return last;
  return book.chapters.find((c) => c.index > (last?.index ?? -1) && c.waitSeconds !== null) ?? { waitSeconds: null };
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
  const request = useRequestedChapter();
  const [waitingForAudio, setWaitingForAudio] = useState(false);
  const { book, error } = useBook(id, { eager: request.requested || waitingForAudio });
  const playlist = usePlaylist(book);
  const detailPath = `/books/${id}`;

  const target = request.find(book);
  const targetPending = target !== undefined && target.startMs === null;
  const startAt: StartRequest | null = target
    ? { id: target.id, seconds: target.startMs === null ? null : target.startMs / 1000, autoplay: true }
    : playlist.resume;
  const notice = targetPending
    ? waitMessage(target)
    : book && waitingForAudio
      ? waitMessage(nextToGenerate(book))
      : null;

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
                key={playlist.revision}
                src={`/api/books/${id}/audio.m3u8`}
                totalSeconds={book.durationMs === null ? null : book.durationMs / 1000}
                startAt={startAt}
                onStartSettled={() => {
                  // A Chapter picked to listen to replaces any resume still waiting.
                  if (target) request.settle();
                  playlist.clearResume();
                }}
                onWaitingForAudio={setWaitingForAudio}
                onPosition={playlist.onPosition}
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
