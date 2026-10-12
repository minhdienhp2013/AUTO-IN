# AUTO-IN Minh Điến — giao diện CODE-104

Ứng dụng React + TypeScript + Vite độc lập (AI4). Mặc định **MÔ PHỎNG**, dùng dữ liệu tổng hợp trong `src/fixtures.ts`; không kết nối Zalo/Ricoh, không nhận tiền thật.

## Chạy thử

Yêu cầu Node >=20.19.0. Cần kết nối registry/npm để cài đúng các phiên bản đã ghim trong `package.json`:

```bash
cd web
npm install
npm run dev
npm test
npm run typecheck
npm run build
```

Mở `http://localhost:5174` (cấu hình máy khác vào LAN chỉ cho môi trường demo được phép). **Chưa có lockfile** do môi trường thực thi AI4 không truy cập registry; cần tạo `web/package-lock.json` bằng `npm install --package-lock-only` và CI kiểm tra sau khi có registry. Không khẳng định đã build/test trình duyệt khi chưa có dependencies. Không chỉnh lock/config root (AI0 quản lý).

## Mô phỏng/live

Mặc định `VITE_DEMO_MODE` không có hoặc khác chuỗi `false`: mô phỏng, có nhãn trên header và trên chi tiết. Tài khoản giả lập trong test: `demo-staff` hoặc `demo-owner` (chỉ đổi vai trong phiên demo). Không dùng dữ liệu/credential thật ở demo.

Để gọi server thật, cần xác nhận contract và môi trường bảo mật: `VITE_DEMO_MODE=false VITE_API_BASE_URL=https://<server-duoc-cap-quyen> npm run dev`. Live theo CODE-101 của AI1 dùng đăng nhập gồm `shop_id`, `username`, `password` và phiên **Bearer token chỉ giữ trong bộ nhớ**; `/api/v1/auth/me` kiểm tra principal từ server. Không lưu token/quyền vào localStorage, sessionStorage hoặc URL; tải lại trang phải đăng nhập lại. Cần cùng origin hoặc cấu hình CORS server an toàn trước khi thử ngoài localhost. HTTP/network/401/403/409/503 trả lỗi rõ, **không fallback sang demo**. Chưa có API để đọc mode server nên header ghi **CHƯA XÁC MINH CHẾ ĐỘ SERVER**; không tự đoán live là production. Tránh cross-origin chưa cấu hình CORS/CSRF.

Mọi thao tác ghi yêu cầu phiên bản gửi `expected_revision`, `request_hash`, `idempotency_key` và `Idempotency-Key`; khóa nút khi đang gọi. 409 tự tải phiên bản mới và yêu cầu người thao tác lại; không retry tự động. Sau API thành công vẫn tải lại trạng thái server nếu mutation chỉ trả biên nhận. Server luôn kiểm quyền/phiên bản, client chỉ hiển thị gợi ý.

## Lối nối còn chờ AI0 / AI1 / AI3

- **AI1 hiện có (CODE-101)**: đã đối chiếu các route hiện hữu và dùng mapper riêng cho `{orders:[...]}` và `{order,revisions,jobs,quote,received_vnd,...}`. Đã đồng bộ tên `acknowledge_deposit_shortage`, `deposit_required_vnd`, `significant_cost`, `direction:'received'`, `method:'bank_transfer'`, `physical_sheets`, `reason`, `evidence_kind:'staff_inspected'`. `verify-paper` chỉ mở cho một job thật `UNKNOWN`/`SENT_UNVERIFIED` và phải nhập số giấy/ghi chú sau kiểm tra trực tiếp. Chưa có server chạy/PG thật để test HTTP live.
- **AI0/AI1 cần bổ sung read model**: xác nhận khách theo phiên/hash, xác nhận giá/quote_revision, preview từng file/trust, tổng trang/mặt/tờ và cảnh báo, hội thoại/owner permissions/audit, chế độ/lịch/notification. API AI1 hiện trả dữ liệu lõi nhưng **không trả confirmations và preview** nên trên live duyệt in vẫn bị khóa (an toàn). Route owner `reprint`/`close-exception` đã có trong AI1 nhưng UI chưa mở vì thiếu quy trình đối soát và xác thực nghiệm thu. Live handover/return-to-AI tạm khóa vì AI1 chưa register route hội thoại.
- **AI3**: URL preview ngắn hạn an toàn theo phiên, độ tin cậy preview, số trang/mặt/tờ kiểm chứng bằng processor. Không dựng bản xem trước giả khi thiếu.
- **AI0/AI2**: backend phát Web Push (VAPID/subscription, quyền truy cập, lịch/khẩn). `public/sw.js` chỉ xử lý payload `order_id`/revision & điều hướng cùng origin; cấp permission không có nghĩa push đã hoạt động. Phải thử trên iPhone thật.

