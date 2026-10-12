# AI5 — CODE-305

Đọc AGENTS.md, docs/QUY_TAC_AI.md, docs/PHAN_CONG_AI.md, docs/prompts/dot-3/README.md, báo cáo docs/architecture/KIEM_TRA_AI1_AI5_2026-10-11.md và các phần hợp đồng/đặc tả TN liên quan. Lượt tiếp theo chỉ đọc thay đổi liên quan. Trực tiếp code, kiểm thử, commit sớm; không chỉ đề xuất.

Nền module: 5707b81128e7e84180db57865896d52d256dac33. Nhánh mới: ai5/dot3-integrated-acceptance. Kiểm tra HEAD thật; nếu nhánh đã có commit mới, giữ thay đổi đó và ghi BASE SHA thực. Nền tài liệu đợt này là commit chứa prompt này, không phải SHA tích hợp sản phẩm.

Phạm vi: tests/acceptance/**, tests/fixtures/public/**, docs/acceptance/**. Không sửa file chung hoặc module AI khác.

Việc cần làm: Đồng bộ product adapter theo AI1 ebdd740 và bridge AI3 31e73ea; giữ PostgreSQL thật hai Pool, isolated DB guard và DryRunDriver thật. Chuẩn bị lệnh/fixture cho CODE-006, không tự ghép code sản phẩm vào nhánh AI5. Khi AI0 cấp SHA tích hợp: chạy 17 ca CODE-205 PG/DryRun, HTTP auth/quyền/operations thật và browser với AI4 mới; kiểm webhook/generation khi pipeline được nối. Ghi PASS/FAIL/SKIP theo từng ca và SHA, gửi lỗi đúng chủ file với expected/actual/lệnh tái hiện. Chưa có PG/server thì chuẩn bị test và ghi BLOCKED, không gọi 23 selftests là nghiệm thu.

Điều kiện bàn giao: Selftests PASS; các ca sản phẩm chạy thật trên bản tích hợp hoặc BLOCKED cụ thể. Cập nhật ma trận TN và release gate; không sửa code sản phẩm.

Giữ wire AI1 hiện hành: request_data, kind request/quote, acknowledge_deposit_shortage, lease_token, result/evidence_kind; không đổi hợp đồng chung. Gửi đề xuất cho AI0 nếu thiếu điểm nối. Thiếu thiết bị/registry/DB không chặn phần độc lập; không giả kết quả.

Bàn giao đúng 6 dòng theo QUY_TAC_AI: trạng thái; nhánh/base/commit/PR; file và kết quả; lệnh kiểm thử + PASS/FAIL/SKIP; phần chưa kiểm chứng; việc AI tiếp theo cần làm. Không tự merge/deploy, bật live, in thật hoặc nhắn khách.
