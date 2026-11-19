import { useCallback, useState } from "react";
import { cardAudioUrl, type Card, type MadeCard } from "../api";
import { announceCardMade } from "../marks/marks";
import { useListening } from "../player/session";
import type { CardAudio } from "./CardPopover";
import type { CardsInBook } from "./useBookCards";

/** The 卡片浮窗 shown: its Cards, and what the page needs to know about where it was opened (`anchor`). */
export interface OpenPopover<A> {
  cards: Card[];
  anchor: A;
}

/**
 * The 卡片浮窗 (F16) of a page that also shows 句子精读: which Cards it shows, closing it (which stops a 卡片原声,
 * PRD 4.4.1 试听 #5), a Card just made (previewed at once, F12) or changed, and 【卡片原声】 through the listening
 * session's 试听.
 */
export function useCardPopover<A>(cards: CardsInBook) {
  const listening = useListening();
  const { stopAudition } = listening;
  const [open, setOpen] = useState<OpenPopover<A> | null>(null);

  const close = useCallback(() => {
    stopAudition();
    setOpen(null);
  }, [stopAudition]);

  const show = useCallback((shown: Card[], anchor: A) => setOpen({ cards: shown, anchor }), []);

  /** 【制作卡片】 got a Card: kept, previewed, and a new one took its Sentence out of Gleanings (PRD 4.5.2 规则 7). */
  const made = ({ card, created }: MadeCard, anchor: A) => {
    cards.put(card);
    if (created && card.sentenceId) announceCardMade(card.sentenceId);
    show([card], anchor);
  };

  /** A Card's back was generated again. */
  const changed = (card: Card) => {
    cards.put(card);
    setOpen((p) => p && { ...p, cards: p.cards.map((c) => (c.id === card.id ? card : c)) });
  };

  const audio: CardAudio = {
    state: listening.audition,
    play: (card) => listening.startAudition({ id: card.id, src: cardAudioUrl(card.id) }),
  };

  return { open, show, close, made, changed, audio };
}
