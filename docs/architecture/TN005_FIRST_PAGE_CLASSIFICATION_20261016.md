# TN-005 / TN-005A — Tự nhận diện loại văn bản từ đúng một trang đầu (quyết định chủ 16/10/2026)

## Quyết định nghiệp vụ
Chủ cửa hàng yêu cầu **tự động nhận diện loại nội dung** khi khách gửi tài liệu, **không cần khai báo thủ công tên loại/từ khóa**. Để nhanh và tiết kiệm tài nguyên, bước phân loại được phép đọc **duy nhất trang 1** của từng file. Đây là tính năng mới bổ sung vào TN-005, không thay thế bước xác nhận của khách hay quyền duyệt của nhân viên.

Đây là **hợp đồng/yêu cầu cho AI chuyên môn**, chưa phải mã triển khai hoặc bằng chứng phân loại đã PASS.

## Phạm vi/không nhầm khái niệm
- Phân loại **nội dung**: bài tập/phiếu học tập; đề thi/đề kiểm tra; đơn từ/tờ khai; hợp đồng/biên bản; giáo án/tài liệu giảng dạy; CV/hồ sơ; văn bản hành chính; tài liệu thông thường; khác/chưa xác định.
- Phân loại **khác** nhận diện định dạng file (PDF/Word/ảnh) và **khác** tín hiệu cấu trúc PDF hiện có (digital_text/text_with_images/raster_no_extractable_text/blank_or_vector).
- Với PDF: lấy chữ hoặc OCR/nhận diện hình **chỉ từ page index 0**. Trang 2 trở đi tuyệt đối không được đọc nội dung cho bước phân loại; dùng fixture trang 2 chứa nhãn trái ngược để test.
- Với ảnh/TIFF nhiều frame: chỉ frame đầu cho phân loại. Với file nhiều tài liệu: chỉ trang đầu của **mỗi** tài liệu, không gộp nội dung các khách.
- Với Word/DOCX: nếu chưa có bộ render native tin cậy có thể xác định ranh giới trang 1, **không** được giả đoạn đầu của document.xml là một trang. Trả UNKNOWN/NEEDS_HUMAN cho loại nội dung khi chưa bảo đảm; không ép toàn bộ Word thành PDF. CODE503 Word preflight là nhiệm vụ độc lập.
- Phân loại một trang **không** thay đổi việc đếm toàn bộ trang, xác minh font/preview/in định dạng gốc, chính sách trên 5 file hoặc các kiểm tra an toàn hiện hành.
- Không lấy loại văn bản từ **tên file** hay vài từ khóa một cách mù quáng. Tên file chỉ là gợi ý phụ, không đủ kết luận tin cậy.

## Chiến lược nhận diện tự động
1. AI3 tạo bộ trích xuất/nhận diện tài liệu trang đầu **nội bộ**, ưu tiên PyMuPDF (với PDF text). OCR tiếng Việt/Anh trên **chính trang đầu** nếu có engine cài sẵn và phép xử lý phù hợp; nếu thiếu OCR, đánh dấu chưa xác định rõ ràng, không báo thành công giả.
2. Đề xuất phân loại bằng tín hiệu nội dung từ trang đầu. Dùng bộ phân loại AI văn bản theo interface riêng nếu sau này AI0/AI2 nối DeepSeek và chủ cho phép gửi đoạn dữ liệu tối thiểu; **không dùng** adapter DeepSeekIntentAdapter hiện có như thể nó đã biết loại văn bản. Không gọi API bên ngoài trong giai đoạn AI3 standalone hoặc tự đưa nội dung khách lên Git/log.
3. Trường hợp đủ tín hiệu → loại SUGGESTED và nhãn tin cậy (high/medium/low); mơ hồ, đầu trang là bìa, trang trắng, scan không đọc được → UNKNOWN; lỗi/bảo vệ file → NEEDS_HUMAN theo chính sách hiện hành.
4. Trả dữ liệu phân loại có cấu trúc, tối thiểu: schema_version, category, status, confidence_label, analyzed_page_count=1 (hoặc 0 khi chưa đọc), method, reason_code (khi UNKNOWN). Không trả đoạn văn bản/PII/OCR thô ra response/log/database. Không đưa giá/tùy chọn in đã khẳng định vào output AI3.
5. Kết quả có thể đưa vào bộ câu hỏi gợi ý phù hợp ở AI2/AI0, ví dụ đề thi/phiếu học tập hỏi số bộ, một/hai mặt, đen trắng/màu; đơn từ hỏi số bản/khổ giấy; luôn để khách xác nhận.
6. Học từ sửa sai và giao diện chỉnh quy tắc là giai đoạn riêng; **không** bắt chủ khai báo từ khóa để tính năng này chạy.

