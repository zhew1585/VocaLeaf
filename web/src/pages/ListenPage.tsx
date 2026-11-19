import { useCallback, useEffect, useRef, useState } from "react";
import type { BookDetail, ChapterSummary } from "../api";
import { isPlayableChapter, waitMessage } from "../chapters";
import { useMarkPress } from "../marks/useMarkPress";
import { useBookMarks } from "../marks/useMarks";
import type { StartRequest } from "../player/playback";
import { Player } from "../player/Player";
import { useListening } from "../player/session";
import { usePlayGuide } from "../guide/PlayGuide";
import { useShortcuts } from "../player/shortcuts";
import { BackToShelf, ChapterDirectory } from "../reading/ChapterDirectory";
import { ReadingView, type ReadingViewHandle } from "../reading/ReadingView";
import { SentencePanel, SentencePanelToggle } from "../reading/SentencePanel";
import { columnWidth, playingChapterId } from "../reading/timeline";
import "../reading/focus.css";
import { useBook } from "../useBook";
import { usePlaylist } from "./usePlaylist";

/**
 * Drops the 专注页's one-off URL parameters (?chapter, ?autoplay, ?locate) once they did their job, so a reload does
 * not redo it.
 */
function dropEntryParams() {
  if (window.location.search) window.history.replaceState(null, "", window.location.pathname);
}

/**
 * Where the 专注页 starts a Book the session does not hold yet: at the start of the Sentence the user last listened
 * to on any device (AC-SHELF-04, AC-PLAY-05, the Book's beginning if none), playing when opened from the Shelf or
 * the 书库 (`?autoplay`, shelfListenPath) or by the first-play guide's 【开始听】, paused otherwise (a reload). Only
 * once. A Book the session already holds plays on where it is, unless it is paused and opened from the Shelf: it
 * then resumes like a Book not held, since another device may have listened on since.
 */
function useResume(here: boolean, playing: boolean, startedFromGuide: boolean) {
  const [fromShelf] = useState(() => new URLSearchParams(window.location.search).has("autoplay"));
  const autoplay = fromShelf || startedFromGuide;
  const [done, setDone] = useState(here && (playing || !fromShelf));
  // Paused at the beginning is where a fresh player is anyway.
  const request = (book: BookDetail | null): StartRequest | null =>
    done || !book || (!autoplay && !book.listening)
      ? null
      : { id: "resume", seconds: (book.listening?.startMs ?? 0) / 1000, autoplay };
  const settle = () => {
    setDone(true);
    // Settling can come after the user left the page; only this page's URL has the parameter.
    if (new URLSearchParams(window.location.search).has("autoplay")) dropEntryParams();
  };
  return { request, settle };
}

/**
 * The Chapter picked to play from its start: from the URL (`?chapter=`, opened from the Chapter list) or the
 * directory, until it has started or the user took over; `settle` then forgets it, in the URL too, so a reload
 * does not jump there again. Each pick counts, so picking the same Chapter again starts it again.
 */
function usePickedChapter() {
  const count = useRef(0);
  const [picked, setPicked] = useState(() => {
    const id = new URLSearchParams(window.location.search).get("chapter");
    return id === null ? null : { id, n: 0 };
  });
  const pick = (id: string) => setPicked({ id, n: ++count.current });
  const settle = () => {
    setPicked(null);
    // Settling can come after the user left the page; only this page's URL has the parameter.
    if (new URLSearchParams(window.location.search).has("chapter")) dropEntryParams();
  };
  /** The picked Chapter and its pick count, if the Book has it and it can be played. */
  const find = (book: BookDetail | null) => {
    const chapter = book?.chapters.find((c) => c.id === picked?.id);
    return picked && chapter && isPlayableChapter(chapter) ? { chapter, n: picked.n } : undefined;
  };
  return { picked, pick, settle, find };
}

