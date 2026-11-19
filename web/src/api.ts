// Typed calls to the VocaLeaf API. Types come straight from the API's zod contract (ADR 0002).
// The session is an HttpOnly cookie the browser sends by itself (same origin), so no call handles a token.
import type {
  ApiError,
  Book,
  BookDetail,
  BookTimeline,
  CodeSent,
  LibraryBook,
  Sentence,
  UploadPolicy,
  User,
} from "@vocaleaf/api/contract";

export type {
  Book,
  BookDetail,
  BookSource,
  BookStatus,
  BookTimeline,
  ChapterSummary,
  Difficulty,
  LibraryBook,
  Listening,
  Sentence,
  UploadPolicy,
  User,
} from "@vocaleaf/api/contract";

/** Fired on window whenever the API answers 401: the session ended, so the app shows the login page. */
export const UNAUTHORIZED_EVENT = "vocaleaf:unauthorized";

/**
 * Fired on window once a Book is deleted or a Library Book is taken off the Shelf, with its id as the CustomEvent's
 * detail, so whatever holds it lets go.
 */
export const BOOK_DELETED_EVENT = "vocaleaf:book-deleted";

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
export function uploadBook(file: File, { declarationVersion, onProgress, signal }: UploadOptions = {}): Promise<Book> {
  const form = new FormData();
  form.append("file", file);
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

/** Tells the API where playback is in the Book's audio; it keeps the Sentence there as the place to resume. */
export async function saveListening(bookId: string, positionMs: number): Promise<void> {
  await send(`/books/${bookId}/listening`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ positionMs: Math.max(0, Math.floor(positionMs)) }),
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
