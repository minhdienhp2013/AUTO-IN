# CODE-006 — bản tích hợp bước 1: core HTTP và bộ kiểm thử chung

Trạng thái: PARTIAL/BLOCKED, chưa có luồng sản phẩm xuyên suốt. Nhánh ai0/tich-hop-simulation-v1. Không merge PR/main, deploy, in thật hoặc gửi khách.

## Nguồn được nhập nguyên trạng

- AI1 76ccbaba62a39c62eec396c3104ba43e11f71151
- AI2 7db89f3a89c4a0fc1c60e307d45bae97125ef225
- AI3 26479054dafa787fbe46991905e1fc431f9d53f1
- AI4 6d8d88f284e1b557851568b59535bd07f444108e
- AI5 989b98fb54f50b031d6ba9b316e4d1f26dc830b2
- Nền AI0 7066849be67dabd992cda08209584e7c861b47ca

## Đã nối

backend/server.ts chạy buildIntegratedApp; dùng createCoreModule, AuthService/PostgreSQL và duy nhất bộ route AI1. CODE-000 buildApp giữ cho kiểm thử scaffold, không đăng ký cùng runtime mới. Identity customer/agent lấy từ cấu hình riêng server, không từ body. Send boundary chỉ cho shop simulation. HTTPS dùng AUTOIN_TLS_KEY và AUTOIN_TLS_CERT; agent AI3 yêu cầu HTTPS.

npm run build tạo dist/backend/core, api, storage và module AI2. npm run check kiểm contracts scaffold, typecheck, build, unit core/Zalo và 5 ca composition (gồm một ca PostgreSQL thật khi có TEST_DATABASE_URL). AI2 dùng tsconfig.ai2.json strict tương đương cấu hình đã bàn giao; sáu lỗi exactOptionalPropertyTypes/noUncheckedIndexedAccess vẫn chờ AI2, không sửa namespace AI2 hoặc tuyên bố đạt hai tùy chọn đó.

npm run db:migrate chạy migration AI1 001–004, AI2 001–002 trong transaction và advisory lock. Chỉ nhận DB test localhost và opt-in. npm run db:bootstrap tạo owner tổng hợp do người chạy cấp, không có HTTP bootstrap/mật khẩu production mặc định. CI integration.yml cấp PostgreSQL 18.3 riêng và chạy product PG/DryRun của AI5.

## Chạy cục bộ

```sh
npm ci
npm run build
# PostgreSQL đã chạy tại localhost, DB riêng autoin_test_305.
export DATABASE_URL='postgresql://auto_in:development_only@127.0.0.1:5432/autoin_test_305'
export AUTOIN_ALLOW_PG_ACCEPTANCE=YES_ISOLATED_TEST_DB
npm run db:migrate
# Cấp AUTOIN_SHOP_ID, AUTOIN_OWNER_USERNAME, AUTOIN_OWNER_PASSWORD qua môi trường riêng.
npm run db:bootstrap
npm start
```

Web nằm trong web/, dùng npm install và npm run dev tại đó; lockfile AI4 vẫn chưa có, không coi npm ci web đã đạt. Backend mặc định localhost:3000; frontend cần proxy same-origin hoặc cấu hình deployment riêng trước nghiệm thu browser live. Không mở CORS wildcard.

AUTOIN_IDENTITIES_FILE là đường dẫn file riêng ngoài Git chứa mảng {token,principal}. Token ngẫu nhiên tối thiểu 32 ký tự, principal gồm id/shop_id/verified=true, role customer kèm customer_id hoặc print_agent kèm printer_ids. Chỉ dùng danh tính tổng hợp simulation; không log token. AI1 vẫn kiểm quyền, shop và customer/order trong nghiệp vụ. Nếu thiếu cấu hình, customer/agent trả 401.

## AI5: kiểm bản tích hợp này

Lấy SHA thực của HEAD nhánh này làm AUTOIN_INTEGRATION_SHA. Đặt AUTOIN_OPERATION_MODE=simulation. Build rồi chạy lệnh trong docs/acceptance/CODE305_RUNBOOK.md; AI1_BUILD_DIR mặc định dist/backend. Chỉ đặt TEST_DATABASE_URL và AUTOIN_TEST_DATABASE_URL khi có PostgreSQL test thật. HTTP readiness/anonymous auth có thể chạy khi server khởi động; không coi nhóm này là toàn bộ nghiệp vụ HTTP.

## Kết quả local

npm run check: PASS; contracts 18, core 11 (2 PG SKIP), Zalo 31 (1 PG SKIP), composition 4 (1 PG SKIP). Python AI3: 95 PASS, 1 SKIP. Web cùng SHA: 40 PASS, typecheck/build PASS với dependencies đã cài; chưa có lock/npm ci. Môi trường local không có PostgreSQL test chạy hợp lệ; CI thực hiện thật, không dùng DB memory thay thế.

## Phần chưa xong và đầu mối

