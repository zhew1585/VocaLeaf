import { useCallback, useEffect, useRef, useState } from "react";
import { getGleanings, type Gleaning } from "../api";
import { locatePath } from "../chapters";
import { LocateIcon, PlaySolidIcon, TextCursorInputIcon, XIcon } from "../icons";
import { useListening } from "../player/session";
import { navigate } from "../router";
import { ConfirmDismiss } from "./ConfirmDismiss";
import { MARKS_CHANGED_EVENT, type MarksChange } from "./marks";
import "./gleanings.css";

const EMPTY = "都拾起来了。听书时点标记，句子会出现在这里";

/** Gleanings from the API, loaded again whenever Marks may have changed wholesale (the outbox was sent). */
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
  useEffect(() => {
    const onChanged = (e: Event) => (e as CustomEvent<MarksChange>).detail === null && setReloads((n) => n + 1);
    window.addEventListener(MARKS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(MARKS_CHANGED_EVENT, onChanged);
  }, []);
  const remove = useCallback((sentenceId: string) => {
    setItems((prev) => prev && prev.filter((g) => g.sentenceId !== sentenceId));
  }, []);
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
 * 【从这里播放】, which plays it in the listening session without leaving the page. Once an item is Dismissed (or,
 * with #15, made into a Card) it leaves the list while the right side keeps showing it.
 */
export function GleaningsPage() {
  const { items, error, remove } = useGleanings();
  const [bookFilter, setBookFilter] = useState<string | null>(null);
  const [selected, setSelected] = useState<Gleaning | null>(null);
  const [asking, setAsking] = useState<Gleaning | null>(null);
  const listening = useListening();
  const plays = useRef(0);

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
            <div className="gleanings-filter" role="group" aria-label="按书筛选">
              <button type="button" className="filter-chip" aria-pressed={filter === null} onClick={() => setBookFilter(null)}>
                全部
              </button>
              {books.map((b) => (
                <button
                  key={b.id}
                  type="button"
                  className="filter-chip book-chip"
                  aria-pressed={filter === b.id}
                  onClick={() => setBookFilter(b.id)}
                >
                  {b.title}
                </button>
              ))}
            </div>
            <ul className="gleaning-list" aria-label="拾起列表">
              {shown.map((g) => (
                <GleaningItem
                  key={g.sentenceId}
                  gleaning={g}
                  selected={g.sentenceId === selected?.sentenceId}
                  onSelect={() => setSelected(g)}
                  onPlay={() => playFrom(g)}
                  onDismiss={() => setAsking(g)}
                />
              ))}
            </ul>
          </>
        )}
      </section>
      <GleaningPanel
        gleaning={selected}
        pending={pending(selected)}
        onLocate={(g) => navigate(locatePath(g.bookId, g.chapterId, g.sentenceId))}
        onDismiss={setAsking}
      />
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
  /** Whether the Sentence is still in Gleanings (not yet Dismissed). */
  pending: boolean;
  onLocate(g: Gleaning): void;
  onDismiss(g: Gleaning): void;
}

/**
 * The right side: the picked Sentence's 句子精读 fixed area with 定位原文 and 【忽略这一句】 (design 05). The panel
 * itself (试听本句, the leaf, AI 解析 and the chat) is #14's SentencePanel, which takes over this frame; 忽略这一句 and
 * 定位原文 go into its fixed area. 制卡 (#15) processes the Mark (api markProcessed) and the item leaves the list.
 */
function GleaningPanel({ gleaning, pending, onLocate, onDismiss }: PanelProps) {
  return (
    <aside className="gleaning-panel" aria-label="句子精读">
      <header className="gleaning-panel-header">
        <h2>句子精读</h2>
      </header>
      {gleaning ? (
        <div className="gleaning-fixed">
          <p className="gleaning-fixed-text">{gleaning.text}</p>
          <div className="gleaning-fixed-actions">
            <button
              type="button"
              className="round-action"
              aria-label="定位原文"
              title="定位原文"
              onClick={() => onLocate(gleaning)}
            >
              <LocateIcon />
            </button>
            <span className="gleaning-fixed-spacer" />
            {pending && (
              <button type="button" className="pill-action" onClick={() => onDismiss(gleaning)}>
                忽略这一句
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="gleaning-panel-empty">
          <TextCursorInputIcon />
          <p className="gleaning-panel-empty-title">选择一条句子</p>
          <p>在左侧选中一句，在这里定位原文或忽略</p>
        </div>
      )}
    </aside>
  );
}
