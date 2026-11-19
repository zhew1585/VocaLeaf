"""Turns an EPUB into Chapters and Sentences.

A Chapter is a top-level entry of the table of contents; it runs from that entry's target to the
next top-level entry's target in spine order, so nested entries fold into their top-level Chapter.
Non-body Chapters (copyright page, contents, index...) are kept but Skipped (PRD 4.2.5). Note reference
numbers and footnotes are left out of the text (PRD 4.2.6 rule 3); spoken_text reads numbers as words (rule 4).
A file that yields nothing to narrate raises ParseFailed with the reason the user is shown (PRD 4.3.5 #4 to #6).
"""

import io
import posixpath
import re
import zipfile
import zlib
from dataclasses import dataclass
from typing import Literal
from urllib.parse import unquote, urldefrag

from lxml import etree

from vocaleaf_worker.sentences import split_sentences
from vocaleaf_worker.spoken import spoken_text

# 0.2.0: abbreviations do not end Sentences; a heading repeating the Chapter title is not a Sentence.
# 0.3.0: Skipped Chapters, over-long Sentences split, note numbers and footnotes left out, numbers spoken as words.
# Books are parsed once (PRD 4.2.6), so Books parsed by an older version keep their Sentences.
PARSER_VERSION = "0.3.0"

NS = {
    "c": "urn:oasis:names:tc:opendocument:xmlns:container",
    "opf": "http://www.idpf.org/2007/opf",
    "dc": "http://purl.org/dc/elements/1.1/",
    "x": "http://www.w3.org/1999/xhtml",
    "ncx": "http://www.daisy.org/z3986/2005/ncx/",
    "epub": "http://www.idpf.org/2007/ops",
}

