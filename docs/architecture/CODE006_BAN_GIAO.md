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
