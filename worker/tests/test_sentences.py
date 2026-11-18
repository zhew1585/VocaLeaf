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
