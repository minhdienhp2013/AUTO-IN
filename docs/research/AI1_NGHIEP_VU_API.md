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

## CODE-008 + OA quarantine acceptance — AI1 Core (2026-10-14)

AI1 `OrderService.approve` giữ khóa `core_orders FOR UPDATE` như trước. Với đơn Zalo có một `core_ai_draft_proposals` tin cậy ghim `shop_id` và `oa_id`, nếu tồn tại bảng AI2 `public.zalo_official_quarantine`, Core lấy PostgreSQL `LOCK TABLE ... IN SHARE MODE` trước khi đọc receipt. Khóa này xung đột `ROW EXCLUSIVE` do AI2 `INSERT`/`UPDATE`, nên receipt đang được ghi trước duyệt phải commit hoặc rollback trước khi Core kiểm tra; không tạo ấn tượng `clear` giả từ race, không coi batch DONE đã đối soát. Bất kỳ receipt `NEEDS_HUMAN` cùng OA — kể cả `customer_id/conversation_id=NULL` — làm trả `DomainError(PENDING_INBOUND_REVIEW, HTTP409)` trước tạo approval/print job. `REVIEWED` chỉ được chấp nhận sau khi AI0 implement đối soát nhân viên xác thực và audit; AI1 không tự chuyển trạng thái hoặc ghi khách xác nhận.

**Điều kiện an toàn để bật route chính thức (vẫn CHƯA đạt):** AI0 phải đưa migration AI2 `004_official_quarantine.sql` vào `db:migrate`, duy trì mapping OA→shop chỉ từ server và bảo đảm webhook chính thức KHÔNG được bật nếu bảng chưa tồn tại. Vì migration chưa có trong manifest hiện tại, Core chỉ gọi gate khi bảng đã được cài; thiếu bảng và route bật là nguy hiểm. Đơn thủ công không có OA binding không thể tự suy đoán OA: AI0/AI1 cần contract registry shop→OA tin cậy trước khi chứng nhận gate OA-wide áp dụng cho **mọi** đơn trong shop. Không dùng input OA tùy ý từ browser, tên/file/path/"OK" làm bằng chứng. Không bật route trước khi AI0 hoàn tất hai điều kiện này.

**Acceptance AI1** `tests/integration/core/official-quarantine-approval-pg.test.cjs`: chạy hai pool PostgreSQL cô lập; tạo đơn Zalo/plan/confirmation từ synthetic fixture; quarantine OA-level unknown + file mapped chặn đồng thời hai worker; HTTP route trả 409 `PENDING_INBOUND_REVIEW`, `0 core_print_jobs/approvals`; đánh dấu riêng một receipt đã REVIEWED vẫn chặn; transaction giữ INSERT chưa commit khiến staff approve chờ khóa bảng, sau commit vẫn chặn; chỉ khi tất cả receipt cùng OA đã được đối soát thì staff approve tạo đúng một job. Event OA khác không chặn sai đơn. Test áp dụng đúng SQL migration AI2, không sửa mã AI2/AI0/AI5; ở CI yêu cầu `TEST_DATABASE_URL` và PG thật, SKIP non-PG không được tính PASS.

**Phân công:** AI1 chỉ sở hữu Core/API/PG fixture; AI2 sở hữu lưu quarantine; AI0 migration registry, trustworthy OA/shop scope, authenticated review route và bật/tắt live route; AI5 nghiệm thu end-to-end mới sau khi có exact staging SHA. Hiện mọi live OA, Ricoh, TN037 vẫn NOT RUN.


## CODE-008 — Per-OA scope lock với AI2 / AI0 (14/10/2026)

Nguồn AI2 PR #53 HEAD `0c29f8c03e4921e2005fcd6fe5c43c63086ac4a4`: ký số và nhận event vào `zalo_official_quarantine` khi signature hợp lệ; AI2 giữ `zalo_official_quarantine_scopes(oa_id)` bằng `SELECT ... FOR UPDATE` trước khi INSERT/UPDATE receipt. **Đây là khóa dùng chung bắt buộc cho mọi consumer**.

