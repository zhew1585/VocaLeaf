// 卡片浮窗 (F16, design 01 ⑥): a quick read-only look at the Cards a click hit, in the right-hand area in place of
// 句子精读. One Card shows its detail; several show a list first, each row opening its detail in place, with
// 【返回列表】 back to the list where it was scrolled. Closing (X, a click outside, Esc from the page) is the page's.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { regenerateCardBack, type Card } from "../api";
import { ArrowLeftIcon, BookOpenIcon, ChevronRightIcon, Volume2Icon, XIcon } from "../icons";
import type { AuditionState } from "../player/audition";
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
    setOpenId(id);
  };

  return (
    <aside ref={box} className="card-popover" aria-label="卡片浮窗">
      <header className="card-popover-header">
        {open && !single ? (
          <button type="button" className="card-popover-back" onClick={() => setOpenId(null)}>
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
        <CardDetail card={open} audio={audio} onStudySentence={onStudySentence} onCardChanged={onCardChanged} />
      ) : (
        <CardList cards={cards} onOpen={openCard} onStudySentence={onStudySentence} />
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
function CardList({ cards, onOpen, onStudySentence }: { cards: Card[]; onOpen(id: string): void; onStudySentence(): void }) {
  return (
    <div className="card-list">
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

/** The Sentence with the Target highlighted. */
function HighlightedSentence({ card }: { card: Card }) {
  const text = card.sentenceText;
  return (
    <p className="card-sentence">
      {text.slice(0, card.targetStart)}
      <mark className="card-highlight">{text.slice(card.targetStart, card.targetEnd)}</mark>
      {text.slice(card.targetEnd)}
    </p>
  );
}

interface DetailProps {
  card: Card;
  audio: CardAudio;
  onStudySentence(): void;
  onCardChanged(card: Card): void;
}

/** One Card (F16 单卡): kind and next Review, the Sentence, the Target and its back, 卡片原声 and 精读原句. */
function CardDetail({ card, audio, onStudySentence, onCardChanged }: DetailProps) {
  const playing = audio.state?.id === card.id ? audio.state : null;
  return (
    <div className="card-detail">
      <p className="card-meta">
        {KIND_LABELS[card.targetKind]} · {dueLabel(card.due)}
      </p>
      <HighlightedSentence card={card} />
      <hr className="card-divider" />
      {card.targetKind !== "sentence" && <p className="card-target-text">{card.targetText}</p>}
      {card.back ? <CardBackView card={card} /> : <RetryBack card={card} onCardChanged={onCardChanged} />}
      {playing?.failed && (
        <p className="card-audio-error" role="alert">
          音频加载失败
        </p>
      )}
      <div className="card-actions">
        <button
          type="button"
          className="card-round"
          aria-label="卡片原声"
          title={card.hasAudio ? "卡片原声" : "这张卡片没有原声"}
          disabled={!card.hasAudio}
          aria-busy={playing?.loading ?? false}
          onClick={() => audio.play(card)}
        >
          {playing?.loading ? <span className="panel-action-ring" aria-hidden="true" /> : <Volume2Icon />}
        </button>
        <StudySentenceButton onClick={onStudySentence} />
      </div>
    </div>
  );
}

/** The back by the Card's kind (PRD 4.5.2 背面内容). */
function CardBackView({ card }: { card: Card }) {
  const back = card.back!;
  switch (back.kind) {
    case "word":
      return (
        <div className="card-back">
          {(back.phonetic || back.partOfSpeech) && (
            <p className="card-phonetic">{[back.phonetic, back.partOfSpeech].filter(Boolean).join(" · ")}</p>
          )}
          <p className="card-meaning">{back.meaning}</p>
          {back.collocations.length > 0 && (
            <ul className="card-notes" aria-label="常见搭配">
              {back.collocations.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          )}
        </div>
      );
    case "phrase":
      return (
        <div className="card-back">
          <p className="card-meaning">{back.meaning}</p>
          {back.usage && <p className="card-usage">{back.usage}</p>}
          {back.example && <p className="card-example">{back.example}</p>}
        </div>
      );
    case "sentence":
      return (
        <div className="card-back">
          <p className="card-meaning">{back.translation}</p>
          {back.grammar.length > 0 && (
            <ul className="card-notes" aria-label="语法要点">
              {back.grammar.map((g) => (
                <li key={g}>{g}</li>
              ))}
            </ul>
          )}
        </div>
      );
  }
}

/** 【释义生成失败，点击重试】 (PRD 4.5.2 规则 6): generates the back again, not counted against the AI limit. */
export function RetryBack({ card, onCardChanged }: { card: Card; onCardChanged(card: Card): void }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const retry = async () => {
    setBusy(true);
    setFailed(false);
    try {
      onCardChanged(await regenerateCardBack(card.id));
    } catch (err) {
      console.warn("generating the Card's back again failed", err);
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button type="button" className="card-retry" disabled={busy} onClick={() => void retry()}>
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
