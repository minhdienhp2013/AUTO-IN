"""Deterministic Vietnamese synthetic first pages (CC0-style, no real people/docs).

TN021 benchmark ONLY. Generates 100 byte-distinct images/PDFs at execution time.
Do not store font binaries, OCR ground-truth transcripts or customer data in Git.
"""
from __future__ import annotations

import hashlib
import io
import os
from pathlib import Path

import fitz
from PIL import Image, ImageDraw, ImageFont, ImageFilter

SEED = "tn021-variety-v1-20261017"
CLASSES = (
    "WORKSHEET", "EXAM", "APPLICATION_FORM", "CONTRACT_MINUTES",
    "LESSON_PLAN", "CV_PROFILE", "ADMINISTRATIVE", "GENERAL_DOCUMENT", "UNKNOWN",
)

HEADINGS = {
 "WORKSHEET": ["Bài tập Toán", "Bài tập Tiếng Việt", "Phiếu học tập", "Bài tập đọc hiểu", "Bài tập hình học"],
 "EXAM": ["Đề kiểm tra Toán", "Đề thi Tiếng Việt", "Đề kiểm tra học kỳ", "Đề thi thử", "Đề kiểm tra cuối kỳ"],
 "APPLICATION_FORM": ["Đơn xin nghỉ học", "Đơn đề nghị xác nhận", "Tờ khai", "Đơn đăng ký câu lạc bộ", "Đơn xin cấp lại"],
 "CONTRACT_MINUTES": ["Hợp đồng lao động", "Biên bản cuộc họp", "Hợp đồng thuê nhà", "Biên bản bàn giao", "Hợp đồng dịch vụ"],
 "LESSON_PLAN": ["Giáo án", "Kế hoạch bài dạy", "Giáo án Tiếng Việt", "Kế hoạch bài dạy Toán", "Giáo án Địa lý"],
 "CV_PROFILE": ["Sơ yếu lý lịch", "CV", "Hồ sơ xin việc", "Curriculum Vitae", "Sơ yếu lý lịch"],
 "ADMINISTRATIVE": ["Quyết định", "Thông báo", "Công văn", "Quyết định nhân sự", "Thông báo nội bộ"],
 "GENERAL_DOCUMENT": ["Hướng dẫn sử dụng", "Tài liệu hướng dẫn", "Hướng dẫn sử dụng", "Tài liệu hướng dẫn", "Hướng dẫn sử dụng"],
}

# Human-semantic "hard" headers deliberately include punctuation, prefixes and
# alternate Vietnamese document names. These are not tailored to pass regexes.
HARD_HEADINGS = {
 "WORKSHEET": {2: "Phiếu bài tập thực hành", 4: "Bài tập: Toán lớp 5", 7: "Phiếu ôn tập Toán", 9: "Bài tập Toán – phần nâng cao"},
 "EXAM": {2: "Đề khảo sát chất lượng", 4: "Đề kiểm tra: Toán", 7: "Bài kiểm tra học kỳ", 9: "Đề thi (đợt 2)"},
 "APPLICATION_FORM": {2: "Mẫu đơn xin nghỉ học", 4: "Đơn xin: nghỉ học", 7: "Đơn đề xuất cấp giấy", 9: "Phiếu đăng ký tham gia"},
 "CONTRACT_MINUTES": {2: "Hợp đồng số 12/HĐ", 4: "Biên bản: bàn giao", 7: "Thỏa thuận thuê mặt bằng", 9: "Biên bản nghiệm thu – 2026"},
 "LESSON_PLAN": {2: "Giáo án – tiết 4", 4: "Kế hoạch giảng dạy", 7: "Giáo án: đọc hiểu", 9: "Kế hoạch bài giảng"},
 "CV_PROFILE": {2: "Lý lịch cá nhân", 4: "CV xin việc", 7: "Hồ sơ ứng tuyển", 9: "Sơ yếu lý lịch (bản khai)"},
 "ADMINISTRATIVE": {2: "Quyết định số 15/QĐ", 4: "Thông báo: nghỉ lễ", 7: "Văn bản điều hành", 9: "Công văn số 98/CV"},
 "GENERAL_DOCUMENT": {2: "Sổ tay hướng dẫn sử dụng", 4: "Hướng dẫn cài đặt", 7: "Quy trình vận hành", 9: "Hướng dẫn sử dụng: máy in"},
}

