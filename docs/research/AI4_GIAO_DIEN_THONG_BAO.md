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

## Đợt 3 — CODE-304 (AI1 ebdd740)

- Nguồn: nested read model `current`, `print_progress`, `conversation_control` trong AI1 `ebdd740`; map đúng `request_confirmation` theo revision/hash và `price_confirmation` theo quote_revision. Không tự suy ra xác nhận từ revision cũ.
- Preview `current.preview_ref` chỉ là artifact reference, **không phải URL per-file có quyền**, nên live approve tiếp tục khóa. Generation/status hội thoại lấy từ server; UNKNOWN và giấy giao một phần không trở thành giấy đã in đủ.
- Chặn mâu thuẫn: `print_progress.verified_sheets` không được vượt tổng bằng chứng `verified_sheets` của job thực (`controlled_test`/`production`); mode thiếu/simulation không tính.
- Chạy thật tại checkout AI4: `cd web && npm test` **40/40 PASS**; isolated TypeScript API/domain/fixtures/notifications PASS. `npm install --package-lock-only --ignore-scripts --no-audit --no-fund --fetch-retries=0` **FAIL EAI_AGAIN**; `npm ci --offline` **FAIL EUSAGE** vì chưa có lock; `npm run typecheck` và `npm run build` **FAIL TS2688** do chưa cài `vite/client`. Không tạo lockfile giả hoặc coi isolated typecheck là build.
- Browser desktop/mobile viewport, CODE-006 localhost/HTTP, iPhone/Ricoh/OA thật **NOT RUN**. PR giữ Draft, không merge/deploy/in thật.


---

## CODE-008 — Checklist thử thủ công trên iPhone Safari (chưa chạy)

**Trạng thái: NOT RUN — chưa có bằng chứng thử trên iPhone vật lý.** Đây là hướng dẫn nghiệm thu, **không phải** chứng nhận tương thích iPhone, Zalo OA thật hay máy in Ricoh/Windows. CI Chromium ở PR #84 HEAD `631cfbb063bf0d612609afb3ab91f2077d792ded` đã đạt **28/28 ca trên desktop 1440×900 và viewport mobile 390×844**, nhưng gọi **API synthetic bằng Playwright**; không thể thay kiểm tra Safari WebKit trên thiết bị thật.

### 1. Phiếu ghi môi trường bắt buộc trước mỗi lượt

| Trường | Ghi vào biên bản — không suy đoán |
| --- | --- |
| Người thử / ngày giờ / múi giờ | ______ / ______ / Asia/Bangkok (UTC+07:00) |
| **Model iPhone chính xác** | ______ (ví dụ: iPhone 14 Pro Max chỉ khi thực tế dùng máy đó) |
| **iOS phiên bản + build** | ______ (kiểm tra trên chính iPhone tại Cài đặt → Cài đặt chung → Giới thiệu) |
| **Safari phiên bản / build** | ______; nếu iOS không hiển thị bản Safari độc lập, ghi **"Safari hệ thống theo iOS [bản iOS]; số bản Safari riêng: không xác định"**, không tự gán một số phiên bản |
| **Viewport CSS px thực đo** | ______ × ______ ở dọc; ______ × ______ ở ngang; lấy `window.innerWidth` / `window.innerHeight` qua Web Inspector; **không mặc định** iPhone thật là 390×844 |
| Kích thước hiển thị vật lý / Display Zoom | ______ / ______ (có hoặc không phóng to); kích thước chữ nếu đổi: ______ |
| Safari URL / môi trường | ______ — chỉ staging/lab **đã được AI0 cho phép**, HTTPS hợp lệ; không dùng OA/khách thật |
| Git commit giao diện và backend | web SHA: ______; backend SHA: ______; link PR/CI: ______ |
| Nguồn test API | □ Fastify + PostgreSQL test cô lập □ proxy/lab synthetic □ khác: ______; nếu synthetic, ghi rõ **không phải product-backed** |
| Nhân viên/quyền mẫu và đơn test | mã định danh giả ______; revision ______; request_hash mẫu ______; **không** ghi mật khẩu, bearer token, nội dung khách thật |
| Bằng chứng | link screenshot dọc/ngang ______; screen recording ______; Safari Web Inspector network/console (đã che bí mật) ______; log server/audit + số đếm DB trước/sau ______ |

