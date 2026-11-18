"""Worker process: polls the API for jobs forever. Configured only by environment variables;
note there is deliberately no database setting (ADR 0002)."""

import logging
import os
import time

import httpx

from vocaleaf_worker.api_client import ApiClient
from vocaleaf_worker.narration import Pauses
from vocaleaf_worker.storage import S3Storage
from vocaleaf_worker.tts import KokoroTts
from vocaleaf_worker.worker import run_once

log = logging.getLogger("vocaleaf_worker")


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)  # one line per poll is noise
    env = os.environ
    poll_seconds = float(env.get("POLL_INTERVAL_SECONDS", "2"))
    api = ApiClient(httpx.Client(base_url=env["API_URL"], timeout=60), env["WORKER_TOKEN"])
    storage = S3Storage(
        endpoint=env["S3_ENDPOINT"],
        region=env.get("S3_REGION", "auto"),
        bucket=env["S3_BUCKET"],
        access_key_id=env["S3_ACCESS_KEY_ID"],
        secret_access_key=env["S3_SECRET_ACCESS_KEY"],
    )
    # One long Sentence can take Kokoro tens of seconds on CPU.
    tts = KokoroTts(httpx.Client(base_url=env["KOKORO_URL"], timeout=300))
    pauses = Pauses.from_env(env)  # fails fast on a malformed value
    log.info("worker started, polling %s, pauses %s", env["API_URL"], pauses)
    while True:
        try:
            if run_once(api, storage, tts, pauses):
                continue
        except Exception:  # API unreachable or rejected a call: log, back off, keep polling
            log.exception("job cycle failed")
        time.sleep(poll_seconds)


if __name__ == "__main__":
    main()