- AI0: đồng bộ OpenAPI/schema runtime theo wire AI1. contracts/generated hiện là scaffold, CHƯA là OpenAPI runtime tích hợp; consumer bám backend/api/routes.ts và tài liệu AI1.
- AI0: đã nối processor CLI nội bộ vào AI1 qua PostgreSQL; còn thiếu upload/preview/artifact theo quyền từ web. Phải giữ snapshot nguồn AI3, không đọc lại inbound lúc gửi.
- AI0 + AI2: nối raw webhook, transaction, trusted OA/shop và Port đơn/tài liệu. Mặc định /webhooks/zalo trả 503; chỉ khi cấu hình test synthetic tại server mới nhận event. Chưa bật worker.
- AI2: 6 lỗi TypeScript strict đã sửa tại overlay `82a0e5d`; thiếu Port AI1/AI3 để xử lý batch sản phẩm.
- AI4: lockfile/npm ci và UI live; AI5: PG/HTTP/DryRun/browser thực. Bộ test hiện không thay TN-037.

## Xác minh CI và processor sau commit đầu

GitHub Actions cho SHA 6d9bdf6882bdc8d3d557978b0e71e7785402fdbd: CODE checks và Simulation integration đều SUCCESS. Simulation integration chạy PostgreSQL 18.3 thật: contracts 18 PASS; AI1 13 PASS/0 SKIP, AI2 32 PASS/0 SKIP, composition 5 PASS/0 SKIP; Python AI3 95 PASS/1 SKIP. AI5 20/20 ca PG/DryRun sản phẩm PASS; nhóm runner --integration 50 PASS/0 FAIL/19 SKIP (19 ca legacy/chưa nối). HTTP readiness và 5 ca từ chối truy cập không xác thực PASS; runner --http vẫn có ca khác SKIP. Đây là bằng chứng core/PG/DryRun service và CLI processor, chưa phải luồng từ giao diện hay webhook.

AI0 tiếp tục thêm `backend/composition/processor.ts`: gọi subprocess AI3 bằng JSON, giới hạn 256 KiB, timeout và stdout, kiểm manifest/hash, giữ snapshot nguồn trong artifact root. `npm run process:order -- <shop_id> <order_uuid>` là CLI nội bộ; cần DATABASE_URL, AUTOIN_INPUT_ROOT, AUTOIN_ARTIFACT_ROOT, AUTOIN_PROCESSOR_ID, Python có PyMuPDF/Pillow. Lấy request_data/hash của revision hiện hành trong PostgreSQL, chỉ cho shop simulation rồi gọi AI1 publishVerifiedPlan. AI1 tăng revision, yêu cầu xác nhận/duyệt lại. Không đi qua HTTP công khai, không gửi máy in. Nên sử dụng trên DB test và file synthetic cho tới khi có endpoint upload/preview được xác thực. Không gán `preview_verified=true` vì preview chưa có route phục vụ theo quyền.

Ca `tests/integration/composition/processor-pg.test.mjs` kiểm riêng đường processor → AI1 trên PostgreSQL thật: tạo ảnh/đơn tổng hợp, gọi CLI nội bộ, xác nhận revision mới và snapshot SHA giữ nguyên sau khi file inbound thay đổi. Khi thiếu TEST_DATABASE_URL ca này SKIP rõ ràng. Ca HTTP/PG AI5 vẫn không phải đường upload/processor trên web; trạng thái processor_configured trên /health tiếp tục false cho đến khi có route theo quyền và artifact resolver.

## AI2 CODE-302 overlay và synthetic ingress

AI2 integration overlay `82a0e5d` is based directly on AI0 `15c1ac7` and supplies
`createZaloComposition()` with one PostgreSQL client per transaction. The AI0
simulation server accepts an optional private `AUTOIN_ZALO_SYNTHETIC_REGISTRY`
JSON file containing `{"kind":"synthetic_fixture","shop_id":"...","oa_id":"...","fixture_key":"at-least-32-characters"}`.
These IDs and the test key come from the server file, never from a webhook. The
server listens only on localhost with an isolated test database. Without this
file, the webhook endpoint remains unavailable. With it, synthetic signed
events can be stored and deduplicated through Fastify and PostgreSQL; the health
response reports `zalo_worker_configured: false`.

This is **inbound only**. AI1 `createDraft()` requires a verified staff actor and
must not be called by an impersonated AI worker. AI1 still needs to export a
server-authorized, event-idempotent draft Port for AI2's `suggest_draft()` and
`route_human()`; AI3 needs a trusted document inspection Port. Do not schedule
`tick_inbound()` until both are connected and tested. No actual OA verifier,
outbound sender, or live printing is configured.

## Bản tích hợp tiếp theo (AI1–AI5)

Nhánh `ai0/code006-ports-integration` nhập mã AI1/AI2/AI3/AI4/AI5 đã bàn giao, bổ sung AI0 composition. Migration chạy AI1 001–004 → AI2 001–002 → AI1 005 → AI0 artifact registry. Synthetic inbound worker chỉ chạy khi có registry riêng và `AUTOIN_ZALO_SYNTHETIC_TICK_MS=1000..60000`; server kiểm đủ bảng trước khi nghe. AI1 draft Port kiểm sự kiện/generation; tài liệu chỉ được AI3 xem khi khớp bản ghi artifact do server kiểm soát, còn file chưa đăng ký chuyển người xử lý. Outbound vẫn khóa, không kết nối OA thật.