AI1 `OrderService.approve` giữ thứ tự duy nhất trong cùng PostgreSQL transaction: `core_orders FOR UPDATE` → xác minh một `core_ai_draft_proposals` có shop/OA server → `INSERT INTO zalo_official_quarantine_scopes(oa_id) ... ON CONFLICT DO NOTHING` → `SELECT ... FOR UPDATE` cùng OA → đọc `NEEDS_HUMAN` ở mọi customer/chat của OA → xác minh current revision/confirmation → ghi `core_approvals` và `core_print_jobs` nguyên tử. Không còn `LOCK TABLE ... SHARE MODE`: table lock cũ có thứ tự ngược với ingress AI2, có thể tạo deadlock. Nếu mới cài 1 trong 2 bảng quarantine/scope thì Core trả lỗi nghiệp vụ HTTP409 `PENDING_INBOUND_REVIEW` (fail-closed). Không coi batch DONE, provider `occurred_at` hoặc `customer_id=NULL` là chứng cứ đã xử lý.

Hồi quy `tests/integration/core/official-quarantine-approval-pg.test.cjs` dùng hai pool PostgreSQL độc lập. **Ingress lấy scope trước**: approval phải chờ COMMIT của event và từ chối HTTP409 với 0 approval/job. **Approval lấy scope trước**: ingress bị chặn ở scope đến sau COMMIT approval; receipt được lưu bền `NEEDS_HUMAN` và vẫn cần human review, không thêm job/approval. Đối soát từng receipt theo actor audit tại AI0; AI1 không tự đặt REVIEWED trong code sản phẩm. AI0 giữ manual-order trigger và registry shop↔OA; không sửa AI2, AI0, AI5. Route Zalo thật vẫn OFF, không merge/deploy hay in Ricoh thật.

## CODE-008 — shop↔OA registry gate cho đơn thủ công và proposal (2026-10-14)

**Nền xác minh:** AI0 Draft PR #88 product SHA `3093de9d17d5455690474dcb3d66addf7f49bb1f`, AI0 migration `backend/composition/migrations/005_official_zalo_shop_registry.sql` cung cấp `core_shop_zalo_oa_registry(shop_id,oa_id,app_id)`, `PRIMARY KEY(shop_id,oa_id)` và `UNIQUE(oa_id)`. Đây là binding cấu hình **không chứa secret**, KHÔNG phải bằng chứng chữ ký OA/provider đã xác minh, cũng KHÔNG cho phép bật route chính thức. AI1 không tạo/đổi migration này.

**Thứ tự duyệt trong một transaction:** `core_orders FOR UPDATE` → kiểm tra tên bảng registry/quarantine/scope → giữ `SHARE` lock registry khi đã cài (ngăn đổi tập OA trong lúc duyệt) → truy vấn **toàn bộ OA của shop** theo `ORDER BY oa_id,app_id`, kiểm duy nhất và proposal OA bắt buộc có đúng một binding cùng shop → từng OA lần lượt `INSERT ... ON CONFLICT DO NOTHING`, `SELECT ... FOR UPDATE` trên `zalo_official_quarantine_scopes` (cùng khóa với AI2) → đọc receipt `NEEDS_HUMAN` → kiểm evidence inbound/phiên bản/xác nhận hiện hành → ghi approval/job nguyên tử. Không lấy OA từ tham số browser hoặc profile của khách.

**Scope quarantine:** proposal vẫn giữ kiểm `NEEDS_HUMAN` ở mức OA toàn bộ như trước. Với đơn **thủ công không có proposal**, mọi receipt `customer_id` hoặc `conversation_id=NULL` vẫn chặn cấp shop/OA; receipt đã map khách/chát chặn đơn cùng `customer_id` + `conversation_id`. Nếu đơn chưa có conversation, giữ thận trọng mọi receipt đã map cùng customer; không đoán khác khách. Không coi `REVIEWED` là chứng cứ khách xác nhận, không tự chuyển `REVIEWED` từ Core.

