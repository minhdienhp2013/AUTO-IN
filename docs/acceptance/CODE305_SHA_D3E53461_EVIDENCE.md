# CODE-305 — xác minh đúng SHA tích hợp mới d3e53461a5cc71d0b96b24b069b5240ca9dcd71e

**Đã xác minh trực tiếp run/job/log GitHub Actions phát sinh từ sự kiện PUSH**, không chuyển kết quả SHA cũ hoặc PR merge ref thành kết quả SHA mới.

- Tích hợp mới thuộc AI0 PR #25, nhánh `ai0/code006-zalo-runtime`, HEAD `d3e53461a5cc71d0b96b24b069b5240ca9dcd71e`; AI0 PR #21 vẫn HEAD `15c1ac7`. Không merge PR nào.
- [Simulation integration PUSH #38165256655](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38165256655), job `114546378165`: **SUCCESS**. [CODE checks PUSH #38165256659](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38165256659): **SUCCESS**. PR-triggered #38165259433/#38165259443 là run khác với merge ref.
- DB CI PostgreSQL **18.3**, `autoin_test_305`, npm ci, migrations, root build/check PASS. AI1/core **16 PASS/0 FAIL/0 SKIP**; AI2 **36 PASS/0 FAIL/0 SKIP**; composition **9 PASS/0 FAIL/0 SKIP**; Python AI3 **100 PASS/1 SKIP**.
- **PG/DryRun product AI5:** 20 ca sản phẩm **20 PASS / 0 FAIL / 0 SKIP**, gồm double claim, UNKNOWN, generation, journal crash. Toàn runner `--integration`: **50 PASS / 0 FAIL / 19 SKIP** (legacy cases; không tính là PASS).
- **HTTP Fastify simulation:** readiness + 5 anonymous authorization **6 PASS / 0 FAIL / 0 SKIP**. Toàn runner `--http`: **36 PASS / 0 FAIL / 40 SKIP** (PG/DryRun không bật, legacy và HTTP-ZALO-01 không có verifier ở server mặc định).
- **Synthetic webhook → Fastify → PostgreSQL**: thành phần composition PASS; bao gồm signature sai trả 403, OA sai trả 422, inbound hợp lệ 200 và event trùng chỉ có một bản trong PG. Đây chỉ là synthetic fixture, **không** phải Zalo OA live, không chứng minh outbound.
- **Browser desktop/mobile**: **NOT RUN**; AI4 HEAD `8859d8639fb88345e0ef145856c28222fd245f00` và SHA tích hợp đều **thiếu** `web/package-lock.json`. Unit/UI tests không thay thế Playwright trên build đã khóa.
- **HTTPS agent product CLI / mất ACK / crash-restart**: **NOT RUN**, chưa có bộ fixture AI0 chứa PostgreSQL test + HTTPS loopback TLS được tin cậy + token print_agent + job mới đã duyệt cho **từng** scenario. AI3 có ca opt-in `test_product_backend_optin.py`; không được coi là chạy vì test unit bị SKIP khi thiếu fixture.

## Ma trận kết quả chốt trên SHA này

| Phạm vi TN | Bằng chứng | PASS | FAIL | SKIP/NOT RUN |
|---|---|---:|---:|---|
| TN-007, 012, 017, 019, 026, 027, 033, 035, 036 | 20 ca AI5 PG và DryRun service/journal | 20 | 0 | 0 |
| TN-017 / HTTP cơ bản | 5 anonymous + 1 readiness | 6 | 0 | 0 |
| TN-001/012 synthetic inbound | Raw-byte Fastify → PostgreSQL thuộc composition | 1 | 0 | 0 |
| Browser desktop/mobile | Chưa lockfile/build AI4 | 0 | 0 | NOT RUN |
| HTTPS agent/CLI lỗi ACK-crash | Fixture test chưa cấp | 0 | 0 | NOT RUN |
| Zalo OA thật, Ricoh thật, iPhone thật | Chưa thực hiện | 0 | 0 | NOT RUN |
| TN-021/037 | ≥90% nhận diện, ≥80% hội thoại, tải 100/ngày, 210 đơn ≥7 ngày, owner phê duyệt | 0 | 0 | BLOCKED |

**TN-037 = BLOCKED, release gate vẫn khóa.** Không in thật, không gửi khách, không mở production. Kết quả từ CI cũ `15c1ac7` lưu lại làm lịch sử nhưng **không thay thế** run push của `d3e53461a5cc71d0b96b24b069b5240ca9dcd71e`.

**AI5 HEAD sau SHA trên:** Bộ test mới yêu cầu fixture HTTPS riêng từng job, sổ chống tái dùng, truy vấn PostgreSQL xác minh kế hoạch đã được xác nhận/duyệt và đúng một job đang chờ trong shop; bổ sung 5 bài browser desktop/mobile. Thay đổi test AI5 này **chưa được CI chạy trên bản tích hợp mới**, phải được AI0 import và chạy lại theo SHA mới.

## Xác minh lại ngày 2026-10-12 (HEAD PR #25 không đổi)

- HEAD vẫn `d3e53461a5cc71d0b96b24b069b5240ca9dcd71e`; workflow push #38165256655 và #38165256659 đều SUCCESS, đã đọc lại log job 114546378165 đúng SHA; **không có lượt chạy PostgreSQL mới trong container AI5**.
- AI1 core PostgreSQL **16 PASS/0 FAIL/0 SKIP**; AI2 **36 PASS/0 FAIL/0 SKIP**; composition **9 PASS/0 FAIL/0 SKIP** (có 1 test synthetic webhook Fastify/PG), AI3 pytest **100 PASS/0 FAIL/1 SKIP**.
- AI5 product PostgreSQL/DryRun **20 PASS/0 FAIL/0 SKIP**; full --integration **50 PASS/0 FAIL/19 SKIP**. HTTP anonymous+readiness **6 PASS/0 FAIL/0 SKIP**; full --http **36 PASS/0 FAIL/40 SKIP**.
- AI5 selftest cục bộ `node --test tests/acceptance/https-agent-fixture.test.mjs tests/acceptance/browser-build-guard.test.mjs`: **6 PASS/0 FAIL/0 SKIP**; `node --check tests/acceptance/https-agent-run.mjs` PASS. Chỉ chốt an toàn, không phải product E2E.
- AI4 PR #15 HEAD `dbf4986` báo 48/48 UI unit PASS, nhưng `web/package-lock.json` vẫn thiếu; npm ci, typecheck, build BLOCKED/FAIL ở môi trường AI4: browser **NOT RUN**. HTTPS agent fixture mất ACK/crash/restart **NOT RUN** vì thiếu TLS/token/job mới.
- Zalo OA thật, Ricoh, iPhone và TN-037 **NOT RUN/BLOCKED**. CI push là bằng chứng phiên trước đã xác minh lại; thay đổi test trên PR #18 **chưa** chạy trên chính HEAD AI5.
