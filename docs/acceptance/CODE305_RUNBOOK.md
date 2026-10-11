# CODE-305 — chạy bộ test nghiệm thu sau khi AI0 cấp SHA tích hợp

Ngày lập: 2026-10-11. Module BASE `5707b81128e7e84180db57865896d52d256dac33`. Tài liệu đợt 3: `7066849be67dabd992cda08209584e7c861b47ca`. Mã AI1 kiểm: `ebdd740d87b3bb72fd7f1229b2ab2e728f55f0bc`. Bridge AI3 kiểm: `31e73ea2607f25d521561a6c3fe9fda733900db5`.

**BLOCKED:** AI0 chưa cấp SHA `ai0/tich-hop-simulation-v1`/CODE-006 nên không có checkout chính thức kết hợp AI1–AI4. Không sử dụng sức khỏe scaffold, HTTP 401 khi auth chưa nối, mock/fixture hoặc nhãn product-backed tự khai để kết luận nghiệm thu.

## Chuẩn bị

1. AI0 cấp SHA tích hợp dài 40 ký tự, build output AI1, migration `001_core.sql`–`004_conversation_generation.sql`, server Fastify localhost simulation, Python AI3 agent, web AI4. Không đưa mã sản phẩm vào nhánh AI5.
2. Tạo **PostgreSQL thật** trên localhost, DB riêng tên `autoin_test...` (không dùng dữ liệu cửa hàng); đã khóa root dependencies và các biến cấu hình server simulation.
3. Chạy kiểm tra độc lập không cần DB:

```sh
node tests/acceptance/run.mjs
```

Các ca `PG-01`–`PG-20` (trừ PG-12/18 là DryRun) thuộc nhóm **NOT RUN** khi không có `--integration`. Test legacy CODE-105 vẫn SKIP riêng.

## Chạy tích hợp trên checkout do AI0 cung cấp

```sh
# Giá trị thật do AI0 bàn giao; đừng dùng SHA của prompt/scaffold/AI5.
export AUTOIN_INTEGRATION_SHA=<40-character-CODE006-SHA>
export AUTOIN_OPERATION_MODE=simulation

# Node dependencies và AI1 modules phải được build thành công trước.
npm ci
npm run build

# 18 PG transaction/gate và 2 DryRun-journal scenarios, dùng AI1 service + pg thật.
AUTOIN_TEST_DATABASE_URL=postgresql://localhost/autoin_test_305 \
AUTOIN_ALLOW_PG_ACCEPTANCE=YES_ISOLATED_TEST_DB \
node tests/acceptance/run.mjs --integration

# Chỉ xác minh HTTP local server đã gắn auth/operations.
AUTOIN_API_URL=http://127.0.0.1:3000 AUTOIN_ACCEPTANCE_HTTP_SCOPE=local-simulation \
node tests/acceptance/run.mjs --http

# Chỉ khi AI2 webhook ingress đã được cấu hình an toàn tại server simulation.
AUTOIN_API_URL=http://127.0.0.1:3000 AUTOIN_ACCEPTANCE_HTTP_SCOPE=local-simulation \
AUTOIN_TEST_WEBHOOK_REJECTION=1 node tests/acceptance/run.mjs --http

# Browser demo local; cần Playwright được AI0/AI4 cài và web build đạt.
AUTOIN_WEB_URL=http://127.0.0.1:5173 AUTOIN_ACCEPTANCE_HTTP_SCOPE=local-simulation \
AUTOIN_EXPECT_DEMO=1 node tests/acceptance/run.mjs --browser
```

Nếu build AI1 không nằm tại `dist/backend`, đặt `AI1_BUILD_DIR` trỏ đến thư mục **backend đã biên dịch từ đúng SHA tích hợp**. Chỉ kết nối `autoin_test...` trên localhost; URL PG chứa query/fragment bị từ chối để tránh override host. Không mở đường in thật hoặc Zalo OA thật. Code Python chỉ import `Journal`/`DryRunDriver`, không dùng driver Windows.

## Phân biệt bằng chứng

- **PASS/FAIL/SKIP selftest:** chỉ bảo vệ fixture, tỷ lệ, chứng cứ và runner. Không báo là kết quả API/PostgreSQL thật.
- **PASS/FAIL/SKIP product:** ghi từng test PG, DryRun, HTTP, browser; chỉ xét nghiệm thu khi 0 SKIP trong nhóm yêu cầu.
- **SHA:** ghi đầy đủ module SHA, `AUTOIN_INTEGRATION_SHA`, `pg_backend_pid` hai connection, health.mode simulation, `DryRunDriver` và ảnh UI Chromium (không tương đương iPhone thật).
- **TN-037:** chưa kiểm OA, Ricoh, iPhone thật, tải 100/ngày, 210 đơn/7 ngày. `release-gate.mjs` luôn fail-closed khi thiếu các bằng chứng đó.

Lỗi PostgreSQL/transaction/ledger/confirmation queue/generation -> **AI1**; Zalo verification/queued outbound -> **AI2**; journal/artifact/DryRun -> **AI3**; browser/mapper -> **AI4**; Fastify composition/schema/dependency/migrations -> **AI0**. Kèm test ID, integration SHA, lệnh chạy, expected/actual, bằng chứng không chứa token/thông tin khách.

## Trạng thái ở thời điểm bàn giao

Selftest chốt SHA riêng (`integration-preflight.test.mjs`) đã chạy cục bộ: 4 PASS / 0 FAIL. Toàn bộ product PG/HTTP/DryRun/browser CODE-305: **NOT RUN/BLOCKED vì thiếu SHA tích hợp và PostgreSQL/server thực**. Không báo số PASS sản phẩm hoặc in thử.
