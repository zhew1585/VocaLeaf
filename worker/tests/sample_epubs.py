"""Sample EPUBs for the parsing rules of PRD 4.2.5, 4.2.6 and 4.3.5, committed under fixtures/ so the end-to-end
tests can upload them through the stack. Regenerate after changing a builder (test_sample_epubs.py checks):

    uv run python tests/sample_epubs.py
"""

from collections.abc import Callable
from pathlib import Path

from epub_factory import Doc, TocEntry, adobe_drm, make_epub

FIXTURES = Path(__file__).parents[2] / "fixtures"

# An over-long Sentence (PRD 4.2.6 rule 2): well over 300 characters, with semicolons to split at.
LONG_SENTENCE = (
    "He searched the drawers, the cupboards and the shelves; he lifted every rug and looked beneath the heavy oak"
    " table; he tapped the panels of the walls one by one, listening for a hollow sound; he even climbed onto a"
    " chair to examine the tops of the wardrobes, where the dust lay thick and undisturbed; and at last, weary and"
    " covered in cobwebs, he sat down by the fire and admitted that the letter was not in the room."
)
# Another, with commas only: it splits at commas.
LONG_COMMA_SENTENCE = (
    "The carriage rolled on through the wet lanes, past the mill and the church, past the long grey wall of the"
    " park, past cottages whose windows glowed with the first lamps of evening, past the inn where the ostler stood"
    " smoking in the doorway, past the last of the elms at the edge of the village, until at length the lights of"
    " the house showed through the rain and the horses slowed of their own accord."
)


def parse_rules() -> bytes:
    """One Book with every rule in it. Non-body Chapters to Skip (AC-UP-06), each by one rule of PRD 4.2.5 alone:
    Rights by its epub:type, Map of the Book by the landmarks, Dedication by its short text, Acknowledgments by
    its title; Index and Endnotes by type and title. A Preface to narrate (AC-UP-07), "Mr. Holmes said."
    (AC-UP-08), note references and a footnote (AC-UP-09), numbers and dates, and over-long Sentences."""
    docs = [
        Doc(
            "rights.xhtml",
            '<section epub:type="copyright-page"><p>These pages may be copied freely for any purpose.'
            " No permission is needed.</p></section>",
            body_type="frontmatter",
        ),
        Doc("map.xhtml", "<p>The Preface comes first, and the story follows it.</p>"),
        Doc("dedication.xhtml", "<p>For Cassandra</p>"),
        Doc(
            "preface.xhtml",
            "<h2>Preface</h2><p>This little book was begun in 1890 and finished on 5 May 1891. I hope you like it.</p>",
            body_type="frontmatter",
        ),
        Doc(
            "chapter-1.xhtml",
            "<h2>Chapter I</h2>"
            "<p>“Come in,” Mr. Holmes said. “You have come 200 miles, I perceive.”</p>"
            '<p>It was the 3rd of March, and the fog was thick.<a href="endnotes.xhtml#note-1" epub:type="noteref">1</a>'
            " Dr. Watson agreed.<sup>2</sup></p>"
            '<aside id="fn-2" epub:type="footnote"><p>A footnote that is never read aloud.</p></aside>'
            f"<p>{LONG_SENTENCE}</p><p>{LONG_COMMA_SENTENCE}</p>",
            body_type="bodymatter",
        ),
        Doc("thanks.xhtml", "<p>My thanks go to Dr. Watson for his patience.</p>"),
        Doc("index.xhtml", "<p>Holmes, Sherlock, 1, 4, 9</p><p>Watson, John, 2, 3</p>", body_type="backmatter index"),
        Doc(
            "endnotes.xhtml",
            '<section epub:type="endnotes"><ol><li id="note-1" epub:type="endnote">'
            "<p>Fog in London was common in 1887.</p></li></ol></section>",
            body_type="backmatter",
        ),
    ]
    toc = [
        TocEntry("Rights", "rights.xhtml"),
        TocEntry("Map of the Book", "map.xhtml"),
        TocEntry("Dedication", "dedication.xhtml"),
        TocEntry("Preface", "preface.xhtml"),
        TocEntry("Chapter I", "chapter-1.xhtml"),
        TocEntry("Acknowledgments", "thanks.xhtml"),
        TocEntry("Index", "index.xhtml"),
        TocEntry("Endnotes", "endnotes.xhtml"),
    ]
    landmarks = [("toc", "map.xhtml"), ("bodymatter", "chapter-1.xhtml")]
    return make_epub(docs, toc, title="A Study in Rules", author="VocaLeaf", landmarks=landmarks)


def drm() -> bytes:
    """An EPUB whose Chapter is encrypted as Adobe ADEPT does it (AC-UP-05, PRD 4.3.5 #4)."""
    return make_epub(
        [Doc("chapter-1.xhtml", "<p>It is a truth universally acknowledged.</p>")],
        [TocEntry("Chapter I", "chapter-1.xhtml")],
        title="Locked",
        extra_files={"META-INF/encryption.xml": adobe_drm("OEBPS/chapter-1.xhtml")},
    )


def corrupt() -> bytes:
    """An EPUB cut off halfway, as an interrupted download leaves it (PRD 4.3.5 #5)."""
    whole = parse_rules()
    return whole[: len(whole) // 2]


def no_text() -> bytes:
    """An EPUB of pictures only: nothing to narrate (PRD 4.3.5 #6)."""
    return make_epub(
        [Doc("cover.xhtml", '<img src="cover.png" alt=""/>'), Doc("plates.xhtml", '<img src="plate-1.png" alt=""/>')],
        [TocEntry("Cover", "cover.xhtml"), TocEntry("Plates", "plates.xhtml")],
        title="Pictures",
    )


SAMPLES: dict[str, Callable[[], bytes]] = {
    "parse-rules.epub": parse_rules,
    "drm.epub": drm,
    "corrupt.epub": corrupt,
    "no-text.epub": no_text,
}

if __name__ == "__main__":
    for name, build in SAMPLES.items():
        (FIXTURES / name).write_bytes(build())
        print(f"wrote fixtures/{name}")
