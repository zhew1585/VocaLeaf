// Typed calls to the VocaLeaf API. Types come straight from the API's zod contract (ADR 0002).
// The session is an HttpOnly cookie the browser sends by itself (same origin), so no call handles a token.
import type {
  ApiError,
  Book,
  BookDetail,
  BookMarks,
  BookTimeline,
  Card,
  CardListItem,
  CodeSent,
  CreateCard,
  ExplainEvent,
  ExplainRequest,
  Explanation,
  Gleaning,
  GleaningCount,
  LibraryBook,
  MarkResult,
  Rating,
  ReviewCount,
  ReviewQueue,
  Sentence,
  UploadPolicy,
  Usage,
  User,
  Voice,
} from "@vocaleaf/api/contract";

export type {
  Book,
  BookDetail,
  BookSource,
  BookStatus,
  BookTimeline,
  Card,
  CardBack,
  CardListItem,
  ChapterSummary,
  ChatMessage,
  Difficulty,
  ExplainEvent,
  ExplainRequest,
  Explanation,
  Gleaning,
  LibraryBook,
  Listening,
  MarkResult,
  Rating,
  ReviewItem,
  ReviewQueue,
  Sentence,
  TargetKind,
  UploadPolicy,
  Usage,
  User,
  Voice,
  VoiceChange,
} from "@vocaleaf/api/contract";

/** Fired on window whenever the API answers 401: the session ended, so the app shows the login page. */
export const UNAUTHORIZED_EVENT = "vocaleaf:unauthorized";

/**
 * Fired on window once a Book is deleted or a Library Book is taken off the Shelf, with its id as the CustomEvent's
 * detail, so whatever holds it lets go.
 */
export const BOOK_DELETED_EVENT = "vocaleaf:book-deleted";

/** Fired on window once the user's Cards changed (one made, rated in Review or deleted), so the 复习 badge counts again. */
export const CARDS_CHANGED_EVENT = "vocaleaf:cards-changed";

function cardsChanged(): void {
  window.dispatchEvent(new Event(CARDS_CHANGED_EVENT));
}

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
    /** Seconds the API asks to wait (Retry-After), when it sent one. */
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
  }
}

/** The error a failed API response carries: its message, or a generic one. Also reports 401 (UNAUTHORIZED_EVENT). */
function errorOf(status: number, body: ApiError | null, retryAfterSeconds: number | null = null): ApiRequestError {
  if (status === 401) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
  return new ApiRequestError(body?.error.message ?? "请求失败，请稍后再试", status, retryAfterSeconds);
}

async function send(path: string, init?: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, init);
  } catch {
    throw new ApiRequestError("网络连接失败，请稍后再试");
  }
  if (res.ok) return res;
  const body = (await res.json().catch(() => null)) as ApiError | null;
  const retryAfter = Number(res.headers.get("Retry-After"));
  throw errorOf(res.status, body, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  return (await (await send(path, init)).json()) as T;
}

function postJson(body: unknown): RequestInit {
  return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

/** The logged-in user, or null when this device has no session. */
export async function getMe(): Promise<User | null> {
  try {
    return await request<User>("/me");
  } catch (err) {
    if (err instanceof ApiRequestError && err.status === 401) return null;
    throw err;
  }
}

/** Emails a login code; rejects with the API's message (not invited, too soon, sending failed). */
export function requestLoginCode(email: string): Promise<CodeSent> {
  return request<CodeSent>("/auth/code", postJson({ email }));
}

export function logIn(email: string, code: string): Promise<User> {
  return request<User>("/auth/login", postJson({ email, code }));
}

/** Today's AI calls left and the uploaded Books held, against their limits (设置页). */
export function getUsage(): Promise<Usage> {
  return request<Usage>("/me/usage");
}

/** Ends this device's session. */
export async function logOut(): Promise<void> {
  await send("/auth/logout", { method: "POST" });
}

/** The user's Shelf, in display order (last listened first, then the others newest first). */
export function getShelf(): Promise<Book[]> {
  return request<Book[]>("/books");
}

/** Limits the upload dialog checks a file against, and whether the declaration still needs confirming. */
export function getUploadPolicy(): Promise<UploadPolicy> {
  return request<UploadPolicy>("/upload-policy");
}

export interface UploadOptions {
  /** The Voice to narrate the Book with; the API's default Voice when left out. */
  voice?: Voice;
  /** The declaration version the user just confirmed, when they had to. */
  declarationVersion?: string;
  /** Share of the file sent so far, 0 to 1. */
  onProgress?(sent: number): void;
  /** Aborting cancels the upload; the promise then rejects with an AbortError. */
  signal?: AbortSignal;
}

/**
 * Uploads an EPUB. Uses XMLHttpRequest rather than fetch because only it reports upload progress (the dialog's
 * progress bar); rejects with the API's message when the upload is refused.
 */
export function uploadBook(file: File, { voice, declarationVersion, onProgress, signal }: UploadOptions = {}): Promise<Book> {
  const form = new FormData();
  form.append("file", file);
  if (voice) form.append("voice", voice);
  if (declarationVersion) form.append("declarationVersion", declarationVersion);
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    xhr.open("POST", "/api/books");
    xhr.responseType = "json";
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded / e.total);
    };
    xhr.onload = () => {
      signal?.removeEventListener("abort", abort);
      if (xhr.status === 201) resolve(xhr.response as Book);
      else reject(errorOf(xhr.status, xhr.response as ApiError | null));
    };
    xhr.onerror = () => reject(new ApiRequestError("网络连接失败，请稍后再试"));
    xhr.onabort = () => reject(new DOMException("上传已取消", "AbortError"));
    if (signal?.aborted) return reject(new DOMException("上传已取消", "AbortError"));
    signal?.addEventListener("abort", abort, { once: true });
    xhr.send(form);
  });
}

