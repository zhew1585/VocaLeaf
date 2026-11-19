import { useState } from "react";
import { cardAudioUrl, deleteCard, type Card, type CardListItem } from "../api";
import { ConfirmDialog } from "../ConfirmDialog";
import { BookOpenIcon, RotateCwIcon, TrashIcon, XIcon } from "../icons";
import { usePresence } from "../motion";
import { useListening } from "../player/session";
import { CardAudioButton, CardBackView, HighlightedSentence, useRegenerateBack } from "./CardContent";
import { sourceDetail } from "./cardList";
import { CARD_BACK_FAILED, dueLabel, isDueToday, KIND_LABELS } from "./cards";

interface Props {
  card: CardListItem;
  /**
   * How it shows: opening beside the list (slides in), taking another Card's place (fades in), or leaving (slides
   * away, usePresence).
   */
  motion?: "open" | "swap" | "exit";
  onClose(): void;
  /** Its back was generated again. */
  onChanged(card: Card): void;
  /** It was deleted. */
  onDeleted(): void;
}

/**
 * A Card's detail in the Card list (design 07): kind and next Review, the Sentence with the Target and its source,
 * 卡片原声, the back, 【重新生成】 (its next Review and the AI allowance unchanged, AC-CLIST-04) and 删除 after a
 * confirmation (PRD 4.5.2 删除).
 */
export function CardDetailPanel({ card, motion = "open", onClose, onChanged, onDeleted }: Props) {
  const { busy, failed, regenerate } = useRegenerateBack(card.id, onChanged);
  const [deleting, setDeleting] = useState(false);
  const confirm = usePresence(deleting);
  return (
    <aside className={`card-panel is-${motion === "exit" ? "exiting" : motion}`} aria-label="卡片详情">
      <header className="card-panel-header">
        <span className="card-panel-kind">{KIND_LABELS[card.targetKind]}</span>
        <span className={isDueToday(card.due) ? "card-panel-due is-today" : "card-panel-due"}>{dueLabel(card.due)}</span>
        <button type="button" className="card-panel-close" aria-label="关闭卡片详情" title="关闭" onClick={onClose}>
          <XIcon size={20} />
        </button>
      </header>
      <SentenceBlock card={card} />
      <hr className="card-panel-divider" />
      <div className="card-panel-back">
        {card.targetKind !== "sentence" && <p className="card-target-text">{card.targetText}</p>}
        {card.back ? (
          <CardBackView back={card.back} labelled />
        ) : (
          <button type="button" className="card-retry" disabled={busy} onClick={() => void regenerate()}>
            {busy ? "正在生成释义…" : CARD_BACK_FAILED}
          </button>
        )}
      </div>
      {failed && (
        <p className="card-panel-error" role="alert">
          重新生成失败，请稍后再试
        </p>
      )}
      <footer className="card-panel-actions">
        <button type="button" className="card-panel-action" disabled={busy} onClick={() => void regenerate()}>
          <RotateCwIcon size={16} />
          {busy ? "正在生成…" : "重新生成"}
        </button>
        <button type="button" className="card-panel-action is-danger" onClick={() => setDeleting(true)}>
          <TrashIcon size={16} />
          删除
        </button>
      </footer>
      {confirm.value && (
        <ConfirmDialog
          title="删除这张卡片？"
          text="删除后不可恢复，复习中也不会再出现"
          confirmLabel="删除"
          run={() => deleteCard(card.id)}
          failure="删除失败，请稍后再试"
          onCancel={() => setDeleting(false)}
          onDone={() => {
            setDeleting(false);
            onDeleted();
          }}
          exiting={confirm.exiting}
        />
      )}
    </aside>
  );
}

/** Where the Card is from, 卡片原声 (the listening session's 试听, PRD 4.4.1) and the Sentence with the Target. */
function SentenceBlock({ card }: { card: CardListItem }) {
  const listening = useListening();
  const failed = listening.audition?.id === card.id && listening.audition.failed;
  return (
    <div className="card-panel-sentence">
      <div className="card-panel-audio-row">
        <span className="card-panel-source">
          <BookOpenIcon size={13} />
          {sourceDetail(card)}
        </span>
        <CardAudioButton
          card={card}
          state={listening.audition}
          className="card-panel-audio"
          onPlay={() => listening.startAudition({ id: card.id, src: cardAudioUrl(card.id) })}
        />
      </div>
      <HighlightedSentence card={card} />
      {failed && (
        <p className="card-panel-error" role="alert">
          音频加载失败
        </p>
      )}
    </div>
  );
}
