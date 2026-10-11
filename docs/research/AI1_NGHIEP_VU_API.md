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

## CODE-301 — factory and PostgreSQL gate

### Import/API for AI0

`import { createCoreModule } from './backend/core/factory.js'` (relative to the AI0 entry) returns `{store,auth,service,registerRoutes}`.

```ts
import { Pool } from 'pg';
import { createCoreModule } from './core/factory.js';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const core = createCoreModule({ pool });
// AI0 owns Fastify app, actual credential verification and migrations.
// In a standalone AI1 route mode ONLY (NOT beside scaffold duplicate routes):
core.registerRoutes(fastifyRoutePort, {
  resolveVerifiedCustomer: verifyProviderOrCustomerCredentialServerSide,
  resolvePrintAgent: verifyScopedAgentCredentialServerSide,
});
```

`fastifyRoutePort` implements AI1 `RouteRegistrar` (`get`, `post`); AI0 must adapt Fastify types and compose a single route system. The CODE-000 app currently mounts the same endpoints with different request/response contracts; **do not call `registerRoutes` inside that app as-is**. AI0 either supplies one core router in place of scaffold registrations or writes verified operation adapters, updates contracts and tests. Never expose bare actor/role/shop/printer headers as authentication. Missing resolvers fail with 503 on startup; invalid verified principals fail with 403. `auth.login(shop_id, username, password)` returns an opaque bearer token; `auth.principal(token)` validates persisted session; owner bootstrap requires a one-time explicit trusted CLI call (`bootstrap_enabled=true`) and is never published as an HTTP route.

`CORE_MIGRATIONS` from `backend/storage/migrations.ts` lists scripts in order (001–004). Runner and connection pooling belong to AI0. The factory deliberately does not run DDL implicitly. Run each SQL file on a dedicated database named `*_test` **before test**, not on production by copy-paste. Test scripts refuse DB names without a `test` token.

### Run with PostgreSQL 18, Node 24, real independent connections

Prerequisites: PostgreSQL service and AI0's locked dependencies (`npm ci`) on a machine with network or preinstalled binaries; a disposable database named `auto_in_test` (never `auto_in` production). Example development setup:

```sh
docker compose up -d postgres
docker compose exec -T postgres psql -U auto_in -d auto_in -c 'CREATE DATABASE auto_in_test'
export TEST_DATABASE_URL='postgresql://auto_in:development_only@127.0.0.1:5432/auto_in_test'
./node_modules/.bin/tsc --strict --exactOptionalPropertyTypes --noUncheckedIndexedAccess --skipLibCheck --target ES2023 --module commonjs --moduleResolution node --esModuleInterop --types node --rootDir . --outDir /tmp/auto-in-code301-build backend/core/*.ts backend/api/*.ts backend/storage/*.ts
AI1_BUILD_DIR=/tmp/auto-in-code301-build/backend node --test tests/unit/core/*.test.cjs tests/integration/core/*.test.cjs
```

The PostgreSQL tests apply migrations 001–004 in order and validate the DB name. `pg-concurrency.test.cjs` **explicitly opens two independent `pg.Pool` instances, obtains two backend PIDs** and tests first customer confirmation vs reversed approval, double approval/claim/mark-sending, stale revision, UNKNOWN not reclaimable, separate money and paper, and generation takeover/return race. Existing `postgres.test.cjs` checks quotes, partial paper, money/refund, mode changes, holidays and owner-only exceptional closure. If `TEST_DATABASE_URL` is absent the PG suite SKIPs: **this is not a successful PostgreSQL test**. If the URL is set but connection/driver is absent the suite FAILS visibly, no memory DB fallback.

### AI4 read model facts

`getOrder(staff, order_id)` preserves `{order,revisions,jobs,quote,received_vnd,receivable_vnd,refundable_vnd}` and provides nested `current`, `print_progress`, `conversation_control`. Read data is server scoped to `shop_id`, revision/hash/quote, trusted processor plan. `preview_ref` is null unless actual verified preview ref exists. `print_progress.fully_verified` is false while print job is unknown or unverified; partial staff inspected paper is deliverable only for the amount physically counted, not self-triggering a reprint. AI4 must never generate a readiness flag from a missing artifact.

### AI2 generation port

