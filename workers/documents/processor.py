"""Fail-closed document inspection, lightweight preview, and physical sheet planning.

Wire v0.1 JSON uses snake_case. This module does not grant print approval.
"""
from __future__ import annotations

import hashlib
import io
import json
import math
from pathlib import Path, PurePosixPath
import re
import stat
import tempfile
import zipfile
from typing import Any

MAX_FILE = 25 * 1024 * 1024
MAX_ARCHIVE = 60 * 1024 * 1024
MAX_ARCHIVE_ENTRIES = 100
MAX_DOCS = 5
MAX_PAGES = 500
IMAGE_EXTENSIONS = {'.png', '.jpg', '.jpeg', '.tif', '.tiff', '.webp', '.bmp'}
SUPPORTED = IMAGE_EXTENSIONS | {'.pdf', '.docx'}
MANUAL = {'.xls', '.xlsx', '.doc', '.ppt', '.pptx', '.odt', '.csv'}


def _human(code: str, **details: Any) -> dict[str, Any]:
    return {'status': 'NEEDS_HUMAN', 'reason_code': code, 'evidence_kind': 'local_inspection', **details}


def _digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _render_pdf(data: bytes, preview_dir: Path | None, stem: str) -> dict[str, Any]:
    try:
        import fitz
        with fitz.open(stream=data, filetype='pdf') as pdf:
            if pdf.needs_pass or pdf.is_encrypted:
                return _human('PASSWORD_PROTECTED')
            n = len(pdf)
            if not 1 <= n <= MAX_PAGES:
                return _human('INVALID_PAGE_COUNT')
            sizes = [{'width_mm': round(page.rect.width * 25.4 / 72, 1),
                      'height_mm': round(page.rect.height * 25.4 / 72, 1)} for page in pdf]
            previews: list[str] = []
            if preview_dir:
                preview_dir.mkdir(parents=True, exist_ok=True)
                for i in sorted({0, n // 2, n - 1}):
                    page = pdf[i]
                    # Max 1600 px per axis; never accidentally rasterize a huge page.
                    scale = min(1.25, 1600 / max(page.rect.width, page.rect.height))
                    pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
                    filename = f'{stem}-p{i+1}.png'
                    (preview_dir / filename).write_bytes(pix.tobytes('png'))
                    previews.append(filename)
            return {'status': 'READY', 'evidence_kind': 'local_render',
                    'render_method': f'pymupdf-{fitz.VersionBind}', 'document_pages': n,
                    'page_sizes': sizes, 'preview_files': previews}
    except Exception:
        return _human('PDF_RENDER_FAILED')


def _image(data: bytes, preview_dir: Path | None, stem: str) -> dict[str, Any]:
    try:
        from PIL import Image, ImageOps, UnidentifiedImageError
        Image.MAX_IMAGE_PIXELS = 40_000_000
        with Image.open(io.BytesIO(data)) as img:
            n = getattr(img, 'n_frames', 1)
            if not 1 <= n <= MAX_PAGES:
                return _human('INVALID_PAGE_COUNT')
            sizes = []
            previews = []
            for i in range(n):
                img.seek(i)
                frame = ImageOps.exif_transpose(img).convert('RGB')
                if frame.width * frame.height > 40_000_000:
                    return _human('IMAGE_TOO_LARGE')
                sizes.append({'width_px': frame.width, 'height_px': frame.height})
                if preview_dir and i in {0, n // 2, n - 1}:
                    preview_dir.mkdir(parents=True, exist_ok=True)
                    frame.thumbnail((1600, 1600))
                    filename = f'{stem}-p{i+1}.png'
                    frame.save(preview_dir / filename, 'PNG')
                    previews.append(filename)
            return {'status': 'READY', 'evidence_kind': 'local_render',
                    'render_method': 'pillow_exif_transpose', 'document_pages': n,
                    'page_sizes': sizes, 'preview_files': previews,
                    'warnings': ['IMAGE_PAPER_SIZE_REQUIRES_CONFIRMATION']}
    except Exception:
        return _human('IMAGE_DECODE_FAILED')


def _validate_zip_entry(info: zipfile.ZipInfo) -> str | None:
    name = info.filename.replace('\\', '/')
    path = PurePosixPath(name)
    if (name.startswith('/') or re.match(r'^[A-Za-z]:', name) or
            '..' in path.parts or not name.strip() or '\x00' in name):
        return 'ZIP_PATH_TRAVERSAL'
    mode = info.external_attr >> 16
    if stat.S_IFMT(mode) == stat.S_IFLNK:
        return 'ZIP_SYMLINK'
    if info.flag_bits & 1:
        return 'ZIP_ENCRYPTED'
    if info.file_size > MAX_FILE:
        return 'ZIP_ENTRY_TOO_LARGE'
    if info.file_size and info.file_size / max(info.compress_size, 1) > 100:
        return 'ZIP_COMPRESSION_RATIO'
    return None


def _check_archive(data: bytes) -> tuple[list[tuple[str, bytes]], str | None]:
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            entries = archive.infolist()
            if len(entries) > MAX_ARCHIVE_ENTRIES:
                return [], 'ZIP_TOO_MANY_ENTRIES'
            files = [e for e in entries if not e.is_dir()]
            if sum(e.file_size for e in files) > MAX_ARCHIVE:
                return [], 'ZIP_EXPANSION_LIMIT'
            results = []
            for e in files:
                bad = _validate_zip_entry(e)
                if bad:
                    return [], bad
                ext = Path(e.filename).suffix.lower()
                if ext == '.zip':
                    return [], 'NESTED_ZIP_REQUIRES_HUMAN'
                if ext in SUPPORTED | MANUAL:
                    if len(results) >= MAX_DOCS:
                        return [], 'OVER_FIVE_DOCUMENTS'
                    payload = archive.read(e)
                    if len(payload) != e.file_size:
                        return [], 'ZIP_LENGTH_MISMATCH'
                    results.append((e.filename, payload))
            return results, None
    except (zipfile.BadZipFile, RuntimeError, OSError, ValueError):
        return [], 'ZIP_CORRUPT'


def _inspect_data(filename: str, data: bytes, preview_dir: Path | None = None,
                  stem: str = 'preview') -> dict[str, Any]:
    ext = Path(filename).suffix.lower()
    common = {'file_name': Path(filename).name, 'file_sha256': _digest(data),
              'size_bytes': len(data)}
    if len(data) == 0 or len(data) > MAX_FILE:
        return {**common, **_human('INVALID_FILE_SIZE')}
    if ext in MANUAL:
        return {**common, **_human('FORMAT_REQUIRES_HUMAN')}
    if ext == '.pdf':
        if not data.lstrip().startswith(b'%PDF-'):
            return {**common, **_human('EXTENSION_CONTENT_MISMATCH')}
        result = _render_pdf(data, preview_dir, stem)
    elif ext in IMAGE_EXTENSIONS:
        result = _image(data, preview_dir, stem)
    elif ext == '.docx':
        # DOCX may render differently from the final native Windows print path.
        # Do not invent a page count from XML paragraphs or a PDF surrogate.
        if not zipfile.is_zipfile(io.BytesIO(data)):
            result = _human('DOCX_CORRUPT')
        else:
            try:
                with zipfile.ZipFile(io.BytesIO(data)) as doc:
                    if 'word/document.xml' not in doc.namelist():
                        result = _human('DOCX_CORRUPT')
                    elif sum(x.file_size for x in doc.infolist()) > MAX_ARCHIVE:
                        result = _human('DOCX_EXPANSION_LIMIT')
                    else:
                        result = _human('WORD_RENDER_PATH_NOT_VERIFIED',
                                        warnings=['Check Vietnamese fonts and compare Word/PDF preview to native driver'])
            except (zipfile.BadZipFile, RuntimeError):
                result = _human('DOCX_CORRUPT')
    else:
        result = _human('UNSUPPORTED_FORMAT')
    return {**common, **result}


def inspect(path: str | Path, preview_dir: str | Path | None = None) -> dict[str, Any]:
    """Inspect a local file; does not infer final print readiness or grant approval."""
    path = Path(path)
    try:
        if not path.is_file() or path.stat().st_size > MAX_FILE:
            return _human('INVALID_FILE_SIZE')
        data = path.read_bytes()
    except OSError:
        return _human('FILE_UNREADABLE')
    previews = Path(preview_dir) if preview_dir is not None else None
    if path.suffix.lower() != '.zip':
        return _inspect_data(path.name, data, previews, _digest(data)[:12])
    docs, error = _check_archive(data)
    if error:
        return {'file_name': path.name, 'file_sha256': _digest(data),
                'document_count': 0, **_human(error)}
    if not docs:
        return {'file_name': path.name, 'document_count': 0, **_human('ZIP_NO_DOCUMENTS')}
    results = [_inspect_data(name, payload, previews, f'{_digest(payload)[:10]}-{i}')
               for i, (name, payload) in enumerate(docs)]
    ready = all(item['status'] == 'READY' for item in results)
    return {'file_name': path.name, 'file_sha256': _digest(data),
            'document_count': len(results), 'documents': results,
            'status': 'READY' if ready else 'NEEDS_HUMAN',
            'evidence_kind': 'local_inspection',
            **({'reason_code': 'ARCHIVE_HAS_UNVERIFIED_DOCUMENT'} if not ready else {})}


def select_pages(expression: str | None, document_pages: int) -> list[int]:
    if not isinstance(document_pages, int) or document_pages < 1:
        raise ValueError('Reliable document_pages required')
    if expression is None or expression.lower() == 'all':
        return list(range(1, document_pages + 1))
    pages: list[int] = []
    for chunk in expression.split(','):
        match = re.fullmatch(r'\s*(\d+)(?:\s*-\s*(\d+))?\s*', chunk)
        if not match:
            raise ValueError('Invalid page range')
        start = int(match[1]); end = int(match[2]) if match[2] else start
        if start < 1 or end > document_pages or end < start:
            raise ValueError('Page range outside document')
        pages.extend(range(start, end + 1))
    if len(pages) != len(set(pages)):
        raise ValueError('Overlapping page range')
    return pages


def plan(files: list[dict[str, Any]]) -> dict[str, Any]:
    """Count every independent file and copy separately; never share duplex backs."""
    items = []
    for item in files:
        if item.get('status') != 'READY':
            raise ValueError('Only READY documents can be counted')
        copies = item.get('copies', 1)
        duplex = item.get('duplex', False)
        paper = item.get('paper', 'A4')
        orientation = item.get('orientation', 'portrait')
        binding = item.get('binding', 'long_edge')
        if type(copies) is not int or not 1 <= copies <= 999:
            raise ValueError('Invalid copies')
        if type(duplex) is not bool or paper not in ('A4', 'A3'):
            raise ValueError('Invalid print settings')
        if orientation not in ('portrait', 'landscape') or binding not in ('long_edge', 'short_edge'):
            raise ValueError('Invalid orientation or binding')
        selected = select_pages(item.get('page_range'), item['document_pages'])
        faces = len(selected) * copies
        sheets = (math.ceil(len(selected) / 2) if duplex else len(selected)) * copies
        items.append({'file_sha256': item['file_sha256'], 'document_pages': item['document_pages'],
                      'selected_pages': selected, 'copies': copies, 'duplex': duplex,
                      'paper': paper, 'orientation': orientation, 'binding': binding,
                      'scale_mode': 'shrink_to_printable_area_only',
                      'printed_faces': faces, 'physical_sheets': sheets,
                      'separate_each_file_and_copy': True})
    return {'files': items, 'document_pages': sum(x['document_pages'] for x in items),
            'printed_faces': sum(x['printed_faces'] for x in items),
            'physical_sheets': sum(x['physical_sheets'] for x in items),
            'requires_price_confirmation': sum(x['physical_sheets'] for x in items) > 150,
            'evidence_kind': 'calculated_from_rendered_page_count'}
