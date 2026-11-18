"""Basic sentence splitting.

Splits after . ! ? or … (plus any closing quotes or brackets) when whitespace and the start of a
new sentence follow. Abbreviations (Mr.), over-long sentence splitting and the rest of
PRD 4.2.6 come with #3.
"""

import re

_BOUNDARY = re.compile(
    r"""(?<=[.!?…])        # sentence-ending punctuation
        [”’"')\]]*          # closing quotes or brackets stay with the sentence
        \s+                 # the gap between sentences
        (?=[“‘"'(\[]?[A-Z0-9])  # next sentence starts with a capital or digit, maybe quoted
    """,
    re.VERBOSE,
)


def split_sentences(paragraph: str) -> list[str]:
    """Splits one paragraph of normalized text into Sentences, in order, without empty parts."""
    sentences: list[str] = []
    start = 0
    for m in _BOUNDARY.finditer(paragraph):
        # m.start() sits right after the punctuation; keep trailing closers with this sentence.
        end = m.start() + len(m.group(0).rstrip())
        sentences.append(paragraph[start:end].strip())
        start = m.end()
    sentences.append(paragraph[start:].strip())
    return [s for s in sentences if s]
