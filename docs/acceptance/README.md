# CODE-105 — kiểm thử độc lập ban đầu

BASE SHA: `84ab02d643622bc7bfdf07eee662d8797bdd84fd`. Chỉ sử dụng fixture tổng hợp/công khai, không lưu tài liệu khách hoặc token.

## Đã có code

- `tests/fixtures/public/scenarios.json`: 10 tình huống tổng hợp (stale, UNKNOWN, cọc thiếu, quote >150 tờ, giao một phần còn nợ, ngày nghỉ, khóa thủ công).
- `tests/fixtures/public/generate.mjs`: sinh 8 tài liệu **synthetic**: PDF A4 1 trang, PNG 1×1, ZIP hợp lệ, ZIP traversal, ZIP tỷ lệ giải nén cao, ZIP >5 tài liệu, ZIP lỗi, PDF lỗi. Các ZIP xấu là để KIỂM TỪ CHỐI; không giải nén vào máy thật.
- `tests/acceptance/*.test.mjs`: test fixture, port tích hợp, cạnh tranh hai client PostgreSQL độc lập, lỗi bảo mật và browser có điều kiện.
- `tests/acceptance/metrics.mjs`: bộ tính 90% nhận diện/80% hội thoại, mẫu số không bỏ câu khó/không có dự đoán; bộ 20 câu synthetic **không thể** là bằng chứng TN-037.
- `tests/acceptance/release-gate.mjs`: fail-closed nếu thiếu 210 ca, 7 ngày sạch lỗi nghiêm trọng, mô phỏng 100/ngày, minh chứng OA/Ricoh/iPhone/PostgreSQL và phê duyệt chủ.

## Lệnh chạy

```bash
node tests/acceptance/run.mjs
node tests/fixtures/public/generate.mjs --output /tmp/auto-in-fixtures
node tests/acceptance/metrics.mjs /path/to/predictions.json
node tests/acceptance/release-gate.mjs /path/to/evidence.json
```

Chạy `run.mjs` không có backend chỉ là **fixture/harness SELFTEST**, không phải kết quả code sản phẩm. Các test sản phẩm bị `SKIP/NOT RUN`. Muốn chạy tích hợp:

```bash
AUTOIN_ACCEPTANCE_ADAPTER=/absolute/path/to/product-adapter.mjs \
AUTOIN_TEST_DATABASE_URL=postgresql://... \
AUTOIN_API_URL=http://127.0.0.1:3000 \
node tests/acceptance/run.mjs --integration
```

Thiếu adapter => exit code **2 (BLOCKED)**, không dùng mock để vượt qua. Adapter do AI0/AI1–AI3 nối theo wire v0.1, export `createAcceptanceAdapter(options)`; trả `environment:{type:'product-backed',database:'postgresql',print_driver:'DryRunDriver'}` và methods `reset(seed)`, `act(operation,body,{actor})`, `newAgent(name)`, `snapshot()`, `dispose()`. `newAgent` phải có PostgreSQL connection độc lập; không được khai báo product-backed cho mock. Operation thuộc test Port, không tạo wire API mới.

## UI và giới hạn

Có `tests/acceptance/browser.test.mjs`, chỉ chạy khi `AUTOIN_WEB_URL` được cung cấp và Playwright được AI0/AI4 cài. Selector đề xuất: `operation-mode-banner`, `approve-print-action`, `send-real-print-action`. Chromium giả lập viewport mobile **không** phải iPhone thật.

**CHƯA CHẠY:** tích hợp API/PostgreSQL, agent DryRunDriver của sản phẩm, OA thật, Ricoh thật, iPhone thật, tải 100 đơn/ngày và nghiệm thu 210 đơn trong ≥7 ngày. Mọi lệnh in thật phải được duyệt riêng; tuyệt đối không tự bật production. Xem `MA_TRAN_NGHIEM_THU.md` và `MAU_BAO_CAO_LOI.md`.

## Bổ sung sau đối chiếu nhánh AI1/AI3/AI4

- **Wire AI1 kiểm tra thật:** `POST /internal/v1/print-jobs/claim` chỉ nhận `printer_id` + `idempotency_key` và trả `{job:null}` khi hàng đợi rỗng; **không** dùng `order_id` để tạo kết quả từ chối giả. Khi có job, `mark-sending` cần `job_id`, `lease_token`, `expected_revision` và `idempotency_key`. `acknowledge_deposit_shortage` là tên trường đúng.
- Acceptance Port cần chuẩn hóa `act('claim',body)` thành `{ok:true,job:null|{job_id,lease_token,revision}}`; `act('mark_sending',body)` trả `{ok:true,state:'SENDING'}` chỉ khi server cấp thành công; các lỗi theo `{ok:false,status,error:{code}}`. Không được trả `ok:false` vì thiếu trường request rồi tính là kiểm thử quyền đạt.
- **HTTP kiểm tra quyền chạy riêng, không có token/in:** `AUTOIN_API_URL=http://127.0.0.1:3000 AUTOIN_ACCEPTANCE_HTTP_SCOPE=local-simulation node tests/acceptance/run.mjs --http`. Chỉ chấp nhận localhost HTTP, mã 401/403 và lỗi có `error.code`, không chấp nhận 404/422/500 là đạt. Máy chủ AI0 phải chạy riêng trong simulation.
- **Integration:** `AUTOIN_ACCEPTANCE_ADAPTER=/absolute/adapter.mjs AUTOIN_TEST_DATABASE_URL=postgresql://... node tests/acceptance/run.mjs --integration`. Adapter do AI0 tích hợp AI1/AI2/AI3, không phải mock. Chưa có scaffold/backend đang chạy nên các ca này vẫn NOT RUN.