Không có nút in trực tiếp, gửi lại lệnh, đóng ngoại lệ đã in, mở production trên giao diện V1 này. Mọi máy in thật cần duyệt và thiết bị kiểm chứng trước.

## Đợt 2 — CODE-204 (trạng thái kiểm chứng)

Cần `web/package-lock.json` **sinh bằng npm từ registry thật** trước khi chạy `npm ci`; phiên thực thi AI4 này không thể truy cập registry (`EAI_AGAIN`), vì vậy **chưa có lock và chưa đạt build**. Dependency đã ghim phiên bản trong `package.json`; không thay bằng lockfile viết tay/thiếu đồ thị gói. Kiểm thử phần thuần: `cd web && npm test` **30/30 PASS** trên Node22, transpile syntax các module và syntax SW PASS. `npm run typecheck`/`npm run build` FAIL thiếu `vite/client` do chưa cài dependency — cần chạy lại sau khi cài, không báo pass thay thế.

AI1 CODE-201 đã thêm hai route handover/return-to-ai. UI cần `conversation_generation` do server xác minh trước khi gửi `expected_generation`. Backend hiện **chưa trả generation qua GET chi tiết**, nên live nút vẫn khóa. Biên nhận phải có `conversation_id`, `status`, generation mới; lỗi 403/409/mạng không tự thử lại. Đơn live vẫn khóa duyệt nếu không có confirmation đúng phiên bản và preview tin cậy; mode không xác minh là `unverified`. Đã thêm test IDs: `operation-mode`, `staff-login`, `order-list`, `order-detail`, `approve-action`, `api-error` cho AI5 viết browser test sau khi có build.

## CODE-304 — nested read model AI1

`mapCoreOrderDetail` consumes AI1 CODE-301 `GET /api/v1/orders/{id}` fields:
`current.{revision,request_hash,verified_plan,request_confirmation,price_confirmation,approval,preview_ref}`,
`print_progress.{planned_sheets,verified_sheets,fully_verified,requires_manual_reconciliation}` and
`conversation_control.{status,generation,claimed_by}`. It checks current revision/hash and
quote confirmation revision, keeps UNKNOWN and partial paper independent from delivery,
and maps conversation generation only when the server returns a valid control state.

**Important:** AI1's `preview_ref` is an internal artifact reference, not an authenticated
per-file browser URL. No preview/document list is fabricated from this reference, and
live approval remains disabled until AI0/AI1 expose a trusted, authorized per-file
preview/read model. Simulation is not physical paper. The UI does not issue print commands.

To reproduce when the npm registry is available:

```sh
cd web
npm install --package-lock-only --ignore-scripts --no-audit --no-fund
npm ci
npm test
npm run typecheck
npm run build
```

`web/package-lock.json` must be generated by npm from the pinned manifest; do not
hand-author a fake lockfile. Browser desktop/mobile viewport E2E additionally requires
a running CODE-006 simulation API and installed browser test dependencies. Testing a
mobile viewport is not testing a physical iPhone.

### CODE-304 — kiểm tra bổ sung (11/10/2026)

