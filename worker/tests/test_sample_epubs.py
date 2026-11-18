"""The committed sample EPUBs (fixtures/) parse the way PRD 4.2.5, 4.2.6 and 4.3.5 say, one sample per rule."""

import pytest

from sample_epubs import FIXTURES, LONG_COMMA_SENTENCE, LONG_SENTENCE, SAMPLES
from vocaleaf_worker.epub_parser import ParseFailed, parse_epub
from vocaleaf_worker.sentences import MAX_SENTENCE_CHARS


@pytest.mark.parametrize("name", SAMPLES)
def test_the_committed_sample_matches_its_builder(name):
    assert (FIXTURES / name).read_bytes() == SAMPLES[name](), "run: uv run python tests/sample_epubs.py"


@pytest.fixture(scope="module")
def rules_book():
    return parse_epub((FIXTURES / "parse-rules.epub").read_bytes())


def chapter(book, title):
    return next(c for c in book.chapters if c.title == title)


def test_non_body_chapters_are_skipped_and_the_preface_is_narrated(rules_book):
    assert [(c.title, c.skipped) for c in rules_book.chapters] == [
        ("Rights", True),  # rule 1: epub:type copyright-page
        ("Map of the Book", True),  # rule 1: the landmarks call it the toc
        ("Dedication", True),  # rule 3: short, no complete Sentence
        ("Preface", False),
        ("Chapter I", False),
        ("Acknowledgments", True),  # rule 2: the title
        ("Index", True),
        ("Endnotes", True),
    ]


def test_mr_holmes_said_stays_one_sentence(rules_book):
    texts = [s.text for s in chapter(rules_book, "Chapter I").sentences]

    assert texts[:2] == ["“Come in,” Mr. Holmes said.", "“You have come 200 miles, I perceive.”"]


def test_note_numbers_and_footnotes_are_not_read(rules_book):
    sentences = chapter(rules_book, "Chapter I").sentences

    assert [s.spoken_text for s in sentences[2:4]] == [
        "It was the third of March, and the fog was thick.",
        "Dr. Watson agreed.",
    ]
    assert not any("footnote" in s.text for s in sentences)


def test_numbers_and_dates_are_spoken_as_words(rules_book):
    preface = chapter(rules_book, "Preface").sentences[0]
    holmes = chapter(rules_book, "Chapter I").sentences[1]

    assert preface.text == "This little book was begun in 1890 and finished on 5 May 1891."
    assert (
        preface.spoken_text
        == "This little book was begun in eighteen ninety and finished on the fifth of May eighteen ninety-one."
    )
    assert holmes.spoken_text == "“You have come two hundred miles, I perceive.”"


@pytest.mark.parametrize(("paragraph", "sentence", "mark"), [(2, LONG_SENTENCE, ";"), (3, LONG_COMMA_SENTENCE, ",")])
def test_an_over_long_sentence_is_split_at_semicolons_or_else_commas(rules_book, paragraph, sentence, mark):
    pieces = [s.text for s in chapter(rules_book, "Chapter I").sentences if s.paragraph_index == paragraph]

    assert len(sentence) > MAX_SENTENCE_CHARS
    assert len(pieces) > 1
    assert all(len(p) <= MAX_SENTENCE_CHARS for p in pieces)
    assert all(p.endswith(mark) for p in pieces[:-1])
    assert " ".join(pieces) == sentence


@pytest.mark.parametrize(
    ("name", "reason"), [("drm.epub", "drm"), ("corrupt.epub", "unreadable"), ("no-text.epub", "no_text")]
)
def test_a_sample_that_cannot_be_parsed_fails_with_its_reason(name, reason):
    with pytest.raises(ParseFailed) as failed:
        parse_epub((FIXTURES / name).read_bytes())

    assert failed.value.reason == reason
