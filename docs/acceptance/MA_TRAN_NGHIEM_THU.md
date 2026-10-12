# AUTO-IN — ma trận nghiệm thu CODE-105/CODE-305/CODE-405

## CODE-008 — HIỆN HÀNH (12/10/2026), P0 BLOCKED

AI5 đã viết/chạy độc lập PostgreSQL trên staging **`7dfefc4e51f0e603c38411f2ed85ac3ac90cc489`** dựa từ AI0 `c88fa3b`, **không sửa product**. [Ma trận/evidence chi tiết](CODE008_NGHIEM_THU_20261012.md) · [PG CI](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38245126219/job/114796979545).

| Phạm vi | PASS | FAIL | SKIP / NOT RUN |
|---|---:|---:|---|
| 9 ca CODE-008 direct PG (hai file >60s, revision, HTTP, race/replay, post-approve) | **7** | **2 P0** | 0 |
| 2 wrapper AI0 composition PG dùng TAP, đúng SHA | **2** | 0 | 0 |
| Toàn AI5 `--integration`, PG 18.3 | **89** | **2** | **19 SKIP** |
| Chromium React/Fastify PG desktop 1440×900 + mobile 390×844 | PASS | 0 | 0 |
| `--http` riêng | — | — | **NOT RUN** (PG step FAIL trước) |
| OA official, Ricoh, iPhone, explicit separate-order Port, TN-037 | — | — | **NOT RUN/BLOCKED** |

**Hai blocker bắt buộc chưa hoàn tất:** (1) file signed đến trước staff approve **chưa làm tăng active revision**; (2) trigger PG `AI0_PENDING_INBOUND_REVIEW` chặn chốt đúng nhưng Fastify **500 thay vì 409**. Bảo vệ giữ HELD, chống chia đơn/auto-print **không tương đương** tự nối đầy đủ file. Không waiver, không DONE V1.

---


## CODE-405 — AI5 đã đồng bộ patch 7 lỗi, xác minh đúng SHA (12/10/2026)

**AI5 PR #18** giữ nhánh `ai5/dot3-integrated-acceptance`, không reset/sửa sản phẩm. Bản sửa nghiệm thu được đồng bộ **nguyên blob từ AI0 commit `823237342dd9b6d0c1db5430e72b311d197056d9`**: `code405-composition-pg.test.mjs`, `integrated-webhook.test.mjs`, `code405-subprocess-evidence.mjs`, `code405-subprocess-evidence.test.mjs`, `run.mjs`. Không xóa ca test; 7 lỗi cũ là 6 wrapper composition và 1 webhook nested test.

**Root cause:** Node v24 test runner parent kế thừa `NODE_TEST_CONTEXT=child-v8` vào child `node --test` làm child bị bỏ qua và đôi khi exit 0 với output rỗng. Node reporter mặc định là spec không khớp parser TAP cũ. **Fix:** child chạy `--test-reporter=tap` và `isolatedTestChildEnv()` xóa `NODE_TEST_CONTEXT`; `assertVerifiedTapSummary()` yêu cầu output không rỗng, đủ 6 bộ đếm `tests/pass/fail/skipped/cancelled/todo`, `tests>0`, `pass===tests`, tất cả fail/skip/cancelled/todo=0. Không hard-code 1 test: file nguồn có thể nhiều test.

### Bằng chứng chính xác

