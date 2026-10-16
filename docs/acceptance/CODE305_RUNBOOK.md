# CODE-305 — chạy bộ test nghiệm thu sau khi AI0 cấp SHA tích hợp

Ngày lập: 2026-10-11. Module BASE `5707b81128e7e84180db57865896d52d256dac33`. Tài liệu đợt 3: `7066849be67dabd992cda08209584e7c861b47ca`. Mã AI1 kiểm: `ebdd740d87b3bb72fd7f1229b2ab2e728f55f0bc`. Bridge AI3 kiểm: `31e73ea2607f25d521561a6c3fe9fda733900db5`.

**BLOCKED:** AI0 chưa cấp SHA `ai0/tich-hop-simulation-v1`/CODE-006 nên không có checkout chính thức kết hợp AI1–AI4. Không sử dụng sức khỏe scaffold, HTTP 401 khi auth chưa nối, mock/fixture hoặc nhãn product-backed tự khai để kết luận nghiệm thu.

## Chuẩn bị

1. AI0 cấp SHA tích hợp dài 40 ký tự, build output AI1, migration `001_core.sql`–`004_conversation_generation.sql`, server Fastify localhost simulation, Python AI3 agent, web AI4. Không đưa mã sản phẩm vào nhánh AI5.
2. Tạo **PostgreSQL thật** trên localhost, DB riêng tên `autoin_test...` (không dùng dữ liệu cửa hàng); đã khóa root dependencies và các biến cấu hình server simulation.
3. Chạy kiểm tra độc lập không cần DB:

```sh
node tests/acceptance/run.mjs
```

Các ca `PG-01`–`PG-20` (trừ PG-12/18 là DryRun) thuộc nhóm **NOT RUN** khi không có `--integration`. Test legacy CODE-105 vẫn SKIP riêng.

## Chạy tích hợp trên checkout do AI0 cung cấp

```sh
# Giá trị thật do AI0 bàn giao; đừng dùng SHA của prompt/scaffold/AI5.
export AUTOIN_INTEGRATION_SHA=<40-character-CODE006-SHA>
export AUTOIN_OPERATION_MODE=simulation

# Node dependencies và AI1 modules phải được build thành công trước.
npm ci
npm run build

# 18 PG transaction/gate và 2 DryRun-journal scenarios, dùng AI1 service + pg thật.
AUTOIN_TEST_DATABASE_URL=postgresql://localhost/autoin_test_305 \
AUTOIN_ALLOW_PG_ACCEPTANCE=YES_ISOLATED_TEST_DB \
node tests/acceptance/run.mjs --integration

# Chỉ xác minh HTTP local server đã gắn auth/operations.
AUTOIN_API_URL=http://127.0.0.1:3000 AUTOIN_ACCEPTANCE_HTTP_SCOPE=local-simulation \
node tests/acceptance/run.mjs --http

# Chỉ khi AI2 webhook ingress đã được cấu hình an toàn tại server simulation.
AUTOIN_API_URL=http://127.0.0.1:3000 AUTOIN_ACCEPTANCE_HTTP_SCOPE=local-simulation \
AUTOIN_TEST_WEBHOOK_REJECTION=1 node tests/acceptance/run.mjs --http

# Browser demo local; cần Playwright được AI0/AI4 cài và web build đạt.
AUTOIN_WEB_URL=http://127.0.0.1:5173 AUTOIN_ACCEPTANCE_HTTP_SCOPE=local-simulation \
AUTOIN_EXPECT_DEMO=1 node tests/acceptance/run.mjs --browser
```

Nếu build AI1 không nằm tại `dist/backend`, đặt `AI1_BUILD_DIR` trỏ đến thư mục **backend đã biên dịch từ đúng SHA tích hợp**. Chỉ kết nối `autoin_test...` trên localhost; URL PG chứa query/fragment bị từ chối để tránh override host. Không mở đường in thật hoặc Zalo OA thật. Code Python chỉ import `Journal`/`DryRunDriver`, không dùng driver Windows.

## Phân biệt bằng chứng

- **PASS/FAIL/SKIP selftest:** chỉ bảo vệ fixture, tỷ lệ, chứng cứ và runner. Không báo là kết quả API/PostgreSQL thật.
- **PASS/FAIL/SKIP product:** ghi từng test PG, DryRun, HTTP, browser; chỉ xét nghiệm thu khi 0 SKIP trong nhóm yêu cầu.
- **SHA:** ghi đầy đủ module SHA, `AUTOIN_INTEGRATION_SHA`, `pg_backend_pid` hai connection, health.mode simulation, `DryRunDriver` và ảnh UI Chromium (không tương đương iPhone thật).
- **TN-037:** chưa kiểm OA, Ricoh, iPhone thật, tải 100/ngày, 210 đơn/7 ngày. `release-gate.mjs` luôn fail-closed khi thiếu các bằng chứng đó.

