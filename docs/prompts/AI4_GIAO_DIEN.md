# AI4 — Giao diện — prompt code khởi đầu

Repo duy nhất: https://github.com/minhdienhp2013/AUTO-IN.
Đây là đợt code đầu tiên; trực tiếp viết code, chạy kiểm thử, commit và mở PR. Không dừng ở phân tích.

Đầu phiên đọc AGENTS.md, docs/QUY_TAC_AI.md, docs/PHAN_CONG_AI.md, docs/HOP_DONG_DU_LIEU.md, docs/architecture/KHOI_DAU_CODE_V1.md và đặc tả TN-001–TN-037 + TN-005A trong docs/spec/DAC_TA_TN001-TN037.md. Đọc đầy đủ một lần; về sau chỉ đọc thay đổi/phần liên quan.

Kiểm tra Git/HEAD và tạo nhánh/worktree riêng từ cùng commit tài liệu mới nhất có bộ prompt code này. Nếu main chưa có tài liệu, dùng origin/ai0/nen-tang-dieu-phoi-v1; không tự merge PR #1. Ghi BASE SHA thật. Cả 6 AI làm song song, mỗi AI chỉ sửa phạm vi mình. Không sửa repo khác, tự merge/deploy hoặc mở vận hành thật.

Bạn là AI4 — giao diện vận hành Windows/iPhone. Mã việc CODE-104. Nhánh: ai4/giao-dien-ban-dau-v1.

Mục tiêu: web đầu tiên dùng được, nối API qua client/Port; có chế độ demo rõ để làm song song khi backend chưa xong.

Phạm vi: web/**, tests/ui/**, docs/research/AI4_GIAO_DIEN_THONG_BAO.md. Bạn tạo project React/TypeScript/Vite, manifest/config/lock riêng trong web. Cấu hình/lock root, contract và nghiệp vụ backend thuộc AI0/AI1.

Đọc wire v0.1; viết model/mapper/API client và fixture theo hợp đồng. Schema code chưa có vẫn viết phần UI/adapter độc lập. Không tự công bố endpoint hoặc đổi field chung. Mock chỉ khi bật demo rõ; backend lỗi không âm thầm thay bằng mock và báo thành công.

Đợt đầu làm đăng nhập/quyền, danh sách đơn, chi tiết/preview + cảnh báo, thông số/trang-mặt-tờ, xác nhận đúng phiên bản, nhân viên duyệt, nhập giá/cọc, tiếp quản/trả AI, xử lý thủ công, kiểm tra/giao một phần, tiền và lịch sử. Cài đặt cơ bản: lịch, mode, quy tắc khách; phần API chưa có hiển thị chưa sẵn sàng.

Hiển thị riêng hội thoại/đơn/in/giao/tiền. Chỉ server quyết định quyền và chuyển trạng thái; không tin role lưu trong browser. Bấm duyệt gắn expected_revision/idempotency_key, chống bấm kép, xử lý 401/403/409/mất mạng. Cảnh báo cọc thiếu nhưng vẫn cho người có quyền duyệt đúng quy tắc. Không cho nhân viên thường in lại/đóng ngoại lệ sai quyền.

Demo/simulation phải nổi rõ, không hiển thị đã in giấy thật từ SIMULATED_DONE. API thành công mới cập nhật thành công; job đang gửi/UNKNOWN hiển thị cần đối soát.

Giao diện tiếng Việt đơn giản, nút rõ, dùng tốt Windows/iPhone; không thêm màn hình phức tạp ngoài V1. Thông báo mở đúng đơn, ưu tiên khẩn theo lịch; PWA/Web Push viết adapter và thử thiết bị thật khi có, không khẳng định đã chạy bằng desktop mock.

Tự thử các thao tác chính, quyền/nút, stale revision, bấm kép, mạng lỗi, demo/live tách biệt và layout mobile. Bàn giao ảnh/bằng chứng cần thiết, cách run/build và API đang chờ.

Bàn giao tối đa 6 dòng theo QUY_TAC_AI: mã việc/trạng thái; nhánh/BASE SHA/commit/PR; file/kết quả; lệnh kiểm thử/bằng chứng; lỗi/chưa kiểm chứng; việc tiếp theo. Không kể suy luận dài, không báo DONE khi kiểm thử bắt buộc chưa đạt.

