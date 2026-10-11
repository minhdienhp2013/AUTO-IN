# AI3 — CODE-303

Đọc AGENTS.md, docs/QUY_TAC_AI.md, docs/PHAN_CONG_AI.md, docs/prompts/dot-3/README.md, báo cáo docs/architecture/KIEM_TRA_AI1_AI5_2026-10-11.md và các phần hợp đồng/đặc tả TN liên quan. Lượt tiếp theo chỉ đọc thay đổi liên quan. Trực tiếp code, kiểm thử, commit sớm; không chỉ đề xuất.

Nền module: 31e73ea2607f25d521561a6c3fe9fda733900db5. Nhánh mới: ai3/dot3-processor-dryrun. Kiểm tra HEAD thật; nếu nhánh đã có commit mới, giữ thay đổi đó và ghi BASE SHA thực. Nền tài liệu đợt này là commit chứa prompt này, không phải SHA tích hợp sản phẩm.

Phạm vi: workers/documents/**, agents/windows/**, tests/unit/documents/**, tests/unit/printing/**, docs/research/AI3_TAI_LIEU_RICOH.md. Không sửa file chung hoặc module AI khác.

Việc cần làm: Hoàn thiện CLI/JSON entry của bridge để AI0 gọi từ Node: đầu vào/đầu ra ổn định, lỗi có mã, timeout và không lộ nội dung tài liệu. Chỉ xử lý file thuộc artifact root, giữ hash/preview/font/ZIP kiểm thật, unsupported chuyển người. Giao ví dụ artifact manifest/PrintPlan mapper đúng AI1 wire. Chuẩn bị test agent dùng HTTP backend sản phẩm tại localhost simulation; sau SHA CODE-006 chạy claim/preflight/mark-sending/report qua DryRunDriver + journal thật. Thử crash/mất ACK/restart không gửi lại UNKNOWN. Chưa có server vẫn hoàn thiện phần độc lập, không tính mock HTTP là tích hợp thật.

Điều kiện bàn giao: 70 test hiện có và compileall PASS; CLI fixture PDF/ảnh PASS; HTTP sản phẩm PASS hoặc BLOCKED. Không gọi Windows/Ricoh driver thật.

Giữ wire AI1 hiện hành: request_data, kind request/quote, acknowledge_deposit_shortage, lease_token, result/evidence_kind; không đổi hợp đồng chung. Gửi đề xuất cho AI0 nếu thiếu điểm nối. Thiếu thiết bị/registry/DB không chặn phần độc lập; không giả kết quả.

Bàn giao đúng 6 dòng theo QUY_TAC_AI: trạng thái; nhánh/base/commit/PR; file và kết quả; lệnh kiểm thử + PASS/FAIL/SKIP; phần chưa kiểm chứng; việc AI tiếp theo cần làm. Không tự merge/deploy, bật live, in thật hoặc nhắn khách.
