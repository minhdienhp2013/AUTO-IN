"""Local, privacy-minimal PDF page signals for TN-005 / TN-005A.

Signals are only suggestions for a human/confirmation workflow. No OCR,
no content strings, no inference about whether a page should print in color.
"""
from __future__ import annotations

from collections import Counter
from typing import Any


def profile_pdf_page(page: Any) -> dict[str, Any]:
    """Inspect text structures and raster placement without extracting content."""
    import fitz

    box = page.rect
    area = box.get_area()
    if not 0 < area < float('inf'):
        raise ValueError('Invalid PDF page dimensions')

    blocks = page.get_text('blocks', flags=fitz.TEXTFLAGS_BLOCKS)
    text_chars = sum(len(block[4].strip()) for block in blocks
                     if len(block) > 6 and block[6] == 0)
    image_boxes = []
    for image in page.get_image_info():
        rect = fitz.Rect(image['bbox']) & box
        if not rect.is_empty and rect.get_area() > 0:
            image_boxes.append(rect)
    images = len(image_boxes)
    coverage = round(max((rect.get_area() / area for rect in image_boxes), default=0), 3)

    if text_chars and images:
        kind = 'text_with_images'
    elif text_chars:
        kind = 'digital_text'
    elif images:
        kind = 'raster_no_extractable_text'
    else:
        # Drawn vectors (e.g. CAD/diagrams) have neither raster images nor text.
        kind = 'blank_or_vector'

    return {'page_number': page.number + 1, 'content_kind': kind,
            'text_char_count': text_chars, 'raster_image_count': images,
            'largest_image_page_fraction': coverage}


def summarize_pdf_content(pdf: Any) -> dict[str, Any]:
    """Never return actual text or images; caller retains final print authority."""
    pages = [profile_pdf_page(page) for page in pdf]
    counts = Counter(page['content_kind'] for page in pages)
    needs_review = any(p['content_kind'] != 'digital_text' for p in pages)
    return {'page_content_signals': pages,
            'content_kind_counts': dict(counts),
            'content_review_recommended': needs_review,
            'content_analysis_method': 'pymupdf_structure_no_ocr_no_color_detection'}
