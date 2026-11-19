import { useState, type ReactNode } from "react";
import { cardAudioUrl, regenerateCardBack, type Card, type CardListItem } from "../api";
import { BookOpenIcon, RotateCwIcon, TrashIcon, Volume2Icon, XIcon } from "../icons";
import { useListening } from "../player/session";
import { HighlightedSentence } from "./CardPopover";
import { sourceDetail } from "./cardList";
import { CARD_BACK_FAILED, dueLabel, KIND_LABELS } from "./cards";
import { ConfirmDeleteCard } from "./ConfirmDeleteCard";

interface Props {
  card: CardListItem;
  onClose(): void;
  /** Its back was generated again. */
  onChanged(card: Card): void;
  /** It was deleted. */
  onDeleted(): void;
}

/**
 * A Card's detail in the Card list (design 07): kind and next Review, the Sentence with the Target and its source,
 * 卡片原声, the back, 【重新生成】 (its next Review and the AI allowance unchanged, AC-CLIST-04) and 删除 after a
 * confirmation.
 */
export function CardDetailPanel({ card, onClose, onChanged, onDeleted }: Props) {
  const listening = useListening();
  const playing = listening.audition?.id === card.id ? listening.audition : null;
  const [regenerating, setRegenerating] = useState(false);
  const [failed, setFailed] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const due = dueLabel(card.due);

  const regenerate = async () => {
    setRegenerating(true);
    setFailed(false);
    try {
      onChanged(await regenerateCardBack(card.id));
    } catch (err) {
      console.warn("generating the Card's back again failed", err);
      setFailed(true);
    } finally {
      setRegenerating(false);
    }
  };

  return (
    <aside className="card-panel" aria-label="卡片详情">
      <header className="card-panel-header">
        <span className="card-panel-kind">{KIND_LABELS[card.targetKind]}</span>
        <span className={due === "今天复习" ? "card-panel-due is-today" : "card-panel-due"}>{due}</span>
        <button type="button" className="card-panel-close" aria-label="关闭卡片详情" title="关闭" onClick={onClose}>
          <XIcon size={20} />
        </button>
      </header>
      <div className="card-panel-sentence">
        <div className="card-panel-audio-row">
          <span className="card-panel-source">
            <BookOpenIcon size={13} />
            {sourceDetail(card)}
          </span>
          <button
            type="button"
            className="card-panel-audio"
            aria-label="卡片原声"
            title={card.hasAudio ? "卡片原声" : "这张卡片没有原声"}
            disabled={!card.hasAudio}
            aria-busy={playing?.loading ?? false}
            onClick={() => listening.startAudition({ id: card.id, src: cardAudioUrl(card.id) })}
          >
            {playing?.loading ? <span className="panel-action-ring" aria-hidden="true" /> : <Volume2Icon />}
          </button>
        </div>
        <HighlightedSentence card={card} />
        {playing?.failed && (
          <p className="card-panel-error" role="alert">
            音频加载失败
          </p>
        )}
      </div>
      <hr className="card-panel-divider" />
      <div className="card-panel-back">
        {card.targetKind !== "sentence" && <p className="card-panel-target">{card.targetText}</p>}
        {card.back ? (
          <BackView back={card.back} />
        ) : (
          <button type="button" className="card-retry" disabled={regenerating} onClick={() => void regenerate()}>
            {regenerating ? "正在生成释义…" : CARD_BACK_FAILED}
          </button>
        )}
      </div>
      {failed && (
        <p className="card-panel-error" role="alert">
          重新生成失败，请稍后再试
        </p>
      )}
      <footer className="card-panel-actions">
        <button type="button" className="card-panel-action" disabled={regenerating} onClick={() => void regenerate()}>
          <RotateCwIcon size={16} />
          {regenerating ? "正在生成…" : "重新生成"}
        </button>
        <button type="button" className="card-panel-action is-danger" onClick={() => setDeleting(true)}>
          <TrashIcon size={16} />
          删除
        </button>
      </footer>
      {deleting && <ConfirmDeleteCard cardId={card.id} onCancel={() => setDeleting(false)} onDeleted={onDeleted} />}
    </aside>
  );
}

/** A labelled part of the back (用法, 例句, …). */
function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="card-panel-section">
      <h3>{label}</h3>
      {children}
    </section>
  );
}

function Notes({ items }: { items: string[] }) {
  return (
    <ul className="card-panel-notes">
      {items.map((x) => (
        <li key={x}>{x}</li>
      ))}
    </ul>
  );
}

/** The back by the Card's kind (PRD 4.5.2 背面内容). */
function BackView({ back }: { back: NonNullable<Card["back"]> }) {
  switch (back.kind) {
    case "word":
      return (
        <>
          {(back.phonetic || back.partOfSpeech) && (
            <p className="card-panel-phonetic">{[back.phonetic, back.partOfSpeech].filter(Boolean).join(" · ")}</p>
          )}
          <p className="card-panel-meaning">{back.meaning}</p>
          {back.collocations.length > 0 && (
            <Section label="常见搭配">
              <Notes items={back.collocations} />
            </Section>
          )}
        </>
      );
    case "phrase":
      return (
        <>
          <p className="card-panel-meaning">{back.meaning}</p>
          {back.usage && (
            <Section label="用法">
              <p className="card-panel-usage">{back.usage}</p>
            </Section>
          )}
          {back.example && (
            <Section label="例句">
              <p className="card-panel-example">{back.example}</p>
            </Section>
          )}
        </>
      );
    case "sentence":
      return (
        <>
          <p className="card-panel-meaning">{back.translation}</p>
          {back.grammar.length > 0 && (
            <Section label="语法要点">
              <Notes items={back.grammar} />
            </Section>
          )}
        </>
      );
  }
}