Đã tạo `web/package-lock.json` từ npm registry thật: `npm ci`, test, typecheck, build đều đạt cục bộ; workflow CODE checks cũng chạy cài sạch/build web. Python AI3 đạt 140 PASS, 1 SKIP cục bộ. Browser desktop/mobile chưa kiểm được do Chromium trong môi trường này không khởi động. PostgreSQL trên SHA mới cần xác nhận qua Simulation integration CI. Bài thử AI2 `route_human` được đồng bộ với hợp đồng CAS của AI1: generation cũ trả `stale_generation`.

Chưa có đường ingest an toàn để ghi artifact registry, HTTPS agent sản phẩm, browser, OA thật hoặc in thật. Không coi các mục đó là V1 đã nghiệm thu.


## CODE-006 tiếp quản 12/10/2026 — đường tài liệu simulation, chưa vận hành thật

AI0 tiếp tục trên nhánh PR #31, sau nền eff849379. KHÔNG thay module AI1–AI5, không merge/deploy.

- AI0 tạo `backend/composition/synthetic-ingest.ts`: staff đăng nhập bằng AuthService của AI1 mới được POST `/internal/simulation/inbound-artifacts`; body JSON `{event_id,filename,content_base64}`. Có thêm server registry trusted OA/shop, DB shop chỉ `simulation`, sự kiện đã được AI2 ký/nhận có `filename` khớp. Chỉ fixture, KHÔNG xác minh file tải từ Zalo thật. Dung lượng tối đa 600 KiB; ảnh/PDF/định dạng khác AI3 vẫn tự đánh giá an toàn. Chống idempotent khác SHA, snapshot riêng 0700 với `source-000-<sha>.<ext>` và `manifest.json` dạng `ai3.upload_snapshot.v1`, DB `ai0_inbound_document_artifacts`. Không lấy ref/hash từ webhook.
- AI0 tạo `backend/composition/migrations/002_plan_previews.sql`: hash manifest AI3 gắn shop/order/revision trong `ai0_verified_plan_manifests`. CLI `npm run process:order` được chặn DB khác localhost test, sau AI1 publishVerifiedPlan mới ghi hash; publication vẫn yêu cầu khách xác nhận/nhân viên duyệt lại. Không tự in.
- AI0 tạo `backend/composition/preview.ts`: `GET /api/v1/orders/:order_id/revisions/:revision/previews/:index` khi `AUTOIN_ARTIFACT_ROOT` cấu hình, chỉ staff đã xác thực cùng shop, revision hiện hành, manifest SHA khớp DB, PNG SHA khớp manifest, file private không symlink. Trả PNG có no-store/nosniff, không mở PDF gốc hoặc kết luận đã in. Không có evidence → 404/409 an toàn.
- `AUTOIN_DOCUMENT_ARTIFACT_ROOT` phục vụ intake synthetic AI2; `AUTOIN_ARTIFACT_ROOT` phục vụ processor CLI/preview AI3. Hai nguồn không tự động liên kết với nhau. Chưa có đường tải trực tiếp tài liệu OA thật, tự map file vào request_data đơn hoặc frontend upload; tài liệu Word/Excel chưa có preview đáng tin cậy phải chuyển nhân viên.
- Bộ test AI0 mới: `tests/integration/composition/{synthetic-ingest,preview}.test.ts`. Các bảng bổ sung chỉ tạo ở DB test qua `npm run db:migrate`. Kết quả CI phải ghi đúng HEAD SHA; PASS cũ không thay PASS mới. Browser desktop/mobile, HTTPS agent end-to-end, Zalo OA thật, Ricoh thật và TN-037 vẫn NOT RUN/BLOCKED.

AI4 chỉ sửa UI sử dụng route preview đã gắn quyền, không thay server. AI5 kiểm cả phép thử từ chối truy cập, mã băm sai, phiên bản cũ, PostgreSQL, browser; không coi CI green là nghiệm thu TN-037.


## CODE-006 tiếp tục: synthetic inbound → AI1 draft → AI3 renderer → preview

Chỉ chạy với PostgreSQL localhost autoin_test, shop simulation và signed synthetic fixture; không phải API tải media Zalo OA thật.

