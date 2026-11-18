"""How a Chapter's Sentences become one natural narration.

Sentences of one paragraph are synthesized together as a passage, so the voice carries intonation across them
instead of reading every Sentence on its own flat contour. The TTS's word timestamps then map the passage's
audio back to each Sentence, and the Chapter is laid out with configured pauses (PRD 4.7.2) between the voiced
spans: at the Chapter start, between Sentences, and between paragraphs. A Sentence's time is exactly its
voiced span; the pauses around it belong to no Sentence.
"""

import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass

from vocaleaf_worker.api_client import SentenceToSpeak, TimedSentence
from vocaleaf_worker.tts import BYTES_PER_SAMPLE, SAMPLE_RATE, Speech, Word, samples_to_ms

# A passage sent to the TTS stays within one Kokoro inference pass (about 250 phoneme tokens). Longer paragraphs
# are split at Sentence boundaries; a single longer Sentence goes alone, and Kokoro splits it itself.
MAX_PASSAGE_CHARS = 400

# Audio kept around a voiced span so word onsets and decays are not clipped. Never more than half the pause it
# sits in, so neighbouring Sentences never overlap.
VOICE_MARGIN_MS = 100

# How far ahead of the expected word a TTS word may match. Small, so a word the TTS spelled out cannot match a
# far later word that happens to be the same.
ALIGN_LOOKAHEAD = 4

# Letters and digits in any script; everything else is dropped before words are compared.
_NOT_WORD = re.compile(r"[\W_]")

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
        """Reads PAUSE_SENTENCE_MS, PAUSE_PARAGRAPH_MS and PAUSE_CHAPTER_START_MS; refuses anything that is not a
        whole, non-negative number of milliseconds."""

        def read(name: str, default: int) -> int:
            raw = env.get(name, str(default))
            if not raw.isdigit():
                raise ValueError(f"{name} must be a whole number of milliseconds, got {raw!r}")
            return int(raw)

        return Pauses(
            sentence_ms=read("PAUSE_SENTENCE_MS", 300),
            paragraph_ms=read("PAUSE_PARAGRAPH_MS", 800),
            chapter_start_ms=read("PAUSE_CHAPTER_START_MS", 1500),
        )


def plan_passages(
    sentences: Sequence[SentenceToSpeak], max_chars: int = MAX_PASSAGE_CHARS
) -> list[list[SentenceToSpeak]]:
    """Groups consecutive Sentences of one paragraph into passages of at most `max_chars` characters."""
    passages: list[list[SentenceToSpeak]] = []
    for sentence in sentences:
        current = passages[-1] if passages else None
        fits = current is not None and (
            current[-1].paragraph_index == sentence.paragraph_index
            and sum(len(x.spoken_text) + 1 for x in current) + len(sentence.spoken_text) <= max_chars
        )
        if current is not None and fits:
            current.append(sentence)
        else:
            passages.append([sentence])
    return passages


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
    return _NOT_WORD.sub("", word.lower())


def has_words(sentence: SentenceToSpeak) -> bool:
    """Whether the Sentence has anything to voice (not just punctuation such as a "* * *" scene break)."""
    return bool(_normalize(sentence.spoken_text))


def align_words(sentences: Sequence[SentenceToSpeak], words: tuple[Word, ...]) -> list[tuple[Word, ...]] | None:
    """Assigns the TTS's words for a passage to the passage's Sentences, in order.

    Each TTS word is looked for among the next few words of the text. A word the TTS spelled differently
    ("Mister" for "Mr.", "eighteen eleven" for "1811") stays with the Sentence being read, and a match in a
    later Sentence may skip words only once the TTS has said something for them, so "one" for "Chapter 1." is
    not taken for the "One" opening the next Sentence. Returns None unless every Sentence has words to find and
    at least half of them were found, so the caller can speak the passage one Sentence at a time instead.
    """
    expected = [
        (normalized, index)
        for index, sentence in enumerate(sentences)
        for normalized in (_normalize(token) for token in sentence.spoken_text.split())
        if normalized
    ]
    own_words = [sum(1 for _, index in expected if index == i) for i in range(len(sentences))]
    if not expected or (len(sentences) > 1 and 0 in own_words):
        return None
    assigned: list[list[Word]] = [[] for _ in sentences]
    found = [0] * len(sentences)
    cursor = 0
    unmatched = 0  # TTS words said since the last match
    for word in words:
        normalized = _normalize(word.word)
        forms = {normalized, _SPOKEN_AS.get(normalized, normalized)}
        current = expected[min(cursor, len(expected) - 1)][1]
        window = range(cursor, min(cursor + ALIGN_LOOKAHEAD, len(expected)))
        match = next(
            (
                j
                for j in window
                if expected[j][0] in forms and (j == cursor or expected[j][1] == current or unmatched > 0)
            ),
            None,
        )
        if match is None:
            assigned[current].append(word)
            unmatched += 1
            continue
        assigned[expected[match][1]].append(word)
        found[expected[match][1]] += 1
        cursor, unmatched = match + 1, 0
    if any(2 * found[i] < own_words[i] for i in range(len(sentences))):
        return None
    return [tuple(ws) for ws in assigned]