`service.withAiSendGate({shop_id, conversation_id, generation}, callback)` checks an existing shop-scoped conversation row under a database row lock. Pass only scope from trusted server context and run the durable, idempotent final outbound reservation/call within the callback; AI2 keeps its own outbound journal/uncertain Zalo provider result. Staff `handover`/`returnToAi` are explicit, expected_generation CAS and never auto-return. Root app must preserve 403/409 errors and never replay unverified OA sends.

### Status

No OA or Ricoh device was contacted. Local environment lacks PostgreSQL server and `pg` package, and DNS access to download binaries is unavailable. Integration remains **BLOCKED, NOT PASS** until tested against actual PostgreSQL. Only a real two-connection run and log can close this gate.

## CODE-301 follow-up — 12/10/2026, PR tích hợp #21

- Đối chiếu HEAD AI1 trước sửa: `76ccbaba62a39c62eec396c3104ba43e11f71151` trên `ai1/dot3-pg-integration`, giữ mọi commit cũ và wire AI0/AI4. Những thay đổi bổ sung giới hạn `backend/api/routes.ts`, `backend/core/service.ts` và `tests/unit/core/readmodel-http.test.cjs`.
- **HTTP strict:** `HttpRequest.body` dùng `unknown` thay vì `any`; mọi POST mutation dùng `Parameters<OrderService['operation']>[N]` để suy ra kiểu, kiểm JSON object trước khi gọi service; đăng nhập kiểm `shop_id/username/password` là string có giá trị. Không bỏ `strict`, `exactOptionalPropertyTypes` hay `noUncheckedIndexedAccess`. Chức năng API và tên trường giữ nguyên.
- **Read model fail closed:** `jobs[].paper_complete` và `print_progress.verified_sheets` chỉ dựa trên bằng chứng giấy thật khi `mode_at_send` là `controlled_test` hoặc `production`; NULL, unknown và simulation KHÔNG được làm UI báo đủ giấy. `current.verified_plan`, `current.preview_ref`, `current.staff_approved`, `print_progress` và `conversation_control` giữ shape cũ.
- **Regressions:** 3 bài unit mới kiểm missing/invalid body, preview chưa xác minh, giấy `VERIFIED_DONE` nhưng `mode_at_send=NULL` không được công nhận, và controlled-test có chứng cứ hợp lệ. Cú pháp CJS test đã parse PASS; **3 ca mới chưa chạy bằng Node trên compiled AI1 của SHA này** khi kiểm trên môi trường không có dependency/download Git. Gọi qua lệnh `npm run test:core` của nhánh tích hợp AI0 sau cherry-pick.
- **Bằng chứng thật ở integration trước khi sửa:** <https://github.com/minhdienhp2013/AUTO-IN/pull/21> SHA `15c1ac75859914b2cc07d5a98bf57c18973cbbb2`, GitHub Actions Simulation integration / PostgreSQL 18.3 PASS: core 13/13, AI5 PG/DryRun product 20/20; kết quả **chỉ thuộc commit tích hợp trước thay đổi trên AI1**, KHÔNG tự tính là PASS cho HEAD mới. Root CODE checks trên nhánh AI1 PASS nhưng manifest trước tích hợp không compile/test namespace AI1.
- **Sáu diagnostic TypeScript stricter thuộc AI2** theo `docs/architecture/CODE006_BAN_GIAO.md` và mô tả PR #21: `batch.ts:44`, `processor.ts:28`, `schedule.ts:27`, `postgres-durable.ts:35,141` (6 diagnostics tại 5 vị trí). Không được phép sửa namespace AI2 trong CODE-301. Yêu cầu: `[AI2] [CODE-302] [Sửa 6 diagnostic exactOptionalPropertyTypes/noUncheckedIndexedAccess trong backend/conversation và backend/integrations, đối chiếu report CODE006] [AI1 không sở hữu các file đó] [typecheck riêng AI2 với hai cờ đều PASS]`.
- **Cần chạy lại trên HEAD AI1 sau khi tích hợp:** `npm ci && npm run typecheck && npm run test:core`, `TEST_DATABASE_URL=postgresql://.../autoin_test_305 npm run test:core` với PostgreSQL test thật, hoặc cùng lệnh CI `Simulation integration` trên SHA tích hợp mới. Không tự merge/deploy hoặc bật in thật.

## CODE-301 — Port đề xuất nháp/chuyển nhân viên AI2 (12/10/2026)