- Nhân viên đăng nhập AI1 thực hiện POST /internal/simulation/inbound-artifacts/:event_id/draft với JSON {"paper":"A4","copies":2,"duplex":false} sau khi đã đăng ký file bằng POST /internal/simulation/inbound-artifacts. Server tự tra customer_id, conversation_id và source ref/hash từ bản ghi event OA/shop đã xác thực; kiểm manifest và file SHA-256, không tin đường dẫn do client đưa.
- Migration backend/composition/migrations/003_inbound_drafts.sql tạo một reservation (shop,oa,event) và đặt PENDING trước khi AI1 createDraft; nếu crash/mất ACK thì giữ PENDING để người xử lý, KHÔNG tự tạo lại; bản CREATED gọi lại trả existing; sửa thông số từ cùng event → lỗi 409.
- CLI npm run process:order -- <shop_id> <order_uuid> chỉ được chạy với AUTOIN_INPUT_ROOT trỏ đúng AUTOIN_DOCUMENT_ARTIFACT_ROOT, AUTOIN_ARTIFACT_ROOT làm nơi AI3 xuất artifact; AI0 kiểm nguồn/manifest SHA trước và sau khi AI3 render. Nếu hash khác, request nhiều file, file ZIP cần xử lý riêng hoặc event không được ràng buộc order → không xuất kế hoạch in.
- Nếu AI3 READY và bằng chứng khớp, AI1 publishVerifiedPlan tăng revision, cần khách xác nhận lại và nhân viên duyệt đúng phiên bản. API xem preview PNG theo quyền vẫn là GET /api/v1/orders/:order_id/revisions/:revision/previews/:index, gắn DB manifest SHA và active revision.
- Test tests/integration/composition/inbound-draft-pg.test.mjs dùng PostgreSQL thật, Fastify/login, AI1 draft, AI3 CLI, preview, trả về 401 khi chưa đăng nhập, chống tạo trùng, giữ PENDING sau lỗi mơ hồ, sửa source → chặn; kiểm 0 confirm và 0 print jobs. Không có TEST_DATABASE_URL thì ca này SKIP.

Còn chặn: tải media OA thật, browser desktop/mobile, HTTPS Windows Agent, native Word/Excel verified preview, Ricoh thật, TN-037. Không phát lệnh in, không gửi OA, không merge/deploy.


## CODE-006 tiếp tục: PostgreSQL thật + Fastify HTTPS + Windows Python DryRun (12/10/2026)

- SHA mã kiểm thử AI0: `414be3e6eb04d5313928422292aa8f6436a190fa`. Phần mới: `tests/integration/composition/https-agent-product-pg.test.mjs` (không sửa AI1/AI2/AI3/AI4/AI5).
- Test bắt buộc `TEST_DATABASE_URL` là PostgreSQL test localhost. Chứng chỉ localhost tự ký dùng riêng cho test, được Python tin qua `SSL_CERT_FILE`, không đưa khóa TLS, token hay hồ sơ khách vào Git.
- Bằng chứng đã chạy: CODE checks push/PR **SUCCESS**, Simulation integration PostgreSQL push/PR **SUCCESS** trên đúng SHA. PostgreSQL composition **15 PASS/0 FAIL/0 SKIP**, AI3 Python **140 PASS/1 SKIP**, AI5 integration **58 PASS/19 SKIP**, AI5 HTTP **43 PASS/41 SKIP**.
- Hai đơn độc lập được tạo qua AI1 HTTP staff: AI3 CLI sinh plan revision 2, thử duyệt trước khi khách xác nhận phải từ chối; khách dùng server-scoped verified credential xác nhận request; nhân viên mới duyệt. Agent `python3 -m agents.windows.cli` chạy qua HTTPS localhost tới Fastify/PostgreSQL, duy nhất `DryRunDriver`; kết quả `SIMULATED_DONE`, `verified_sheets=0`, ghi giao giấy bị từ chối, chạy agent lại phải `NO_JOB`.
- Đơn khác mô phỏng crash sau `mark_sending` và trước driver; journal SQLite bền vững, chạy Python process khác gọi `recover()` chuyển PG thành `UNKNOWN` với **0 driver calls**; gọi lại agent phải `NO_JOB`; không có job in lại hay giấy verified. Đây là bài test thực qua mạng HTTPS localhost và PostgreSQL; **không** phải test máy Ricoh thật hoặc môi trường Windows thật.
- Tài khoản chủ, khách, agent, máy `RMP7000`, đơn hàng, file ảnh, chứng chỉ và journal trong ca này đều là fixture synthetic cô lập. Quyền in thật, gửi Zalo OA, deploy và merge vẫn khóa.

**Tiếp theo**: AI4 browser desktop/mobile dùng backend simulation và preview theo bearer; AI5 ghi bằng chứng mới trên SHA tích hợp hiện hành, không tính SKIP là nghiệm thu; AI3/AI1 phối hợp kiểm thử Agent Windows HTTPS trên máy dự kiến sau khi có thiết bị/môi trường thử riêng và được chủ duyệt. Chưa đạt TN-037.


## CODE-006 — Đối soát bản nháp synthetic PENDING do mất ACK

Khi quá trình tạo nháp của AI1 đã COMMIT nhưng việc ghi phản hồi/tham chiếu vào bảng AI0 gặp lỗi, trạng thái `PENDING` **không được thử tạo lại**. AI0 cung cấp thao tác chỉ chủ cửa hàng (role `owner`) và chỉ trong shop `simulation`:

