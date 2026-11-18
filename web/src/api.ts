// Typed calls to the VocaLeaf API. Types come straight from the API's zod contract (ADR 0002).
// The session is an HttpOnly cookie the browser sends by itself (same origin), so no call handles a token.
import type { ApiError, Book, BookDetail, CodeSent, Sentence, User } from "@vocaleaf/api/contract";

export type { Book, BookDetail, BookStatus, ChapterSummary, Sentence, User } from "@vocaleaf/api/contract";

/** Fired on window whenever the API answers 401: the session ended, so the app shows the login page. */
export const UNAUTHORIZED_EVENT = "vocaleaf:unauthorized";

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

async function send(path: string, init?: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, init);
  } catch {
    throw new ApiRequestError("网络连接失败，请稍后再试");
  }
  if (res.ok) return res;
  if (res.status === 401) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
  const body = (await res.json().catch(() => null)) as ApiError | null;
  const retryAfter = Number(res.headers.get("Retry-After"));
  throw new ApiRequestError(
    body?.error.message ?? "请求失败，请稍后再试",
    res.status,
    Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
  );
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

export function uploadBook(file: File): Promise<Book> {
  const form = new FormData();
  form.append("file", file);
  return request<Book>("/books", { method: "POST", body: form });
}

export function getBook(id: string): Promise<BookDetail> {
  return request<BookDetail>(`/books/${id}`);
}

/** A Chapter's Sentences in reading order, with their times in the Book's audio once the Chapter is placed. */
export function getChapterSentences(chapterId: string): Promise<Sentence[]> {
  return request<Sentence[]>(`/chapters/${chapterId}/sentences`);
}

/** Generates a 生成失败 Chapter again; it goes back to 待生成. */
export async function retryChapter(chapterId: string): Promise<void> {
  await send(`/chapters/${chapterId}/retry`, { method: "POST" });
}
