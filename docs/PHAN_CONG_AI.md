# Phân công AI — V1 AUTO-IN

AI0 giữ tài liệu chung và tích hợp. Bảng này phân phạm vi file, không chốt stack. Các thư mục mã nguồn dưới đây được giữ chỗ theo chức năng trong một sản phẩm đơn giản, không yêu cầu tách thành nhiều dịch vụ.

BASE SHA khởi tạo: c271a240f44cd78b97c088e9e8bde91ad8e05321.
Đọc bộ tài liệu trên nhánh điều phối đang review (hoặc commit đã tích hợp) trước khi nhận việc. Khi bắt đầu, mỗi AI ghi HEAD/BASE SHA thực của checkout vào bàn giao; không dùng SHA cũ máy móc.

## Việc được bắt đầu

| Mã | AI | File/phạm vi được sửa | Đầu ra và điều kiện đạt |
| --- | --- | --- | --- |
| V1-000 | AI0 | README.md, AGENTS.md, .gitignore, docs/QUY_TAC_AI.md, docs/PHAN_CONG_AI.md, docs/HOP_DONG_DU_LIEU.md, docs/prompts/**, docs/spec/**, docs/TONG_HOP_NGHIEP_VU.md | Bộ tài liệu trong PR này; có đủ 37 TN và TN-005A, liên kết đúng, nguồn Word giữ nguyên. |
| V1-001 | AI2 | docs/research/AI2_ZALO_OA.md; backend/integrations/zalo/research/** | Khảo sát TN-022; bảng hỗ trợ/giới hạn + bằng chứng thử thật hoặc thiếu quyền cụ thể. Thử webhook lặp, tải file, hạn URL, giới hạn gửi. Không tự nhắn khách thật để thử. |
| V1-002 | AI3 | docs/research/AI3_TAI_LIEU_RICOH.md; workers/documents/research/**; agents/windows/research/** | Chọn thử bộ xử lý PDF/Word/ảnh và đường Ricoh; kết xuất/đếm/preview, A4/A3/duplex, điểm crash. Phân biệt thật/mô phỏng; mỗi lệnh in thật vẫn cần được duyệt. |
| V1-003 | AI1 | docs/research/AI1_NGHIEP_VU_API.md | Đề xuất trạng thái/quyền/API/khóa cạnh tranh bám đặc tả; chỉ ra thao tác nguyên tử ở duyệt→gửi và thủ công; thử mô hình bằng bảng ca chuyển trạng thái. Gửi AI0 để cập nhật hợp đồng. |
| V1-004 | AI4 | docs/research/AI4_GIAO_DIEN_THONG_BAO.md | Luồng Windows/iPhone, màn hình/nút theo quyền, phương án thông báo; ghi bằng chứng thử thiết bị nếu có. Không xác nhận Push đã chạy bằng mock. |
| V1-005 | AI5 | docs/acceptance/KE_HOACH_NGHIEM_THU.md; tests/acceptance/**; tests/fixtures/public/** | Ma trận TN→ca thử, bộ mẫu/cách tính 90%/80%, phân loại chuyển người, kế hoạch 210 ca/7 ngày và tải 100/ngày. Kế hoạch không phải báo cáo đã đạt. |

V1-001–005 có thể chuẩn bị song song bằng nhánh/worktree riêng; thiếu tài khoản/máy không chặn phần tài liệu/mô phỏng độc lập. Các AI được giao riêng, không tự sinh thêm AI hoặc mở rộng phạm vi.

## Việc chờ AI0 mở sau khảo sát

| Mã | AI | Phạm vi dự kiến | Phụ thuộc và tiêu chí |
| --- | --- | --- | --- |
| V1-010 | AI0 | docs/architecture/**; hợp đồng chung; cấu hình build/CI ở root | Chốt stack/đường in theo V1-001/002; cập nhật hợp đồng tối thiểu và chia từng việc triển khai có ca đạt. |
| V1-020 | AI1 | backend/core/**, backend/api/**, backend/storage/**, backend/jobs/**, tests/unit/core/** | V1-010 và hợp đồng được chốt; backend kiểm quyền/phiên bản/tiền/lệnh in, tự thử đồng thời và phục hồi. |
| V1-030 | AI2 | backend/integrations/zalo/**, backend/conversation/**, backend/ai/**, tests/unit/zalo/** | V1-010 và API tối thiểu AI1; OA/hội thoại/rules/DeepSeek, khử lặp/tiếp quản/lịch/chi phí. |
| V1-040 | AI3 | workers/documents/**, agents/windows/**, tests/unit/documents/**, tests/unit/printing/** | V1-010 và hợp đồng tác vụ AI1; đầu ra tài liệu + journal/gửi Ricoh/đối soát, có phép thử thật trước nghiệm thu. |
| V1-050 | AI4 | web/**, tests/ui/** | V1-010 và hợp đồng API/sự kiện; UI duyệt/giao/tiền/lịch/thông báo, thử đa thiết bị và lỗi đồng bộ. |
| V1-060 | AI5 | tests/acceptance/**, tests/fixtures/public/**, docs/acceptance/** | Kiểm từng phần khi có bàn giao; toàn luồng cần phần tích hợp. Lỗi sản phẩm trả đúng chủ file; nghiệm thu cuối đúng TN-037. |

## Ranh giới

- AI0: đặc tả, hợp đồng, bảng phân công, prompt, cấu hình root/CI và thay đổi tích hợp được ghi rõ.
- AI1 không sửa backend/integrations/zalo, backend/conversation, backend/ai. AI2 không sửa backend/core/api/storage/jobs.
- AI3 giữ pipeline tài liệu + agent; AI4 dùng API, không tự thêm quy tắc duyệt/tiền. AI5 giữ kiểm thử độc lập, không tự sửa mã sản phẩm của AI khác.
- Test đơn vị thuộc AI viết phần đó; kiểm thử nghiệm thu chung thuộc AI5.
- Mỗi file một đầu mối; yêu cầu ngoài phạm vi gửi AI0 chốt trước. File chưa được liệt kê không tự coi là được cấp.
- Thay bảng này/hợp đồng: AI0 cập nhật trong commit rõ ràng. Merge/deploy/mở chính thức theo quyền chủ đã cấp.

## Báo cáo ngắn

Dùng mẫu 6 dòng trong QUY_TAC_AI.md. Yêu cầu liên AI chỉ gồm người nhận, mã việc, đường dẫn, điều cần cung cấp, lý do và điều kiện xong.

