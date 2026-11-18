"""The worker's whole job cycle, seen from outside: it talks to the API over HTTP and reads
the original file from object storage. There is no database anywhere in this picture."""

import json

import httpx

from epub_factory import Doc, TocEntry, make_epub
from vocaleaf_worker.api_client import ApiClient
from vocaleaf_worker.worker import run_once

TOKEN = "worker-token"
JOB = {
    "id": "11111111-1111-4111-8111-111111111111",
    "type": "parse",
    "bookId": "b",
    "sourceKey": "books/b/source.epub",
    # A re-claimed job: the worker must echo this attempt so the API can refuse reports from older claims.
    "attempt": 2,
}


class FakeApi:
    """Records every request the worker makes and answers like the real /internal routes."""

    def __init__(self, job: dict | None):
        self.job = job
        self.requests: list[httpx.Request] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        assert request.headers["Authorization"] == f"Bearer {TOKEN}"
        if request.url.path == "/api/internal/jobs/claim":
            return httpx.Response(200, json=self.job) if self.job else httpx.Response(204)
        return httpx.Response(204)

    def calls(self) -> list[tuple[str, str]]:
        return [(r.method, r.url.path) for r in self.requests]

    def body(self, index: int) -> dict:
        return json.loads(self.requests[index].content)


class FakeStorage:
    def __init__(self, objects: dict[str, bytes]):
        self.objects = objects

    def get_object(self, key: str) -> bytes:
        return self.objects[key]


def client(api: FakeApi) -> ApiClient:
    http = httpx.Client(base_url="http://api:3000", transport=httpx.MockTransport(api.handler))
    return ApiClient(http, TOKEN)


def test_returns_false_when_no_job_is_queued():
    api = FakeApi(job=None)

    assert run_once(client(api), FakeStorage({})) is False
    assert api.calls() == [("POST", "/api/internal/jobs/claim")]


def test_parses_the_claimed_book_and_reports_chapters_and_sentences():
    epub = make_epub(
        [Doc("c1.xhtml", "<p>It is a truth. However little known.</p><p>Next.</p>")],
        [TocEntry("Chapter 1", "c1.xhtml")],
        title="Pride and Prejudice",
        author="Jane Austen",
    )
    api = FakeApi(job=JOB)

    assert run_once(client(api), FakeStorage({"books/b/source.epub": epub})) is True

    assert api.calls() == [
        ("POST", "/api/internal/jobs/claim"),
        ("POST", f"/api/internal/jobs/{JOB['id']}/parse-result"),
    ]
    body = api.body(1)
    assert body["attempt"] == 2
    assert body["title"] == "Pride and Prejudice"
    assert body["author"] == "Jane Austen"
    assert body["parserVersion"]
    assert body["chapters"] == [
        {
            "title": "Chapter 1",
            "sentences": [
                {"paragraphIndex": 0, "text": "It is a truth.", "spokenText": "It is a truth."},
                {"paragraphIndex": 0, "text": "However little known.", "spokenText": "However little known."},
                {"paragraphIndex": 1, "text": "Next.", "spokenText": "Next."},
            ],
        }
    ]


def test_reports_a_failure_when_the_file_cannot_be_parsed():
    api = FakeApi(job=JOB)

    assert run_once(client(api), FakeStorage({"books/b/source.epub": b"not an epub"})) is True

    assert api.calls()[1] == ("POST", f"/api/internal/jobs/{JOB['id']}/failure")
    assert "BadZipFile" in api.body(1)["error"]
    assert api.body(1)["attempt"] == 2


def test_moves_on_when_the_api_says_the_job_was_claimed_again():
    epub = make_epub([Doc("c1.xhtml", "<p>Body.</p>")], [TocEntry("Chapter", "c1.xhtml")])
    api = FakeApi(job=JOB)
    real_handler = api.handler
    api.handler = lambda r: httpx.Response(409) if r.url.path.endswith("/parse-result") else real_handler(r)

    assert run_once(client(api), FakeStorage({"books/b/source.epub": epub})) is True
