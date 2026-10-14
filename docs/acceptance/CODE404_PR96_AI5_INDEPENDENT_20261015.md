# AI5 độc lập — PR96 CODE-008/401/403/404 — chỉ simulation, chưa phải pilot

**Product:** Draft [PR #96](https://github.com/minhdienhp2013/AUTO-IN/pull/96), SHA khóa `7bf2127b1eb8bd508021b3069210f67e893490e9`, base main `99c935b8518238ead38a1d958503a23c1ad09204`. **AI5 overlay mới:** một commit **parent trực tiếp** trên đúng product, không mượn PR #93 vốn parent `d1b5503...`. Lịch sử [PR #18](https://github.com/minhdienhp2013/AUTO-IN/pull/18) tiếp tục, không reset.

## Những gì đã được xác minh trước khi thực thi runner

- AI0 xác nhận product CI trên **SHA mới**: [CODE checks #38612295368](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38612295368) và [composition integration #38612295370](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38612295370) **SUCCESS**, PG18.3 Core 39/39, composition 26/26, AI2 93/93, contracts 18/18; Python 199 PASS/1 SKIP; Chromium AI4 synthetic 28/28 desktop/mobile. Đây **không** phải AI5 independent runner và Python 1 SKIP **không được tính PASS**.
- Source review: `backend/core/pending-updates.ts` đã có nhánh provenance staff cho order **conversation_id=NULL**, kiểm tra `core_shop_zalo_oa_registry` + `zalo_official_quarantine` + scopes; nếu missing/partial schema thì `needs_human`, SQL fault thì `PENDING_READ_UNAVAILABLE` HTTP503, không CLEAR. Cổng `backend/core/verified-confirmation-port.ts` ném `403 CONFIRMATION_UNLINKED` trước khi cấp challenge nếu order không có verified conversation. Đây là **bằng chứng đọc source**, không được gọi là acceptance PG PASS.
- Tệp độc lập thuộc AI5: `tests/acceptance/pr96-offline-manual-pg.test.mjs` (9 TAP tests: 7 PR88 manual/quarantine/race hồi quy + 2 ca mới no-conversation), `tests/acceptance/run-pr96.mjs` (strict PG/browser), tài liệu này.

## Ma trận kiểm thử phải giữ nguyên

| Gate | Bằng chứng và yêu cầu thực tế | Trạng thái trước khi có log chạy AI5 |
| --- | --- | --- |
| A. Manual không conversation, read model | Core PG staff order có `conversation_id=NULL`, verified plan, ban đầu CLEAR hợp lệ; nhận synthetic signed mapped image cùng customer phải thành PROCESSING/không CLEAR, thêm unmapped OA-level file unresolved=2; review 1 vẫn không CLEAR, review cả 2 mới CLEAR, 0 automatic approvals/jobs; không lộ nội dung, danh tính | NOT RUN |
| B. Thiếu registry/schema hoặc PG fault | Cơ sở PostgreSQL thật, giả lập **failure ở query boundary** (không DROP schema dùng chung) → `needs_human` / `PENDING_READ_UNAVAILABLE` 503; không CLEAR | NOT RUN |
| C. Offline OA challenge | Order staff `conversation_id=NULL`: `issue_challenge` server Port từ chối **403 CONFIRMATION_UNLINKED**; 0 challenge/confirmation/approval/print job | NOT RUN |
| D. Manual mapped/unmapped + pending | Ngay cả khi không có `core_ai_draft_proposals`, cần HTTP **409 PENDING_INBOUND_REVIEW** và **0 approvals, 0 print jobs**. Hai PostgreSQL pools riêng, synthetic signed ingress, replay/lost ACK không tạo receipt/job trùng | NOT RUN |
| E. OA lock ordering | **Ingress-first** nắm row-lock đến COMMIT → Core HTTP approval chờ rồi 409, 0 jobs. **Approval-first** nắm lock → synthetic ingress phải chờ rồi lưu NEEDS_HUMAN sau commit, có tối đa 1 approval/job trước sự kiện đến | NOT RUN |
| F. Review partial/full | Có cả mapped và OA-level unmapped; review một vẫn HTTP409/0 job; review đủ rồi đủ confirmation/plan hiện hành mới duyệt được chính xác một lần | NOT RUN |
| G. CODE-008 + CODE-401 | Tái chạy strict các suite PG trên product mới: same order_id/revision trước chốt, journal/replay, pending 409, candidate không tự xác nhận, challenge postback có bằng chứng, không stale sau revision/approval/handover, chống 2 worker/lost ACK | NOT RUN |
| H. CODE-403 | HTTPS agent synthetic + Python DryRun/UNKNOWN không tự gửi lại; không coi spooler hay DryRun là giấy thật | NOT RUN |
| I. Chromium desktop/mobile | Production web build `VITE_DEMO_MODE=false`, chạy Chromium thực tế qua AI4 harness **14 scenario × 2 viewports = 28 unique markers**, mỗi marker `mutation=0`, approve disabled, API-error riêng API-lock-banner, UNKNOWN, stale, 401/409/503/offline. API **synthetic intercept**, không phải browser-E2E gọi PG | NOT RUN |

**Quy tắc:** giữ toàn bộ expected HTTP409, 403, readmodel không CLEAR, không auto challenge/confirmation/print và 0/1 job chính xác; không sửa product/workflow hoặc nới assertion nếu test đỏ. **SKIP là SKIP**, không tính PASS.

## Cách chạy thật độc lập, cần AI0 sở hữu isolated CI job

Checkout exact **SHA overlay AI5 mới** với `fetch-depth:0`; PG18.3 chỉ trong localhost, DB `autoin_test_ai5`, cả `DATABASE_URL`/`TEST_DATABASE_URL`/`AUTOIN_TEST_DATABASE_URL` trỏ cùng database; `AUTOIN_ALLOW_PG_ACCEPTANCE=YES_ISOLATED_TEST_DB`, `AUTOIN_OPERATION_MODE=simulation`, Node 24.19+.

**Job #1: PostgreSQL + HTTP + Python**

```sh
npm ci
python3 -m pip install -r workers/documents/requirements-test.txt
npm run db:migrate
npm run check
node tests/acceptance/run-pr96.mjs --pg
```

Runner kiểm tra parent đúng product SHA, file diff thuộc AI5, database cô lập; chạy strict **9 AI5 new TAP cases + 8 existing regression suites** (cần xác nhận bằng log số suite/test thực tế) và 2 Python C403 paths; mỗi TAP suite phải có **0 FAIL/0 SKIP/0 TODO**. Nếu thiếu một tệp, fail cứng.

**Job #2: Chromium synthetic desktop/mobile**

```sh
cd web
npm ci
VITE_DEMO_MODE=false npm run build
cd ..
python3 -m pip install playwright==1.58.0
python3 -m playwright install chromium
# Expose Playwright Chromium executable as `chromium` in PATH, like AI0 workflow.
node tests/acceptance/run-pr96.mjs --browser
```

Runner đòi đủ **28/28 marker riêng**, 14 scenario × 1440×900 + 390×844, mỗi marker mutation=0. Chạy Python Playwright độc lập trên product web build; không được gán kết quả browser synthetic thành xác nhận live Fastify/PG.

**Giới hạn hiện tại:** do môi trường truy cập mã bằng GitHub connector nhưng không có PostgreSQL18.3/Docker hoặc khả năng kích hoạt workflow tùy ý, lệnh độc lập AI5 **chưa thực thi** trong môi trường này; mọi gate AI5 giữ **NOT RUN** tới khi có **exact SHA checkout, lệnh, stdout/TAP/log và run ID**. Không ghi PASS chỉ vì product CODE/PG/Chromium CI xanh.

**LIVE NOT RUN:** chữ ký/provider canonical payload và danh tính/callback Zalo OA thật, Ricoh/Windows + giấy in thật, iPhone Safari vật lý, TN-037 ≥210 đơn thật trong tối thiểu 7 ngày sạch. PR #96 và AI5 overlay phải giữ Draft, không merge/deploy/gửi OA/in thật.
