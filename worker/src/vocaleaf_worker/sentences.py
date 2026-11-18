"""Sentence splitting (PRD 4.2.6 rule 1).

Splits after . ! ? or … (plus any closing quotes or brackets) when whitespace and the start of a new sentence
follow. A period that belongs to an abbreviation does not end a Sentence (AC-UP-08); the lists below follow
ebook2audiobook's English abbreviations (ADR 0001). Over-long Sentences, footnote numbers and number spelling
(the rest of PRD 4.2.6) come with #3.
"""

import re

# Titles stand before a name, so a Sentence never ends on one unless the paragraph or a quotation ends there.
TITLES = ("Mr", "Mrs", "Ms", "Messrs", "Dr", "St", "Mt", "Prof", "Rev", "Capt", "Col", "Gen", "Lt", "Gov")

# Abbreviations that introduce what follows them.
LEADING = ("vs", "e.g", "i.e", "cf", "viz")

# Abbreviations that may also end a Sentence, as may an initial ("J.") or an acronym ("U.S."): they end one only
# when the next word is one that clearly opens a Sentence.
TRAILING = ("Jr", "Sr", "etc", "Esq")

# Words that open Sentences far more often than they continue a name or a list after an abbreviation.
# fmt: off
SENTENCE_OPENERS = frozenset((
    "A", "An", "The", "This", "That", "These", "Those", "There", "Then", "Now", "So", "But", "And", "Or", "Yet",
    "Still", "Thus", "However", "Meanwhile", "I", "He", "She", "It", "We", "They", "You", "His", "Her", "Its",
    "Our", "Their", "My", "Your", "Who", "What", "When", "Where", "Why", "How", "While", "After", "Before",
    "If", "As", "In", "On", "At", "Of", "For", "From", "With", "To", "By", "Not", "No", "Yes",
))
# fmt: on

_NEVER_END = {a.lower() for a in (*TITLES, *LEADING)}
_MAY_END = {a.lower() for a in TRAILING}
# One letter, or letters each followed by a period: J, U.S, e.g (without the final period).
_INITIALS = re.compile(r"^(?:[A-Za-z]\.)*[A-Za-z]$")
_LAST_TOKEN = re.compile(r"(?<![^\W\d_])([^\W\d_](?:[^\W\d_.]|\.(?=[^\W\d_]))*)\.$")

_BOUNDARY = re.compile(
    r"""(?<=[.!?…])        # sentence-ending punctuation
        [”’"')\]]*          # closing quotes or brackets stay with the sentence
        \s+                 # the gap between sentences
        (?=[“‘"'(\[]?[A-Z0-9])  # next sentence starts with a capital or digit, maybe quoted
    """,
    re.VERBOSE,
)


def _ends_sentence(before: str, closers: str, after: str) -> bool:
    """Whether a candidate boundary really ends a Sentence: `before` is the text up to its punctuation,
    `closers` any quotes or brackets after it, `after` the text that follows."""
    if not before.endswith(".") or closers:
        # Only a bare period can belong to an abbreviation; one that closes a quotation ends the Sentence.
        return True
    # The letters (and inner periods) right before the period, however the word is joined to what precedes it:
    # "drily—“Mr." gives "Mr", "the U.S." gives "U.S".
    found = _LAST_TOKEN.search(before)
    token = found.group(1) if found else ""
    if token.lower() in _NEVER_END:
        return False
    if token.lower() in _MAY_END or _INITIALS.match(token):
        next_word = after.split()[0].lstrip("“‘\"'([") if after.split() else ""
        is_initial = re.match(r"^[A-Z]\.", next_word) is not None
        return not is_initial and next_word.rstrip(".,;:!?”’\"')]") in SENTENCE_OPENERS
    return True


def split_sentences(paragraph: str) -> list[str]:
    """Splits one paragraph of normalized text into Sentences, in order, without empty parts."""
    sentences: list[str] = []
    start = 0
    for m in _BOUNDARY.finditer(paragraph):
        closers = m.group(0).rstrip()
        if not _ends_sentence(paragraph[start : m.start()], closers, paragraph[m.end() :]):
            continue
        # m.start() sits right after the punctuation; keep trailing closers with this sentence.
        end = m.start() + len(closers)
        sentences.append(paragraph[start:end].strip())
        start = m.end()
    sentences.append(paragraph[start:].strip())
    return [s for s in sentences if s]
