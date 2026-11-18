from vocaleaf_worker.sentences import split_sentences


def test_splits_on_terminal_punctuation():
    assert split_sentences("It rained. Was it cold? Yes! Then… Silence.") == [
        "It rained.",
        "Was it cold?",
        "Yes!",
        "Then…",
        "Silence.",
    ]


def test_keeps_closing_quotes_with_their_sentence():
    assert split_sentences("“Is he married or single?” “Oh! single, my dear.”") == [
        "“Is he married or single?”",
        "“Oh! single, my dear.”",
    ]


def test_does_not_split_before_a_lowercase_continuation():
    assert split_sentences("“Oh! single, my dear, to be sure!” she said.") == [
        "“Oh! single, my dear, to be sure!” she said."
    ]


def test_does_not_split_inside_numbers_or_without_a_following_space():
    assert split_sentences("It cost 4.5 pounds.It was cheap.") == ["It cost 4.5 pounds.It was cheap."]


def test_a_paragraph_without_terminal_punctuation_is_one_sentence():
    assert split_sentences("Chapter I") == ["Chapter I"]


def test_empty_and_blank_paragraphs_yield_nothing():
    assert split_sentences("") == []
    assert split_sentences("   ") == []


# ---- Abbreviations (PRD 4.2.6 rule 1, AC-UP-08) ----

import pytest

from vocaleaf_worker.sentences import TITLES


@pytest.mark.parametrize("title", TITLES)
def test_never_ends_a_sentence_on_a_title_before_a_name(title: str):
    assert split_sentences(f"Then {title}. Holmes said nothing. He left.") == [
        f"Then {title}. Holmes said nothing.",
        "He left.",
    ]


@pytest.mark.parametrize(
    "text",
    [
        "Mr. Bennet replied that he had not.",
        "Mrs. Long has just been here.",
        "Ms. Lucas came.",
        "Dr. Watson arrived.",
        "They walked to St. Paul's together.",
        "Prof. Moriarty smiled.",
        "Rev. Collins bowed.",
        "Capt. Carter waved.",
        "Col. Forster laughed.",
        "Gen. Tilney frowned.",
        "Lt. Wickham danced.",
        "Gov. Phillips spoke.",
    ],
)
def test_keeps_each_title_with_the_name_it_belongs_to(text: str):
    assert split_sentences(text) == [text]


def test_finds_a_title_joined_to_the_word_before_by_a_dash():
    text = "“Oh! yes,” said Elizabeth drily\ufeff—“Mr. Darcy is all politeness.”"
    assert split_sentences(text) == [text]


def test_keeps_a_title_inside_quoted_dialogue_with_its_name():
    assert split_sentences("“My dear Mr. Bennet,” said his lady to him one day, “have you heard?” He had not.") == [
        "“My dear Mr. Bennet,” said his lady to him one day, “have you heard?”",
        "He had not.",
    ]


@pytest.mark.parametrize(
    "text",
    [
        "Cats vs. Dogs was the debate.",
        "Bring fruit, e.g. Apples or pears.",
        "One answer, i.e. The first, was right.",
    ],
)
def test_never_ends_a_sentence_on_an_abbreviation_that_introduces_what_follows(text: str):
    assert split_sentences(text) == [text]


@pytest.mark.parametrize(
    "text",
    [
        "Martin Luther King Jr. Was a minister.",
        "John Smith Sr. Owned the mill.",
        "Apples, pears, etc. Were on the table.",
        "The book by J. K. Rowling sold well.",
        "It was signed by E. Darcy himself.",
        "The U.S. Army marched.",
    ],
)
def test_keeps_names_initials_and_trailing_abbreviations_with_what_follows(text: str):
    assert split_sentences(text) == [text]


@pytest.mark.parametrize(
    ("text", "first"),
    [
        ("He moved to the U.S. The weather was better.", "He moved to the U.S."),
        ("We bought apples, pears, etc. Then we went home.", "We bought apples, pears, etc."),
        ("The letter was from John Smith Jr. He wrote it at night.", "The letter was from John Smith Jr."),
        ("The answer is plan B. It always is.", "The answer is plan B."),
    ],
)
def test_ends_a_sentence_on_a_trailing_abbreviation_when_a_new_sentence_clearly_starts(text: str, first: str):
    assert split_sentences(text) == [first, text[len(first) + 1 :]]


def test_ends_a_sentence_on_an_abbreviation_at_the_end_of_a_paragraph():
    assert split_sentences("He moved to the U.S.") == ["He moved to the U.S."]
    assert split_sentences("Come in, Mr.") == ["Come in, Mr."]


def test_ends_a_sentence_when_the_abbreviation_closes_a_quotation():
    assert split_sentences("“Good morning, Mrs.” She left.") == ["“Good morning, Mrs.”", "She left."]
