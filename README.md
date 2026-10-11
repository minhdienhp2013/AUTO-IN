# AUTO-IN — In tự động Minh Điến

Phần mềm độc lập: Zalo OA → chuẩn bị tài liệu/yêu cầu → khách xác nhận → nhân viên duyệt → Windows/Ricoh IM7000 → kiểm tra, giao giấy và đối soát tiền.

V1 tự in đen trắng; in màu, Excel và trường hợp khó chuyển nhân viên. Mọi lệnh in thật cần được duyệt đúng phiên bản. Chưa có ứng dụng chạy hoặc tích hợp đã kiểm chứng.

## Bắt đầu

1. Đọc [AGENTS.md](AGENTS.md) và [quy tắc chung](docs/QUY_TAC_AI.md).
2. Chọn [prompt theo vai trò](docs/prompts/README.md), nhận đúng mã việc trong [bảng phân công](docs/PHAN_CONG_AI.md).
3. Đọc [đặc tả đầy đủ](docs/spec/DAC_TA_TN001-TN037.md) và [hợp đồng dữ liệu dự thảo](docs/HOP_DONG_DU_LIEU.md); làm trên nhánh/worktree riêng.
4. Bàn giao commit/PR và kết quả kiểm thử theo mẫu 6 dòng. Các lượt sau chỉ gửi mã việc và thay đổi.

[Bản Word gốc](docs/spec/Dac_ta_nghiep_vu_Minh_Dien_2026-10-11.docx) · [Tổng hợp nghiệp vụ](docs/TONG_HOP_NGHIEP_VU.md).

## Trạng thái

Đã chuẩn bị tài liệu điều phối; chưa chốt stack, chưa có mã sản phẩm, chưa kiểm chứng OA/Windows/Ricoh/iPhone, chưa nghiệm thu. Chạy khảo sát OA và đường tài liệu/in trước khi giao triển khai sâu. Không đưa tài liệu khách hoặc khóa bí mật vào repo.

