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

## CODE-204 / Đợt 2 — nhánh ai4/dot2-web-build-readmodel

- Nền module `fde9cdccb6aad888fada378567590f8f325ab635`, khung AI0 `a681fe91f24f3b0cec61cb72887cc0928d9460ca`; nhánh riêng chỉ sửa `web/**`, `tests/ui/**` và báo cáo AI4 này. Khung AI0 được nhập bằng merge nội bộ trên nhánh AI4, không merge PR/deploy.
- Đã khai báo `ImportMetaEnv` có `VITE_DEMO_MODE`, `VITE_API_BASE_URL` dưới `web/src/vite-env.d.ts`; sửa `isDemo` dùng `Pick<ImportMetaEnv,'VITE_DEMO_MODE'>` thay vì ép kiểu `any`. Đây là sửa nguyên nhân TS2559; **chưa xác minh bằng Vite typecheck thật** vì thiếu package npm.
- Dữ liệu tiền/giấy dùng converter PostgreSQL `BIGINT` dạng chuỗi chữ số nguyên hợp lệ, từ chối số vượt `Number.MAX_SAFE_INTEGER`; không biến số thiếu tin cậy thành số thực. Giấy `VERIFIED_DONE` chưa có `verified_sheets` hoặc thấp hơn kế hoạch **không được hiển thị giao đủ**. Nút giao yêu cầu số giấy thật đã kiểm còn lại. Không dùng `SIMULATED_DONE`/spooler làm bằng chứng giấy.
- AI1 CODE-201 đã khai báo POST handover/return-to-ai với `expected_generation`; UI gửi `idempotency_key` và generation khi có read model xác thực; bắt buộc phản hồi `conversation_id`/`status`/generation hợp lệ. Khi chưa được API GET trả generation, nút live vẫn khóa (fail closed), không giả giá trị `0` hay `1`; hai người cạnh tranh/403/409/mất mạng không tự retry.
- Thêm `data-testid` cố định cho AI5 (`operation-mode`, `staff-login`, `order-list`, `order-detail`, `approve-action`, `api-error`); đây là điểm nối để viết E2E, **không phải bằng chứng đã chạy browser/iPhone**.

### Lệnh và kết quả thực tại môi trường lượt này

- `cd web && npm test`: **30 PASS, 0 FAIL** (Node v22.16.0), gồm 4 ca giấy thật/BIGINT, 3 ca hội thoại/generation/409/403/mạng, 23 ca gốc.
- TS/TSX module `App.tsx`, `api.ts`, `domain.ts`, `fixtures.ts`, `main.tsx`, `notifications.ts`: **transpile syntax PASS** bằng TypeScript global. `node --check public/sw.js`: PASS.
- `npm install --package-lock-only --ignore-scripts --no-audit --no-fund --fetch-retries=0 --fetch-timeout=5000`: **FAIL DNS EAI_AGAIN** `registry.npmjs.org`; không có metadata package để khóa dependencies đầy đủ; không sinh lock giả.
- `npm ci --offline`: **FAIL (thiếu `web/package-lock.json`)**. `npm run typecheck` / `npm run build`: **FAIL TS2688 `vite/client` chưa cài**; không thể coi TS2559/build đã được xác minh bằng Vite. Browser Chromium viewport/Windows/iPhone/Web Push: **NOT RUN** khi chưa có app bundle và server.

### Điều kiện giải blocker và bàn giao

1. Khi npm registry hoạt động trên môi trường build đáng tin: `cd web && npm install --package-lock-only --ignore-scripts`, commit `web/package-lock.json` sinh thật; `npm ci`, `npm test`, `npm run typecheck`, `npm run build`, giữ log exit code. Không tự sửa root config/lock.
2. `[AI1/AI0] [CODE-201/006→CODE-204]` Cấp GET chi tiết có xác nhận khách `revision/hash`, xác nhận giá `quote_revision`, preview per-file có kiểm quyền/độ tin cậy, generation/status/claimed_by hiện hành của hội thoại, mode/lịch; cần để UI mở nút duyệt/tiếp quản một cách xác thực. Điều kiện xong: schema/fixture + HTTP tests có nguồn từ server.
3. `[AI5] [CODE-205]` Chạy browser E2E Windows/mobile 390×844 và desktop 1440×900, mất mạng/401/403/409/bấm kép/stale revision, xác nhận cảnh báo demo; iPhone và Web Push thật phải kiểm riêng, không coi desktop mock là đủ.

Trạng thái CODE-204 tại thời điểm bàn giao: **BLOCKED vì lockfile/build/npm registry và read model thiếu**; đã đưa sửa code + kiểm thử thuần TS lên nhánh, không merge/deploy/in thật.

## CODE-304 — nested read model AI1 (đợt 3)

- BASE `694179cd5ac6804d276da837b3cded2e89da3c4d`, nguồn read model AI1 `ebdd740d87b3bb72fd7f1229b2ab2e728f55f0bc`, nhánh `ai4/dot3-web-contract-lock`.
- Đã đối chiếu `backend/core/service.ts:getOrder` và `backend/core/model.ts:PrintPlan` của AI1. Mapper đọc `current.{revision,request_hash,verified_plan,request_confirmation,price_confirmation,approval,preview_ref}`, `print_progress`, `conversation_control`. Kiểm phiên bản/hash/quote_revision, BIGINT an toàn, generation/status/claimed_by; lỗi thiếu dữ liệu thì không suy đoán.
- Xác nhận yêu cầu/giá và trạng thái đơn lấy từ server đúng phiên; giấy mô phỏng không thành giấy thật; UNKNOWN giữ đối soát; chỉ hiển thị giao đủ khi giấy thật được xác minh và server không còn reconciliation. Cọc thiếu vẫn là cảnh báo, không tự cấm duyệt; kiểm duyệt live vẫn khóa vì thiếu danh sách file và URL preview per-file được cấp quyền. `preview_ref` của processor là ref nội bộ, **không tự biến thành URL public**.
- **PASS:** `cd web && npm test` 38/38 (30 ca cũ + 8 ca nested); TypeScript isolated strict API/domain/fixtures/notifications PASS bằng TS global 5.8.3 và khai báo ImportMeta tạm **ngoài repo**, không gọi là Vite build.
- **FAIL/BLOCKED:** `npm install --package-lock-only --ignore-scripts --no-audit --no-fund --fetch-retries=0 --fetch-timeout=4500` trả `EAI_AGAIN registry.npmjs.org`; `npm ci --offline` fail vì thiếu lockfile; `npm run typecheck` và `npm run build` fail TS2688 `vite/client` do chưa có deps. Không tạo lockfile giả.
- **NOT RUN:** browser viewport desktop/mobile, HTTP CODE-006/PostgreSQL, iPhone/Web Push, máy in thật. Không merge/deploy/in thật.

**Yêu cầu AI0/AI1:** cung cấp danh sách file và URL preview có kiểm quyền/độ tin cậy gắn revision/hash, đồng thời SHA API simulation CODE-006 để AI4+AI5 chạy browser; khi npm registry khả dụng phải sinh `web/package-lock.json` bằng npm và chạy `npm ci && npm test && npm run typecheck && npm run build`.
