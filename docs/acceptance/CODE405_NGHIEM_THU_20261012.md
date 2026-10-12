# CODE-405 — Nghiệm thu chéo đúng SHA CODE-007, 12/10/2026

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


## Định danh và nguồn chứng cứ

- **Nền điều phối**: `docs/architecture/CODE007_PHAN_CONG_20261012.md` tại SHA `e16f69ace72f41b82bd7438cc97b0c275fc57f64`.
- **AI0 PR #31**, branch `ai0/code006-ports-integration`, **HEAD đã kiểm** `e16f69ace72f41b82bd7438cc97b0c275fc57f64` — Draft/chưa merge.
- [CODE checks PUSH run 38212405872](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38212405872): SUCCESS.
- [Simulation integration PUSH run 38212405914](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38212405914): SUCCESS; postgres job `114689312221`, product-browser job `114689312077`, cả hai SUCCESS.
- [CODE checks PR run 38212409957](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38212409957) SUCCESS; [Simulation integration PR run 38212410000](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38212410000) SUCCESS. PR checkout merge ref **không** dùng thay bằng chứng push.
- Nhóm 6/6 PASS là **workflow/job CI đã có**; AI5 đọc log đúng SHA và không nhận đã chạy lại DB/Chromium trên máy AI5.

## Ma trận kiểm đúng SHA `e16f69ace72f41b82bd7438cc97b0c275fc57f64`

| Thành phần | PASS | FAIL | SKIP | Nguồn/trình độ |
| --- | ---: | ---: | ---: | --- |
| AI1/core | 20 | 0 | 0 | CI Postgres 18.3, isolated `autoin_test*` |
| AI2 Zalo + queue/generation | 43 | 0 | 0 | CI synthetic, **KHÔNG** OA live |
| AI0 composition gồm verified image, idempotent draft, webhook, preview | 19 | 0 | 0 | CI, PostgreSQL thật + fixture synthetic |
| AI3 Python | 140 | 0 | 1 | Pytest actual processor/DryRun, 1 SKIP giữ riêng |
| AI5 existing `--integration` | 58 | 0 | 19 | CI test đã có, legacy SKIP không phải PASS |
| AI5 existing `--http` | 43 | 0 | 41 | CI local API, các bài không bật vẫn SKIP |
| Chromium product, desktop `1440×900` | PASS | 0 | 0 | CI job 114689312077, Fastify/staff login/PG với `VITE_DEMO_MODE=false` |
| Chromium product, mobile `390×844` | PASS | 0 | 0 | CI job 114689312077, viewport simulation **không** iPhone thật |
| CODE-405 SHA guard selftest mới | 3 | 0 | 0 | Node v22 cục bộ trên 2 blob giống GitHub, SHA hash đối chiếu |
| CODE-405 5 ca xác nhận trực tiếp PostgreSQL mới | — | — | **NOT RUN** | Mã AI5 mới, chưa được tích hợp vào SHA AI0 |
| CODE-405 5 wrapper tích hợp synthetic webhook/artifact/ACK/HTTPS | — | — | **NOT RUN** | Đòi checkout đúng SHA, DB riêng và các dependency sản phẩm |
| CODE-405 wrapper Chromium product mới | — | — | **NOT RUN** | Đòi checkout đúng SHA, build web và Chromium/PG |
| Zalo OA thật / Windows Ricoh thật / iPhone thật / 210 đơn ≥7 ngày | — | — | **NOT RUN** | Chưa có môi trường vận hành và mẫu nghiệm thu |

**Quy tắc:** PASS Chromium chỉ là **test ứng dụng thật trong CI với fixture synthetic**, không phải file do khách Zalo thật gửi hoặc máy in đã ra giấy. Với ảnh/preview CI dùng manifest synthetic có SHA neo DB và kiểm tamper. Ca AI3 xử lý file thật sinh từ fixture nằm trong nhóm PostgreSQL khác. Chưa có Port chứng thực xác nhận khách từ sự kiện OA thì **không thể gọi luồng OA → customer confirmation PASS**.

## CODE-405 — các ca AI5 mới đã viết

**PostgreSQL trực tiếp AI1 service qua `product-adapter.mjs` (test-only synthetic Principal, KHÔNG tạo Principal từ tin OA):**

- `C405-PG-01`: staff giả xác nhận, khách khác shop/khách khác, revision cũ → từ chối, không ghi confirm/job.
- `C405-PG-02`: cùng idempotency key như mất ACK → xác nhận một bản; không tự staff approve/print.
- `C405-PG-03`: trên 150 tờ yêu cầu đúng quote_revision và price-confirm; khách xác nhận **không** tự duyệt, chỉ staff chủ động duyệt.
- `C405-PG-04`: thiếu cọc buộc acknowledgement cảnh báo trước khi nhân viên duyệt.
- `C405-PG-05`: 2 PostgreSQL connections độc lập cùng synthetic customer/idempotency key → tối đa 1 xác nhận, không tự duyệt.

**Cross-module wrappers dùng sản phẩm thật từ AI0** (không dùng fake/mocks ở AI5):

- `C405-HTTP-PG`: signed synthetic webhook; sai chữ ký, OA sai, event trùng → backend/PG.
- `C405-AI2/AI3`: signed image, AI3 verified facts, worker generation/dedupe; tamper → HUMAN, không biến system marker thành customer confirmation.
- `C405-PLAN`: file nguồn/hình preview/manifest sau publication thay đổi → 409, không tin preview.
- `C405-ACK`: staff draft mất response sau commit → chỉ owner reconcile, không tạo đơn thứ hai.
- `C405-AGENT`: HTTPS loopback + PostgreSQL + Python agent `DryRunDriver`; UNKNOWN/restart không in thật.
- `C405-CHROMIUM`: chạy lại `scripts/browser-product.mjs` từ đúng checkout SHA, VITE_DEMO_MODE=false, 1440×900 và 390×844; PNG tamper bị ẩn, không tạo approve/print/delivery.

## Phần BLOCKED và việc tiếp theo

1. **AI1/AI2/AI0**: chưa bàn giao verified-event customer confirmation Port mới của CODE-401/402/007. Không dùng text `OK` hoặc event_id khách khai như chứng cứ. Các test CODE-405 về customer-confirm thông qua **sự kiện OA đã được xác thực**: **NOT RUN**, cần AI0 nối và đưa fixture signed/challenge rõ shop/OA/customer/conversation/order/revision/request_hash/quote_revision.
2. **AI3**: các kịch bản lost ACK/crash tại thời điểm agent thực nhận job vẫn cần xác minh từng boundary tương ứng; Python 140 PASS/1 SKIP không được diễn giải tất cả scenario đã PASS.
3. **AI0**: nhập đúng các thay đổi `tests/acceptance/**` mới của AI5 vào SHA tích hợp *mới*, chạy PG/HTTP/Chromium push CI đúng SHA mới; không lấy run cũ. Cần npm ci, DB riêng và Playwright đã cài.
4. **TN-037**: nhận diện ≥90%, hội thoại thông dụng ≥80%, 100 đơn/ngày, 210 đơn ≥7 ngày, OA/Ricoh/iPhone thật và duyệt chủ vẫn **NOT RUN/BLOCKED**. Không merge/deploy/nhắn OA/in thử thật.

**Bằng chứng riêng AI5 hiện tại:** `node --test tests/acceptance/code405-exact-sha.test.mjs` = **3 PASS/0 FAIL/0 SKIP** trên 2 file SHA-đối-chiếu byte-identical. Product PG/HTTP/Chromium **chưa chạy bản test AI5 mới**, không được cộng những test mới vào 58/43 hiện có.
