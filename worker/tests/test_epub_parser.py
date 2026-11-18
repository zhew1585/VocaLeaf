import io
import re
import zipfile
from pathlib import Path

import pytest

from epub_factory import Doc, TocEntry, adobe_drm, font_obfuscation, make_epub
from vocaleaf_worker.epub_parser import ParseFailed, parse_epub
from vocaleaf_worker.sentences import TITLES

# A title at the very end of a Sentence, whatever precedes it (space, quote, dash).
TITLE_ENDING = re.compile(rf"(?<![A-Za-z])(?:{'|'.join(TITLES)})\.$")
PRIDE_AND_PREJUDICE = Path(__file__).parents[2] / "fixtures" / "pride-and-prejudice.epub"


def texts(chapter):
    return [(s.paragraph_index, s.text) for s in chapter.sentences]


def test_reads_metadata_and_makes_one_chapter_per_top_level_toc_entry():
    epub = make_epub(
        [
            Doc("one.xhtml", "<h2>One</h2><p>The first words came.</p>"),
            Doc("two.xhtml", "<p>The second words came.</p>"),
        ],
        [TocEntry("Chapter One", "one.xhtml"), TocEntry("Chapter Two", "two.xhtml")],
        title="Pride and Prejudice",
        author="Jane Austen",
    )

    book = parse_epub(epub)

    assert (book.title, book.author) == ("Pride and Prejudice", "Jane Austen")
    assert [c.title for c in book.chapters] == ["Chapter One", "Chapter Two"]
    assert texts(book.chapters[0]) == [(0, "One"), (1, "The first words came.")]
    assert texts(book.chapters[1]) == [(0, "The second words came.")]


def test_nested_toc_entries_fold_into_their_top_level_chapter():
    epub = make_epub(
        [
            Doc("part1.xhtml", "<h1>Volume I</h1>"),
            Doc("c1.xhtml", "<p>One came home.</p>"),
            Doc("c2.xhtml", "<p>Two came home.</p>"),
            Doc("part2.xhtml", "<h1>Volume II</h1>"),
            Doc("c3.xhtml", "<p>Three came home.</p>"),
        ],
        [
            TocEntry("Volume I", "part1.xhtml", [TocEntry("I", "c1.xhtml"), TocEntry("II", "c2.xhtml")]),
            TocEntry("Volume II", "part2.xhtml", [TocEntry("III", "c3.xhtml")]),
        ],
    )

    book = parse_epub(epub)

    assert [c.title for c in book.chapters] == ["Volume I", "Volume II"]
    # The headings repeat the Chapter titles, so they are not Sentences.
    assert texts(book.chapters[0]) == [(0, "One came home."), (1, "Two came home.")]
    assert texts(book.chapters[1]) == [(0, "Three came home.")]


def test_toc_fragments_split_chapters_inside_one_file():
    epub = make_epub(
        [
            Doc(
                "all.xhtml",
                '<section id="a"><h2>A</h2><p>Alpha came home.</p></section><section id="b"><p>Beta came home.</p></section>',
            )
        ],
        [TocEntry("A", "all.xhtml#a"), TocEntry("B", "all.xhtml#b")],
    )

    book = parse_epub(epub)

    assert [texts(c) for c in book.chapters] == [[(0, "Alpha came home.")], [(0, "Beta came home.")]]


def test_content_before_the_first_toc_target_is_not_in_any_chapter():
    epub = make_epub(
        [Doc("cover.xhtml", "<p>Cover text.</p>"), Doc("c1.xhtml", "<p>The body came home.</p>")],
        [TocEntry("Chapter", "c1.xhtml")],
    )

    assert [texts(c) for c in parse_epub(epub).chapters] == [[(0, "The body came home.")]]


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


def test_a_heading_of_only_punctuation_is_not_taken_for_a_punctuation_title():
    epub = make_epub([Doc("c1.xhtml", "<p>* * *</p><p>The body came home.</p>")], [TocEntry("…", "c1.xhtml")])

    assert texts(parse_epub(epub).chapters[0]) == [(0, "* * *"), (1, "The body came home.")]


