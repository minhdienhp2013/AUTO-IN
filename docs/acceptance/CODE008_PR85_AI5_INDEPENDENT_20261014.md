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

- Trong AI0 code nguyên trạng, CODE-008/401/402/403 đã có test liên quan; runner AI5 tách chạy và từ chối TAP rỗng/SKIP thay vì tin CI tổng quát. **Quy tắc bắt buộc: chỉ đánh dấu PASS khi có log runner exact-overlay. Run #38585298107 dưới đây đã thỏa điều kiện này.**
- Nếu fail thuộc: Core, revision, approval/409 → AI1; callback/candidate/quarantine → AI2 và AI0 composition; tampered document/print UNKNOWN → AI3; UI/Chromium/error banners → AI4; harness/runner → AI5. Báo exact SHA, case, trace, không sửa product.
- **NOT RUN:** official Zalo OA, máy Ricoh/Windows thật, iPhone vật lý, TN-037. AI0 đã thực hiện hai lệnh qua workflow validation PR #87, được AI5 xác minh ở mục mới bên dưới; AI5 không sửa `.github/workflows/**`.
- Không merge main, deploy, cấp quyền live hoặc thử thiết bị thật.

## Bằng chứng giai đoạn trước khi AI0 chạy runner — lưu lịch sử (14/10/2026)

