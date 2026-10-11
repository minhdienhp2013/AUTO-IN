# CODE-101 — Backend nghiệp vụ, wire v0.1

Phạm vi AI1: `backend/core`, `backend/api`, `backend/storage`, `backend/jobs` và hai nhóm test core. AI0 giữ app entry/manifest/lockfile/contracts; không tạo endpoint bootstrap công khai.

## Kết nối / Migration

- PostgreSQL thật (không SQLite). Database thử nghiệm riêng, tên chứa `test` để chống chạy nhầm bài integration. Cấu trúc được tạo bằng `psql -v ON_ERROR_STOP=1 -1 -d "$TEST_DATABASE_URL" -f backend/storage/migrations/001_core.sql`.
- `PgStore(pool)` nhận `pg.Pool` từ AI0; `new AuthService(store)` và `new OrderService(store)`; `registerCoreRoutes(app,{service,auth,resolveVerifiedCustomer,resolvePrintAgent})` do AI0 gọi. `resolveVerifiedCustomer` phải kiểm tra chữ ký/identity kênh hoặc credential khách do backend phát hành, không bao giờ lấy vai trò/customer_id từ JSON. `resolvePrintAgent` phải kiểm chứng credential nội bộ có shop scope từ server, không tin header role trần. Port chưa nối thì fail closed.
- AI0 cài/khóa `pg`/`@types/pg` và Fastify vào root manifest/lockfile; Node phải có crypto scrypt/Intl timezone. Không thêm package từ AI1 ngoài phạm vi.
- Chỉ bootstrap owner bằng `AuthService.bootstrapOwner({shop_id,username,password,bootstrap_enabled:true})` từ script quản trị có config do chủ cấp ngoài Git, lần đầu và không expose HTTP. Sau đó `auth.login()` cấp bearer session ngẫu nhiên, DB chỉ lưu SHA256 token. Mặc định shop `simulation`, in thật bị khóa `printing_enabled=false`.

## Endpoints (nội dung snake_case)

`POST /api/v1/auth/login|logout`, `GET /api/v1/auth/me`; `GET|POST /api/v1/orders`, `GET /api/v1/orders/:order_id`, `POST /api/v1/orders/:order_id/revisions|confirmations|approvals|quote|payments|deliveries|manual|close-exception|reprint`; `POST /internal/v1/print-jobs/claim`, `POST /internal/v1/print-jobs/:job_id/preflight|mark-sending|reports`; `POST /api/v1/print-jobs/:job_id/verify-paper|mark-unknown`.

Required mutation envelope: `idempotency_key` (1–128 chars). Revision-dependent routes: `expected_revision`. Hash = SHA256 canonical JSON of `request_data`. Client never gets to mark a plan trusted; `OrderService.publishVerifiedPlan()` accepts **only** a server-verified processor principal and adds a new immutable revision. API for processor ingestion must be owned by AI0 under credential verification, not a public customer/staff route.

`confirmations`: only verified customer identity, `kind:'request'|'quote'`; quote confirmation tied to quote_revision. `approvals`: staff principal, `acknowledge_deposit_shortage` for missing deposit; >150 **physical sheets** or significant-cost flag requires quote + verified price confirmation. Initial job unique per active revision; reprint job separately owner-authorized and audited.

`claim`: internal authenticated agent with `printer_id`; returns `{job:null}` if no eligible job, or stable IDs and 90s lease secret. `preflight` and `mark-sending` recheck order lock, active revision, approval, print plan, printer, holiday, shop mode and lease. **mark-sending must happen before printer effect**, agent records durable journal. Once SENDING (or UNKNOWN/SENT_UNVERIFIED) cannot be reclaimed by expired lease. `reports` never accepts agent-asserted VERIFIED_DONE; staff explicitly checks paper or trusted device confirmation via `verify-paper`. SIMULATED_DONE is not physical completion. On lost acknowledgment, call staff `mark-unknown` to reconcile; never revert to NOT_SENT.

`payments`: staff manually records received cash/transfer, owner-only refund approval or actual refund; images do not count as receipt. `deliveries`: requires verified physical paper, supports partial and tracks remaining. `close-exception`: any staff only for unprinted/unpaid; otherwise owner only, rejects SENDING and preserves balances + paper not delivered. No automatic accounting cleanup, disposal or silent printed status.

## Kiểm thử / trạng thái

Run after AI0 provides Node root tools and lock:

```sh
tsc -p tsconfig.json --noEmit
node --test tests/unit/core/safety.test.cjs
TEST_DATABASE_URL=postgres://.../autoin_test node --test tests/integration/core/postgres.test.cjs
```

