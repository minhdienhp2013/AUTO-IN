# AI5 CODE-105 — bộ đầu tiên

BASE: `84ab02d643622bc7bfdf07eee662d8797bdd84fd`.

Chạy `node tests/acceptance/run.mjs` (chỉ SELFTEST fixture). Chạy tích hợp: `AUTOIN_ACCEPTANCE_ADAPTER=/absolute/path/product-adapter.mjs AUTOIN_TEST_DATABASE_URL=postgresql://... node tests/acceptance/run.mjs --integration`; thiếu adapter trả exit 2 BLOCKED.

Adapter phải export `createAcceptanceAdapter(options)` và trả `environment:{type:'product-backed',database:'postgresql',print_driver:'DryRunDriver'}`; hỗ trợ `reset(seed)`, `act(operation,body,{actor})`, `newAgent(name)` (client PostgreSQL tách biệt), `snapshot()`, `dispose()`. AI0 quyết định API/OpenAPI chính thức; các operation ở đây chỉ là Port kiểm thử. Không tự cho mô phỏng đủ tiêu chuẩn nghiệm thu.

**Phần chưa chạy:** PostgreSQL 2 client, UI trình duyệt, OA thật, Ricoh thật, iPhone thật, 100 đơn/ngày, 210 đơn ≥7 ngày và ngưỡng 90%/80%. Đường máy in thật luôn tắt cho tới khi có duyệt và bằng chứng.
