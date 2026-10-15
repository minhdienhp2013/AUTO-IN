# AI5 — Bàn giao PR96 trên SHA 7bf2127 (15/10/2026)

**Tiếp tục PR #18:** giữ nguyên lịch sử nhánh `ai5/dot3-integrated-acceptance`; nguồn nghiệm thu là [Draft PR #96](https://github.com/minhdienhp2013/AUTO-IN/pull/96) product `7bf2127b1eb8bd508021b3069210f67e893490e9`, base main `99c935b8518238ead38a1d958503a23c1ad09204`.

**Đã tạo [Draft PR #97](https://github.com/minhdienhp2013/AUTO-IN/pull/97)**, HEAD `21e6c4f472269572939928e231b044befcc8df85`, **1 commit trực tiếp trên product SHA**, chỉ 3 file AI5 (hai file `tests/acceptance/`, một file `docs/acceptance/`). **Không dùng PR #93** vốn có parent cũ.

## Phạm vi cần nghiệm thu

1. **Đơn thủ công không conversation** và đã có plan: read model ban đầu không có receipt có thể CLEAR; thêm synthetic signed image đã map cùng customer và file OA-level chưa map thì **không CLEAR**, unresolved 1→2; sau review một vẫn pending, review cả hai mới được CLEAR. Không có auto approval/print; không tiết lộ payload. Thiếu registry/quarantine/scope mock tại truy vấn nguồn phải `needs_human`, PG lookup lỗi phải **503 PENDING_READ_UNAVAILABLE**.
2. **Offline OA challenge:** `createVerifiedConfirmationPort.issue_challenge` cho order `conversation_id=NULL` phải ném **403 CONFIRMATION_UNLINKED**, không có challenge, confirmation, approval hoặc job. Đây là **server port** (không ngụy nhận HTTP route).
3. **Review/approval:** giữ các 7 ca từ PR93, mapped/unmapped cần HTTP **409 PENDING_INBOUND_REVIEW**, **0 approval, 0 print**; hai pool và cả ingress-first/approval-first OA lock, lost ACK/replay; review đủ mới được duyệt theo các quy tắc cũ.
4. **Hồi quy:** strict PG suite `active-order-supplement-pg`, `pending-updates-pg`, `official-quarantine-approval-pg`, `verified-confirmation-pg`, `confirmation-candidate-pg`, `official-zalo-runtime-pg`, `confirmation-candidates-pg` và `https-agent-product-pg`; Python C403 DryRun. Không nhận test có SKIP là PASS.
5. **Chromium:** 14 synthetic scenarios trên **1440×900** và **390×844** = **28 unique marks**, phải có `mutation=0`, approve disabled, API-error/API-lock-banner riêng, stale/UNKNOWN/offline, sau real web production build. Không tính đây là browser E2E kết nối PostgreSQL.

## Trạng thái bằng chứng

- **Product CI SHA 7bf2127:** CODE checks [#38612295368](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38612295368) SUCCESS, PostgreSQL [#38612295370](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38612295370) SUCCESS, Core 39/39, AI2 93/93, composition 26/26, contracts 18/18; Python 199 PASS **1 SKIP**; AI4 Chromium synthetic 28/28. **Không coi đây là independent AI5 runner**.
- **PR97 overlay tự động trên SHA `21e6c4f`:** [CODE checks #38615517062](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38615517062) **SUCCESS**; [composition #38615516635](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38615516635) **SUCCESS**, cả composition-postgres và web-quality. Đã đọc log web-quality: 28 marker Chromium synthetic duy nhất, mỗi marker `mutation=0`, tổng kết `PASS CODE008 SYNTHETIC Chromium 28 scenario-viewport cases`. **Hai workflows không gọi `node tests/acceptance/run-pr96.mjs --pg` hoặc `--browser`.** Đây là CI sản phẩm ở overlay, không phải independent AI5.
- **AI5 independent `--pg`: NOT RUN; `--browser`: NOT RUN.** Không có PostgreSQL 18.3/Docker và không thể kích hoạt workflow tùy ý từ môi trường hiện tại. Cần AI0 tạo job riêng, cấp log/TAP exact SHA rồi mới cập nhật trạng thái.

## Lệnh AI0 cần chạy trong workflow AI0 sở hữu

**Checkout EXACT overlay SHA `21e6c4f472269572939928e231b044befcc8df85`**, fetch-depth=0. Job PG Node24.19+ / postgres:18.3 `autoin_test_ai5` localhost, 3 DB URLs bằng nhau, `AUTOIN_ALLOW_PG_ACCEPTANCE=YES_ISOLATED_TEST_DB`, `AUTOIN_OPERATION_MODE=simulation`:

```sh
npm ci
python3 -m pip install -r workers/documents/requirements-test.txt
npm run db:migrate
npm run check
node tests/acceptance/run-pr96.mjs --pg
```

Job Chromium (cùng exact overlay, web production build và Playwright Chromium executable được mở qua PATH):

```sh
cd web && npm ci && VITE_DEMO_MODE=false npm run build && cd ..
python3 -m pip install playwright==1.58.0
python3 -m playwright install --with-deps chromium
node tests/acceptance/run-pr96.mjs --browser
```

AI0 phải gửi **run ID, job logs đầy đủ, dòng checkout SHA, lệnh thực thi, 9/9 test mới, 8 suite hồi quy và 28/28 Chromium**, mọi PASS/FAIL/SKIP/NOT RUN, không gán SKIP thành PASS. Nếu FAIL giữ nguyên và giao AI1 (Core), AI2 (OA), AI3 (DryRun), AI4 (UI) hoặc AI0 (composition) theo sở hữu; **không đổi assertions, mã sản phẩm hay workflow từ AI5**.

**Live NOT RUN:** Zalo OA real canonical signature/payload/customer identity/callback, Ricoh/Windows vật lý, iPhone vật lý, TN-037 ≥210 đơn thật/ít nhất 7 ngày sạch. Không merge/deploy, gửi tin OA hoặc in thật.


## CẬP NHẬT KẾT QUẢ ĐỘC LẬP — run #38657817146 (15/10/2026)

**Đây là kết quả MỚI NHẤT, thay thế phần `AI5 NOT RUN` được ghi trước khi AI0 thực thi workflow.** Các mục NOT RUN phía trên là trạng thái lịch sử của bước chuẩn bị, không phải trạng thái hiện tại của runner này. AI5 tự đối chiếu **toàn bộ log hai job** của [run #38657817146](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38657817146), không chỉ dựa vào bình luận AI0.

### Định danh và nguyên trạng test

- **Product** [Draft PR #96](https://github.com/minhdienhp2013/AUTO-IN/pull/96): `7bf2127b1eb8bd508021b3069210f67e893490e9`; **overlay AI5** [Draft PR #97](https://github.com/minhdienhp2013/AUTO-IN/pull/97) `21e6c4f472269572939928e231b044befcc8df85`. **AI0 workflow-only** [Draft PR #98](https://github.com/minhdienhp2013/AUTO-IN/pull/98) HEAD `2120707ece11dbc076d780599d878c815a58d644`, trực tiếp trên main `99c935b8518238ead38a1d958503a23c1ad09204`; GitHub compare xác nhận **đúng 1 file workflow** `.github/workflows/ai0-ai5-pr97-exact-acceptance-20261015.yml`; **không sửa product, AI5 test, assertion**.
- [Actions run #38657817146](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38657817146) head là **workflow commit PR98 `2120707e`**, nhưng **cả hai job đều checkout riêng EXACT AI5 overlay `21e6c4f`**; log `git checkout --force` và bước `git rev-parse HEAD / HEAD^` so khớp overlay và parent product. **Không nhầm workflow-branch HEAD với tree nghiệm thu.**
- **PostgreSQL/Fastify/HTTP/DryRun job** [#116171663989](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38657817146/job/116171663989) **SUCCESS**. Log xác minh PostgreSQL **18.3** service localhost với `autoin_test_ai5` cô lập, cả ba DB URL cùng DB, `AUTOIN_ALLOW_PG_ACCEPTANCE=YES_ISOLATED_TEST_DB` và mode simulation. `npm ci`, migration và `npm run check` PASS; thực sự gọi **`node tests/acceptance/run-pr96.mjs --pg`**.
- Lệnh AI5 `--pg` xuất đúng **9 suites / 18 tests PASS / 0 FAIL / 0 SKIP** (9 new PR96 + 9 kiểm tra hồi quy): offline no-conversation readmodel và `403 CONFIRMATION_UNLINKED`; Core manual mapped/OA-level unmapped `HTTP409` + zero approvals/jobs; two-pool race; CODE-008 same order/revision; CODE-401 challenge/replay; CODE-402 candidate/ingress/ACK; CODE-403 simulated HTTPS/UNKNOWN/DryRun. **Python C403 riêng 42 PASS / 0 FAIL / 0 SKIP**. Dòng cuối log ghi `AI5 PG + Fastify HTTP synthetic suites count=9 tests total=18 Python=42`.
- **Chromium desktop/mobile job** [#116171663869](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38657817146/job/116171663869) **SUCCESS**. Checkout overlay/parent như trên, `npm ci` web, strict typecheck/build `VITE_DEMO_MODE=false` và Playwright Chromium; **thực sự gọi `node tests/acceptance/run-pr96.mjs --browser`**, xuất `PASS AI5 Chromium 28/28, independent direct execution (synthetic API fixtures ONLY)`. Runner kiểm tra 28 marker duy nhất (14 kịch bản × desktop 1440×900 + mobile 390×844), `mutation=0`; browser được mở thật nhưng API mock/intercept, **không phải Chromium-to-live-Fastify/Postgres E2E**.
- **Tổng kết:** **2/2 jobs SUCCESS**, AI5 synthetic PostgreSQL/HTTP **18/18 PASS** (FAIL=0, SKIP=0), Python DryRun **42/42 PASS**, Chromium synthetic **28/28 PASS**. Đây là **nghiệm thu kỹ thuật mô phỏng PASS trên product exact SHA**, không phải chứng nhận vận hành V1 hoặc TN-037. Không phát sinh commit test sau run, không nới assertion.

### Việc còn chặn vận hành thật

**NOT RUN:** xác minh chữ ký và byte/payload provider Zalo OA thật, OA/customer identity/callback thật, máy Ricoh/Windows + giấy in thực tế, Safari trên iPhone vật lý, TN-037 **≥210 đơn đạt trong tối thiểu 7 ngày sạch**, tỷ lệ 90%/80% và quyết định chấp thuận của chủ. Không tính 18 test hoặc 28 synthetic screenshots thành đơn thật; không khẳng định spooler là bằng chứng đủ giấy. Giữ PR #96/#97/#98 **Draft**, không merge/deploy, không gửi tin Zalo OA hoặc in thật.
