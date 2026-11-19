// 卡片浮窗 (F16, design 01 ⑥): a quick read-only look at the Cards a click hit, in the right-hand area in place of
// 句子精读. One Card shows its detail; several show a list first, each row opening its detail in place, with
// 【返回列表】 back to the list where it was scrolled. Closing (X, a click outside, Esc from the page) is the page's.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Card } from "../api";
import { ArrowLeftIcon, BookOpenIcon, ChevronRightIcon, XIcon } from "../icons";
import type { AuditionState } from "../player/audition";
import { CardAudioButton, CardBackView, HighlightedSentence, useRegenerateBack } from "./CardContent";
import { BACK_MISSING, CARD_BACK_FAILED, cardMeaning, dueLabel, dueShort, KIND_LABELS } from "./cards";
import "./cards.css";

/** 【卡片原声】 of the Cards in the popover (PRD 4.4.1 试听). */
export interface CardAudio {
  state: AuditionState | null;
  play(card: Card): void;
}

interface Props {
  /** The Cards the click hit, in reading order; never empty. */
  cards: Card[];
  onClose(): void;
  /** 【精读原句】: closes the popover and opens 句子精读 on the Cards' Sentence, without asking the AI (AC-POP-03). */
  onStudySentence(): void;
  /** A Card's back was generated again. */
  onCardChanged(card: Card): void;
  audio: CardAudio;
}

export function CardPopover({ cards, onClose, onStudySentence, onCardChanged, audio }: Props) {
  const box = useRef<HTMLElement>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  // Moved between the list and a Card's detail: the one shown comes in from its side (not on first showing).
  const [moved, setMoved] = useState(false);
  const listScroll = useRef(0);
  const single = cards.length === 1 ? cards[0]! : null;
  const open = single ?? cards.find((c) => c.id === openId) ?? null;

  // A click anywhere outside closes it (F16 关闭); the click then does what it does there.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [onClose]);

  // Back in the list where it was scrolled (F16 返回列表保留滚动位置).
  useLayoutEffect(() => {
    if (open === null && box.current) box.current.scrollTop = listScroll.current;
  }, [open]);

  const openCard = (id: string) => {
    listScroll.current = box.current?.scrollTop ?? 0;
    setMoved(true);
    setOpenId(id);
  };

  return (
    <aside ref={box} className="card-popover" aria-label="卡片浮窗">
      <header className="card-popover-header">
        {open && !single ? (
          <button
            type="button"
            className="card-popover-back"
            onClick={() => {
              setMoved(true);
              setOpenId(null);
            }}
          >
            <ArrowLeftIcon size={16} />
            返回列表
          </button>
        ) : (
          <h2>已有卡片</h2>
        )}
        <button type="button" className="card-popover-close" aria-label="关闭卡片浮窗" title="关闭" onClick={onClose}>
          <XIcon size={16} />
        </button>
      </header>
      {open ? (
        <CardDetail
          card={open}
          moved={moved}
          audio={audio}
          onStudySentence={onStudySentence}
          onCardChanged={onCardChanged}
        />
      ) : (
        <CardList cards={cards} moved={moved} onOpen={openCard} onStudySentence={onStudySentence} />
      )}
    </aside>
  );
}

function StudySentenceButton({ onClick }: { onClick(): void }) {
  return (
    <button type="button" className="card-pill" onClick={onClick}>
      <BookOpenIcon />
      精读原句
    </button>
  );
}

/** 【这里有 N 张卡片】: one row per Card with its Target, meaning and next Review. */
function CardList({
  cards,
  moved,
  onOpen,
  onStudySentence,
}: {
  cards: Card[];
  moved: boolean;
  onOpen(id: string): void;
  onStudySentence(): void;
}) {
  return (
    <div className={moved ? "card-list is-moved" : "card-list"}>
      <p className="card-meta">这里有 {cards.length} 张卡片</p>
      <ul aria-label="卡片列表">
        {cards.map((c) => (
          <li key={c.id}>
            <button type="button" className="card-row" onClick={() => onOpen(c.id)}>
              <span className="card-row-main">
                <span className="card-row-target">{c.targetText}</span>
                <span className="card-row-meaning">{cardMeaning(c) || BACK_MISSING}</span>
              </span>
              <span className="card-row-due">{dueShort(c.due)}</span>
              <ChevronRightIcon size={16} />
            </button>
          </li>
        ))}
      </ul>
      <div className="card-actions">
        <StudySentenceButton onClick={onStudySentence} />
      </div>
    </div>
  );
}

interface DetailProps {
  card: Card;
  /** Opened from the list: it comes in from the right. */
  moved: boolean;
  audio: CardAudio;
  onStudySentence(): void;
  onCardChanged(card: Card): void;
}

/** One Card (F16 单卡): kind and next Review, the Sentence, the Target and its back, 卡片原声 and 精读原句. */
function CardDetail({ card, moved, audio, onStudySentence, onCardChanged }: DetailProps) {
  const playing = audio.state?.id === card.id ? audio.state : null;
  return (
    <div className={moved ? "card-detail is-moved" : "card-detail"}>
      <p className="card-meta">
        {KIND_LABELS[card.targetKind]} · {dueLabel(card.due)}
      </p>
      <HighlightedSentence card={card} />
      <hr className="card-divider" />
      {card.targetKind !== "sentence" && <p className="card-target-text">{card.targetText}</p>}
      {card.back ? <CardBackView back={card.back} /> : <RetryBack card={card} onCardChanged={onCardChanged} />}
      {playing?.failed && (
        <p className="card-audio-error" role="alert">
          音频加载失败
        </p>
      )}
      <div className="card-actions">
        <CardAudioButton card={card} state={audio.state} className="card-round" onPlay={() => audio.play(card)} />
        <StudySentenceButton onClick={onStudySentence} />
      </div>
    </div>
  );
}

/** 【释义生成失败，点击重试】 (PRD 4.5.2 规则 6): generates the back again, not counted against the AI limit. */
export function RetryBack({ card, onCardChanged }: { card: Card; onCardChanged(card: Card): void }) {
  const { busy, failed, regenerate } = useRegenerateBack(card.id, onCardChanged);
  return (
    <>
      <button type="button" className="card-retry" disabled={busy} onClick={() => void regenerate()}>
        {busy ? "正在生成释义…" : CARD_BACK_FAILED}
      </button>
      {failed && (
        <p className="card-audio-error" role="alert">
          还是没有生成，请稍后再试
        </p>
      )}
    </>
  );
}
