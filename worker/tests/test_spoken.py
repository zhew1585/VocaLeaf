"""What the narrator reads for a Sentence (PRD 4.2.6 rule 4): numbers and dates as English words."""

import pytest

from vocaleaf_worker.spoken import spoken_text


@pytest.mark.parametrize(
    ("text", "spoken"),
    [
        # Cardinals
        ("He had 3 sisters.", "He had three sisters."),
        ("It cost 25 pounds.", "It cost twenty-five pounds."),
        ("Chapter 12 begins.", "Chapter twelve begins."),
        ("There were 105 of them.", "There were one hundred five of them."),
        ("A sum of 10,000 a year.", "A sum of ten thousand a year."),
        ("1,234,567 souls", "one million two hundred thirty-four thousand five hundred sixty-seven souls"),
        ("It was 0 degrees.", "It was zero degrees."),
        ("3.5 miles", "three point five miles"),
        # Ordinals
        ("the 1st of May", "the first of May"),
        ("the 22nd", "the twenty-second"),
        ("her 3rd ball", "her third ball"),
        ("the 11th hour", "the eleventh hour"),
        ("the 100th time", "the one hundredth time"),
        # Years
        ("In 1811 he came.", "In eighteen eleven he came."),
        ("in 1905", "in nineteen oh five"),
        ("in 1900", "in nineteen hundred"),
        ("in 2000", "in two thousand"),
        ("in 2008", "in two thousand eight"),
        ("in 2024", "in twenty twenty-four"),
        ("the 1790s", "the seventeen nineties"),
        ("the 1900s", "the nineteen hundreds"),
        # Dates
        ("On May 5, 1811, it rained.", "On May fifth, eighteen eleven, it rained."),
        ("On 5 May 1811 it rained.", "On the fifth of May eighteen eleven it rained."),
        ("by June 21st", "by June twenty-first"),
        # Money, percent, time
        ("It cost $5.", "It cost five dollars."),
        ("It cost $1.", "It cost one dollar."),
        ("It cost $3.50 in all.", "It cost three dollars and fifty cents in all."),
        ("a debt of £20", "a debt of twenty pounds"),
        ("a debt of £1", "a debt of one pound"),
        ("a fortune of $2.5 billion", "a fortune of two point five billion dollars"),
        ("£10,000 a year", "ten thousand pounds a year"),
        ("$1.5", "one point five dollars"),
        ("50% of it", "fifty percent of it"),
        ("at 10:30 sharp", "at ten thirty sharp"),
        ("at 9:05", "at nine oh five"),
        ("at 10:00", "at ten o'clock"),
        ("at 12:00 a.m.", "at twelve a.m."),
        ("at 3:00 PM", "at three PM"),
    ],
)
def test_numbers_and_dates_are_read_as_words(text, spoken):
    assert spoken_text(text) == spoken


def test_text_without_numbers_is_unchanged():
    text = "“My dear Mr. Bennet,” said his lady to him one day, “have you heard that Netherfield Park is let at last?”"

    assert spoken_text(text) == text


def test_a_number_that_ends_a_sentence_keeps_its_period():
    assert spoken_text("He was 5. She was 7.") == "He was five. She was seven."
