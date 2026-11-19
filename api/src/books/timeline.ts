// A Book's continuous audio (PRD 4.4.1): its narrated Chapters' HLS segments, one after another.
// The playlist, the Book's `playable` flag and Sentence times all derive from this one function.
import { and, asc, eq, inArray } from "drizzle-orm";
import type { AudioStatus } from "../contract.js";
import type { Db } from "../db/client.js";
import { audioSegments, chapters, jobs } from "../db/schema.js";

export interface TimelineChapterInput {
  id: string;
  skipped: boolean;
  audioStatus: AudioStatus;
  /**
   * The Chapter failed for good once (its job used up every attempt) and the user asked to generate it again.
   * It is then generated out of Chapter order, after the Chapters behind it already played on.
   */
  retried: boolean;
  /** The Chapter's segments in order. */
  segments: { id: string; durationMs: number }[];
}

export interface TimelineEntry {
  chapterId: string;
  /** Where the Chapter starts in the Book's audio. */
  offsetMs: number;
  segments: { id: string; durationMs: number }[];
}

export interface Timeline {
  entries: TimelineEntry[];
  /**
   * True once no more audio will be appended at the end: every narrated Chapter is generated, failed, or
   * retried (whose audio goes in its own place, not at the end).
   */
  complete: boolean;
}

/**
 * Lays the narrated Chapters (given in Chapter order) end to end. Skipped Chapters are left out.
 * The timeline stops at the first narrated Chapter still to generate, after the segments it has so far (a
 * Chapter waiting for another attempt may have some): later Chapters cannot be placed before it. Since
 * published segments are never taken back, a player only ever sees segments appended at the end, as an HLS
 * EVENT playlist requires.
 * A failed Chapter keeps only what it published before failing (usually nothing) and holds nothing back.
 * Neither does one the user retried: it is generated out of order, so it is left out until it is generated
 * and then inserted in its place whole. That is the one case where the playlist changes before its end, at
 * most twice per retry (a failed Chapter's earlier audio drops out, then all of it comes in); the 专注页
 * notices and reloads the playlist (web/src/pages/usePlaylist.ts).
 */
export function buildTimeline(chaptersInOrder: TimelineChapterInput[]): Timeline {
  const entries: TimelineEntry[] = [];
  let offsetMs = 0;
  const place = (ch: TimelineChapterInput) => {
    const entry = { chapterId: ch.id, offsetMs, segments: ch.segments };
    entries.push(entry);
    offsetMs = entryEndMs(entry);
  };
  for (const ch of chaptersInOrder) {
    if (ch.skipped) continue;
    const hasAudio = ch.segments.length > 0;
    if (ch.retried && ch.audioStatus !== "generated") continue;
    if (ch.audioStatus === "failed") {
      if (hasAudio) place(ch);
      continue;
    }
    if (ch.audioStatus === "pending" && !hasAudio) return { entries, complete: false };
    place(ch);
    if (ch.audioStatus !== "generated") return { entries, complete: false };
  }
  return { entries, complete: true };
}

/** Where a Chapter's audio ends in the Book's audio. */
export function entryEndMs(entry: TimelineEntry): number {
  return entry.offsetMs + entry.segments.reduce((sum, s) => sum + s.durationMs, 0);
}

export interface DurationChapterInput {
  skipped: boolean;
  audioStatus: AudioStatus;
  durationMs: number | null;
  /** Characters of the Chapter's spoken text. */
  spokenChars: number;
}

/**
 * The Book's audio length: generated Chapters count as they are, Chapters still to generate are estimated at the
 * generated ones' milliseconds per character. Null while no Chapter with text is generated. Failed Chapters
 * count as nothing.
 */
export function estimateDurationMs(chaptersInOrder: DurationChapterInput[]): number | null {
  const narrated = chaptersInOrder.filter((c) => !c.skipped);
  const generated = narrated.filter((c) => c.audioStatus === "generated");
  const generatedMs = generated.reduce((sum, c) => sum + (c.durationMs ?? 0), 0);
  const generatedChars = generated.reduce((sum, c) => sum + c.spokenChars, 0);
  if (generatedChars === 0) return null;
  const toGenerate = narrated.filter((c) => c.audioStatus === "pending" || c.audioStatus === "generating");
  const restChars = toGenerate.reduce((sum, c) => sum + c.spokenChars, 0);
  return Math.round(generatedMs + (restChars * generatedMs) / generatedChars);
}

