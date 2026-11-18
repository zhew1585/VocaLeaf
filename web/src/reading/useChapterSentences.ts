import { useEffect, useMemo, useRef, useState } from "react";
import { getChapterSentences, type ChapterSummary } from "../api";
import type { ReadingSentence } from "./timeline";

/** A generating Chapter gets times for more Sentences as it renders; its Sentences are loaded again this often. */
const GENERATING_REFRESH_MS = 15_000;
/** A Chapter that failed to load is tried again after this long, while it is still wanted. */
const RETRY_MS = 3_000;

interface Loaded {
  version: string;
  sentences: ReadingSentence[];
}

/** What a Chapter's Sentences depend on: its place in the audio, and for a generating one, the refresh tick. */
function versionOf(chapter: ChapterSummary, tick: number): string {
  const base = `${chapter.audioStatus}:${chapter.startMs ?? "-"}`;
  return chapter.audioStatus === "generating" ? `${base}:${tick}` : base;
}

/**
 * Loads the Sentences of the Chapters the reading view wants (those near the reading position and the one
 * playing), and keeps what it loaded, so scrolling back shows a Chapter at once. Loaded again when a Chapter's
 * audio changes. Returns the Sentences by Chapter ID; a Chapter not loaded yet is missing.
 */
export function useChapterSentences(wanted: ChapterSummary[]): ReadonlyMap<string, ReadingSentence[]> {
  const [loaded, setLoaded] = useState<ReadonlyMap<string, Loaded>>(new Map());
  const [tick, setTick] = useState(0);
  const inFlight = useRef(new Set<string>());

  const generating = wanted.some((c) => c.audioStatus === "generating");
  useEffect(() => {
    if (!generating) return;
    const timer = setInterval(() => setTick((n) => n + 1), GENERATING_REFRESH_MS);
    return () => clearInterval(timer);
  }, [generating]);

  useEffect(() => {
    for (const chapter of wanted) {
      const version = versionOf(chapter, tick);
      const request = `${chapter.id}@${version}`;
      if (loaded.get(chapter.id)?.version === version || inFlight.current.has(request)) continue;
      inFlight.current.add(request);
      getChapterSentences(chapter.id)
        .then((rows) => {
          const sentences = rows.map(({ id, paragraphIndex, text, startMs }) => ({ id, paragraphIndex, text, startMs }));
          setLoaded((prev) => new Map(prev).set(chapter.id, { version, sentences }));
        })
        .catch((err: unknown) => {
          // The Chapter stays a placeholder; ask again shortly by moving the tick.
          console.warn(`Loading the Sentences of Chapter ${chapter.id} failed`, err);
          setTimeout(() => setTick((n) => n + 1), RETRY_MS);
        })
        .finally(() => inFlight.current.delete(request));
    }
  }, [wanted, loaded, tick]);

  return useMemo(() => new Map([...loaded].map(([id, l]) => [id, l.sentences])), [loaded]);
}
