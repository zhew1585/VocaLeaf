"""The worker's job cycle. Stateless: all state lives behind the API, files in object storage."""

import logging

from vocaleaf_worker.api_client import ApiClient, Job, JobSuperseded, ParseJob, RenderJob
from vocaleaf_worker.epub_parser import PARSER_VERSION, parse_epub
from vocaleaf_worker.heartbeat import Heartbeat
from vocaleaf_worker.narration import Pauses
from vocaleaf_worker.render import render_chapter
from vocaleaf_worker.storage import ObjectStorage
from vocaleaf_worker.tts import Tts

log = logging.getLogger(__name__)


def run_once(
    api: ApiClient,
    storage: ObjectStorage,
    tts: Tts,
    pauses: Pauses,
    heartbeat_seconds: float | None = None,
) -> bool:
    """Claims and runs one job, keeping its lease alive meanwhile. Returns False when nothing was queued.
    `pauses` lays out narrated audio; `heartbeat_seconds` overrides the interval derived from the lease (tests)."""
    job = api.claim()
    if job is None:
        return False
    log.info("job %s: %s book %s (attempt %d)", job.id, job.type, job.book_id, job.attempt)
    try:
        with Heartbeat(api, job, heartbeat_seconds) as heartbeat:
            _run(api, storage, tts, pauses, job, heartbeat)
    except JobSuperseded:
        # Our lease ran out and another worker took the job over, or the job ended; its result is not ours.
        log.warning("job %s attempt %d was superseded; dropped", job.id, job.attempt)
    return True


def _run(api: ApiClient, storage: ObjectStorage, tts: Tts, pauses: Pauses, job: Job, heartbeat: Heartbeat) -> None:
    try:
        match job:
            case ParseJob():
                book = parse_epub(storage.get_object(job.source_key))
                heartbeat.check()
                api.report_parse_result(job, book, PARSER_VERSION)
                log.info("job %s: %d chapters", job.id, len(book.chapters))
            case RenderJob():
                render_chapter(api, storage, tts, job, pauses, heartbeat.check)
    except JobSuperseded:
        raise
    except Exception as exc:  # reasons per PRD 4.3.5 come with #3; the API queues a Chapter again (PRD 4.3.5 #8)
        log.exception("job %s failed", job.id)
        api.report_failure(job, f"{type(exc).__name__}: {exc}")
