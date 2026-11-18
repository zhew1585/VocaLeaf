"""How a Chapter's Sentences become one natural narration.

Sentences of one paragraph are synthesized together, so the voice carries intonation across them instead of
reading every Sentence on its own flat contour. The TTS's word timestamps then map the chunk's audio back to
each Sentence, and the Chapter is laid out with configured pauses (PRD 4.7.2) between the voiced spans:
after the Chapter start, between Sentences, and between paragraphs. A Sentence's time is exactly its voiced
span; the pauses around it belong to no Sentence.
"""

import os
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass

from vocaleaf_worker.api_client import SentenceToSpeak, TimedSentence
from vocaleaf_worker.tts import BYTES_PER_SAMPLE, SAMPLE_RATE, Speech, Word

# A chunk sent to the TTS stays within one Kokoro inference pass (about 250 phoneme tokens). Longer paragraphs
# are split at Sentence boundaries; a single longer Sentence goes alone, and Kokoro splits it itself.
MAX_CHUNK_CHARS = 400

# Audio kept around a voiced span so word onsets and decays are not clipped. Never more than half the pause it
# sits in, so neighbouring Sentences never overlap.
VOICE_MARGIN_MS = 100

# How far ahead of the expected word a TTS word may match. Small, so a spelled-out number ("eighteen") cannot
# jump to a later Sentence that happens to contain the same word.
ALIGN_LOOKAHEAD = 4

_NON_ALNUM = re.compile(r"[^a-z0-9]")

# Abbreviations Kokoro reads out as a different word (checked against kokoro-fastapi v0.10.0), so they still match.
_SPOKEN_AS = {"mister": "mr", "doctor": "dr"}


@dataclass(frozen=True)
class Pauses:
    """Silence before a Sentence's voice starts, in ms (technical config, PRD 4.7.2)."""

    sentence_ms: int
    paragraph_ms: int
    chapter_start_ms: int

    @staticmethod
    def from_env(env: Mapping[str, str]) -> "Pauses":
        return Pauses(
            sentence_ms=int(env.get("PAUSE_SENTENCE_MS", "300")),
            paragraph_ms=int(env.get("PAUSE_PARAGRAPH_MS", "800")),
            chapter_start_ms=int(env.get("PAUSE_CHAPTER_START_MS", "1500")),
        )


DEFAULT_PAUSES = Pauses.from_env(os.environ)


def plan_chunks(sentences: Sequence[SentenceToSpeak], max_chars: int = MAX_CHUNK_CHARS) -> list[list[SentenceToSpeak]]:
    """Groups consecutive Sentences of one paragraph into chunks of at most `max_chars` characters."""
    chunks: list[list[SentenceToSpeak]] = []
    for sentence in sentences:
        current = chunks[-1] if chunks else None
        fits = current is not None and (
            current[-1].paragraph_index == sentence.paragraph_index
            and sum(len(x.spoken_text) + 1 for x in current) + len(sentence.spoken_text) <= max_chars
        )
        if current is not None and fits:
            current.append(sentence)
        else:
            chunks.append([sentence])
    return chunks


def pauses_before(sentences: Sequence[SentenceToSpeak], pauses: Pauses) -> list[int]:
    """The pause before each Sentence of a Chapter: the Chapter start, a new paragraph, or the next Sentence."""
    result = []
    for i, sentence in enumerate(sentences):
        if i == 0:
            result.append(pauses.chapter_start_ms)
        elif sentence.paragraph_index != sentences[i - 1].paragraph_index:
            result.append(pauses.paragraph_ms)
        else:
            result.append(pauses.sentence_ms)
    return result


def _normalize(word: str) -> str:
    return _NON_ALNUM.sub("", word.lower())