BODIES = {
 "WORKSHEET": ["Họ tên: Học sinh giả lập", "Lớp: 5A", "Câu 1: Tính tổng các số", "Bài 2: Điền kết quả thích hợp", "Ví dụ số: 12 + 8 = ?"],
 "EXAM": ["Thời gian: 45 phút", "Hướng dẫn: làm bài độc lập", "Câu 1: Trình bày đáp án", "Phần 2: Đọc đoạn văn", "Môn học: Tiếng Việt"],
 "APPLICATION_FORM": ["Kính gửi: Bộ phận tiếp nhận", "Tôi tên: Nhân vật giả lập", "Nội dung: đề nghị xem xét", "Người làm đơn: Người mẫu tổng hợp", "Ngày viết: 17 tháng 10"],
 "CONTRACT_MINUTES": ["Bên A: Đơn vị mẫu", "Bên B: Nhân vật giả lập", "Thành phần: đại diện hai bên", "Nội dung cuộc họp: bàn giao", "Thỏa thuận: theo điều khoản"],
 "LESSON_PLAN": ["Mục tiêu: luyện đọc hiểu", "Hoạt động: thảo luận nhóm", "Phương pháp: đặt câu hỏi", "Chuẩn bị: sách và bút", "Đánh giá: theo tiêu chí"],
 "CV_PROFILE": ["Họ và tên: Người giả lập", "Kinh nghiệm: hai năm", "Học vấn: tốt nghiệp đại học", "Kỹ năng: sử dụng máy tính", "Mục tiêu: nghề nghiệp"],
 "ADMINISTRATIVE": ["Căn cứ: kế hoạch năm học", "Điều 1: Phê duyệt nội dung", "Kính gửi: bộ phận phụ trách", "Cơ quan: đơn vị giả lập", "Hiệu lực: kể từ ngày ký"],
 "GENERAL_DOCUMENT": ["Bước 1: Kiểm tra thiết bị", "Cách thực hiện: theo sơ đồ", "Lưu ý: giữ an toàn", "Bước 2: Nhấn nút nguồn", "Bảo quản: nơi khô ráo"],
}


def resolve_font() -> Path:
    """Runtime environment needs a local unicode TTF; never commit font bytes."""
    names = [os.environ.get("TN021_FONT", ""),
             "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
             "/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf",
             "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
             "C:/Windows/Fonts/arial.ttf"]
    for name in names:
        if name and Path(name).is_file():
            return Path(name)
    raise RuntimeError("TN021_FONT_REQUIRED: set TN021_FONT to locally installed Unicode TTF")


def cases():
    """Frozen category/format distribution: eight supported classes ×10 + UNKNOWN×20."""
    all_cases = []
    for kind in CLASSES:
        count = 20 if kind == "UNKNOWN" else 10
        for i in range(count):
            if kind == "UNKNOWN":
                mode = "text_pdf" if i < 8 else "png" if i < 14 else "scan_pdf"
            else:
                mode = "text_pdf" if i < 6 else "png" if i < 8 else "scan_pdf"
            index = len(all_cases) + 1
            all_cases.append({"id": f"TN021-{index:03d}", "expected": kind,
                              "mode": mode, "variant": i,
                              "format_hint": "png" if mode == "png" else "pdf"})
    assert len(all_cases) == 100
    assert len({case["id"] for case in all_cases}) == 100
    return all_cases


