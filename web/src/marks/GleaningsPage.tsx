import { useCallback, useEffect, useState } from "react";
import { getGleanings, type Card, type Gleaning, type MadeCard } from "../api";
import { CardPopover } from "../cards/CardPopover";
import { useBookCards } from "../cards/useBookCards";
import { useCardPopover } from "../cards/useCardPopover";
import { locatePath } from "../chapters";
import { PauseSolidIcon, PlaySolidIcon, XIcon } from "../icons";
import { useCollapse, usePresence, usePresenceList } from "../motion";
import type { AuditionControl } from "../reading/SentencePanel";
import { playlistUrl, useListening } from "../player/session";
import { SentencePanel } from "../reading/SentencePanel";
import { navigate } from "../router";
import { ConfirmDismiss } from "./ConfirmDismiss";
import { markSentence, unmarkSentence, type MarksChange } from "./marks";
import { useMarksChanged } from "./useMarks";
import "./gleanings.css";

const EMPTY = "都拾起来了。听书时点标记，句子会出现在这里";
/** The list before it loads; one array, so the list's presence sees no change. */
const NOT_LOADED: Gleaning[] = [];

/**
 * Gleanings from the API. A Sentence whose Mark stops being pending (Dismissed, unmarked, made into a Card) leaves
 * at once; they are loaded again when one becomes pending or Marks may have changed wholesale (the outbox was sent).
 */
function useGleanings() {
  const [items, setItems] = useState<Gleaning[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);
  useEffect(() => {
    let active = true;
    getGleanings().then(
      (loaded) => active && (setItems(loaded), setError(null)),
      (err: unknown) => active && setError(err instanceof Error ? err.message : "加载失败，请稍后再试"),
    );
    return () => {
      active = false;
    };
  }, [reloads]);
  const remove = useCallback((sentenceId: string) => {
    setItems((prev) => prev && prev.filter((g) => g.sentenceId !== sentenceId));
  }, []);
  useMarksChanged(
    useCallback(
      (change: MarksChange) => (change === null || change.pending ? setReloads((n) => n + 1) : remove(change.sentenceId)),
      [remove],
    ),
  );
  return { items, error, remove };
}

/** The Books that have items, in the order their newest item comes. */
function booksOf(items: Gleaning[]): { id: string; title: string }[] {
  const seen = new Map<string, string>();
  for (const g of items) if (!seen.has(g.bookId)) seen.set(g.bookId, g.bookTitle);
  return [...seen].map(([id, title]) => ({ id, title }));
}

/**
 * 拾起 (design 05, F10, PRD 4.4.4): one list of the user's pending Marks across Books, newest first, filtered by
 * Book; × Dismisses after a confirmation. Picking an item shows its Sentence on the right and offers 播放这一句,
 * which plays that Sentence alone (试听) and stops at its end, pausable and resumable from the same button. The right side is
 * 句子精读 of the picked Sentence with 【忽略这一句】 (F11), where words can be made into a Card (F12), and the 卡片浮窗 in its place
 * once one is made or its green underline clicked (F16). Once an item is Dismissed or made into a Card it leaves the
 * list while the right side keeps showing it (PRD 4.4.4).
 */
