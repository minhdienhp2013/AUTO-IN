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
- \`route_human({conversation_id,reason,event_ids,expected_generation})\` trả \`{status:'routed'|'already_routed'|'stale_generation',generation?}\`. Sau xác minh Zalo event và \`FOR UPDATE\`, chuyển status \`HUMAN\`, tăng generation và \`claimed_by=NULL\`, giữ \`ai_route_fingerprint/ai_route_reason\`; khách này vào **hàng đợi chờ nhân viên thật**, không giả staff ID. Retry với generation cũ trả \`stale_generation\` kể cả cùng batch. \`already_routed\` chỉ có thể trả khi request mang đúng generation hiện hành và hội thoại đã HUMAN. \`OrderService.handover\` cho phép nhân viên thật nhận HUMAN chưa có người nhận, và giữ chống hai nhân viên cùng nhận; trả lại AI vẫn bắt buộc nhân viên/chủ làm chủ động.
- Migration AI1 mới: \`backend/storage/migrations/005_ai_order_port.sql\`, bổ sung vào \`CORE_MIGRATIONS\` sau 001–004. Schema 005 thay table CHECK cũ yêu cầu claimed_by không null khi HUMAN, để biểu diễn routed-but-unclaimed. Runner AI0 \`scripts/database.ts\` đã duyệt danh sách \`CORE_MIGRATIONS\`, nên không cần sửa file root. Cần AI2 001/002 migration \`zalo_inbound_events\` trước khi sử dụng Port (không đụng dữ liệu/tables AI2). Script production migration phải do AI0 chốt.
- **Boundary**: không gọi \`OrderService.createDraft(staff)\`, không mạo danh staff/customer/processor, không cấp quyền duyệt/gửi in/Zalo. Audit \`ai.draft_suggested\` do service actor định danh OA và chỉ ghi fingerprint + số sự kiện, không chép text khách vào audit. \`route_human\` dùng transaction row lock ngay khi AI đang soạn/trước gửi; AI2 vẫn phải kiểm outbound generation bằng \`CoreConversationGate\`.
- AI2 cần gọi Port trong backend sau bước verify/persist Zalo; xử lý \`stale_generation\` như HOLD/không hành động, \`existing\` không tạo lại order, \`already_routed\` không trả AI lại. AI0 cung cấp connection Pool và trusted OA/shop; không tự gắn public endpoint. AI4 dùng \`conversation_control.status='HUMAN',claimed_by=null\` làm “chờ nhân viên nhận”; không tự coi có nhân viên đang tiếp quản.
- Kiểm thử: \`node --test tests/unit/core/ai-order-port.test.cjs\`, \`TEST_DATABASE_URL=postgresql://.../autoin_test_305 npm run test:core\`. PG test dùng **hai pg.Pool độc lập**, xác minh concurrent retry chỉ một draft và còn 0 confirmation/quote/approval/print job; mismatched OA/customer/shop fail closed; đồng thời route HUMAN, stale generation, staff claim và return AI. CI validation riêng trên bản tích hợp: PR #28, không thay PR #23 đã làm chứng cứ đợt trước. Không merge/deploy/in hay gửi tin thật.

## AI2 → AI1: Hợp đồng Port nội bộ (12/10/2026)

Khởi tạo phía AI0 từ server-verified OA/shop mapping, tuyệt đối không nhận shop/OA từ body webhook:

```ts
import { createAiOrderPort } from './backend/core/ai-order-port.js';
const port = createAiOrderPort({store: core.store, trusted: {shop_id: verifiedShopId, oa_id: verifiedOaId}});
```

**1. suggest_draft**

```ts
suggest_draft({conversation_id, customer_id, event_ids, text, idempotency_key, expected_generation})
// {status:'created',order_id} | {status:'existing',order_id} | {status:'stale_generation'}
```

**2. route_human**

```ts
route_human({conversation_id, reason, event_ids, expected_generation})
// {status:'routed',generation} | {status:'already_routed',generation} | {status:'stale_generation'}
```

**Ràng buộc kiểu:** `conversation_id` 1–256 ký tự, `event_ids` từ 1 đến 100 ID duy nhất (mỗi ID 1–256 ký tự), `customer_id` 1–256, `text` 1–4000, `idempotency_key` 1–128, `reason` 1–500, `expected_generation` số nguyên an toàn không âm. Phần input giữ nguyên tên/snake_case; `route_human` không có trường idempotency_key trong contract.

**Bất biến transaction:** Port kiểm tra shop tồn tại, tất cả events đã nằm trong `zalo_inbound_events` của đúng server `oa_id`, cùng hội thoại/khách, sau đó `SELECT ... FOR UPDATE` dòng `(shop_id,conversation_id)` trước mọi quyết định. Kiểm `expected_generation` và unique idempotency của `core_ai_draft_proposals` **trong cùng transaction** với INSERT order/revision. Concurrency từ hai pg.Pool phải bị tuần tự hóa. Chỉ cho phép tạo control row mới ở generation 0; request khác generation trên hội thoại chưa có control phải trả stale mà không tạo dòng.

**Kết quả:**
- `suggest_draft`: đúng generation + AI => `created`; cùng tập `event_ids` (không phụ thuộc thứ tự), cùng text/khách/generation => `existing` bất kể retry key; cùng event/key nhưng payload khác => `AI_DRAFT_IDEMPOTENCY_CONFLICT` 409. Không tạo quote/confirmation/approval/print job.
- `route_human`: đúng generation + AI => `routed`, tăng generation 1, trạng thái HUMAN và `claimed_by=NULL`; đúng generation hiện hành + HUMAN => `already_routed` không thay đổi DB.
- **Generation không đúng luôn trả `stale_generation`**, kể cả retry cùng batch vừa chuyển HUMAN. Không tạo đơn, không chuyển trạng thái, không tạo control row khi unlinked. AI2 HOLD mọi tác động và không gửi outbound khi stale.
- Port không giả làm staff; nhân viên đăng nhập thật tiếp nhận HUMAN chưa gán qua `OrderService.handover` và chỉ nhân viên/chủ trả AI chủ động. Fingerprint của `event_ids` được lưu nhưng không được dùng để bỏ qua kiểm generation.

**Lỗi:** `UNVERIFIED_AI_EVENTS`, `AI_SHOP_NOT_FOUND`, `AI_CUSTOMER_MISMATCH`, `AI_EVENT_BINDING_MISMATCH`: 403; `AI_DRAFT_IDEMPOTENCY_CONFLICT` hoặc `AI_CONVERSATION_CUSTOMER_CONFLICT`: 409; input không hợp lệ: 422; thiếu cấu hình server: 503.

**Migrations:** core `001` → `005`, tiếp theo AI2 `001_zalo_durable.sql` và `002_zalo_oa_scope.sql` trước khi dùng Port; AI0 sở hữu runner/runtime. Port là module nội bộ, không đăng ký HTTP mới, giữ nguyên read model AI0/AI4.

**Bằng chứng:** Unit `tests/unit/core/ai-order-port.test.cjs` và PostgreSQL thật hai kết nối `tests/integration/core/ai-order-port-pg.test.cjs`. Ca thực thi gồm retry đồng thời, idempotency conflict, stale trước khi control tồn tại, stale sau HUMAN, cạnh tranh `suggest_draft` vs `route_human`. Xem PR #28 cho CI trên base tích hợp; PR #23 giữ nguyên lịch sử kiểm thử trước đó. Không merge/deploy/gửi OA hay in thật.

## CODE-401 — Port xác nhận khách bằng sự kiện OA có chứng cứ (2026-10-12)

**Chỉ dành cho backend AI0** (không thêm HTTP route; không tạo `Principal customer` hoặc staff giả):

```ts
import { createVerifiedConfirmationPort } from './backend/core/verified-confirmation-port.js';
const port = createVerifiedConfirmationPort({store:core.store, trusted:{shop_id: verifiedShopId,oa_id:verifiedOaId}});
const target = {order_id,expected_revision,request_hash,kind:'request',expected_generation};
const challenge = await port.issue_challenge(target);
// {status:'issued',challenge_id,challenge_token,expires_at} | {status:'stale'}
const committed = await port.confirm_verified_event({...target,event_id:verifiedEventId});
// {status:'confirmed'|'existing', confirmation_id,order_id,revision,kind,quote_revision} | {status:'stale'}
```

**Hợp đồng bằng chứng bắt buộc:** AI0 xác minh chữ ký webhook Zalo OA, mapping OA→shop/customer/conversation và **loại postback nút nhấn đồng ý rõ ràng** rồi mới lưu chuẩn hóa vào `zalo_inbound_events` của AI2, với `payload_json.confirmation_postback={kind:'verified_confirmation_accept',challenge_id,challenge_token}`. Đây là dữ liệu **do adapter đáng tin cậy tạo từ postback có chữ ký**, tuyệt đối KHÔNG suy đoán từ text `OK`, `đồng ý`, event ID/metadata người dùng tự điền hay kết quả LLM. AI2 chỉ tạo candidate khi thiếu chứng cứ và HOLD/NEEDS_HUMAN; không tự gọi `OrderService.confirm` bằng Principal dựng giả. AI0 phải chốt và triển khai adapter kí/challenge delivery trước khi gọi Port với OA thật. `challenge_token` là giá trị 256-bit ngẫu nhiên, chỉ sử dụng trong một postback hợp lệ; không ghi secrets vào Git/log, không nhận từ text khách; challenge hiệu lực 10 phút.

**Binding và transaction:** AI1 khóa `core_orders` theo ID, đối chiếu shop, customer, conversation, active revision/hash, manual/closed, khóa `(shop_id,conversation_id)` trong `core_conversation_controls` bằng `FOR UPDATE`, so status=AI/generation; quote challenge buộc `quote_revision` đúng bản giá mới nhất. Port đọc `zalo_inbound_events` theo server-provided OA/event ID, kiểm customer và conversation; khóa challenge, đối chiếu order/revision/hash/kind/quote/customer/generation + SHA-256 token + hạn; ghi `core_confirmations`, `core_verified_confirmation_events`, đánh dấu challenge consumed và audit trong **một transaction**. Các thao tác này không định giá, tạo approval/print job hoặc gửi OA.

**Replay/ACK:** Cùng event ID gọi bởi hai PostgreSQL pools chỉ một xác nhận, lần sau trả `existing` + ID đã commit (khi revision còn hiệu lực). Event khác reuse challenge trả `CONFIRMATION_REPLAY` (409); event đã dùng cho challenge khác trả `CONFIRMATION_EVENT_REPLAY` (409). Wrong OA/shop/customer/conversation, thiếu structured postback hoặc sai token trả 403; sai revision/hash/quote/takeover/generation trả `stale`, không tạo xác nhận. Lost ACK sau thay revision phải trả stale chứ không hồi sinh phiên cũ. Challenge được phát ra **không phải** xác nhận khách.

**Migration 006:** `backend/storage/migrations/006_verified_confirmation.sql` bổ sung bảng `core_confirmation_challenges` và `core_verified_confirmation_events`. `CORE_MIGRATIONS` nay 001→006. Migration chạy trên DB test riêng cùng AI2 001/002; không chạy trong request. Chỉ AI0 nối vào migration runner đã có; không tự đụng `scripts/**` hay `backend/composition/**`.

**Nhắc AI0 và AI2 (cần chốt contract trước wire chung):** [AI0][CODE-007][Bảo đảm `payload_json.confirmation_postback` chỉ do adapter sự kiện postback có chữ ký phát sinh và challenge đã gửi qua OA đúng khách; không dựng từ tin nhắn text, đồng thời inject trusted mapping server vào Port][Thiếu guard này không đủ bằng chứng customer][CI synthetic + negative text/wrong OA/customer/replay trên PG phải PASS]. [AI2][CODE-402][Chỉ tạo confirmation_candidate, giữ raw event signature/provenance cho AI0; không tự ghi core_confirmations][Không giả danh khách][stale và thiếu challenge phải HOLD/NEEDS_HUMAN].

**Kiểm thử:** `npm ci && npm run typecheck && npm run test:core` (trên branch tích hợp); CI PostgreSQL 18.3 trên PR #33 chạy `npm run db:migrate`, `npm run check`, `node tests/acceptance/run.mjs --integration` khi có `TEST_DATABASE_URL`. `tests/integration/core/verified-confirmation-pg.test.cjs` dùng hai pg.Pool, kiểm nhấn chấp nhận rõ ràng, thiếu challenge/text OK, shop/OA/customer sai, replay/lost ACK, sửa revision, takeover, >150 tờ/quote và chỉ staff mới approve. Không dùng synthetic để tuyên bố đã xác minh chữ ký OA thật.

## CODE-008 — Cùng chat, bổ sung trước staff chốt in = một order_id (12/10/2026)

**Port AI1 nội bộ, AI0 phải nối:** `createOrderSupplementPort({store, trusted:{shop_id,oa_id}})` tại `backend/core/order-supplement-port.ts`. `trusted` là mapping OA/shop do server xác thực. Không mở HTTP public hoặc giả Principal khách/nhân viên. 

```ts
port.append_verified_events(verifiedProcessorOrStaff, {
  order_id, conversation_id, customer_id, event_ids, expected_revision, idempotency_key
})
// {status:'appended'|'existing',order_id,revision,request_hash,requires_reconfirmation:true}
// hoặc {status:'stale_revision',current_revision}
```

**Trong 1 PostgreSQL transaction:** `SELECT core_orders FOR UPDATE` (khóa giống `OrderService.approve`), xác minh order ↔ shop/OA/customer/conversation qua `core_ai_draft_proposals`, toàn bộ event_ids ↔ `zalo_inbound_events(oa_id,customer_id,conversation_id,kind)`; `core_order_supplement_batches` chống trùng theo tập event + idempotency key; `core_order_inbound_reviews` là journal đã đưa vào revision. Thay đổi cùng order_id, tăng active_revision, request_hash mới, chép đầy đủ event IDs xuyên nhiều batch (không dựa mốc 60 giây); `plan=NULL` bắt buộc processor kiểm lại và khách xác nhận lại. Không tạo tự động quote, confirmation, approval, print job; không thay đổi đơn đã từng duyệt/gửi/UNKNOWN. Nếu không rõ đơn đích, AI2 giữ batch ở HUMAN để nhân viên xác định; yêu cầu đơn riêng phải được khách xác thực rõ.

**Chặn chốt:** `OrderService.approve` kiểm dữ liệu `zalo_inbound_events` đã cam kết cho shop/OA/customer/chat, không dựa `occurred_at` do provider khai; chỉ chấp nhận event nằm trong revision 1 ban đầu hoặc `core_order_inbound_reviews` thuộc order và revision không lớn hơn active. Tin/file chưa đối soát → DomainError `PENDING_INBOUND_REVIEW`, HTTP **409**. Cùng khóa order với append; nguồn `zalo_inbound_events` phải giữ AI0 trigger ingress khóa order ở cùng transaction để chống TOCTOU. Batch `DONE` hay file `ai0_inbound_artifact_drafts.CREATED` **không đồng nghĩa đã đưa vào revision**. Migration AI1 mới `007_active_order_inbound.sql` (core manifest 001→007) chỉ tạo bảng AI1; AI0 chịu trách nhiệm thứ tự migration chung.

**P0 liên AI0 đang mở:** Trigger AI0 trong `backend/composition/migrations/004_pending_approval_gate.sql` chỉ loại event ban đầu hoặc `ai0_inbound_artifact_drafts.CREATED`, hiện chưa nhận biết event đã ghi vào `core_order_inbound_reviews`. Trên code overlay PR #35, PG 18.3 test vào đúng `service.approve` sau append + xác nhận mới bị trigger `P0001 AI0_PENDING_INBOUND_REVIEW` — **FAIL có thật**, không được gắn DONE/V1 ready và không xóa trigger/test để xanh. AI1 đã yêu cầu AI0 bổ sung ngoại lệ đã đối soát vào `004` trên PR #31 comment #6123586540; chỉ AI0 có quyền sửa composition. Sau AI0 sửa phải chạy CI lại cùng SHA tích hợp, bảo đảm tin chưa append vẫn chặn, tin đã append + processor + xác nhận mới thì cho phép staff chốt.

**Kiểm thử:** `npm run check` PASS trên PR #35 overlay `54a1f9aad021e5d4a58390c9f5dd007bdc0a7d31`; PostgreSQL 18.3 **23 PASS / 1 FAIL / 0 SKIP** (AI1; lỗi duy nhất cross-owner trigger trên test mới), browser PASS. Unit `tests/unit/core/order-supplement.test.cjs` kiểm actor/inputs trước transaction. DB thật dùng hai pools, retry idempotency, nhiều batch >60s, stale revision/confirmation, pending file + future provider timestamp, duyệt vs append và bất biến sau duyệt. OA/Ricoh thật NOT RUN.

## CODE-008 — Hợp đồng Port nguyên tử AI1 → AI2/AI0 (12/10/2026)

**Port mới dùng một PostgreSQL transaction; cấm đọc đơn ở transaction A rồi append ở transaction B:**

```ts
const port=createOrderSupplementPort({
 store: core.store,
 trusted: {shop_id: trustedServerShop, oa_id: verifiedServerOa},
 processor: serverAuthenticatedProcessor,
 verifyExplicitSeparate: async (db, scope) => verifyPersistedSeparateRequest(db, scope)
});
const result=await port.apply_incoming_batch({
 conversation_id, customer_id, event_ids, text, idempotency_key,
 expected_generation, expected_revision, intent:'append_or_create', materialized:true
});
```

**Contract:** `apply_incoming_batch(input)` không nhận Principal từ AI2. Server inject processor đã xác thực lúc tạo Port. `trusted` OA/shop cũng do server cấp. `verifyExplicitSeparate(db,scope)` là callback AI0 xác thực chứng cứ khách thực sự yêu cầu đơn riêng từ sự kiện OA đã lưu; không lấy nhãn AI classifier làm chứng cứ. `event_ids` phải tồn tại trong `zalo_inbound_events`, cùng đúng OA/khách/chat, duy nhất 1–100 ID. `expected_generation` số nguyên an toàn không âm; `expected_revision` là CAS tùy chọn; `idempotency_key` phải ổn định qua retry.

| Status | Ý nghĩa |
| --- | --- |
| `appended` | Đúng một đơn mở: giữ order_id, thêm revision/hash; plan=NULL; yêu cầu processor kiểm lại và khách xác nhận lại |
| `existing` | Retry/mất ACK: cùng order đã commit, không tạo order/revision mới |
| `created` | Không có đơn trước đó, hoặc đơn riêng có chứng cứ từ callback server |
| `stale_generation` | Takeover/generation thay đổi; HOLD, không ghi dữ liệu |
| `stale_revision` | Phiên bản đơn cũ, không ghi dữ liệu |
| `ambiguous` | Nhiều đơn mở, nhờ nhân viên xác định, không đoán |
| `closed` | Không được sửa đơn đã chốt/in/khóa |
| `needs_review` | Thiếu artifact bất biến hoặc xác thực intent; HOLD, không tự đánh dấu DONE |

**Transaction/locking:** `pg_advisory_xact_lock` theo tuple (shop,OA,customer,chat), kiểm bằng chứng từng event + shop. Chọn duy nhất order đang mở, khóa `core_orders FOR UPDATE` cùng thứ tự thao tác duyệt in, khóa `core_conversation_controls FOR UPDATE` và kiểm generation trong transaction, sau đó CAS revision và idempotency trước INSERT order/revision/journal. Khi đã có đơn nháp hoặc event cập nhật cùng fingerprint, trả `existing` cả khi ACK thất lạc. File/image ngoài cờ `materialized=true` còn bắt buộc hiện diện trong bảng server-owned `ai0_inbound_document_artifacts`; thiếu thì `needs_review`. Không chuyển xác nhận cũ sang revision mới, không gắn plan ready giả.

**Duyệt & UI:** `OrderService.approve` đối soát event đã nhận với revision đầu và `core_order_inbound_reviews` có shop/OA/event/revision/hash hợp lệ; nếu thiếu thì `PENDING_INBOUND_REVIEW` HTTP409 và 0 job. Trigger AI0 ingress tiếp tục khóa order theo thứ tự commit. `getOrder.current.pending_updates={order_id,revision,request_hash,status,unresolved_count,items}` do backend pin theo active revision; không lấy AI2 batch DONE làm bằng chứng CLEAR. AI0/AI4 có thể đọc shape hiện có.

**Tích hợp bắt buộc do AI0/AI2:** AI0 cấp mapping server, processor và callback xác minh đơn riêng; AI2 gọi `apply_incoming_batch(input)` trực tiếp trong product pipeline sau signed ingest, không đọc core order trong transaction riêng để suy luận rồi gọi append. Các kết quả stale/ambiguous/needs_review phải HELD/NEEDS_HUMAN. AI0 gỡ nhánh guard cũ đang trả stale_generation thay vì append và nối real worker, không chỉnh code AI1. AI5 C008-PG-02 còn RED đến khi luồng thật gọi Port; C008-HTTP-03, C008-PG-07 cần kỳ vọng lỗi nghiệp vụ 409 ở Core (chỉ direct SQL trigger mới là P0001).

**Thực chứng:** PR #39 SHA `65a4c9bf28c58fe44f8b5a9ceb0364d9f34fb662`: TypeScript strict, Chromium và PostgreSQL 18.3 AI1 **27 PASS / 0 FAIL / 0 SKIP**. Ca `tests/integration/core/atomic-incoming-batch-pg.test.cjs` dùng hai pool độc lập, kiểm >60s, retry/mất ACK, materialization thiếu, explicit separate, ambiguous, stale revision và takeover. Acceptance toàn tích hợp **88 PASS / 3 FAIL / 19 SKIP** do chưa nối đường AI0/AI2 và kỳ vọng AI5 chưa cập nhật; không tính CODE008 P0 toàn luồng đã DONE. Không chạy Zalo/Ricoh thật hoặc deploy.

## CODE-008 P0 cập nhật — generation 0, sau chốt và chỉnh thông số in (2026-10-13)

**Bản vá AI1 không đổi chữ ký Port**: `createOrderSupplementPort({store,trusted,processor,verifyExplicitSeparate}).apply_incoming_batch(input)` giữ kết quả `created|existing|appended|stale_generation|stale_revision|ambiguous|closed|needs_review`.

- **Đơn đầu:** Sau khi kiểm tra OA/shop/khách/event và lấy PostgreSQL advisory lock cùng chat, Port chỉ khi `expected_generation=0` mới `INSERT ... ON CONFLICT DO NOTHING` dòng `core_conversation_controls` vắng mặt. Sau đó khóa `FOR UPDATE`, so đúng generation và AI/HUMAN; 2 worker cạnh tranh cho cùng một `order_id` nhờ idempotency.
- **Sau chốt:** Nếu không còn đơn đang mở và có approval lịch sử, Port so từng sự kiện theo `received_at` của server **và** `occurred_at` với `MAX(core_approvals.created_at)`. Yêu cầu in mới có cả hai thời điểm thực sự sau chốt có thể tạo order mới, 0 approval/job. Sự kiện đã nhận trước chốt hoặc provider clock bất nhất trả `needs_review`, không gắn vào bất kỳ đơn mới đang mở nào. Tin chỉ nói đổi số bản/khổ/mặt sau chốt cũng `needs_review`, không tự coi là đơn mới.
- **Thay đổi thông số:** Port chỉ tự chấp nhận thông điệp độc lập, unambiguous cho `copies` (1–500), `paper_size` (A3/A4/A5) hoặc `duplex` (một/hai mặt), khi `text` của input khớp chính xác trường `payload_json.text` của **một** sự kiện text do server lưu. Ghi giá trị cùng `event_ids`/supplements vào `request_data` của revision mới với hash mới, `plan=NULL`. Tin mơ hồ như `in ba bản` hoặc `in 2 bản khổ A4` trả `needs_review`, không ACK, không ghi journal; muốn thay đồng thời nhiều trường phải có adapter AI0 chứng minh rõ hoặc chuyển nhân viên.
- **Bất biến:** Chỉ một PostgreSQL transaction xử lý danh tính, thời gian nguồn, tìm đúng đơn, khóa order + generation, idempotency, revision; không đổi đơn đã có approval, không kế thừa customer confirmation/quote approval từ revision cũ. `OrderService.approve` vẫn trả `PENDING_INBOUND_REVIEW` HTTP409 và tạo 0 print job khi có dữ liệu chưa đối soát. Không sửa AI0 SQL trigger, tests AI5 hay pipeline AI2.
- **Test thật:** `tests/integration/core/first-generation-and-print-settings-pg.test.cjs`: 2 `pg.Pool`/PIDs độc lập, generation 7 chưa có control => stale + không tạo control, generation0 hai worker => một đơn, retry/lost ACK, tăng revision cho 3 bản/A3/hai mặt, text không rõ => HOLD, plan/null, approval theo revision và xác nhận thật (fixture credential), đơn mới sau chốt, sự kiện có server receipt trước chốt + provider clock tương lai => HOLD. Staging PR #40 trên AI0 `faa0668c326393cc6a49cfa74fe682a606aeddb1` chạy CI strict+PG; chỉ tính PASS theo đúng SHA CI.
- **Giao AI0/AI2:** AI0 tiếp tục gọi Port ở đúng signed-worker path sau khi artifact immutable có chứng cứ; AI2 giữ nguyên `needs_review` thành HOLD/NEEDS_HUMAN. AI5 `C008-PG-02` phải nghiệm thu đúng worker tự động, không bỏ test. Chưa có live OA hoặc Ricoh.

## CODE-008 — Read model `current.pending_updates` cho AI4 (13/10/2026)

API sẵn có `GET /api/v1/orders/:order_id`, không thêm HTTP endpoint và không nhận status pending từ client. `OrderService.getOrder` trả thêm `current.pending_updates` được suy ra trong transaction của đơn đang `FOR UPDATE`:

```ts
current.pending_updates = {
  order_id: string, revision: number, request_hash: string,
  status: 'clear' | 'processing' | 'needs_human',
  unresolved_count: number,
  items: Array<{kind:'file'|'message';label:string;summary:string;received_at:string|null}>
}
```

- `clear`: chỉ sau khi scope OA/server shop/customer/conversation được chứng minh từ `core_ai_draft_proposals`, tất cả ID trong current revision có nguồn `zalo_inbound_events` đúng OA/khách/chat, không có event text/image/file chưa đối soát và print plan của current revision đã được xác minh. Chỉ initial event_ids hoặc `core_order_inbound_reviews` cùng shop/OA/order, đúng revision và event tồn tại trong **reviewed revision** lẫn **current request_data.event_ids** mới được chấp nhận; batch DONE không phải chứng cứ.
- `processing`: còn event đã nhận bền trước chốt chưa được đưa vào revision hiện tại, hoặc plan chưa được processor xác minh. `unresolved_count` là tổng số event chưa đối soát (không phải số item hiển thị), `items` tối đa 12. Kind/label/summary là nhãn chung do backend tạo, không bao giờ bao gồm nội dung chat, event ID, tên file, path/URL hoặc customer metadata; `received_at` là timestamp của DB hoặc null.
- `needs_human`: thiếu link shop/OA, conversation không có nguồn, nhiều đơn đang mở cùng shop/khách/chat, không tồn tại bảng source/revision/journal hoặc lịch sử revision sai/mất event nguồn; API không được tự suy đoán `clear`. Lỗi SQL/query trả DomainError `PENDING_READ_UNAVAILABLE` HTTP503, **không** trả trạng thái CLEAR giả. Sự kiện đã nhận bền sau thời điểm staff approve đầu tiên của đơn cũ không quay lại trạng thái pending của chính đơn đó. Với đơn mở tiếp theo, so biên `received_at` với approval của đơn trước để chặn gộp nhầm sự kiện cũ.
- Read model chỉ hỗ trợ UI và được ghim theo `order_id`, `active_revision`, `request_hash` tại cùng snapshot/row lock; **không** tạo quyền duyệt. `OrderService.approve` và trigger AI0 vẫn kiểm lại ở transaction ghi approval, trả nghiệp vụ `PENDING_INBOUND_REVIEW` (HTTP409) khi còn file/tin chưa đối soát, đảm bảo 0 print job. Không sửa migration hay module AI0/AI2/AI4/AI5.
- Kiểm chứng AI1: `tests/unit/core/pending-updates.test.cjs` chứng minh sanitize, fail-closed no schema/sai shop/sai revision/SQL failure; `tests/integration/core/pending-updates-pg.test.cjs` chạy hai `pg.Pool` thật với signed-persisted synthetic events, scope OA, journal cũ không hợp lệ, revision/hash mới, pending -> approved gate 409/0-job, race ingress/read và staff approval, nhiều đơn mơ hồ, event sau duyệt, event nhận trước duyệt nhưng lưu chậm, thiếu nguồn, tổng hơn 12 mục bị giới hạn hiển thị. Dùng dữ liệu thử tổng hợp, không gửi Zalo/Ricoh thật.
- AI0 chỉ cần nhập 2 file sản phẩm AI1 (`backend/core/pending-updates.ts`, `backend/core/service.ts`) và tests sau khi SHA staging pass; API route chi tiết đơn hiện có tự đưa trường mới ra, không thay schema JSON chung khi chưa AI0 phê duyệt. AI4 nên coi `needs_human` và `processing` là khóa nút duyệt; ngay cả `clear` vẫn cần guard duyệt từ server.
