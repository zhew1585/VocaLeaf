import re
import zipfile
from pathlib import Path

import pytest

from epub_factory import Doc, TocEntry, make_epub
from vocaleaf_worker.epub_parser import parse_epub
from vocaleaf_worker.sentences import TITLES

# A title at the very end of a Sentence, whatever precedes it (space, quote, dash).
TITLE_ENDING = re.compile(rf"(?<![A-Za-z])(?:{'|'.join(TITLES)})\.$")
PRIDE_AND_PREJUDICE = Path(__file__).parents[2] / "fixtures" / "pride-and-prejudice.epub"


def texts(chapter):
    return [(s.paragraph_index, s.text) for s in chapter.sentences]


def test_reads_metadata_and_makes_one_chapter_per_top_level_toc_entry():
    epub = make_epub(
        [Doc("one.xhtml", "<h2>One</h2><p>First words.</p>"), Doc("two.xhtml", "<p>Second words.</p>")],
        [TocEntry("Chapter One", "one.xhtml"), TocEntry("Chapter Two", "two.xhtml")],
        title="Pride and Prejudice",
        author="Jane Austen",
    )

    book = parse_epub(epub)

    assert (book.title, book.author) == ("Pride and Prejudice", "Jane Austen")
    assert [c.title for c in book.chapters] == ["Chapter One", "Chapter Two"]
    assert texts(book.chapters[0]) == [(0, "One"), (1, "First words.")]
    assert texts(book.chapters[1]) == [(0, "Second words.")]


def test_nested_toc_entries_fold_into_their_top_level_chapter():
    epub = make_epub(
        [
            Doc("part1.xhtml", "<h1>Volume I</h1>"),
            Doc("c1.xhtml", "<p>One.</p>"),
            Doc("c2.xhtml", "<p>Two.</p>"),
            Doc("part2.xhtml", "<h1>Volume II</h1>"),
            Doc("c3.xhtml", "<p>Three.</p>"),
        ],
        [
            TocEntry("Volume I", "part1.xhtml", [TocEntry("I", "c1.xhtml"), TocEntry("II", "c2.xhtml")]),
            TocEntry("Volume II", "part2.xhtml", [TocEntry("III", "c3.xhtml")]),
        ],
    )

    book = parse_epub(epub)

    assert [c.title for c in book.chapters] == ["Volume I", "Volume II"]
    # The headings repeat the Chapter titles, so they are not Sentences.
    assert texts(book.chapters[0]) == [(0, "One."), (1, "Two.")]
    assert texts(book.chapters[1]) == [(0, "Three.")]


def test_toc_fragments_split_chapters_inside_one_file():
    epub = make_epub(
        [Doc("all.xhtml", '<section id="a"><h2>A</h2><p>Alpha.</p></section><section id="b"><p>Beta.</p></section>')],
        [TocEntry("A", "all.xhtml#a"), TocEntry("B", "all.xhtml#b")],
    )

    book = parse_epub(epub)

    assert [texts(c) for c in book.chapters] == [[(0, "Alpha.")], [(0, "Beta.")]]


def test_content_before_the_first_toc_target_is_not_in_any_chapter():
    epub = make_epub(
        [Doc("cover.xhtml", "<p>Cover text.</p>"), Doc("c1.xhtml", "<p>Body.</p>")],
        [TocEntry("Chapter", "c1.xhtml")],
    )

    assert [texts(c) for c in parse_epub(epub).chapters] == [[(0, "Body.")]]


def test_paragraphs_split_into_sentences_and_keep_inline_text_together():
    epub = make_epub(
        [Doc("c1.xhtml", "<p>It is <em>true</em>. Is it?</p><blockquote><p>Line one<br/>line two.</p></blockquote>")],
        [TocEntry("Chapter", "c1.xhtml")],
    )

    chapter = parse_epub(epub).chapters[0]

    assert texts(chapter) == [(0, "It is true."), (0, "Is it?"), (1, "Line one line two.")]
    assert all(s.spoken_text == s.text for s in chapter.sentences)


def test_a_heading_that_repeats_the_chapter_title_is_not_a_sentence():
    epub = make_epub(
        [Doc("c1.xhtml", "<h2>Chapter  I.</h2><p>It is a truth.</p><p>Chapter I</p>")],
        [TocEntry("CHAPTER I", "c1.xhtml")],
    )

    # Compared without case, spacing and punctuation; only the opening paragraph is the heading.
    assert texts(parse_epub(epub).chapters[0]) == [(0, "It is a truth."), (1, "Chapter I")]


def test_a_heading_that_differs_from_the_chapter_title_stays():
    epub = make_epub([Doc("c1.xhtml", "<h2>One</h2><p>Body.</p>")], [TocEntry("Chapter One", "c1.xhtml")])

    assert texts(parse_epub(epub).chapters[0]) == [(0, "One"), (1, "Body.")]


def test_missing_toc_title_and_metadata_are_none():
    epub = make_epub([Doc("c1.xhtml", "<p>Body.</p>")], [TocEntry("", "c1.xhtml")], title=None, author=None)

    book = parse_epub(epub)

    assert (book.title, book.author, book.chapters[0].title) == (None, None, None)


def test_epub2_ncx_table_of_contents():
    epub = make_epub(
        [Doc("c1.xhtml", "<p>One.</p>"), Doc("c2.xhtml", "<p>Two.</p>")],
        [TocEntry("First", "c1.xhtml"), TocEntry("Second", "c2.xhtml")],
        epub2=True,
    )

    assert [(c.title, texts(c)) for c in parse_epub(epub).chapters] == [
        ("First", [(0, "One.")]),
        ("Second", [(0, "Two.")]),
    ]


def test_without_any_toc_each_spine_document_is_a_chapter():
    epub = make_epub([Doc("c1.xhtml", "<p>One.</p>"), Doc("c2.xhtml", "<p>Two.</p>")], [], epub2=True)

    assert [(c.title, texts(c)) for c in parse_epub(epub).chapters] == [(None, [(0, "One.")]), (None, [(0, "Two.")])]


def test_unreadable_file_raises():
    with pytest.raises(zipfile.BadZipFile):
        parse_epub(b"not a zip")


def test_pride_and_prejudice_from_standard_ebooks():
    book = parse_epub(PRIDE_AND_PREJUDICE.read_bytes())

    assert (book.title, book.author) == ("Pride and Prejudice", "Jane Austen")
    assert len(book.chapters) == 65
    titles = [c.title for c in book.chapters]
    assert titles[:3] == ["Titlepage", "Imprint", "I"]
    assert titles[-3:] == ["LXI", "Colophon", "Uncopyright"]
    chapter_one = book.chapters[2]
    # The heading "I" is the Chapter's title, not its first Sentence.
    assert chapter_one.sentences[0].text == (
        "It is a truth universally acknowledged, that a single man in possession of a good fortune,"
        " must be in want of a wife."
    )
    assert chapter_one.sentences[2].text.startswith("“My dear Mr. Bennet,” said his lady to him one day,")
    assert chapter_one.sentences[3].text == "Mr. Bennet replied that he had not."
    assert all(len(c.sentences) > 0 for c in book.chapters[2:63])


def test_pride_and_prejudice_has_no_sentence_ending_on_a_title():
    book = parse_epub(PRIDE_AND_PREJUDICE.read_bytes())

    endings = [s.text for c in book.chapters for s in c.sentences if TITLE_ENDING.search(s.text)]

    assert endings == []


def test_a_book_without_any_document_raises():
    with pytest.raises(ValueError):
        parse_epub(make_epub([], [], epub2=True))