- **Sản phẩm nguyên trạng:** `a3dfac7fa2335694067e6d61f4c6045ad1d43a2d`; **overlay SHA:** `3cde4b49fdacf8d40c59f69a770b6886cd5ce529`. GitHub compare xác minh overlay một commit, chỉ hai đường dẫn được phép. [CODE checks PUSH #38571126147](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38571126147) SUCCESS; [composition PG/Chromium PUSH #38571126065](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38571126065) SUCCESS.
- **Bài kiểm sản phẩm đã chạy thực trên checkout overlay trong GitHub Actions** (không phải runner độc lập mới): PostgreSQL 18.3 migrations PASS; composition **26 PASS / 0 FAIL / 0 SKIP**, Core **38/0/0**, AI2 **93/0/0**, contracts **18/0/0**, strict TypeScript/build PASS. AI3 Python **199 PASS / 1 SKIP**; UI **72/0/0**, Chromium **28/0/0** synthetic (14 desktop 1440×900 + 14 mobile 390×844). Log ghi **đúng 28 marker riêng**, từng marker có `mutation=0`; API 401/409/503/offline, UNKNOWN, wrong order/revision/hash và data missing/bad count đều có mặt. UI script test `api-error` và `api-lock-banner` riêng; `approve.is_disabled()`; không thay màn hình để giả API thực.
- **Trạng thái lịch sử trước workflow #87:** `node tests/acceptance/pr85-independent.mjs --pg` **NOT RUN**; `--browser` **NOT RUN**. Sau đó runner đã được AI0 chạy trên đúng overlay và AI5 đọc trực tiếp logs (xem kết quả mới nhất bên dưới). CI sản phẩm trước đây không phải là bằng chứng chạy runner.
- **HTTP:** có bằng chứng product Fastify `inject()` + real isolated PostgreSQL trong 26 composition cases; không có bằng chứng trình duyệt 28 tình huống thật gọi Fastify/PG. **Các 28 case browser dùng synthetic route interception**. Không suy ra mutation/approval hoạt động đúng trong UI khi kết nối backend thật từ fixture.
- **NOT RUN (ngoài phạm vi mô phỏng):** Zalo OA signature/schema/identity/callback thật, Windows/Ricoh thật, iPhone vật lý, TN-037. Giữ Draft, không merge/deploy.

## Xác minh AI5 run #38585298107 — kết quả mới nhất (14/10/2026)

**Trạng thái phạm vi mô phỏng: DONE — AI5 independent acceptance runner đã PASS.**
AI5 đã trực tiếp đọc đầy đủ job logs của [Actions run #38585298107](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38585298107), không lấy comment AI0 làm bằng chứng duy nhất.

### SHA và nguồn chạy

- Product [PR #85](https://github.com/minhdienhp2013/AUTO-IN/pull/85): `a3dfac7fa2335694067e6d61f4c6045ad1d43a2d`.
- AI5 test overlay [PR #86](https://github.com/minhdienhp2013/AUTO-IN/pull/86): `3cde4b49fdacf8d40c59f69a770b6886cd5ce529`, **một commit trực tiếp trên product**, đúng 2 file AI5.
- AI0 validation [PR #87](https://github.com/minhdienhp2013/AUTO-IN/pull/87): workflow HEAD `e18e59a391b201531964cb5e60e9f65fce1ae06d`, thay đổi **chỉ** `.github/workflows/ai5-pr85-independent.yml`, không sửa sản phẩm hoặc assertion.
- Cả hai job log đều ghi `actions/checkout` ref, `git checkout --force`, kết quả checkout **đúng SHA `3cde4b49fdacf8d40c59f69a770b6886cd5ce529`**. Đây là SHA chạy test; `e18e59a` chỉ là commit chứa workflow AI0.

### AI5 đọc và đối chiếu job logs

| Job / log trực tiếp | Lệnh được thực thi | PASS | FAIL | SKIP |
| --- | --- | ---: | ---: | ---: |
| [pg-http-dryrun #115925564208](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38585298107/job/115925564208) | `node tests/acceptance/pr85-independent.mjs --pg` | **8/8 suites PostgreSQL + Fastify/HTTP** | 0 | 0 |
| C403 Python trong cùng job PG | runner gọi Python pytest/DryRun | **42/42** | 0 | 0 |
| [chromium #115925564798](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38585298107/job/115925564798) | `node tests/acceptance/pr85-independent.mjs --browser` | **28/28 Chromium synthetic** | 0 | 0 |

- PG job **SUCCESS**, PostgreSQL **18.3** chạy database localhost cô lập `autoin_test_ai5`, ba biến `DATABASE_URL`/`TEST_DATABASE_URL`/`AUTOIN_TEST_DATABASE_URL` trỏ cùng DB, `AUTOIN_ALLOW_PG_ACCEPTANCE=YES_ISOLATED_TEST_DB`. `npm ci`, migration và `npm run check` PASS. Tám dòng `PASS AI5 ... 1/1 (FAIL=0 SKIP=0)` được log in trực tiếp: **C008** giữ cùng order_id và 0 print; pending scope/revision/hash HTTP409; race hai thứ tự khóa; **C401** verified challenge/replay hai pool; **C402** candidate không phải confirmation; inbound human review HTTP409; dual-worker lost ACK không tự consent; **C403** evidence bị sửa/UNKNOWN/lost ACK và DryRun 0-call. Cuối log in `PASS AI5 C403 Python 42 tests; FAIL=0 SKIP=0` và `AI5 PG + Fastify HTTP synthetic suites total=8 Python=42; product=a3dfac7... overlay=3cde4b49...`.
- Chromium job **SUCCESS** sau web `npm ci`, `VITE_DEMO_MODE=false npm run build`, Playwright **1.58.0** và Chromium. Log xác nhận lệnh `--browser` cùng dòng kết quả `PASS AI5 Chromium 28/28, independent direct execution (synthetic API fixtures ONLY)`. Runner kiểm tra đầy đủ **14 scenario × 2 viewport** (desktop 1440×900, mobile 390×844), 28 marker riêng và `mutation=0`; AI4 harness assert lỗi API `api-error` riêng với `api-lock-banner`, UNKNOWN và disabled approve. **Lưu ý bằng chứng:** job chỉ in dòng tổng kết 28/28, 28 marker con được runner thu thập/đối chiếu nội bộ (thiếu, trùng hoặc sai thì FAIL).
- Đây là **AI5 runner do workflow validation AI0 thực thi, AI5 tự kiểm lại full logs**. PostgreSQL/Fastify tests là backend thật với DB cô lập (Fastify inject); Chromium mở trình duyệt thật nhưng **intercept API bằng synthetic fixtures**, không phải browser-to-Fastify/PostgreSQL E2E. Không suy diễn các ca synthetic thành kết nối thực.

### Lần chạy lỗi trước và điều kiện còn thiếu

- [Run #38585019044](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38585019044) lỗi cấu hình tên database thử nghiệm chưa đạt guard. PR #87 thay tên DB thành `autoin_test_ai5`; #38585298107 sau đó **PASS**. Không sửa product/test/assertions, không biến lỗi cấu hình cũ thành lỗi sản phẩm hoặc PASS giả.
- **Chỉ phạm vi CI/simulation CODE-008/401/402/403 đạt nghiệm thu độc lập. NOT RUN:** Zalo OA/chữ ký/schema/danh tính/callback thật, Windows/Ricoh và máy in thật, iPhone vật lý, TN-037. Đây **không phải chứng nhận V1 đã vận hành live**; không merge/deploy/gửi OA thật/in thật. Giữ PR #18/#85/#86/#87 Draft.
