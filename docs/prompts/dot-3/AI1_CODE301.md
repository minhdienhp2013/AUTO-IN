# AI1 — CODE-301

Đọc AGENTS.md, docs/QUY_TAC_AI.md, docs/PHAN_CONG_AI.md, docs/prompts/dot-3/README.md, báo cáo docs/architecture/KIEM_TRA_AI1_AI5_2026-10-11.md và các phần hợp đồng/đặc tả TN liên quan. Lượt tiếp theo chỉ đọc thay đổi liên quan. Trực tiếp code, kiểm thử, commit sớm; không chỉ đề xuất.

Nền module: ebdd740d87b3bb72fd7f1229b2ab2e728f55f0bc. Nhánh mới: ai1/dot3-pg-integration. Kiểm tra HEAD thật; nếu nhánh đã có commit mới, giữ thay đổi đó và ghi BASE SHA thực. Nền tài liệu đợt này là commit chứa prompt này, không phải SHA tích hợp sản phẩm.

Phạm vi: backend/core/**, backend/api/**, backend/storage/**, backend/jobs/**, tests/unit/core/**, tests/integration/core/**, docs/research/AI1_NGHIEP_VU_API.md. Không sửa file chung hoặc module AI khác.

Việc cần làm: Giữ wire CODE-201. Hoàn thiện factory/plugin hoặc export service/auth/repository để AI0 nối Fastify mà không sửa module AI1. Ghi rõ constructor/config, migration 001–004, credential nhân viên/agent và printer scope. Chạy PostgreSQL thật: FIFO theo xác nhận hoàn tất, hai connection claim/duyệt/mark-sending cạnh tranh, stale revision, UNKNOWN không claim lại, generation handover/return, giấy/giao/tiền độc lập. Chỉ seed tài khoản tổng hợp trong DB test qua script test; không có mật khẩu mặc định production.

Điều kiện bàn giao: Typecheck và unit PASS; integration PostgreSQL thật PASS hoặc BLOCKED có lệnh/error cụ thể. Bàn giao exports và fixture read model hiện hành cho AI0/AI4/AI5.

Giữ wire AI1 hiện hành: request_data, kind request/quote, acknowledge_deposit_shortage, lease_token, result/evidence_kind; không đổi hợp đồng chung. Gửi đề xuất cho AI0 nếu thiếu điểm nối. Thiếu thiết bị/registry/DB không chặn phần độc lập; không giả kết quả.

Bàn giao đúng 6 dòng theo QUY_TAC_AI: trạng thái; nhánh/base/commit/PR; file và kết quả; lệnh kiểm thử + PASS/FAIL/SKIP; phần chưa kiểm chứng; việc AI tiếp theo cần làm. Không tự merge/deploy, bật live, in thật hoặc nhắn khách.