/** Where a Chapter's audio starts in the Book's audio, or null while the timeline has none of it. */
export function chapterStartMs(timeline: Timeline, chapterId: string): number | null {
  const entry = timeline.entries.find((e) => e.chapterId === chapterId);
  return entry && entry.segments.length > 0 ? entry.offsetMs : null;
}

/** Whether the timeline has any audio to play (PRD 4.3.3 invariant 3). */
export function hasAudio(timeline: Timeline): boolean {
  return timeline.entries.some((e) => e.segments.length > 0);
}

/** Loads the timelines of several Books in three queries. */
export async function loadTimelines(db: Db, bookIds: string[]): Promise<Map<string, Timeline>> {
  if (bookIds.length === 0) return new Map();
  const chapterRows = await db
    .select({ id: chapters.id, bookId: chapters.bookId, skipped: chapters.skipped, audioStatus: chapters.audioStatus })
    .from(chapters)
    .where(inArray(chapters.bookId, bookIds))
    .orderBy(asc(chapters.bookId), asc(chapters.index));
  const segmentRows = await db
    .select({ id: audioSegments.id, chapterId: audioSegments.chapterId, durationMs: audioSegments.durationMs })
    .from(audioSegments)
    .innerJoin(chapters, eq(chapters.id, audioSegments.chapterId))
    .where(inArray(chapters.bookId, bookIds))
    .orderBy(asc(audioSegments.chapterId), asc(audioSegments.index));

  // A Chapter whose job failed for good and that is not failed now was retried by the user.
  const failedRows = await db
    .selectDistinct({ chapterId: jobs.chapterId })
    .from(jobs)
    .where(and(inArray(jobs.bookId, bookIds), eq(jobs.type, "render_chapter"), eq(jobs.status, "failed")));
  const failedOnce = new Set(failedRows.map((r) => r.chapterId));

  const segmentsByChapter = Map.groupBy(segmentRows, (s) => s.chapterId);
  const chaptersByBook = Map.groupBy(chapterRows, (c) => c.bookId);
  return new Map(
    bookIds.map((id) => [
      id,
      buildTimeline(
        (chaptersByBook.get(id) ?? []).map((c) => ({
          ...c,
          retried: failedOnce.has(c.id) && c.audioStatus !== "failed",
          segments: segmentsByChapter.get(c.id) ?? [],
        })),
      ),
    ]),
  );
}

export async function loadTimeline(db: Db, bookId: string): Promise<Timeline> {
  return (await loadTimelines(db, [bookId])).get(bookId)!;
}

/** HLS segments are cut at about 10 seconds (PRD 4.7.2); the target duration never goes below that. */
const MIN_TARGET_DURATION_S = 10;

/**
 * Renders the timeline as an HLS media playlist. Segment URIs are relative (`segments/{id}.ts`), so they resolve
 * against the playlist's own URL. Each Chapter was encoded on its own, so a new Chapter starts a discontinuity.
 * The playlist is an EVENT playlist: players reload it and play on as segments are appended, until ENDLIST.
 */
export function toM3u8(timeline: Timeline): string {
  const all = timeline.entries.flatMap((e) => e.segments);
  const target = Math.max(MIN_TARGET_DURATION_S, ...all.map((s) => Math.round(s.durationMs / 1000)));
  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    "#EXT-X-PLAYLIST-TYPE:EVENT",
    `#EXT-X-TARGETDURATION:${target}`,
    "#EXT-X-MEDIA-SEQUENCE:0",
  ];
  let first = true;
  for (const entry of timeline.entries) {
    if (entry.segments.length === 0) continue;
    if (!first) lines.push("#EXT-X-DISCONTINUITY");
    first = false;
    for (const s of entry.segments) lines.push(`#EXTINF:${(s.durationMs / 1000).toFixed(3)},`, `segments/${s.id}.ts`);
  }
  if (timeline.complete) lines.push("#EXT-X-ENDLIST");
  return `${lines.join("\n")}\n`;
}