**Fail closed:** thiếu/không nhất quán registry khi có quarantine/proposal, proposal chưa được đăng ký, schema migration chỉ một phần, OA scope không khóa được, hoặc lỗi truy vấn registry/quarantine đều trả **HTTP409 `PENDING_INBOUND_REVIEW`**, transaction rollback, không tạo approval/job. Shop hoàn toàn không đăng ký OA (registry tồn tại nhưng zero binding) không có official ingress được phép định tuyến theo contract AI0; đơn Core truyền thống vẫn duyệt theo bằng chứng hiện hành. Nếu AI0 cho phép route OA vào shop zero binding thì release gate thất bại, không được bật.

**PostgreSQL acceptance:** `tests/integration/core/official-quarantine-approval-pg.test.cjs` giữ nguyên các assertion proposal cũ, bổ sung test real PG hai pools cho đơn manual cùng customer/chat, unmapped held, OA thứ hai, đăng ký sai/mất binding, ingress khóa trước → duyệt chờ rồi 409/0 approval/0 job, duyệt khóa trước → ingress commit sau duyệt, lost ACK/replay `raw_sha256` không sinh receipt mới; toàn bộ dùng migration 005 **đúng từ AI0 staging**, không thay DDL hoặc trigger của AI0. Source PR #59 có base cũ **không chứa** migration 005; CI ở base đó không thể chứng minh trường hợp registry mới. AI0 cần ghép ba blob AI1 sang đúng staging #88 rồi chạy GitHub CI trên **HEAD tích hợp mới**. Không dùng CI cũ hoặc các SKIP thay thế cho PostgreSQL thật.

**Chưa kiểm chứng vận hành:** Zalo provider golden MAC/raw-byte, OA live, Ricoh/Windows, iPhone thật, AI5 độc lập/TN-037 NOT RUN. Không merge/deploy/bật route.


## CODE501 — Đề xuất hợp đồng lịch theo shop và khóa vận hành (16/10/2026; **chỉ tài liệu, chờ AI0 chốt**)

**Nền và ranh giới:** main `cb2be7a7b84d689dbe6c2c773192f111897c4063`; yêu cầu từ `docs/prompts/DOT_HOAN_THIEN_20261016.md` tại `3bcddc5f`, TN-028/TN-035. Đây là **API đề xuất, chưa tồn tại, chưa chạy PostgreSQL/HTTP**. Không sửa CODE008/401, Zalo/AI2, Windows/AI3, React/AI4, driver hoặc hợp đồng shared trước khi AI0 đồng ý.

### 1. API/định danh/quyền (đề xuất)

- `GET /api/v1/settings/schedule`: **owner hoặc staff** có bearer session hợp lệ được xem lịch shop của chính mình; không hiển thị shop khác. `PATCH /api/v1/settings/schedule`: **owner duy nhất** (`assertOwner`). Principal phải do `AuthService.principal(bearer)` lấy từ `core_sessions` và `core_users` trên máy chủ: `principal.shop_id` quyết định hàng DB; **không nhận** shop từ URL, query, body, cookie, header tự khai hay vai trò gửi bởi browser. Anonymous/customer/agent/processor không xem/ghi lịch staff. Staff GET hợp lệ nhưng PATCH 403.
- Hai route chỉ xử lý **lịch khóa in của shop** trong `core_shop_settings`: `open_at`, `close_at`, `timezone`, `holiday_dates`, `manual_lock`. `manual_lock` ở đây là **shop-level print pause**, KHÔNG phải `core_orders.manual_lock` của từng đơn hoặc nút dừng AI. `mode` và `printing_enabled` có thể được trả **read-only** ở mục `operational_guard` cho UI hiển thị trạng thái, nhưng **mọi request PATCH chứa chúng phải 422**, kể cả giá trị `simulation`/`false` hoặc nằm trong object lồng. Tuyệt đối không có nhánh PATCH nào bật `production`/`controlled_test` hoặc đổi `printing_enabled`; AI0 giữ quy trình phê duyệt mở vận hành riêng.
- Không tự `INSERT ... ON CONFLICT` settings từ PATCH: chỉ cập nhật hàng shop đã được bootstrap; hàng thiếu trả lỗi và không sửa nhầm shop. GET cũng phải xác thực trước query, trả `Cache-Control: no-store` (tránh tái sử dụng trạng thái khóa cũ), không để body mới điều khiển credential.

### 2. JSON wire đề xuất