/**
 * The first-play guide (F2, AC-GUIDE-02): before the user's first play ever, the 专注页 shows it once its Book can
 * play, and holds playback back until 【开始听】, which starts it. `passed` is true when there is nothing to hold.
 */
function useFirstPlayGuide(playable: boolean) {
  const { seen, show, hide, showing } = usePlayGuide();
  // Whether this page holds playback for the guide; its 【开始听】 then starts playback.
  const [held] = useState(!seen);
  const [passed, setPassed] = useState(!held);
  const waiting = useRef(false);
  waiting.current = held && !passed;
  useEffect(() => {
    if (playable && !passed && !showing) show(() => setPassed(true));
  }, [playable, passed, showing, show]);
  // Leaving the page before 【开始听】 takes the guide along; it shows again on the next first play.
  useEffect(
    () => () => {
      if (waiting.current) hide();
    },
    [hide],
  );
  return { passed, startedFromGuide: held && passed, showing };
}

/** What an id from the URL may look like (UUIDs in practice); anything else could break a selector. */
const ID = /^[\w-]{1,64}$/;

/**
 * The Sentence 【定位原文】 opened the page at (`?locate=<Sentence>&locateChapter=<Chapter>`, locatePath), if any.
 * Malformed ids are ignored: they come from the URL and end up in selectors.
 */
function useLocatedSentence() {
  const [located] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    const sentenceId = params.get("locate") ?? "";
    const chapterId = params.get("locateChapter") ?? "";
    return ID.test(sentenceId) && ID.test(chapterId) ? { sentenceId, chapterId } : null;
  });
  return located;
}

/** Below this width the side panels lie over the text, so the directory starts collapsed (G8). */
const WIDE_WINDOW = "(min-width: 901px)";