def test_a_heading_that_differs_from_the_chapter_title_stays():
    epub = make_epub([Doc("c1.xhtml", "<h2>One</h2><p>The body came home.</p>")], [TocEntry("Chapter One", "c1.xhtml")])

    assert texts(parse_epub(epub).chapters[0]) == [(0, "One"), (1, "The body came home.")]


def test_missing_toc_title_and_metadata_are_none():
    epub = make_epub(
        [Doc("c1.xhtml", "<p>The body came home.</p>")], [TocEntry("", "c1.xhtml")], title=None, author=None
    )

    book = parse_epub(epub)

    assert (book.title, book.author, book.chapters[0].title) == (None, None, None)


def test_epub2_ncx_table_of_contents():
    epub = make_epub(
        [Doc("c1.xhtml", "<p>One came home.</p>"), Doc("c2.xhtml", "<p>Two came home.</p>")],
        [TocEntry("First", "c1.xhtml"), TocEntry("Second", "c2.xhtml")],
        epub2=True,
    )

    assert [(c.title, texts(c)) for c in parse_epub(epub).chapters] == [
        ("First", [(0, "One came home.")]),
        ("Second", [(0, "Two came home.")]),
    ]


def test_without_any_toc_each_spine_document_is_a_chapter():
    epub = make_epub(
        [Doc("c1.xhtml", "<p>One came home.</p>"), Doc("c2.xhtml", "<p>Two came home.</p>")], [], epub2=True
    )

    assert [(c.title, texts(c)) for c in parse_epub(epub).chapters] == [
        (None, [(0, "One came home.")]),
        (None, [(0, "Two came home.")]),
    ]


def test_a_file_that_is_not_a_zip_is_unreadable():
    with pytest.raises(ParseFailed) as failed:
        parse_epub(b"not a zip")

    assert failed.value.reason == "unreadable"
    assert isinstance(failed.value.__cause__, zipfile.BadZipFile)


def test_pride_and_prejudice_from_standard_ebooks():
    book = parse_epub(PRIDE_AND_PREJUDICE.read_bytes())

    assert (book.title, book.author) == ("Pride and Prejudice", "Jane Austen")
    assert len(book.chapters) == 65
    titles = [c.title for c in book.chapters]
    assert titles[:3] == ["Titlepage", "Imprint", "I"]
    assert titles[-3:] == ["LXI", "Colophon", "Uncopyright"]
    # AC-UP-06: the title page, imprint, colophon and copyright page are kept but not narrated.
    assert [c.title for c in book.chapters if c.skipped] == ["Titlepage", "Imprint", "Colophon", "Uncopyright"]
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


def test_a_book_without_any_document_is_unreadable():
    with pytest.raises(ParseFailed) as failed:
        parse_epub(make_epub([], [], epub2=True))

    assert failed.value.reason == "unreadable"


# ---- Skipped Chapters (PRD 4.2.5, AC-UP-06, AC-UP-07) ----

BODY = "<p>It is a truth universally acknowledged, that a single man in possession of a good fortune, must be in want of a wife.</p>"


def skipped(book):
    return {c.title: c.skipped for c in book.chapters}


@pytest.mark.parametrize(
    "epub_type",
    ["cover", "titlepage", "copyright-page", "toc", "index", "colophon", "imprint", "loi", "lot", "endnotes"],
)
def test_a_chapter_whose_section_is_marked_as_non_body_is_skipped(epub_type):
    epub = make_epub(
        [
            Doc("front.xhtml", f'<section epub:type="{epub_type}">{BODY}</section>', body_type="frontmatter"),
            Doc("c1.xhtml", f'<section epub:type="chapter">{BODY}</section>', body_type="bodymatter"),
        ],
        [TocEntry("Front", "front.xhtml"), TocEntry("One", "c1.xhtml")],
    )

    assert skipped(parse_epub(epub)) == {"Front": True, "One": False}