```http
GET /api/v1/settings/schedule
Authorization: Bearer <staff-or-owner-session>

HTTP/1.1 200 OK
Cache-Control: no-store
```
```json
{
  "shop_id": "autoin-test-shop-a",
  "version": 8,
  "open_at": "07:00",
  "close_at": "21:30",
  "timezone": "Asia/Ho_Chi_Minh",
  "holiday_dates": ["2026-10-20"],
  "manual_lock": false,
  "operational_guard": {"mode": "simulation", "printing_enabled": false}
}
```

```http
PATCH /api/v1/settings/schedule
Authorization: Bearer <owner-session>
Content-Type: application/json
```
```json
{
  "expected_version": 8,
  "idempotency_key": "owner-schedule-20261016-001",
  "open_at": "08:00",
  "close_at": "19:00",
  "timezone": "Asia/Ho_Chi_Minh",
  "holiday_dates": ["2026-10-20", "2026-10-21"],
  "manual_lock": true
}
```

```json
{
  "shop_id": "autoin-test-shop-a",
  "version": 9,
  "open_at": "08:00",
  "close_at": "19:00",
  "timezone": "Asia/Ho_Chi_Minh",
  "holiday_dates": ["2026-10-20", "2026-10-21"],
  "manual_lock": true,
  "changed": true,
  "operational_guard": {"mode": "simulation", "printing_enabled": false}
}
```

PATCH nhận **tập con không rỗng** của năm field cho phép; `holiday_dates` là **thay toàn bộ tập**, không hợp nhất ngầm. `expected_version` và `idempotency_key` bắt buộc, không phải field cấu hình. Không nhận null, number thay string, field lạ/giả mạo (`shop_id`, `actor_id`, `role`, `mode`, `printing_enabled`, `operational_guard`, `version`, `updated_at`, `__proto__`,...) hoặc object thừa; validate whitelist **trước khi ghi**. Response vẫn chứa nguyên trạng `mode/printing_enabled` read-only để chứng minh không nâng quyền vận hành. Không đưa thông tin lease/token vào response/audit.

### 3. Validation cụ thể, version và idempotency

