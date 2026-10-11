# AI4 — CODE-304

Đọc AGENTS.md, docs/QUY_TAC_AI.md, docs/PHAN_CONG_AI.md, docs/prompts/dot-3/README.md, báo cáo docs/architecture/KIEM_TRA_AI1_AI5_2026-10-11.md và các phần hợp đồng/đặc tả TN liên quan. Lượt tiếp theo chỉ đọc thay đổi liên quan. Trực tiếp code, kiểm thử, commit sớm; không chỉ đề xuất.

Nền module: 694179c. Nhánh mới: ai4/dot3-web-contract-lock. Kiểm tra HEAD thật; nếu nhánh đã có commit mới, giữ thay đổi đó và ghi BASE SHA thực. Nền tài liệu đợt này là commit chứa prompt này, không phải SHA tích hợp sản phẩm.

Phạm vi: web/**, tests/ui/**, docs/research/AI4_GIAO_DIEN_THONG_BAO.md. Không sửa file chung hoặc module AI khác.

Việc cần làm: Giữ sửa Promise<OrderView>/ConversationState. Tạo web/package-lock.json từ npm thật và chạy npm ci, npm test, npm run typecheck, npm run build. Nếu registry bị chặn, vẫn làm mapper/test, không tự viết lock giả. Mapper bám AI1 ebdd740: current.request_confirmation/price_confirmation/verified_plan/preview_ref/approval, print_progress, conversation_control.generation/status. Xác minh cấu trúc chính xác từ AI1 trước khi mapping; fail closed khi thiếu dữ liệu. Test duyệt đúng bản, >150 tờ xác nhận giá, cọc thiếu cảnh báo, simulated không thành giấy thật, UNKNOWN, giấy giao một phần, handover/return generation. Khi có SHA CODE-006 nối API localhost và chạy browser desktop/mobile viewport; không gọi đó là thử iPhone thật.

Điều kiện bàn giao: 30 test hiện có + ca nested read model PASS; typecheck/build PASS; npm ci PASS hoặc ghi BLOCKED riêng. Giao lock thật và mapper, không thêm tính năng.

Giữ wire AI1 hiện hành: request_data, kind request/quote, acknowledge_deposit_shortage, lease_token, result/evidence_kind; không đổi hợp đồng chung. Gửi đề xuất cho AI0 nếu thiếu điểm nối. Thiếu thiết bị/registry/DB không chặn phần độc lập; không giả kết quả.

Bàn giao đúng 6 dòng theo QUY_TAC_AI: trạng thái; nhánh/base/commit/PR; file và kết quả; lệnh kiểm thử + PASS/FAIL/SKIP; phần chưa kiểm chứng; việc AI tiếp theo cần làm. Không tự merge/deploy, bật live, in thật hoặc nhắn khách.
