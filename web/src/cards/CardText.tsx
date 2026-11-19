import { Fragment } from "react";
import type { Card } from "../api";
import { textRuns } from "./cards";
import "./cards.css";

/**
 * A Sentence's text with each Card's Target underlined in solid green (PRD 4.4.5 有 Card). Renders exactly the text,
 * so character offsets in the DOM are offsets in the Sentence. An underlined run says which Cards it belongs to in
 * `data-card-ids`, for hitCardIds.
 */
export function CardText({ text, cards }: { text: string; cards: readonly Card[] }) {
  if (cards.length === 0) return <>{text}</>;
  return (
    <>
      {textRuns(text, cards).map((run) =>
        run.cardIds.length > 0 ? (
          <span key={run.start} className="card-target" data-card-ids={run.cardIds.join(" ")}>
            {run.text}
          </span>
        ) : (
          <Fragment key={run.start}>{run.text}</Fragment>
        ),
      )}
    </>
  );
}

/** The ids of the Cards whose underline a click landed on, or null off any underline. */
export function hitCardIds(target: Element): string[] | null {
  return target.closest<HTMLElement>("[data-card-ids]")?.dataset.cardIds?.split(" ") ?? null;
}