- `open_at`, `close_at`: chuỗi `HH:mm` chính xác hai chữ số; phút 00–59; `00:00 <= open_at < close_at <= 24:00`; riêng `24:00` **chỉ cho close_at** (giữ tương thích test 23:59), không cho `24:01`, `23:60`, bằng nhau, khoảng qua nửa đêm. `open_at`/ `close_at` không có giây. So sánh cả cặp giá trị *cuối cùng* sau khi merge PATCH với row hiện tại. Qua đêm cần contract riêng trước triển khai, không âm thầm diễn giải sai.
- `timezone`: giai đoạn này chỉ chấp nhận `Asia/Ho_Chi_Minh`, vì `printingAllowed` hiện fail-closed với tất cả zone khác (`backend/core/model.ts`); không quảng cáo hỗ trợ IANA rộng hơn khi Core chưa làm. `holiday_dates`: mảng các ngày thực sự hợp lệ `YYYY-MM-DD` theo lịch Gregorian (ví dụ 2026-02-29 lỗi, 2028-02-29 hợp lệ); duy nhất, chuẩn hóa thứ tự tăng dần khi lưu/đọc, từ chối trùng và ngày không tồn tại, giới hạn số phần tử (đề xuất tối đa **730 ngày**, AI0 quyết số cuối); ngày này cấm claim/preflight/mark-sending nhưng KHÔNG tự tắt AI tư vấn. `manual_lock` chỉ nhận boolean thật. Không tự xóa ngày nghỉ đã qua trừ khi owner cập nhật.
- Migration cần thiết: `core_shop_settings.schedule_version BIGINT NOT NULL DEFAULT 1 CHECK (schedule_version >= 1)` và nên có `schedule_updated_at timestamptz`, `schedule_updated_by uuid` tham chiếu chủ; bổ sung bảng audit **shop-specific** (đề xuất `core_shop_schedule_audit` với shop_id/actor_id/old_version/new_version/old_value/new_value/created_at), vì `core_audit.order_id` hiện `NOT NULL`, không phù hợp audit cấu hình không có order. AI0 quyết số migration, DDL và việc giữ lịch sử hữu hạn, không sửa migration cũ tại giai đoạn1.
- `PATCH` gọi `PgStore.tx`, tái dùng `PgStore.once` ở action riêng `shop.schedule.patch`, scope `shop_id + actor_id + action + idempotency_key` với payload chứa cả `expected_version` và các field. Trong callback, `SELECT * FROM core_shop_settings WHERE shop_id=principal.shop_id FOR UPDATE`, so `expected_version` với `schedule_version`, validate cả bộ, `UPDATE` chỉ whitelist + `schedule_version = schedule_version + 1` (nếu có thay đổi), ghi audit cùng transaction. Replay **cùng key + payload** trả response đã lưu, không cộng version/audit thêm; cùng key khác payload trả 409 `IDEMPOTENCY_CONFLICT`. Nếu **key mới + version cũ**, luôn 409 `STALE_SETTINGS_VERSION` ngay cả khi field trùng; GET lại để thao tác thủ công. No-op với version đúng trả `changed:false` và không tăng version. Version số nguyên an toàn >0, tránh overflow.
- Mẫu lỗi (cùng envelope hiện tại `{error:{code,message,retryable}}`):
  - Không bearer / session hết hạn: HTTP **401** `UNAUTHENTICATED`.
  - Staff cố PATCH, customer/agent cố GET/PATCH: HTTP **403** `OWNER_REQUIRED` hoặc `FORBIDDEN` (theo route).
  - Body `{ "expected_version":8, "idempotency_key":"k", "mode":"production" }`: HTTP **422** `READ_ONLY_OPERATION_FIELDS`; body sai định dạng/lịch sai: **422** `INVALID_SCHEDULE`; shop_id từ caller hoặc field lạ: **422** `INVALID_INPUT`. Không tạo thay đổi.
  - Client A đã lên version 9, client B gửi `expected_version:8` key khác: HTTP **409** `STALE_SETTINGS_VERSION`, trả `current_version:9` (bổ sung meta có kiểm soát trong response, AI0 chốt wire).
  - Cùng idempotency key nhưng payload khác: HTTP **409** `IDEMPOTENCY_CONFLICT`.
  - Shop settings thật sự không tồn tại: HTTP **404** `SHOP_SETTINGS_NOT_FOUND`; DB unavailable: **503** `SCHEDULE_UNAVAILABLE`/fail-closed, không trả cached unlocked success.

### 4. Race PATCH lịch vs. claim/preflight/mark_sending (ràng buộc không gửi trùng)

Hiện trạng `OrderService.claim`: lock `core_orders` → job `NOT_SENT` → `checkGates` lock `core_shop_settings FOR UPDATE`; `preflight` và `markSending` cũng `checkGates` trong transaction và đối chiếu lease/revision/order. Vì vậy PATCH chỉ lấy **shop settings row FOR UPDATE** để tuần tự hóa; **không quét/khóa core_orders hoặc core_print_jobs trong transaction PATCH** (tránh đảo thứ tự order→job→settings và gây deadlock). Hai trình tự cần bảo đảm:

1. Owner PATCH khóa/ngày nghỉ/giờ đóng **commit trước khi** claim/preflight/mark_sending đọc gate: lệnh nhận `PRINT_CLOSED` (hoặc claim `{job:null}` tùy contract AI0 chốt), **không chuyển sang SENDING**, không driver effect. Claim đã cấp lease trước PATCH không đồng nghĩa quyền in; mark_sending **phải kiểm lại sau PATCH**, từ chối nếu đã khóa. Log lịch sử lease chưa gửi để agent đối soát an toàn.
2. Agent `mark_sending` **commit trước** PATCH: job đã `SENDING` với `mode_at_send` bất biến. PATCH được quyền khóa *lần gửi kế tiếp* nhưng KHÔNG rollback/revoke hoặc biến lệnh SENDING thành NOT_SENT, UNKNOWN/VERIFIED_DONE. Agent report theo mode snapshot cũ; mất ACK giữ **UNKNOWN / manual reconciliation**, tuyệt đối không retry/auto-resend. Sau mở khóa hay hết ngày nghỉ, chỉ các job chắc chắn `NOT_SENT`, revision/approval/plan còn hợp lệ, chưa bị order manual_lock, chưa quá hạn và đủ gate mới có thể được claim; không tạo job mới hay duyệt lại.
3. Hai owner PATCH đồng thời: cùng version 8, mỗi request có key khác; đúng một thành công lên 9, request còn lại chờ row lock rồi 409 `STALE_SETTINGS_VERSION` và không ghi; replay key cũ trả response cũ. Hai shop khác nhau cập nhật độc lập.
4. Không đổi hợp đồng xác nhận CODE401, queue, agent journal/lease, quyền reprint owner hoặc `printingAllowed` hiện hành trong giai đoạn1. Nếu chính sách cần tắt cả câu trả lời đang xử lý, đó là **AI response pause contract riêng** với AI2: print `manual_lock` không được giả là khóa AI.

