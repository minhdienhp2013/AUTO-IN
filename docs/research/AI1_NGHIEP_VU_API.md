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
