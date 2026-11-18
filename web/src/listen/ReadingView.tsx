import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";
import type { ChapterSummary, Sentence } from "../api";
import { LocateFixedIcon } from "../icons";
import { paragraphs, playingSentenceId, timesBehind } from "./timing";
import { useSentences } from "./useSentences";

/** Chapters within this distance of the viewport are rendered; the others keep only their height (F9). */
const NEAR_MARGIN = "150% 0px";
/** Height of a Chapter never rendered yet, per Sentence: about two lines of 21 px text at 1.5 plus spacing. */
const ESTIMATED_SENTENCE_PX = 64;
/** Room the floating player and its fade take at the bottom of the viewport. */
const PLAYER_ROOM_PX = 160;
/** Where a followed Sentence is placed when it has to scroll: this share of the viewport from the top. */
const FOLLOW_AT = 0.3;
/** Keys that scroll the text; using them is reading on, so following stops. */
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"]);

export interface ReadingViewHandle {
  /** Follows playback again and scrolls to where it is (【回到播放处】, or after starting a Chapter). */
  follow(): void;
  /** Stops following and shows a Chapter from its start (one that cannot be played: Skipped or not generated). */
  showChapter(chapterId: string): void;
}

interface Props {
  chapters: readonly ChapterSummary[];
  /** The Chapter playback is in and how far, in ms of the Book's audio. */
  playingChapterId: string | null;
  positionMs: number;
  directoryOpen: boolean;
  onToggleDirectory(): void;
  /** The floating player, docked at the bottom of the reading area. */
  player: ReactNode;
  ref?: Ref<ReadingViewHandle>;
}

/**
 * Reading view of the 专注页 (F9, design 01 ②): the whole Book's text by paragraph under a fixed Chapter title,
 * the playing Sentence highlighted and kept in view (PRD 4.4.5). Scrolling by hand stops following and offers
 * 【回到播放处】. Only Chapters near the viewport are fetched and rendered, so a 200 000-word Book scrolls freely.
 * Whatever changes the text's layout (a Chapter rendering above, the column width changing with the sidebars),
 * the Sentence at the top of the viewport stays where it was.
 */