def test_a_chapter_marked_on_its_body_or_its_toc_target_is_skipped():
    epub = make_epub(
        [
            Doc("index.xhtml", BODY, body_type="backmatter index"),
            Doc("all.xhtml", f'<section id="c1">{BODY}</section><section id="toc" epub:type="toc">{BODY}</section>'),
        ],
        [TocEntry("Back", "index.xhtml"), TocEntry("One", "all.xhtml#c1"), TocEntry("List", "all.xhtml#toc")],
    )

    assert skipped(parse_epub(epub)) == {"Back": True, "One": False, "List": True}


def test_a_chapter_named_by_the_landmarks_is_skipped():
    epub = make_epub(
        [Doc("rights.xhtml", BODY), Doc("c1.xhtml", BODY)],
        [TocEntry("Front", "rights.xhtml"), TocEntry("One", "c1.xhtml")],
        landmarks=[("copyright-page", "rights.xhtml"), ("bodymatter", "c1.xhtml")],
    )

    assert skipped(parse_epub(epub)) == {"Front": True, "One": False}


def test_a_landmark_on_a_whole_file_that_several_chapters_share_is_not_trusted():
    epub = make_epub(
        [Doc("book.xhtml", f'{BODY}<section id="c2">{BODY}</section>')],
        [TocEntry("One", "book.xhtml"), TocEntry("Two", "book.xhtml#c2")],
        landmarks=[("toc", "book.xhtml")],
    )

    assert skipped(parse_epub(epub)) == {"One": False, "Two": False}


def test_a_chapter_named_by_the_epub2_guide_is_skipped():
    epub = make_epub(
        [Doc("rights.xhtml", BODY), Doc("c1.xhtml", BODY)],
        [TocEntry("Front", "rights.xhtml"), TocEntry("One", "c1.xhtml")],
        epub2=True,
        guide=[("copyright-page", "rights.xhtml"), ("text", "c1.xhtml")],
    )

    assert skipped(parse_epub(epub)) == {"Front": True, "One": False}


@pytest.mark.parametrize(
    ("title", "is_skipped"),
    [
        ("Copyright", True),
        ("Copyright Page", True),
        ("Contents", True),
        ("Table of Contents", True),
        ("INDEX", True),
        ("Also by Jane Austen", True),
        ("About the Author", True),
        ("About the Publisher", True),
        ("Acknowledgments", True),
        ("Acknowledgements", True),
        ("Copyright Notice", True),
        ("Index of Names", True),
        ("About the Author and Illustrator", True),
        ("Chapter 1: The Index", False),
        ("Indexing the Stars", False),
        ("The Contents of a Drawer", False),
    ],
)
def test_a_chapter_titled_like_non_body_text_is_skipped(title, is_skipped):
    epub = make_epub(
        [Doc("c0.xhtml", BODY), Doc("c1.xhtml", BODY)], [TocEntry(title, "c0.xhtml"), TocEntry("One", "c1.xhtml")]
    )

    assert parse_epub(epub).chapters[0].skipped is is_skipped


@pytest.mark.parametrize("title", ["Preface", "Foreword", "Introduction", "Prologue", "Epilogue", "Afterword"])
def test_prefaces_and_the_like_are_narrated_even_when_marked_as_front_matter(title):
    epub = make_epub(
        [Doc("p.xhtml", BODY, body_type="frontmatter")],
        [TocEntry(title, "p.xhtml")],
        landmarks=[("titlepage", "p.xhtml")],
    )

    assert parse_epub(epub).chapters[0].skipped is False


