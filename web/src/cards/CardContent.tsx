// What a Card shows wherever it is opened (the 卡片浮窗, F16, and the Card list's detail, F14): its Sentence with the
// Target highlighted, its back, 【卡片原声】 and generating the back again.
import { useState, type ReactNode } from "react";
import { regenerateCardBack, type Card, type CardBack } from "../api";
import { Volume2Icon } from "../icons";
import type { AuditionState } from "../player/audition";
import "./cards.css";

/** The Sentence with the Target highlighted. */
export function HighlightedSentence({ card }: { card: Card }) {
  const text = card.sentenceText;
  return (
    <p className="card-sentence">
      {text.slice(0, card.targetStart)}
      <mark className="card-highlight">{text.slice(card.targetStart, card.targetEnd)}</mark>
      {text.slice(card.targetEnd)}
    </p>
  );
}

interface AudioButtonProps {
  card: Card;
  /** The 试听 going on, whichever it is. */
  state: AuditionState | null;
  onPlay(): void;
  className: string;
}

/** 【卡片原声】: plays the Card's own audio (PRD 4.4.1 试听), a thin ring while it loads; off without audio. */
export function CardAudioButton({ card, state, onPlay, className }: AudioButtonProps) {
  const loading = state?.id === card.id && state.loading;
  return (
    <button
      type="button"
      className={className}
      aria-label="卡片原声"
      title={card.hasAudio ? "卡片原声" : "这张卡片没有原声"}
      disabled={!card.hasAudio}
      aria-busy={loading}
      onClick={onPlay}
    >
      {loading ? <span className="panel-action-ring" aria-hidden="true" /> : <Volume2Icon />}
    </button>
  );
}

/** A part of the back under its label (用法, 例句, …) when `label` is given, as the Card list's detail shows it. */
function BackPart({ label, children }: { label?: string; children: ReactNode }) {
  if (!label) return <>{children}</>;
  return (
    <section className="card-back-part">
      <h3>{label}</h3>
      {children}
    </section>
  );
}

function BackList({ items, label }: { items: string[]; label: string }) {
  return (
    <ul className="card-notes" aria-label={label}>
      {items.map((x) => (
        <li key={x}>{x}</li>
      ))}
    </ul>
  );
}

/** The back by the Card's kind (PRD 4.5.2 背面内容); `labelled` names each part below the meaning (design 07). */
export function CardBackView({ back, labelled = false }: { back: CardBack; labelled?: boolean }) {
  const label = (text: string) => (labelled ? text : undefined);
  switch (back.kind) {
    case "word":
      return (
        <div className="card-back">
          {(back.phonetic || back.partOfSpeech) && (
            <p className="card-phonetic">{[back.phonetic, back.partOfSpeech].filter(Boolean).join(" · ")}</p>
          )}
          <p className="card-meaning">{back.meaning}</p>
          {back.collocations.length > 0 && (
            <BackPart label={label("常见搭配")}>
              <BackList items={back.collocations} label="常见搭配" />
            </BackPart>
          )}
        </div>
      );
    case "phrase":
      return (
        <div className="card-back">
          <p className="card-meaning">{back.meaning}</p>
          {back.usage && (
            <BackPart label={label("用法")}>
              <p className="card-usage">{back.usage}</p>
            </BackPart>
          )}
          {back.example && (
            <BackPart label={label("例句")}>
              <p className="card-example">{back.example}</p>
            </BackPart>
          )}
        </div>
      );
    case "sentence":
      return (
        <div className="card-back">
          <p className="card-meaning">{back.translation}</p>
          {back.grammar.length > 0 && (
            <BackPart label={label("语法要点")}>
              <BackList items={back.grammar} label="语法要点" />
            </BackPart>
          )}
        </div>
      );
  }
}

/**
 * Generating a Card's back again (【释义生成失败，点击重试】, 【重新生成】): not counted against the AI limit, its next
 * Review unchanged (PRD 4.5.2). `failed` holds from a failure until the next try.
 */
export function useRegenerateBack(cardId: string, onChanged: (card: Card) => void) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const regenerate = async () => {
    setBusy(true);
    setFailed(false);
    try {
      onChanged(await regenerateCardBack(cardId));
    } catch (err) {
      console.warn("generating the Card's back again failed", err);
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  return { busy, failed, regenerate };
}