### 5. TN-028: quyết định liên module mà API năm field chưa đủ biểu diễn

**Gap đặc tả:** TN-028 cho phép owner chỉnh **giờ AI trả lời ngày đặc biệt** ngoài 07:00–21:30, và ngày nghỉ AI vẫn tư vấn theo lịch nhưng **không in thật**; còn nút **tạm dừng AI và chặn câu trả lời đang xử lý**. `core_shop_settings` hiện không có per-date override hay `ai_paused`; `printingAllowed` chỉ gác **in**, không phải AI2 reply gate. Vì vậy **không được tuyên bố CODE501 năm field là đã hoàn thành TN-028**, cũng không được đưa `manual_lock` từ print sang AI2 tự động.
- **Đề nghị AI0 chốt:** giai đoạn2 chỉ quản lý *print schedule/lock* trên các field hiện có rồi giao một hợp đồng riêng `ai_reply_schedule`/`special_date_hours`/`ai_paused` cho AI2+AI4 sau; **hoặc** mở rộng cùng đợt bằng thiết kế DB/Port shared có ownership rõ trước khi code. Với ngày nghỉ, giờ AI và giờ in vẫn phải khác trục; không cho special AI hours mở khóa print. Giữ `mode=simulation` và `printing_enabled=false` bất biến tại mọi quyết định này.
- Lịch `close_at` Core hiện có so sánh exclusive, nên 21:30 đóng đúng 21:30. Thay thời gian phải được kiểm cả timezone/date trong transaction gửi, không sử dụng cache client cho khóa an toàn.

### 6. File triển khai *dự kiến sau duyệt*, ma trận PostgreSQL hai pool (**NOT RUN**)

- **AI1 stage2** sau AI0 phê duyệt: `backend/core/shop-schedule.ts` (service/policy validation; giữ `backend/core/model.ts` `printingAllowed` nguyên nếu không có thay đổi đã chốt); `backend/api/routes.ts` thêm GET/PATCH sau khi AI0 thống nhất `RouteRegistrar.patch`; `backend/core/factory.ts`; migration mới theo số AI0 cấp dưới `backend/storage/migrations/` (AI1 sở hữu file riêng sau chốt), `tests/unit/core/shop-schedule.test.cjs`, `tests/integration/core/shop-schedule-pg.test.cjs`. **AI0 sở hữu** `backend/composition/runtime.ts` register PATCH, hợp đồng/OpenAPI shared `contracts/**`, root migration runner và CI. **AI4 sở hữu** SettingsView gọi API sau khi contract được duyệt. Không sửa các file đó trong giai đoạn1.
- Ma trận thực thi chỉ trên PostgreSQL 18.3 cô lập `autoin_test*`, `Pool A/B` độc lập, Fastify thật + Core auth thật; tuyệt đối không mock API/role, không in thật. Mỗi case chụp `core_shop_settings`, version, audit/idempotency, `core_print_jobs` state, approvals và số job trước/sau:
  1. 401 GET/PATCH không bearer, bearer hết hạn; 403 PATCH staff/customer/agent; cross-shop: owner A cố gửi shop B qua body/query/URL phải bị 422/403, DB shop B không đổi, GET chủ A không bao giờ thấy dữ liệu B.
  2. Validate time/date/timezone/null/duplicate/unknown fields, kể cả `mode` và `printing_enabled`; đều 422, *không thay* version/audit/mode/printing_enabled.
  3. Hai pool owner A1/A2 PATCH cùng version; đúng **1×200, 1×409**, version tăng một, audit một; cùng key/payload replay trả nguyên response, không tăng thêm; cùng key khác payload 409; no-op không tăng version.
  4. Pool A giữ row `core_shop_settings FOR UPDATE` và cập nhật `manual_lock=true`/holiday; Pool B claim hoặc `mark_sending` đã có lease bị chờ; A commit rồi B fail-closed `PRINT_CLOSED`, giữ `NOT_SENT`, **0 new print effect / 0 duplicate job**. Test riêng preflight đọc sau update; không coi claim lease đã lấy là in.
  5. Pool B mark_sending thực (test simulation, agent credential scoped, manifest hợp lệ) **commit SENDING trước**; Pool A PATCH khóa sau: giữ `SENDING` + immutable `mode_at_send`, report thành UNKNOWN khi không rõ, không auto-resend/downgrade. Test lease ACK mất và owner mở khóa lại: chỉ `NOT_SENT` đủ điều kiện, không claim lại UNKNOWN/SENDING.
  6. Pool A/B shop khác nhau đổi lịch độc lập, không rò rỉ version/audit; query shop settings đúng scope; rollback khi DB fail. Nếu kiểm thử agent mark ở AI0 composition cần fixture verified document; AI0 cấp test-only producer, không bypass guard.
