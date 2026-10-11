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

Đã chuẩn bị [6 prompt code khởi đầu](docs/prompts/BO_PROMPT_CODE_KHOI_DAU_V1.md), [stack/wire v0.1](docs/architecture/KHOI_DAU_CODE_V1.md) và phạm vi để 6 AI làm song song. Chưa có scaffold/mã sản phẩm, chưa kiểm chứng OA/Windows/Ricoh/iPhone, chưa nghiệm thu. Mô phỏng là mặc định; phần thử thật làm và ghi bằng chứng riêng. Không đưa tài liệu khách hoặc khóa bí mật vào repo.