export function ReadingView({ chapters, playingChapterId, positionMs, directoryOpen, onToggleDirectory, player, ref }: Props) {
  const viewport = useRef<HTMLDivElement>(null);
  const column = useRef<HTMLDivElement>(null);
  const sections = useRef(new Map<string, HTMLElement>());
  const heights = useRef(new Map<string, number>());
  const observer = useRef<IntersectionObserver | null>(null);
  /** The element at the top of the viewport and its offset from it, kept in place across layout changes. */
  const anchor = useRef<{ el: Element; top: number } | null>(null);

  const [near, setNear] = useState<ReadonlySet<string>>(new Set());
  const [following, setFollowing] = useState(true);
  const [followRequest, setFollowRequest] = useState(0);
  const [topChapterId, setTopChapterId] = useState<string | null>(null);
  const [atChapterStart, setAtChapterStart] = useState(true);
  const { byChapter, load, refresh } = useSentences();

  const playingChapter = chapters.find((c) => c.id === playingChapterId);
  const playingSentences = playingChapterId ? byChapter.get(playingChapterId) : undefined;
  const playingSentence = playingSentences ? playingSentenceId(playingSentences, positionMs) : null;

  // Fetch the Chapters near the viewport and the one playing, and newer times for the playing one while it generates.
  useEffect(() => {
    for (const c of chapters) if (near.has(c.id) || c.id === playingChapterId) load(c);
  }, [chapters, near, playingChapterId, load]);
  useEffect(() => {
    if (playingChapter && playingSentences && timesBehind(playingSentences, positionMs)) refresh(playingChapter);
  }, [playingChapter, playingSentences, positionMs, refresh]);

  /** Registers a Chapter's section for windowing; returns its cleanup (a React 19 ref callback). */
  const observe = useCallback((chapterId: string, el: HTMLElement) => {
    sections.current.set(chapterId, el);
    observer.current?.observe(el);
    return () => {
      observer.current?.unobserve(el);
      sections.current.delete(chapterId);
    };
  }, []);

  // Created after the sections registered themselves (their refs attach before this effect runs).
  useLayoutEffect(() => {
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const section = e.target as HTMLElement;
          // A rendered Chapter keeps the real height of its text for when it is a placeholder again.
          const body = section.querySelector("[data-chapter-start]");
          if (section.dataset.rendered !== undefined && body) heights.current.set(section.dataset.chapterId!, body.getBoundingClientRect().height);
        }
        setNear((prev) => {
          const next = new Set(prev);
          for (const e of entries) {
            const id = (e.target as HTMLElement).dataset.chapterId!;
            if (e.isIntersecting) next.add(id);
            else next.delete(id);
          }
          return next.size === prev.size && [...next].every((id) => prev.has(id)) ? prev : next;
        });
      },
      { root: viewport.current, rootMargin: NEAR_MARGIN },
    );
    observer.current = io;
    for (const el of sections.current.values()) io.observe(el);
    return () => {
      io.disconnect();
      observer.current = null;
    };
  }, []);

  /** Where a Chapter's text starts: below its heading, so showing it puts the heading just out of view. */
  const chapterStart = (chapterId: string) => sections.current.get(chapterId)?.querySelector("[data-chapter-start]") ?? null;

  /** Records the anchor and which Chapter is at the top (for the fixed title and the top fade). */
  const onScroll = () => {
    const vp = viewport.current!;
    const vpTop = vp.getBoundingClientRect().top;
    let top: string | null = chapters[0]?.id ?? null;
    let startOffset = 0;
    for (const c of chapters) {
      const offset = chapterStart(c.id)?.getBoundingClientRect().top;
      if (offset === undefined || offset - vpTop > 1) break;
      top = c.id;
      startOffset = offset - vpTop;
    }
    setTopChapterId(top);
    setAtChapterStart(Math.abs(startOffset) <= 1);

    const col = column.current!.getBoundingClientRect();
    anchor.current = null;
    for (const dy of [4, 24, 48]) {
      const hit = document.elementFromPoint?.(col.left + col.width / 2, vpTop + dy);
      const el = hit?.closest("[data-sentence-id], [data-chapter-start]");
      if (el && vp.contains(el)) {
        anchor.current = { el, top: el.getBoundingClientRect().top - vpTop };
        break;
      }
    }
  };

  // Keep the anchor in place whenever the text's layout changes.
  useEffect(() => {
    const vp = viewport.current!;
    const ro = new ResizeObserver(() => {
      const a = anchor.current;
      if (!a?.el.isConnected) return;
      const delta = a.el.getBoundingClientRect().top - vp.getBoundingClientRect().top - a.top;
      if (Math.abs(delta) >= 1) vp.scrollTop += delta;
    });
    ro.observe(column.current!);
    return () => ro.disconnect();
  }, []);

  // Follow playback: bring the playing Sentence into view, or the playing Chapter's start before its first one.
  useEffect(() => {
    if (!following || !playingChapterId) return;
    const vp = viewport.current!;
    const sentence = playingSentence ? vp.querySelector(`[data-sentence-id="${playingSentence}"]`) : null;
    // Not rendered yet: go to its Chapter, which then renders and brings this effect back for the Sentence.
    const target = sentence ?? chapterStart(playingChapterId);
    if (!target) return;
    const vpRect = vp.getBoundingClientRect();
    const rect = target.getBoundingClientRect();
    const top = rect.top - vpRect.top;
    if (sentence && top >= 0 && rect.bottom - vpRect.top <= vp.clientHeight - PLAYER_ROOM_PX) return;
    const offset = sentence ? Math.round(vp.clientHeight * FOLLOW_AT) : 0;
    if (Math.abs(top - offset) < 1) return;
    const far = Math.abs(top - offset) > vp.clientHeight * 2;
    vp.scrollTo({ top: vp.scrollTop + top - offset, behavior: far ? "instant" : "smooth" });
  }, [following, followRequest, playingChapterId, playingSentence, near, byChapter]);

  useImperativeHandle(ref, () => ({
    follow() {
      setFollowing(true);
      setFollowRequest((n) => n + 1);
    },
    showChapter(chapterId) {
      setFollowing(false);
      const vp = viewport.current!;
      const start = chapterStart(chapterId);
      if (start) vp.scrollTo({ top: vp.scrollTop + start.getBoundingClientRect().top - vp.getBoundingClientRect().top, behavior: "instant" });
    },
  }));

  const stopFollowing = () => setFollowing(false);
  const topChapter = chapters.find((c) => c.id === topChapterId) ?? chapters[0];

  return (
    <div className="reading">
      <header className="reading-header">
        <div className="reading-measure reading-header-inner">
          {topChapter && (
            <button type="button" className="chapter-toggle" aria-expanded={directoryOpen} onClick={onToggleDirectory}>
              <span className="chapter-toggle-title">{topChapter.title}</span>
              <span className="chapter-toggle-chevron" aria-hidden="true">
                ›
              </span>
            </button>
          )}
          {topChapter?.skipped && <span className="tag">未朗读</span>}
        </div>
      </header>
      <div
        ref={viewport}
        className={`reading-scroll${atChapterStart ? "" : " is-faded"}`}
        data-testid="reading-scroll"
        onScroll={onScroll}
        onWheel={stopFollowing}
        onTouchMove={stopFollowing}
        onKeyDown={(e) => SCROLL_KEYS.has(e.key) && stopFollowing()}
        // Dragging the scrollbar: the press lands on the scroll container itself.
        onPointerDown={(e) => e.target === e.currentTarget && stopFollowing()}
      >
        <div ref={column} className="reading-measure reading-column">
          {chapters.map((c, i) => (
            <ChapterSection
              key={c.id}
              chapter={c}
              withHeading={i > 0}
              sentences={near.has(c.id) ? byChapter.get(c.id) : undefined}
              placeholderHeight={heights.current.get(c.id) ?? c.sentenceCount * ESTIMATED_SENTENCE_PX}
              playingSentenceId={c.id === playingChapterId ? playingSentence : null}
              observe={observe}
            />
          ))}
        </div>
      </div>
      <div className="player-dock">
        {!following && playingChapterId && (
          <button
            type="button"
            className="back-to-playing"
            onClick={() => {
              setFollowing(true);
              setFollowRequest((n) => n + 1);
            }}
          >
            <LocateFixedIcon />
            回到播放处
          </button>
        )}
        {player}
      </div>
    </div>
  );
}