- **Kiểm tra giai đoạn1 thực tế:** chỉ đối chiếu source `backend/core/model.ts:printingAllowed`, `backend/core/service.ts:checkGates/claim/preflight/markSending/report`, `backend/storage/database.ts:once`, `backend/api/routes.ts`, migration 001 và TN-028/TN-035. **0 test mới chạy, PostgreSQL/HTTP stage2 NOT RUN**. Không merge/deploy/in thật; V1 vẫn BLOCKED.

**AI0 cần quyết định trước CODE501 giai đoạn2:** (a) tên route + GET staff/owner, (b) version/audit migration + ngày nghỉ bound/timezone/tối đa/qua đêm, (c) tách AI schedule/pausing/special-date override theo TN-028, (d) điều phối ownership `RouteRegistrar.patch`/composition/OpenAPI và cách trả `claim` khi shop đóng. Chỉ sau khi chốt mới triển khai.

## CODE501 — Giai đoạn2 triển khai theo quyết định AI0 (16/10/2026)

**AI0 đã phê duyệt:** `docs/architecture/CODE009_CONTRACT_DECISIONS_20261016.md` ở PR118. Implement trong AI1: `backend/core/shop-schedule.ts`, `backend/api/routes.ts`, `backend/core/factory.ts`, `backend/storage/migrations/008_shop_schedule.sql`, manifest Core và test Core. GET staff/owner, PATCH owner từ phiên server; shop lấy từ principal, không nhận caller-supplied shop. Runtime registration PATCH và OpenAPI do AI0 nối sau bàn giao, không được tuyên bố endpoint đã hoạt động trên composition trước đó.

- PATCH thay đúng 5 trường print schedule, strict 422 với bất kỳ `mode`/`printing_enabled`; trả `operational_guard` read-only. Gregorian max730, `Asia/Ho_Chi_Minh`, close-only 24:00, không qua đêm. `schedule_version` BIGINT checked safe integer, `PgStore.once`, CAS và audit shop không có order_id. Replay không tạo version/audit mới.
- Chỉ giữ khóa `core_shop_settings FOR UPDATE` khi PATCH; existing agent gate lock order→job→settings tiếp tục nguyên trạng. Không chỉnh `SENDING/UNKNOWN`, `mode_at_send`, in lại, claim hay print driver. Lịch AI, special-day, AI paused nằm ngoài CODE501.
- CI cần migration008, build TypeScript, test unit+PostgreSQL18.3 two independent pools, auth Fastify và mark_sending arbitration; nếu composition thiếu `RouteRegistrar.patch`, AI0 bổ sung wrapper method; không thay `backend/composition/**` trong PR AI1.
