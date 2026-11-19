// Scheduling Cards with FSRS (ts-fsrs, PRD 4.5.3): a Card row's columns are its ts-fsrs Card, and each rating in
// Review moves them on. Fuzz stays off, so the interval a rating button shows is the one the rating gives
// (AC-REV-03).
import { fsrs, generatorParameters, State, type Card as FsrsCard } from "ts-fsrs";
import type { CardRow } from "../cards/cards.js";
import { RATINGS, TARGET_RETENTION, type CardState, type Rating } from "../contract.js";

/** The FSRS columns of a Card row. */
export type Schedule = Pick<
  CardRow,
  "due" | "state" | "stability" | "difficulty" | "scheduledDays" | "learningSteps" | "reps" | "lapses" | "lastReviewedAt" | "firstReviewedAt"
>;

const STATES: Record<CardState, State> = {
  new: State.New,
  learning: State.Learning,
  review: State.Review,
  relearning: State.Relearning,
};
const STATE_NAMES = Object.fromEntries(Object.entries(STATES).map(([name, state]) => [state, name])) as Record<State, CardState>;

const scheduler = fsrs(generatorParameters({ request_retention: TARGET_RETENTION, enable_fuzz: false }));

/** The Card as ts-fsrs sees it. */
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
    state: STATES[s.state],
    last_review: s.lastReviewedAt ?? undefined,
  };
}

/** Milliseconds from `now` to the Card's next due date for each rating 1 to 4 (the buttons' 下次间隔). */
export function nextIntervals(s: Schedule, now: Date): [number, number, number, number] {
  const preview = scheduler.repeat(fsrsCard(s), now);
  const interval = (rating: Rating) => preview[rating].card.due.getTime() - now.getTime();
  return [interval(RATINGS[0]), interval(RATINGS[1]), interval(RATINGS[2]), interval(RATINGS[3])];
}

/** The Card's FSRS columns after it was rated `rating` at `now`. */
export function rateSchedule(s: Schedule, rating: Rating, now: Date): Schedule {
  const { card } = scheduler.next(fsrsCard(s), now, rating);
  return {
    due: card.due,
    state: STATE_NAMES[card.state],
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