@pytest.mark.parametrize(
    ("body", "is_skipped"),
    [
        ("<p>For Cassandra</p>", True),  # a dedication: short, no complete Sentence
        ("<p>Pride and Prejudice</p><p>by Jane Austen</p>", True),  # a title page without markup
        ("", True),  # nothing at all
        ("<p>It rained all day.</p>", False),  # short, but a complete Sentence
        (f"<p>{'word ' * 50}</p>", False),  # 200 characters or more, even without any full stop
    ],
)
def test_a_short_chapter_without_a_complete_sentence_is_skipped(body, is_skipped):
    epub = make_epub(
        [Doc("c0.xhtml", body), Doc("c1.xhtml", BODY)], [TocEntry("Front", "c0.xhtml"), TocEntry("One", "c1.xhtml")]
    )

    assert parse_epub(epub).chapters[0].skipped is is_skipped


def test_a_short_preface_without_a_complete_sentence_is_still_skipped():
    epub = make_epub(
        [Doc("p.xhtml", "<p>To be written</p>"), Doc("c1.xhtml", BODY)],
        [TocEntry("Preface", "p.xhtml"), TocEntry("One", "c1.xhtml")],
    )

    assert parse_epub(epub).chapters[0].skipped is True


def test_a_skipped_chapter_keeps_its_sentences():
    epub = make_epub(
        [Doc("rights.xhtml", "<p>Copyright 2020 by the Author. All rights reserved.</p>"), Doc("c1.xhtml", BODY)],
        [TocEntry("Copyright", "rights.xhtml"), TocEntry("One", "c1.xhtml")],
    )

    assert texts(parse_epub(epub).chapters[0]) == [(0, "Copyright 2020 by the Author."), (0, "All rights reserved.")]


# ---- Notes (PRD 4.2.6 rule 3, AC-UP-09) and spoken_text (rule 4) ----


def test_note_reference_numbers_are_neither_shown_nor_read():
    epub = make_epub(
        [
            Doc(
                "c1.xhtml",
                '<p>He said so.<a href="notes.xhtml#n1" epub:type="noteref">1</a> She agreed.<sup>2</sup>'
                ' It was late<a href="#n3"><sup>3</sup></a>, and dark<a href="#n4">[4]</a>.'
                " Then he left.<sup>*</sup></p>",
            )
        ],
        [TocEntry("One", "c1.xhtml")],
    )

    chapter = parse_epub(epub).chapters[0]

    expected = ["He said so.", "She agreed.", "It was late, and dark.", "Then he left."]
    assert [s.text for s in chapter.sentences] == expected
    assert [s.spoken_text for s in chapter.sentences] == expected


def test_superscripts_that_are_not_note_numbers_stay():
    epub = make_epub([Doc("c1.xhtml", "<p>In the 19<sup>th</sup> century.</p>")], [TocEntry("One", "c1.xhtml")])

    sentence = parse_epub(epub).chapters[0].sentences[0]

    assert (sentence.text, sentence.spoken_text) == ("In the 19th century.", "In the nineteenth century.")


def test_footnote_text_is_not_read_inside_the_chapter():
    epub = make_epub(
        [
            Doc(
                "c1.xhtml",
                '<p>He said so.<a epub:type="noteref" href="#fn1">1</a></p>'
                '<aside id="fn1" epub:type="footnote"><p>A note about it.</p></aside>'
                "<p>The end came.</p>",
            )
        ],
        [TocEntry("One", "c1.xhtml")],
    )

    assert texts(parse_epub(epub).chapters[0]) == [(0, "He said so."), (1, "The end came.")]


def test_footnotes_marked_only_by_class_are_not_read_inside_the_chapter():
    # Project Gutenberg's HTML marks notes with classes only.
    epub = make_epub(
        [
            Doc(
                "c1.xhtml",
                '<p>He said so.<a class="fnanchor" href="#Footnote_1">[1]</a></p>'
                '<div class="footnote"><p><a id="Footnote_1">[1]</a> A note about it.</p></div>'
                "<p>The end came.</p>",
            )
        ],
        [TocEntry("One", "c1.xhtml")],
    )

    assert texts(parse_epub(epub).chapters[0]) == [(0, "He said so."), (1, "The end came.")]