Lỗi PostgreSQL/transaction/ledger/confirmation queue/generation -> **AI1**; Zalo verification/queued outbound -> **AI2**; journal/artifact/DryRun -> **AI3**; browser/mapper -> **AI4**; Fastify composition/schema/dependency/migrations -> **AI0**. Kèm test ID, integration SHA, lệnh chạy, expected/actual, bằng chứng không chứa token/thông tin khách.

## Trạng thái ở thời điểm bàn giao

Selftest chốt SHA riêng (`integration-preflight.test.mjs`) đã chạy cục bộ: 4 PASS / 0 FAIL. Toàn bộ product PG/HTTP/DryRun/browser CODE-305: **NOT RUN/BLOCKED vì thiếu SHA tích hợp và PostgreSQL/server thực**. Không báo số PASS sản phẩm hoặc in thử.

## Sau khi có SHA 15c1ac7

Đã có [bằng chứng CI push trực tiếp HEAD](CODE305_SHA_15c1ac7_EVIDENCE.md) cho PostgreSQL, DryRun, HTTP auth và webhook synthetic. Người kiểm thử mới chạy trên SHA khác phải đặt AUTOIN_INTEGRATION_SHA bằng SHA CODE-006 mới và chạy lại nhóm sản phẩm, không chép kết quả cũ. Trong run.mjs AI5 đã bổ sung một ca synthetic webhook thật sự gọi composition test với PostgreSQL test rồi bắt buộc 1 PASS/0 FAIL/0 SKIP; ca này CHƯA được CI chạy trên SHA 15c1ac7 vì thay đổi AI5 tạo sau SHA đó. Browser yêu cầu AI4 package-lock.json và web/dist/index.html, thiếu sẽ báo BLOCKED exit2; không coi unit tests web là browser E2E. HTTP-ZALO-01 vẫn SKIP trên default server không gắn ingress; synthetic test dùng app.inject với provider thử riêng, không phải OA live.

## CODE-305 — SHA mới và kịch bản HTTPS agent (cập nhật 2026-10-12)

Đọc [báo cáo bằng chứng SHA `d3e53461`](CODE305_SHA_D3E53461_EVIDENCE.md). Bằng chứng PASS PostgreSQL/DryRun/HTTP chỉ tính cho `d3e53461a5cc71d0b96b24b069b5240ca9dcd71e` (push CI), không dùng lại từ SHA trước.

**Browser:** AI4 phải tạo lockfile thật từ npm (`web/package-lock.json`), `cd web && npm ci && npm run build`, chạy server Vite localhost và Playwright. Lệnh `node tests/acceptance/run.mjs --browser` sau đó kiểm **desktop 1440×900** và **mobile 390×844**, mode an toàn và không tràn ngang; `AUTOIN_EXPECT_ANONYMOUS=1` để kiểm quyền khách chưa login. Nếu không có lock/build, runner trả BLOCKED exit2; không coi demo/unit test là browser PASS.

**HTTPS agent fixture do AI0 cấp (chưa có, hiện NOT RUN):** cần PostgreSQL test localhost, server HTTPS localhost với TLS đáng tin cậy (không `--insecure`), token print_agent scoped và file JSON fixture **riêng cho mỗi scenario** (chmod 600, đặt bên ngoài Git). Ví dụ file synthetic không chứa secret:
```json
{
  "scenario": "cli",
  "job_id": "12345678-1234-1234-1234-123456789abc",
  "order_id": "87654321-1234-1234-1234-abcdef123456",
  "shop_id": "autoin-test-305",
  "printer_id": "RMP7000",
  "integration_sha": "d3e53461a5cc71d0b96b24b069b5240ca9dcd71e"
}
```
Các UUID trên chỉ là ví dụ, không phải job có thật. **Không gửi/chia sẻ token hoặc chứng thư riêng trong repo.** Mỗi scenario lấy job/order UUID mới và riêng biệt trong PG; ghi file `AUTOIN_CODE305_USED_JOB_LEDGER` ngoài Git, mode 0600, để không tái dùng dù ACK mơ hồ. Trước khi gọi agent, AI5 tự truy vấn DB xác minh job **NOT_SENT**, chưa claim, không khóa/đóng, shop ở simulation, có xác nhận khách + approval đúng revision/hash, **chỉ một job eligible trong shop**. Nếu sai: BLOCKED, không gọi agent.

