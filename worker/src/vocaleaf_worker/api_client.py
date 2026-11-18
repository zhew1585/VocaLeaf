"""HTTP client for the API's /internal worker protocol. Mirrors api/src/contract.ts."""

from dataclasses import dataclass
from typing import Literal

import httpx

from vocaleaf_worker.epub_parser import ParsedBook


@dataclass(frozen=True)
class ClaimedJob:
    id: str
    type: Literal["parse"]
    book_id: str
    source_key: str
    # Fencing token: sent back with every report so the API can refuse reports from a superseded claim.
    attempt: int


class JobSuperseded(Exception):
    """The API refused a report (409): the job finished, failed or was claimed again after this claim's lease."""


class ApiClient:
    """The worker's only channel to state: claim jobs, report results (ADR 0002, 0003)."""

    def __init__(self, http: httpx.Client, token: str):
        self._http = http
        self._headers = {"Authorization": f"Bearer {token}"}

    def claim(self) -> ClaimedJob | None:
        res = self._post("/api/internal/jobs/claim")
        if res.status_code == 204:
            return None
        data = res.json()
        return ClaimedJob(
            id=data["id"],
            type=data["type"],
            book_id=data["bookId"],
            source_key=data["sourceKey"],
            attempt=data["attempt"],
        )

    def report_parse_result(self, job: ClaimedJob, book: ParsedBook, parser_version: str) -> None:
        payload = {"attempt": job.attempt, **parse_result_payload(book, parser_version)}
        self._report(f"/api/internal/jobs/{job.id}/parse-result", payload)

    def report_failure(self, job: ClaimedJob, error: str) -> None:
        self._report(f"/api/internal/jobs/{job.id}/failure", {"attempt": job.attempt, "error": error})

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


def parse_result_payload(book: ParsedBook, parser_version: str) -> dict:
    """ParseResult as defined in api/src/contract.ts, without the attempt echo."""
    return {
        "parserVersion": parser_version,
        "title": book.title,
        "author": book.author,
        "chapters": [
            {
                "title": c.title,
                "sentences": [
                    {"paragraphIndex": s.paragraph_index, "text": s.text, "spokenText": s.spoken_text}
                    for s in c.sentences
                ],
            }
            for c in book.chapters
        ],
    }