- `POST /internal/simulation/inbound-artifacts/:event_id/reconcile` với bearer **phiên chủ** AI1; JSON chỉ gồm `{"paper":"A4","copies":1,"duplex":false}` (cùng tham số lần tạo ban đầu). Event và OA lấy theo fixture scope của server.
- Kiểm tra SHA của file & manifest đã đăng ký, trùng toàn bộ settings hash trong reservation, actor_id ban đầu, idempotency key và payload hash của AI1 `core_idempotency`, response phải đủ id/request hash, kiểm tra `core_orders` + revision 1/customer/conversation/request data đúng hash. Tất cả đọc/ghi khóa row PostgreSQL trong giao dịch.
- Khi chứng minh được **đơn thật đã có**, đổi PENDING → CREATED và ghi vào `core_audit` hành động `ai0.synthetic_draft.reconciled` trong **cùng transaction**. Trả `{"status":"recovered","order_id":"…","revision":1,"requires_customer_confirmation":true,"preview_trusted":false,"created_new_order":false}`. Đối soát lần 2 trả `existing` và không ghi audit mới.
- Khi không có chứng cứ đã COMMIT, hash lệch, sai shop/quyền, hoặc nguồn lưu trữ thay đổi: trả 403/404/409, giữ nguyên PENDING cho xử lý thủ công. **Không có nhánh nào gọi createDraft/new order**, không xác nhận thay khách, không duyệt in, không tạo job in.
- Test `tests/integration/composition/inbound-reconcile-pg.test.mjs` trên PostgreSQL thật: mất ACK sau AI1 COMMIT, chủ khôi phục; cấm nhân viên; sai thông số; mất ACK trước COMMIT vẫn giữ PENDING; hai lời gọi đồng thời chỉ cập nhật một lần; kiểm DB có đúng một audit và không tạo thêm đơn. Nếu thiếu TEST_DATABASE_URL thì báo SKIP, không đánh dấu PASS.

Lưu ý: đây là quy trình *simulation-only*, không dùng token nhân viên để phục hồi, không cho phép tạo đơn mới thay vì phục hồi. Sau khi liên kết phải tiếp tục quy trình xác nhận/preview/duyệt đúng revision đã kiểm chứng.


## CODE-006 — API danh sách preview đã xác minh cho AI4

Thêm endpoint phía AI0: `GET /api/v1/orders/:order_id/revisions/:revision/previews`, yêu cầu phiên đăng nhập nhân viên/chủ AI1 qua `Authorization: Bearer <staff_session>` (không nhận token trong URL).

- Server đối chiếu shop, quyền, active revision, `ai0_verified_plan_manifests`, hash manifest AI3, request hash và SHA-256/kích thước **của mọi PNG**. Nếu một ảnh bị đổi, mất, sai chữ ký hoặc manifest lỗi, toàn bộ catalog thất bại, không xuất danh sách một phần với nhãn verified.
- Chỉ trả JSON server-relative, không có đường dẫn file thật, token, tên tệp gốc hay manifest nội bộ: `{"order_id":"<uuid>","revision":2,"request_hash":"<sha256>","preview_verified":true,"preview_count":1,"previews":[{"index":0,"url":"/api/v1/orders/<uuid>/revisions/2/previews/0","content_type":"image/png"}]}`. Header `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`.
- Lấy từng ảnh qua `GET /api/v1/orders/:order_id/revisions/:revision/previews/:index` **luôn kiểm lại** phiên/quyền/hash/revision khi tải; catalog không phải token hay bằng chứng duyệt. Frontend AI4 phải fetch ảnh với Bearer rồi tạo object URL và thu hồi khi đổi đơn/unmount, không dùng trực tiếp `<img src=...>` vì browser không tự gắn bearer. Không được chuyển preview_verified thành xác nhận khách hoặc giấy in/giao thực tế.
- Kiểm thử `tests/integration/composition/preview.test.ts`: shop sai, role customer, stale revision, manifest/source PNG đổi, cả tình huống ảnh thứ nhất đúng nhưng ảnh thứ hai bị lỗi → catalog bị chặn. `tests/integration/composition/inbound-draft-pg.test.mjs`: Fastify+PostgreSQL, bearer 401/200, URL scope đúng, ảnh đổi → HTTP 409. Chỉ ghi PASS sau khi GitHub CI hoàn tất trên đúng HEAD.


## CODE-006 — Gate browser product độc lập và hợp đồng xác minh chế độ (12/10/2026)

AI0 cung cấp `GET /api/v1/runtime-status` dành cho nhân viên/chủ đã đăng nhập AI1, **không** dùng `/health` công khai hoặc giá trị do JavaScript tự đoán làm bằng chứng vận hành. Mỗi yêu cầu xác minh principal, tra `core_shop_settings` theo `shop_id` ở phiên, chỉ nhận shop trong mode `simulation` và từ chối shop `production`/`controlled_test`/`safe` bằng HTTP 409 `SIMULATION_REQUIRED`. Kết quả an toàn: `server_verified:true`, `mode:'simulation'`, `live_enabled:false`, `physical_print_enabled:false`, `manual_lock`, `preview_configured`, `synthetic_artifact_ingest_configured`. Header `Cache-Control:no-store`; không trả token, đường dẫn riêng hoặc cấu hình máy in thật. `printing_enabled=true` trong DB không được đổi physical_print_enabled trong runtime test thành true.

`tests/integration/composition/runtime-status-pg.test.mjs` kiểm thử bằng PostgreSQL thật với hai shop, đăng nhập chủ thật, 401 khi thiếu/giả token, scope theo shop, `manual_lock` và yêu cầu 409 khi shop không ở mode simulation. Nhắc AI4 chỉ sửa `web/**`: `HttpPrintPort.mode()` phải đọc mode đã chứng thực, fail-closed về `unverified` khi 401/403/409/503/không rõ; đừng diễn giải chế độ demo hay `/health` thành bằng chứng chấp thuận lệnh in.

