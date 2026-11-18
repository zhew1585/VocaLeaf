"""Builds small EPUB 3 files in memory for tests, written by hand so tests do not depend on the parser's library.
Output is byte-for-byte reproducible (fixed zip timestamps), so committed sample EPUBs can be checked against it."""

import io
import zipfile
from dataclasses import dataclass, field


@dataclass
class Doc:
    """One XHTML file in the spine."""

    name: str
    body: str
    # epub:type of the <body>, e.g. "frontmatter".
    body_type: str | None = None


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


_EPOCH = (2026, 1, 1, 0, 0, 0)


def make_epub(
    docs: list[Doc],
    toc: list[TocEntry],
    title: str | None = "A Book",
    author: str | None = "An Author",
    epub2: bool = False,
    landmarks: list[tuple[str, str]] | None = None,
    guide: list[tuple[str, str]] | None = None,
    extra_files: dict[str, str] | None = None,
) -> bytes:
    """An EPUB 3 with a nav document, or with epub2=True an EPUB 2 whose TOC is only an NCX.
    `landmarks` are (epub:type, href) entries of the EPUB 3 landmarks nav, `guide` (type, href) references of
    the EPUB 2 OPF guide; `extra_files` are added as is, e.g. META-INF/encryption.xml."""
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
  {_guide(guide or [])}
</package>"""
    nav = f"""<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>toc</title></head>
<body><nav epub:type="toc">{_nav_list(toc)}</nav>{_landmarks(landmarks or [])}</body></html>"""
    container = """<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>"""
    files = {"META-INF/container.xml": container, "OEBPS/content.opf": opf}
    files |= {"OEBPS/toc.ncx": _ncx(toc)} if epub2 else {"OEBPS/nav.xhtml": nav}
    for d in docs:
        body_type = f' epub:type="{d.body_type}"' if d.body_type else ""
        files[f"OEBPS/{d.name}"] = (
            '<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"'
            f' xmlns:epub="http://www.idpf.org/2007/ops"><head><title>x</title></head><body{body_type}>{d.body}</body></html>'
        )
    files |= extra_files or {}
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr(zipfile.ZipInfo("mimetype", _EPOCH), "application/epub+zip", compress_type=zipfile.ZIP_STORED)
        for name, content in files.items():
            z.writestr(zipfile.ZipInfo(name, _EPOCH), content, compress_type=zipfile.ZIP_DEFLATED)
    return buf.getvalue()


def _landmarks(entries: list[tuple[str, str]]) -> str:
    if not entries:
        return ""
    items = "".join(f'<li><a epub:type="{t}" href="{href}">{t}</a></li>' for t, href in entries)
    return f'<nav epub:type="landmarks"><ol>{items}</ol></nav>'


def _guide(entries: list[tuple[str, str]]) -> str:
    if not entries:
        return ""
    return "<guide>" + "".join(f'<reference type="{t}" href="{href}" title="{t}"/>' for t, href in entries) + "</guide>"


def font_obfuscation(path: str) -> str:
    """META-INF/encryption.xml declaring only IDPF font obfuscation of `path`: not DRM."""
    return _encryption(path, "http://www.idpf.org/2008/embedding")


def adobe_drm(path: str) -> str:
    """META-INF/encryption.xml as Adobe ADEPT writes it: `path` encrypted with AES."""
    return _encryption(path, "http://www.w3.org/2001/04/xmlenc#aes128-cbc")


def _encryption(path: str, algorithm: str) -> str:
    return f"""<?xml version="1.0"?>
<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#">
  <enc:EncryptedData><enc:EncryptionMethod Algorithm="{algorithm}"/>
    <enc:CipherData><enc:CipherReference URI="{path}"/></enc:CipherData></enc:EncryptedData>
</encryption>"""
