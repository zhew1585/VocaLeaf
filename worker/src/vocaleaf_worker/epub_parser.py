"""Turns an EPUB into Chapters and Sentences.

A Chapter is a top-level entry of the table of contents; it runs from that entry's target to the
next top-level entry's target in spine order, so nested entries fold into their top-level Chapter.
Non-body detection, abbreviations, footnotes and number spelling (PRD 4.2.5, 4.2.6) come with #3.
"""

import io
import posixpath
import re
import zipfile
from dataclasses import dataclass
from urllib.parse import unquote, urldefrag

from lxml import etree

from vocaleaf_worker.sentences import split_sentences

# 0.2.0: abbreviations do not end Sentences; a heading repeating the Chapter title is not a Sentence.
# Books are parsed once (PRD 4.2.6), so Books parsed by an older version keep their Sentences.
PARSER_VERSION = "0.2.0"

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

_XML_PARSER = etree.XMLParser(recover=True, resolve_entities=False, no_network=True)


@dataclass(frozen=True)
class ParsedSentence:
    paragraph_index: int
    text: str
    # What the narrator reads. Equal to text until #3 adds number spelling and note removal.
    spoken_text: str


@dataclass(frozen=True)
class ParsedChapter:
    title: str | None
    sentences: tuple[ParsedSentence, ...]


@dataclass(frozen=True)
class ParsedBook:
    title: str | None
    author: str | None
    chapters: tuple[ParsedChapter, ...]


@dataclass(frozen=True)
class _TocTarget:
    title: str | None
    doc: str
    fragment: str | None


def parse_epub(data: bytes) -> ParsedBook:
    """Parses EPUB bytes. Raises on unreadable input; the caller reports that as a failed job."""
    with zipfile.ZipFile(io.BytesIO(data)) as z:
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
        paragraphs = _paragraphs_by_chapter(z, spine, targets)

    chapters = tuple(
        ParsedChapter(title=t.title, sentences=_sentences(_without_title(paragraphs[i], t.title)))
        for i, t in enumerate(targets)
    )
    return ParsedBook(
        title=_text(opf.find("opf:metadata/dc:title", NS)),
        author=_text(opf.find("opf:metadata/dc:creator", NS)),
        chapters=chapters,
    )


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
        ParsedSentence(paragraph_index=p, text=s, spoken_text=s)
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


def _nav_entry(li: etree._Element, base_dir: str) -> _TocTarget | None:
    """A nav <li>: its own link, or its first descendant link when the label is a bare <span>."""
    own_link = li.find("x:a", NS)
    label = own_link if own_link is not None else li.find("x:span", NS)
    href = _attr(own_link if own_link is not None else li.find(".//x:a", NS), "href")
    return _target(_text(label), base_dir, href) if href else None


def _target(title: str | None, base_dir: str, href: str) -> _TocTarget:
    path, fragment = urldefrag(href)
    return _TocTarget(title, _resolve(base_dir, path), unquote(fragment) or None)


def _paragraphs_by_chapter(z: zipfile.ZipFile, spine: list[str], targets: list[_TocTarget]) -> list[list[str]]:
    """Walks the spine in order and files each paragraph under the Chapter whose target precedes it.
    Content before the first target (for example a cover outside the TOC) belongs to no Chapter."""
    starts: dict[tuple[str, str | None], int] = {}
    for i, t in enumerate(targets):
        starts.setdefault((t.doc, t.fragment), i)

    paragraphs: list[list[str]] = [[] for _ in targets]
    current: int | None = None
    for doc in spine:
        current = starts.get((doc, None), current)
        if doc not in z.namelist():
            continue
        body = _read_xml(z, doc).find("x:body", NS)
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
    if _local(el) not in BLOCK_TAGS or any(_local(a) in SKIP_TAGS for a in el.iterancestors()):
        return False
    return not any(_local(d) in BLOCK_TAGS for d in el.iterdescendants(tag=etree.Element))


def _block_text(el: etree._Element) -> str:
    """Visible text of a block, with <br/> read as a space."""
    parts: list[str] = []
    for node in el.iter():
        if not isinstance(node.tag, str):  # comments and processing instructions
            if node.tail:
                parts.append(node.tail)
            continue
        local = _local(node)
        if node is not el and local in SKIP_TAGS:
            continue
        if local == "br":
            parts.append(" ")
        elif node.text:
            parts.append(node.text)
        if node is not el and node.tail:
            parts.append(node.tail)
    return _normalize("".join(parts))
