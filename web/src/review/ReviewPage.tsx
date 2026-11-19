// 复习页 (PRD 4.5.3, F13, design 06): works through today's queue one Card at a time. Entering pauses the main
// playback, which nothing here plays on again (AC-REV-07); each Card's audio plays as a 卡片原声 on the session's
// 试听 element, never the main one. Every rating goes to the API at once, so leaving mid-way loses nothing and the
// next visit goes on with what is left (AC-REV-05).
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiRequestError, cardAudioUrl, getReviewQueue, rateCard, type Card, type Rating, type ReviewItem } from "../api";
import { LeafIcon, XIcon } from "../icons";
import { useListening } from "../player/session";
import { useReviewShortcuts } from "../player/shortcuts";
import { followLink } from "../router";
import { progressOf } from "./review";
import { ReviewBack, ReviewFront, type ReviewAudio } from "./ReviewCard";
import "./review.css";

type Load = { state: "loading" } | { state: "failed"; message: string } | { state: "ready"; queue: ReviewItem[] };

const messageOf = (err: unknown, fallback: string) => (err instanceof ApiRequestError ? err.message : fallback);

/** Today's queue as this visit works through it, every Card seen in it, and those rated. */
function useQueue() {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [seen, setSeen] = useState<ReadonlySet<string>>(new Set());
  const [rated, setRated] = useState<ReadonlySet<string>>(new Set());
  const [loads, setLoads] = useState(0);

  const take = useCallback((queue: ReviewItem[]) => {
    setLoad({ state: "ready", queue });
    setSeen((prev) => new Set([...prev, ...queue.map((i) => i.card.id)]));
  }, []);

  useEffect(() => {
    let active = true;
    setLoad({ state: "loading" });
    getReviewQueue().then(
      ({ cards }) => active && take(cards),
      (err: unknown) => active && setLoad({ state: "failed", message: messageOf(err, "加载失败，请稍后再试") }),
    );
    return () => {
      active = false;
    };
  }, [loads, take]);

  /** Rates the first Card; the queue the API answers with replaces this one. */
  const rate = async (cardId: string, rating: Rating) => {
    take((await rateCard(cardId, rating)).cards);
    setRated((prev) => new Set([...prev, cardId]));
  };
  /** A Card's back was generated again. */
  const replace = (card: Card) =>
    setLoad((prev) =>
      prev.state === "ready" ? { ...prev, queue: prev.queue.map((i) => (i.card.id === card.id ? { ...i, card } : i)) } : prev,
    );
  return { load, seen, rated, rate, replace, retry: () => setLoads((n) => n + 1) };
}

export function ReviewPage() {
  const listening = useListening();
  const latest = useRef(listening);
  latest.current = listening;
  const { load, seen, rated, rate, replace, retry } = useQueue();
  const [revealed, setRevealed] = useState(false);
  const [rating, setRating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Counts the fronts shown: each one plays its Card's audio once, also a Card shown again (a learning step).
  const [fronts, setFronts] = useState(0);

  // Entering pauses the main playback (AC-REV-07); leaving stops the Card's audio.
  useEffect(() => {
    latest.current.pause();
    return () => latest.current.stopAudition();
  }, []);

  const item = load.state === "ready" ? (load.queue[0] ?? null) : null;
  const card = item?.card ?? null;

  const play = useCallback(() => {
    if (card?.hasAudio) latest.current.startAudition({ id: card.id, src: cardAudioUrl(card.id) });
  }, [card?.id, card?.hasAudio]);

  // The front plays the Card's audio on its own (PRD 4.5.3 正面); a browser that wants a tap first waits for one.
  useEffect(() => {
    if (!revealed) play();
    // Once per front shown.
  }, [fronts, card?.id]);

  const onRate = async (r: Rating) => {
    if (!card || rating) return;
    setRating(true);
    setError(null);
    try {
      await rate(card.id, r);
      listening.stopAudition();
      setRevealed(false);
      setFronts((n) => n + 1);
    } catch (err) {
      // Deleted meanwhile (#17, another device): it simply leaves the queue.
      if (err instanceof ApiRequestError && err.status === 404) {
        setRevealed(false);
        setFronts((n) => n + 1);
        retry();
      } else setError(messageOf(err, "评分失败，请稍后再试"));
    } finally {
      setRating(false);
    }
  };

  useReviewShortcuts(
    card === null
      ? null
      : revealed
        ? { rate: (r) => void onRate(r) }
        : { reveal: () => setRevealed(true) },
  );

  const state = listening.audition?.id === card?.id ? listening.audition : null;
  const audio: ReviewAudio = { playing: state !== null && !state.failed, failed: state?.failed ?? false, play };

  if (load.state === "loading") return <div className="review" aria-busy="true" />;
  if (load.state === "failed") {
    return (
      <div className="review">
        <div className="review-column">
          <p className="form-error" role="alert">
            {load.message}
          </p>
          <button type="button" className="review-reveal" onClick={retry}>
            重试
          </button>
        </div>
      </div>
    );
  }
  if (!item) return <ReviewDone count={rated.size} />;

  const { done, total } = progressOf(seen, load.queue);
  return (
    <div className="review">
      <div className="review-column">
        <div className="review-bar">
          <a href="/" className="review-exit" aria-label="退出复习" title="退出复习" onClick={followLink}>
            <XIcon size={20} />
          </a>
          <div className="review-progress" role="progressbar" aria-label="复习进度" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
            <span style={{ width: `${total === 0 ? 0 : (done / total) * 100}%` }} />
          </div>
          <span className="review-count">
            {done} / {total}
          </span>
        </div>
        {revealed ? (
          <ReviewBack item={item} audio={audio} rating={rating} onRate={(r) => void onRate(r)} onCardChanged={replace} />
        ) : (
          <ReviewFront card={item.card} audio={audio} onReveal={() => setRevealed(true)} />
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

/** The queue is empty (design 06-3): 【今日复习完成】 and how many Cards this visit rated (AC-REV-06). */
function ReviewDone({ count }: { count: number }) {
  return (
    <div className="review review-done">
      <span className="review-done-mark" aria-hidden="true">
        <span>
          <LeafIcon size={52} />
        </span>
      </span>
      {count > 0 ? (
        <>
          <h1>今日复习完成</h1>
          <p className="review-done-count">
            <strong>{count}</strong> 张
          </p>
        </>
      ) : (
        <>
          <h1>今天没有要复习的卡片</h1>
          <p className="review-done-hint">在专注页或拾起里制作卡片，它们会出现在这里</p>
        </>
      )}
    </div>
  );
}