**Điều kiện mở đầu:** phiên đăng nhập là tài khoản *test*, đơn/khách/chat dùng dữ liệu giả; không dùng endpoint thật để gửi OA hoặc máy in. AI0/AI5 chuẩn bị order detail có `current.pending_updates` đúng `order_id`, revision, `request_hash` và từng biến thể bên dưới; việc sinh response fixture phải được đánh dấu **synthetic**. Kiểm thử chỉ xem/chuyển trang/làm mới; **không nhấn thực hiện xác nhận khách, duyệt in, gửi lệnh in, xác nhận giấy thật hay ghi thu tiền**. Nếu hệ thống staging không có cơ chế quan sát mutation, đánh dấu mục kiểm tra mutation là **NOT RUN**, không tự coi là PASS.

**Điều kiện phiên bản:** bộ giao diện cần bao gồm sửa banner PR #84 (`web/src/App.tsx`: `data-testid="api-error"` cho lỗi HTTP cụ thể; `data-testid="api-lock-banner"` cho cảnh báo khóa API toàn trang). PR #15 gốc **chưa** chứa sửa hai banner này; nếu bản Safari đang thử chưa có bản sửa, ghi **BLOCKED — build chưa đúng**, không chấm PASS cho hai cảnh báo riêng.

### 2. Ma trận thử thực tế trên iPhone (mọi kết quả mặc định NOT RUN)

Thực hiện mỗi ca ở **Safari iPhone vật lý**, tối thiểu chiều dọc và kiểm lại bố cục dọc/ngang, với số liệu/test fixture do AI0/AI5 cấp. Dùng Safari Web Inspector trên Mac (Develop → iPhone → trang đang mở) nếu có, quan sát Network/Console và đếm DOM `data-testid` trên *build thật đang chạy*. Lưu cả ảnh **danh sách đơn → chi tiết → nút quay lại** để phát hiện phần tử tràn/lệch/hết vùng chạm. Mỗi lần thay tình huống phải **làm mới / tải lại chi tiết từ server**, không coi dữ liệu lưu trên màn hình là bằng chứng đã đối soát.

