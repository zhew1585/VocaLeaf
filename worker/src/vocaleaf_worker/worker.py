"""The worker's job cycle. Stateless: all state lives behind the API, files in object storage."""

import logging

from vocaleaf_worker.api_client import ApiClient
from vocaleaf_worker.epub_parser import PARSER_VERSION, parse_epub
from vocaleaf_worker.storage import SourceStorage

log = logging.getLogger(__name__)


def run_once(api: ApiClient, storage: SourceStorage) -> bool:
    """Claims and runs one job. Returns False when nothing was queued."""
    job = api.claim()
    if job is None:
        return False
    log.info("job %s: %s book %s", job.id, job.type, job.book_id)
    try:
        book = parse_epub(storage.get_object(job.source_key))
    except Exception as exc:  # any unreadable input fails the job; reasons per PRD 4.3.5 come with #3
        log.exception("job %s failed", job.id)
        api.report_failure(job.id, f"{type(exc).__name__}: {exc}")
        return True
    api.report_parse_result(job.id, book, PARSER_VERSION)
    log.info("job %s: %d chapters", job.id, len(book.chapters))
    return True
