// Typed calls to the VocaLeaf API. Types come straight from the API's zod contract (ADR 0002).
import type { ApiError, Book, BookDetail, Sentence } from "@vocaleaf/api/contract";

export type { Book, BookDetail, BookStatus, ChapterSummary, Sentence } from "@vocaleaf/api/contract";

export class ApiRequestError extends Error {}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, init);
  } catch {
    throw new ApiRequestError("网络连接失败，请稍后再试");
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as ApiError | null;
    throw new ApiRequestError(body?.error.message ?? "请求失败，请稍后再试");
  }
  return (await res.json()) as T;
}

export function uploadBook(file: File): Promise<Book> {
  const form = new FormData();
  form.append("file", file);
  return request<Book>("/books", { method: "POST", body: form });
}

export function getBook(id: string): Promise<BookDetail> {
  return request<BookDetail>(`/books/${id}`);
}

/** A Chapter's Sentences in reading order, with their place in the Book's audio once generated. */
export function getSentences(chapterId: string): Promise<Sentence[]> {
  return request<Sentence[]>(`/chapters/${chapterId}/sentences`);
}