| ID | Tình huống / thao tác xem | Kết quả phải xác minh trên màn hình |
| --- | --- | --- |
| IPH-01 | `clear` với `order_id`, revision và hash **đúng**, `unresolved_count=0`, `items=[]`; chưa có xác nhận khách/preview hợp lệ | Hiển thị `code008-clear` và giải thích CLEAR **chỉ đối soát tin/file**, không thay xác nhận khách. Nút `approve-action` **disabled** khi thiếu xác nhận khách hoặc preview. Chỉ **qua gate pending** khi CLEAR đúng scope; không tự kích hoạt duyệt. |
| IPH-02 | `processing(0,[])` trước khi có verified plan | Cảnh báo **ĐANG CHỜ AI XỬ LÝ**, hiển thị trạng thái `processing`; **0 mục không phải CLEAR**, `approve-action` disabled. |
| IPH-03 | `needs_human(0,[])` khi chưa chứng thực được liên kết nguồn | Cảnh báo **CẦN NHÂN VIÊN ĐỐI SOÁT**, hiển thị trạng thái `needs_human`, **không** coi 0 mục là hết chờ; `approve-action` disabled. |
| IPH-04 | `processing(2)` và `needs_human(1)` có metadata tin và file chờ; thay giữa hai dữ liệu | Hiển thị đúng count, nhãn/loại file–tin, cảnh báo tương ứng; không hiển thị nội dung riêng tư chưa kiểm chứng, **không nói "đã ghép vào đơn"**; nút duyệt disabled. |
| IPH-05 | Thiếu `current.pending_updates`, sai `order_id`, sai `revision`, sai `request_hash`, count/items mâu thuẫn (thử từng biến thể) | `code008-blocked` ghi **CHƯA XÁC ĐỊNH**, không hiện CLEAR của dữ liệu cũ, không cho duyệt; đổi revision phải yêu cầu khách xác nhận lại khi cần. |
| IPH-06 | API trả **401** cho GET chi tiết, phiên hết hạn / không còn token hợp lệ | Không cho xem/duyệt theo phiên cũ; trở lại yêu cầu đăng nhập nếu session bị thu hồi; không tự gọi approve/print. Ghi rõ cách UI thực tế trình bày 401 và thông báo đăng nhập; không yêu cầu 2 banner giống 409 khi session đã bị xóa. |
| IPH-07 | API trả **409** khi đọc chi tiết / phiên bản thay đổi (fixture hoặc staging có chủ đích) | Thông báo lỗi 409 ở **`api-error`** và cảnh báo toàn trang **`api-lock-banner`** cùng hiện **mỗi loại đúng một**, có nội dung khác chức năng. `code008-blocked` = **CHƯA XÁC ĐỊNH**; `approve-action` disabled; không tự retry mutation. |
| IPH-08 | **Offline**: ngắt Wi-Fi/di động sau khi mở trang và làm mới đơn; bật lại mạng rồi tải lại | Có thông báo lỗi kết nối ở `api-error` **và** cảnh báo khóa thao tác ở `api-lock-banner`; trạng thái chưa xác định, dữ liệu cũ chỉ đọc; duyệt disabled. Sau khi có mạng, chỉ cho hiển thị CLEAR nếu **GET chi tiết mới** đúng scope. Không tự lặp lệnh in/approve. |
| IPH-09 | API trả **503** hoặc response lỗi không đọc được | Cảnh báo lỗi chi tiết và cảnh báo khóa API có `data-testid` riêng; không tự xem lỗi là hoàn thành, không bỏ cảnh báo tổng; nút duyệt disabled, mutation bằng 0. |
| IPH-10 | Đơn đã staff approve / `print_closed` / manual lock, sau đó có tin/file mới hoặc quay lại đơn cũ | Không sửa âm thầm giá/yêu cầu trên đơn đã chốt, không tự thêm tin/file vào revision cũ, không tự in lại; yêu cầu mới theo quy trình tạo đơn mới có xác nhận/duyệt phù hợp. |

### 3. Bằng chứng bắt buộc cho từng ca (FAIL hoặc thiếu bằng chứng ≠ PASS)

- **Hình / video:** ảnh chụp màn hình **iPhone thật** hiển thị cảnh báo, phiên bản, đúng trạng thái và nút duyệt bị vô hiệu; một video ngắn nếu có thao tác đổi mạng, 401, 409 hoặc chuyển dọc/ngang. Ẩn thông tin khách/tài khoản/token.
- **DOM / Network:** log Safari Web Inspector với timestamp, URL endpoint test và mã HTTP (401/409/503), trạng thái offline; khi hiển thị hai cảnh báo, xác minh **`[data-testid="api-error"]` đúng 1**, **`[data-testid="api-lock-banner"]` đúng 1**, cả hai đều đọc được, `[data-testid="code008-blocked"]` hiện **CHƯA XÁC ĐỊNH**. Nếu không có Web Inspector thì đánh dấu phần đếm DOM **NOT RUN**, nhưng vẫn phải có ảnh hai cảnh báo để đánh giá thủ công.
- **Không mutation:** ghi số lần gọi **POST/PUT/PATCH/DELETE tới các endpoint nghiệp vụ** (approve, print job, xác nhận khách, sửa đơn) trong Network: **0**; ngoại lệ POST đăng nhập test được ghi tách biệt. Nếu có quyền đọc DB test, AI0/AI5 so sánh số dòng `core_confirmations`, `core_approvals`, `core_print_jobs` trước–sau: **không tăng**. Không gửi dữ liệu khách thật, không lưu credential vào video/HAR.
- **Lưu theo ca:** `IPH-xx | thiết bị | iOS/Safari | viewport CSS px | UI SHA | backend SHA | kiểu API (synthetic/PG) | PASS/FAIL/BLOCKED/NOT RUN | ảnh/video/log | số mutation trước/sau | lỗi & AI phụ trách`. Nếu thiếu model/iOS/viewport hoặc bằng chứng khóa duyệt/no mutation, **không ghi PASS**.

