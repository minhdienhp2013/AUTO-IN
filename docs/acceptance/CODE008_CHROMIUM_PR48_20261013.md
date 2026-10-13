# AI5 CODE-008 — Chromium pending_updates PR #48: root cause và nghiệm thu 14/14

Ngày: 13/10/2026. **Chỉ sửa tests/acceptance/** và **docs/acceptance/**. Không sửa AI4/web, AI0/CI, không merge hoặc triển khai thật.

## Nguồn chính xác

- AI0 validation PR #48: `ai0/code008-ai4-ai5-validation-20261013`, HEAD **`816adb5fd7ff24cc98cd5841c95a8d25a523e45d`** (overlay 5 file AI4 + test AI5; chưa nhập PR #31/main). CI ban đầu [push Simulation integration #38368001297](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38368001297) browser RED; [PR workflow #38368017881](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38368017881) Chromium RED, PG **98 PASS/0 FAIL/19 SKIP**, HTTP **61 PASS/0 FAIL/63 SKIP**. Không dùng run PR merge-ref để thay push.
- AI5 verification branch độc lập `ai5/code008-chromium-diagnostics-pr48-20261013`: chỉ thay 3 file acceptance `code008-pending-chromium.{py,mjs}` và `code008-pending-chromium.test.mjs`; khởi đầu từ SHA `816adb5fd7ff24cc98cd5841c95a8d25a523e45d`, giữ nguyên toàn bộ sản phẩm và workflow AI0/AI4. **Final staging SHA `33f793af444045cbc1c15387ec748f00847a21a5`**.
- [Simulation integration PUSH #38369695822](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38369695822): **SUCCESS cả postgres job 115203316477 và product-browser job 115203316693**. [CODE checks PUSH #38369695850](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38369695850): SUCCESS.
- Trên final staging SHA, PG `--integration` **98 PASS/0 FAIL/19 SKIP** (117 tests); HTTP `--http` **61 PASS/0 FAIL/63 SKIP** (124 tests), Python/documents/DryRun và CODE-008/CODE-405 không bị bỏ test để đổi xanh. Browser acceptance runner **57 PASS/0 FAIL/62 SKIP** (119 wrapper tests; 62 SKIP vì PG tests không bật trong browser-only mode); trong đó **một browser wrapper đã chạy đủ 14/14 viewport×status assertions**, được xác nhận bằng 14 dòng PASS riêng trong job log. AI4 unit web **72 PASS/0 FAIL/0 SKIP**; generic Chromium product-browser desktop/mobile PASS.

## Nguyên nhân và cách sửa harness AI5, không phải lỗi giao diện AI4

1. Root cause thứ nhất: Python đã nuốt lỗi chi tiết, chỉ báo `AssertionError`; Node tầng ngoài cắt stderr còn 950 ký tự. **Sửa:** in `viewport`, `scenario`, `step`, traceback gốc Python/Playwright; Node thu đủ stdout và stderr (giới hạn 16k ký tự cuối) và không che stderr gốc, in đủ marker từng ca đã PASS. Không ghi credentials/bearer token/full page DOM.
2. Chạy lại trên staging `630c9feb...` rồi `397eb355...` phát hiện thực tế: Chromium **1440×900, processing(0)**. Mã UI hiển thị đúng `Trạng thái: processing` ở `data-testid=code008-pending-count`, còn `ĐANG CHỜ AI XỬ LÝ` ở **`data-testid=code008-blocked`**. Test cũ tìm thông điệp AI xử lý trong `pending-count`; đây là **assertion sai vị trí**. **Sửa test chặt hơn:** đòi đúng mã machine-readable, đúng cảnh báo hiển thị, đúng unresolved_count, không mở approve.
3. Lượt staging `de7afadf...` bộc lộ timing race: tiêu đề đơn hiện trước khi `GET /api/v1/orders/:id` hoàn tất, test đọc `pending-count` quá sớm. **Sửa:** Playwright `wait_for(state="visible", timeout=15000)` trước khi khẳng định trạng thái `clear`, blocked hay processing/HUMAN. Nếu thiếu trường thật, timeout gây FAIL (không skip/waive).
4. Staging cuối **`33f793af444045cbc1c15387ec748f00847a21a5`** chạy đủ 14/14 PASS: Desktop 1440×900 và mobile 390×844, mỗi viewport lần lượt **clear**, **processing(0)**, **needs_human(0)**, **processing(2)**, **needs_human(1)**, **stale_hash**, **missing**. Những ca có pending hoặc dữ liệu sai vẫn bắt buộc nút **approve bị khóa**; sai hash/missing phải hiển thị UNKNOWN và không hiện dữ liệu trạng thái cũ. Chỉ dùng fake *synthetic pending HTTP response* trên localhost Fastify gắn với đơn PostgreSQL test thật; **không phải Zalo OA/khách/Ricoh/iPhone thật**.

## Ma trận kết luận

| Mục | PASS | FAIL | SKIP / NOT RUN |
|---|---:|---:|---|
| 14 Chromium cases theo trạng thái/viewport, strict assertions | **14** | **0** | 0 |
| Generic Chromium product browser + tamper PNG | PASS desktop/mobile | 0 | 0 |
| PostgreSQL integration runner | **98** | **0** | 19 SKIP legacy |
| HTTP runner | **61** | **0** | 63 SKIP mode-specific |
| Browser-only runner | **57** | **0** | 62 SKIP vì PG mode không bật |
| Real OA, Ricoh printer, iPhone vật lý, TN-037, 210 đơn/≥7 ngày | — | — | **NOT RUN / BLOCKED** |

**Vẫn không được đánh dấu V1/TN-037 DONE**. Đây là nghiệm thu synthetic + real PostgreSQL/Chromium; 19/63/62 SKIP là từ các mode khác nhau, không thay thế bằng chứng chạy ở mode phù hợp. AI0 cần lấy **chỉ các file AI5** từ PR #18 mới để đồng bộ vào PR #48 hoặc một overlay SHA mới và chạy lại CI push đúng SHA đã nhập; **không merge/deploy**.
