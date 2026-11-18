"""How a Chapter's Sentences become one narration: grouped into paragraph chunks for synthesis, the chunk's
words mapped back to Sentences, and the audio laid out with configured pauses between voiced spans."""

import struct

import pytest

from vocaleaf_worker.api_client import SentenceToSpeak
from vocaleaf_worker.narration import ChapterAssembler, Pauses, align_words, pauses_before, plan_chunks
from vocaleaf_worker.tts import SAMPLE_RATE, Speech, Word

PAUSES = Pauses(sentence_ms=300, paragraph_ms=800, chapter_start_ms=1500)


def s(id: str, text: str, paragraph: int) -> SentenceToSpeak:
    return SentenceToSpeak(id=id, spoken_text=text, paragraph_index=paragraph)


class TestPlanChunks:
    def test_groups_the_sentences_of_each_paragraph(self):
        sentences = [s("a", "One.", 0), s("b", "Two.", 0), s("c", "Three.", 1)]

        chunks = plan_chunks(sentences, max_chars=400)

        assert [[x.id for x in c] for c in chunks] == [["a", "b"], ["c"]]

    def test_splits_a_long_paragraph_at_sentence_boundaries(self):
        sentences = [s(str(i), "x" * 150 + ".", 0) for i in range(5)]

        chunks = plan_chunks(sentences, max_chars=400)

        assert [[x.id for x in c] for c in chunks] == [["0", "1"], ["2", "3"], ["4"]]

    def test_keeps_a_sentence_longer_than_the_limit_whole_and_alone(self):
        sentences = [s("a", "Short.", 0), s("b", "y" * 500, 0), s("c", "End.", 0)]

        assert [[x.id for x in c] for c in plan_chunks(sentences, max_chars=400)] == [["a"], ["b"], ["c"]]


class TestPausesBefore:
    def test_opens_the_chapter_and_separates_paragraphs_more_than_sentences(self):
        sentences = [s("a", "A.", 0), s("b", "B.", 0), s("c", "C.", 3), s("d", "D.", 3)]

        assert pauses_before(sentences, PAUSES) == [1500, 300, 800, 300]


def w(word: str, start: int, end: int) -> Word:
    return Word(word, start, end)


