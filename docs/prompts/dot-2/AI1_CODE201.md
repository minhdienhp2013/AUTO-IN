# AI1 — CODE-201

Đọc README.md của thư mục này, báo cáo kiểm tra AI1–AI5, AGENTS.md và TN-007/017/026/027/033/035/036. Tạo nhánh ai1/dot2-core-pg-readmodel từ fc0ca144a9ea4fa4092c9e1de5109d690505aacd; lấy khung a681fe9 theo hướng dẫn chung.

Chỉ sửa backend/core/**, backend/api/**, backend/storage/**, backend/jobs/**, tests/unit/core/**, tests/integration/core/** và docs/research/AI1_NGHIEP_VU_API.md. Không sửa root/contracts/app/web.

1. Chạy migration001/002 và suite transaction/concurrency trên PostgreSQL thật, DB test riêng. Nếu thiếu server, chuẩn bị lệnh/test và ghi BLOCKED, không coi skip là đạt. Khóa cạnh tranh, stale revision, idempotency khác payload, double-claim, UNKNOWN, đổi mode, hoàn/giao/đóng ngoại lệ phải có bằng chứng.
2. Sửa claim xếp theo lúc khách hoàn tất xác nhận hiệu lực (TN-007), không theo lúc nhân viên duyệt; thêm ca A xác nhận trước B nhưng B được duyệt trước A. Giữ NOT_SENT-only/SKIP LOCKED và không để đơn thiếu thông tin chặn đơn hợp lệ khác.
3. Mở rộng getOrder read model bằng dữ liệu thật: xác nhận yêu cầu/giá đúng revision/hash/quote, approval, plan/preview đã được processor kiểm chứng, mode_at_send và giấy kiểm chứng. Không dựng cờ ready hoặc preview khi chưa có artifact. Giữ response đang dùng, thêm trường có mô tả để AI0 khóa schema và AI4 mapper.
4. Thêm hai route handover/return-to-ai đã được AI0 cấp; generation có version + transaction + auth theo shop/hội thoại. AI2 nhận Port kiểm lại quyền/generation trước gửi. Credential customer/agent/processor phải có resolver server và scope printer/shop; thiếu cấu hình thì fail closed, không actor/role header trần. Gửi đề xuất Port cho AI0, không tự expose endpoint processor mới.

Kiểm thêm verify-paper khi chỉ có một phần giấy: không làm UI hiểu đã đủ toàn bộ bản in; lưu rõ verified/planned/missing và không tự in bù. Commit sửa core sớm. Bàn giao6dòng: SHA/PR, file, lệnh và kết quả thật, blocker, read model/Port cho AI0–AI2–AI4–AI5. Không tự merge/deploy/in thật.
