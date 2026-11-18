import itertools

import pytest

from vocaleaf_worker.sentences import MAX_SENTENCE_CHARS, TITLES, split_sentences


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
    text = "“Oh! yes,” said Elizabeth drily\ufeff\u2014“Mr. Darcy is all politeness.”"
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
        "The novel by É. Zola sold well.",
        "See No. 4 for details.",
        "It is in Vol. II of the letters.",
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
        ("They sent their thanks, etc. Mrs. Bennet was quite disconcerted.", "They sent their thanks, etc."),
        ("It was not I. Jane did it.", "It was not I."),
        ("He lives at No. 4. The house is big.", "He lives at No. 4."),
    ],
)
def test_ends_a_sentence_on_a_trailing_abbreviation_when_a_new_sentence_clearly_starts(text: str, first: str):
    assert split_sentences(text) == [first, text[len(first) + 1 :]]


def test_ends_a_sentence_on_an_abbreviation_at_the_end_of_a_paragraph():
    assert split_sentences("He moved to the U.S.") == ["He moved to the U.S."]
    assert split_sentences("Come in, Mr.") == ["Come in, Mr."]


def test_ends_a_sentence_when_the_abbreviation_closes_a_quotation():
    assert split_sentences("“Good morning, Mrs.” She left.") == ["“Good morning, Mrs.”", "She left."]


@pytest.mark.parametrize(
    ("text", "first"),
    [
        ("It was not equal to Anne’s. Anne would have been a delight.", "It was not equal to Anne’s."),
        ("He preferred her husband's. Mr. Collins did not.", "He preferred her husband's."),
    ],
)
def test_a_possessive_is_not_an_initial(text: str, first: str):
    assert split_sentences(text) == [first, text[len(first) + 1 :]]


def test_a_title_is_matched_with_its_own_capitalization():
    # "MS." (a manuscript) is not "Ms." (a title).
    assert split_sentences("He found the MS. It was old.") == ["He found the MS.", "It was old."]


# PRD 4.2.6 rule 2: a Sentence over MAX_SENTENCE_CHARS splits at semicolons, then colons, then commas.
def clause(n: int, words: int = 12) -> str:
    return " ".join(f"w{n}x{i}" for i in range(words))


def test_a_short_sentence_with_semicolons_stays_whole():
    assert split_sentences("He came; she went; they stayed.") == ["He came; she went; they stayed."]


def test_an_over_long_sentence_splits_at_semicolons_into_pieces_as_long_as_allowed():
    sentence = "; ".join(clause(n) for n in range(8)) + "."
    assert len(sentence) > MAX_SENTENCE_CHARS

    pieces = split_sentences(sentence)

    assert len(pieces) > 1
    assert all(len(p) <= MAX_SENTENCE_CHARS for p in pieces)
    assert all(p.endswith(";") for p in pieces[:-1])
    assert " ".join(pieces) == sentence
    # Greedy: two neighbouring pieces together would be over the limit, so none could have been merged.
    assert all(len(a) + 1 + len(b) > MAX_SENTENCE_CHARS for a, b in itertools.pairwise(pieces))


def test_falls_back_to_colons_then_commas_when_a_piece_is_still_too_long():
    long_clause = ", ".join(clause(n, 6) for n in range(10))
    sentence = f"{long_clause}: {clause(99)}; {clause(98)}."

    pieces = split_sentences(sentence)

    assert all(len(p) <= MAX_SENTENCE_CHARS for p in pieces)
    assert " ".join(pieces) == sentence
    # The clause before the colon is still too long on its own, so it breaks at commas.
    assert all(p.endswith((";", ":", ",")) for p in pieces[:-1])
    assert any(p.endswith(",") for p in pieces)


def test_a_long_run_without_any_punctuation_splits_between_words():
    sentence = clause(0, 80) + "."

    pieces = split_sentences(sentence)

    assert len(pieces) > 1
    assert all(len(p) <= MAX_SENTENCE_CHARS for p in pieces)
    assert " ".join(pieces) == sentence


def test_the_length_limit_applies_after_splitting_at_sentence_ends():
    paragraph = "It rained. The " + "; ".join(clause(n) for n in range(8)) + ". It stopped."

    pieces = split_sentences(paragraph)

    assert pieces[0] == "It rained."
    assert pieces[-1] == "It stopped."
    assert all(len(p) <= MAX_SENTENCE_CHARS for p in pieces)
