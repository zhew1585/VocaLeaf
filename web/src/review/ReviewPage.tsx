// 复习页 (PRD 4.5.3, F13, design 06): works through today's queue one Card at a time (useReview), with Space and
// 1 to 4 as keys, and 【今日复习完成】 once the queue is empty.
import { LeafIcon, XIcon } from "../icons";
import { useReviewShortcuts } from "../player/shortcuts";
import { followLink } from "../router";
import { progressOf } from "./review";
import { ReviewBack, ReviewFront } from "./ReviewCard";
import { useReview } from "./useReview";
import "./review.css";

export function ReviewPage() {
  const { load, seen, item, revealed, reveal, rating, rate, error, audio, replace, reload } = useReview();

  useReviewShortcuts(item === null ? null : revealed ? { rate: (r) => void rate(r) } : { reveal });

  if (load.state === "loading") return <div className="review" aria-busy="true" />;
  if (load.state === "failed") {
    return (
      <div className="review">
        <div className="review-column">
          <p className="form-error" role="alert">
            {load.message}
          </p>
          <button type="button" className="review-reveal" onClick={reload}>
            重试
          </button>
        </div>
      </div>
    );
  }
  if (!item) return <ReviewDone count={load.queue.reviewedToday} />;

  return (
    <div className="review">
      <div className="review-column">
        <ProgressBar {...progressOf(seen, load.queue.cards)} />
        {revealed ? (
          <ReviewBack item={item} audio={audio} rating={rating} onRate={(r) => void rate(r)} onCardChanged={replace} />
        ) : (
          <ReviewFront card={item.card} audio={audio} onReveal={reveal} />
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

/** 退出 (back to the 书架) and how far this visit's queue is. */
function ProgressBar({ done, total }: { done: number; total: number }) {
  return (
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
  );
}

/**
 * The queue is empty (design 06-3): 【今日复习完成】 and how many Cards were rated today (AC-REV-06), also when coming
 * back after finishing; before any is rated today, that there is nothing to review.
 */
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
