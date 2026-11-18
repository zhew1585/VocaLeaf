"""Builds small EPUB 3 files in memory for tests, written by hand so tests do not depend on the parser's library."""

import io
import zipfile
from dataclasses import dataclass, field


@dataclass
class Doc:
    """One XHTML file in the spine."""

    name: str
    body: str


@dataclass
class TocEntry:
    label: str
    href: str
    children: list["TocEntry"] = field(default_factory=list)


def _nav_list(entries: list[TocEntry]) -> str:
    items = "".join(
        f'<li><a href="{e.href}">{e.label}</a>{_nav_list(e.children) if e.children else ""}</li>' for e in entries
    )
    return f"<ol>{items}</ol>"


def _ncx(entries: list[TocEntry]) -> str:
    points = "".join(
        f'<navPoint id="p{i}"><navLabel><text>{e.label}</text></navLabel><content src="{e.href}"/></navPoint>'
        for i, e in enumerate(entries)
    )
    return f'<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><navMap>{points}</navMap></ncx>'


def make_epub(
    docs: list[Doc],
    toc: list[TocEntry],
    title: str | None = "A Book",
    author: str | None = "An Author",
    epub2: bool = False,
) -> bytes:
    """An EPUB 3 with a nav document, or with epub2=True an EPUB 2 whose TOC is only an NCX."""
    manifest = "".join(
        f'<item id="d{i}" href="{d.name}" media-type="application/xhtml+xml"/>' for i, d in enumerate(docs)
    )
    spine = "".join(f'<itemref idref="d{i}"/>' for i in range(len(docs)))
    meta = (f"<dc:title>{title}</dc:title>" if title else "") + (f"<dc:creator>{author}</dc:creator>" if author else "")
    toc_item = (
        '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>'
        if epub2
        else '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>'
    )
    spine_attr = ' toc="ncx"' if epub2 else ""
    opf = f"""<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">test</dc:identifier><dc:language>en</dc:language>{meta}</metadata>
  <manifest>{toc_item}{manifest}</manifest>
  <spine{spine_attr}>{spine}</spine>
</package>"""
    nav = f"""<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>toc</title></head>
<body><nav epub:type="toc">{_nav_list(toc)}</nav></body></html>"""
    container = """<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>"""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("mimetype", "application/epub+zip", compress_type=zipfile.ZIP_STORED)
        z.writestr("META-INF/container.xml", container)
        z.writestr("OEBPS/content.opf", opf)
        if epub2:
            z.writestr("OEBPS/toc.ncx", _ncx(toc))
        else:
            z.writestr("OEBPS/nav.xhtml", nav)
        for d in docs:
            z.writestr(
                f"OEBPS/{d.name}",
                f'<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body>{d.body}</body></html>',
            )
    return buf.getvalue()
