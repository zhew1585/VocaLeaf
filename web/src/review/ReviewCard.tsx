// One Card in Review (PRD 4.5.3 单张流程, design 06-1 and 06-2): the front with its audio and the Target blanked
// out (a whole-Sentence Card only plays), then the back with the whole Sentence, the back and the source, and the
// four ratings with their next intervals.
import type { ReactNode } from "react";
import type { Card, Rating, ReviewItem } from "../api";
import { RetryBack } from "../cards/CardPopover";
import { AudioLinesIcon, BookOpenIcon, Volume2Icon } from "../icons";
import { intervalLabel, RATINGS } from "./review";

/** The Card's 卡片原声 as the page plays it. */
export interface ReviewAudio {
  /** Playing or loading. */
  playing: boolean;
  /** 【音频加载失败】. */
  failed: boolean;
  play(): void;
}

function KeyHint({ children }: { children: string }) {
  return (
    <kbd className="review-key" aria-hidden="true">
      {children}
    </kbd>
  );
}

function AudioError({ card, audio }: { card: Card; audio: ReviewAudio }) {
  if (!card.hasAudio) return <p className="review-audio-note">这张卡片没有原声</p>;
  if (!audio.failed) return null;
  return (
    <p className="review-audio-note is-error" role="alert">
      音频加载失败
    </p>
  );
}

/** The front: the audio, and the Sentence with the Target as a blank; a whole-Sentence Card shows no text. */
export function ReviewFront({ card, audio, onReveal }: { card: Card; audio: ReviewAudio; onReveal(): void }) {
  const text = card.sentenceText;
  // Without its audio a whole-Sentence Card has nothing to recall from but its text.
  const showText = card.targetKind !== "sentence" || !card.hasAudio;
  return (
    <>
      <div className="review-card is-front">
        <span className={`review-halo${audio.playing ? " is-playing" : ""}`}>
          <button type="button" className="review-play" aria-label="播放原声" disabled={!card.hasAudio} onClick={audio.play}>
            <AudioLinesIcon size={30} />
          </button>
        </span>
        <AudioError card={card} audio={audio} />
        {showText &&
          (card.targetKind === "sentence" ? (
            <p className="review-cloze">{text}</p>
          ) : (
            <p className="review-cloze">
              {text.slice(0, card.targetStart)}
              <span className="review-blank" role="img" aria-label="空缺" style={{ width: `${card.targetEnd - card.targetStart + 1}ch` }} />
              {text.slice(card.targetEnd)}
            </p>
          ))}
      </div>
      <button type="button" className="review-reveal" onClick={onReveal}>
        显示答案
        <KeyHint>空格</KeyHint>
      </button>
    </>
  );
}

interface BackProps {
  item: ReviewItem;
  audio: ReviewAudio;
  /** A rating is on its way: the buttons wait. */
  rating: boolean;
  onRate(rating: Rating): void;
  onCardChanged(card: Card): void;
}

/** The back: the source and the Sentence with the Target highlighted, the back, and the ratings. */
export function ReviewBack({ item, audio, rating, onRate, onCardChanged }: BackProps) {
  const { card, intervalsMs } = item;
  const text = card.sentenceText;
  return (
    <>
      <div className="review-card is-back">
        <div className="review-source-row">
          <span className="review-source">
            <BookOpenIcon size={14} />
            {card.bookTitle}
          </span>
          <button type="button" className="review-replay" aria-label="播放原声" disabled={!card.hasAudio} onClick={audio.play}>
            <Volume2Icon size={20} />
          </button>
        </div>
        <AudioError card={card} audio={audio} />
        <p className="review-sentence">
          {card.targetKind === "sentence" ? (
            text
          ) : (
            <>
              {text.slice(0, card.targetStart)}
              <mark className="review-target">{text.slice(card.targetStart, card.targetEnd)}</mark>
              {text.slice(card.targetEnd)}
            </>
          )}
        </p>
        <hr className="review-divider" />
        {card.back ? <BackContent card={card} /> : <RetryBack card={card} onCardChanged={onCardChanged} />}
      </div>
      <div className="review-ratings" role="group" aria-label="评分">
        {RATINGS.map(({ rating: r, label, tone }) => (
          <button
            key={r}
            type="button"
            className={`review-rate is-${tone}${r === 3 ? " is-primary" : ""}`}
            disabled={rating}
            onClick={() => onRate(r)}
          >
            <span className="review-rate-label">
              <span className="review-rate-name">{label}</span>
              <span className="review-rate-interval">{intervalLabel(intervalsMs[r - 1] ?? 0)}</span>
            </span>
            <KeyHint>{String(r)}</KeyHint>
          </button>
        ))}
      </div>
    </>
  );
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="review-detail">
      <span className="review-detail-label">{label}</span>
      {children}
    </div>
  );
}

function NoteList({ items }: { items: string[] }) {
  return (
    <ul className="review-notes">
      {items.map((x) => (
        <li key={x}>{x}</li>
      ))}
    </ul>
  );
}

/** The back by the Card's kind (PRD 4.5.2 背面内容), laid out as design 06-2. */
function BackContent({ card }: { card: Card }) {
  const back = card.back!;
  if (back.kind === "sentence") {
    return (
      <div className="review-back">
        <p className="review-meaning">{back.translation}</p>
        {back.grammar.length > 0 && (
          <div className="review-details">
            <Detail label="语法要点">
              <NoteList items={back.grammar} />
            </Detail>
          </div>
        )}
      </div>
    );
  }
  const phonetic = back.kind === "word" ? [back.phonetic, back.partOfSpeech].filter(Boolean).join(" · ") : "";
  return (
    <div className="review-back">
      <div className="review-heading">
        <p className="review-target-text">{card.targetText}</p>
        {phonetic && <p className="review-phonetic">{phonetic}</p>}
        <p className="review-meaning">{back.meaning}</p>
      </div>
      {back.kind === "word" && back.collocations.length > 0 && (
        <div className="review-details">
          <Detail label="常见搭配">
            <NoteList items={back.collocations} />
          </Detail>
        </div>
      )}
      {back.kind === "phrase" && (back.usage || back.example) && (
        <div className="review-details">
          {back.usage && (
            <Detail label="用法">
              <p className="review-usage">{back.usage}</p>
            </Detail>
          )}
          {back.example && (
            <Detail label="例句">
              <p className="review-example">{back.example}</p>
            </Detail>
          )}
        </div>
      )}
    </div>
  );
}