class TestAlignWords:
    def test_gives_each_sentence_its_own_words(self):
        sentences = [s("a", "It is a truth.", 0), s("b", "However little known.", 0)]
        words = [w("It", 0, 100), w("is", 100, 200), w("a", 200, 250), w("truth", 250, 600)]
        words += [w("However", 800, 1200), w("little", 1200, 1500), w("known", 1500, 1900)]

        aligned = align_words(sentences, tuple(words))

        assert aligned is not None
        assert [[x.word for x in ws] for ws in aligned] == [["It", "is", "a", "truth"], ["However", "little", "known"]]

    def test_keeps_words_the_tts_spelled_out_with_the_sentence_they_came_from(self):
        sentences = [s("a", "Mr. Bennet paid 1811 pounds.", 0), s("b", "1811 was a good year.", 0)]
        words = [w("Mister", 0, 1), w("Bennet", 1, 2), w("paid", 2, 3), w("eighteen", 3, 4), w("eleven", 4, 5)]
        words += [w("pounds", 5, 6), w("eighteen", 7, 8), w("eleven", 8, 9), w("was", 9, 10), w("a", 10, 11)]
        words += [w("good", 11, 12), w("year", 12, 13)]

        aligned = align_words(sentences, tuple(words))

        assert aligned is not None
        assert [len(ws) for ws in aligned] == [6, 6]
        assert aligned[1][0].word == "eighteen"

    def test_matches_a_title_the_tts_spells_out_even_when_it_is_a_sentence_of_its_own(self):
        # Until #3 keeps "Mr." with the name, the splitter makes it a Sentence; Kokoro reads it as "Mister".
        sentences = [
            s("a", "“My dear Mr.", 0),
            s("b", "Bennet,” said his lady.", 0),
            s("c", "Dr.", 0),
            s("d", "Jones came.", 0),
        ]
        words = [w("My", 0, 1), w("dear", 1, 2), w("Mister", 2, 3), w("Bennet", 3, 4), w("said", 4, 5)]
        words += [w("his", 5, 6), w("lady", 6, 7), w("Doctor", 8, 9), w("Jones", 9, 10), w("came", 10, 11)]

        aligned = align_words(sentences, tuple(words))

        assert aligned is not None
        assert [[x.word for x in ws] for ws in aligned] == [
            ["My", "dear", "Mister"],
            ["Bennet", "said", "his", "lady"],
            ["Doctor"],
            ["Jones", "came"],
        ]

    def test_still_matches_the_spelled_out_word_itself(self):
        sentences = [s("a", "The doctor came.", 0), s("b", "Mister Collins left.", 0)]
        words = [w("The", 0, 1), w("doctor", 1, 2), w("came", 2, 3), w("Mister", 3, 4), w("Collins", 4, 5)]
        words += [w("left", 5, 6)]

        aligned = align_words(sentences, tuple(words))

        assert aligned is not None
        assert [len(ws) for ws in aligned] == [3, 3]

    def test_matches_hyphenated_and_quoted_words(self):
        sentences = [s("a", "He was three-and-twenty.", 0), s("b", "“My dear,” said she.", 0)]
        words = [w("He", 0, 1), w("was", 1, 2), w("three-and-twenty", 2, 3), w("My", 4, 5), w("dear", 5, 6)]
        words += [w("said", 6, 7), w("she", 7, 8)]

        aligned = align_words(sentences, tuple(words))

        assert aligned is not None
        assert [[x.word for x in ws] for ws in aligned] == [
            ["He", "was", "three-and-twenty"],
            ["My", "dear", "said", "she"],
        ]

    def test_gives_up_when_a_sentence_borrows_its_neighbours_words(self):
        # The TTS lost "It is lost."; the next Sentence's "It is" must not be taken as b's words.
        sentences = [s("a", "It is a truth.", 0), s("b", "It is lost.", 0), s("c", "It is known.", 0)]
        words = [w("It", 0, 1), w("is", 1, 2), w("a", 2, 3), w("truth", 3, 4)]
        words += [w("It", 5, 6), w("is", 6, 7), w("known", 7, 8)]

        assert align_words(sentences, tuple(words)) is None

    def test_gives_up_when_a_sentence_with_words_gets_none(self):
        sentences = [s("a", "It is a truth.", 0), s("b", "However little known.", 0)]
        words = (w("It", 0, 1), w("is", 1, 2), w("a", 2, 3), w("truth", 3, 4))

        assert align_words(sentences, words) is None