def text_for_case(case):
    kind, variant = case["expected"], case["variant"]
    if kind != "UNKNOWN":
        lines = [HARD_HEADINGS[kind].get(variant, HEADINGS[kind][variant % len(HEADINGS[kind])])]
        # Reordered independent structure evidence, while preserving headings.
        body = BODIES[kind][:]
        order = variant % len(body)
        body = body[order:] + body[:order]
        lines.extend(body)
        lines.extend([f"Ví dụ minh họa số {variant + 1}: chỉ là dữ liệu tạo.",
                      f"Mã thử nghiệm: {case['id']}"])
        return lines
    if variant in (0, 1, 2, 3):
        return [HEADINGS["WORKSHEET"][variant], "Trang bìa bộ tài liệu mẫu", "Ngày thử nghiệm: 17 tháng 10"]
    if variant in (4, 5, 6, 7):
        return ["Báo cáo kiểm thử bộ phân loại", "Ví dụ trích dẫn từ giấy học tập",
                "Bài tập Toán", "Họ tên: Người giả lập", "Câu 1: Điền kết quả",
                "Các dòng trên chỉ là ví dụ, không phải tên tài liệu chính"]
    if variant in (8, 9, 10, 11):
        return ["Bài tập Toán", "Nội dung giới thiệu", "Không có câu hỏi hoặc ô họ tên", "Trang bìa"]
    if variant in (12, 13, 14, 15):
        return ["Bài tập Toán", "Hợp đồng lao động", "Họ tên: Học sinh giả lập", "Câu 1: Điền kết quả",
                "Bên A: Đơn vị thử", "Bên B: Người thử", "Hai cấu trúc trùng nhau"]
    return ["Trang ghi chú", "Mẫu khảo sát từ vựng", "Không cung cấp đủ bằng chứng", "Mã: "+case["id"]]


def _raster(lines, font_path, case):
    w, h = 1240, 1740
    image = Image.new("RGB", (w, h), (255, 255, 253))
    draw = ImageDraw.Draw(image)
    variant = case["variant"]
    large = ImageFont.truetype(str(font_path), 36 + (variant % 3) * 2)
    body = ImageFont.truetype(str(font_path), 29 - (variant % 3))
    y = 95 + (variant % 4) * 9
    for line_idx, line in enumerate(lines):
        font = large if line_idx == 0 else body
        draw.text((75 + (variant % 3) * 13, y), line, fill=(26, 26, 26), font=font)
        y += 95 if line_idx == 0 else 68
    if variant in (6, 9, 13):
        image = image.rotate(1.1, resample=Image.Resampling.BICUBIC, fillcolor=(255,255,255))
    if variant in (7, 12):
        image = image.filter(ImageFilter.GaussianBlur(0.35))
    return image


def _text_pdf(lines, font_path, case):
    with fitz.open() as document:
        page = document.new_page(width=595, height=842)
        page.insert_font(fontname="TN021", fontfile=str(font_path))
        for n, line in enumerate(lines):
            # Embed the local Unicode font in the fixture PDF, without shipping fonts.
            page.insert_text((42, 65 + n*46), line, fontsize=17 if n == 0 else 12,
                             fontname="TN021", color=(0.1, 0.1, 0.1))
        # 10 documents intentionally have a conflicting class on page 2;
        # classifier must never inspect the second page.
        if int(case["id"][-3:]) % 10 == 0:
            decoy = document.new_page()
            decoy.insert_font(fontname="TN021", fontfile=str(font_path))
            for j, text in enumerate(["Đề thi Toán", "Thời gian: 60 phút", "Câu 1: Tính toán"]):
                decoy.insert_text((42, 65 + j*35), text, fontname="TN021", fontsize=13)
        return document.tobytes(garbage=4, deflate=True, no_new_id=True)


def materialize(case, font_path):
    lines = text_for_case(case)
    if case["mode"] == "text_pdf":
        payload = _text_pdf(lines, font_path, case)
    else:
        image = _raster(lines, font_path, case)
        with io.BytesIO() as output:
            image.save(output, format="PNG", compress_level=6)
            png_bytes = output.getvalue()
        image.close()
        if case["mode"] == "png":
            payload = png_bytes
        else:
            with fitz.open() as document:
                page = document.new_page(width=595, height=842)
                page.insert_image(page.rect, stream=png_bytes)
                payload = document.tobytes(garbage=4, deflate=True, no_new_id=True)
    return payload, hashlib.sha256(payload).hexdigest()
