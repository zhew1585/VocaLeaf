import { useCallback, useRef, useState } from "react";
import { getSentences, type ChapterSummary, type Sentence } from "../api";

/** No Chapter is fetched again sooner than this, whether the last try failed or its times were behind. */
const RETRY_MS = 3000;

interface Fetch {
  /** The Chapter's audio_status when fetched: once it changes, the Sentence times may have too. */
  audioStatus: ChapterSummary["audioStatus"];
  at: number;
  ok: boolean;
}

/**
 * Sentences of a Book's Chapters, fetched one Chapter at a time as the reading view needs them (F9: long Books
 * render by Chapter). `load` fetches a Chapter unless it has it as of the Chapter's audio_status; `refresh`
 * fetches it again for times written since (a Chapter that was generating when fetched). Neither fetches one
 * Chapter more often than every few seconds.
 */
export function useSentences() {
  const [byChapter, setByChapter] = useState<ReadonlyMap<string, Sentence[]>>(new Map());
  const fetches = useRef(new Map<string, Fetch>());
  const inFlight = useRef(new Set<string>());

  const fetchChapter = useCallback((chapter: ChapterSummary, force: boolean) => {
    const last = fetches.current.get(chapter.id);
    if (inFlight.current.has(chapter.id)) return;
    if (!force && last?.ok && last.audioStatus === chapter.audioStatus) return;
    if (last && Date.now() - last.at < RETRY_MS) return;

    const record = (ok: boolean) => fetches.current.set(chapter.id, { audioStatus: chapter.audioStatus, at: Date.now(), ok });
    inFlight.current.add(chapter.id);
    record(false);
    getSentences(chapter.id)
      .then((sentences) => {
        record(true);
        setByChapter((prev) => new Map(prev).set(chapter.id, sentences));
      })
      .catch(() => record(false))
      .finally(() => inFlight.current.delete(chapter.id));
  }, []);

  const load = useCallback((chapter: ChapterSummary) => fetchChapter(chapter, false), [fetchChapter]);
  const refresh = useCallback((chapter: ChapterSummary) => fetchChapter(chapter, true), [fetchChapter]);

  return { byChapter, load, refresh };
}