## Bất biến an toàn
- **Không** tự báo giá, quyết định màu/đen trắng, số bản, lựa chọn máy, duyệt hoặc phát lệnh in dựa trên nhãn phân loại.
- Kết quả nhận diện chỉ là **gợi ý**, không tự nâng tình trạng tài liệu thành READY hay vượt qua các cảnh báo lỗi font, DOCX, scan không tin cậy.
- Tuân thủ phân vùng shop/customer, thời hạn lưu file, hạn chế chuyển dữ liệu nhạy cảm ra ngoài. Nội dung trích xuất/OCR chỉ xử lý tạm, không ghi nguyên văn trong nhật ký.
- Chưa bật OA thật, không mở outbound, không in thật, không deploy.
- Khi phân loại UNKNOWN, trả lời an toàn: “Tôi đã nhận tài liệu. Bạn muốn in bao nhiêu bản, một hay hai mặt và đen trắng hay màu?”; không bịa loại nội dung.

## Phân công không chồng lấn
- **AI3 — TN005-1PAGE giai đoạn đầu**: chịu trách nhiệm code thuộc workers/documents/**, tests/unit/documents/**, docs/research/AI3_TAI_LIEU_RICOH.md. Thực thi bộ nhận diện trang đầu, test PDF text nhiều trang, ảnh scan/OCR khả dụng và thiếu, file lỗi, không rò chữ nhạy cảm; giữ logic processor cũ và tính ổn định schema. **Chỉ bắt đầu sửa docs/research AI3 sau khi AI3 CODE503 kết thúc hoặc trên cùng nhánh AI3 để không tranh file.**
- **AI0 — TN005-1PAGE composition/contract**: chốt nơi metadata đi vào order/conversation và giao tiếp qua Port, kiểm tra quyền/scope và test PG; sở hữu backend/composition/**, scripts/**, tests/integration/composition/**, các hợp đồng chung.
- **AI2 — TN005-1PAGE trả lời**: khi AI0 chốt shape, chỉ nối loại tài liệu vào quyết định hỏi khách ở backend/conversation/** và test tests/unit/zalo/**. Không để AI2 gọi DeepSeek với toàn văn file; không thay bộ phân loại intent khi CODE502 còn thực hiện.
- **AI4 — tùy chọn hiển thị**: nếu cần UI, sau khi API đã chốt mới hiển thị nhãn gợi ý + trạng thái chưa xác định; không cần giao diện quản lý từ khóa thủ công.
- **AI5**: độc lập đo thời gian, test chỉ trang đầu và fail-closed; synthetic và real-device gates tách bạch.

## Điều kiện nghiệm thu
- File PDF có trang 1 “BÀI TẬP TOÁN” và trang 2 “HỢP ĐỒNG” => chỉ nhận bài tập; đảo nội dung => chỉ nhận hợp đồng. Không truy xuất nội dung từ trang 2 để phân loại.
- Mỗi loại mẫu đại diện được nhận diện tự động; trường hợp bìa hoặc câu chữ mơ hồ => UNKNOWN, không phỏng đoán.
- Scan image nếu không có OCR khả dụng => UNKNOWN/NEEDS_HUMAN, không đoán từ định dạng ảnh.
- Không làm thay đổi việc đếm tất cả trang để tính giấy hoặc bản xem trước và không tự in; nguồn file giả/khác hash => fail closed.
- Benchmark tốc độ xử lý một trang bằng dữ liệu tổng hợp (ghi thời gian đo thực, không tuyên bố SLA nếu chưa có).
- Mỗi AI báo PASS/FAIL/SKIP/NOT RUN thật, branch/base/HEAD/PR. AI0 tích hợp và AI5 nghiệm thu trên cùng SHA trước khi xin merge.

**Căn cứ:** docs/spec/DAC_TA_TN001-TN037.md TN-005, TN-005A, TN-006, TN-007, TN-034; AGENTS.md và docs/PHAN_CONG_AI.md.