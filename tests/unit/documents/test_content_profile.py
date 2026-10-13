import io

import fitz
from PIL import Image

from workers.documents.content_profile import summarize_pdf_content, profile_pdf_page
from workers.documents.processor import inspect


def test_page_profiles_are_local_metadata_no_customer_text():
    img = Image.new('RGB', (80, 120), 'white')
    out = io.BytesIO()
    img.save(out, format='PNG')
    doc = fitz.open()
    page = doc.new_page()
    page.insert_text((50, 60), 'Confidential private text')
    page = doc.new_page()
    page.insert_image(fitz.Rect(20, 30, 160, 180), stream=out.getvalue())
    page = doc.new_page()
    page.insert_text((50, 60), 'mixed text and graphic')
    page.insert_image(fitz.Rect(100, 100, 200, 240), stream=out.getvalue())
    page = doc.new_page()
    page.draw_rect(fitz.Rect(25, 25, 200, 400))
    summary = summarize_pdf_content(doc)
    assert [p['content_kind'] for p in summary['page_content_signals']] == [
        'digital_text', 'raster_no_extractable_text', 'text_with_images', 'blank_or_vector']
    assert summary['content_review_recommended'] is True
    assert summary['content_kind_counts']['text_with_images'] == 1
    assert summary['page_content_signals'][1]['raster_image_count'] == 1
    assert summary['page_content_signals'][1]['largest_image_page_fraction'] > 0
    assert 'Confidential private text' not in str(summary)
    assert 'color' in summary['content_analysis_method']
    doc.close()


def test_digital_text_only_no_extra_manual_review():
    doc = fitz.open()
    page = doc.new_page()
    page.insert_text((30, 30), 'Text only')
    signal = profile_pdf_page(doc[0])
    assert signal['content_kind'] == 'digital_text'
    assert signal['raster_image_count'] == 0
    assert summarize_pdf_content(doc)['content_review_recommended'] is False
    doc.close()


def test_two_hundred_page_local_scan_is_bounded():
    doc = fitz.open()
    for i in range(200):
        p = doc.new_page(width=595, height=842)
        p.insert_text((40, 50), f'Page {i + 1}')
    result = summarize_pdf_content(doc)
    assert len(result['page_content_signals']) == 200
    assert result['content_kind_counts'] == {'digital_text': 200}
    doc.close()


def test_inspect_pdf_reports_content_signals_without_auto_color_choice(tmp_path):
    doc = fitz.open()
    page = doc.new_page()
    page.insert_text((30, 60), 'Test document')
    sample = tmp_path / 'test.pdf'
    sample.write_bytes(doc.tobytes())
    doc.close()
    inspected = inspect(sample)
    assert inspected['status'] == 'READY'
    assert inspected['page_content_signals'][0]['content_kind'] == 'digital_text'
    assert inspected['content_review_recommended'] is False
    assert not any(key in inspected for key in ('print_color', 'printer_id', 'auto_print'))
    assert inspected['document_pages'] == 1
