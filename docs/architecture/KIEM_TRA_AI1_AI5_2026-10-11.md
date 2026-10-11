# Kiểm tra bàn giao AI1–AI5 — 11/10/2026

Kiểm từ mã GitHub thực tế, checkout riêng từng HEAD; không dựa vào lời báo DONE. Không thay file của AI khác, không merge/deploy. Đặc tả TN vẫn là nguồn nghiệp vụ. Đây là kiểm tra phạm vi code/test ban đầu, chưa chứng minh đầu-cuối hoặc TN-037.

| AI | HEAD / PR | Kết quả chạy lại | Kết luận |
| --- | --- | --- | --- |
| AI1 | fc0ca144a9ea4fa4092c9e1de5109d690505aacd / #7 draft | tsc PASS; 7 pass, 1 PostgreSQL integration skip | Chưa đạt điều kiện CODE-101 transaction/concurrency PostgreSQL thật |
| AI2 | ccf5e6e1bb97fb1ca8c70a4b2d1c6ad22d59e682 / #5 draft | 13 pass, 1 file test fail SyntaxError | Cần sửa DeepSeek test, chạy đủ suite |
| AI3 | 72647b4e8d489c506f8814ac7565116d0d1a16df / #2 draft | 47/47 pytest PASS với PyMuPDF1.26.7/Pillow12.3.0/Python3.12.14 | Module Linux + mô phỏng đạt; chưa Windows/Ricoh thật |
| AI4 | fde9cdccb6aad888fada378567590f8f325ab635 / #6 draft | 23/23 test PASS; build FAIL TS2559 | Chưa đạt build giao diện |
| AI5 | 2038863949e8366e9e6742472d4992f2cf224601 / #4 draft | 19 pass, 19 skip | Self-test tốt; product acceptance chưa chạy |

PR #3 của AI1 đã được merge vào nhánh tài liệu bởi phiên khác trước lượt kiểm tra này; main vẫn README, PR #1 chưa merge. AI0 không thực hiện merge. AI1 hardening PR #7 mới hơn phần đã merge, do đó đánh giá #7 HEAD.

## Lỗi tái hiện và việc cần giao đúng chủ file

1. **AI2 / CODE-102 / P1:** `tests/unit/zalo/deepseek.test.mjs:10–11` đóng `fetchMock` thừa `};`, Node báo `SyntaxError: missing ) after argument list` dòng11. Lệnh `node --experimental-strip-types --test tests/unit/zalo/*.test.mjs` trả exit1. Cần AI2 sửa test trong namespace của mình và chạy đủ suite; 34 smoke check V8 trước đó không chứng minh file test hiện tại hợp lệ.
2. **AI4 / CODE-104 / P1:** `web/src/api.ts:17`, default `import.meta.env` không có property chung với `{VITE_DEMO_MODE?:string}`; `web/tsconfig.json` chỉ nạp vite/client, chưa khai báo env custom. Lệnh `cd web; npm install --ignore-scripts --package-lock=false; npm test; npm run build` đạt23test nhưng build dừngTS2559. AI4 khai báo ImportMetaEnv đúng, tạo lockfile riêng trong web và chạy lại typecheck/build. AI0 chỉ cài deps tại checkout review, không commit web/package/config.
3. **AI1 / CODE-101 / P0 chưa kiểm chứng:** tests/integration/core/postgres.test.cjs còn skip khi không có `pg` + TEST_DATABASE_URL. AI0 đã compile module riêng bằng TypeScript5.9.3 và chạy 7 unit test. Đã thử lấy PostgreSQL18.4 binary từ package npm riêng cho review; binary chạy được nhưng môi trường từ chối đổi ownership sang user khác (`chown: Invalid argument`), không khởi tạo server PostgreSQL bằng root. Không dùng DB giả hoặc PGlite để báo đạt. Cần chạy migration001/002 và suite ở DB test thật, giữ hai connection độc lập.
4. **AI1 / P1 read model:** `backend/core/service.ts:getOrder` chưa trả confirmations, preview và conversation generation; AI4 có chủ động khóa duyệt/tiếp quản khi thiếu. Cần mapper/read model đủ dữ kiện xác minh hiện tại; không bật nút bằng fixture hoặc cờ client.
5. **AI1 / P1 hàng đợi TN-007:** `claim` sắp theo `j.created_at,j.id` (lúc duyệt), trong khi đặc tả yêu cầu thời điểm khách hoàn tất xác nhận. Hai đơn xác nhận A trước B nhưng nhân viên duyệt B trước A sẽ bị đảo. Cần AI1 chốt/thêm ordering theo confirmation hiệu lực và test tình huống này trên PostgreSQL.
6. **AI5 / CODE-105:** thiếu `createAcceptanceAdapter` product-backed nối AI1+AI3, PostgreSQL và DryRunDriver. Lệnh selftest exit0 có 19 skip không chứng minh P0 đạt. Các ca HTTP/browser cũng chưa được chạy ở lượt này. Giữ release gate fail closed.

