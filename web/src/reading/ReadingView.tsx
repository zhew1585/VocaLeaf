import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";
import type { BookDetail, ChapterSummary } from "../api";
import { currentSentenceId, paragraphs, type ReadingSentence } from "./timeline";
import { useChapterSentences } from "./useChapterSentences";

/** Height of the sticky Chapter title at the top of the reading area (design: 92). */
const HEADER_PX = 92;
/** The text fades out this far under the sticky title; a Sentence there is not in view. */
const FADE_PX = 48;
/** Room the floating player takes at the bottom; a Sentence under it is not in view. */
const DOCK_PX = 160;
/** Placeholder height per Sentence for a Chapter never rendered at this width. */
const SENTENCE_ESTIMATE_PX = 48;
/** Chapters rendered on each side of the one at the reading position (F9: only Chapters near the view). */
const WINDOW_RADIUS = 1;
/** Keys that scroll the reading area; pressing one is a manual scroll. */
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);

/** Steers the reading view from outside (the Chapter directory, 【定位原文】, the Mark Toast). */
export interface ReadingViewHandle {
  /** Follows playback again and scrolls to the current Sentence (【回到播放处】, 点章节). */
  followPlayback(): void;
  /** Scrolls to a Chapter's start without playing it (a Skipped Chapter), leaving playback unfollowed. */
  showChapter(chapterId: string): void;
  /** Scrolls to a Sentence of the Chapter once it is shown (【定位原文】), leaving playback unfollowed. */
  showSentence(chapterId: string, sentenceId: string): void;
  /** The text of a Sentence of a Chapter loaded so far (the Toast of a Mark), or undefined. */
  sentenceText(sentenceId: string): string | undefined;
}

interface Props {
  book: BookDetail;
  /** Playback position in milliseconds, or null when the session plays another Book or none. */
  positionMs: number | null;
  playingChapterId: string | null;
  columnWidth: number;
  directoryOpen: boolean;
  onToggleDirectory(): void;
  /** The floating player and its notices, at the bottom of the reading area. */
  dock: ReactNode;
  /** Sentences with a pending Mark, underlined in amber dashes (PRD 4.4.5, AC-READ-04). */
  markedIds: ReadonlySet<string>;
  ref?: Ref<ReadingViewHandle>;
}

/** The Chapter whose section holds the reading position, just under the sticky title. */
function sectionIndexAt(sections: HTMLElement[], y: number): number {
  let lo = 0;
  let hi = sections.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (sections[mid]!.offsetTop <= y) lo = mid;
    else hi = mid - 1;
  }
  return Math.max(0, lo);
}

/** First Sentence whose bottom is below the sticky title, by binary search over the section's Sentences. */
function firstVisibleSentence(section: HTMLElement, viewTop: number): Element | null {
  const items = section.querySelectorAll("[data-sentence-id]");
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (items[mid]!.getBoundingClientRect().bottom <= viewTop) lo = mid + 1;
    else hi = mid;
  }
  return items[lo] ?? null;
}

/**
 * Scrolls so the target is in the readable band between the title's fade and the player: a third of the way
 * down that band. Nothing moves while it is already there. Short moves glide, long jumps are instant.
 */
function keepInView(container: HTMLElement, target: Element, isSection: boolean) {
  const box = container.getBoundingClientRect();
  const rect = target.getBoundingClientRect();
  const top = rect.top - box.top;
  const bandTop = HEADER_PX + FADE_PX;
  const bandBottom = container.clientHeight - DOCK_PX;
  let delta: number;
  if (isSection) delta = top;
  else if (top >= bandTop && rect.bottom - box.top <= bandBottom) return;
  else delta = top - (bandTop + (bandBottom - bandTop) / 3);
  const behavior = Math.abs(delta) < container.clientHeight ? "smooth" : "auto";
  container.scrollTo({ top: container.scrollTop + delta, behavior });
}

/**
 * The 专注页 reading area (F9, PRD 4.4.5): every Chapter's text by paragraph, the current Sentence on light
 * green, following playback until the user scrolls, then 【回到播放处】. Each Chapter's title sticks at the top
 * while it is being read. Only Chapters near the reading position (and the playing one) are rendered; the rest
 * keep their height as placeholders, and the reading position is kept when heights change above it.
 */
