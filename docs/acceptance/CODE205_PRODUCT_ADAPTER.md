# CODE-205 — AI5 product-backed nghiệm thu đợt 2

MODULE_BASE_SHA: 2038863949e8366e9e6742472d4992f2cf224601
SCAFFOLD_SHA: a681fe91f24f3b0cec61cb72887cc0928d9460ca
Kiểm tra consumer mới: AI1 CODE-201 869adc6b2721a4773da9714f9707e466098c197e.

## Phạm vi và bằng chứng

- Adapter tests/acceptance/product-adapter.mjs tải AI1 OrderService + PgStore + AuthService từ bản BUILD TÍCH HỢP, sử dụng package pg thật và hai Pool kết nối PostgreSQL thật. Không giả mô hình bằng memory.
- Mỗi ca tạo shop + order synthetic riêng trong DB test; không xóa hoặc truncate bảng. Chặn DB khác tên autoin_test..., chặn PostgreSQL remote, chặn DATABASE_URL trùng, yêu cầu xác nhận AUTOIN_ALLOW_PG_ACCEPTANCE=YES_ISOLATED_TEST_DB.
- Migration AI1 phải đủ 001_core.sql, 002_send_mode.sql, 003_confirmed_queue.sql, 004_conversation_generation.sql. Principal test có printer_ids RMP7000; điều này chỉ kiểm service AI1, không thay xác thực credential HTTP.
- Bridge tests/acceptance/dryrun-bridge.py sử dụng AI3 Journal + DryRunDriver thật. Lưu journal trạng thái BOUNDARY trước mark-sending backend, driver chỉ được gọi khi server cho phép. Bằng chứng trả là simulated, KHÔNG chứng minh đã in giấy.
- Tests PG-01 đến PG-17 (16 ca PostgreSQL và 1 ca DryRun): chưa duyệt, stale, claim kép 2 connection, mark-sending cạnh sửa, UNKNOWN, ngày nghỉ/thủ công, báo giá >150, cọc thiếu, nợ + ngoại lệ đúng chủ, idempotency, chặn giao giấy khi mô phỏng, FIFO xác nhận trước/duyệt sau, printer scope và hoàn tiền.
- DRYRUN-12: journal/backend/driver trên cùng đơn thử. CODE-105 legacy Port test vẫn SKIP có nhãn, không được tính làm product PASS.
- HTTP readiness chặn 401 giả: bắt buộc GET /health xác nhận auth_configured=true và các operations thực đã kết nối, sau đó HTTP anonymous yêu cầu 401/403 + error.code.
- Browser chạy khi có web local + playwright và flag --browser; Chromium viewport không được gọi là iPhone thật.

## Lệnh chạy từ checkout tích hợp có code AI0/AI1/AI3/AI4

npm ci && npm run build
node tests/acceptance/run.mjs

AUTOIN_TEST_DATABASE_URL=postgresql://localhost/autoin_test_205 AUTOIN_ALLOW_PG_ACCEPTANCE=YES_ISOLATED_TEST_DB node tests/acceptance/run.mjs --integration

AUTOIN_API_URL=http://127.0.0.1:3000 AUTOIN_ACCEPTANCE_HTTP_SCOPE=local-simulation node tests/acceptance/run.mjs --http

AUTOIN_WEB_URL=http://127.0.0.1:5173 AUTOIN_ACCEPTANCE_HTTP_SCOPE=local-simulation AUTOIN_EXPECT_DEMO=1 node tests/acceptance/run.mjs --browser

Nếu build output khác dist/backend: đặt AI1_BUILD_DIR trỏ tới thư mục backend đã build. Không đặt AUTOIN_ACCEPTANCE_ADAPTER để ép adapter khác. Không tự ghép code sản phẩm vào nhánh AI5; AI0 cấp SHA tích hợp và chạy root.

## Kết quả có căn cứ ở thời điểm viết

- Bản selftest adapter độc lập đã chạy: PASS 4; FAIL 0. Tại thời điểm này 17 ca product PG/DryRun của bản PR mới vẫn NOT RUN vì chưa có PostgreSQL test/checkout tích hợp; lượt thử ban đầu khi suite còn 12 ca ghi 12 SKIP, không phải bằng chứng product PASS. Test guard từ chối endpoint in/DB thật. Chưa có GitHub CI xác nhận checkout hiện tại.
- PostgreSQL thật: NOT RUN. HTTP simulation với auth/route nối thật: NOT RUN. AI3 bridge với đầy đủ nguồn Python: NOT RUN. Browser của AI4 bản tích hợp: NOT RUN.
- Không có bản CODE-006 tích hợp của AI0 tại lúc kiểm tra; chỉ có nhánh scaffold CODE-000 và nhánh chuyên môn. Không gửi lệnh in thật, không merge/deploy.
- TN-015/021/037: >=90% nhận diện, >=80% hội thoại, 100 đơn/ngày mô phỏng, 210 đơn >=7 ngày sạch lỗi P0 và thiết bị OA/Ricoh/iPhone thật đều CHƯA NGHIỆM THU.

## Chuyển lỗi đúng đầu mối

AI0 / CODE-006: cấp SHA root tích hợp, khóa wire/schema, migration runner, CI và server localhost simulation. AI1 / CODE-201: nếu fail PG/transaction/queue/ledger, gửi seed, SQLSTATE/error.code, expected/actual và SHA. AI3 / CODE-203: nếu fail journal/DryRun, gửi job_id synthetic, trạng thái và stderr sạch bí mật. AI4 / CODE-204: nếu FAIL browser, gửi viewport, selector, screenshot sạch dữ liệu. AI2 / CODE-202: webhook, hội thoại, outbound chưa chạy phải test sau khi port nối. Bất kỳ P0 FAIL: giữ SAFE, không mở đường in.
