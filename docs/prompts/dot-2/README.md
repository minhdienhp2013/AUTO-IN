# Đợt 2 — sửa lỗi và nối sản phẩm

AI0 phân việc theo kiểm tra từng HEAD ngày 11/10/2026. AI1–AI4 bắt đầu song song; AI5 chuẩn bị adapter ngay, chạy tích hợp khi có bản nối. Không chờ OA/Ricoh để sửa code. Không tự merge PR/deploy/in thật.

Khung: `a681fe91f24f3b0cec61cb72887cc0928d9460ca` trên `ai0/khoi-tao-code-v1`, Draft PR #9. Báo cáo: `docs/architecture/KIEM_TRA_AI1_AI5_2026-10-11.md`.

Tạo nhánh mới từ HEAD bàn giao của mình trong bảng dưới. Giữ lịch sử/code đã có, lấy commit khung AI0 vào nhánh riêng; không tự sửa file chung khi có xung đột. Ghi cả MODULE_BASE_SHA và SCAFFOLD_SHA. Không dùng main đang chỉ có README; không lấy toàn bộ nhánh AI khác vào nhánh sản phẩm của mình.

| AI | Việc / nhánh mới | MODULE_BASE_SHA |
| --- | --- | --- |
| AI1 | CODE-201 / ai1/dot2-core-pg-readmodel | fc0ca144a9ea4fa4092c9e1de5109d690505aacd |
| AI2 | CODE-202 / ai2/dot2-zalo-tests-durable | ccf5e6e1bb97fb1ca8c70a4b2d1c6ad22d59e682 |
| AI3 | CODE-203 / ai3/dot2-processor-agent-bridge | 72647b4e8d489c506f8814ac7565116d0d1a16df |
| AI4 | CODE-204 / ai4/dot2-web-build-readmodel | fde9cdccb6aad888fada378567590f8f325ab635 |
| AI5 | CODE-205 / ai5/dot2-product-acceptance | 2038863949e8366e9e6742472d4992f2cf224601 |

## Quyết định AI0 cho đợt này

Giữ body/response đang dùng từ AI1 tại HEAD fc0ca14 vì AI3/AI4 đã bám: login shop_id + Bearer, request_data, kind request/quote, acknowledge_deposit_shortage, deposit_required_vnd, lease_token, report result/evidence_kind. Không bắt các AI tự đổi sang tên khác của schema scaffold. AI0 sẽ đồng bộ schema/OpenAPI/mapper ở CODE-006 trước khi tích hợp; schema hiện tại chưa là hợp đồng HTTP liên module đã đạt. Đây là chốt hướng tương thích, không tuyên bố đã sửa exports.

API AI1 đã có verify-paper, mark-unknown, reprint, close-exception được giữ và sẽ do AI0 đưa vào OpenAPI. AI1 được nối thêm hai route đã có trong bảng khởi đầu: POST /api/v1/conversations/{conversation_id}/handover và /return-to-ai. Không thêm API khác hoặc đổi body cũ; đề xuất chung gửi AI0.

AI1 giữ record/control generation hội thoại trong backend/core và migration backend/storage; AI2 giữ inbound queue/outbound reservation trong namespace mình, nhận quyền/generation qua Port. Chốt Port qua tài liệu đề xuất, AI0 cập nhật contracts. Không để hai AI cùng sửa một bảng/migration/file. Principal/quyền/scopes đều xác thực ở server; test principal chỉ trong tests.

AI0 tiếp tục CODE-006 trên nhánh riêng: đồng bộ wire; cấp cấu hình root để build/test các module; nối Fastify/PG/auth/processor/AI2/UI; đưa SHA tích hợp cho AI5. Chỉ ghép code đã bàn giao, không tự sửa namespace AI1–AI5. Cùng lúc các AI sửa module độc lập; AI0 không mở live adapter.

## Bàn giao

Đọc prompt riêng của mình cùng AGENTS/quy tắc/đặc tả liên quan. Làm code ngay, test thật, commit sửa lỗi nhỏ sớm, rồi bàn giao 6 dòng. Nêu rõ PASS/FAIL/SKIP/NOT RUN. Thiếu PostgreSQL thật thì phần transaction còn BLOCKED; vẫn hoàn thành phần độc lập và chuẩn bị test, không dùng DB bộ nhớ để báo đạt.
