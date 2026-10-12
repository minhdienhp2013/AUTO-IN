# CODE-008 — AI5 nghiệm thu quy tắc một đơn trước chốt in (12/10/2026)

## Tách nguồn code, fixture và kết luận

- **AI0 PR #31:** base tích hợp được kiểm `c88fa3b570e360c6fb013930392e00c7dc81d3d0` (có `conversation-order-guard.ts` và migration PostgreSQL simulation-only `004_pending_approval_gate.sql`). HEAD PR31 tại lúc ghi ma trận: `c88fa3b570e360c6fb013930392e00c7dc81d3d0`.
- **AI5 PR #18:** giữ nhánh `ai5/dot3-integrated-acceptance`; mọi thay đổi của đợt CODE-008 chỉ nằm trong `tests/acceptance/**`, `docs/acceptance/**`, không sửa AI1/AI2/AI0.
- **Staging có chạy PostgreSQL thực:** `7dfefc4e51f0e603c38411f2ed85ac3ac90cc489`, nhánh `ai5/code008-test-staging-20261012` = **AI0 code base c88fa3b + chỉ 3 file test AI5**; không merge hoặc deploy staging. Đây không phải SHA của PR #18, nên ghi riêng.
- CI **push đúng SHA staging**: [CODE checks run #38245126222](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38245126222) **PASS**; [Simulation integration run #38245126219](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38245126219) có Chromium **PASS**, PostgreSQL acceptance **FAIL (2 blocker thật)**, không giả toàn workflow xanh.
- [Log PostgreSQL job #114796979545](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38245126219/job/114796979545) — PostgreSQL **18.3**, cô lập `autoin_test_305`, npm ci/migrate/check/AI3 thực; `node tests/acceptance/run.mjs --integration` **110 tests = 89 PASS / 2 FAIL / 19 SKIP**, 0 CANCELLED, 0 TODO.
- Chromium desktop **1440×900** + mobile viewport **390×844** từ [product-browser job #114796979435](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38245126219/job/114796979435) **PASS** với React/Fastify/PostgreSQL synthetic. **KHÔNG** là thử iPhone hay máy in thật.
- `--http` runner riêng **NOT RUN** trên staging mới vì bước PostgreSQL acceptance đã FAIL và job dừng trước bước đó. Có **một ca HTTP 409 thực** trong `--integration` **FAIL**, không ghi HTTP toàn bộ PASS.

## Ma trận 11 ca nghiệm thu CODE-008 mới

| ID | Điều kiện và kết luận | Trạng thái PG staging |
|---|---|---|
| C008-CI-01 | Composition AI0: same-order across batch, stale event HELD, không sinh đơn thứ hai | **PASS** (synthetic) |
| C008-CI-02 | Composition AI0: file đã nhận trước chốt, `occurred_at` tự khai ở tương lai, trigger PG từ chối duyệt | **PASS** (synthetic) |
| C008-PG-01 | Hai file ảnh signed ở các batch khác nhau, receipt đầu dịch lùi **65 giây** trong DB test; vẫn 1 order, 0 approve/job | **PASS** (dữ liệu thời gian mô phỏng, chưa tự append) |
| C008-PG-02 | File bổ sung **trước chốt** phải cập nhật active revision, hủy hiệu lực xác nhận phiên bản trước | **FAIL P0**: vẫn revision cũ; chỉ HELD |
| C008-HTTP-03 | Đã nhận file chưa đối soát: Fastify route staff approve phải trả HTTP **409** có mã nghiệp vụ | **FAIL P0**: trả **500 INTERNAL_ERROR** dù PG trigger chặn |
| C008-PG-04 | Webhook trùng/replay, mất ACK, hai worker gọi propose đồng thời, event bền không sinh thêm đơn | **PASS** |
| C008-PG-05 | Staff approve xong, yêu cầu mới đúng thứ tự mở order_id mới; đơn mới 0 approve/job, đơn cũ không đổi | **PASS**, fixture principal riêng không phải live OA |
| C008-PG-06 | Tin cũ đến sau, provider timestamp cũ; HELD không sinh thêm order/job | **PASS** |
| C008-PG-07 | Hai approval worker đồng thời khi file signed đã commit: **cả hai P0001**, 0 approve/job | **PASS** |
| C008-PG-08 | Hai đơn cùng chat đang mở, file không chỉ rõ đơn: giữ HELD/HUMAN không hợp nhất ngầm | **PASS** |
| C008-PG-09 | Signed ingress cạnh tranh staff approve: hàng rào PG theo thứ tự commit; HELD an toàn ở ranh giới không chắc chắn, không reprint | **PASS** |

**Tổng ca mới:** 9 ca trực tiếp = **7 PASS / 2 FAIL / 0 SKIP**, 2 ca composition wrapper = **2 PASS / 0 FAIL / 0 SKIP**. Hai lỗi P0 không bị đánh dấu SKIP hay EXPECTED PASS. Cả runner có 19 SKIP lịch sử độc lập và vẫn bị ghi riêng.

## Kết luận chưa đủ và việc AI0 tiếp nhận

1. **AI1 + AI2:** triển khai Port transactionally append-to-current-order liên kết đủ source/event_ids vào **active revision** cùng order_id trước staff approve, refresh request hash, invalidate stale confirmation/quote, lock hàng chờ an toàn trong PostgreSQL. Nghiệm thu C008-PG-02 phải GREEN mà không fake event hoặc tự đánh dấu đã review.
2. **AI1 + AI0:** dịch `P0001 / AI0_PENDING_INBOUND_REVIEW` thành Fastify **HTTP 409** với mã máy đọc được, giữ 0 approval/job; C008-HTTP-03 phải GREEN.
3. **AI2 + AI0:** xác nhận quy tắc event provider timestamp không đáng tin, nhận nhiều batch >60s, hai worker, lost ACK, replay, text “tạo đơn riêng” phải qua ý định đã được kiểm chứng; nếu không rõ, HUMAN/HELD. Đường xử lý **tạo đơn riêng có bằng chứng ý định** hiện **NOT RUN** (chưa có Port).
4. **AI0:** nhập các test trên PR #18 vào một SHA tích hợp mới rồi chạy lại CI push **đúng SHA**, gồm `--integration`, `--http` và Chromium. Không dùng CI xanh trên bản code chưa có 11 ca mới để tuyên bố đủ CODE-008.
5. **Không đánh đồng fixture với thực tế:** signed webhook dùng synthetic verifier/test key; trong C008-PG-02/05/07/09 có principal test-only cho customer/processor để kích thích Core, **KHÔNG** phải credential khách Zalo thật, không phải AI3 sealed rendering trong ca đơn lẻ (các test AI3 riêng vẫn có).
6. **Zalo OA thật, Ricoh/Windows thật, iPhone thật, nghiệm thu TN-037** (≥90% nhận diện, ≥80% hội thoại, 100 đơn/ngày, 210 đơn/≥7 ngày) **NOT RUN/BLOCKED**. V1 chưa đủ điều kiện DONE.

## Cách chạy lại

Checkout **SHA tích hợp** có mã sản phẩm AI0 + file AI5 (ví dụ staging `7dfefc4e51f0e603c38411f2ed85ac3ac90cc489`), dùng PG chỉ localhost/DB `autoin_test*`, simulation mode. Những file test trực tiếp import TS phải chạy với `--import tsx` (runner AI5 đã bật).

```sh
npm ci
npm run db:migrate  # DATABASE_URL trỏ PostgreSQL cô lập
export AUTOIN_INTEGRATION_SHA="$(git rev-parse HEAD)"
export AUTOIN_OPERATION_MODE=simulation
export AUTOIN_ALLOW_PG_ACCEPTANCE=YES_ISOLATED_TEST_DB
export AUTOIN_TEST_DATABASE_URL='postgresql://auto_in:isolated_ci_only@127.0.0.1:5432/autoin_test_305'
export TEST_DATABASE_URL="$AUTOIN_TEST_DATABASE_URL"
node tests/acceptance/run.mjs --integration
```

Sau khi AI1/AI2/AI0 sửa, yêu cầu **0 FAIL trong tất cả ca bắt buộc**. Không thử Zalo OA/Ricoh thật, không merge/deploy.