For stand-alone module before root scaffold, compile backend sources to a temporary directory, set `AI1_BUILD_DIR` to its `backend` subfolder, then run node tests. **PostgreSQL integration has to be executed against a real PostgreSQL service; without `pg` and TEST_DATABASE_URL it explicitly SKIPs and is not considered passed.** No Zalo, Ricoh, printing or deployment invoked.

## Blocking dependency for AI0

`[AI0] [CODE-000→CODE-101] [Root pg/Fastify deps, auth customer/agent resolver and trusted processor Port] [AI1 exports typed composition but refuses unverified identity] [Done when app and OpenAPI match wire v0.1 and PostgreSQL integration can run]`.


## 2026-10-11 — hardening pass after PR #3

- **PostgreSQL BIGINT:** Node `pg` trả `BIGINT`/`SUM(BIGINT)` dạng text, không tự cộng trực tiếp với số JS. `dbSafeInteger` chuẩn hóa các counter/quote và fail-closed nếu số vượt `Number.MAX_SAFE_INTEGER`. Đã thêm test giao hai đợt (2 + 3 = 5).
- **Snapshot lúc gửi:** `002_send_mode.sql` bổ sung `core_print_jobs.mode_at_send`. `markSending` ghi chế độ dưới transaction đồng thời với SENDING; `report` chỉ chấp nhận evidence phù hợp chế độ đã chốt lúc gửi, KHÔNG dựa vào mode hiện tại có thể đổi sau đó.
- **Mô phỏng không phải giấy thật:** `verifyPaper` từ chối mọi job `mode_at_send=simulation` hoặc NULL (job cũ chưa biết mode). `device_verified` bị chặn 503 cho tới khi AI3 có adapter tin cậy; nhân viên chỉ được xác nhận `staff_inspected`. Mỗi job chỉ được xác minh tối đa số tờ của plan.
- **Migrations:** nếu database mới chạy `001_core.sql` rồi `002_send_mode.sql` theo thứ tự; database cũ đã có bảng chạy riêng `002_send_mode.sql` (idempotent, không xóa bảng). Không có cơ chế auto-migrate root, AI0 nối migration runner.
- **Đã thực thi:** `tsc -p /tmp/autoin-ai1-tsconfig.json`, và `AI1_BUILD_DIR=/mnt/data/auto_in_ai1_build/backend node --test tests/unit/core/safety.test.cjs tests/integration/core/postgres.test.cjs`. Test PostgreSQL thực vẫn yêu cầu `TEST_DATABASE_URL` + package `pg` (KHÔNG coi skip là PASS). `device_verified` chưa có đường thật.
- **Yêu cầu AI0:** không expose endpoint print production trước khi migration 002 + print-driver Port và kiểm thử PG transaction; đồng bộ schema `mode_at_send` khi khóa contracts v0.1.

## 2026-10-11 — kiểm soát hoàn tiền / đóng ngoại lệ

- **TN-036 đóng ngoại lệ:** nhân viên chỉ được đóng đơn chưa từng có bất kỳ dòng thanh toán nào và chưa từng gửi lệnh in. Không dùng số dư thực nhận bằng 0 làm bằng chứng “chưa thu tiền”: đã nhận cọc rồi hoàn hết vẫn phải do **chủ** đóng.
- **Hoàn tiền:** chỉ chủ duyệt/ghi hoàn; tổng hoàn được duyệt nhưng chưa thực hiện không vượt tiền thực nhận còn lại, và không cho phép ghi hoàn vượt khoản vừa được duyệt hoặc vượt tiền thực còn giữ. Khóa từng order trong transaction để chống hai người hoàn/duyệt cạnh tranh.
- **Bằng chứng giấy:** chỉ job có `mode_at_send=controlled_test|production` mới có thể xác nhận giấy thật; mode `simulation`, `safe` hoặc thiếu dữ liệu đều bị chặn.
- **Kiểm thử PostgreSQL:** bổ sung ca hoàn vượt số nhận, duyệt hai lần, cọc đã hoàn hết vẫn cần chủ đóng ngoại lệ, và nhân viên đóng đơn thật sự chưa in/chưa thu. **Chưa được chạy với PostgreSQL thật tại môi trường hiện tại.**

## CODE-201 — 11/10/2026: PostgreSQL queue/read model/conversation