# Elements that start a new paragraph. Only the innermost ones (no block descendants) become
# paragraphs, so wrappers such as <section> or <blockquote><p> are not read twice.
BLOCK_TAGS = frozenset(
    {
        *("p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "blockquote", "pre", "dd", "dt", "td", "th"),
        *("figcaption", "caption", "div", "section", "article", "aside", "header", "footer", "hgroup"),
        *("table", "tr", "ol", "ul", "dl", "figure", "nav", "main", "address", "body"),
    }
)
SKIP_TAGS = frozenset({"script", "style", "head"})

# PRD 4.2.5 rule 1: epub:type or landmark types of non-body Chapters. "title-page" is the EPUB 2 guide's spelling.
NON_BODY_TYPES = frozenset(
    {
        "cover",
        "titlepage",
        "title-page",
        "copyright-page",
        "toc",
        "index",
        "colophon",
        "imprint",
        "loi",
        "lot",
        "endnotes",
    }
)
# PRD 4.2.5 rule 2, matched against the start of the title's words (lower case, no punctuation): "Copyright
# Notice" and "Index of Names" are Skipped, "Chapter 1: The Index" is not.
NON_BODY_TITLE = re.compile(
    r"(?:copyright|(?:table of )?contents|index|acknowledge?ments|about the (?:authors?|publisher)|also by)\b"
)
# Narrated whatever rules 1 and 2 say; only rule 3 (no text worth reading) can skip them.
NARRATED_TITLE = re.compile(r"(?:preface|foreword|introduction|prologue|epilogue|afterword)(?: .*)?")
# PRD 4.2.5 rule 3: a Chapter this short is Skipped unless it holds a complete Sentence.
MIN_BODY_CHARS = 200
# A complete Sentence: at least this many words and closed by sentence-ending punctuation.
_COMPLETE_SENTENCE = re.compile(r"\S+(?:\s+\S+){2,}[.!?…][”’\"')\]]*$")

# Cover images browsers show; anything else (an SVG cover, say) is left out and the app draws a default cover.
COVER_MEDIA_TYPES = frozenset({"image/jpeg", "image/png", "image/webp", "image/gif"})
# A larger cover is not worth sending to every Shelf; the app draws a default instead.
MAX_COVER_BYTES = 5 * 1024 * 1024

# Encryption that only obfuscates embedded fonts (IDPF, Adobe); anything else in encryption.xml is DRM.
FONT_OBFUSCATION = frozenset({"http://www.idpf.org/2008/embedding", "http://ns.adobe.com/pdf/enc#RC"})

# The text of a superscript or bracketed link that is only a note's reference mark: "3", "[12]", "*", "†".
_NOTE_MARK = re.compile(r"[\[(]?(?:[0-9]{1,3}|[*†‡§¶#]{1,3})[\])]?")
_BRACKETED_NOTE_MARK = re.compile(r"[\[(][0-9]{1,3}[\])]")
# Notes placed inside the body text; their text is not read there (PRD 4.2.6 rule 3).
_INLINE_NOTE_TYPES = frozenset({"footnote", "endnote", "rearnote", "note"})
# Classes that mark footnotes in HTML without epub:type, as Project Gutenberg's does.
_FOOTNOTE_CLASSES = frozenset({"footnote", "footnotes"})

ParseFailureReason = Literal["drm", "unreadable", "no_text"]


class ParseFailed(Exception):
    """The file gives no usable text; `reason` tells which message the user sees (PRD 4.3.5 #4 to #6)."""

    def __init__(self, reason: ParseFailureReason, detail: str) -> None:
        super().__init__(f"{reason}: {detail}")
        self.reason: ParseFailureReason = reason


_XML_PARSER = etree.XMLParser(recover=True, resolve_entities=False, no_network=True)


@dataclass(frozen=True)
class ParsedSentence:
    paragraph_index: int
    text: str
    # What the narrator reads: text with numbers and dates as words.
    spoken_text: str


@dataclass(frozen=True)
class ParsedChapter:
    title: str | None
    sentences: tuple[ParsedSentence, ...]
    # Kept in the Book but not narrated (PRD 4.2.5).
    skipped: bool = False


@dataclass(frozen=True)
class Cover:
    """The cover image the package declares, as stored in the EPUB."""

    media_type: str
    data: bytes


@dataclass(frozen=True)
class ParsedBook:
    title: str | None
    author: str | None
    chapters: tuple[ParsedChapter, ...]
    # Shown on the Shelf (PRD 4.2.1 cover_url); None when the EPUB has no usable one, and the app draws a default.
    cover: Cover | None = None


@dataclass(frozen=True)
class _TocTarget:
    title: str | None
    doc: str
    fragment: str | None


def parse_epub(data: bytes) -> ParsedBook:
    """Parses EPUB bytes. Raises ParseFailed when there is nothing usable to narrate."""
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            _check_drm(z)
            book = _read_book(z)
    except ParseFailed:
        raise
    except (zipfile.BadZipFile, zlib.error, KeyError, ValueError, EOFError, etree.LxmlError) as exc:
        raise ParseFailed("unreadable", f"{type(exc).__name__}: {exc}") from exc
    if not any(c.sentences and not c.skipped for c in book.chapters):
        raise ParseFailed("no_text", "no narrated Chapter has any text")
    return book


def _check_drm(z: zipfile.ZipFile) -> None:
    """PRD 4.3.5 #4: encryption.xml lists encryption other than font obfuscation."""
    if "META-INF/encryption.xml" not in z.namelist():
        return
    for el in _read_xml(z, "META-INF/encryption.xml").iter(tag=etree.Element):
        if _local(el) == "EncryptionMethod" and _attr(el, "Algorithm") not in FONT_OBFUSCATION:
            raise ParseFailed("drm", f"encrypted with {_attr(el, 'Algorithm')}")


def _read_book(z: zipfile.ZipFile) -> ParsedBook:
    opf_path = _rootfile_path(z)
    opf = _read_xml(z, opf_path)
    opf_dir = posixpath.dirname(opf_path)
    manifest = {_attr(item, "id"): item for item in opf.iterfind("opf:manifest/opf:item", NS)}
    spine = [
        _resolve(opf_dir, _attr(manifest[_attr(ref, "idref")], "href"))
        for ref in opf.iterfind("opf:spine/opf:itemref", NS)
        if _attr(ref, "idref") in manifest
    ]
    targets = _toc_targets(z, opf, opf_dir, manifest) or [_TocTarget(None, doc, None) for doc in spine]
    if not targets:
        raise ValueError("EPUB has no table of contents and no spine documents")
    bodies = {doc: body for doc in spine if doc in z.namelist() and (body := _body(z, doc)) is not None}
    paragraphs = _paragraphs_by_chapter(spine, bodies, targets)
    landmarks = _non_body_landmarks(z, opf, opf_dir, manifest)
    # A landmark on a whole file says nothing about which of several Chapters in that file it means.
    shared = {t.doc for t in targets if sum(u.doc == t.doc for u in targets) > 1}

    chapters = []
    for i, t in enumerate(targets):
        sentences = _sentences(_without_title(paragraphs[i], t.title))
        by_landmark = (t.doc, t.fragment) in landmarks and (t.fragment is not None or t.doc not in shared)
        marked = by_landmark or not NON_BODY_TYPES.isdisjoint(_target_types(bodies, t))
        chapters.append(ParsedChapter(t.title, sentences, skipped=_is_skipped(t.title, marked, sentences)))
    return ParsedBook(
        title=_text(opf.find("opf:metadata/dc:title", NS)),
        author=_text(opf.find("opf:metadata/dc:creator", NS)),
        chapters=tuple(chapters),
        cover=_cover(z, opf, opf_dir, manifest),
    )


def _cover(z: zipfile.ZipFile, opf: etree._Element, opf_dir: str, manifest: dict[str, etree._Element]) -> Cover | None:
    """The cover image: the manifest item with properties="cover-image" (EPUB 3), else the one <meta name="cover">
    names (EPUB 2). A missing, oversized or non-image cover is left out rather than failing the parse."""
    item = next((i for i in manifest.values() if "cover-image" in _attr(i, "properties").split()), None)
    if item is None:
        meta = next((m for m in opf.iterfind("opf:metadata/opf:meta", NS) if _attr(m, "name") == "cover"), None)
        item = manifest.get(_attr(meta, "content"))
    media_type = _attr(item, "media-type")
    if item is None or media_type not in COVER_MEDIA_TYPES:
        return None
    path = _resolve(opf_dir, _attr(item, "href"))
    try:
        info = z.getinfo(path)
    except KeyError:
        return None
    if info.file_size > MAX_COVER_BYTES:
        return None
    return Cover(media_type, z.read(info))


def _is_skipped(title: str | None, marked: bool, sentences: tuple[ParsedSentence, ...]) -> bool:
    """PRD 4.2.5: Skipped when marked as non-body (rule 1), titled like it (rule 2) or holding no text worth
    reading (rule 3). Prefaces and the like are exempt from rules 1 and 2."""
    if _lacks_body_text(sentences):
        return True
    words = _title_words(title) if title else ""
    if NARRATED_TITLE.fullmatch(words):
        return False
    return marked or bool(NON_BODY_TITLE.match(words))


def _lacks_body_text(sentences: tuple[ParsedSentence, ...]) -> bool:
    """PRD 4.2.5 rule 3: under MIN_BODY_CHARS and without a complete Sentence (a dedication, a title page)."""
    chars = sum(len(s.text) for s in sentences)
    return chars < MIN_BODY_CHARS and not any(_COMPLETE_SENTENCE.match(s.text) for s in sentences)


def _title_words(title: str) -> str:
    """A title's words in lower case, single-spaced, without punctuation: "About the Author:" → "about the author"."""
    return " ".join(re.sub(r"[^\w\s]", " ", title.lower()).split())


def _comparable(text: str) -> str:
    """Text reduced to its letters and digits, lowercased, for comparing a heading with a title."""
    return re.sub(r"[\W_]", "", text.lower())


def _without_title(paragraphs: list[str], title: str | None) -> list[str]:
    """Drops the Chapter's opening heading when it only repeats the Chapter's title (ignoring case, spacing and
    punctuation): the title is shown as the Chapter's name, so it is not read as a Sentence."""
    if title and paragraphs and _comparable(title) and _comparable(paragraphs[0]) == _comparable(title):
        return paragraphs[1:]
    return paragraphs


def _sentences(paragraphs: list[str]) -> tuple[ParsedSentence, ...]:
    return tuple(
        ParsedSentence(paragraph_index=p, text=s, spoken_text=spoken_text(s))
        for p, paragraph in enumerate(paragraphs)
        for s in split_sentences(paragraph)
    )


def _rootfile_path(z: zipfile.ZipFile) -> str:
    rootfile = _read_xml(z, "META-INF/container.xml").find("c:rootfiles/c:rootfile", NS)
    path = _attr(rootfile, "full-path")
    if not path:
        raise ValueError("EPUB container.xml has no rootfile")
    return path


def _read_xml(z: zipfile.ZipFile, path: str) -> etree._Element:
    root = etree.fromstring(z.read(path), _XML_PARSER)
    if root is None:
        raise ValueError(f"{path} is not XML")
    return root


def _attr(el: etree._Element | None, name: str) -> str:
    """An attribute's value, or "" when the element or attribute is missing."""
    value = el.get(name) if el is not None else None
    return str(value) if value is not None else ""


def _text(el: etree._Element | None) -> str | None:
    """Normalized text content of an element, or None when missing or blank."""
    if el is None:
        return None
    return _normalize("".join(str(t) for t in el.itertext())) or None


def _resolve(base_dir: str, href: str) -> str:
    """Resolves an href relative to the file's directory into a zip path."""
    return posixpath.normpath(posixpath.join(base_dir, unquote(href)))


def _normalize(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def _toc_targets(
    z: zipfile.ZipFile, opf: etree._Element, opf_dir: str, manifest: dict[str, etree._Element]
) -> list[_TocTarget]:
    """Top-level TOC entries from the EPUB 3 nav, falling back to the EPUB 2 NCX."""
    nav_item = next((i for i in manifest.values() if "nav" in _attr(i, "properties").split()), None)
    if nav_item is not None:
        nav_path = _resolve(opf_dir, _attr(nav_item, "href"))
        doc = _read_xml(z, nav_path)
        nav = next(
            (n for n in doc.iter(f"{{{NS['x']}}}nav") if "toc" in _attr(n, f"{{{NS['epub']}}}type").split()), None
        )
        ol = nav.find("x:ol", NS) if nav is not None else None
        if ol is not None:
            return [t for li in ol.iterfind("x:li", NS) if (t := _nav_entry(li, posixpath.dirname(nav_path)))]

    ncx_id = _attr(opf.find("opf:spine", NS), "toc")
    if ncx_id in manifest:
        ncx_path = _resolve(opf_dir, _attr(manifest[ncx_id], "href"))
        return [
            _target(_text(point.find("ncx:navLabel/ncx:text", NS)), posixpath.dirname(ncx_path), src)
            for point in _read_xml(z, ncx_path).iterfind("ncx:navMap/ncx:navPoint", NS)
            if (src := _attr(point.find("ncx:content", NS), "src"))
        ]
    return []


def _non_body_landmarks(
    z: zipfile.ZipFile, opf: etree._Element, opf_dir: str, manifest: dict[str, etree._Element]
) -> set[tuple[str, str | None]]:
    """Targets (document, fragment) that the EPUB 3 landmarks or the EPUB 2 guide mark as non-body (PRD 4.2.5)."""
    # (types, href, the directory the href is relative to)
    marks = [(_attr(ref, "type"), _attr(ref, "href"), opf_dir) for ref in opf.iterfind("opf:guide/opf:reference", NS)]
    nav_item = next((i for i in manifest.values() if "nav" in _attr(i, "properties").split()), None)
    if nav_item is not None:
        nav_path = _resolve(opf_dir, _attr(nav_item, "href"))
        marks += [
            (_attr(a, f"{{{NS['epub']}}}type"), _attr(a, "href"), posixpath.dirname(nav_path))
            for nav in _read_xml(z, nav_path).iter(f"{{{NS['x']}}}nav")
            if "landmarks" in _types(nav)
            for a in nav.iter(f"{{{NS['x']}}}a")
        ]
    targets = (
        _target(None, base, href)
        for kinds, href, base in marks
        if href and not NON_BODY_TYPES.isdisjoint(kinds.split())
    )
    return {(t.doc, t.fragment) for t in targets}


def _types(el: etree._Element) -> list[str]:
    """The element's epub:type values."""
    return _attr(el, f"{{{NS['epub']}}}type").split()


def _target_types(bodies: dict[str, etree._Element], t: _TocTarget) -> set[str]:
    """epub:type values that describe a TOC target: those of the targeted element and its ancestors; for a whole
    document, its <body> and the <body>'s first element (the <section> that usually wraps it)."""
    body = bodies.get(t.doc)
    if body is None:
        return set()
    if t.fragment is None:
        first = next(body.iterchildren(tag=etree.Element), None)
        return {*_types(body), *(_types(first) if first is not None else [])}
    target = next((el for el in body.iter(tag=etree.Element) if el.get("id") == t.fragment), None)
    if target is None:
        return set()
    return {kind for el in (target, *target.iterancestors()) for kind in _types(el)}


def _nav_entry(li: etree._Element, base_dir: str) -> _TocTarget | None:
    """A nav <li>: its own link, or its first descendant link when the label is a bare <span>."""
    own_link = li.find("x:a", NS)
    label = own_link if own_link is not None else li.find("x:span", NS)
    href = _attr(own_link if own_link is not None else li.find(".//x:a", NS), "href")
    return _target(_text(label), base_dir, href) if href else None


def _target(title: str | None, base_dir: str, href: str) -> _TocTarget:
    path, fragment = urldefrag(href)
    return _TocTarget(title, _resolve(base_dir, path), unquote(fragment) or None)


def _body(z: zipfile.ZipFile, doc: str) -> etree._Element | None:
    return _read_xml(z, doc).find("x:body", NS)


def _paragraphs_by_chapter(
    spine: list[str], bodies: dict[str, etree._Element], targets: list[_TocTarget]
) -> list[list[str]]:
    """Walks the spine in order and files each paragraph under the Chapter whose target precedes it.
    Content before the first target (for example a cover outside the TOC) belongs to no Chapter."""
    starts: dict[tuple[str, str | None], int] = {}
    for i, t in enumerate(targets):
        starts.setdefault((t.doc, t.fragment), i)

    paragraphs: list[list[str]] = [[] for _ in targets]
    current: int | None = None
    for doc in spine:
        current = starts.get((doc, None), current)
        body = bodies.get(doc)
        if body is None:
            continue
        for el in body.iter(tag=etree.Element):
            if (anchor := el.get("id")) is not None:
                current = starts.get((doc, anchor), current)
            if current is not None and _is_leaf_block(el):
                text = _block_text(el)
                if text:
                    paragraphs[current].append(text)
    return paragraphs


def _local(el: etree._Element) -> str:
    return etree.QName(el).localname


def _is_leaf_block(el: etree._Element) -> bool:
    if _local(el) not in BLOCK_TAGS or any(_is_hidden(a) for a in (el, *el.iterancestors())):
        return False
    return not any(_local(d) in BLOCK_TAGS for d in el.iterdescendants(tag=etree.Element))


def _is_hidden(el: etree._Element) -> bool:
    """Not part of the text read in place: scripts and styles, and footnotes placed inside the body text."""
    if _local(el) in SKIP_TAGS or "doc-footnote" in _attr(el, "role").split() or "footnote" in _types(el):
        return True
    if not _FOOTNOTE_CLASSES.isdisjoint(_attr(el, "class").split()):
        return True
    return _local(el) == "aside" and not _INLINE_NOTE_TYPES.isdisjoint(_types(el))


def _is_noteref(el: etree._Element) -> bool:
    """A note's reference mark in the text (AC-UP-09): marked as a noteref, or a superscript or bracketed link
    that holds only a number or a note symbol. "19<sup>th</sup>" is not one."""
    if "noteref" in _types(el) or "doc-noteref" in _attr(el, "role").split():
        return True
    text = "".join(str(t) for t in el.itertext()).strip()
    if _local(el) == "sup":
        return bool(_NOTE_MARK.fullmatch(text))
    return _local(el) == "a" and "#" in _attr(el, "href") and bool(_BRACKETED_NOTE_MARK.fullmatch(text))


def _block_text(el: etree._Element) -> str:
    """Visible text of a block, with <br/> read as a space and note reference marks left out."""
    return _normalize("".join(_inline_text(el)))


def _inline_text(el: etree._Element) -> list[str]:
    parts = [el.text or ""] if isinstance(el.tag, str) else []
    for child in el:
        if isinstance(child.tag, str):  # not a comment or processing instruction
            if _local(child) == "br":
                parts.append(" ")
            elif not (_is_hidden(child) or _is_noteref(child)):
                parts += _inline_text(child)
        parts.append(child.tail or "")
    return parts
