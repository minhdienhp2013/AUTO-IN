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
- **PR97 overlay tự động:** [CODE checks #38615517062](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38615517062), [composition #38615516635](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38615516635). Những workflow có sẵn không chạy `tests/acceptance/**`; chỉ nêu PASS/FAIL khi log kết thúc và đối chiếu đúng SHA.
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
