import { useCallback, useEffect, useRef, useState } from "react";
import { cardAudioUrl, getGleanings, type Card, type Gleaning, type MadeCard } from "../api";
import { CardPopover } from "../cards/CardPopover";
import { useBookCards } from "../cards/useBookCards";
import { locatePath } from "../chapters";
import { PlaySolidIcon, XIcon } from "../icons";
import { useListening } from "../player/session";
import { SentencePanel } from "../reading/SentencePanel";
import { navigate } from "../router";
import { ConfirmDismiss } from "./ConfirmDismiss";
import { announceCardMade, markSentence, unmarkSentence, type MarksChange } from "./marks";
import { useMarksChanged } from "./useMarks";
import "./gleanings.css";

const EMPTY = "都拾起来了。听书时点标记，句子会出现在这里";

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
 * Book; × Dismisses after a confirmation. Picking an item shows its Sentence on the right and offers
 * 【从这里播放】, which plays it in the listening session without leaving the page. The right side is 句子精读 of the
 * picked Sentence with 【忽略这一句】 (F11), where words can be made into a Card (F12), and the 卡片浮窗 in its place
 * once one is made or its green underline clicked (F16). Once an item is Dismissed or made into a Card it leaves the
 * list while the right side keeps showing it (PRD 4.4.4).
 */
export function GleaningsPage() {
  const { items, error, remove } = useGleanings();
  const [bookFilter, setBookFilter] = useState<string | null>(null);
  const [selected, setSelected] = useState<Gleaning | null>(null);
  const [asking, setAsking] = useState<Gleaning | null>(null);
  const listening = useListening();
  const plays = useRef(0);
  const cards = useBookCards(selected?.bookId ?? null);
  const [popover, setPopover] = useState<Card[] | null>(null);
  const { stopAudition } = listening;
  const closePopover = useCallback(() => {
    stopAudition();
    setPopover(null);
  }, [stopAudition]);

  // Esc closes the popover (F16 关闭); this page has no other Esc.
  useEffect(() => {
    if (!popover) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closePopover();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [popover, closePopover]);

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
  const shown = filter === null ? items : items.filter((g) => g.bookId === filter);
  const pending = (g: Gleaning | null) => g !== null && items.some((i) => i.sentenceId === g.sentenceId);

  /** 从这里播放 (PRD 4.4.1): the session switches to the Sentence's Book if needed and plays from its start. */
  const playFrom = (g: Gleaning) => {
    if (g.startMs === null) return;
    listening.open(g.bookId);
    listening.requestStart({ id: `gleaning#${++plays.current}`, seconds: g.startMs / 1000, autoplay: true });
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
              {shown.map((g) => (
                <GleaningItem
                  key={g.sentenceId}
                  gleaning={g}
                  selected={g.sentenceId === selected?.sentenceId}
                  onSelect={() => {
                    if (g.sentenceId !== selected?.sentenceId) closePopover();
                    setSelected(g);
                  }}
                  onPlay={() => playFrom(g)}
                  onDismiss={() => setAsking(g)}
                />
              ))}
            </ul>
          </>
        )}
      </section>
      {popover ? (
        <div className="card-popover-area gleaning-popover-area">
          <CardPopover
            key={popover.map((c) => c.id).join()}
            cards={popover}
            onClose={closePopover}
            onStudySentence={closePopover}
            onCardChanged={(card) => {
              cards.put(card);
              setPopover((p) => p && p.map((c) => (c.id === card.id ? card : c)));
            }}
            audio={{
              state: listening.audition,
              play: (card) => listening.startAudition({ id: card.id, src: cardAudioUrl(card.id) }),
            }}
          />
        </div>
      ) : (
        <GleaningPanel
          gleaning={selected}
          pending={pending(selected)}
          cards={selected ? cards.of(selected.sentenceId) : []}
          onLocate={(g) => navigate(locatePath(g.bookId, g.chapterId, g.sentenceId))}
          onDismiss={setAsking}
          onOpenCards={setPopover}
          onCardMade={({ card, created }) => {
            cards.put(card);
            // The API processed the Mark: the item leaves the list (PRD 4.4.4), the count drops.
            if (created && card.sentenceId) announceCardMade(card.sentenceId);
            setPopover([card]);
          }}
        />
      )}
      {asking && (
        <ConfirmDismiss
          sentenceId={asking.sentenceId}
          onCancel={() => setAsking(null)}
          onDismissed={() => {
            remove(asking.sentenceId);
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
  selected: boolean;
  onSelect(): void;
  onPlay(): void;
  onDismiss(): void;
}

/** One item: the Sentence and where it is from; picked, it also offers 从这里播放. */
function GleaningItem({ gleaning: g, selected, onSelect, onPlay, onDismiss }: ItemProps) {
  return (
    <li className={selected ? "gleaning is-selected" : "gleaning"}>
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
            aria-label="从这里播放"
            title={g.startMs === null ? "这一句的音频还没生成" : "从这里播放"}
            disabled={g.startMs === null}
            onClick={onPlay}
          >
            <PlaySolidIcon size={15} />
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
  onLocate(g: Gleaning): void;
  onDismiss(g: Gleaning): void;
  onOpenCards(cards: Card[]): void;
  onCardMade(made: MadeCard): void;
}

/**
 * The right side: 句子精读 (F11) of the picked Sentence, with 【忽略这一句】 while it is in Gleanings (design 05). The
 * leaf takes the Mark back (the item leaves) or marks it again. 试听本句 needs the Sentence's Book in the listening
 * session, so it is not offered here.
 */
function GleaningPanel({ gleaning, pending, cards, onLocate, onDismiss, onOpenCards, onCardMade }: PanelProps) {
  const sentence = gleaning && { id: gleaning.sentenceId, text: gleaning.text };
  return (
    <div className="gleaning-panel">
      <SentencePanel
        sentence={sentence}
        onLocate={() => gleaning && onLocate(gleaning)}
        audition={null}
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
