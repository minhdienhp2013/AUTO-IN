# AI5 — CODE-008/CODE-405 kiểm thử độc lập trên AI0 SHA 9fb2bf1bcd1ca9d59b912adf60d7fb8f3cabca54

Ngày xác minh 13/10/2026. Vai trò AI5, **chỉ thay đổi tests/acceptance/** và **docs/acceptance/**. PR AI5 #18 giữ nguyên branch/history. AI0 #31 HEAD thực tế `9fb2bf1bcd1ca9d59b912adf60d7fb8f3cabca54` (Draft); AI4 status fix tại PR #47 HEAD `61423574bd18d3143002a3c14b39690e7e998adb` **chưa** tích hợp PR #31.

## Chứng cứ tách đúng SHA

- AI0 push đúng `9fb2bf1bcd1ca9d59b912adf60d7fb8f3cabca54`: [Simulation integration #38362911714](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38362911714) **SUCCESS** (PG 18.3, API/HTTP, Chromium 1440×900 và 390×844); [CODE checks #38362911739](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38362911739) **SUCCESS**.
- AI5 RED-validation staging `6a317e4f6abc68127fc0fbd020d1fd58cf03e06a` = AI0 SHA `9fb2bf1bcd1ca9d59b912adf60d7fb8f3cabca54` **+ chỉ 2 file acceptance của AI5** (`code008-pending-ui-contract.test.mjs` và `run.mjs`), không sửa web/AI1/AI2/AI0. [Simulation integration PUSH #38364941554](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38364941554): PostgreSQL job `115187703075` **FAIL** đúng 2 ca mới; product-browser job `115187702684` **SUCCESS** (smoke tổng quát, không injection pending status). [CODE checks PUSH #38364941578](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38364941578) **SUCCESS**. **Không được tuyên bố staging integration SUCCESS**.
- CI AI0 HEAD nguyên trạng: `--integration` **91 PASS/0 FAIL/19 SKIP**; `--http` **54 PASS/0 FAIL/63 SKIP**.
- CI staging chính xác: `--integration` **96 PASS/2 FAIL/19 SKIP** (117 tổng); `--http` **59 PASS/2 FAIL/63 SKIP** (124 tổng), cùng 2 lỗi UI lặp lại vì kiểm chung non-PG trong hai mode; **không cộng thành 4 lỗi sản phẩm khác nhau**.

## Ma trận theo đúng yêu cầu

| Nhóm | PASS | FAIL | SKIP | Căn cứ |
|---|---:|---:|---:|---|
| C008-PG-01..09 cùng order/revision/hai worker/replay/delayed/approval race | 9 | 0 | 0 | PG CI staging, synthetic signed ingress → real AI2 worker → AI1 atomic append |
| C008-CI-01..02 cross composition | 2 | 0 | 0 | PG CI, đúng event receipt/trigger |
| CODE405 direct PG customer-confirm, quote, deposit, two PG pools | 5 | 0 | 0 | Real Core/PG test-only Principal, **không phải OA credential thực** |
| CODE405 6 composition raw signed webhook, candidate, AI2/AI3, preview tamper, lost ACK, HTTPS DryRun UNKNOWN | 6 | 0 | 0 | Real Fastify/PG/Python/DryRun với synthetic fixture, không phải Ricoh |
| C008-UI-01,04,05,06,07: scoped clear, >0 pending, wrong hash/order/rev, missing/error fail-closed | 5 | 0 | 0 | Actual `web/src/code008.ts` imported by Node v24 via pinned tsx; synthetic UI read-model envelope |
| **C008-UI-02 processing(0,[])** | 0 | **1** | 0 | **AI4** `web/src/code008.ts`: returns `unknown` instead of `processing`; approval remains blocked |
| **C008-UI-03 needs_human(0,[])** | 0 | **1** | 0 | **AI4** `web/src/code008.ts`: returns `unknown` instead of `needs_human`; approval remains blocked |
| Existing CODE105/legacy cases not connected to product Port | 0 | 0 | **19** | Runner `--integration`; explicit legacy SKIP, not PASS |
| Separate HTTP runner: integration-only tests disabled | — | — | **63** | `--http` deliberately lacks isolated PG opt-in; the same 7 new UI checks run and 2 fail |
| Chromium compiled React/Fastify/PostgreSQL desktop+mobile generic smoke | PASS 2 viewports | 0 | 0 | Product-browser CI job 115187702684; NOT status-specific |
| Chromium pending_updates 7 cases × 2 viewports | — | — | **NOT RUN** | New AI5 `code008-pending-chromium.*` added but integration workflow does **not** invoke dedicated status test |
| OA official, Ricoh Windows, iPhone vật lý, 100/ngày, 210 đơn/≥7 ngày / TN-037 | — | — | **NOT RUN/BLOCKED** | Không có bằng chứng vận hành thật |

**CODE405 không có ca trực tiếp PG bắt buộc nào bị SKIP trong runner `--integration`**: cả 5 direct và 6 composition đều PASS. Trên lượt `--http`, các ca PG bắt buộc cố ý SKIP do chế độ chạy khác, **không phải chấp nhận nghiệm thu toàn bộ**. Không cho phép dữ liệu synthetic giả làm xác nhận Zalo OA thật.

## Phát hiện cần phân công theo module

**AI4 — `web/src/code008.ts`**, trong `parsePendingInbound`: logic `pending.status !== 'clear' && unresolved_count === 0` hạ cả `processing(0)` và `needs_human(0)` xuống `unknown`, dù AI1 read model hợp lệ có thể phát hai trạng thái với 0 unresolved. PR #47 đã có thay đổi sửa chính đoạn này, nhưng **chưa nhập vào AI0 #31**. Bỏ điều kiện sai, không bỏ các hàng rào scope/revision/hash/valid items, và chạy 7 UI contract tests. Cẩn thận: `unknown` vẫn khóa duyệt — phát hiện này là **không hiển thị đúng trạng thái đối soát**, không có bằng chứng cho thấy tự mở in.

**AI0 — tích hợp có kiểm soát AI4 PR #47**, sau đó nhập test AI5, chạy lại `--integration`, `--http` trên PUSH SHA mới. Bổ sung bước Chromium status-specific trong workflow *do AI0 sở hữu*, không cho AI5 sửa CI/root: `node tests/acceptance/run.mjs --browser-product` với isolated PG, `AUTOIN_TEST_DATABASE_URL`, `AUTOIN_INTEGRATION_SHA`, web lockfile/build và Python Playwright/Chrome. AI5 opt-in browser wrapper chạy **14** trạng thái/viewport, không được báo PASS nếu chưa có log.

**TN-037 và V1 vẫn BLOCKED.** Không merge/deploy, không chạy Zalo OA/Ricoh thật, không tự gửi xác nhận/duyệt thay khách.


## Bổ sung 13/10 — trạng thái CI sau khi AI4 PR #47 + AI5 harness trên PR #48

Hai lỗi CODE008 UI-02/03 thuộc AI0 SHA cũ `9fb2bf1` đã được AI4 sửa tại PR #47; PR #48 đã tích hợp fix đó. AI5 Chromium fail ở PR #48 không phải lỗi UI: harness kiểm sai DOM node và đua tải dữ liệu. Đã sửa trong AI5 và nghiệm thu 14/14 trên staging `33f793af444045cbc1c15387ec748f00847a21a5` (PG 98 PASS/19 SKIP, HTTP 61 PASS/63 SKIP, browser 14 PASS). [Báo cáo cuối](CODE008_CHROMIUM_PR48_20261013.md); không diễn giải những RED trước đây là còn tồn tại trong patch đã kiểm. TN-037 vẫn NOT RUN.
