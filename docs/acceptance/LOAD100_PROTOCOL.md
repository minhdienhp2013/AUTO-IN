# AUTO-IN — CODE505 / LOAD100, protocol batch 100 đơn tổng hợp

## Trạng thái và điều kiện công bố

- Nền tham chiếu chính xác: `cb2be7a7b84d689dbe6c2c773192f111897c4063`, nhánh AI5 `ai5/tn037-load100-main-cb2be7a-20261016`. Chỉ ba phạm vi: `tests/acceptance/load100-product-pg.mjs`, `tests/fixtures/public/load100/**`, và chính file này.
- Dữ liệu giả lập thuần túy: 100 customer ID cố định, 100 conversation ID cố định, 100 event ID cố định, dự kiến **100 order ID duy nhất do Core thực sinh**, không bịa UUID trước. `manifest.json` ràng buộc riêng từng event↔customer↔conversation↔source SHA-256↔revision kỳ vọng [1,2,3]. 80 lần PNG `source.png` (96×128), 20 lần PDF `source.pdf` (1 trang); cả hai là file nhị phân tổng hợp, không chứa thông tin khách. Hash request của từng order phải lấy từ DB + manifest niêm phong thật, **không tự chọn hash tĩnh** khi đường dẫn artifact do server tạo ngẫu nhiên.
- Báo cáo **PASS** nếu và chỉ nếu thực sự chạy xong Fastify localhost/PostgreSQL **18.3**, AI2 ingress/worker thực và AI3 processor thực, 100/100 matching không mất, trùng hay rò shop/conversation/source, queue drain, không lỗi HTTP ngoài dự kiến, confirmation/approval/print_job giữ 0→0; hai nhóm replay đều **20/20**. PASS chỉ là **batch mô phỏng 100 đơn**; không phải 100 đơn trong 24 giờ, 210 ca/7 ngày, Zalo OA thật, DeepSeek thật, Ricoh/Windows thật hoặc Safari iPhone thật.
- Mọi lỗi/hợp đồng thiếu: **BLOCKED hoặc FAIL**, ghi rõ JSON/TAP; **NOT RUN** khi chưa thực thi. Không gán `load_orders_per_day=100` để qua release gate.

## Timeout kỹ thuật cố định, công bố trước khi chạy

| Đường đo | Trần kỹ thuật (không phải SLA) |
| --- | ---: |
| HTTP loopback từng request | **20.000 ms** |
| Một lần AI3 processor Node/Python | **90.000 ms** |
| Drain AI2 worker batch | **480.000 ms** |
| Tổng một lần LOAD100 | **1.200.000 ms (20 phút)** |
| HTTP đồng thời | **5** |
| Durable worker thực đồng thời | **2**, mỗi worker dùng pool PostgreSQL riêng |
| AI3 processor thực đồng thời | **2** |

Quá timeout ghi FAIL với nguyên nhân; không âm thầm kéo dài hoặc tự nới limit. Số thực đo: submitted, completed, failed, distinct IDs, exact mapping, HTTP status/code, latency p50/p95/max theo stage, elapsed, throughput thực của batch, queue peak và drain, guard trước/sau. Thông số bộ nhớ chỉ công bố khi đo thực; harness chưa chứng minh RSS toàn bộ subprocess.

## Lệnh thực thi/JSON/TAP cho AI0

Tạo một PostgreSQL **18.3** ở localhost, DB tách biệt tên **`autoin_test_load100`**, user/password riêng cho CI. Không dùng database cửa hàng. Node **24.19+**, `npm ci`, Python **3.12** + `python -m pip install -r workers/documents/requirements-test.txt` (Pillow/PyMuPDF). Hệ thống xuất chuẩn TAP trực tiếp và một dòng `LOAD100_JSON {...}`; có thể lưu JSON ngoài repo bằng `AUTOIN_LOAD100_REPORT=/tmp/load100-report.json`.

```bash
# 1. Checkout CHÍNH XÁC SHA đã có harness và AI0 code phụ thuộc, không chỉ main cũ.
git rev-parse HEAD
node --import tsx tests/acceptance/load100-product-pg.mjs --check-fixture

# 2. Chỉ cho DB cô lập, quyền thử có chủ đích, không bật Zalo live hoặc print.
export AUTOIN_OPERATION_MODE=simulation
export AUTOIN_ALLOW_PG_ACCEPTANCE=YES_ISOLATED_TEST_DB
export TEST_DATABASE_URL='postgresql://auto_in:TEST_ONLY@127.0.0.1:5432/autoin_test_load100'
export DATABASE_URL="$TEST_DATABASE_URL"
export AUTOIN_LOAD100_REPORT=/tmp/load100-report.json
npm ci
python -m pip install -r workers/documents/requirements-test.txt
npm run db:migrate

# 3. Sau khi AI0 cung cấp hợp đồng adopt staff và tích hợp vào đúng SHA.
node --import tsx tests/acceptance/load100-product-pg.mjs | tee /tmp/load100.tap
```