export function GleaningsPage() {
  const { items, error, remove } = useGleanings();
  const [bookFilter, setBookFilter] = useState<string | null>(null);
  const [selected, setSelected] = useState<Gleaning | null>(null);
  const [asking, setAsking] = useState<Gleaning | null>(null);
  const confirm = usePresence(asking);
  // An item that leaves (Dismissed, unmarked, made into a Card) closes up in place rather than vanishing.
  const listed = usePresenceList(items ?? NOT_LOADED, (g) => g.sentenceId);
  const listening = useListening();
  const cards = useBookCards(selected?.bookId ?? null);
  const popover = useCardPopover<null>(cards);
  const { close: closePopover } = popover;
  const popoverOpen = popover.open !== null;

  // Esc closes the popover (F16 关闭); this page has no other Esc.
  useEffect(() => {
    if (!popoverOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closePopover();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [popoverOpen, closePopover]);

  if (error && !items) {
    return (
      <p className="form-error" role="alert">
        {error}
      </p>
    );
  }
  if (!items) return null;

  const books = booksOf(items);
  // A Book whose last item left stops filtering.
  const filter = books.some((b) => b.id === bookFilter) ? bookFilter : null;
  const shown = filter === null ? listed : listed.filter(({ item }) => item.bookId === filter);
  const pending = (g: Gleaning | null) => g !== null && items.some((i) => i.sentenceId === g.sentenceId);

  /**
   * The Sentence alone (PRD 4.4.1 试听), from its own Book's audio, whichever Book the session holds. The item's
   * 播放这一句 and 句子精读's speaker are separate: each shows only its own playing. Only the item's pauses and plays
   * on from where it paused; the speaker always reads from the Sentence's start.
   */
  const audition = (g: Gleaning, from: "item" | "panel"): AuditionControl | null => {
    const { startMs, endMs } = g;
    if (startMs === null || endMs === null) return null;
    const id = `${from}:${g.sentenceId}`;
    const own = listening.audition?.id === id ? listening.audition : null;
    const state = !own || own.paused ? "idle" : own.loading ? "loading" : "playing";
    const play = () =>
      own?.paused ? listening.resumeAudition() : listening.startAudition({ id, startMs, endMs, playlist: playlistUrl(g.bookId) });
    return { state, play };
  };

  return (
    <div className="gleanings">
      <section className="gleanings-main">
        <h1 className="gleanings-title">
          拾起<span className="gleanings-count">{items.length}</span>
        </h1>
        {items.length === 0 ? (
          <p className="gleanings-empty">{EMPTY}</p>
        ) : (
          <>
            <BookFilter books={books} value={filter} onChange={setBookFilter} />
            <ul className="gleaning-list" aria-label="拾起列表">
              {shown.map(({ item: g, exiting }) => (
                <GleaningItem
                  key={g.sentenceId}
                  gleaning={g}
                  exiting={exiting}
                  selected={g.sentenceId === selected?.sentenceId}
                  onSelect={() => {
                    // Another Sentence: its own right side, and no 试听 goes on (PRD 4.4.1 试听 #5).
                    if (g.sentenceId !== selected?.sentenceId) closePopover();
                    setSelected(g);
                  }}
                  audition={audition(g, "item")}
                  onPause={listening.pauseAudition}
                  onDismiss={() => setAsking(g)}
                />
              ))}
            </ul>
          </>
        )}
      </section>
      {popover.open ? (
        <div className="card-popover-area gleaning-popover-area">
          <CardPopover
            key={popover.open.cards.map((c) => c.id).join()}
            cards={popover.open.cards}
            onClose={closePopover}
            onStudySentence={closePopover}
            onCardChanged={popover.changed}
            audio={popover.audio}
          />
        </div>
      ) : (
        <GleaningPanel
          gleaning={selected}
          pending={pending(selected)}
          cards={selected ? cards.of(selected.sentenceId) : []}
          audition={selected && audition(selected, "panel")}
          onLocate={(g) => navigate(locatePath(g.bookId, g.chapterId, g.sentenceId))}
          onDismiss={setAsking}
          onOpenCards={(shown) => popover.show(shown, null)}
          // A new Card took the item out of Gleanings (PRD 4.4.4); the right side keeps the Sentence.
          onCardMade={(made) => popover.made(made, null)}
        />
      )}
      {confirm.value && (
        <ConfirmDismiss
          sentenceId={confirm.value.sentenceId}
          exiting={confirm.exiting}
          onCancel={() => setAsking(null)}
          onDismissed={() => {
            remove(confirm.value!.sentenceId);
            setAsking(null);
          }}
        />
      )}
    </div>
  );
}

interface FilterProps {
  books: { id: string; title: string }[];
  /** The Book filtered by, or null for 全部. */
  value: string | null;
  onChange(bookId: string | null): void;
}

/** 全部 and one chip per Book with items (PRD 4.4.4 筛选). */
function BookFilter({ books, value, onChange }: FilterProps) {
  return (
    <div className="gleanings-filter" role="group" aria-label="按书筛选">
      <button type="button" className="filter-chip" aria-pressed={value === null} onClick={() => onChange(null)}>
        全部
      </button>
      {books.map((b) => (
        <button
          key={b.id}
          type="button"
          className="filter-chip book-chip"
          aria-pressed={value === b.id}
          onClick={() => onChange(b.id)}
        >
          {b.title}
        </button>
      ))}
    </div>
  );
}

interface ItemProps {
  gleaning: Gleaning;
  /** Gone from Gleanings, closing up before it goes. */
  exiting: boolean;
  selected: boolean;
  /** 试听 of the Sentence, or null while it has no audio. */
  audition: AuditionControl | null;
  onSelect(): void;
  onPause(): void;
  onDismiss(): void;
}

/**
 * One item: the Sentence and where it is from. Picked, it also offers 播放这一句: the Sentence alone (试听, PRD
 * 4.4.1), stopping at its end; while it plays the same button pauses it, and playing again goes on from there.
 */
function GleaningItem({ gleaning: g, exiting, selected, audition, onSelect, onPause, onDismiss }: ItemProps) {
  const playing = audition !== null && audition.state !== "idle";
  const ref = useCollapse<HTMLLIElement>(exiting);
  return (
    <li ref={ref} className={["gleaning", selected && "is-selected", exiting && "is-exiting"].filter(Boolean).join(" ")}>
      <button type="button" className="gleaning-body" aria-pressed={selected} onClick={onSelect}>
        <span className="gleaning-text">{g.text}</span>
        <span className="gleaning-source">
          {g.bookTitle} · {g.chapterTitle}
        </span>
      </button>
      <div className="gleaning-actions">
        {selected && (
          <button
            type="button"
            className="gleaning-play"
            aria-label={playing ? "暂停" : "播放这一句"}
            title={audition === null ? "这一句的音频还没生成" : playing ? "暂停" : "播放这一句"}
            disabled={audition === null}
            onClick={playing ? onPause : audition?.play}
          >
            <span key={playing ? "pause" : "play"} className="icon-swap">
              {playing ? <PauseSolidIcon size={15} /> : <PlaySolidIcon size={15} />}
            </span>
          </button>
        )}
        <button type="button" className="gleaning-dismiss" aria-label="忽略" title="忽略这一句" onClick={onDismiss}>
          <XIcon size={17} />
        </button>
      </div>
    </li>
  );
}

interface PanelProps {
  gleaning: Gleaning | null;
  /** Whether the Sentence is still in Gleanings (not Dismissed, unmarked or made into a Card yet). */
  pending: boolean;
  cards: Card[];
  /** 【试听本句】; null while the Sentence has no audio. */
  audition: AuditionControl | null;
  onLocate(g: Gleaning): void;
  onDismiss(g: Gleaning): void;
  onOpenCards(cards: Card[]): void;
  onCardMade(made: MadeCard): void;
}

/**
 * The right side: 句子精读 (F11) of the picked Sentence, with 【忽略这一句】 while it is in Gleanings (design 05). The
 * leaf takes the Mark back (the item leaves) or marks it again.
 */
function GleaningPanel({ gleaning, pending, cards, audition, onLocate, onDismiss, onOpenCards, onCardMade }: PanelProps) {
  const sentence = gleaning && { id: gleaning.sentenceId, text: gleaning.text };
  return (
    <div className="gleaning-panel">
      <SentencePanel
        sentence={sentence}
        onLocate={() => gleaning && onLocate(gleaning)}
        audition={audition}
        mark={
          gleaning && {
            marked: pending,
            toggle: () => void (pending ? unmarkSentence(gleaning.sentenceId) : markSentence(gleaning.sentenceId)),
          }
        }
        cards={cards}
        onOpenCards={onOpenCards}
        onCardMade={onCardMade}
        extraAction={
          gleaning &&
          pending && (
            <button type="button" className="pill-action" onClick={() => onDismiss(gleaning)}>
              忽略这一句
            </button>
          )
        }
      />
    </div>
  );
}