```sh
export AUTOIN_INTEGRATION_SHA=d3e53461a5cc71d0b96b24b069b5240ca9dcd71e  # thay bằng SHA mới nếu AI0 bàn giao
export AUTOIN_OPERATION_MODE=simulation
export AUTOIN_ALLOW_PG_ACCEPTANCE=YES_ISOLATED_TEST_DB
export AUTOIN_TEST_DATABASE_URL=postgresql://localhost/autoin_test_305
export TEST_DATABASE_URL="$AUTOIN_TEST_DATABASE_URL"
export AUTOIN_CODE303_HTTPS_URL=https://127.0.0.1:3443/
export SSL_CERT_FILE=/ngoai-git/cert/trusted-synthetic-test-ca.pem
export AUTOIN_CODE303_AGENT_TOKEN='TOKEN_TEST_SCOPE_DO_AI0_CAP_KHONG_COMMIT'
export AUTOIN_CODE305_USED_JOB_LEDGER=/ngoai-git/job-ledger-305.jsonl
export AUTOIN_CODE305_HTTPS_FIXTURE=/ngoai-git/fixture-cli-fresh.json
export AUTOIN_CODE305_SCENARIO=cli
export AUTOIN_CODE305_RUN_HTTPS_AGENT=YES_SIMULATION_ONLY
node tests/acceptance/https-agent-run.mjs --execute
```

Chạy **từng scenario với fixture/job MỚI**; tám tên hợp lệ: `normal`, `cli`, `lost_mark_ack`, `lost_report_ack`, `before_mark_sending`, `after_mark_sending`, `after_journal_before_driver`, `after_driver`. Harness gọi trực tiếp bài kiểm tra AI3 `tests/unit/printing/test_product_backend_optin.py`, chỉ chấp nhận `1 passed/0 failed/0 skipped`, không dùng driver in thật. Log không chứa token; lỗi phải gửi AI3/AI0 kèm SHA và scenario, không đăng token, ảnh, nội dung khách.

**Selftests AI5:** `node --test tests/acceptance/https-agent-fixture.test.mjs` để kiểm guard trước khi cấp fixture. Chỉ selftest mới có thể chạy độc lập; không được ghi HTTPS CLI PASS nếu chưa có fixture thật. Các ca mới này chưa có CI trên tích hợp `d3e53461a5cc71d0b96b24b069b5240ca9dcd71e`, nên AI0 phải đưa vào SHA tích hợp tiếp theo và chạy lại.

**Phân công:** AI0 cấp SHA tích hợp + HTTPS fixture/CI, AI3 xác minh logic HTTPS/ACK/restart, AI4 cung cấp npm lock/build/browser. AI5 chỉ nghiệm thu và báo lỗi. Giữ **TN-037 BLOCKED** cho đến khi đủ toàn bộ điều kiện thực tế.

## Recheck 2026-10-12

SHA PR #25 mới nhất vẫn `d3e53461a5cc71d0b96b24b069b5240ca9dcd71e`. Chỉ đối chiếu CI **push** run #38165256655 và #38165256659 đúng SHA. Nếu AI0 cấp commit mới phải xác minh run **push của SHA mới**; không kế thừa số đếm PASS. AI4 HEAD `dbf4986` thiếu web/package-lock.json nên Playwright desktop/mobile **NOT RUN**. HTTPS agent cần fixture DB test, TLS, token scoped và job đã duyệt riêng cho từng scenario; chưa có nên **NOT RUN**. AI3 1 SKIP và các runner 19/40 SKIP phải báo riêng. TN-037 tiếp tục **BLOCKED**.

## CODE-405 — runbook kiểm chính xác AI0 SHA

Đọc [báo cáo CODE405](CODE405_NGHIEM_THU_20261012.md) và [phân công CODE007](../architecture/CODE007_PHAN_CONG_20261012.md). Mặc định tất cả test CODE405 mới có cổng. **Không chạy trên AI5 branch bằng cách giả mạo AUTOIN_INTEGRATION_SHA**. Checkout CODE-006 AI0 immutable SHA mới đã nhận các file AI5; `git rev-parse HEAD` phải khớp `AUTOIN_INTEGRATION_SHA`. Máy chỉ dùng PostgreSQL localhost tên `autoin_test*` và DryRunDriver.

```sh
# Checkout đúng SHA AI0 đã tích hợp CODE-405, không lấy SHA lịch sử
git rev-parse HEAD
export AUTOIN_INTEGRATION_SHA=$(git rev-parse HEAD)
export AUTOIN_OPERATION_MODE=simulation
export AUTOIN_TEST_DATABASE_URL=postgresql://auto_in:ISOLATED_TEST_ONLY@127.0.0.1:5432/autoin_test_405
export TEST_DATABASE_URL="$AUTOIN_TEST_DATABASE_URL"
export AUTOIN_ALLOW_PG_ACCEPTANCE=YES_ISOLATED_TEST_DB
npm ci && npm run db:migrate && npm run build
# Chỉ chạy test mới + selftest cũ; wrapper subprocess chứng minh chính checkout
node tests/acceptance/run.mjs --integration

# AI4 phải có web/package-lock.json thật; build web không demo
(cd web && npm ci && VITE_DEMO_MODE=false npm run build)
# Python/Chromium Playwright được cài trong isolated CI
node tests/acceptance/run.mjs --browser-product
```