- Bản nền AI1 `fc0ca144a9ea4fa4092c9e1de5109d690505aacd`, khung AI0 `a681fe91f24f3b0cec61cb72887cc0928d9460ca` được nhập thành merge commit trong nhánh AI1, giữ nguyên namespaces và không sửa root config/contracts.
- Migrations trên **DB test độc lập**: chạy 001, 002, 003, 004 theo thứ tự, trong đó `003_confirmed_queue.sql` backfill `confirmed_at` từ xác nhận yêu cầu/giá đúng revision/hash/quote. Nếu thiếu bằng chứng thì `confirmed_at=NULL` và **không được claim**. Các đơn mới ghi `confirmed_at` ngay khi nhân viên duyệt, từ dấu thời gian hoàn thành đủ xác nhận của khách (lấy lần đầu hợp lệ, tránh webhook lặp đẩy lùi). Claim dùng `ORDER BY confirmed_at,id FOR UPDATE OF o SKIP LOCKED`. Reprint chỉ do chủ duyệt, giữ `confirmed_at` gốc, không cấp quyền nếu thiếu bằng chứng.
- `getOrder` **giữ nguyên** `{order,revisions,jobs,quote,received_vnd,receivable_vnd,refundable_vnd}` và thêm:
  - `current: {revision,request_hash,verified_plan,preview_ref,request_confirmation,price_confirmation,requires_price_confirmation,approval,queue_confirmed_at,request_confirmed,price_confirmed,staff_approved}`; xác nhận/duyệt ràng buộc active revision + request_hash + quote_revision, phê duyệt phải có job chưa hủy; `verified_plan` chỉ từ processor đã xác minh và `preview_ref` chỉ có khi `plan.preview_verified===true` kèm `plan.preview_ref` thực, thiếu thì `null`, không tự sinh.
  - `jobs[]` thêm `mode_at_send,confirmed_at,verified_sheets,planned_sheets,missing_sheets,paper_complete,cancelled_at`. `print_progress: {planned_sheets,verified_sheets,missing_sheets,delivered_sheets,fully_verified,requires_manual_reconciliation}`. Giấy xác minh một phần giữ job `UNKNOWN`, ghi `verified_sheets` và cho giao đúng số kiểm tra, không tự in bù. `conversation_control` là `{status,generation,claimed_by}` hoặc `null`.
- POST `/api/v1/conversations/:conversation_id/handover` và `/return-to-ai`, body `{expected_generation,idempotency_key}`, chỉ staff/owner có Bearer session; `core_conversation_controls` phạm vi shop với `SELECT FOR UPDATE`, đổi generation mỗi khi thực sự chuyển quyền, trả AI là hành động **chủ động**. Hội thoại chưa xác minh/liên kết order => 404 fail-closed.
- **Port AI2 đề xuất** (AI0 cập nhật contracts): `withAiSendGate({shop_id,conversation_id,generation}, async()=>{...})` chỉ dành cho backend AI2 sử dụng. Transaction khóa dòng conversation xuyên suốt callback, bác stale generation/HUMAN/missing row trước outbound effect; AI2 chịu trách nhiệm durable outbound/idempotency và xử lý kết quả OA mơ hồ. Không nhận scope từ body/header khách.
- **Port AI0 cần nối**: `resolveVerifiedCustomer` bắt buộc xác thực OA/credential; `resolvePrintAgent` bắt buộc credential có `shop_id, printer_ids`; `publishVerifiedPlan` chỉ gọi từ processor Port đã kiểm chứng, không mount public route; không dùng test principal ở runtime.
- **Chưa xác minh** PostgreSQL thật vì không có server/driver `pg` trong môi trường thực thi. Integration test đã viết chặn nếu thiếu `TEST_DATABASE_URL` và `pg`; không được đánh dấu PASS khi còn skip. Chạy test trên db tên chứa `test`, sau khi có package theo AI0 root manifest. Không deploy/in thật.

### Lệnh kiểm tra riêng AI1 (khung CODE-000 chưa typecheck namespace AI1)

Sau khi AI0 cài package chính xác bằng `npm ci` tại checkout repo chứa CODE-201:

```sh
mkdir -p /tmp/autoin-code201-build
npx tsc --strict --exactOptionalPropertyTypes --noUncheckedIndexedAccess --skipLibCheck --target ES2023 --module commonjs --moduleResolution node --types node --esModuleInterop --rootDir . --outDir /tmp/autoin-code201-build backend/core/*.ts backend/api/*.ts backend/storage/*.ts
AI1_BUILD_DIR=/tmp/autoin-code201-build/backend node --test tests/unit/core/safety.test.cjs tests/integration/core/postgres.test.cjs
```

Chỉ chạy integration khi đã cấu hình `TEST_DATABASE_URL` trỏ đến PostgreSQL thật và **database tên chứa `test`**; test tự chạy migrations 001→004. Nếu chưa có URL/pg, integration được SKIP và KHÔNG đạt P0. `npm run check` từ root của AI0 hiện **chưa include AI1**, nên check xanh chỉ chứng minh contract scaffold, không phải CODE-201. `getOrder.current.staff_approved`/price_confirmed/fully_verified luôn fail-closed nếu thiếu plan hợp lệ hoặc còn job UNKNOWN/SENT_UNVERIFIED.