CI `.github/workflows/integration.yml` tách **2 job độc lập**: `postgres` (AI1/AI2/AI3/AI5, Fastify, tài liệu, DryRun) và `product-browser` (Vite `VITE_DEMO_MODE=false`, chromium trên desktop/mobile, Fastify + PostgreSQL test). `product-browser` vẫn là **release-blocking gate**, không được tạm `continue-on-error` hay gắn nhãn SKIP. Tách job là để không ghi sai kết quả PostgreSQL khi lỗi nằm ở UI. CI `check` chạy Chromium DEMO riêng. Lệnh migration cho cả hai PG job chỉ được bật bằng `AUTOIN_ALLOW_PG_ACCEPTANCE=YES_ISOLATED_TEST_DB` và URL localhost `autoin_test_305`.

**Blocker AI4 còn mở:** `web/src/api.ts` dùng default `fetch` không bind rồi gọi `this.fetcher(...)` → trình duyệt không gửi request auth, NETWORK. AI0 đã giao sửa ở PR #15 (bình luận #6117649126 và #6118332767), AI5 phải ghi `product-browser FAIL` tới khi có log chính xác trên SHA tích hợp. Chưa có nghiệm thu Zalo OA, Ricoh, Windows thật hoặc TN-037. Không merge/deploy/in thật.


## CODE-006 — Đóng blocker Chromium product login (12/10/2026)

**ĐÃ KHẮC PHỤC và kiểm thử thật**, không còn giữ nhãn `product-browser FAIL` cho commit `1d3ef7f157ea903d6d6bd91dc14334e9866ee1e7`.

Nguyên nhân: AI4 `web/src/api.ts` truyền `fetch` mặc định vào `this.fetcher`, sau đó gọi như method của `HttpPrintPort`. Khi chạy trên Chromium, native `Window.fetch` yêu cầu receiver đúng, xảy ra `Illegal invocation`, HTTP POST đăng nhập không gửi đến Fastify; web hiển thị NETWORK. **Bản vá tích hợp khẩn một dòng theo yêu cầu trực tiếp của chủ**: default `fetcher = globalThis.fetch.bind(globalThis)`. Bản vá chỉ sửa method binding, không thay quyền, nội dung nghiệp vụ, mô hình phiên, không đụng AI1/AI2/AI3. AI4 giữ quyền sở hữu lâu dài `web/**` và phải đồng bộ commit này vào nhánh AI4 trước khi phát triển thêm.

Bằng chứng **đúng SHA `1d3ef7f157ea903d6d6bd91dc14334e9866ee1e7`**:
- CODE checks push + PR: **2/2 SUCCESS**.
- Simulation integration PostgreSQL push + PR: **2/2 SUCCESS**.
- Product-browser Chromium push + PR: **2/2 SUCCESS**.
- Trình duyệt Chrome headless chạy build thật `VITE_DEMO_MODE=false`, đăng nhập chủ đã bootstrap bằng AI1, qua Fastify localhost và PostgreSQL test biệt lập: **Desktop 1440×900 PASS, mobile 390×844 PASS**. POST `/api/v1/auth/login` thực sự đến Fastify HTTP 200, GET `/api/v1/auth/me`, `/api/v1/orders`, GET chi tiết đơn HTTP 200; preview chưa đủ chứng cứ => nút duyệt disabled. Sau ca test DB chứng minh không tạo xác nhận khách, approval, print job, delivery; không tràn ngang. Không có gọi OA/driver Ricoh.
- AI0 composition PostgreSQL **18/18 PASS**, Python AI3 **140 PASS / 1 SKIP**, AI5 integration **58 PASS / 19 SKIP**, HTTP **43 PASS / 41 SKIP**.
- GitHub job tham chiếu: product-browser `https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38208761685/job/114678010061`; PostgreSQL `https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38208761685/job/114678009933`; checks `https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38208761749/job/114678010257`.

**Không suy diễn thành V1 RELEASE:** Zalo OA thật, máy Ricoh/Windows thật, end-to-end in vật lý và tiêu chí TN-037 210 đơn/≥7 ngày vẫn NOT RUN/BLOCKED. V1/PR #31 vẫn Draft; không merge/deploy/in thật khi chưa có phê duyệt.


## CODE-006 — Zalo synthetic file-only: AI3 facts → AI2 durable worker → AI1 draft (12/10/2026)

**ĐÃ CHẠY PostgreSQL/AI3 Python thật ở môi trường test**, không phải mock. `tests/integration/composition/zalo-artifact-worker-pg.test.mjs` dùng OA/shop fixture có secret riêng, Fastify nhận webhook chữ ký tổng hợp, AI0 nhập file PNG test và đóng băng nguồn+SHA-256+manifest, AI3 `fact_inspect` thực sự decode file, AI2 worker lấy queue PostgreSQL và gọi AI1 Port tạo draft đúng một lần. Kết quả AI1 revision 1, chưa quote/chưa khách xác nhận/chưa approval/chưa print job, sender Zalo thật disabled. Webhook trùng, worker tick lại đều không tạo proposal trùng.