Các test `C405-PG-*` dùng test-only credential Principal từ fixture/DB, **không phải** customer đã xác thực qua webhook. Các wrapper `C405-*` spawn chính test sản phẩm AI0 đã có, yêu cầu **1 PASS / 0 FAIL / 0 SKIP** mỗi bài. Nếu chưa có customer event verification Port chính thức từ CODE-401/402: ghi **NOT RUN** phần OA→customer-confirm; không tự giả Principal Zalo. Browser product script chỉ phục vụ localhost/PG isolated, xác minh tamper, không in thật.

**Hiện tại** 3 self-test provenance PASS cục bộ; test mới PG/browser/HTTP sản phẩm **NOT RUN** vì AI0 chưa nhập test CODE405 vào SHA mới. Vẫn có bằng chứng CI hiện có trên SHA `e16f69ace72f41b82bd7438cc97b0c275fc57f64` tại PR #31 cho PostgreSQL/Chromium trước CODE-405. Chuyển lỗi về đúng AI1/AI2/AI3/AI4/AI0; tuyệt đối không merge/deploy.

## CODE-405 — latest integration HEAD recheck

PR #31 đã chuyển sang `fb4af186d62adc3d91848f1306576f07cf35f4ee`. CODE checks PUSH [38213694609](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38213694609) và Simulation integration PUSH [38213694522](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38213694522) đều SUCCESS. PG composition **20/20 PASS** gồm signed synthetic `OK` candidate **không** ghi customer confirmation, AI3 140 PASS/1 SKIP, AI5 hiện hữu 58 PASS/19 SKIP integration và 43 PASS/41 SKIP HTTP; Chromium product PASS desktop/mobile. **Đây là kết quả CI trước khi test AI5 CODE-405 mới được nhập.**

Trong nhóm wrapper CODE-405 mới phải chạy `confirmation-candidate-pg.test.mjs` cùng signed wrong OA, artifact, lost-ACK reconcile, preview tamper và HTTPS agent. Mọi wrapper chưa chạy đúng SHA tích hợp có file AI5 phải báo **NOT RUN**. Không bao giờ đổi `candidate_requires_credential` thành xác nhận khách. Từ chối mọi cách giả identity, OA thật hay driver Ricoh thật.

## CODE-405 — nghiệm thu 7 lỗi đã sửa bởi AI0, SHA `823237342dd9b6d0c1db5430e72b311d197056d9`

Patch đã được chuyển nguyên blob vào AI5, chi tiết tại [CODE405_NGHIEM_THU_20261012.md](CODE405_NGHIEM_THU_20261012.md). Với subprocess test, bắt buộc `--test-reporter=tap`, **xóa `NODE_TEST_CONTEXT`** khỏi môi trường child; xác minh cả 6 trường TAP, >0 bài thực thi, toàn bộ PASS và không có FAIL/SKIP/cancelled/TODO; không chấp nhận exit code 0 đơn độc. Lệnh selftest đã chạy: `node --test tests/acceptance/code405-subprocess-evidence.test.mjs tests/acceptance/code405-exact-sha.test.mjs` (11 PASS/0 FAIL/0 SKIP trên đúng GitHub blobs). CI AI0 push đúng SHA `823237342dd9b6d0c1db5430e72b311d197056d9` đã chạy real PostgreSQL + HTTP + DryRun + Chromium 1440×900/390×844 (lượt `--integration` 80 PASS/19 SKIP, `--http` 54 PASS/52 SKIP, AI3 Python 167 PASS/1 SKIP). Test nào SKIP không tính là PASS. **AI0 phải tiếp nhận HEAD AI5 mới và chạy CI tích hợp đúng SHA tiếp theo** trước khi kết luận nghiệm thu lại. OA/Ricoh thật, iPhone thật và TN-037 NOT RUN/BLOCKED.

## CODE-008 — 13/10/2026: đường đi bắt buộc để nghiệm thu append thật

