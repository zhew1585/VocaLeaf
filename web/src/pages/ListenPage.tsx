import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { ChapterSummary } from "../api";
import { ArrowLeftIcon, PanelRightCloseIcon, PanelRightIcon } from "../icons";
import { ChapterDirectory } from "../listen/ChapterDirectory";
import { ReadingView, type ReadingViewHandle } from "../listen/ReadingView";
import { playingChapterId } from "../listen/timing";
import { usePlayback } from "../player/playback";
import { bookLength, Player } from "../player/Player";
import { navigate } from "../router";
import { useBook } from "../useBook";

const DIRECTORY_PX = 240;
const PANEL_PX = 440;
/** The reading area must fit the narrowest column (620) with 32 px on each side, or a sidebar stops docking. */
const MIN_READING_PX = 620 + 64;
/** Where the user last left the Chapter directory, for every Book (PRD 6.5 G8). */
const DIRECTORY_KEY = "vocaleaf.directoryOpen";

/** Column width of the text and the player for which sidebars are docked (F7: 620, 680, 720, 760). */
export function columnWidth(directory: boolean, panel: boolean): number {
  if (directory) return panel ? 620 : 720;
  return panel ? 680 : 760;
}

function storedDirectoryOpen(): boolean {
  try {
    return localStorage.getItem(DIRECTORY_KEY) !== "false";
  } catch {
    return true;
  }
}

function useWindowWidth() {
  const [width, setWidth] = useState(window.innerWidth);
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return width;
}

/**
 * 专注页 (F7, design 01): the Chapter directory on the left, the reading view with the floating player in the
 * middle and 句子精读 on the right, which starts collapsed (its content comes with #14). The global navigation
 * is hidden. Leaving the page does not stop playback, which lives above every screen (playback.tsx).
 * A window too narrow for a docked sidebar shows it over the text instead, the directory first (PRD 6.5 G8).
 */
export function ListenPage({ id }: { id: string }) {
  const { book, error } = useBook(id);
  const playback = usePlayback();
  const reading = useRef<ReadingViewHandle>(null);
  const src = `/api/books/${id}/audio.m3u8`;

  const [directoryPref, setDirectoryPref] = useState(storedDirectoryOpen);
  const [directoryOverlay, setDirectoryOverlay] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const windowWidth = useWindowWidth();
  const panelDocked = panelOpen && windowWidth - PANEL_PX >= MIN_READING_PX;
  const directoryFits = windowWidth - DIRECTORY_PX - (panelDocked ? PANEL_PX : 0) >= MIN_READING_PX;
  const directoryDocked = directoryFits && directoryPref;
  const directoryShown = directoryDocked || (!directoryFits && directoryOverlay);

  const { load } = playback;
  useEffect(() => {
    if (book?.playable) load(src);
  }, [book?.playable, src, load]);

  const ours = playback.src === src;
  const positionMs = ours ? playback.position * 1000 : 0;
  const playing = ours && playback.playing;
  const playingChapter = book ? playingChapterId(book.chapters, positionMs) : null;
  const totalSeconds = book?.durationMs == null ? null : book.durationMs / 1000;
  const length = ours ? bookLength(playback.playable, totalSeconds) : 0;

  const toggleDirectory = () => {
    if (!directoryFits) return setDirectoryOverlay((open) => !open);
    setDirectoryPref((open) => {
      try {
        localStorage.setItem(DIRECTORY_KEY, String(!open));
      } catch {
        // Not remembered this time; the directory still toggles.
      }
      return !open;
    });
  };

  /** A Chapter in the playlist plays from its start (F7); one that is not can only be read. */
  const openChapter = (chapter: ChapterSummary) => {
    setDirectoryOverlay(false);
    if (chapter.startMs !== null && ours) {
      playback.playFrom(chapter.startMs / 1000);
      reading.current?.follow();
    } else reading.current?.showChapter(chapter.id);
  };

  const toShelf = () => navigate("/");

  return (
    <div className="focus" style={{ "--col": `${columnWidth(directoryDocked, panelDocked)}px` } as CSSProperties}>
      {error && (
        <p className="form-error focus-error" role="alert">
          {error}
        </p>
      )}
      {book && directoryShown && (
        <>
          {!directoryDocked && <div className="focus-scrim" onClick={() => setDirectoryOverlay(false)} />}
          <aside className={`focus-directory${directoryDocked ? "" : " is-overlay"}`}>
            <ChapterDirectory
              book={book}
              playingChapterId={playingChapter}
              playing={playing}
              progress={length > 0 && ours ? Math.min(playback.position / length, 1) : 0}
              onShelf={toShelf}
              onChapter={openChapter}
            />
          </aside>
        </>
      )}
      <div className="focus-main">
        {!directoryShown && (
          <button type="button" className="shelf-button" aria-label="返回书架" title="返回书架" onClick={toShelf}>
            <span className="shelf-circle">
              <ArrowLeftIcon />
            </span>
          </button>
        )}
        {!panelOpen && (
          <button type="button" className="panel-toggle" aria-label="展开句子精读" title="展开句子精读" onClick={() => setPanelOpen(true)}>
            <PanelRightIcon />
          </button>
        )}
        {book && (
          <ReadingView
            ref={reading}
            chapters={book.chapters}
            playingChapterId={playingChapter}
            positionMs={positionMs}
            directoryOpen={directoryShown}
            onToggleDirectory={toggleDirectory}
            player={
              book.playable ? (
                <Player totalSeconds={totalSeconds} />
              ) : (
                <p className="listen-wait">
                  {book.status === "generating" || book.status === "parsing"
                    ? "正在生成第一段音频，稍候即可收听"
                    : "这本书没有可播放的音频"}
                </p>
              )
            }
          />
        )}
      </div>
      {panelOpen && (
        <aside className={`focus-panel${panelDocked ? "" : " is-overlay"}`} aria-label="句子精读">
          <div className="panel-toolbar">
            <span className="panel-title">句子精读</span>
            <button type="button" className="panel-collapse" aria-label="收起句子精读" title="收起句子精读" onClick={() => setPanelOpen(false)}>
              <PanelRightCloseIcon />
            </button>
          </div>
          <div className="panel-empty">
            <p>选中一句原文</p>
            <p>在这里试听、解析或提问</p>
          </div>
        </aside>
      )}
    </div>
  );
}
