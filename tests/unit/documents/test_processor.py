import io
import zipfile
import pytest
import fitz
from PIL import Image
from workers.documents.processor import inspect, plan, select_pages


def sample_pdf(pages=3):
    doc = fitz.open()
    for idx in range(pages):
        page = doc.new_page(width=595, height=842)
        page.insert_text((40, 40), f'Public synthetic page {idx + 1}')
    value = doc.tobytes()
    doc.close()
    return value


def archive_file(path, entries):
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
        for name, body in entries:
            z.writestr(name, body)


def test_pdf_real_render_and_preview(tmp_path):
    source = tmp_path / 'file.pdf'
    source.write_bytes(sample_pdf(3))
    result = inspect(source, tmp_path / 'preview')
    assert result['status'] == 'READY'
    assert result['document_pages'] == 3
    assert len(result['preview_files']) == 3
    assert all((tmp_path / 'preview' / p).is_file() for p in result['preview_files'])


def test_image_exif_read_and_preview(tmp_path):
    img = Image.new('RGB', (300, 400), 'white')
    stream = io.BytesIO(); img.save(stream, 'PNG')
    p = tmp_path / 'photo.png'; p.write_bytes(stream.getvalue())
    result = inspect(p, tmp_path / 'p')
    assert result['status'] == 'READY'
    assert result['document_pages'] == 1
    assert 'IMAGE_PAPER_SIZE_REQUIRES_CONFIRMATION' in result['warnings']


def test_duplex_odd_copies_separate(tmp_path):
    p = tmp_path / 'doc.pdf'; p.write_bytes(sample_pdf(3))
    info = inspect(p)
    result = plan([{**info, 'copies': 3, 'duplex': True, 'paper': 'A4'}])
    assert result['printed_faces'] == 9
    assert result['physical_sheets'] == 6  # NOT ceil(9/2) -> 5
    assert result['document_pages'] == 3


def test_files_never_share_duplex_sheet(tmp_path):
    p = tmp_path / 'one.pdf'; p.write_bytes(sample_pdf(1))
    info = inspect(p)
    out = plan([{**info, 'duplex': True}, {**info, 'duplex': True}])
    assert out['physical_sheets'] == 2
    assert out['printed_faces'] == 2


def test_page_range_and_large_order(tmp_path):
    p = tmp_path / 'five.pdf'; p.write_bytes(sample_pdf(5))
    info = inspect(p)
    out = plan([{**info, 'copies': 40, 'duplex': True, 'page_range': '1-3,5'}])
    assert out['physical_sheets'] == 80
    assert out['printed_faces'] == 160
    assert out['requires_price_confirmation'] is False
    out = plan([{**info, 'copies': 80, 'duplex': True, 'page_range': '1-3,5'}])
    assert out['physical_sheets'] == 160
    assert out['requires_price_confirmation'] is True
    with pytest.raises(ValueError):
        select_pages('1-3,3', 5)


def test_zip_traversal_bomb_and_many_docs(tmp_path):
    z = tmp_path / 'bad.zip'
    archive_file(z, [('../secret.pdf', sample_pdf())])
    assert inspect(z)['reason_code'] == 'ZIP_PATH_TRAVERSAL'
    archive_file(z, [(f'{i}.pdf', sample_pdf(1)) for i in range(6)])
    assert inspect(z)['reason_code'] == 'OVER_FIVE_DOCUMENTS'
    archive_file(z, [('huge.pdf', b'A' * 500_000)])
    assert inspect(z)['reason_code'] == 'ZIP_COMPRESSION_RATIO'


def test_zip_valid_and_excel_manual(tmp_path):
    z = tmp_path / 'good.zip'
    archive_file(z, [('a.pdf', sample_pdf(1)), ('b.pdf', sample_pdf(2))])
    r = inspect(z, tmp_path / 'pv')
    assert r['status'] == 'READY' and r['document_count'] == 2
    x = tmp_path / 'report.xlsx'; x.write_bytes(b'invalid')
    assert inspect(x)['status'] == 'NEEDS_HUMAN'


def test_word_no_guessed_pages_and_corrupt_file(tmp_path):
    doc = tmp_path / 'test.docx'
    with zipfile.ZipFile(doc, 'w') as z:
        z.writestr('word/document.xml', '<w:document/>')
    assert inspect(doc)['reason_code'] == 'WORD_RENDER_PATH_NOT_VERIFIED'
    assert 'document_pages' not in inspect(doc)
    doc.write_bytes(b'invalid')
    assert inspect(doc)['reason_code'] == 'DOCX_CORRUPT'


def test_encrypted_pdf_needs_human(tmp_path):
    doc = fitz.open(); doc.new_page(); pdf = doc.tobytes(encryption=fitz.PDF_ENCRYPT_AES_256,
                                                        owner_pw='owner', user_pw='secret')
    doc.close(); path = tmp_path / 'secure.pdf'; path.write_bytes(pdf)
    assert inspect(path)['reason_code'] == 'PASSWORD_PROTECTED'
