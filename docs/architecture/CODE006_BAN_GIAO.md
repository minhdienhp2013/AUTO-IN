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
- AI0 + AI2: nối raw webhook, transaction, trusted OA/shop và Port đơn/tài liệu. /webhooks/zalo hiện 503 rõ ràng; không dựng receipt giả hoặc bật worker chưa nối.
- AI2: xử lý 6 lỗi stricter TS ở batch.ts:44, processor.ts:28, schedule.ts:27, postgres-durable.ts:35,141. Strict cơ bản PASS.
- AI4: lockfile/npm ci và UI live; AI5: PG/HTTP/DryRun/browser thực. Bộ test hiện không thay TN-037.

## Xác minh CI và processor sau commit đầu

GitHub Actions cho SHA 6d9bdf6882bdc8d3d557978b0e71e7785402fdbd: CODE checks và Simulation integration đều SUCCESS. Simulation integration chạy PostgreSQL 18.3 thật: contracts 18 PASS; AI1 13 PASS/0 SKIP, AI2 32 PASS/0 SKIP, composition 5 PASS/0 SKIP; Python AI3 95 PASS/1 SKIP. AI5 20/20 ca PG/DryRun sản phẩm PASS; nhóm runner --integration 50 PASS/0 FAIL/19 SKIP (19 ca legacy/chưa nối). HTTP readiness và 5 ca từ chối truy cập không xác thực PASS; runner --http vẫn có ca khác SKIP. Đây là bằng chứng core/PG/DryRun service và CLI processor, chưa phải luồng từ giao diện hay webhook.

AI0 tiếp tục thêm `backend/composition/processor.ts`: gọi subprocess AI3 bằng JSON, giới hạn 256 KiB, timeout và stdout, kiểm manifest/hash, giữ snapshot nguồn trong artifact root. `npm run process:order -- <shop_id> <order_uuid>` là CLI nội bộ; cần DATABASE_URL, AUTOIN_INPUT_ROOT, AUTOIN_ARTIFACT_ROOT, AUTOIN_PROCESSOR_ID, Python có PyMuPDF/Pillow. Lấy request_data/hash của revision hiện hành trong PostgreSQL, chỉ cho shop simulation rồi gọi AI1 publishVerifiedPlan. AI1 tăng revision, yêu cầu xác nhận/duyệt lại. Không đi qua HTTP công khai, không gửi máy in. Nên sử dụng trên DB test và file synthetic cho tới khi có endpoint upload/preview được xác thực. Không gán `preview_verified=true` vì preview chưa có route phục vụ theo quyền.

Ca `tests/integration/composition/processor-pg.test.mjs` kiểm riêng đường processor → AI1 trên PostgreSQL thật: tạo ảnh/đơn tổng hợp, gọi CLI nội bộ, xác nhận revision mới và snapshot SHA giữ nguyên sau khi file inbound thay đổi. Khi thiếu TEST_DATABASE_URL ca này SKIP rõ ràng. Ca HTTP/PG AI5 vẫn không phải đường upload/processor trên web; trạng thái processor_configured trên /health tiếp tục false cho đến khi có route theo quyền và artifact resolver.