**Điều kiện kết luận:** chỉ ghi **PASS iPhone Safari thực tế** sau khi có thiết bị, dữ liệu kiểm thử an toàn, thao tác chạy và đủ bằng chứng. Nếu chưa có iPhone/môi trường/tester hoặc chưa xuất được log mutation, giữ **NOT RUN/BLOCKED** đúng mục. Mốc Chromium synthetic PR #84 (28/28) chỉ là tham chiếu hồi quy, **không** thay nghiệm thu Safari hay chứng minh Zalo OA, Ricoh, in giấy thật, TN-037/V1.


## TN008-WEBKIT-REGRESSION-01 — WebKit thông báo (17/10/2026)

- Overlay AI4 **trực tiếp từ candidate PR #144 HEAD `0673460af71205986b901a21fc7724dbea23c991`**. Không sửa `web/src/notifications.ts`, SettingsView, service worker, backend, CODE008/CODE501 browser tests hoặc workflow gốc. Hai file bổ sung: `tests/ui/notification_webkit_browser.py` và script `web/package.json`.
- **Trình duyệt:** Playwright **WebKit thật** chạy UI production React/Vite đã build (`VITE_DEMO_MODE=false`), hai viewport 1440×900 và 390×844. **Synthetic:** `window.Notification`/permission và API đăng nhập/GET shop là fixture vô danh trong context, không cấp quyền hệ điều hành; không có sự kiện OA/khách hay backend Push. Không sử dụng WebKit làm tên thay thế cho Safari trên iPhone vật lý.
- **10 tình huống × 2 viewport = 20 ca:** thiếu `Notification`, không có phương thức `requestPermission`, insecure context giả lập, `denied`, `default`, `default` còn giữ nguyên sau hỏi quyền, `granted`, Promise reject, reject rồi thử lại thành công, và một yêu cầu pending chặn nhấn lặp.
- **Assertion chính xác:** `Trình duyệt hoặc kết nối HTTPS chưa hỗ trợ thông báo`; `Đã từ chối quyền — kiểm tra cài đặt trình duyệt`; `Chưa cấp quyền thông báo`; `Đã cấp quyền, chưa nối Web Push`; `Yêu cầu quyền thất bại. Có thể thử lại; Web Push chưa kết nối.` Đồng thời mọi trạng thái phải giữ câu **`Web Push thật chưa được kết nối; thông báo sẽ mở đúng đơn sau khi có backend phát Push được xác thực.`**
- Không tự hỏi quyền khi tải trang/vào Settings; kiểm số lần gọi prompt; `granted` không chứng minh subscription, không tự gọi `PushManager.subscribe()`, không request endpoint push/backend, không tạo mutation/duyệt/in, không unhandled JS error. Chỉ nhập credential **synthetic** vào API fixture.
- **Yêu cầu AI0 tích hợp CI (không giao AI4 sửa workflow):** trong web-quality sau checkout đúng SHA, Node/npm install, production build và cài Python 3.12, chạy:

```sh
python3 -m pip install playwright==1.58.0
python3 -m playwright install --with-deps webkit
cd web
npm ci
VITE_DEMO_MODE=false npm run build
npm run test:webkit:notifications
```

- Bản test **fail** nếu binary WebKit hoặc dist thực sự thiếu; không fallback Chromium. Không ghi PASS WebKit cho đến khi log 20/20 xuất hiện trên đúng SHA. Bằng chứng Safari iPhone 14 Pro Max vật lý **IPH-01–IPH-10 = NOT RUN**, Web Push subscription/VAPID/push provider và Zalo OA/Ricoh thực **NOT RUN**. Không merge/deploy.
