"""HTTP client for the API's /internal worker protocol. Mirrors api/src/contract.ts."""

from dataclasses import dataclass
from typing import Literal

import httpx

from vocaleaf_worker.epub_parser import ParsedBook, ParseFailureReason
from vocaleaf_worker.tts import Voice, Word


@dataclass(frozen=True)
class ParseJob:
    id: str
    book_id: str
    # Fencing token: sent back with every report so the API can refuse reports from a superseded claim.
    attempt: int
    # How long the claim holds the job without a heartbeat.
    lease_ms: int
    source_key: str
    # Where the Book's cover image goes, when the EPUB has one.
    cover_key: str
    type: Literal["parse"] = "parse"


@dataclass(frozen=True)
class SentenceToSpeak:
    id: str
    spoken_text: str
    # Sentences of one paragraph are synthesized together and separated by the shorter pause.
    paragraph_index: int


@dataclass(frozen=True)
class RenderJob:
    id: str
    book_id: str
    attempt: int
    lease_ms: int
    chapter_id: str
    voice: Voice
    # Every segment of this claim is written under this object key prefix.
    audio_prefix: str
    sentences: tuple[SentenceToSpeak, ...]
    type: Literal["render_chapter"] = "render_chapter"


Job = ParseJob | RenderJob


@dataclass(frozen=True)
class WrittenSegment:
    index: int
    key: str
    duration_ms: int


@dataclass(frozen=True)
class TimedSentence:
    id: str
    # Milliseconds from the start of the Chapter's audio.
    start_ms: int
    end_ms: int
    # Relative to the start of the Sentence's own audio.
    words: tuple[Word, ...]


class JobSuperseded(Exception):
    """The API refused a report (409): the job finished, failed or was claimed again after this claim's lease."""


class ApiClient:
    """The worker's only channel to state: claim jobs, report results (ADR 0002, 0003)."""

    def __init__(self, http: httpx.Client, token: str) -> None:
        self._http = http
        self._headers = {"Authorization": f"Bearer {token}"}

    def claim(self) -> Job | None:
        res = self._post("/api/internal/jobs/claim")
        if res.status_code == 204:
            return None
        return job_from_claim(res.json())

    def heartbeat(self, job: Job) -> None:
        self._report(f"/api/internal/jobs/{job.id}/heartbeat", {"attempt": job.attempt})

    def report_parse_result(self, job: ParseJob, book: ParsedBook, parser_version: str) -> None:
        payload = {"attempt": job.attempt, **parse_result_payload(book, parser_version)}
        self._report(f"/api/internal/jobs/{job.id}/parse-result", payload)

    def report_render(
        self, job: RenderJob, segments: list[WrittenSegment], sentences: list[TimedSentence], *, finished: bool
    ) -> None:
        """Reports segments and Sentence timings since the last report; `finished` ends the Chapter."""
        payload = {"attempt": job.attempt, **render_report_payload(segments, sentences)}
        self._report(f"/api/internal/jobs/{job.id}/{'render-result' if finished else 'render-progress'}", payload)

    def report_failure(self, job: Job, error: str, reason: ParseFailureReason | None = None) -> None:
        """`error` is for the job log; `reason`, for a parse job, picks the message the user sees (PRD 4.3.5)."""
        payload = {"attempt": job.attempt, "error": error, **({"reason": reason} if reason else {})}
        self._report(f"/api/internal/jobs/{job.id}/failure", payload)

    def _report(self, path: str, payload: dict) -> None:
        """Posts a job report; a 409 means this claim was superseded and raises JobSuperseded."""
        try:
            self._post(path, json=payload)
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code == 409:
                raise JobSuperseded(path) from exc
            raise

    def _post(self, path: str, json: dict | None = None) -> httpx.Response:
        res = self._http.post(path, json=json, headers=self._headers)
        res.raise_for_status()
        return res


def job_from_claim(data: dict) -> Job:
    """ClaimedJob as defined in api/src/contract.ts."""
    common = {"id": data["id"], "book_id": data["bookId"], "attempt": data["attempt"], "lease_ms": data["leaseMs"]}
    if data["type"] == "parse":
        return ParseJob(**common, source_key=data["sourceKey"], cover_key=data["coverKey"])
    if data["type"] == "render_chapter":
        return RenderJob(
            **common,
            chapter_id=data["chapterId"],
            voice=data["voice"],
            audio_prefix=data["audioPrefix"],
            sentences=tuple(SentenceToSpeak(s["id"], s["spokenText"], s["paragraphIndex"]) for s in data["sentences"]),
        )
    raise ValueError(f"unknown job type {data['type']!r}")


def parse_result_payload(book: ParsedBook, parser_version: str) -> dict:
    """ParseResult as defined in api/src/contract.ts, without the attempt echo."""
    return {
        "parserVersion": parser_version,
        "title": book.title,
        "author": book.author,
        # The image itself is already in storage under the claim's coverKey.
        "cover": {"contentType": book.cover.media_type} if book.cover else None,
        "chapters": [
            {
                "title": c.title,
                "skipped": c.skipped,
                "sentences": [
                    {"paragraphIndex": s.paragraph_index, "text": s.text, "spokenText": s.spoken_text}
                    for s in c.sentences
                ],
            }
            for c in book.chapters
        ],
    }


def render_report_payload(segments: list[WrittenSegment], sentences: list[TimedSentence]) -> dict:
    """RenderReport as defined in api/src/contract.ts, without the attempt echo."""
    return {
        "segments": [{"index": s.index, "key": s.key, "durationMs": s.duration_ms} for s in segments],
        "sentences": [
            {
                "id": s.id,
                "startMs": s.start_ms,
                "endMs": s.end_ms,
                "wordTimings": [{"word": w.word, "startMs": w.start_ms, "endMs": w.end_ms} for w in s.words],
            }
            for s in sentences
        ],
    }