def _to_samples(ms: int) -> int:
    return ms * SAMPLE_RATE // 1000


@dataclass(frozen=True)
class SpokenSentence:
    """One Sentence of a synthesized passage, with the TTS's words for it (times from the passage start)."""

    sentence: SentenceToSpeak
    words: tuple[Word, ...]


class ChapterAssembler:
    """Lays a Chapter's passages end to end, replacing the TTS's own pauses with the configured ones.

    Built with the pause before every Sentence of the Chapter (see pauses_before); `add` takes the passages in
    order and returns the PCM to append and each Sentence's time from the Chapter start.
    """

    def __init__(self, pauses_ms: Sequence[int]) -> None:
        self._pauses = [_to_samples(p) for p in pauses_ms]
        self._margin = _to_samples(VOICE_MARGIN_MS)
        self._sentence_index = 0  # position in the Chapter of the next Sentence to add
        self._written = 0  # samples emitted so far
        self._voice_end = 0  # where the previous Sentence's voice ended

    def _voiced_span(self, spoken: SpokenSentence, total: int) -> tuple[int, int]:
        if spoken.words:
            return _to_samples(spoken.words[0].start_ms), _to_samples(spoken.words[-1].end_ms)
        # No timestamps: all of the audio if there was something to say, none of it for a bare "* * *".
        return (0, total) if has_words(spoken.sentence) else (0, 0)

    def add(self, passage: Sequence[SpokenSentence], speech: Speech) -> tuple[bytes, list[TimedSentence]]:
        total = len(speech.pcm) // BYTES_PER_SAMPLE
        spans = [self._voiced_span(spoken, total) for spoken in passage]
        out: list[bytes] = []
        timed: list[TimedSentence] = []
        for k, spoken in enumerate(passage):
            voice_start, voice_end = spans[k]
            # The clip around the voiced span: a margin each side, cut halfway into the TTS's own pause.
            clip_start = max(voice_start - self._margin, (spans[k - 1][1] + voice_start) // 2 if k > 0 else 0)
            clip_end = min(
                voice_end + self._margin, (voice_end + spans[k + 1][0]) // 2 if k + 1 < len(spans) else total
            )
            pause = self._pauses[self._sentence_index]
            has_next = self._sentence_index + 1 < len(self._pauses)
            pause_after = self._pauses[self._sentence_index + 1] if has_next else 2 * self._margin
            head = max(0, min(voice_start - clip_start, pause // 2))
            tail = max(0, min(clip_end - voice_end, pause_after // 2))

            start = self._voice_end + pause
            out.append(b"\x00\x00" * (start - head - self._written))
            out.append(speech.pcm[(voice_start - head) * BYTES_PER_SAMPLE : (voice_end + tail) * BYTES_PER_SAMPLE])
            self._voice_end = start + voice_end - voice_start
            self._written = self._voice_end + tail
            self._sentence_index += 1
            timed.append(self._timed(spoken, start, voice_start))
        return b"".join(out), timed

    def _timed(self, spoken: SpokenSentence, start: int, voice_start: int) -> TimedSentence:
        start_ms, end_ms = samples_to_ms(start), samples_to_ms(self._voice_end)
        offset_ms, length_ms = samples_to_ms(voice_start), end_ms - start_ms

        def clamp(ms: int) -> int:
            return min(max(ms - offset_ms, 0), length_ms)

        words = tuple(Word(x.word, clamp(x.start_ms), clamp(x.end_ms)) for x in spoken.words)
        return TimedSentence(id=spoken.sentence.id, start_ms=start_ms, end_ms=end_ms, words=words)