export function ReadingView({
  book,
  positionMs,
  playingChapterId,
  columnWidth,
  directoryOpen,
  onToggleDirectory,
  dock,
  markedIds,
  ref,
}: Props) {
  const container = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [readingIndex, setReadingIndex] = useState(0);
  const [intoChapter, setIntoChapter] = useState(false);
  const [following, setFollowing] = useState(true);
  const heights = useRef(new Map<string, number>());
  // The Sentence 【定位原文】 asked for, until it is shown and scrolled to.
  const [locating, setLocating] = useState<string | null>(null);
  const anchor = useRef<{ el: Element; top: number } | null>(null);

  const { chapters } = book;
  const playingIndex = chapters.findIndex((c) => c.id === playingChapterId);
  const wanted = useMemo(() => {
    const picked = new Set<number>();
    for (let i = readingIndex - WINDOW_RADIUS; i <= readingIndex + WINDOW_RADIUS; i++) if (chapters[i]) picked.add(i);
    if (playingIndex >= 0) picked.add(playingIndex);
    return [...picked].sort((a, b) => a - b).map((i) => chapters[i]!);
  }, [chapters, readingIndex, playingIndex]);
  const sentences = useChapterSentences(wanted);
  const playingSentences = playingChapterId ? sentences.get(playingChapterId) : undefined;
  const current = positionMs !== null && playingSentences ? currentSentenceId(playingSentences, positionMs) : null;

  const sections = () => [...content.current!.children] as HTMLElement[];

  /** Remembers which Sentence is at the top of the view and where, to hold it there when heights change. */
  const captureAnchor = useCallback(() => {
    const el = container.current!;
    const all = sections();
    if (all.length === 0) return;
    const index = sectionIndexAt(all, el.scrollTop + HEADER_PX);
    const section = all[index]!;
    const viewTop = el.getBoundingClientRect().top + HEADER_PX;
    const target = firstVisibleSentence(section, viewTop) ?? section;
    anchor.current = { el: target, top: target.getBoundingClientRect().top - el.getBoundingClientRect().top };
    setReadingIndex(index);
    setIntoChapter(el.scrollTop > section.offsetTop + 1);
  }, []);

  const frame = useRef(0);
  const onScroll = () => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(captureAnchor);
  };
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  // Heights change when a Chapter renders or leaves, or the column width changes: keep the anchor in place,
  // and remember rendered Chapters' heights for their placeholders.
  useLayoutEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      for (const s of sections()) {
        if (s.dataset.rendered === "true") heights.current.set(`${columnWidth}:${s.dataset.chapterId}`, s.offsetHeight);
      }
      const a = anchor.current;
      if (!a?.el.isConnected) return;
      const el = container.current!;
      const delta = a.el.getBoundingClientRect().top - el.getBoundingClientRect().top - a.top;
      if (Math.abs(delta) > 0.5) el.scrollTop += delta;
    });
    observer.observe(content.current!);
    return () => observer.disconnect();
  }, [columnWidth]);

  // Follow playback: keep the current Sentence (or, before its Sentences load, the playing Chapter) in view.
  const followed = positionMs !== null && following;
  useEffect(() => {
    if (!followed) return;
    const el = container.current!;
    const sentence = current ? el.querySelector(`[data-sentence-id="${current}"]`) : null;
    const section = playingChapterId ? el.querySelector(`[data-chapter-id="${playingChapterId}"]`) : null;
    if (sentence) keepInView(el, sentence, false);
    else if (section) keepInView(el, section, true);
  }, [followed, current, playingChapterId, sentences]);

  // Scroll to the Sentence 【定位原文】 asked for once its Chapter is rendered.
  useEffect(() => {
    if (locating === null) return;
    const el = container.current!.querySelector(`[data-sentence-id="${locating}"]`);
    if (!el) return;
    keepInView(container.current!, el, false);
    setLocating(null);
  }, [locating, sentences]);

  const latestSentences = useRef(sentences);
  latestSentences.current = sentences;
  const showChapter = (chapterId: string) => {
    setFollowing(false);
    const section = container.current!.querySelector<HTMLElement>(`[data-chapter-id="${chapterId}"]`);
    if (section) container.current!.scrollTo({ top: section.offsetTop, behavior: "auto" });
  };

  useImperativeHandle(
    ref,
    () => ({
      followPlayback: () => {
        setLocating(null);
        setFollowing(true);
      },
      showChapter,
      showSentence: (chapterId, sentenceId) => {
        showChapter(chapterId);
        // Render the Chapter now rather than after the scroll settles.
        const index = chapters.findIndex((c) => c.id === chapterId);
        if (index >= 0) setReadingIndex(index);
        setLocating(sentenceId);
      },
      sentenceText: (sentenceId) => {
        for (const list of latestSentences.current.values()) {
          const found = list.find((s) => s.id === sentenceId);
          if (found) return found.text;
        }
        return undefined;
      },
    }),
    [chapters],
  );

  const stopFollowing = () => setFollowing(false);
  const placeholderHeight = (c: ChapterSummary) =>
    heights.current.get(`${columnWidth}:${c.id}`) ?? c.sentenceCount * SENTENCE_ESTIMATE_PX;
  const inWindow = new Set(wanted.map((c) => c.id));

  return (
    <div className="reading" style={{ "--column": `${columnWidth}px` } as React.CSSProperties}>
      <div
        ref={container}
        className="reading-scroll"
        onScroll={onScroll}
        onWheel={stopFollowing}
        onTouchMove={stopFollowing}
        // A key the player shortcuts took (Space plays or pauses) does not scroll.
        onKeyDown={(e) => SCROLL_KEYS.has(e.key) && !e.nativeEvent.defaultPrevented && stopFollowing()}
        onMouseDown={(e) => {
          // A press on the scrollbar itself (outside the content box) is a manual scroll.
          if (e.target === e.currentTarget && e.nativeEvent.offsetX >= e.currentTarget.clientWidth) stopFollowing();
        }}
      >
        <div ref={content} className="reading-content">
          {chapters.map((c, i) => (
            <ChapterSection
              key={c.id}
              chapter={c}
              sentences={inWindow.has(c.id) ? sentences.get(c.id) : undefined}
              placeholderHeight={placeholderHeight(c)}
              currentSentenceId={c.id === playingChapterId ? current : null}
              markedIds={markedIds}
              faded={i === readingIndex && intoChapter}
              directoryOpen={directoryOpen}
              onToggleDirectory={onToggleDirectory}
            />
          ))}
        </div>
      </div>
      <div className="reading-dock">
        {positionMs !== null && !following && (
          <button type="button" className="follow-button" onClick={() => setFollowing(true)}>
            回到播放处
          </button>
        )}
        {dock}
      </div>
    </div>
  );
}