## Điểm nối chung AI0 phải làm tiếp

Các module đã viết trước schema scaffold. Body/response/actor/lease của AI1 hiện khác contract khung; AI3/AI4 đã bám AI1. Xem bảng mapping trong CODE000_BAN_GIAO.md. Chốt một wire tại CODE-006 rồi cập nhật mapper/consumer cùng test HTTP; không mount route trùng. Auth customer/agent/processor vẫn cần resolver thật; không đưa principal test vào runtime.

AI2 có Port/gate/migration events nhưng durable queue, outbound gate và takeover liên AI1 chưa nối. OA verifier live hiện fail closed. AI3 Word và Excel chưa có đường in tin cậy nên NEEDS_HUMAN; đây là giới hạn được ghi rõ. Driver thật bị chặn. Tất cả OA/Ricoh/iPhone và 100đơn/ngày,210đơn/7ngày chưa kiểm chứng.

## Lệnh tái hiện

- AI1: compile `backend/core/*.ts backend/api/*.ts backend/storage/*.ts` bằng tsc strict NodeNext ES2023; đặt AI1_BUILD_DIR vào thư mục output backend; `node --test tests/unit/core/safety.test.cjs tests/integration/core/postgres.test.cjs`. Đặt TEST_DATABASE_URL chỉ tới DB test riêng để chạy PG.
- AI2: `node --experimental-strip-types --test tests/unit/zalo/*.test.mjs`.
- AI3: Python venv; `pip install -r workers/documents/requirements.txt pytest==8.4.2`; `python -m pytest -q tests/unit/documents tests/unit/printing`.
- AI4: `cd web`; cài dependency chính xác trong manifest; `npm test`; `npm run build`.
- AI5: `node tests/acceptance/run.mjs` (self-test); `--integration` cần adapter + AUTOIN_TEST_DATABASE_URL, không dùng mock.

Kết luận: đủ5bàn giao code trên GitHub, chưa đủ điều kiện nói cả5đã hoàn tất. Sửa2lỗi đang FAIL, chạy PG thật và nối hợp đồng trước kiểm tra đầu-cuối. Không mở vận hành thật.


## Kiểm tra AI4 CODE-204 — cập nhật 11/10/2026

HEAD kiểm: 7e6623a995a67f756d30be48f2a4be9ac06691f8, Draft PR #12. AI0 checkout riêng, cài đúng manifest bằng npm install --ignore-scripts --package-lock=false; không sửa file AI4.

- npm test: 30/30 PASS.
- npm run typecheck: FAIL TS2416 tại web/src/api.ts:202 và TS2322 tại dòng306.
- npm run build: FAIL cùng lỗi; chưa tới Vite bundling.
- ImportMetaEnv cũ đã được sửa. Lỗi mới: HttpPrintPort.mutate suy ra conversation_state là string ở nhánh handover/return-to-ai, không khớp ConversationState của OrderView.
- AI4 cần khai báo kiểu trả về Promise<OrderView> cho HttpPrintPort.mutate hoặc tạo kết quả có kiểu OrderView, giữ literal staff/ai; không dùng any để giấu lỗi. Chạy lại test/typecheck/build và commit web/package-lock.json thật trong môi trường truy cập npm.
- HEAD vẫn chưa có web/package-lock.json. Backend read model/HTTP, browser/iPhone/Push vẫn chưa kiểm chứng. CODE-204 chưa đạt điều kiện DONE/build; không merge/deploy.


## Kiểm tra AI1 CODE-201 — cập nhật 11/10/2026