- Mapper nested từ AI1 `ebdd740` đã kiểm thử với 40/40 bài unit (30 cũ + 10 nested/giấy thật). Dữ liệu `print_progress.verified_sheets` không được vượt tổng số tờ có bằng chứng từ job gửi ở chế độ `controlled_test`/`production`; mode thiếu/simulation không được tính.
- `tsc` kiểm tra độc lập các module `api.ts`, `domain.ts`, `fixtures.ts`, `notifications.ts` PASS với khai báo ImportMeta tạm **không phải** build Vite.
- npm registry báo `EAI_AGAIN` nên không sinh được `web/package-lock.json` thật. `npm ci --offline` FAIL thiếu lock; `npm run typecheck` và `npm run build` FAIL `TS2688` thiếu `vite/client`. Không tự tạo lockfile giả, không báo Vite build PASS.
- Browser desktop/mobile, CODE-006 localhost, PostgreSQL, iPhone thật: chưa chạy. Nút duyệt live tiếp tục khóa khi không có preview per-file được xác thực.

### CODE-304 — đối chiếu PR tích hợp #21 (`15c1ac75859914b2cc07d5a98bf57c18973cbbb2`, 12/10/2026)

Nguồn live được kiểm lại theo `backend/api/routes.ts` và `backend/core/service.ts` trên
[PR #21](https://github.com/minhdienhp2013/AUTO-IN/pull/21). AI1 đã trả
`current`, `print_progress`, `conversation_control` qua `GET /api/v1/orders/:order_id`;
`POST /api/v1/print-jobs/:job_id/verify-paper` trả biên nhận gồm `job_id`,
`state`, `verified_sheets`, `planned_sheets`. Khi nhân viên xác minh **một phần**,
server trả `UNKNOWN` và số tờ đã kiểm, KHÔNG trả `VERIFIED_DONE`. Client giờ
chấp nhận đúng biên nhận `UNKNOWN` có đếm giấy, sau đó đọc lại GET để so
khớp trạng thái/số tờ; biên nhận thiếu, dữ liệu đọc lại cũ hoặc mâu thuẫn đều
trả lỗi đối soát, không tạo trạng thái thành công từ UI.

Bộ mapper chặn tình huống jobs tự khai `VERIFIED_DONE` nhưng thiếu số tờ,
`evidence_kind` không thuộc `staff_inspected`/`device_verified`, mode gửi
không rõ/simulation, đếm thiếu, hoặc mâu thuẫn với `print_progress`. Khi đó
UI hạ trạng thái xuống `UNKNOWN`, ghi cảnh báo và không hiển thị đã in/giao đủ.
Job của revision/hash cũ không cộng thành giấy thật cho revision hiện hành;
spooler không xác minh được giấy. Đã có regression tests cho cả ca này.

**Kết quả chạy độc lập (Node v22.16.0, npm 10.9.2):**

| Lệnh | Kết quả |
| --- | --- |
| `cd web && npm test` | **PASS 45/45**, 0 FAIL |
| TypeScript strict API/domain/fixtures/notifications bằng `tsc` global với `ImportMetaEnv` shim tạm *chỉ cho isolation* | **PASS**; **không** coi là Vite build |
| `node --check web/public/sw.js` | **PASS** |
| `npm install --package-lock-only --ignore-scripts --no-audit --no-fund --fetch-retries=0 --fetch-timeout=5000` | **BLOCKED** `EAI_AGAIN: getaddrinfo registry.npmjs.org` |
| `cd web && npm ci --ignore-scripts --no-audit --no-fund` | **BLOCKED** `EUSAGE` — chưa có `web/package-lock.json` thật |
| `cd web && npm run typecheck` | **BLOCKED** `TS2688 Cannot find type definition file for 'vite/client'` (thiếu dependency npm) |
| `cd web && npm run build` | **BLOCKED** cùng TS2688, chưa chạy được Vite bundle |

**Browser:** chưa có bundle và server web chạy được, nên Chromium desktop
**1440×900** và mobile viewport **390×844** đều **NOT RUN** (0 kích thước
được kiểm chứng); không báo đây là test trình duyệt hoặc iPhone thật.

**Phụ thuộc:** `[AI0/CI] [CODE-006→304]` Chạy `npm install --package-lock-only`
trong môi trường npm registry hoạt động, bàn giao lockfile sinh thật cho AI4,
sau đó `npm ci && npm test && npm run typecheck && npm run build` và browser
1440×900/390×844. AI4 không chạm CI/root config. `[AI0/AI1/AI3]` Cấp
preview per-file có phân quyền nếu muốn mở duyệt live; internal `preview_ref`
không đủ điều kiện. Không merge/deploy, không bật in hoặc OA thật.

## CODE-304 — continuation on AI4 PR #15 (2026-10-12)

- Source branch before change: `ai4/dot3-web-contract-lock` at `8859d8639fb88345e0ef145856c28222fd245f00`, integration reference PR #21 at `15c1ac75859914b2cc07d5a98bf57c18973cbbb2`. No merge/deployment.
- Delivery axis matches AI1 `OrderService.deliver`: real **staff-inspected partial paper** of an `UNKNOWN` job can be handed over up to the **server-evidenced** remaining count, while the print axis remains `UNKNOWN` and still needs reconciliation. `SIMULATED_DONE`, `SENDING`, `SENT_UNVERIFIED`, missing evidence, and exhausted verified quantity **cannot** enable delivery. The backend remains the authority on delivery; this UI helper does not report successful printing.
- Preview remains locked: AI1 GET current `preview_ref` is an internal artifact reference, not an authenticated per-document preview URL. `mapCoreOrderDetail` therefore deliberately returns `documents: []`; client approval stays disabled.
- Commands attempted in this environment: `npm install --package-lock-only --ignore-scripts --no-audit --no-fund --fetch-retries=0 --fetch-timeout=4000` => **FAIL EAI_AGAIN** (`getaddrinfo registry.npmjs.org`, metadata `@types/react`); `npm ci --offline --ignore-scripts --no-audit --no-fund` => **FAIL EUSAGE** (no lockfile); `npm test` => **48/48 PASS**; `npm run typecheck` and `npm run build` => **FAIL TS2688** (`vite/client` package unavailable). Because `npm install` did not succeed, `web/package-lock.json` does **not** exist. Do not generate it manually. See local logs from this session when provided as handoff artifact.
- Chromium desktop **1440 x 900** and mobile **390 x 844**: **NOT RUN**, since required React/Vite packages and successful build are absent. Backend simulation was not launched. No real iPhone, Zalo, or printer test was performed.
- Next action when npm registry is reachable: from `web/`, run `npm install --package-lock-only --ignore-scripts && npm ci && npm test && npm run typecheck && npm run build`, commit real `web/package-lock.json`, run Chromium at the above viewports against simulation, capture screenshots/console/network, and verify `UNKNOWN`, partial evidence, simulated output and untrusted preview.

## CODE-404 — giao diện xác nhận có chứng cứ (12/10/2026)

- Nguồn tích hợp AI0 `3f0380abed2294fc18d09294cd6a8c9562108710`: đã đồng bộ đúng patch `web/src/{api,App,domain,styles}` và `web/package-lock.json` npm **thật**, không tự dựng. Preview chỉ qua Bearer catalog+PNG, đối chiếu order_id/active revision/request_hash/URL/index, metadata AI3; gallery blob URL được revoke khi unmount/đổi revision/hash.
- CODE-404 thêm ba trục hiển thị riêng **khách xác nhận đúng revision/hash / yêu cầu báo giá / chờ nhân viên duyệt** lấy từ nested read model. Nhân viên KHÔNG có nút xác nhận thay khách, không tự duyệt, và preview không biến giấy mô phỏng/UNKNOWN thành giấy thật.
- Session token được chụp *trước* GET catalog; logout/đổi tài khoản trong lúc tải khiến mọi ảnh bị từ chối, PNG 401 xóa token. 409, 401, offline khiến thao tác duyệt bị khóa cho tới khi GET hiện hành thành công.
- Test mới: `tests/ui/confirmation-readiness.test.ts` (6 case), `tests/ui/code404-preview-security.test.ts` (5 case); dùng fixture synthetic, không Zalo/Ricoh. Xem bàn giao PR #15 cho SHA và phân loại npm/build/browser thực tế.