function wideWindow(): boolean {
  return window.matchMedia?.(WIDE_WINDOW).matches ?? true;
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
 * 专注页 (design 01, PRD 4.4.5): the Chapter directory, the Book's text following the audio, the floating
 * player, and the collapsed 句子精读. The page opens its Book in the listening session once it has audio, at the
 * Sentence the user last listened to;
 * until then it waits and checks again. Picking a Chapter (here or in the Chapter list) plays it from its
 * start; one not generated yet says how long that takes and starts by itself once it is (PRD 4.3.4,
 * AC-BOOK-03). Playback that catches up with the generated audio waits the same way and goes on by itself.
 */
export function ListenPage({ id }: { id: string }) {
  const listening = useListening();
  const here = listening.bookId === id;
  const chapterPick = usePickedChapter();
  // Playback waits for audio still to generate: it caught up with it, or the bar was dragged past it.
  const waitingForAudio = here && (listening.waitingForAudio || listening.seekPending);
  const { book, error } = useBook(id, { eager: chapterPick.picked !== null || waitingForAudio });
  const playlist = usePlaylist(book, here ? { seconds: listening.position, playing: listening.playing } : { seconds: 0, playing: false });
  const [directoryOpen, setDirectoryOpen] = useState(wideWindow);
  const [panelOpen, setPanelOpen] = useState(false);
  const reading = useRef<ReadingViewHandle>(null);
  const playable = book?.playable ?? false;
  const guide = useFirstPlayGuide(playable);
  const resume = useResume(here, listening.playing, guide.startedFromGuide);
  const located = useLocatedSentence();
  // Opened at a located Sentence, the text stays there rather than following playback, until a Chapter is picked.
  const stayAtLocated = useRef(located !== null);
  const marks = useBookMarks(id);
  const markPress = useMarkPress({
    target: listening.markTarget,
    textOf: (sentenceId) => reading.current?.sentenceText(sentenceId),
    marks,
  });
  useShortcuts(
    here && !guide.showing
      ? { toggle: listening.toggle, replay: listening.replay, next: listening.next, mark: markPress.press }
      : null,
  );
  // Stable, so the reading view's memoized Chapters do not render again on every time update.
  const toggleDirectory = useCallback(() => setDirectoryOpen((o) => !o), []);

  const bookLoaded = book !== null;
  useEffect(() => {
    if (!bookLoaded || !located) return;
    reading.current?.showSentence(located.chapterId, located.sentenceId);
    dropEntryParams();
  }, [bookLoaded, located]);

  const { open, reload, requestStart } = listening;
  useEffect(() => {
    if (playable) open(id);
  }, [playable, id, open]);
  // A retried Chapter came in before the playlist's end: load it again (it resumes at playlist.resume).
  useEffect(() => {
    if (playlist.revision > 0) reload();
  }, [playlist.revision, reload]);

  const found = chapterPick.find(book);
  const target = found?.chapter;
  const targetPending = target !== undefined && target.startMs === null;
  const requested: StartRequest | null = found
    ? {
        id: `${found.chapter.id}#${found.n}`,
        seconds: found.chapter.startMs === null ? null : found.chapter.startMs / 1000,
        autoplay: true,
      }
    : (resume.request(book) ?? playlist.resume);
  // Nothing starts before the first-play guide is passed.
  const startAt = guide.passed ? requested : null;
  // Asked in the same commit as open (above), which drops any request of the Book opened before.
  useEffect(() => {
    if (!playable) return;
    requestStart(startAt, () => {
      // A Chapter picked to listen to replaces any resume still waiting.
      chapterPick.settle();
      resume.settle();
      playlist.clearResume();
      if (!stayAtLocated.current) reading.current?.followPlayback();
    });
    // The request's id and position say when it changed; the callbacks only set state.
  }, [playable, startAt?.id, startAt?.seconds, requestStart]);

  if (!book) {
    return error ? (
      <p className="form-error focus-error" role="alert">
        {error}
      </p>
    ) : null;
  }

  const positionMs = here ? listening.position * 1000 : null;
  const playingId = positionMs === null ? null : playingChapterId(book.chapters, positionMs);
  const totalSeconds = book.durationMs === null ? null : book.durationMs / 1000;
  const notice = targetPending ? waitMessage(target) : waitingForAudio ? waitMessage(nextToGenerate(book)) : null;
  const width = columnWidth({ directory: directoryOpen, sentencePanel: panelOpen });

  const onPick = (chapter: ChapterSummary) => {
    stayAtLocated.current = false;
    reading.current?.showChapter(chapter.id);
    if (isPlayableChapter(chapter)) chapterPick.pick(chapter.id);
  };

  // The player shows the session, which holds this Book once opened (right after the Book is playable).
  const dock = playable ? (
    here && (
      <>
        {markPress.toast}
        <Player totalSeconds={totalSeconds} notice={notice} onMark={markPress.press} />
      </>
    )
  ) : (
    <p className="listen-wait">
      {targetPending
        ? notice
        : book.status === "generating" || book.status === "parsing"
          ? "正在生成第一段音频，稍候即可收听"
          : "这本书没有可播放的音频"}
    </p>
  );

  return (
    <div className="focus">
      {directoryOpen ? (
        <ChapterDirectory
          book={book}
          playingChapterId={playingId}
          playing={here && listening.playing}
          listened={here && totalSeconds ? Math.min(listening.position / totalSeconds, 1) : 0}
          onPick={onPick}
        />
      ) : (
        <div className="directory-collapsed">
          <BackToShelf compact />
        </div>
      )}
      <main className="focus-main">
        {error && (
          <p className="form-error focus-error" role="alert">
            {error}
          </p>
        )}
        <ReadingView
          ref={reading}
          book={book}
          positionMs={positionMs}
          playingChapterId={playingId}
          columnWidth={width}
          directoryOpen={directoryOpen}
          onToggleDirectory={toggleDirectory}
          dock={dock}
          markedIds={marks.pending}
        />
        {!panelOpen && <SentencePanelToggle onOpen={() => setPanelOpen(true)} />}
      </main>
      {panelOpen && <SentencePanel onClose={() => setPanelOpen(false)} />}
    </div>
  );
}