Lệnh `--check-fixture` chỉ xác minh manifest + SHA-256 của file PNG/PDF và **không phải PASS sản phẩm**. Pipeline LOAD100 chưa thể thực thi end-to-end trên BASE nếu chưa có API adopt hợp lệ, được kiểm tra trước khi gửi 100 webhook. AI0 cần tạo workflow riêng ở phần file của AI0, checkout nguồn SHA bất biến, cài PostgreSQL18.3 và Python/Node; **không** tính một workflow green nếu LOAD100 chưa thực sự chạy.

## Pipeline được yêu cầu và không làm giả

1. Khởi động hai `pg.Pool` cô lập khác nhau trên cùng DB thử (cùng trusted shop), dùng `createSyntheticZaloRuntime` thật, `PgStore` thật, `createCoreModule` thật. Fastify `buildIntegratedApp` nhận synthetic webhook plugin, fixture-only artifact registry, preview root riêng; bind loopback `127.0.0.1`; đăng nhập nhân viên bằng Core API.
2. Gửi đúng **100 webhook signed-by-fixture** `synthetic_fixture=true`, `x-test-fixture-key` là khóa test ngẫu nhiên chỉ lưu trong bộ nhớ, không tương đương chữ ký provider Zalo. Gửi lại **20 event** đồng ID, phải phản hồi `duplicate`. Thực hiện **100 staff HTTP upload** `/internal/simulation/inbound-artifacts` bằng Bearer owner, xác minh `registered` và preview chưa được tin cậy.
3. Chạy **2 worker thực** qua 2 PG pool; chỉ dịch `deadline_at` của batch synthetic đã tiếp nhận về trước để bỏ chờ 60 giây theo fixture time, **không ghi SQL giả `DONE`/proposal/order**. Kiểm sau drain: 100 AI2 proposal có 100 order thật, customer/conversation/event đúng, không tồn queue.
4. Nhân viên adopt nguồn **vào chính order ID do AI2 đã tạo** bằng API xác thực, không tạo thêm order. AI0 phải cung cấp hợp đồng hợp lệ dưới đây. Trong 20 trường hợp đầu, client chủ động **bỏ body phản hồi 2xx thành công** rồi gửi lại cùng HTTP method, path, body và `idempotency_key` — đây chỉ là client lost-success-ACK synthetic, **không** chứng minh rơi ACK máy in/provider. Các trường hợp khác adopt một lần.
5. Dùng **2 processor Node→AI3 Python thật** chạy `scripts/process-order.ts` cho từng order, không dùng fake plan. Từ DB lấy revision/hash, chứng cứ staff source, SHA-256 manifest AI3 và source SHA đã đăng ký; staff GET preview catalog revision 3 qua Fastify auth 200; giữ confirmations/approvals/print_jobs **0→0**; outlet Zalo `tick_outbound().disabled=true`.

## Rà soát tính idempotent của adopt trước khi nối CI

- Kiểm tra tĩnh trên BASE: `adoptSyntheticSuggestedSource` tại `backend/composition/synthetic-suggestion-adopt.ts` **chưa nhận client idempotency_key**. Sau lần adopt đầu, revision tăng thành 2, reservation thành `CREATED`; khi replay, hàm hiện từ chối do `active_revision!==1`. Không thể chỉ gắn hàm này vào một HTTP route rồi cho rằng 20 lần bỏ ACK đã PASS.
- Contract AI0 cần xử lý cùng shop/OA/event/order và **khóa idempotency_key + canonical request body**: replay y hệt sau COMMIT trả cùng receipt `existing`, không tạo revision mới; cùng key nhưng body khác trả conflict; khi reservation `PENDING`/không rõ Core đã COMMIT phải giữ fail-closed/reconcile có thẩm quyền, không tự ghi nhận thành công.
- Route phải xác thực principal staff và ràng buộc scope ở server; không lấy `shop_id`, source-ref/hash từ client. Việc kiểm 20 replays và 100 mapping không được hạ chuẩn để vượt BLOCKED. AI0 cần kiểm thử race và nguồn gốc/idempotency trong phạm vi module của AI0 trước khi chạy LOAD100.
- `CODE305_RUNBOOK` **không tìm thấy dưới tên file đó trong tree BASE**; tài liệu gần nhất đã đối chiếu là `docs/prompts/dot-3/AI5_CODE305.md`. Nếu runbook lưu ngoài nhánh hiện có, AI0 cần cung cấp vị trí/SHA để kiểm tra trước nghiệm thu sản phẩm.

## Hợp đồng thiếu trên BASE — yêu cầu AI0

Đã kiểm `backend/composition/runtime.ts` ở `cb2be7a7`: hiện chỉ có staff upload `POST /internal/simulation/inbound-artifacts`, staff draft/reconcile; chưa có staff API **adopt nguồn vào order AI2 existing**. Module `adoptSyntheticSuggestedSource` ở `backend/composition/synthetic-suggestion-adopt.ts` có kiểm provenance và dùng Core.revise, nhưng hiện chỉ được gọi trực tiếp bởi test tích hợp, **không phải HTTP route**. Gọi module trực tiếp từ AI5 hoặc dùng draft API sẽ vi phạm mục tiêu nghiệm thu 100 mapping AI2.

