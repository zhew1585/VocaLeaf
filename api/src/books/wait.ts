// How long a Chapter that is not playable yet still waits for its audio (PRD 4.3.4 跳到未生成的章节):
// 【该章节生成中，预计约 N 秒】. Estimated from the work queued ahead of it and the workers' recent pace.
import { and, desc, eq, inArray, isNotNull, sql, sum } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { jobs, sentences } from "../db/schema.js";

/**
 * Rendering pace before any Chapter was generated to measure it: Kokoro on CPU runs about 3.5 times
 * realtime, and narration takes about 70 ms per character.
 */
export const DEFAULT_RENDER_MS_PER_CHAR = 20;
/** About one 10-second HLS segment of narration: a Chapter plays as soon as its first segment exists. */
export const FIRST_SEGMENT_CHARS = 150;
/** How many recently generated Chapters the pace is measured over. */
const PACE_SAMPLE_JOBS = 20;

/** A render job still to finish, with the characters it has left to speak. */
export interface OpenRenderJob {
  id: string;
  chapterId: string;
  running: boolean;
  position: number;
  createdAt: Date;
  remainingChars: number;
}

/**
 * Seconds until each open job's Chapter has its first segment. Running jobs come first, then queued ones in
 * the order they are claimed (jobs/lifecycle.ts claimNextJob); every job waits for all the work ahead of it.
 * Assumes one worker: with more the wait is shorter.
 */
export function queueWaits(open: OpenRenderJob[], msPerChar: number): Map<string, number> {
  const order = [...open].sort(
    (a, b) =>
      Number(b.running) - Number(a.running) ||
      a.position - b.position ||
      a.createdAt.getTime() - b.createdAt.getTime() ||
      a.id.localeCompare(b.id),
  );
  const waits = new Map<string, number>();
  let charsAhead = 0;
  for (const job of order) {
    const chars = charsAhead + Math.min(job.remainingChars, FIRST_SEGMENT_CHARS);
    waits.set(job.chapterId, Math.max(1, Math.ceil((chars * msPerChar) / 1000)));
    charsAhead += job.remainingChars;
  }
  return waits;
}

/** Milliseconds of rendering per character over the given generated Chapters, or the default without any. */
export function renderPace(samples: { chars: number; ms: number }[]): number {
  const chars = samples.reduce((n, s) => n + s.chars, 0);
  const ms = samples.reduce((n, s) => n + s.ms, 0);
  return chars > 0 && ms > 0 ? ms / chars : DEFAULT_RENDER_MS_PER_CHAR;
}

/** Characters each Chapter speaks. */
async function charsOf(db: Db, chapterIds: string[]): Promise<Map<string, number>> {
  if (chapterIds.length === 0) return new Map();
  const rows = await db
    .select({ chapterId: sentences.chapterId, chars: sum(sql<number>`length(${sentences.spokenText})`).mapWith(Number) })
    .from(sentences)
    .where(inArray(sentences.chapterId, chapterIds))
    .groupBy(sentences.chapterId);
  return new Map(rows.map((r) => [r.chapterId, r.chars]));
}

/** The workers' pace over the last generated Chapters: how long each one's last claim took. */
async function loadPace(db: Db): Promise<number> {
  const recent = await db
    .select({ chapterId: jobs.chapterId, startedAt: jobs.startedAt, finishedAt: jobs.updatedAt })
    .from(jobs)
    .where(and(eq(jobs.type, "render_chapter"), eq(jobs.status, "succeeded"), isNotNull(jobs.startedAt)))
    .orderBy(desc(jobs.updatedAt))
    .limit(PACE_SAMPLE_JOBS);
  const chars = await charsOf(db, recent.map((j) => j.chapterId!));
  return renderPace(
    recent.map((j) => ({ chars: chars.get(j.chapterId!) ?? 0, ms: j.finishedAt.getTime() - j.startedAt!.getTime() })),
  );
}

/**
 * Seconds until each Chapter with an open render job (of any Book: they share the workers) plays.
 * A running job has left only the Sentences it has not timed yet; a queued one all of them.
 */
export async function loadChapterWaits(db: Db): Promise<Map<string, number>> {
  const open = await db
    .select({
      id: jobs.id,
      chapterId: jobs.chapterId,
      status: jobs.status,
      position: jobs.position,
      createdAt: jobs.createdAt,
      remainingChars: sql<number>`coalesce(sum(length(${sentences.spokenText})) filter (where ${jobs.status} = 'queued' or ${sentences.startMs} is null), 0)`.mapWith(Number),
    })
    .from(jobs)
    .innerJoin(sentences, eq(sentences.chapterId, jobs.chapterId))
    .where(and(eq(jobs.type, "render_chapter"), inArray(jobs.status, ["queued", "running"])))
    .groupBy(jobs.id);
  if (open.length === 0) return new Map();
  return queueWaits(
    open.map((j) => ({ ...j, chapterId: j.chapterId!, running: j.status === "running" })),
    await loadPace(db),
  );
}
