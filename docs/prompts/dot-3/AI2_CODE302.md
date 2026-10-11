# AI2 — CODE-302

Đọc AGENTS.md, docs/QUY_TAC_AI.md, docs/PHAN_CONG_AI.md, docs/prompts/dot-3/README.md, báo cáo docs/architecture/KIEM_TRA_AI1_AI5_2026-10-11.md và các phần hợp đồng/đặc tả TN liên quan. Lượt tiếp theo chỉ đọc thay đổi liên quan. Trực tiếp code, kiểm thử, commit sớm; không chỉ đề xuất.

Nền module: 9b431352de19a7f9ad5f7814e200ecbc6ca5bf0e. Nhánh mới: ai2/dot3-zalo-core-gate. Kiểm tra HEAD thật; nếu nhánh đã có commit mới, giữ thay đổi đó và ghi BASE SHA thực. Nền tài liệu đợt này là commit chứa prompt này, không phải SHA tích hợp sản phẩm.

Phạm vi: backend/integrations/zalo/**, backend/conversation/**, backend/ai/**, tests/unit/zalo/**, docs/research/AI2_ZALO_OA.md. Không sửa file chung hoặc module AI khác.

Việc cần làm: Xuất factory pipeline/worker nhận transaction runner và trusted shop_id từ AI0; giữ migration Zalo riêng. Kiểm tra CoreConversationGate theo AI1 ebdd740 và migration 004, cùng transaction khóa generation/reservation. Mở rộng test PostgreSQL thật cho webhook trùng, hai worker, restart/recovery, takeover khi đang soạn và ngay trước gửi, UNKNOWN outbound không gửi lại. Giữ xác minh raw-body signature; thiếu cấu hình provider từ chối webhook/live outbound. Dùng mock transport có nhãn, không nhắn khách.

Điều kiện bàn giao: 25 unit hiện có không giảm; typecheck PASS; PG integration PASS hoặc BLOCKED. Giao ví dụ wiring và cấu hình tối thiểu không chứa secrets.

Giữ wire AI1 hiện hành: request_data, kind request/quote, acknowledge_deposit_shortage, lease_token, result/evidence_kind; không đổi hợp đồng chung. Gửi đề xuất cho AI0 nếu thiếu điểm nối. Thiếu thiết bị/registry/DB không chặn phần độc lập; không giả kết quả.

Bàn giao đúng 6 dòng theo QUY_TAC_AI: trạng thái; nhánh/base/commit/PR; file và kết quả; lệnh kiểm thử + PASS/FAIL/SKIP; phần chưa kiểm chứng; việc AI tiếp theo cần làm. Không tự merge/deploy, bật live, in thật hoặc nhắn khách.