- Entry **internal only**: \`createAiOrderPort({store:new PgStore(pool),trusted:{shop_id,oa_id}})\` từ \`backend/core/ai-order-port.ts\`. Hai giá trị trusted phải được AI0 lấy từ mapping OA/shop cấu hình server đã xác thực; **không** lấy shop, role, customer hoặc OA từ HTTP body do người gửi khai. Không tạo route HTTP mới.
- \`suggest_draft({conversation_id,customer_id,event_ids,text,idempotency_key,expected_generation})\` trả \`{status:'created'|'existing'|'stale_generation',order_id?}\`. Port kiểm bằng cùng transaction: shop tồn tại; tất cả \`event_ids\` đã ở \`zalo_inbound_events\` đúng trusted \`oa_id\`, cùng conversation và customer; không có đơn của khách khác gắn conversation; khóa \`core_conversation_controls\` shop/conversation \`FOR UPDATE\`; generation và status=AI. Chỉ khi hợp lệ mới INSERT order DRAFT và revision 1 \`request_data={source:'zalo_ai_suggestion',conversation_id,event_ids,text}\`, \`plan=NULL\`; không quote, confirmation, approval hay print job. \`core_ai_draft_proposals\` có PRIMARY KEY fingerprint của event_ids và UNIQUE idempotency key theo shop/OA, nên retry hai PostgreSQL pools vẫn chỉ một order, kể cả thay idempotency key nhưng không đổi payload/sự kiện. Cùng sự kiện/khóa nhưng text/khách khác thì 409; lỗi scope thì 403, stale generation trả enum.
- \`route_human({conversation_id,reason,event_ids,expected_generation})\` trả \`{status:'routed'|'already_routed'|'stale_generation',generation?}\`. Sau xác minh Zalo event và \`FOR UPDATE\`, chuyển status \`HUMAN\`, tăng generation và \`claimed_by=NULL\`, giữ \`ai_route_fingerprint/ai_route_reason\`; khách này vào **hàng đợi chờ nhân viên thật**, không giả staff ID. Cùng batch retry trả \`already_routed\`, generation quá cũ/đã trả AI trả \`stale_generation\`. \`OrderService.handover\` cho phép nhân viên thật nhận HUMAN chưa có người nhận, và giữ chống hai nhân viên cùng nhận; trả lại AI vẫn bắt buộc nhân viên/chủ làm chủ động.
- Migration AI1 mới: \`backend/storage/migrations/005_ai_order_port.sql\`, bổ sung vào \`CORE_MIGRATIONS\` sau 001–004. Schema 005 thay table CHECK cũ yêu cầu claimed_by không null khi HUMAN, để biểu diễn routed-but-unclaimed. Runner AI0 \`scripts/database.ts\` đã duyệt danh sách \`CORE_MIGRATIONS\`, nên không cần sửa file root. Cần AI2 001/002 migration \`zalo_inbound_events\` trước khi sử dụng Port (không đụng dữ liệu/tables AI2). Script production migration phải do AI0 chốt.
- **Boundary**: không gọi \`OrderService.createDraft(staff)\`, không mạo danh staff/customer/processor, không cấp quyền duyệt/gửi in/Zalo. Audit \`ai.draft_suggested\` do service actor định danh OA và chỉ ghi fingerprint + số sự kiện, không chép text khách vào audit. \`route_human\` dùng transaction row lock ngay khi AI đang soạn/trước gửi; AI2 vẫn phải kiểm outbound generation bằng \`CoreConversationGate\`.
- AI2 cần gọi Port trong backend sau bước verify/persist Zalo; xử lý \`stale_generation\` như HOLD/không hành động, \`existing\` không tạo lại order, \`already_routed\` không trả AI lại. AI0 cung cấp connection Pool và trusted OA/shop; không tự gắn public endpoint. AI4 dùng \`conversation_control.status='HUMAN',claimed_by=null\` làm “chờ nhân viên nhận”; không tự coi có nhân viên đang tiếp quản.
- Kiểm thử: \`node --test tests/unit/core/ai-order-port.test.cjs\`, \`TEST_DATABASE_URL=postgresql://.../autoin_test_305 npm run test:core\`. PG test dùng **hai pg.Pool độc lập**, xác minh concurrent retry chỉ một draft và còn 0 confirmation/quote/approval/print job; mismatched OA/customer/shop fail closed; đồng thời route HUMAN, stale generation, staff claim và return AI. CI validation riêng trên bản tích hợp: PR #28, không thay PR #23 đã làm chứng cứ đợt trước. Không merge/deploy/in hay gửi tin thật.