/**
 * Tells the API where playback is in the Book's audio; it keeps the Sentence there as the place to resume.
 * `voice` is the Voice of the audio the position is in, so a position in audio from before a Voice change is not
 * misplaced. `keepalive` lets the request finish after the page is gone (sent while the page is hidden or left).
 */
export async function saveListening(
  bookId: string,
  positionMs: number,
  { keepalive = false, voice }: { keepalive?: boolean; voice?: Voice } = {},
): Promise<void> {
  await send(`/books/${bookId}/listening`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ positionMs: Math.max(0, Math.floor(positionMs)), voice }),
    keepalive,
  });
}

export function getBook(id: string): Promise<BookDetail> {
  return request<BookDetail>(`/books/${id}`);
}

/** Where the Book's Sentences and narrated Chapters sit in its audio, for the player's controls. */
export function getBookTimeline(id: string): Promise<BookTimeline> {
  return request<BookTimeline>(`/books/${id}/timeline`);
}

/** A Chapter's Sentences in reading order, with their times in the Book's audio once the Chapter is placed. */
export function getChapterSentences(chapterId: string): Promise<Sentence[]> {
  return request<Sentence[]>(`/chapters/${chapterId}/sentences`);
}

/** Generates a 生成失败 Chapter again; it goes back to 待生成. */
export async function retryChapter(chapterId: string): Promise<void> {
  await send(`/chapters/${chapterId}/retry`, { method: "POST" });
}

/**
 * Sets a Chapter Skipped or narrated (PRD 4.2.5). Narrating one without audio queues its generation; the
 * playlist changes at once, which the listening session follows once the Book is loaded again.
 */
export async function setChapterSkipped(chapterId: string, skipped: boolean): Promise<void> {
  await send(`/chapters/${chapterId}/skipped`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ skipped }),
  });
}

/**
 * Starts generating the Book's audio again in `voice` (PRD 4.2.4); the old audio plays until the new one is
 * complete. Rejects with the API's message when refused (a change already running, the Book not 已就绪 yet).
 */
export async function changeVoice(bookId: string, voice: Voice): Promise<void> {
  await send(`/books/${bookId}/voice`, postJson({ voice }));
}

/**
 * Deletes an uploaded Book in any state (PRD 4.3.6), then fires BOOK_DELETED_EVENT. A Book that is already gone
 * (404, deleted on another device) counts as deleted.
 */
export async function deleteBook(id: string): Promise<void> {
  try {
    await send(`/books/${id}`, { method: "DELETE" });
  } catch (err) {
    if (!(err instanceof ApiRequestError && err.status === 404)) throw err;
  }
  window.dispatchEvent(new CustomEvent(BOOK_DELETED_EVENT, { detail: id }));
}

/** Library Books ready to play, by difficulty and then title, each saying whether it is on the user's Shelf. */
export function getLibrary(): Promise<LibraryBook[]> {
  return request<LibraryBook[]>("/library");
}

/** Puts a Library Book on the user's Shelf; one already there keeps its progress. */
export async function addToShelf(id: string): Promise<void> {
  await send(`/books/${id}/shelf`, { method: "PUT" });
}

/**
 * Takes a Library Book off the user's Shelf with their progress (PRD 4.2.3), then fires BOOK_DELETED_EVENT so the
 * listening session lets go of it.
 */
export async function removeFromShelf(id: string): Promise<void> {
  await send(`/books/${id}/shelf`, { method: "DELETE" });
  window.dispatchEvent(new CustomEvent(BOOK_DELETED_EVENT, { detail: id }));
}

/** Records that the user saw the first-play guide, so it does not show on their next play (AC-GUIDE-02). */
export async function markPlayGuideSeen(): Promise<void> {
  await send("/me/play-guide", { method: "PUT" });
}

/** Marks a Sentence (PRD 4.4.2); says whether that created a Mark, found one pending or put one back to pending. */
export function putMark(sentenceId: string): Promise<MarkResult> {
  return request<MarkResult>(`/sentences/${sentenceId}/mark`, { method: "PUT" });
}