**Lỗi liên module tìm và sửa:** Khi khách chỉ gửi attachment, AI2 giữ `text:''` (chính xác, không bịa lời khách); AI1 `suggest_draft` yêu cầu `text` khác rỗng. Trước sửa, worker `retry=1` và giữ hàng đợi dù tài liệu đã được AI3 kiểm chứng. Adapter AI0 ở `backend/composition/zalo-simulation.ts` bổ sung **metadata do hệ thống tạo** `[AUTO-IN SYSTEM: ATTACHMENT_ONLY; NO_CUSTOMER_TEXT]` vào đúng boundary AI2→AI1 **chỉ khi** `text.trim()` rỗng; giữ nguyên mọi text khách thật, event IDs, shop/OA, expected_generation và khóa idempotency. AI1 vẫn ràng buộc event với conversation/customer và kiểm generation trong PostgreSQL. Không được diễn giải metadata đó thành lời khách đã gửi; request revision không chứa `file_ref` do khách tự cung cấp.

**Ca đối chứng fail-closed:** Một sự kiện image khác được đăng ký manifest hợp lệ, sau đó thay bytes nguồn → AI3 trả `unknown/preview_trusted:false` → AI2 chuyển `HUMAN`, không tạo đơn nháp mới, không thể in/tạo approval tự động. Không cho webhook đính kèm đường dẫn tự nhận làm artifact chuẩn.

SHA tích hợp đã qua 6/6 CI `1c7465c38db9663e135618070fa17859eb76613b`: `CODE checks`, `Simulation integration / postgres` và `product-browser` đều SUCCESS trên push và PR. Composition **19/19 PASS**, AI3 Python 140 PASS/1 SKIP, AI5 integration 58 PASS/19 SKIP và HTTP 43 PASS/41 SKIP. PostgreSQL evidence: https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38209565593/job/114680474511 . Kiểm thử dùng file/khách tổng hợp trên database autoin_test riêng, KHÔNG thử OA thật hoặc Windows/Ricoh thật, không đáp ứng TN-037; PR tiếp tục Draft/partial, chưa merge/deploy.


## CODE-006 — Giao diện preview raster có chứng cứ SHA/PG/Chromium (12/10/2026)

**Đã nối thật trên nhánh tích hợp AI0 theo yêu cầu chủ.** Tại commit mã `e9b8ceadb6c68e95b9dcea69624469320d92e2b5` toàn bộ **6/6 GitHub CI SUCCESS**, bao gồm CODE checks 2/2, real PostgreSQL 2/2, real Chromium product-browser 2/2; AI0 composition 19/19 PASS, AI3 Python 140 PASS/1 SKIP, AI5 integration 58 PASS/19 SKIP, HTTP 43 PASS/41 SKIP. [Chromium product job](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38210529611/job/114683426927) · [PostgreSQL job](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38210529611/job/114683426818).

**Phạm vi bản vá tích hợp tạm trên `web/**` (AI4 cần đồng bộ về PR riêng):**
- `web/src/api.ts`: `HttpPrintPort.loadVerifiedPreviewPages(order)` dùng bearer AI1, GET catalog `/api/v1/orders/:id/revisions/:revision/previews`, buộc `order_id/revision/request_hash`, `preview_count` 1–15, index và **URL chính xác** đúng origin/route được máy chủ cấp; lần lượt fetch mỗi `image/png` bằng Authorization (không đặt token vào URL). Chỉ trả đủ danh sách Blob khi tất cả trang trả hợp lệ và có PNG signature; lỗi/401/409/404/503/network trả trạng thái không tin cậy; không tự coi catalog cũ là quyền truy cập sau thay đổi phiên bản.
- `web/src/App.tsx`: `VerifiedPreviewGallery` riêng, Object URL tạm; mount lại theo `order_id:revision:request_hash`, cleanup `URL.revokeObjectURL` khi đổi/đóng đơn. Bắt buộc chỉ hiển thị toàn bộ tập trang sau khi tất cả đã tải; mất một trang → không có ảnh nào được tuyên bố xác minh. Luôn giải thích preview **không phải** xác nhận khách, không phải giấy đã in/giao; không set `DocumentView.preview_trusted` hay trạng thái xác nhận giả, không mở nút duyệt của `hasValidApprovalInputs`.
- `web/src/styles.css`: lưới ảnh xem trước responsive cho desktop/mobile. Chưa dựng lại metadata per-file bởi AI1 hiện chưa cấp read model chi tiết; giao diện nêu rõ, không giả danh cấu trúc gốc.

