# AI5 — CODE-402: OA pending quarantine, nghiệm thu độc lập (14/10/2026)

## 1. Trạng thái hiện hành và bằng chứng chính xác

**Đã PASS các ca CODE-402 quarantine trên môi trường simulation, PostgreSQL thật cô lập. Chưa nghiệm thu Zalo OA thực tế hoặc TN-037.**

| Thành phần | SHA hoặc workflow | Kết quả |
|---|---|---|
| Product AI0 do AI5 nghiệm thu độc lập | `25a99ce2d0ddae673489361d7fceca56c3b60151` | Nền mã sản phẩm, không lẫn SHA overlay |
| AI5-only validation overlay | `413860824677f35a7211174d8f243f0bbb471685` | Product trên + **chỉ** `tests/acceptance/code402-official-quarantine-pg.test.mjs` và `tests/acceptance/run.mjs` |
| Independent AI5 Simulation integration (PUSH) | [#38489353875](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38489353875) | **SUCCESS**, PostgreSQL **109 PASS / 0 FAIL / 19 SKIP**; HTTP **62 PASS / 0 FAIL / 73 SKIP**; browser **58 PASS / 0 FAIL / 72 SKIP**; Chromium **14/14** trạng thái×viewport |
| Independent AI5 CODE checks (PUSH) | [#38489353886](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38489353886) | **SUCCESS**, kiểm mã/TypeScript/build |
| PR #31 AI0 tích hợp hiện tại | `a4de074aff009f26e1c172972369c43f101d653d` — **Draft** | Mới hơn product SHA được AI5 kiểm độc lập |
| PR #31 Simulation integration | [#38489898052](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38489898052) | **SUCCESS** trên HEAD tích hợp: PostgreSQL **109/0/19**, HTTP **62/0/73**, Chromium **14/14** |
| PR #31 CODE checks | [#38489897942](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38489897942) | **SUCCESS** trên HEAD tích hợp |

Các CI của PR #31 là kết quả kiểm tra **AI0 trên SHA tích hợp hiện tại**; không tuyên bố chúng là một lượt chạy AI5 độc lập mới. Lượt nghiệm thu AI5 độc lập thực tế là PUSH của overlay `413860824677f35a7211174d8f243f0bbb471685` trên product `25a99ce2d0ddae673489361d7fceca56c3b60151`.

## 2. Đường composition thực tế được nghiệm thu

Bài `tests/acceptance/code402-official-quarantine-pg.test.mjs` đã được cập nhật để chạy qua đường hiện hành:

`buildIntegratedApp` / Fastify raw-body `createOfficialZaloWebhookPlugin`
→ OA/shop và người gửi được ánh xạ từ **registry / identity map ở PostgreSQL phía máy chủ**
→ AI2 `createOfficialZaloVerifiedIngress`
→ sự kiện tin chữ đã ánh xạ vào `zalo_inbound_events` + `zalo_process_queue`; sự kiện **đã ký nhưng chưa được hỗ trợ hoặc chưa ánh xạ** vào `zalo_official_quarantine`.

Đây **không còn là** bài kiểm component gọi trực tiếp `createOfficialZaloIngress` chỉ nhận tin chữ, và **không** yêu cầu ảnh/file/click lưu dưới `kind=unsupported`, `QUEUED` trong hàng đợi văn bản. Bản ghi quarantine đang chờ đối soát có `status='NEEDS_HUMAN'`; `kind` được phân loại bảo thủ thành `image`, `file`, `click`, `unknown`. **Không diễn giải click thành CODE-401 consent hoặc tự tải file.**

| Case | Bằng chứng trên overlay AI5 | Kết quả |
|---|---|---|
| **C402-OA-01** | Chữ ký synthetic hợp lệ, `user_send_text` có ánh xạ OA/customer/conversation: đúng một event và marker `QUEUED` qua **hai pool PostgreSQL độc lập**; replay không trùng; text `OK` và trường `confirmation_postback` tự khai không tạo xác nhận | **PASS** |
| **C402-OA-02** | Ảnh ký synthetic, hai Fastify instances / hai pool, một custody receipt bền vững `kind='image'`, `NEEDS_HUMAN`, đúng OA và mapping máy chủ; replay/lost ACK cùng receipt và thời điểm nhận | **PASS** |
| **C402-OA-03** | File ký synthetic được giữ ở `zalo_official_quarantine`, `kind='file'`, `NEEDS_HUMAN`, không enqueue vào text worker hoặc tin cậy nội dung/tự tải file | **PASS** |
| **C402-OA-04** | Click/button ký synthetic nhưng chưa có hợp đồng xác nhận được giữ `kind='click'`, `NEEDS_HUMAN`; không tạo CODE-402 candidate, Core confirmation, duyệt hoặc print job | **PASS** |
| **C402-OA-05** | `user_send_text` ký synthetic **chưa có ánh xạ danh tính máy chủ** được giữ OA-level `kind='unknown'`, `NEEDS_HUMAN`, `customer_id=NULL`, `conversation_id=NULL`; **không lưu body trong hàng đợi text** và không đoán khách/cuộc chat | **PASS** |
| **C402-OA-RUNTIME (simulation)** | Real Fastify composition được inject **có chủ đích** và kiểm dữ liệu PostgreSQL; mặc định không inject plugin phải trả **HTTP 503 / FEATURE_UNAVAILABLE** | **PASS — simulation only** |
| **C402-OA-PILOT (real provider)** | Chữ ký thực Zalo OA, schema image/file/callback thực, mapping người thật, delivery/retry thật, xác nhận người dùng | **NOT RUN / BLOCKED** |

**Các assertion an toàn được giữ:** chữ ký MAC sai trả HTTP **403**; payload ký đúng MAC nhưng sai OA đích trả **422**; không tạo bản ghi lặp khi hai worker/replay; hash bytes gốc và `received_at` PostgreSQL được giữ; dữ liệu thiếu mapping không gán customer/chat tùy đoán; quarantine không chuyển thành candidate; **0** `core_confirmations`, `core_approvals`, `core_print_jobs`, `zalo_outbound` từ những ca này. Các case quarantine xác minh không xuất hiện thêm `zalo_inbound_events` / `zalo_process_queue` dành cho tin chữ.

## 3. Lịch sử RED đã được khắc phục — không xóa bằng chứng

- **Lịch sử trên mã sản phẩm cũ** `84cef429293eb4b6f49dac31e0078357d51cf1bc`: overlay `3ae9aec659e3b40e8a827f16f2660581bf6d76eb`, [Simulation #38454107754](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38454107754), PostgreSQL **105 PASS / 3 FAIL / 19 SKIP**. **OA-02/03/04 FAIL lúc đó** vì ingress cũ từ chối sự kiện đã ký không phải text trước khi lưu custody. Đây là **lỗi sản phẩm lịch sử, không phải trạng thái hiện nay**.
- Khi chuyển sang composition/quarantine hiện hành, overlay AI5 trung gian `f355f21f130224375225e9604e9a5b2ccb537a0c` [Simulation #38489047733](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38489047733) có **3 FAIL do test AI5 thiếu biến `secret`** trong ca kiểm MAC đúng/sai OA (và browser tổng quát timeout). Đây là lỗi harness AI5, không phải mất khả năng lưu quarantine.
- Sau khi sửa test, **không bỏ, nới assertion hay ẩn FAIL**, đã chạy lại toàn bộ trên overlay `413860824677f35a7211174d8f243f0bbb471685`, CI **SUCCESS** với **C402-OA-01/02/03/04/05 đều PASS**.

## 4. Ranh giới nghiệm thu và điều kiện mở vận hành

**Bằng chứng hiện tại là synthetic-only**, dù sử dụng Fastify thật và PostgreSQL 18.3 thật cô lập: dữ liệu, sự kiện và MAC được tạo bằng secret `synthetic-only-*`. Chưa có bằng chứng Zalo OA thật về **chữ ký header, chuỗi byte ký, schema ảnh/file/click/postback, danh tính khách/OA, callback, retry và SLA**. `user_click_button` trong fixture không chứng minh nút Zalo OA thật có hợp đồng CODE-401 xác nhận.

**Route OA thật vẫn TẮT.** HTTP 503 là hành vi mặc định khi plugin không được cấu hình; bật plugin trong test chỉ là injection runtime simulation có giới hạn, không bật production endpoint hoặc gửi phản hồi Zalo thật. Không dùng dữ liệu synthetic làm xác nhận khách hoặc cho phép in.

**NOT RUN / BLOCKED:** Zalo OA live, Windows/Ricoh thật, iPhone vật lý, kiểm tải 100 đơn/ngày, ≥210 đơn trong ≥7 ngày và toàn bộ TN-037. Các SKIP trong mode HTTP/browser là test PostgreSQL/integration-only không bật trong mode đó, **không phải PASS ngầm**.

**Tiếp theo AI0:** giữ PR #31 **Draft**, lấy tài liệu này làm bằng chứng đã cập nhật; khi SHA product tiếp tục thay đổi, nghiệm thu lại đúng SHA nếu cần. AI0/AI2 chỉ xem xét route official theo tài liệu provider và kiểm soát danh tính/chữ ký/duyệt có quyền sở hữu; AI5 nghiệm thu độc lập trước khi mở pilot thật. **Không merge main, deploy, gửi Zalo OA thật hay in máy thật trong công việc tài liệu này.**
