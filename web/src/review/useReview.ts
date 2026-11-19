// The state of one visit to the 复习页 (PRD 4.5.3): today's queue as the API last answered, the Card shown and its
// side, rating it, and its audio. Every rating goes to the API at once, so leaving mid-way loses nothing and the next
// visit goes on with what is left (AC-REV-05).
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiRequestError, cardAudioUrl, getReviewQueue, rateCard, type Card, type Rating, type ReviewQueue } from "../api";
import { useListening } from "../player/session";
import type { ReviewAudio } from "./ReviewCard";

type Load = { state: "loading" } | { state: "failed"; message: string } | { state: "ready"; queue: ReviewQueue };

const messageOf = (err: unknown, fallback: string) => (err instanceof ApiRequestError ? err.message : fallback);

/** Today's queue, loaded on entering and replaced by the one each rating answers with; every Card seen in it. */
function useQueue() {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [seen, setSeen] = useState<ReadonlySet<string>>(new Set());
  const [loads, setLoads] = useState(0);

  const take = useCallback((queue: ReviewQueue) => {
    setLoad({ state: "ready", queue });
    setSeen((prev) => new Set([...prev, ...queue.cards.map((i) => i.card.id)]));
  }, []);

  useEffect(() => {
    let active = true;
    setLoad({ state: "loading" });
    getReviewQueue().then(
      (queue) => active && take(queue),
      (err: unknown) => active && setLoad({ state: "failed", message: messageOf(err, "加载失败，请稍后再试") }),
    );
    return () => {
      active = false;
    };
  }, [loads, take]);

  /** A Card's back was generated again. */
  const replace = (card: Card) =>
    setLoad((prev) => {
      if (prev.state !== "ready") return prev;
      const cards = prev.queue.cards.map((i) => (i.card.id === card.id ? { ...i, card } : i));
      return { ...prev, queue: { ...prev.queue, cards } };
    });
  return { load, seen, take, replace, reload: () => setLoads((n) => n + 1) };
}

/**
 * Entering pauses the main playback, which nothing here plays on again (AC-REV-07, PRD 4.4.1 规则 7); each front plays
 * its Card's audio on the session's 试听 element, never the main one; leaving stops it.
 */
function useCardAudio(card: Card | null, front: number): ReviewAudio {
  const listening = useListening();
  const latest = useRef(listening);
  latest.current = listening;

  useEffect(() => {
    latest.current.pause();
    return () => latest.current.stopAudition();
  }, []);

  const play = useCallback(() => {
    if (card?.hasAudio) latest.current.startAudition({ id: card.id, src: cardAudioUrl(card.id), keepsMainPaused: true });
  }, [card?.id, card?.hasAudio]);

  // Once per front shown, also of a Card shown again (a learning step); a browser that wants a tap waits for one.
  // With the queue done, the last Card's audio stops.
  useEffect(() => (card ? play() : latest.current.stopAudition()), [front, card?.id]);

  const state = card !== null && listening.audition?.id === card.id ? listening.audition : null;
  return { playing: state !== null && !state.failed, failed: state?.failed ?? false, play };
}

export function useReview() {
  const { load, seen, take, replace, reload } = useQueue();
  const [revealed, setRevealed] = useState(false);
  const [rating, setRating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Counts the fronts shown, so a Card shown again plays again.
  const [front, setFront] = useState(0);
  const item = load.state === "ready" ? (load.queue.cards[0] ?? null) : null;
  const audio = useCardAudio(item?.card ?? null, front);

  const nextFront = () => {
    setRevealed(false);
    setFront((n) => n + 1);
  };

  const rate = async (r: Rating) => {
    if (!item || rating) return;
    setRating(true);
    setError(null);
    try {
      take(await rateCard(item.card.id, r));
      nextFront();
    } catch (err) {
      // Deleted meanwhile (#17, another device): it simply leaves the queue.
      if (err instanceof ApiRequestError && err.status === 404) {
        nextFront();
        reload();
      } else setError(messageOf(err, "评分失败，请稍后再试"));
    } finally {
      setRating(false);
    }
  };

  return { load, seen, item, revealed, reveal: () => setRevealed(true), rating, rate, error, audio, replace, reload };
}
