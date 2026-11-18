"""Sentence splitting (PRD 4.2.6 rules 1 and 2).

Splits after . ! ? or … (plus any closing quotes or brackets) when whitespace and the start of a new sentence
follow. A period that belongs to an abbreviation does not end a Sentence (AC-UP-08). The abbreviation lists
start from ebook2audiobook's English list (ADR 0001); SENTENCE_OPENERS is our own heuristic for the
abbreviations that can end a Sentence too.

A Sentence longer than MAX_SENTENCE_CHARS is split further at semicolons, then colons, then commas, and as a last
resort between words (PRD 4.2.6 rule 2); each piece becomes a Sentence of its own.
"""

import re

# PRD 4.7.2 单句最大字符数.
MAX_SENTENCE_CHARS = 300

# Where an over-long Sentence may break, most preferred first. The mark stays with the piece before it.
_CLAUSE_MARKS = (";", ":", ",")

# Titles stand before a name, so a Sentence never ends on one unless the paragraph or a quotation ends there.
# Matched with their own capitalization: "MS." (a manuscript) is not "Ms.".
TITLES = ("Mr", "Mrs", "Ms", "Messrs", "Dr", "St", "Mt", "Prof", "Rev", "Capt", "Col", "Gen", "Lt", "Gov")

# Abbreviations that introduce what follows them.
LEADING = ("vs", "e.g", "i.e", "cf", "viz")

# Abbreviations that stand before a number ("No. 4", "Vol. II"), and do not end a Sentence there.
NUMBERING = ("No", "Vol", "Ch", "Fig", "p", "pp")

# Abbreviations that may also end a Sentence, as may an initial ("J.", "É.") or an acronym ("U.S."): they end one
# only before a title or a word that clearly opens a Sentence.
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

_OPENING_QUOTES = "“‘\"'(["
_CLOSING_QUOTES = "”’\"')]"

_TITLES = frozenset(TITLES)
_LEADING = frozenset(LEADING)
_NUMBERING = frozenset(NUMBERING)
_TRAILING = frozenset(a.lower() for a in TRAILING)

_LETTER = r"[^\W\d_]"
# The abbreviation right before the final period: letters, with inner periods ("U.S"), not part of a longer
# word or a possessive ("Anne’s"). Read across dashes and invisible joiners: "drily—“Mr." gives "Mr".
_LAST_TOKEN = re.compile(rf"(?<![^\W\d_’'])({_LETTER}(?:{_LETTER}|\.(?={_LETTER}))*)\.$")
_NUMBER = re.compile(r"^(?:\d|[IVXLC]+\b)")

_BOUNDARY = re.compile(
    rf"""(?<=[.!?…])                  # sentence-ending punctuation
        [{re.escape(_CLOSING_QUOTES)}]*  # closing quotes or brackets stay with the sentence
        \s+                           # the gap between sentences
        (?=[{re.escape(_OPENING_QUOTES)}]?[A-Z0-9])  # next sentence starts with a capital or digit, maybe quoted
    """,
    re.VERBOSE,
)


def _is_initials(token: str) -> bool:
    """Capital letters each followed by a period, in any script: "J", "É", "U.S". The pronoun "I" is not one."""
    return token != "I" and all(len(x) == 1 and x.isupper() for x in token.split("."))


def _ends_sentence(before: str, closers: str, after: str) -> bool:
    """Whether a candidate boundary really ends a Sentence: `before` is the text up to its punctuation,
    `closers` any quotes or brackets after it, `after` the text that follows."""
    if not before.endswith(".") or closers:
        # Only a bare period can belong to an abbreviation; one that closes a quotation ends the Sentence.
        return True
    found = _LAST_TOKEN.search(before)
    token = found.group(1) if found else ""
    next_word = after.split(maxsplit=1)[0].lstrip(_OPENING_QUOTES) if after.strip() else ""
    if token in _TITLES or token.lower() in _LEADING:
        return False
    if token in _NUMBERING and _NUMBER.match(next_word):
        return False
    if token.lower() in _TRAILING or (token and _is_initials(token)):
        bare = next_word.rstrip(".,;:!?" + _CLOSING_QUOTES)
        return bare in SENTENCE_OPENERS or bare in _TITLES
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
    return [piece for s in sentences if s for piece in _within_limit(s, _CLAUSE_MARKS)]


def _within_limit(sentence: str, marks: tuple[str, ...]) -> list[str]:
    """Splits an over-long Sentence after the first of `marks` it contains (pieces still too long try the next
    marks), then packs neighbouring pieces back together as long as they fit."""
    if len(sentence) <= MAX_SENTENCE_CHARS:
        return [sentence]
    if not marks:
        return _pack(sentence.split(" "))
    parts = re.split(rf"(?<={re.escape(marks[0])})\s+", sentence)
    if len(parts) == 1:
        return _within_limit(sentence, marks[1:])
    return _pack([piece for part in parts for piece in _within_limit(part, marks[1:])])


def _pack(pieces: list[str]) -> list[str]:
    """Joins consecutive pieces with a space while the result stays within MAX_SENTENCE_CHARS."""
    packed: list[str] = []
    for piece in pieces:
        if packed and len(packed[-1]) + 1 + len(piece) <= MAX_SENTENCE_CHARS:
            packed[-1] = f"{packed[-1]} {piece}"
        else:
            packed.append(piece)
    return packed