def test_an_endnotes_chapter_is_skipped_but_keeps_its_notes():
    epub = make_epub(
        [
            Doc("c1.xhtml", '<p>He said so.<a epub:type="noteref" href="notes.xhtml#n1">1</a></p>'),
            Doc(
                "notes.xhtml",
                '<section epub:type="endnotes"><ol><li id="n1" epub:type="endnote"><p>A note about it.</p></li></ol></section>',
            ),
        ],
        [TocEntry("One", "c1.xhtml"), TocEntry("Endnotes", "notes.xhtml")],
    )

    notes = parse_epub(epub).chapters[1]

    assert notes.skipped is True
    assert texts(notes) == [(0, "A note about it.")]


def test_spoken_text_reads_numbers_and_dates_while_text_keeps_them():
    epub = make_epub([Doc("c1.xhtml", "<p>On May 5, 1811, he had 3 sisters.</p>")], [TocEntry("One", "c1.xhtml")])

    sentence = parse_epub(epub).chapters[0].sentences[0]

    assert sentence.text == "On May 5, 1811, he had 3 sisters."
    assert sentence.spoken_text == "On May fifth, eighteen eleven, he had three sisters."


def test_mr_holmes_said_is_one_sentence():
    epub = make_epub([Doc("c1.xhtml", "<p>“Come in,” Mr. Holmes said. “Sit down.”</p>")], [TocEntry("One", "c1.xhtml")])

    assert [s.text for s in parse_epub(epub).chapters[0].sentences] == ["“Come in,” Mr. Holmes said.", "“Sit down.”"]


# ---- 解析失败 (PRD 4.3.5 #4 to #6, AC-UP-05) ----


def test_an_epub_with_drm_fails_as_drm():
    epub = make_epub(
        [Doc("c1.xhtml", BODY)],
        [TocEntry("One", "c1.xhtml")],
        extra_files={"META-INF/encryption.xml": adobe_drm("OEBPS/c1.xhtml")},
    )

    with pytest.raises(ParseFailed) as failed:
        parse_epub(epub)

    assert failed.value.reason == "drm"


def test_font_obfuscation_is_not_drm():
    epub = make_epub(
        [Doc("c1.xhtml", BODY)],
        [TocEntry("One", "c1.xhtml")],
        extra_files={"META-INF/encryption.xml": font_obfuscation("OEBPS/fonts/a.otf")},
    )

    assert parse_epub(epub).chapters[0].skipped is False


@pytest.mark.parametrize(
    "files",
    [
        {"META-INF/container.xml": "<not xml"},
        {"OEBPS/content.opf": "<package/>"},
    ],
)
def test_an_epub_with_broken_parts_is_unreadable(files):
    epub = make_epub([Doc("c1.xhtml", BODY)], [TocEntry("One", "c1.xhtml")])
    broken = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(epub)) as src, zipfile.ZipFile(broken, "w") as dst:
        for item in src.infolist():
            dst.writestr(item, files.get(item.filename, src.read(item)))

    with pytest.raises(ParseFailed) as failed:
        parse_epub(broken.getvalue())

    assert failed.value.reason == "unreadable"


def test_a_truncated_epub_is_unreadable():
    epub = make_epub([Doc("c1.xhtml", BODY)], [TocEntry("One", "c1.xhtml")])

    with pytest.raises(ParseFailed) as failed:
        parse_epub(epub[: len(epub) // 2])

    assert failed.value.reason == "unreadable"


@pytest.mark.parametrize(
    "docs",
    [
        [Doc("c1.xhtml", "")],
        [Doc("c1.xhtml", '<img src="a.png" alt=""/>'), Doc("c2.xhtml", "<p>Chapter Two</p>")],
        [Doc("c1.xhtml", BODY, body_type="frontmatter copyright-page")],
    ],
)
def test_an_epub_with_no_narrated_text_fails_as_no_text(docs):
    epub = make_epub(docs, [TocEntry(f"Part {i}", d.name) for i, d in enumerate(docs)])

    with pytest.raises(ParseFailed) as failed:
        parse_epub(epub)

    assert failed.value.reason == "no_text"
