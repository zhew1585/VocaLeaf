"""Test doubles for the worker's three outside channels: the API (over real HTTP code paths, via httpx
MockTransport), object storage and TTS. Audio still goes through the real ffmpeg."""

import json
import math
import re
import struct
import threading
import time

import httpx

from vocaleaf_worker.api_client import ApiClient
from vocaleaf_worker.tts import SAMPLE_RATE, Speech, Voice, Word

TOKEN = "worker-token"


class FakeApi:
    """Records every request the worker makes and answers like the real /internal routes."""

    def __init__(self, job: dict | None, refuse: frozenset[str] = frozenset()):
        self.job = job
        # Last path parts (e.g. "heartbeat", "parse-result") answered with 409, as the API does once
        # another worker has claimed the job again.
        self.refuse = refuse
        self.requests: list[httpx.Request] = []
        self._lock = threading.Lock()

    def handler(self, request: httpx.Request) -> httpx.Response:
        with self._lock:
            self.requests.append(request)
        assert request.headers["Authorization"] == f"Bearer {TOKEN}"
        if request.url.path == "/api/internal/jobs/claim":
            return httpx.Response(200, json=self.job) if self.job else httpx.Response(204)
        return httpx.Response(409 if request.url.path.rsplit("/", 1)[1] in self.refuse else 204)

    def calls(self) -> list[str]:
        """The last path part of every request, e.g. ["claim", "render-progress", "render-result"]."""
        return [r.url.path.rsplit("/", 1)[1] for r in self.requests]

    def bodies(self, call: str) -> list[dict]:
        return [json.loads(r.content) for r in self.requests if r.url.path.endswith(f"/{call}")]


class FakeStorage:
    def __init__(self, objects: dict[str, bytes] | None = None):
        self.objects = dict(objects or {})
        self.content_types: dict[str, str] = {}

    def get_object(self, key: str) -> bytes:
        return self.objects[key]

    def put_object(self, key: str, body: bytes, content_type: str) -> None:
        self.objects[key] = body
        self.content_types[key] = content_type


def tone(ms: int) -> bytes:
    """A 440 Hz tone as 16-bit mono PCM."""
    n = SAMPLE_RATE * ms // 1000
    return b"".join(struct.pack("<h", int(8000 * math.sin(2 * math.pi * 440 * i / SAMPLE_RATE))) for i in range(n))


def silence(ms: int) -> bytes:
    return b"\x00\x00" * (SAMPLE_RATE * ms // 1000)


class FakeTts:
    """Speaks like Kokoro, in shape: a short lead-in silence, every word as a tone of `word_ms`, a natural pause
    after each sentence-ending word, trailing silence, and a timestamp per spoken word (none for punctuation).

    `drop_words_of` makes the timestamps skip every word of that text when it is part of a longer input, as a
    TTS that mangles a Sentence would; spoken alone it is timed normally.
    """

    LEAD_MS = 50
    NATURAL_PAUSE_MS = 250
    TRAIL_MS = 300

    def __init__(
        self, word_ms: int = 300, delay_seconds: float = 0, fail_on: str | None = None, drop_words_of: str | None = None
    ):
        self.word_ms = word_ms
        self.delay_seconds = delay_seconds
        self.fail_on = fail_on
        self.drop_words_of = drop_words_of
        self.calls: list[tuple[str, Voice]] = []
        self._word = tone(word_ms)

    def synthesize(self, text: str, voice: Voice) -> Speech:
        self.calls.append((text, voice))
        time.sleep(self.delay_seconds)
        if self.fail_on and self.fail_on in text:
            raise httpx.ConnectError("kokoro unreachable")
        dropped = range(0)
        if self.drop_words_of and text != self.drop_words_of and (found := text.find(self.drop_words_of)) >= 0:
            dropped = range(found, found + len(self.drop_words_of))
        pcm, words, at = [silence(self.LEAD_MS)], [], self.LEAD_MS
        for match in re.finditer(r"\S+", text):
            token = match.group()
            pcm.append(self._word)
            if match.start() not in dropped:
                words.append(Word(token.strip('.,;!?"“”'), at, at + self.word_ms))
            at += self.word_ms
            if token.endswith((".", "!", "?")):
                pcm.append(silence(self.NATURAL_PAUSE_MS))
                at += self.NATURAL_PAUSE_MS
        pcm.append(silence(self.TRAIL_MS))
        return Speech(b"".join(pcm), tuple(words))


def client(api: FakeApi) -> ApiClient:
    http = httpx.Client(base_url="http://api:3000", transport=httpx.MockTransport(api.handler))
    return ApiClient(http, TOKEN)
