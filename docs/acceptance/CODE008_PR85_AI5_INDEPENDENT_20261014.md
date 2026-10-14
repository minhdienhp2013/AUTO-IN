# AI5 — PR85 độc lập CODE-008/401/402/403 (14/10/2026)

## Định danh và mức chứng cứ

- **Product HEAD:** PR #85 Draft `a3dfac7fa2335694067e6d61f4c6045ad1d43a2d`, dựa trực tiếp PR #83 `caf9641edaddc445433fb47450891446e9f969bd`.
- **AI5 overlay:** Draft [PR #86](https://github.com/minhdienhp2013/AUTO-IN/pull/86), branch `ai5/pr85-code008-independent-20261014`, SHA **`3cde4b49fdacf8d40c59f69a770b6886cd5ce529`**, **một commit trực tiếp trên product SHA**, chỉ có 2 file AI5 (`tests/acceptance/pr85-independent.mjs` và tài liệu này); lịch sử PR #18 giữ nguyên.
- PR #85 AI0 CI trên product: [CODE checks #38569679700](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38569679700), [composition #38569679731](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38569679731) đều SUCCESS: UI 72/72, Chromium 28/28 synthetic, Core 38/38, AI2 93/93, composition 26/26, Python 199 PASS / 1 SKIP. **Đây là CI AI0, KHÔNG thay thế AI5 chạy độc lập.**
- Root workflow ở product SHA hiện chỉ chạy `tests/integration/**`, `tests/ui/**` và Python unit. **Không chạy `tests/acceptance/**`**, vì vậy push AI5 overlay dù CI xanh vẫn không có nghĩa đã chạy `tests/acceptance/pr85-independent.mjs`.

## Runner AI5, không bỏ assertion

Dùng `node tests/acceptance/pr85-independent.mjs --pg` sau khi checkout **đúng overlay**, `npm ci && npm run db:migrate && npm run check` trên PostgreSQL 18.3 cô lập (cùng 3 biến URL localhost và `AUTOIN_ALLOW_PG_ACCEPTANCE=YES_ISOLATED_TEST_DB`). Runner chạy 8 **bộ test PostgreSQL/HTTP sản phẩm riêng lẻ** bằng Node/TAP nghiêm ngặt (mỗi suite phải có tests >0, 0 FAIL, 0 SKIP), cộng Python DryRun CODE-403 (bắt buộc pass, 0 SKIP): pending same order/revision/hash/HTTP409, AI1 challenge, AI2 candidate/replay, quarantined OA manual approval, tampered evidence/UNKNOWN/lost ACK and DryRun zero-call. Có `AI1_BUILD_DIR=dist/backend` giống runner Core chuẩn.

Browser chạy riêng sau `cd web && npm ci && VITE_DEMO_MODE=false npm run build`, `python -m pip install playwright==1.58.0`, `python -m playwright install --with-deps chromium`, với executable `chromium` trong PATH, sau đó `node tests/acceptance/pr85-independent.mjs --browser`. Runner yêu cầu **đủ 28 marker khác nhau**: 14 status×2 viewport, cụ thể từng lỗi API 401/409/503/offline, tách `api-error` và `api-lock-banner`, UNKNOWN và approve disabled, mutation=0. **Các 28 case là synthetic API fixtures trong browser thật; không đánh đồng với trình duyệt gọi API Fastify/PG thật.**

Các suites PG trực tiếp sử dụng Fastify inject với PostgreSQL thật; khác với 28 browser fixture. Không có `VITE_DEMO_MODE=true`, không live OA, không gửi tin, không in thật.

## Các gate bắt buộc / blocker

- Trong AI0 code nguyên trạng, CODE-008/401/402/403 đã có test liên quan; runner AI5 tách chạy và từ chối TAP rỗng/SKIP thay vì tin CI tổng quát. **Chưa ghi PASS của runner đến khi thực sự chạy trên overlay.**
- Nếu fail thuộc: Core, revision, approval/409 → AI1; callback/candidate/quarantine → AI2 và AI0 composition; tampered document/print UNKNOWN → AI3; UI/Chromium/error banners → AI4; harness/runner → AI5. Báo exact SHA, case, trace, không sửa product.
- **NOT RUN:** official Zalo OA, máy Ricoh/Windows thật, iPhone vật lý, TN-037. AI0 phải đưa hai lệnh `--pg` và `--browser` vào CI validation do AI0 sở hữu, hoặc chạy bằng môi trường quyền hạn tương đương; AI5 không sửa `.github/workflows/**`.
- Không merge main, deploy, cấp quyền live hoặc thử thiết bị thật.

## Kết quả đã đọc trực tiếp trên overlay AI5 (14/10/2026)

- **Sản phẩm nguyên trạng:** `a3dfac7fa2335694067e6d61f4c6045ad1d43a2d`; **overlay SHA:** `3cde4b49fdacf8d40c59f69a770b6886cd5ce529`. GitHub compare xác minh overlay một commit, chỉ hai đường dẫn được phép. [CODE checks PUSH #38571126147](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38571126147) SUCCESS; [composition PG/Chromium PUSH #38571126065](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38571126065) SUCCESS.
- **Bài kiểm sản phẩm đã chạy thực trên checkout overlay trong GitHub Actions** (không phải runner độc lập mới): PostgreSQL 18.3 migrations PASS; composition **26 PASS / 0 FAIL / 0 SKIP**, Core **38/0/0**, AI2 **93/0/0**, contracts **18/0/0**, strict TypeScript/build PASS. AI3 Python **199 PASS / 1 SKIP**; UI **72/0/0**, Chromium **28/0/0** synthetic (14 desktop 1440×900 + 14 mobile 390×844). Log ghi **đúng 28 marker riêng**, từng marker có `mutation=0`; API 401/409/503/offline, UNKNOWN, wrong order/revision/hash và data missing/bad count đều có mặt. UI script test `api-error` và `api-lock-banner` riêng; `approve.is_disabled()`; không thay màn hình để giả API thực.
- **Chưa được workflow gọi:** `node tests/acceptance/pr85-independent.mjs --pg` **NOT RUN**; `--browser` **NOT RUN**. Các assertion strict TAP, đủ 8 bộ PG subprocess, 28-marker validator là mã AI5 đã tạo nhưng chưa có bằng chứng thực thi. Phải chạy riêng trên đúng checkout overlay, không dùng CI sản phẩm để tuyên bố runner này PASS. AI0 sở hữu workflow, AI5 không sửa workflow.
- **HTTP:** có bằng chứng product Fastify `inject()` + real isolated PostgreSQL trong 26 composition cases; không có bằng chứng trình duyệt 28 tình huống thật gọi Fastify/PG. **Các 28 case browser dùng synthetic route interception**. Không suy ra mutation/approval hoạt động đúng trong UI khi kết nối backend thật từ fixture.
- **NOT RUN / BLOCKED:** official Zalo OA signature/schema/callback, Windows/Ricoh thật, iPhone vật lý, TN-037. Giữ Draft, không merge/deploy.
