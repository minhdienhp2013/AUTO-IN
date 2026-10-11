# CODE-104 — giao diện / thông báo / bằng chứng (11/10/2026)

## Tình trạng

- Tạo React/TypeScript/Vite, dữ liệu mock có nhãn **MÔ PHỎNG**, adapter API với endpoint wire v0.1 và dữ liệu snake_case.
- Trang đăng nhập theo quyền server; tổng quan, đơn, tìm/lọc, chi tiết, năm trục trạng thái, kiểm preview/trang-mặt-tờ, giá/cọc, duyệt đúng phiên bản, thủ công, AI handover, tiền và giao (nút giao chỉ bật với VERIFIED_DONE).
- `UNKNOWN`/`SENDING`/`SENT_UNVERIFIED`: hiển thị đối soát, không cung cấp gửi lại. `SIMULATED_DONE`: mô phỏng, tuyệt đối không ghi đã in giấy thật. Chỉ server xác minh quyền; owner-only reprint/đóng ngoại lệ chưa có API nên không dựng nút giả.
- iPhone dùng layout CSS responsive breakpoint 760px với danh sách → chi tiết → quay lại; chưa có thử trên máy iPhone thật.
- Cài đặt lịch, mode, quy tắc khách: chỉ đọc mô tả và báo chưa sẵn sàng. Web Push chỉ có SW nhận thông báo/điều hướng, **chưa** subscription/backend và **chưa** thử iPhone.

## Kiểm thử đã chạy (thật tại môi trường thực thi, phần thuần TS)

`cd web && npm test`: 14/14 PASS trên Node v22.16.0 (node --experimental-strip-types). Các ca: duyệt phiên bản, preview không tin, quote >150 tờ, thiếu cọc, trạng thái in mơ hồ, idempotency trùng/khác payload, stale revision, giấy mô phỏng không giao thật, network fail, HTTP cookie/header, 401/403/409/503, mapping fail-safe, điều hướng thông báo.

## Chưa kiểm chứng / blocker

- `npm install`, `npm run typecheck`, `npm run build`, trình duyệt thật, Windows/iPhone: **CHƯA CHẠY** do môi trường không truy cập DNS `registry.npmjs.org` và không có local React/Vite dependencies. `package-lock.json` **chưa sinh**; không tạo lock giả. Cần kiểm trên máy có registry rồi lưu lock trong `web/**`.
- Không có API backend bản chạy tương thích để xác minh login/schemas/CSRF; backend mock chỉ là fixture; thanh toán và bàn giao thật không thử. Không có OA/Ricoh/iPhone, không có bằng chứng Web Push thật.
- Wire v0.1 chưa chốt request/response body, các tên trường view-model nêu trong `web/README.md` là tạm ở consumer và cần AI0 khóa trước khi nối thật.

## Đề nghị phối hợp

`[AI0] [CODE-104] Cần body/response/schema cho /api/v1/auth/me, /orders, /approvals, /quote, /payments, /deliveries, /manual, /conversations/* cùng mode/settings/notifications nếu được bổ sung; lý do UI chỉ có mapper provisional và fail-closed; xong khi test contract giữa AI0/AI1/AI4 pass.`

`[AI3] [CODE-104] Cần metadata preview đáng tin, URL truy cập theo quyền, trang/mặt/tờ đúng revision; lý do UI không thể giả preview/file thật; xong khi có fixture và test tích hợp đúng nguồn.`

`[AI5] [CODE-104] Nhờ chạy E2E thao tác trên Chromium + iPhone thật: quyền, bấm kép, stale revision, mất mạng, xem đúng đơn từ thông báo và layout nhỏ; xong khi có ảnh/trace và ma trận pass/fail.`

## Lượt CODE-104 tiếp theo: đối chiếu AI1 CODE-101

- Đã đọc thực tế `backend/api/routes.ts`, `backend/core/service.ts`, `backend/core/auth.ts` trên `ai1/nghiep-vu-ban-dau-v1` và cập nhật `web/src/api.ts`: `shop_id`/Bearer-only memory session; `/auth/me` trả `{principal}`, `/orders` trả `{orders}` và chi tiết `{order,revisions,jobs,quote,received_vnd,...}`. Không coi danh sách tóm tắt là xác nhận khách hoặc tình trạng in đã đủ tin cậy.
- Đã đồng bộ request `acknowledge_deposit_shortage`, `deposit_required_vnd`, `significant_cost`, `direction:'received'`, `bank_transfer`, `physical_sheets`, lý do manual. Đã nối nút kiểm tra giấy thực tế vào endpoint `POST /api/v1/print-jobs/{job_id}/verify-paper` chỉ khi `SENT_UNVERIFIED`/`UNKNOWN` có một job duy nhất, có ghi chú và số tờ nhân viên xác minh; không cho dùng SIMULATED_DONE.
- Chưa có GET confirmations/preview/file metadata nên việc duyệt trên live bị khóa an toàn; cần AI0/AI1 cấp read model có bằng chứng đáng tin. Hội thoại, lịch, chế độ server, owner reprint/close-exception chưa nối UI. Chưa có môi trường runtime AI0/PostgreSQL/in Ricoh để kiểm thử end-to-end.
- Đã thử `cd web && npm test` (23/23 PASS trên Node 22) và type-check riêng các module dữ liệu/port bằng TypeScript global; kiểm tra cú pháp TS/TSX. `npm install && npm run build`, Chromium/Playwright/iPhone thật CHƯA chạy vì npm registry không phân giải DNS và React/Vite chưa cài; chưa có lockfile sinh thật.

`[AI0/AI1] [CODE-104→CODE-000/101] [GET /orders/{id} read model xác nhận khách phiên/hash, quote confirmed, file preview/trust và audit; mode server] [UI hiện không đủ dữ liệu để bật duyệt an toàn] [Done khi schema+fixture backend xác minh, test contract AI4 đạt]`.