**Đề xuất cho AI0 review, không tự tạo endpoint:** `POST /internal/simulation/inbound-artifacts/:event_id/adopt`, Bearer staff, body đúng `{order_id,paper,copies,duplex,idempotency_key}`. Phải kiểm shop/OA/event/proposal/source và quyền ở server; đi qua service Core, không nhận source ref/hash do client tự chỉ định; receipt `{status:"adopted"|"existing",order_id,revision:2}`. Khi cùng idempotency key và body được replay sau khi transaction committed, trả đúng order/receipt cũ, không tạo order/revision mới; conflict payload khác phải fail closed. **Không được coi existing proposal là bằng chứng đã adopt**. Nếu AI0 quyết định shape khác, cập nhật harness/protocol bằng bàn giao rõ trước khi chạy, không bypass.

**AI0/CODE009** cần cung cấp endpoint hoặc bằng chứng rằng existing authenticated API thật đã đủ chức năng; sau đó nối CI đúng source SHA và lấy TAP/JSON. **AI5** chỉ chốt batch PASS sau test thực trên chính SHA đó. **AI1–AI4** giữ HOLD, chỉ sửa lỗi tái hiện đúng ownership; OA provider thật OFF.

## Release gate

TN-037 vẫn **BLOCKED**: nhận diện ≥90%, xử lý hội thoại ≥80%, 210 ca trong tối thiểu 7 ngày sạch, thiết bị Windows/Ricoh thật, OA có chữ ký thật, iPhone Safari thật và các kiểm chứng vận hành. Không merge/deploy/OA/in thật khi chưa có phê duyệt.

## AI5 sửa LOAD100 sau CI diagnostic của AI0 PR118 (2026-10-16)

- AI0 integration source: PR118 `021bd277facfa807bb45abadc71a17be08a17bcd`, còn test trên PR117 là nhánh độc lập. CI `38891866440` cho thấy 80 batches DONE và 20 PDF `NEEDS_HUMAN/GENERATION_HELD`, **LOAD100 FAIL**, không có 100 order completed.
- Fixture `source.pdf` cũ Type1 Helvetica không nhúng font bị guard AI3 giữ lại **đúng**. Fixture thay thế là PDF A4 1 trang vector shapes, không chứa font/text, render được bằng PyMuPDF; giữ nguyên guard `_pdf_font_reliable`, không sửa sản phẩm. PDF mới: **609 bytes, SHA256 `2f23535722b9d2fcc65f136aa39a55ba36226512318a2dd610a2ba7e42fcf8e8`**. 80 PNG dùng nguyên hash cũ.
- **Giới hạn quan trọng:** 80 PNG chia sẻ chính xác cùng một nguồn byte; 20 PDF cũng chia sẻ cùng một nguồn byte. Bộ test khóa ID/scope/provenance/hash theo từng event nhưng không chứng minh phân biệt khi hai file **cùng loại, cùng SHA** bị hoán đổi. Cần bộ fixture đa dạng hóa mới nếu nghiệm thu bao phủ rò file giữa hai khách cùng loại.
- Throughput = `completed/(elapsed_ms/1000)`, làm tròn 2 chữ số. Worker bắt buộc sáu bộ đếm thật `ingested/claimed/processed/held/needs_human/retry`; LOAD100 yêu cầu **zero held/needs_human/retry** (không tự chạy lại effects ngoài hợp đồng). Hai queue phải có 100 batch DONE/100 event COMMITTED và zero pending. Lịch sử order phải đúng [1,2,3], replay dùng receipt server từ `ai0_source_adoption_receipts`; JSON cung cấp `expected_source_sha256` và `observed_source_sha256` cho từng ID.
- Thêm global run-abort watchdog 20 phút; mỗi HTTP/SQL query bị giới hạn 20 giây, processor 90 giây và bị kill khi abort. `bounded()` chờ toàn bộ task settled trước cleanup, kể cả khi một task thất bại; timer dừng trong finally. **Giới hạn deadline:** không thay thế được timeout của runner/CI 30 phút hoặc các service bên ngoài bị treo nếu không tôn trọng cancellation.
- `--check-fixture` PASS chỉ chứng minh manifest/SHA, không phải 100 đơn. Test PostgreSQL/Fastify/AI2/AI3 chỉ PASS khi AI0 import nguyên blob AI5 vào candidate mới, chạy thật trên isolated PostgreSQL18.3 và xuất JSON/TAP trên chính SHA đó. Không sửa release gate hoặc đổi `load_orders_per_day`. OA/DeepSeek/Ricoh/Safari/iPhone và TN037 210/7d **NOT RUN**; V1 BLOCKED.