interface SectionProps {
  chapter: ChapterSummary;
  /** Every Chapter but the first starts with its title in the text; the fixed title names the first. */
  withHeading: boolean;
  /** Set when the Chapter is near the viewport and fetched; otherwise only its height is kept. */
  sentences: Sentence[] | undefined;
  placeholderHeight: number;
  playingSentenceId: string | null;
  observe(chapterId: string, el: HTMLElement): () => void;
}

/** One Chapter's text, re-rendered only when it changes or the playing Sentence moves within it. */
const ChapterSection = memo(function ChapterSection({ chapter, withHeading, sentences, placeholderHeight, playingSentenceId, observe }: SectionProps) {
  const ref = useCallback((el: HTMLElement) => observe(chapter.id, el), [chapter.id, observe]);
  return (
    <section ref={ref} className="chapter-section" data-chapter-id={chapter.id} data-rendered={sentences ? "" : undefined}>
      {withHeading && (
        <h2 className="chapter-break">
          {chapter.title}
          {chapter.skipped && <span className="tag">未朗读</span>}
        </h2>
      )}
      {sentences ? (
        <div className="chapter-body" data-chapter-start="">
          {paragraphs(sentences).map((para) =>
            para.length === 1 ? (
              <p key={para[0]!.id} className={sentenceClass("para", para[0]!.id === playingSentenceId)} data-sentence-id={para[0]!.id}>
                {para[0]!.text}
              </p>
            ) : (
              <p key={para[0]!.id} className="para">
                {para.map((s, i) => (
                  <Fragment key={s.id}>
                    {i > 0 && " "}
                    <span className={sentenceClass("sentence", s.id === playingSentenceId)} data-sentence-id={s.id}>
                      {s.text}
                    </span>
                  </Fragment>
                ))}
              </p>
            ),
          )}
        </div>
      ) : (
        <div className="chapter-body" data-chapter-start="" style={{ height: placeholderHeight }} />
      )}
    </section>
  );
});

/** A one-Sentence paragraph is highlighted as a block (as in the design), a Sentence within a paragraph inline. */
function sentenceClass(base: "para" | "sentence", playing: boolean) {
  return playing ? `${base} is-playing` : base;
}
