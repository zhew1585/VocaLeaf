import { useEffect, useState } from "react";
import { CARDS_CHANGED_EVENT, getReviewCount } from "../api";

/** How many Cards today's Review queue holds, for the navigation's 复习 badge; null until known. */
export function useReviewCount(): number | null {
  const [count, setCount] = useState<number | null>(null);
  const [reloads, setReloads] = useState(0);
  useEffect(() => {
    let active = true;
    getReviewCount().then(
      (r) => active && setCount(typeof r?.count === "number" ? r.count : null),
      (err: unknown) => console.warn("loading the Review count failed", err),
    );
    return () => {
      active = false;
    };
  }, [reloads]);
  useEffect(() => {
    const reload = () => setReloads((n) => n + 1);
    window.addEventListener(CARDS_CHANGED_EVENT, reload);
    return () => window.removeEventListener(CARDS_CHANGED_EVENT, reload);
  }, []);
  return count;
}
