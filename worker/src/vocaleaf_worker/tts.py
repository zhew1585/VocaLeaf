"""Text-to-speech behind one small interface (ADR 0001): self-hosted Kokoro now, other providers later.

Kokoro runs as Kokoro-FastAPI; its `/dev/captioned_speech` endpoint returns raw PCM and word-level timestamps
in one call. The model file is pinned in compose (ADR 0003), so development and production sound the same.
"""

import base64
import re
from dataclasses import dataclass
from typing import Literal, Protocol

import httpx

Voice = Literal["us_female", "us_male", "uk_female", "uk_male"]

# PRD 4.2.4 and 4.7.2 (technical config): the Kokoro voice behind each Voice, confirmed by listening (#2).
KOKORO_VOICES: dict[Voice, str] = {
    "us_female": "af_heart",
    "us_male": "am_michael",
    "uk_female": "bf_emma",
    "uk_male": "bm_george",
}

# Kokoro returns 16-bit mono PCM at 24 kHz.
SAMPLE_RATE = 24_000
BYTES_PER_SAMPLE = 2

# A timestamp entry that is only punctuation is not a word.
_WORDLIKE = re.compile(r"\w")


@dataclass(frozen=True)
class Word:
    word: str
    # Milliseconds from the start of this speech.
    start_ms: int
    end_ms: int


@dataclass(frozen=True)
class Speech:
    """Synthesized audio for one input (a Sentence or a passage of several): 16-bit mono PCM at SAMPLE_RATE,
    and when each spoken word is said, from the start of the audio."""

    pcm: bytes
    words: tuple[Word, ...]

    @property
    def duration_ms(self) -> int:
        return samples_to_ms(len(self.pcm) // BYTES_PER_SAMPLE)


def samples_to_ms(samples: int) -> int:
    return round(samples * 1000 / SAMPLE_RATE)


class Tts(Protocol):
    def synthesize(self, text: str, voice: Voice) -> Speech: ...


class KokoroTts:
    def __init__(self, http: httpx.Client) -> None:
        self._http = http

    def synthesize(self, text: str, voice: Voice) -> Speech:
        res = self._http.post(
            "/dev/captioned_speech",
            json={
                "model": "kokoro",
                "input": text,
                "voice": KOKORO_VOICES[voice],
                "response_format": "pcm",
                "stream": False,
                "return_timestamps": True,
                "speed": 1.0,
            },
        )
        res.raise_for_status()
        data = res.json()
        pcm = base64.b64decode(data["audio"])
        duration_ms = samples_to_ms(len(pcm) // BYTES_PER_SAMPLE)
        return Speech(pcm=pcm, words=words_from_timestamps(data.get("timestamps") or [], duration_ms))


def words_from_timestamps(timestamps: list[dict], duration_ms: int) -> tuple[Word, ...]:
    """Kokoro's timestamps (seconds, may start slightly below zero, include punctuation) as words in ms."""

    def ms(seconds: float) -> int:
        return min(max(round(seconds * 1000), 0), duration_ms)

    return tuple(
        Word(t["word"], ms(t["start_time"]), ms(t["end_time"])) for t in timestamps if _WORDLIKE.search(t["word"])
    )