/** Deletes the user's Mark of a Sentence (撤销, 取消标记); a missing Mark is fine. */
export async function deleteMark(sentenceId: string): Promise<void> {
  await send(`/sentences/${sentenceId}/mark`, { method: "DELETE" });
}

/** Dismisses a pending Mark (PRD 4.4.4): it leaves Gleanings. */
export async function dismissMark(sentenceId: string): Promise<void> {
  await send(`/sentences/${sentenceId}/mark/dismiss`, { method: "POST" });
}

/** The Book's Sentences with a pending Mark. */
export function getBookMarks(bookId: string): Promise<BookMarks> {
  return request<BookMarks>(`/books/${bookId}/marks`);
}

/** Gleanings: pending Marks across Books, most recently marked first. */
export function getGleanings(): Promise<Gleaning[]> {
  return request<Gleaning[]>("/gleanings");
}

/** How many Sentences wait in Gleanings. */
export function getGleaningCount(): Promise<GleaningCount> {
  return request<GleaningCount>("/gleanings/count");
}

/** The user's Explanation of a Sentence with its follow-up questions, and today's AI calls left. */
export function getExplanation(sentenceId: string): Promise<Explanation> {
  return request<Explanation>(`/sentences/${sentenceId}/explanation`);
}

/**
 * Asks the AI about a Sentence (AI 解析, regenerate, or a follow-up question) and hands each streamed event to
 * `onEvent` as it arrives. Resolves when the stream ends; rejects with the API's message when the call is refused
 * (no calls left: status 429), and with an AbortError once `signal` stops it.
 */
export async function streamExplanation(
  sentenceId: string,
  body: ExplainRequest,
  { signal, onEvent }: { signal: AbortSignal; onEvent(event: ExplainEvent): void },
): Promise<void> {
  const res = await send(`/sentences/${sentenceId}/explanation`, { ...postJson(body), signal });
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffered = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffered += value;
    const lines = buffered.split("\n");
    buffered = lines.pop()!;
    for (const line of lines) if (line.trim()) onEvent(JSON.parse(line) as ExplainEvent);
  }
}

/** The user's Cards of a Book's Sentences, in reading order (the green underlines, PRD 4.4.5). */
export function getBookCards(bookId: string): Promise<Card[]> {
  return request<Card[]>(`/books/${bookId}/cards`);
}

/**
 * Makes a Card of a selection of a Sentence (PRD 4.5.2), or finds the Sentence's Card of the same Target. Rejects
 * with status 409 and the prompt as message when the user has a Card of the same Target in another Sentence; send
 * `allowDuplicate` to make it anyway.
 */
export async function createCard(body: CreateCard): Promise<MadeCard> {
  const res = await send("/cards", postJson(body));
  const created = res.status === 201;
  if (created) cardsChanged();
  return { card: (await res.json()) as Card, created };
}

/** What 【制作卡片】 got: a new Card, or the Sentence's Card of the same Target (`created` false). */
export interface MadeCard {
  card: Card;
  created: boolean;
}

/** Generates a Card's back again (【释义生成失败，点击重试】, 【重新生成】); rejects when it fails again. */
export function regenerateCardBack(cardId: string): Promise<Card> {
  return request<Card>(`/cards/${cardId}/back`, { method: "POST" });
}

/** Every Card of the user, soonest due first, each with its Book while that is on the Shelf (卡片列表, F14). */
export function listCards(): Promise<CardListItem[]> {
  return request<CardListItem[]>("/cards");
}

/** Deletes a Card and its audio for good (PRD 4.5.2 删除); one already gone counts as deleted. */
export async function deleteCard(cardId: string): Promise<void> {
  try {
    await send(`/cards/${cardId}`, { method: "DELETE" });
  } catch (err) {
    if (!(err instanceof ApiRequestError && err.status === 404)) throw err;
  }
  cardsChanged();
}

/** Where a Card's own copy of its Sentence's audio is (【卡片原声】). */
export function cardAudioUrl(cardId: string): string {
  return `/api/cards/${cardId}/audio`;
}

/** Today's Review queue (PRD 4.5.3): due Cards plus the day's new Cards, by due date, with each rating's interval. */
export function getReviewQueue(): Promise<ReviewQueue> {
  return request<ReviewQueue>("/review");
}

/** How many Cards today's Review queue holds (the navigation's 复习 badge). */
export function getReviewCount(): Promise<ReviewCount> {
  return request<ReviewCount>("/review/count");
}

/** Rates a Card in Review (1 忘了 to 4 简单); resolves to today's queue after it. */
export async function rateCard(cardId: string, rating: Rating): Promise<ReviewQueue> {
  const queue = await request<ReviewQueue>(`/cards/${cardId}/review`, postJson({ rating }));
  cardsChanged();
  return queue;
}