- **GitHub Actions PUSH đúng AI0 SHA `823237342dd9b6d0c1db5430e72b311d197056d9`:** [CODE checks #38216608448](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38216608448) SUCCESS; [Simulation integration #38216608417](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38216608417) SUCCESS với job [PostgreSQL 114702715075](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38216608417/job/114702715075) và [Chromium 114702714940](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38216608417/job/114702714940) SUCCESS. Git checkout job và AUTOIN_INTEGRATION_SHA đã được đối chiếu đúng SHA; 2 workflow pull_request khác cũng SUCCESS nhưng không dùng thay push.
- **PostgreSQL CI:** AI1 core **23 PASS/0 FAIL/0 SKIP**, AI2 **50 PASS/0 FAIL/0 SKIP**, composition **20 PASS/0 FAIL/0 SKIP**; AI3 **167 PASS/0 FAIL/1 SKIP**. AI5 `node tests/acceptance/run.mjs --integration`: **80 PASS/0 FAIL/19 SKIP**, gồm **7/7 bài trước FAIL đã PASS**; HTTP `--http`: **54 PASS/0 FAIL/52 SKIP**. SKIP ở runner khác chế độ không chuyển thành PASS.
- **Chromium product CI:** `web/package-lock.json`, `npm ci`, `VITE_DEMO_MODE=false` build; Fastify + PG synthetic staff session, desktop **1440×900 PASS**, mobile **390×844 PASS**, preview PNG tamper bị từ chối và không tự approve/print/deliver. Không phải iPhone thật.
- **AI5 local độc lập:** kiểm hash `git hash-object` của **hai blob** `code405-subprocess-evidence.mjs` (`810f1e97dceff534c023ab90fae29bef8892871d`) và test (`1645362c6654201721eb432b30a241f72bfc5769`) **trùng GitHub AI0**. `node --test tests/acceptance/code405-subprocess-evidence.test.mjs tests/acceptance/code405-exact-sha.test.mjs` trên Node v22.16.0: **11 PASS / 0 FAIL / 0 SKIP / 0 CANCELLED / 0 TODO**, trong đó **nested child thật** chạy ≥3 test, không chỉ parse fixture.
- **Giới hạn nguồn chứng cứ:** không có PostgreSQL server/npm registry/GitHub git DNS để chạy lại toàn repo từ container AI5; PostgreSQL/HTTP/Chromium nói trên là **CI thực thi trên SHA tích hợp AI0**, không phải CI của nhánh AI5 sau sync. 5 blob patch trên nhánh AI5 đã được đối chiếu SHA nguồn; AI0 cần nhập patch vào SHA tích hợp kế tiếp rồi chạy CI đúng SHA để tránh lệch.

| Phạm vi | Trạng thái |
|---|---|
| 7 lỗi harness CODE-405 trên tích hợp `823237342dd9b6d0c1db5430e72b311d197056d9` | **PASS 7/7**, không còn FAIL |
| Bản sửa 5 file trên AI5 branch mới | **COMMITTED**, CI của HEAD nhánh AI5 **NOT RUN** |
| AI5 local selftest parser + nested child | **11 PASS / 0 FAIL / 0 SKIP** |
| CODE-405 Zalo confirmed từ credential/challenge verified thực sự | **NOT RUN**: synthetic OK chỉ candidate, không tạo confirmation |
| Real Zalo OA / Windows Ricoh / iPhone / TN-037 ≥210 đơn trong ≥7 ngày | **NOT RUN / BLOCKED** |

**TN-037 và V1 vẫn BLOCKED**; 7 lỗi kỹ thuật harness đã được sửa không thay cho nghiệm thu kinh doanh, không phát tin OA thật/in Ricoh/merge/deploy.

---

## CODE-405 — cập nhật kết quả CI SHA mới nhất (12/10/2026)

**AI0 PR #31 đã tiến lên HEAD `fb4af186d62adc3d91848f1306576f07cf35f4ee`.** Bằng chứng của `e16f69a` bên dưới trở thành lịch sử; không lấy kết quả cũ thế chỗ. Các lượt **PUSH đúng SHA mới** đã xác minh:

- [CODE checks #38213694609](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38213694609): SUCCESS.
- [Simulation integration #38213694522](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38213694522): SUCCESS; PostgreSQL job `114693400470` và product-browser job `114693400167` đều SUCCESS.
- PR-triggered CI cũng SUCCESS nhưng chạy trên merge ref, không tính thay push; log checkout Git HEAD của cả hai job chính khớp `fb4af186d62adc3d91848f1306576f07cf35f4ee`.

| Hạng mục trên đúng SHA này | PASS | FAIL | SKIP/NOT RUN |
|---|---:|---:|---|
| AI1 core/PostgreSQL | 20 | 0 | 0 |
| AI2 synthetic | 43 | 0 | 0 |
| AI0 composition PG (có signed `OK` candidate preflight) | 20 | 0 | 0 |
| AI3 Python | 140 | 0 | 1 SKIP |
| AI5 existing `--integration` | 58 | 0 | 19 SKIP |
| AI5 existing `--http` | 43 | 0 | 41 SKIP |
| Chromium product Fastify/PG 1440×900 + 390×844 | PASS cả hai viewport | 0 | 0 |
| **6 wrapper composition CODE-405 mới** | — | — | **NOT RUN** trên SHA tích hợp mới |
| 5 PG confirmation cases CODE-405 + browser wrapper mới | — | — | **NOT RUN** trên SHA tích hợp mới |
| OA/Ricoh/iPhone thật, TN-037 | — | — | **NOT RUN/BLOCKED** |

Ca signed synthetic Zalo `OK` của AI0 trả **`candidate_requires_credential` với `customer_credential_verified:false`** và **0 core_confirmations/approvals/print_jobs**. Sai OA/shop/customer, stale revision/hash/generation, quote cũ và HUMAN takeover bị chặn; **không chứng minh đã có customer confirmation hợp lệ**. CODE-405 bây giờ có wrapper gọi đúng bài PG `confirmation-candidate-pg.test.mjs` nhưng wrapper mới vẫn chưa có CI.

**V1/TN-037 vẫn BLOCKED.** Khi AI1/AI2 bàn giao Port sự kiện chứng thực và AI0 tích hợp test AI5, phải chạy lại trên SHA tích hợp kế tiếp. 210 đơn ≥7 ngày, OA/Ricoh/iPhone thật chưa thực hiện.

---

## CODE-405 — trạng thái hiện hành 2026-10-12

**AI0 PR #31 HEAD `e16f69ace72f41b82bd7438cc97b0c275fc57f64`** (CODE-007 giao ngày 12/10). Bằng chứng **push đúng SHA**: CODE checks #38212405872 SUCCESS; Simulation integration #38212405914 SUCCESS, PostgreSQL và product-browser jobs cùng SUCCESS. Check PR runs tách riêng. Báo cáo chi tiết: [CODE405_NGHIEM_THU_20261012.md](CODE405_NGHIEM_THU_20261012.md).

| Hạng mục TN | Đã chạy / chứng cứ | SKIP/NOT RUN |
|---|---|---|
| TN-007/012/017/019/026/027/033/035/036 | AI1 core 20 PASS; composition 19 PASS; AI5 integration 58 PASS CI simulation/PG | AI5 runner còn 19 SKIP |
| TN-001/002/005/006/012/022 (synthetic) | AI2 43 PASS; signed synthetic OA/AI3 document fact verified, tamper → HUMAN | **OA thật NOT RUN** |
| TN-011/025/034 source/preview | Real AI3-derived preview PG tests; SHA/manifest/tamper verified | Thiết bị/giấy thật NOT RUN |
| TN-008/010/032 Chromium | AI0 product-browser job PASS 1440×900/390×844, real Fastify/PG staff session | iPhone thật NOT RUN |
| CODE-405 customer confirmation | New 5 PG direct-service cases written; candidate→verified-event Port chưa nối | **New tests NOT RUN, verified OA confirm NOT RUN** |
| CODE-405 replay/two workers/ACK/DryRun | New 5 composition wrappers written | **New wrappers NOT RUN on new SHA** |
| TN-015/021/037 | Không có báo cáo thực địa đủ mẫu | **BLOCKED, chưa đạt nghiệm thu V1** |

**Những bảng CODE-105/CODE-305 bên dưới là lịch sử; các số của SHA cũ không thay bằng chứng SHA mới.**

---

## Trạng thái hiện hành — xác minh lại 2026-10-12

**HEAD mới nhất PR AI0 #25:** `d3e53461a5cc71d0b96b24b069b5240ca9dcd71e` (Draft, chưa merge). **Không có SHA tích hợp mới hơn** ở thời điểm kiểm tra. Bằng chứng dưới đây lấy từ GitHub Actions **PUSH đúng SHA**; AI5 đọc lại job log, không tự nhận đã chạy PostgreSQL mới trong container.

- [Simulation integration — PUSH #38165256655](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38165256655), job `114546378165`: SUCCESS.
- [CODE checks — PUSH #38165256659](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38165256659): SUCCESS.
- Không dùng SHA cũ `15c1ac7` hoặc PR-triggered merge ref để thay thế.

| Hạng mục kiểm thử | PASS | FAIL | SKIP / NOT RUN | Mức kết luận |
|---|---:|---:|---|---|
| AI1 PostgreSQL/core | 16 | 0 | 0 | CI trên PostgreSQL 18.3 thật |
| AI2 Zalo unit/integration | 36 | 0 | 0 | Simulation, không phải OA live |
| Composition Fastify/PostgreSQL | 9 | 0 | 0 | Có 1 bài synthetic raw webhook → PG (signature/scope/dedupe) |
| AI3 Python documents/printing | 100 | 0 | 1 SKIP | Không tính SKIP thành PASS |
| AI5 PG/DryRun product | 20 | 0 | 0 | Simulation; không phải Ricoh |
| HTTP auth (5) + readiness (1) | 6 | 0 | 0 | Anonymous, không chứng minh auth E2E |
| Full runner --integration | 50 | 0 | 19 SKIP | Legacy/không nối |
| Full runner --http | 36 | 0 | 40 SKIP | PG tắt, legacy và HTTP-ZALO-01 chưa nối runtime mặc định |
| AI5 selftest guard Node local | 6 | 0 | 0 | Chỉ fixture/browser preflight, không kết nối sản phẩm |
| Browser AI4 desktop/mobile | — | — | NOT RUN | AI4 HEAD `dbf4986`: chưa package-lock.json / build |
| HTTPS agent CLI, ACK mất, crash/restart | — | — | NOT RUN | Thiếu test TLS/token/job riêng từng scenario |
| OA thật, Ricoh, iPhone, 100 đơn/ngày, 210 đơn/≥7 ngày | — | — | NOT RUN | Chưa có dữ liệu thực địa |

**TN-037: BLOCKED**, chưa đủ tỷ lệ nhận diện ≥90%, tự xử lý ≥80%, tải 100 đơn/ngày, 210 đơn/ít nhất 7 ngày, thiết bị thật và duyệt chủ. Không đánh dấu toàn hệ thống DONE.

AI4 HEAD `dbf4986da7c7786afbaf6e2a5f9871136867cbad` có báo cáo 48/48 UI unit PASS nhưng lockfile/npm ci/typecheck/build chưa đạt; không đổi thành browser PASS. Bộ test mới trên AI5 PR #18 chưa có CI riêng ở HEAD; phải tích hợp và chạy lại khi có SHA mới.

**Các bảng bên dưới là lịch sử tại thời điểm viết trước; phần này là trạng thái mới nhất.**

---

**Mặc định tất cả ca nghiệm thu sản phẩm CHƯA CHẠY.** Fixture PASS không phải bằng chứng phần mềm đúng. Chỉ dùng giấy tờ tổng hợp, không dùng file khách.

| TN | Chủ code | Ca thử / yêu cầu | Bằng chứng |
|---|---|---|---|
| TN-001 | AI2 | gom tin | INTEGRATION NOT RUN |
| TN-002 | AI2 | tuyến mua hàng | INTEGRATION NOT RUN |
| TN-003 | AI2 | ngoài giờ | INTEGRATION NOT RUN |
| TN-004 | AI3 | file ZIP >5 | INTEGRATION NOT RUN |
| TN-005 | AI2/AI3 | nhận diện | INTEGRATION NOT RUN |
| TN-005A | AI2/AI3 | local before LLM | INTEGRATION NOT RUN |
| TN-006 | AI2 | trả lời | INTEGRATION NOT RUN |
| TN-007 | AI1 | unapproved_order, stale_revision | INTEGRATION NOT RUN |
| TN-008 | AI4 | push | INTEGRATION NOT RUN |
| TN-009 | AI3 | capability | INTEGRATION NOT RUN |
| TN-010 | AI4 | QR | INTEGRATION NOT RUN |
| TN-011 | AI1/AI3 | unauthorized_preview | INTEGRATION NOT RUN |
| TN-012 | AI1/AI2/AI3 | unknown_after_crash, duplicate_webhook | INTEGRATION NOT RUN |
| TN-013 | AI2 | cost alarms | INTEGRATION NOT RUN |
| TN-014 | AI2 | rule version | INTEGRATION NOT RUN |
| TN-015 | AI0/AI5 | 210/7 days | FIELD / GATE NOT RUN |
| TN-016 | AI0 | end-to-end | INTEGRATION NOT RUN |
| TN-017 | AI1 | forged_actor | INTEGRATION NOT RUN |
| TN-018 | AI3 | long text | INTEGRATION NOT RUN |
| TN-019 | AI1 | deposit_short | INTEGRATION NOT RUN |
| TN-020 | AI1 | customer retention | INTEGRATION NOT RUN |
| TN-021 | AI2/AI5 | 90%/80% metrics | FIELD / GATE NOT RUN |
| TN-022 | AI2 | OA verification | FIELD / GATE NOT RUN |
| TN-023 | AI3 | spooler | FIELD / GATE NOT RUN |
| TN-024 | AI1 | audit | INTEGRATION NOT RUN |
| TN-025 | AI3 | sheets/faces/pages | INTEGRATION NOT RUN |
| TN-026 | AI1 | sending_revision_race | INTEGRATION NOT RUN |
| TN-027 | AI1/AI2 | handover_race | INTEGRATION NOT RUN |
| TN-028 | AI1/AI2 | holiday | INTEGRATION NOT RUN |
| TN-029 | AI3 | duplex/scale | INTEGRATION NOT RUN |
| TN-030 | AI1 | partial_delivery_exception | INTEGRATION NOT RUN |
| TN-031 | AI1 | abandoned/reminders | INTEGRATION NOT RUN |
| TN-032 | AI1/AI4 | mode/owner | INTEGRATION NOT RUN |
| TN-033 | AI1 | large_quote_unconfirmed, deposit_short | INTEGRATION NOT RUN |
| TN-034 | AI3 | file fonts/preview | INTEGRATION NOT RUN |
| TN-035 | AI1/AI3 | manual_lock, unknown_after_crash | INTEGRATION NOT RUN |
| TN-036 | AI1 | partial_delivery_exception | INTEGRATION NOT RUN |
| TN-037 | AI0/AI5 | release gate | FIELD / GATE NOT RUN |

**Chặn P0:** thiếu duyệt, stale, trùng job, giả quyền, UNKNOWN tự retry, in sai, rò dữ liệu. Có P0 phải chuyển SAFE qua AI0, sửa đúng module và chạy lại; không tự in thật.

**TN-021/037:** yêu cầu nhận diện ≥90%, hội thoại phổ biến tự xử lý ≥80%; mẫu số khóa trước, thiếu dự đoán tính sai, không loại ca khó; bước nhân viên duyệt là bắt buộc và không tính là lỗi của AI. 210 đơn đạt trong ≥7 ngày sạch lỗi nghiêm trọng + mô phỏng 100 đơn/ngày, OA/Ricoh/iPhone có bằng chứng thật, chủ duyệt mở chính thức. Chưa có các bằng chứng đó.

## CODE-305 — ma trận bổ sung đợt 3 (2026-10-11)

**BASE MODULE:** `5707b81128e7e84180db57865896d52d256dac33`. **Tích hợp CODE-006:** CHƯA CÓ SHA tại thời điểm viết. Các dòng dưới chỉ là ca đã **viết code**, sản phẩm vẫn **NOT RUN / BLOCKED**. Kết quả selftest không chuyển trạng thái nghiệm thu.

| TN | Test trên sản phẩm thật (simulation, PostgreSQL test) | Chủ xử lý lỗi | Trạng thái |
| --- | --- | --- | --- |
| TN-007, TN-026 | PG-01–04, PG-13, PG-16–17: stale/claim kép/mark kép/FIFO xác nhận khác thứ tự duyệt | AI1 | NOT RUN |
| TN-012, TN-023, TN-035 | PG-05/11, DRYRUN-12/18: UNKNOWN, crash journal, không gửi lại, không chứng minh giấy thật | AI1/AI3 | NOT RUN |
| TN-017 | PG-14 printer scope; HTTP anonymous staff/agent denial | AI1/AI0 | NOT RUN |
| TN-019, TN-030, TN-033, TN-036 | PG-07–10, PG-15: giá/cọc/hoàn/đóng ngoại lệ còn nợ | AI1 | NOT RUN |
| TN-027 | PG-19/20: generation cũ bị chặn và handover đồng thời | AI1/AI2 | NOT RUN |
| TN-001, TN-012, TN-022 | HTTP-ZALO-01 từ chối webhook không chữ ký nếu AI2 ingress tích hợp | AI0/AI2 | NOT RUN |
| TN-008, TN-010, TN-032 | UI browser local Chromium; mobile viewport không phải iPhone thật | AI4 | NOT RUN |
| TN-015, TN-021, TN-037 | 90%/80%, 100 đơn/ngày, 210 đơn ≥7 ngày, OA/Ricoh/iPhone thật và bằng chứng release gate | AI0/AI5 | FIELD NOT RUN |

**Release gate bổ sung:** yêu cầu `evidence.integration_sha` 40 ký tự và `evidence.product_runs.pg/http/dryrun/browser` từng mục có `status:'PASS'`, `fail:0`, `skip:0`, `pass >= 1` và **cùng SHA**; các điều kiện nghiệp vụ/thiết bị TN-037 trước đây vẫn giữ nguyên. Một bài SKIP không phải PASS.

**Nguyên tắc báo cáo:** Bất kỳ ca P0 FAIL -> SAFE, không tự gửi in, không tự nhắn OA. File/code AI5 chỉ báo lỗi, chủ module tương ứng sửa. Mọi báo cáo phải ghi SHA, lệnh tái hiện, observed/expected và bằng chứng đã che thông tin nhạy cảm.

## Cập nhật xác minh 2026-10-12

Xem [Bằng chứng SHA 15c1ac7](CODE305_SHA_15c1ac7_EVIDENCE.md). Các bảng NOT RUN ở trên là trạng thái lịch sử trước khi AI0 cấp SHA. Kết quả mới của GitHub Actions **push trực tiếp SHA**: 20 PG/DryRun PASS/0 FAIL/0 SKIP; HTTP auth/readiness 6 PASS/0 FAIL/0 SKIP; 1 bài webhook synthetic Fastify/PostgreSQL PASS. Toàn runner --integration 50 PASS/19 SKIP; --http 36 PASS/40 SKIP (các SKIP không phải kết quả PASS sản phẩm). Browser BLOCKED vì AI4 chưa có package-lock.json. Zalo OA thật, Ricoh thật, iPhone thật và TN-037 vẫn NOT RUN/BLOCKED. Không nâng trạng thái TN-037 dựa trên CI simulation.

## Trạng thái mới trên SHA CODE-006 `d3e53461`

Bảng phía trên và báo cáo `15c1ac7` là lịch sử. Bằng chứng đang có trên [SHA push mới](CODE305_SHA_D3E53461_EVIDENCE.md): AI5 PG/DryRun **20 PASS/0 FAIL/0 SKIP**; HTTP auth/readiness **6 PASS/0 FAIL/0 SKIP**; synthetic raw Fastify→PostgreSQL **PASS** trong 9 ca composition. Toàn runner integration 50 PASS/19 SKIP; HTTP 36 PASS/40 SKIP. Browser desktop/mobile và agent HTTPS fixture mới **NOT RUN**. Zalo OA thật, Ricoh thật, iPhone thật và TN-037 **BLOCKED**. Không lấy kết quả SHA cũ hoặc selftest làm nghiệm thu thực tế.
