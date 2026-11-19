// Scheduling Cards with FSRS (ts-fsrs, PRD 4.5.3): a Card row's columns are its ts-fsrs Card, and each rating in
// Review moves them on. Fuzz stays off, so the interval a rating button shows is the one the rating gives
// (AC-REV-03).
import { fsrs, generatorParameters, type Card as FsrsCard, type Grade, type State } from "ts-fsrs";
import { CARD_STATES, TARGET_RETENTION, type Rating } from "../contract.js";
import type { cards } from "../db/schema.js";

type CardRow = typeof cards.$inferSelect;

/** The FSRS columns of a Card row. */
export type Schedule = Pick<
  CardRow,
  "due" | "state" | "stability" | "difficulty" | "scheduledDays" | "learningSteps" | "reps" | "lapses" | "lastReviewedAt" | "firstReviewedAt"
>;

const scheduler = fsrs(generatorParameters({ request_retention: TARGET_RETENTION, enable_fuzz: false }));

/** The Card as ts-fsrs sees it. CARD_STATES are in the order of ts-fsrs' State. */
function fsrsCard(s: Schedule): FsrsCard {
  return {
    due: s.due,
    stability: s.stability,
    difficulty: s.difficulty,
    // Deprecated in ts-fsrs 5 and only copied into its review log; the scheduler counts from last_review.
    elapsed_days: 0,
    scheduled_days: s.scheduledDays,
    learning_steps: s.learningSteps,
    reps: s.reps,
    lapses: s.lapses,
    state: CARD_STATES.indexOf(s.state) as State,
    last_review: s.lastReviewedAt ?? undefined,
  };
}

/** Milliseconds from `now` to the Card's next due date for each rating 1 to 4 (the buttons' 下次间隔). */
export function nextIntervals(s: Schedule, now: Date): number[] {
  const preview = scheduler.repeat(fsrsCard(s), now);
  return ([1, 2, 3, 4] as Grade[]).map((grade) => preview[grade].card.due.getTime() - now.getTime());
}

/** The Card's FSRS columns after it was rated `rating` at `now`. */
export function rateSchedule(s: Schedule, rating: Rating, now: Date): Schedule {
  const { card } = scheduler.next(fsrsCard(s), now, rating as Grade);
  return {
    due: card.due,
    state: CARD_STATES[card.state],
    stability: card.stability,
    difficulty: card.difficulty,
    scheduledDays: card.scheduled_days,
    learningSteps: card.learning_steps,
    reps: card.reps,
    lapses: card.lapses,
    lastReviewedAt: now,
    firstReviewedAt: s.firstReviewedAt ?? now,
  };
}
