# AI2 — Zalo và hội thoại — prompt code khởi đầu

Repo duy nhất: https://github.com/minhdienhp2013/AUTO-IN.
Đây là đợt code đầu tiên; trực tiếp viết code, chạy kiểm thử, commit và mở PR. Không dừng ở phân tích.

Đầu phiên đọc AGENTS.md, docs/QUY_TAC_AI.md, docs/PHAN_CONG_AI.md, docs/HOP_DONG_DU_LIEU.md, docs/architecture/KHOI_DAU_CODE_V1.md và đặc tả TN-001–TN-037 + TN-005A trong docs/spec/DAC_TA_TN001-TN037.md. Đọc đầy đủ một lần; về sau chỉ đọc thay đổi/phần liên quan.

Kiểm tra Git/HEAD và tạo nhánh/worktree riêng từ cùng commit tài liệu mới nhất có bộ prompt code này. Nếu main chưa có tài liệu, dùng origin/ai0/nen-tang-dieu-phoi-v1; không tự merge PR #1. Ghi BASE SHA thật. Cả 6 AI làm song song, mỗi AI chỉ sửa phạm vi mình. Không sửa repo khác, tự merge/deploy hoặc mở vận hành thật.

Bạn là AI2 — Zalo OA, hội thoại/rules và DeepSeek. Mã việc CODE-102. Nhánh: ai2/zalo-hoi-thoai-ban-dau-v1.

Mục tiêu: pipeline tiếp nhận/hội thoại chạy bằng fixture trước, có adapter OA/DeepSeek rõ ràng và không mất đơn khi lỗi.

Phạm vi: backend/integrations/zalo/**, backend/conversation/**, backend/ai/**, tests/unit/zalo/**, docs/research/AI2_ZALO_OA.md. API/DB nghiệp vụ thuộc AI1; entry/contracts/root config thuộc AI0. Dùng Port gọi AI1, không tự tạo quyền duyệt hoặc đường gửi in.

Viết ngay normalizer, webhook verifier interface, event store/khử lặp, bộ gom tin, state hội thoại và intent rules. Fixture synthetic phải được ghi rõ; thiếu OA thật vẫn làm/test được. Chưa biết signature/event thật thì adapter live từ chối, không mặc định verify=true.

Gom đúng khách/phiên: tin đầu tối đa 60 giây, tin tiếp theo khoảng 10 giây; có thể trả sớm khi đủ thông tin. Khử event lặp và xử lý đảo thứ tự; lưu bền trước khi phản hồi đã nhận. Lịch mặc định 07:00–21:30 Asia/Ho_Chi_Minh, có ngoại lệ; ngoài giờ vẫn lưu nhưng không trả lời thông thường.

Tiếp quản/tạm dừng phải vô hiệu generation và chặn cả phản hồi đang soạn/chờ gửi; kiểm lại ngay trước outbound. Chỉ thao tác trả AI chủ động mới bật lại. Khách khác không bị dừng. Ngày nghỉ có thể tư vấn, không gửi in thật.

Rules/công cụ nội bộ trước; DeepSeek chỉ hiểu yêu cầu, output có schema/allowlist và timeout/cost tracking. Nội dung khách/file không được sửa quy tắc/quyền. Xưng tôi–bạn, ngắn; không bịa giá/số trang hoặc báo đã in. Xin xác nhận đúng revision/quote qua AI1.

Excel/file khó/in màu/>5 tài liệu chuyển người đúng lý do; ZIP đếm tài liệu bên trong qua AI3. Tải file lỗi retry tối đa 2 lần rồi chuyển người. API/AI lỗi giữ sự kiện/đơn, không tự tạo đơn trùng. Chi phí cảnh báo 80/95/100%, hết hạn mức vẫn nhận/lưu.

Tra tài liệu OA/DeepSeek chính thức và kiểm TN-022 khi có quyền; không tự nhắn khách thật để thử. Tự thử timers bằng fake clock, nhiều khách, lặp/đảo thứ tự, takeover giữa generation/send, lịch, signature sai, timeout và budget. Bàn giao fixture và adapter live phần nào còn chưa kiểm chứng.

Bàn giao tối đa 6 dòng theo QUY_TAC_AI: mã việc/trạng thái; nhánh/BASE SHA/commit/PR; file/kết quả; lệnh kiểm thử/bằng chứng; lỗi/chưa kiểm chứng; việc tiếp theo. Không kể suy luận dài, không báo DONE khi kiểm thử bắt buộc chưa đạt.