HEAD ebdd740d87b3bb72fd7f1229b2ab2e728f55f0bc, Draft PR #11. AI0 checkout riêng và compile core/api/storage bằng TypeScript5.9.3 strict NodeNext ES2023: PASS. Không sửa namespace AI1.

Chạy AI1_BUILD_DIR trỏ output backend, NODE_PATH trỏ dependency pg đã khóa, node --test tests/unit/core/safety.test.cjs tests/integration/core/postgres.test.cjs: 8 PASS, 1 PostgreSQL integration SKIP do chưa có TEST_DATABASE_URL/server test thật. Skip không là PASS; CODE-201 còn thiếu gate PG.

Đã đối chiếu code: claim dùng confirmed_at hiệu lực; migration003/004; giấy kiểm chứng một phần giữ UNKNOWN/missing_sheets; getOrder bổ sung current/print_progress/conversation_control; handover/return generation và scoped printer principal. Đây là kiểm tra mã và unit-test, chưa chứng minh SQL transaction thực.

AI4 cần đọc read model nested thực tế current.request_confirmation/price_confirmation/verified_plan/preview_ref, print_progress và conversation_control.generation/status. Mapper 7e6623a vẫn chưa đọc các trường này nên thao tác live tiếp tục khóa an toàn. Không mở bằng hardcode, cập nhật test contract trên fixture đúng response AI1 ebdd740.

Việc tiếp theo: AI0 đồng bộ schemas/mapper/composition theo wire AI1; AI5 chạy migration001–004 và integration PG thật trên DB test, cùng hai connection độc lập. Không merge/deploy/in thật hoặc báo CODE-201 DONE trước khi PG gate đạt.


## Kiểm tra bàn giao AI2/AI3/AI5 đợt 2 và AI4 sửa build

AI0 kiểm tra checkout thật ngày 2026-10-11; không merge/deploy hoặc gửi lệnh in thật.

| AI | SHA | Kết quả chạy lại |
| --- | --- | --- |
| AI2 CODE-202 | 9b431352de19a7f9ad5f7814e200ecbc6ca5bf0e | Node 24: 25 PASS, 0 FAIL, 1 SKIP PostgreSQL |
| AI3 CODE-203 | 31e73ea2607f25d521561a6c3fe9fda733900db5 | Python 3.12: 70 PASS; compileall PASS |
| AI5 CODE-205 | 5707b81128e7e84180db57865896d52d256dac33 | Runner: 23 PASS, 0 FAIL, 36 SKIP |
| AI4 CODE-204 sửa tiếp | 694179c (origin/ai4/dot2-web-build-readmodel) | typecheck PASS, Vite build PASS, 30 unit PASS |

Lệnh AI2: node --experimental-strip-types --test tests/unit/zalo/*.test.mjs.
TypeScript PASS: strict NodeNext noEmit với allowImportingTsExtensions kiểm tra postgres-durable.ts, durable-worker.ts và core-gate.ts; chưa phải build module tích hợp.

Lệnh AI3: python -m pytest -q tests/unit/documents tests/unit/printing; python -m compileall -q agents workers tests/unit/documents tests/unit/printing.
Các ca HTTP backend simulation của AI3 dùng mock; 70 PASS không chứng minh luồng Fastify/PostgreSQL thực, Windows/Ricoh hoặc giấy thật.

Lệnh AI5: node tests/acceptance/run.mjs. 23 PASS thuộc fixtures, guards, metrics và release-gate selftests. 17 ca CODE-205 PG/DryRun sản phẩm và 19 ca legacy vẫn SKIP; HTTP/browser NOT RUN. Không được tính 23 PASS là nghiệm thu sản phẩm.

AI4 chạy với dependencies đúng manifest đã cài ở worktree review trước, liên kết node_modules để kiểm tra SHA mới; không phải npm ci mới. Lỗi ConversationState/Promise<OrderView> đã hết. package-lock và mapper read model AI1 nested vẫn cần hoàn thiện trước nghiệm thu tích hợp.

PostgreSQL thật chưa chạy: chưa có DB test hợp lệ hoạt động trong môi trường này. CODE-006 composition của AI0 và kiểm thử luồng liên module vẫn chưa hoàn thành. Bàn giao các module đủ để bắt đầu tích hợp simulation, chưa đủ để nghiệm thu hoặc mở in thật.