def tone(ms: int) -> bytes:
    return struct.pack("<h", 8000) * (SAMPLE_RATE * ms // 1000)


def silence(ms: int) -> bytes:
    return b"\x00\x00" * (SAMPLE_RATE * ms // 1000)


def samples(pcm: bytes) -> list[int]:
    return [v for (v,) in struct.iter_unpack("<h", pcm)]


class TestChapterAssembler:
    """Chunk audio: 50 ms lead silence, sentence a voiced 1000 ms, 400 ms natural pause, sentence b voiced 600 ms,
    then 300 ms trailing silence. The assembler must replace natural pauses with the configured ones."""

    chunk_pcm = silence(50) + tone(1000) + silence(400) + tone(600) + silence(300)
    chunk_words = (w("It", 50, 550), w("is", 550, 1050), w("Fine", 1450, 2050))

    def assemble(self, sentences: list[SentenceToSpeak]):
        assembler = ChapterAssembler(pauses_before(sentences, PAUSES))
        pcm, timed = assembler.add(
            sentences,
            Speech(self.chunk_pcm, self.chunk_words),
            [
                self.chunk_words[:2],
                self.chunk_words[2:],
            ],
        )
        return pcm, timed

    def test_places_voiced_spans_after_the_configured_pauses_and_excludes_silence_from_sentence_times(self):
        _pcm, timed = self.assemble([s("a", "It is.", 0), s("b", "Fine.", 0)])

        assert [(t.id, t.start_ms, t.end_ms) for t in timed] == [("a", 1500, 2500), ("b", 2800, 3400)]

    def test_puts_only_silence_or_the_spoken_audio_where_it_belongs(self):
        pcm, _timed = self.assemble([s("a", "It is.", 0), s("b", "Fine.", 0)])
        values = samples(pcm)
        at = lambda ms: values[SAMPLE_RATE * ms // 1000]

        assert all(v == 0 for v in values[: SAMPLE_RATE * 1400 // 1000])  # lead-in, before the head margin
        assert at(1600) != 0 and at(2400) != 0  # sentence a
        assert at(2650) == 0  # the gap between a and b
        assert at(3000) != 0  # sentence b
        # The chunk's audio ends a margin after b's last word.
        assert len(values) <= SAMPLE_RATE * (3400 + 100) // 1000

    def test_uses_the_paragraph_pause_between_paragraphs(self):
        _, timed = self.assemble([s("a", "It is.", 0), s("b", "Fine.", 1)])

        assert timed[1].start_ms - timed[0].end_ms == 800

    def test_keeps_word_timings_inside_each_sentence_relative_to_its_start(self):
        _, timed = self.assemble([s("a", "It is.", 0), s("b", "Fine.", 0)])

        assert timed[0].words == (w("It", 0, 500), w("is", 500, 1000))
        assert timed[1].words == (w("Fine", 0, 600),)

    def test_continues_the_timeline_across_chunks(self):
        sentences = [s("a", "It is.", 0), s("b", "Fine.", 0), s("c", "Again.", 0)]
        assembler = ChapterAssembler(pauses_before(sentences, PAUSES))
        first_pcm, _ = assembler.add(
            sentences[:2],
            Speech(self.chunk_pcm, self.chunk_words),
            [
                self.chunk_words[:2],
                self.chunk_words[2:],
            ],
        )
        _, timed = assembler.add(
            sentences[2:],
            Speech(silence(50) + tone(500) + silence(200), (w("Again", 50, 550),)),
            [(w("Again", 50, 550),)],
        )

        # Chunks of one paragraph are joined by the sentence pause, not the paragraph pause.
        assert (timed[0].start_ms, timed[0].end_ms) == (3700, 4200)
        assert len(first_pcm) // 2 <= SAMPLE_RATE * 3550 // 1000

    def test_times_a_sentence_the_tts_gave_no_words_as_its_whole_audio(self):
        sentences = [s("a", "* * *", 0)]
        assembler = ChapterAssembler(pauses_before(sentences, PAUSES))

        _, timed = assembler.add(sentences, Speech(tone(400), ()), [()])

        assert (timed[0].start_ms, timed[0].end_ms) == (1500, 1900)


@pytest.mark.parametrize(
    "pauses",
    [
        Pauses(sentence_ms=0, paragraph_ms=0, chapter_start_ms=0),
        Pauses(sentence_ms=50, paragraph_ms=60, chapter_start_ms=10),
    ],
)
def test_never_overlaps_sentences_even_with_tiny_pauses(pauses: Pauses):
    sentences = [s("a", "It is.", 0), s("b", "Fine.", 1)]
    assembler = ChapterAssembler(pauses_before(sentences, pauses))
    words = TestChapterAssembler.chunk_words

    _, timed = assembler.add(sentences, Speech(TestChapterAssembler.chunk_pcm, words), [words[:2], words[2:]])

    assert timed[0].start_ms <= timed[0].end_ms <= timed[1].start_ms <= timed[1].end_ms