**KHÔNG** đổi `C008-PG-02` sang `propose()`/direct append/manual, cũng không fake Principal Zalo. Trên staging `0730cbd14f5386a431f74593ba0e4e49c8518490` đã chạy **PASS** bằng `createSyntheticZaloRuntime` (real AI2 durable worker + AI1 `apply_incoming_batch`) với PNG fixture được register qua Fastify staff session và xác minh bởi AI3 Python. CI push [simulation](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38283185321) 91 PASS/0 FAIL/19 SKIP integration; HTTP 54 PASS/0 FAIL/63 SKIP; Chromium desktop/mobile PASS. SHA nền AI0 `faa0668c326393cc6a49cfa74fe682a606aeddb1`, staging thêm duy nhất file test AI5. AI0 phải nhập test vào SHA tích hợp tiếp theo rồi chạy lại **push exact SHA**; không dùng CI staging để thay thế nghiệm thu trên PR31 mới. Zalo OA thật/Ricoh/iPhone/TN-037 **NOT RUN**.

## AI5 13/10/2026 — pending_updates Chromium E2E opt-in

Phiên kiểm bản AI0 `9fb2bf1bcd1ca9d59b912adf60d7fb8f3cabca54`: CI integration [#38362911714](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38362911714) PASS nhưng chưa test per-status Chromium. AI5 mới có `code008-pending-chromium.mjs`, `code008-pending-chromium.py` và `code008-pending-chromium.test.mjs`, chạy 7 synthetic read-model status/scopes qua React compiled + Fastify + PG staff session trên Chromium 1440×900 và 390×844, 14 scenario assertions. **NOT RUN** đến khi có lệnh chuẩn độc lập. Các file ở `tests/acceptance/**`, không bổ sung endpoint vào production: mock fixture endpoint chỉ khởi động localhost riêng trong harness, các assert không tạo print job.

Điều kiện trước khi chạy: checkout SHA AI0 tích hợp test AI5 mới, `AUTOIN_OPERATION_MODE=simulation`, `AUTOIN_ALLOW_PG_ACCEPTANCE=YES_ISOLATED_TEST_DB`, `AUTOIN_TEST_DATABASE_URL` và `TEST_DATABASE_URL` cùng URL PostgreSQL cô lập, `AUTOIN_INTEGRATION_SHA=$(git rev-parse HEAD)`, web/package-lock.json thật, `cd web && npm ci && VITE_DEMO_MODE=false npm run build`, Python playwright==1.57.0 và Chrome. Sau đó `node tests/acceptance/run.mjs --browser-product`. Điều này chạy cả CODE405 browser product và 14 case CODE008. **Không ghi PASS trước CI thực tế.**

Lỗi **2 RED** khác nhau chỉ thuộc AI4 `web/src/code008.ts`: UI parse processing(0)/needs_human(0) thành unknown; staging [#38364941554](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38364941554) PG/HTTP FAIL đúng 2 test. AI4 PR #47 có bản sửa nhưng AI0 #31 chưa tích hợp. **Không nới assertion**, không sửa web từ AI5. 19 integration SKIP và 63 HTTP SKIP vẫn có, TN-037 thật NOT RUN.

## AI5 Chromium CODE-008 cập nhật 13/10/2026

PR #48 HEAD `816adb5fd7ff24cc98cd5841c95a8d25a523e45d`; patch harness AI5 từ PR #18 đã thử độc lập tại staging `33f793af444045cbc1c15387ec748f00847a21a5`. [CI PUSH #38369695822](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38369695822) PG 98 PASS/19 SKIP, HTTP 61 PASS/63 SKIP, browser 14/14 status×viewport PASS. Nguyên nhân hai lỗi harness: nhầm phần tử `pending-count` với `blocked`, và đọc `pending-count` trước khi async detail GET tải xong. Python in scenario/viewport/step/traceback thật; Node giữ stdout/stderr. Vẫn assert machine-readable state, user-facing warning, exact count, wrong scope/hash fail-closed và approve disabled. Lệnh `node tests/acceptance/run.mjs --browser-product` cần checkout đúng integration SHA chứa patch và web build localhost; test-only synthetic input, tuyệt đối không OA/Ricoh thật. Chi tiết [CODE008_CHROMIUM_PR48_20261013.md](CODE008_CHROMIUM_PR48_20261013.md).

## CODE-402 AI5 — PG challenge candidate 14/10/2026

AI5 PR #18 branch `ai5/dot3-integrated-acceptance`, integrated product SHA `4822958713e6ee1c728babde790f4c7022ac02bc`, staging `646aaa767bd3f37274e48a797ea03488cbbb6c42` chạy real PG [#38445735214](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38445735214). `code402-postback-pg.test.mjs` kiểm nguồn signed synthetic→normalizer→AI0 resolver→AI2 candidate, 0 confirmation/approval/job; `code402-product-regression-pg.test.mjs` thực thi strict TAP 4 product suites (AI2 durable workers, strict normalization, AI1 verified-confirmation/replay, AI0 signed Fastify/PG). Chạy `node tests/acceptance/run.mjs --integration` sau `npm ci && npm run db:migrate && npm run check` với PG `autoin_test*`/local, `AUTOIN_ALLOW_PG_ACCEPTANCE=YES_ISOLATED_TEST_DB`, `AUTOIN_TEST_DATABASE_URL=TEST_DATABASE_URL`, `AUTOIN_INTEGRATION_SHA=$(git rev-parse HEAD)`; AI1 child dùng `AI1_BUILD_DIR=dist/backend` như canonical scripts/run-core.mjs. Kết quả **103 PASS/0 FAIL/19 SKIP**. Không dùng synthetic candidate để báo Zalo customer confirmation thực; TN-037 NOT RUN.

## CODE-401 AI5 mới nhất — 14/10/2026

Chạy độc lập sản phẩm AI0 `1c1b75fd8be7063add12c8510eec9d5d6742df54` với overlay AI5 `f1d334bf90f2506157b12ac7c5a56eefe3267f6b`. Lệnh canonical trong [workflow integration](../../.github/workflows/integration.yml) thực hiện `npm run check` (TypeScript/build) trước `node tests/acceptance/run.mjs --integration` khi `AUTOIN_ALLOW_PG_ACCEPTANCE=YES_ISOLATED_TEST_DB`, `AUTOIN_TEST_DATABASE_URL` và `TEST_DATABASE_URL` trỏ cùng database kiểm thử. Bài `tests/acceptance/code401-independent-port-pg.test.cjs` chỉ import `dist/backend` trong mode integration, browser/HTTP SKIP rõ lý do. AI5 đã kiểm 2 PG pools, falsified `occurred_at` vs trusted PostgreSQL `received_at`, strict postback/2 workers/ACK/revision/approve, không tạo in tự động. Final [CI PUSH #38451399440](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38451399440): PG 104 PASS/19 SKIP, HTTP 62 PASS/68 SKIP, browser 58 PASS/67 SKIP, Chromium 14/14 status PASS. [Báo cáo](CODE401_AI5_INDEPENDENT_1C1B75F_20261014.md). NOT RUN: real OA/Ricoh/iPhone/TN037.

## AI5 CODE-402 current quarantine proof (2026-10-14)
Product `25a99ce2d0ddae673489361d7fceca56c3b60151` + AI5-only overlay `413860824677f35a7211174d8f243f0bbb471685`. CI [integration #38489353875](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38489353875), [CODE checks #38489353886](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38489353886), both SUCCESS. PostgreSQL 109 PASS/0 FAIL/19 SKIP, HTTP 62/0/73, browser 58/0/72, Chromium 14/14 statuses PASS. New `tests/acceptance/code402-official-quarantine-pg.test.mjs` tests current AI0 Fastify raw-body composer / server registry / AI2 verified ingress, not obsolete `createOfficialZaloIngress`; 5 OA cases, NEEDS_HUMAN durable custody, 2 PG pools, replay, wrong signature & wrong OA, mapped/unmapped text, default OA route 503, zero Core/outbound effects. Signed MAC and data synthetic only; live OA, Windows Ricoh, iPhone physical, TN037 NOT RUN. AI0 PR31 may have advanced since `25a99ce2d0ddae673489361d7fceca56c3b60151`; independent retest required on any newer SHA.


## Checklist vận hành TN-037 — chuẩn bị nghiệm thu thật

**Mục đích:** mẫu chuẩn bị/bàn giao **chưa thực thi pilot**; đối chiếu với [đặc tả TN-037](../spec/DAC_TA_TN001-TN037.md) (mục II/TN-037 và VII). Không thay đổi quyết định đã chốt, không coi CI, DryRun, Chromium synthetic, đơn mẫu hoặc tải giả lập là đơn vận hành thật. Tất cả dòng checklist chưa có bằng chứng được ghi **NOT RUN/BLOCKED**, không tích dấu đạt trước.

### A. Khóa phạm vi, nguồn dữ liệu và người chịu trách nhiệm (chưa chạy)

- [ ] Có **chủ cửa hàng phê duyệt riêng** việc bắt đầu thử vận hành thực tế, phạm vi OA, cửa hàng, máy Windows/Ricoh IM7000, nhân sự, lịch bắt đầu/kết thúc và phương án chuyển sang xử lý thủ công; không suy diễn quyền thử thật từ CI/PR.
- [ ] Ghi **product SHA, phiên bản backend/web/Windows agent, migration/schema và cấu hình máy in**, thời điểm áp dụng/thay đổi, người đối chiếu. Thay bản có lỗi nghiêm trọng phải tách lứa bằng chứng, không cộng dồn ca bị ảnh hưởng từ phiên bản lỗi.
- [ ] Xác thực OA thật: quyền nhận tin/file, chữ ký webhook và byte sequence theo nhà cung cấp, OA/customer binding, dedupe, thử mất mạng và thất bại xác thực; các trường hợp chưa xác định phải khóa, chuyển người. Không đưa secret/token/tin khách thật vào repo/CI/log công khai.
- [ ] Kiểm tra Word/PDF/ảnh theo **định dạng gốc phù hợp**, preview, số trang/tờ, khổ, hai mặt/chiều lật; trên **Ricoh + Windows thật** xác minh giấy xuất thực tế, không chỉ dùng trạng thái spooler. Đối chiếu nhật ký lệnh in, chống gửi trùng và UNKNOWN; chỉ chủ phê duyệt in lại.
- [ ] Kiểm tra người duyệt theo vai trò, khách xác nhận đúng revision/hash/quote; sửa yêu cầu sau chốt phải xác nhận/duyệt lại; không cho AI tự duyệt/in. Kiểm tra luồng thanh toán/giao/đóng ngoại lệ vẫn là các trạng thái riêng; không tự hoàn tiền, xóa nợ hoặc tiêu hủy giấy.
- [ ] Kiểm tra **iPhone vật lý** theo phạm vi nghiệp vụ, thông báo/khóa duyệt/mất mạng/đồng bộ đa thiết bị. Browser 390×844 synthetic **không** thay thế bước này.
- [ ] Chốt trước khi thử thật bộ ca đại diện và quy tắc tính **mẫu số nhận diện ≥90%**, mẫu số **hội thoại thông dụng tự xử lý ≥80%**, tiêu chí ca đúng, ca chuyển người hợp lệ và ca ngoài phạm vi. Các định nghĩa chưa được đặc tả ấn định phải được **AI0 tổng hợp để chủ duyệt**, không tự loại ca khó để nâng tỷ lệ.

### B. Bằng chứng từng đơn và nhật ký ngày (không nhập dữ liệu khách thật vào Git)

Chỉ lập sổ trong **kho bằng chứng bảo vệ quyền truy cập**, có người chịu trách nhiệm và đường dẫn tham chiếu; tài liệu Git này chỉ quy định **trường cần ghi**, không chứa nội dung khách, số điện thoại, file gốc, token, ảnh giấy có dữ liệu riêng hoặc khóa API.

| Loại bản ghi | Trường tối thiểu cần lưu trong hệ thống bảo vệ |
| --- | --- |
| Phiên nghiệm thu | ID phiên; product SHA và cấu hình thực tế; người cho phép; giờ bắt đầu/kết thúc có múi giờ; tình trạng OA/Windows/Ricoh/iPhone; người đối chiếu; trạng thái PASS/FAIL/BLOCKED/NOT RUN |
| Một đơn thực tế | ID đơn duy nhất (không cộng trùng replay, in lại hoặc các lần sửa), mốc nhận yêu cầu/khách xác nhận/nhân viên duyệt/gửi lệnh/kiểm giấy/giao và người chịu trách nhiệm; revision/hash/quote; phân loại nhận diện và hội thoại; số trang/tờ/khổ/hai mặt thực xuất; đối chiếu preview–giấy; mã chứng cứ có giới hạn quyền truy cập |
| Gửi lệnh và đối soát | ID lệnh/job, journal/ACK, số lượt gửi, trạng thái NOT_SENT/SENDING/SENT/UNKNOWN, dấu thời gian, giấy được nhân viên kiểm; riêng UNKNOWN phải có bằng chứng đối soát, **không tự gửi lại** và không dùng spooler làm bằng chứng in xong |
| Sổ lỗi/ngoại lệ | ID sự cố, ngày giờ và timezone; mã đơn/job/revision liên quan; loại lỗi và mức độ; expected/actual; phiên bản/SHA; ảnh/log đã ẩn danh; cách phát hiện; tác động khách/giấy/tiền; người xử lý/phê duyệt; quyết định dừng/khôi phục; lần kiểm lại và liên kết bằng chứng |
| Báo cáo mỗi ngày | Khoảng giờ; số đơn thật tiếp nhận, đủ điều kiện, đạt, lỗi, đang chờ/ngoại lệ; số lượng lũy kế **từ phiên sạch**; hai tỷ lệ cùng **tử số + mẫu số đã chốt**; sự cố/nguyên nhân; thay đổi phiên bản; người kiểm tra xác nhận |

- [ ] Phân biệt **đơn thực tế**, **ca hồi quy kỹ thuật**, **fixture mô phỏng**, **DryRun**, **load 100 đơn/ngày mô phỏng** bằng trường nguồn chứng cứ; chỉ đơn thật đạt điều kiện đã đối chiếu mới được xét vào mốc **210 đơn đạt**. Không cộng cùng `order_id` hai lần, không tính ca chưa có đủ bằng chứng, ca FAIL, ca ở bản lỗi, đơn bị in/giao sai hoặc chưa đối soát.
- [ ] Ghi thời gian bắt đầu/kết thúc từng ngày và cả phiên; xuất báo cáo có thể kiểm toán được, không lấy số lượng message/event/job/print sheet thay cho **số đơn đạt**. Giữ riêng số đơn lỗi, đang treo và ngoại lệ để không che mẫu số.
- [ ] Lưu file/bằng chứng thật theo chính sách dữ liệu, phân quyền và thời hạn đã phê duyệt (quy tắc 30 ngày từ khi đóng đơn trong đặc tả, các trường hợp chưa đóng và backup còn cần chốt); không mặc định đưa dữ liệu nhạy cảm vào GitHub Actions hoặc PR.

### C. Tiêu chí tổng hợp, dừng và khôi phục

- [ ] **TN-037 bắt buộc:** có **ít nhất 210 đơn đạt trong tối thiểu 7 ngày thử nghiệm sạch, không lỗi nghiêm trọng**; tỷ lệ nhận diện **≥90%** và tự xử lý hội thoại thông dụng **≥80%** dựa vào mẫu số đã được duyệt. **Mô phỏng tải 100 đơn/ngày** được báo cáo thành gate kỹ thuật riêng, không tính là 100 đơn thật hoặc cộng vào 210 đơn.
- [ ] Kiểm riêng các tình huống mất mạng, restart khi gửi lệnh, replay/mất ACK, chỉnh sửa đơn khi chờ in, in ngoài phần mềm, in lại đúng quyền, nhập liệu thiếu, tài liệu/preview thay đổi, tính giấy và đối soát tiền/giao. Không công nhận PASS chỉ bằng UI, ACK gửi lệnh hoặc spooler.
- [ ] **DỪNG NGAY** khi có in chưa duyệt, in trùng, sai bản in nghiêm trọng, lộ/mất dữ liệu hoặc lỗi nghiêm trọng khác; giữ hệ thống ở trạng thái an toàn, khóa đường tự động gây tác động và chuyển người có quyền, lưu chứng cứ. Với job UNKNOWN/chưa chắc đã gửi, **không tự retry**; kiểm tra thiết bị/journal thực trước, chỉ chủ được quyết định in lại.
- [ ] Khi dừng: lập incident với ID, SHA, thời điểm, đơn bị ảnh hưởng, tác động, nguyên nhân (nếu xác minh được), phương án sửa và người phê duyệt. **Loại ca thuộc bản lỗi**, kiểm thử lại đầy đủ các ca liên quan trên bản sửa rồi **tích lũy lại tối thiểu 210 đơn đạt trong tối thiểu 7 ngày sạch không lỗi nghiêm trọng**; không nối chắp kết quả trước lỗi để đủ mốc.
- [ ] Giữ công nợ/khoản phải hoàn, giấy đã giao/chưa giao trong trường hợp hủy/đóng ngoại lệ; trường hợp đã in, đã thu cọc, cần hoàn hoặc khách không nhận do chủ quyết định. Ghi quyết định và kết quả thực tế riêng; **không giả giao đủ**.
- [ ] Đóng nghiệm thu chỉ khi mọi gate bắt buộc có chứng cứ, không còn lỗi chặn, thống kê và sổ incident đối chiếu được; **chủ cửa hàng xem báo cáo và phê duyệt**. Chỉ sau phê duyệt mới được xem xét mở toàn bộ đơn hợp lệ theo TN-032, vẫn giữ **nhân viên duyệt mọi lệnh in**. Nếu thiếu bất kỳ gate nào, ghi **BLOCKED/NOT RUN, chưa mở vận hành thật**.

### D. Tình trạng tại thời điểm bổ sung checklist

**CHƯA CHẠY PILOT TN-037.** CI AI5 độc lập trên product PR #85 / overlay PR #86 đã PASS ở [run #38585298107](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38585298107) (PG/Fastify **8/8**, Python DryRun **42/42**, Chromium **28/28 synthetic**); các kết quả này **chỉ là gate kiểm thử kỹ thuật**. Chưa có bằng chứng 210 đơn thật/7 ngày sạch, OA live/chữ ký/danh tính thật, in Ricoh/Windows thật, iPhone vật lý hay chủ ký nghiệm thu. **TN-037 = NOT RUN/BLOCKED, số đơn vận hành thật được xác nhận trong tài liệu này = 0 (chưa có bằng chứng, không phải khẳng định cửa hàng không có đơn).** Không kích hoạt OA, máy in, pilot hoặc deploy từ checklist này.
