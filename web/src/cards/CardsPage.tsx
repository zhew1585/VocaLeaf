import { useCallback, useEffect, useState } from "react";
import { listCards, type Card, type CardListItem } from "../api";
import { SearchIcon } from "../icons";
import { useListening } from "../player/session";
import { CardDetailPanel } from "./CardDetailPanel";
import { cardSources, matchesSearch, sourceKey, sourceLabel, type CardSource } from "./cardList";
import { BACK_MISSING, cardMeaning, dueShort } from "./cards";
import "./cardsPage.css";

const EMPTY = "还没有卡片。在句子精读里选中单词，点【制作卡片】";
const NO_MATCH = "没有找到匹配的卡片";

/** Every Card of the user, kept as Cards are changed or deleted here. */
function useCardList() {
  const [items, setItems] = useState<CardListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    listCards().then(
      (loaded) => active && setItems(loaded),
      (err: unknown) => active && setError(err instanceof Error ? err.message : "加载失败，请稍后再试"),
    );
    return () => {
      active = false;
    };
  }, []);
  /** A Card's back was generated again; it keeps where it came from. */
  const replace = useCallback((card: Card) => {
    setItems((prev) => prev && prev.map((c) => (c.id === card.id ? { ...c, ...card } : c)));
  }, []);
  const remove = useCallback((id: string) => {
    setItems((prev) => prev && prev.filter((c) => c.id !== id));
  }, []);
  return { items, error, replace, remove };
}

/**
 * 卡片 (design 07, F14, PRD 4.5.2): every Card of the user, soonest due first, searched by Target and Sentence and
 * filtered by the Book it came from. Picking one shows its detail on the right, with 卡片原声, 【重新生成】 and 删除.
 */
export function CardsPage() {
  const { items, error, replace, remove } = useCardList();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { stopAudition } = useListening();

  // Leaving the page ends a 卡片原声 (PRD 4.4.1 试听 #5).
  useEffect(() => stopAudition, [stopAudition]);

  if (error && !items) {
    return (
      <p className="form-error" role="alert">
        {error}
      </p>
    );
  }
  if (!items) return null;

  const sources = cardSources(items);
  // A source whose last Card was deleted stops filtering.
  const activeFilter = sources.some((s) => s.key === filter) ? filter : null;
  const shown = items.filter((c) => (activeFilter === null || sourceKey(c) === activeFilter) && matchesSearch(c, query));
  const selected = items.find((c) => c.id === selectedId) ?? null;

  /** Another Card, or none: whatever 卡片原声 plays stops. */
  const select = (id: string | null) => {
    if (id !== selectedId) stopAudition();
    setSelectedId(id);
  };

  return (
    <div className={selected ? "cards-page has-detail" : "cards-page"}>
      <section className="cards-main">
        <header className="cards-header">
          <h1 className="cards-title">
            卡片<span className="cards-count">{items.length}</span>
          </h1>
          <label className="cards-search">
            <SearchIcon />
            <input type="search" aria-label="搜索卡片" placeholder="搜索" value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
        </header>
        {items.length === 0 ? (
          <p className="cards-empty">{EMPTY}</p>
        ) : (
          <>
            <SourceFilter sources={sources} value={activeFilter} onChange={setFilter} />
            <ul className="card-items" aria-label="卡片列表">
              {shown.map((c) => (
                <CardItem key={c.id} card={c} selected={c.id === selectedId} onSelect={() => select(c.id)} />
              ))}
            </ul>
            {shown.length === 0 && <p className="cards-empty">{NO_MATCH}</p>}
          </>
        )}
      </section>
      {selected && (
        <CardDetailPanel
          key={selected.id}
          card={selected}
          onClose={() => select(null)}
          onChanged={replace}
          onDeleted={() => {
            select(null);
            remove(selected.id);
          }}
        />
      )}
    </div>
  );
}

interface FilterProps {
  sources: CardSource[];
  /** The source filtered by, or null for 全部. */
  value: string | null;
  onChange(key: string | null): void;
}

/** 全部 and one chip per Book Cards came from. */
function SourceFilter({ sources, value, onChange }: FilterProps) {
  return (
    <div className="cards-filter" role="group" aria-label="按书筛选">
      <button type="button" className="filter-chip" aria-pressed={value === null} onClick={() => onChange(null)}>
        全部
      </button>
      {sources.map((s) => (
        <button key={s.key} type="button" className="filter-chip book-chip" aria-pressed={value === s.key} onClick={() => onChange(s.key)}>
          {s.label}
        </button>
      ))}
    </div>
  );
}

/** One row: Target, meaning, source and next Review (F14). */
function CardItem({ card, selected, onSelect }: { card: CardListItem; selected: boolean; onSelect(): void }) {
  const due = dueShort(card.due);
  return (
    <li>
      <button type="button" className="card-item" aria-pressed={selected} onClick={onSelect}>
        <span className="card-item-text">
          <span className="card-item-target">{card.targetText}</span>
          <span className="card-item-sub">
            <span className="card-item-meaning">{cardMeaning(card) || BACK_MISSING}</span>
            <span className="card-item-dot" aria-hidden="true">
              ·
            </span>
            <span className="card-item-source">{sourceLabel(card)}</span>
          </span>
        </span>
        <span className={due === "今天" ? "card-item-due is-today" : "card-item-due"}>{due}</span>
      </button>
    </li>
  );
}
