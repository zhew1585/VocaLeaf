"""Keeps a claimed job's lease alive while the worker works on it.

A Chapter can take longer to render on CPU than the lease (default 10 minutes); without heartbeats the API
would hand the job to another worker. A heartbeat refused with 409 means the job was taken over (or ended),
so the worker stops working on it at the next check.
"""

import logging
import threading
from types import TracebackType
from typing import Self

from vocaleaf_worker.api_client import ApiClient, Job, JobSuperseded

log = logging.getLogger(__name__)

# Beat three times per lease, so one or two lost heartbeats do not cost the job.
BEATS_PER_LEASE = 3


class Heartbeat:
    """Context manager: sends heartbeats from a background thread for as long as the block runs."""

    def __init__(self, api: ApiClient, job: Job, interval_seconds: float | None = None):
        self._api = api
        self._job = job
        self._interval = interval_seconds if interval_seconds is not None else job.lease_ms / 1000 / BEATS_PER_LEASE
        self._stop = threading.Event()
        self._superseded = threading.Event()
        self._thread = threading.Thread(target=self._run, name=f"heartbeat-{job.id}", daemon=True)

    def check(self) -> None:
        """Raises JobSuperseded once the API refused a heartbeat; call it between units of work."""
        if self._superseded.is_set():
            raise JobSuperseded(f"heartbeat for job {self._job.id}")

    def _run(self) -> None:
        while not self._stop.wait(self._interval):
            try:
                self._api.heartbeat(self._job)
            except JobSuperseded:
                self._superseded.set()
                return
            except Exception:  # API briefly unreachable: keep beating, the lease has room for a few misses
                log.exception("heartbeat for job %s failed", self._job.id)

    def __enter__(self) -> Self:
        self._thread.start()
        return self

    def __exit__(self, exc_type: type[BaseException] | None, exc: BaseException | None, tb: TracebackType | None):
        self._stop.set()
        self._thread.join()
