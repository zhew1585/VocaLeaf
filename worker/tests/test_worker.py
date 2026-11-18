"""The worker's whole job cycle, seen from outside: it talks to the API over HTTP and reads
the original file from object storage. There is no database anywhere in this picture."""

from epub_factory import Doc, TocEntry, make_epub
from fakes import FakeApi, FakeStorage, FakeTts, client
from vocaleaf_worker.narration import Pauses
from vocaleaf_worker.worker import run_once

PAUSES = Pauses(sentence_ms=300, paragraph_ms=800, chapter_start_ms=1500)

JOB = {
    "id": "11111111-1111-4111-8111-111111111111",
    "type": "parse",
    "bookId": "b",
    "sourceKey": "books/b/source.epub",
    # A re-claimed job: the worker must echo this attempt so the API can refuse reports from older claims.
    "attempt": 2,
    "leaseMs": 600_000,
}


def test_returns_false_when_no_job_is_queued():
    api = FakeApi(job=None)

    assert run_once(client(api), FakeStorage(), FakeTts(), PAUSES) is False
    assert api.calls() == ["claim"]


def test_parses_the_claimed_book_and_reports_chapters_and_sentences():
    epub = make_epub(
        [Doc("c1.xhtml", "<p>It is a truth. However little known.</p><p>Next.</p>")],
        [TocEntry("Chapter 1", "c1.xhtml")],
        title="Pride and Prejudice",
        author="Jane Austen",
    )
    api = FakeApi(job=JOB)

    assert run_once(client(api), FakeStorage({"books/b/source.epub": epub}), FakeTts(), PAUSES) is True

    assert api.calls() == ["claim", "parse-result"]
    body = api.bodies("parse-result")[0]
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

    assert run_once(client(api), FakeStorage({"books/b/source.epub": b"not an epub"}), FakeTts(), PAUSES) is True

    assert api.calls() == ["claim", "failure"]
    assert "BadZipFile" in api.bodies("failure")[0]["error"]
    assert api.bodies("failure")[0]["attempt"] == 2


def test_moves_on_when_the_api_says_the_job_was_claimed_again(caplog):
    epub = make_epub([Doc("c1.xhtml", "<p>Body.</p>")], [TocEntry("Chapter", "c1.xhtml")])
    api = FakeApi(job=JOB, refuse=frozenset({"parse-result"}))

    assert run_once(client(api), FakeStorage({"books/b/source.epub": epub}), FakeTts(), PAUSES) is True

    assert api.calls() == ["claim", "parse-result"]
    assert "superseded" in caplog.text