interface SectionProps {
  chapter: ChapterSummary;
  /** Undefined while the Chapter is a placeholder: away from the reading position, or not loaded yet. */
  sentences: ReadingSentence[] | undefined;
  placeholderHeight: number;
  currentSentenceId: string | null;
  markedIds: ReadonlySet<string>;
  /** The text under the sticky title fades out once the Chapter is scrolled into (not at its start). */
  faded: boolean;
  directoryOpen: boolean;
  onToggleDirectory(): void;
}

/** One Chapter: its sticky title (which opens and closes the directory) and its paragraphs. */
const ChapterSection = memo(function ChapterSection({
  chapter,
  sentences,
  placeholderHeight,
  currentSentenceId,
  markedIds,
  faded,
  directoryOpen,
  onToggleDirectory,
}: SectionProps) {
  return (
    <section
      className={faded ? "reading-chapter is-faded" : "reading-chapter"}
      data-chapter-id={chapter.id}
      data-rendered={sentences ? "true" : "false"}
      aria-label={chapter.title}
    >
      <header className="reading-heading">
        <button
          type="button"
          className="reading-title"
          aria-expanded={directoryOpen}
          aria-controls="chapter-directory"
          title={directoryOpen ? "收起目录" : "展开目录"}
          onClick={onToggleDirectory}
        >
          {chapter.title}
          <span className="reading-chevron" aria-hidden="true">
            ›
          </span>
        </button>
        {chapter.skipped && <span className="chapter-tag">未朗读</span>}
      </header>
      {sentences ? (
        paragraphs(sentences).map((para) => (
          <p key={para[0]!.id} className="reading-paragraph">
            {para.map((s, i) => (
              <Fragment key={s.id}>
                {i > 0 && " "}
                <span
                  data-sentence-id={s.id}
                  className={sentenceClass(s.id === currentSentenceId, markedIds.has(s.id))}
                  aria-current={s.id === currentSentenceId ? "true" : undefined}
                >
                  {s.text}
                </span>
              </Fragment>
            ))}
          </p>
        ))
      ) : (
        <div className="reading-placeholder" style={{ height: placeholderHeight }} />
      )}
    </section>
  );
});

/** A Sentence's styles stack (PRD 4.4.5 叠加规则): playing is a light green fill, a pending Mark an amber underline. */
function sentenceClass(playing: boolean, marked: boolean): string {
  return ["sentence", playing && "is-playing", marked && "is-marked"].filter(Boolean).join(" ");
}