**Kiểm thử trực tiếp Chrome + Fastify + PostgreSQL** ở `scripts/browser-product.mjs`/`.py`: tạo hai đơn test cô lập, một đơn không preview và một đơn có manifest SHA-256 PNG tổng hợp được anchor vào PostgreSQL. Chrome headless 1440×900 và 390×844 đăng nhập staff bearer, GET catalog/PNG trả 200, ảnh hiển thị bằng `blob:`, không lộ file riêng/token, không tràn ngang, **nút duyệt vẫn DISABLED** vì chưa có xác nhận khách. Sau đó trong *test fixture only* cho phép ghi vào file read-only và cố tình làm thay đổi bytes → backend trả 409, chính hai trình duyệt đều chỉ hiện `preview-unavailable`, **0 ảnh được báo tin cậy**, approval vẫn disabled. Kiểm tra DB không có xác nhận khách, approval, print-job hay delivery mới. Bằng chứng này là preview **PNG tổng hợp có hash được neo vào DB để kiểm tương tác HTTP/UI**, không giả báo là AI3 đã render file đó; AI3 render thực tế đã được thử trong ca PG tài liệu riêng.

**Bước tiếp theo AI4**: cherry-pick/đồng bộ đúng patch trên `web/**` trong nhánh AI4 và bổ sung test lỗi session/async đổi revision/hủy object URL; đọc `docs/architecture/CODE006_BAN_GIAO.md`. **AI5**: cập nhật ma trận theo SHA tích hợp, phân biệt browser product PostgreSQL synthetic PASS và OA thật/iPhone thật/Ricoh thật/TN-037 vẫn NOT RUN. PR #31 vẫn Draft/partial; **không merge/deploy/gửi khách/in thật**.


## CODE-006 — Thông số từng file chỉ từ AI3 sealed manifest (12/10/2026)

AI0 bổ sung metadata theo file cho trang xem trước, **không suy diễn từ đơn/khách hoặc đếm trang tự tạo**. `backend/composition/preview.ts` chỉ trả `files` trong catalog đã xác thực khi manifest `ai3.document_bridge.v1` được neo hash SHA-256 trong PostgreSQL và chứa `files` + `paper_plan` khớp hoàn toàn. Với mỗi file: kiểm tra source-ref riêng (không trả cho client), SHA file nguồn bất biến, byte length, `file_sha256` khớp cả record AI3 và `paper_plan`, số trang/mặt/tờ, cấu hình bản sao/khổ/in hai mặt/hướng giấy, tổng số trang/mặt/tờ đúng `manifest.counts` và đúng `core_revisions.plan` hiện hành. Không có chứng cứ đủ thì HTTP 409, không trả số liệu. Manifest legacy chỉ có raster vẫn xem trước nhưng **không** công bố `files` giả. Tên hiển thị `Tài liệu 1…`, không lộ đường dẫn, SHA hay tên file riêng tư.

Bản vá tích hợp tạm phía `web/**` (AI4 là chủ module): thêm `VerifiedFileFact` ở `web/src/domain.ts`, `HttpPrintPort.loadVerifiedPreviewPages` trả `{pages,files}` sau khi kiểm catalog theo phiên bản và token, `VerifiedPreviewGallery` chỉ hiển thị số trang gốc, mặt in, tờ giấy, bản sao, A3/A4, đơn/hai mặt, dọc/ngang **sau khi** mọi ảnh được nhận và xác minh; ảnh/hash lỗi thì không còn cả ảnh hoặc các chỉ số. Responsive desktop/mobile, không đụng `hasValidApprovalInputs` hoặc trạng thái xác nhận của khách. Thông số AI3 *không* phải xác nhận khách, duyệt in, hoặc bằng chứng giấy in thật.

Bằng chứng:
- Test PostgreSQL thật `tests/integration/composition/inbound-draft-pg.test.mjs` chạy AI3 xử lý PNG tổng hợp, publish plan revision 2 rồi kiểm **1 file** = 1 trang/2 mặt/2 tờ, 2 bản A4 một mặt dọc; làm hỏng source snapshot -> `DOCUMENT_SOURCE_CHANGED`, phục hồi nguồn -> 200; làm hỏng raster -> 409 `PREVIEW_BYTES_CHANGED`. Nhận dữ liệu từ mã AI3 thực chạy, không mock manifest.
- Browser Chrome headless tại `scripts/browser-product.*`: dữ liệu tách biệt **synthetic** có manifest/hash neo PG, desktop 1440×900 và mobile 390×844 đều hiển thị ảnh `blob:` + đầy đủ trường per-file; sau khi làm hỏng raster thì không còn ảnh/metadata, nút duyệt vẫn bị khóa do thiếu xác nhận khách. Đây là UI kiểm thử bằng manifest thử, không tự nhận là tác vụ AI3 render.
- Code SHA `5d664421aefe4782ac603ca1cb4c1261b75db635` `postgres` và `product-browser` job push SUCCESS và CODE checks push SUCCESS; CI push+PR kiểm lại đúng HEAD tài liệu. AI0 composition **19/19 PASS**, AI3 Python **140 PASS/1 SKIP**, AI5 integration **58 PASS/19 SKIP**, HTTP **43 PASS/41 SKIP**. [PG run](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38211411173/job/114686195161) · [Chromium run](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38211411173/job/114686194874).

Hạn chế còn mở: không hiển thị tên file gốc khi chưa có hợp đồng nguồn tin cậy; test UI chưa đại diện cho Zalo OA thật/Windows/Ricoh/iPhone phần cứng, TN-037 chưa nghiệm thu. Không merge/deploy/in thật; PR giữ Draft.