def align_words(sentences: Sequence[SentenceToSpeak], words: tuple[Word, ...]) -> list[tuple[Word, ...]] | None:
    """Assigns the TTS's words for a chunk to the chunk's Sentences, in order.

    Each TTS word is looked for among the next few words of the text; a word the TTS spelled differently
    ("Mister" for "Mr.", "eighteen eleven" for "1811") stays with the Sentence being read. Returns None unless
    every Sentence had at least half of its own words found, so a TTS that skipped a Sentence (whose neighbour's
    repeated words would otherwise fill the gap) makes the caller synthesize that chunk Sentence by Sentence.
    """
    expected = [
        (normalized, index)
        for index, sentence in enumerate(sentences)
        for normalized in (_normalize(token) for token in sentence.spoken_text.split())
        if normalized
    ]
    assigned: list[list[Word]] = [[] for _ in sentences]
    found = [0] * len(sentences)
    cursor = 0
    for word in words:
        normalized = _normalize(word.word)
        forms = {normalized, _SPOKEN_AS.get(normalized, normalized)}
        window = range(cursor, min(cursor + ALIGN_LOOKAHEAD, len(expected)))
        match = next((j for j in window if expected[j][0] in forms), None)
        if match is not None:
            assigned[expected[match][1]].append(word)
            found[expected[match][1]] += 1
            cursor = match + 1
        else:
            assigned[expected[min(cursor, len(expected) - 1)][1] if expected else 0].append(word)
    own_words = [sum(1 for _, index in expected if index == i) for i in range(len(sentences))]
    if any(2 * found[i] < own_words[i] for i in range(len(sentences))):
        return None
    return [tuple(ws) for ws in assigned]


def _to_samples(ms: int) -> int:
    return ms * SAMPLE_RATE // 1000


def _to_ms(samples: int) -> int:
    return round(samples * 1000 / SAMPLE_RATE)


class ChapterAssembler:
    """Lays a Chapter's chunks end to end, replacing the TTS's own pauses with the configured ones.

    Built with the pause before every Sentence of the Chapter (see pauses_before); `add` takes the chunks in
    order and returns the PCM to append and each Sentence's time from the Chapter start.
    """

    def __init__(self, pauses_ms: Sequence[int]) -> None:
        self._pauses = [_to_samples(p) for p in pauses_ms]
        self._margin = _to_samples(VOICE_MARGIN_MS)
        self._next = 0  # index of the next Sentence in the Chapter
        self._written = 0  # samples emitted so far
        self._voice_end = 0  # where the previous Sentence's voice ended

    def add(
        self, sentences: Sequence[SentenceToSpeak], speech: Speech, words: Sequence[tuple[Word, ...]]
    ) -> tuple[bytes, list[TimedSentence]]:
        total = len(speech.pcm) // BYTES_PER_SAMPLE
        spans = [(_to_samples(ws[0].start_ms), _to_samples(ws[-1].end_ms)) if ws else (0, total) for ws in words]
        out: list[bytes] = []
        timed: list[TimedSentence] = []
        for k, sentence in enumerate(sentences):
            voice_start, voice_end = spans[k]
            # The clip around the voiced span: a margin each side, cut halfway into the TTS's own pause.
            clip_start = max(voice_start - self._margin, (spans[k - 1][1] + voice_start) // 2 if k > 0 else 0)
            clip_end = min(
                voice_end + self._margin, (voice_end + spans[k + 1][0]) // 2 if k + 1 < len(spans) else total
            )
            pause = self._pauses[self._next]
            pause_after = self._pauses[self._next + 1] if self._next + 1 < len(self._pauses) else 2 * self._margin
            head = min(voice_start - clip_start, pause // 2)
            tail = min(clip_end - voice_end, pause_after // 2)

            start = self._voice_end + pause
            out.append(b"\x00\x00" * (start - head - self._written))
            out.append(speech.pcm[(voice_start - head) * BYTES_PER_SAMPLE : (voice_end + tail) * BYTES_PER_SAMPLE])
            self._voice_end = start + voice_end - voice_start
            self._written = self._voice_end + tail
            self._next += 1

            start_ms, end_ms = _to_ms(start), _to_ms(self._voice_end)
            offset_ms = _to_ms(voice_start)
            timed.append(
                TimedSentence(
                    id=sentence.id,
                    start_ms=start_ms,
                    end_ms=end_ms,
                    words=tuple(
                        Word(
                            x.word,
                            min(max(x.start_ms - offset_ms, 0), end_ms - start_ms),
                            min(max(x.end_ms - offset_ms, 0), end_ms - start_ms),
                        )
                        for x in words[k]
                    ),
                )
            )
        return b"".join(out), timed
