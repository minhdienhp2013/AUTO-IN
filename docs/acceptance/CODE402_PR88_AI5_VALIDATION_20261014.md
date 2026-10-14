# AI5 — PR88 CODE-402 independent quarantine / manual-order acceptance

Ngày 14/10/2026; **chỉ bộ kiểm thử và bằng chứng**, không sửa mã sản phẩm, workflow, hoặc nới assertion.

## Mốc nguồn và giới hạn

- **AI0 product PR #88** Draft, SHA chính xác: `3093de9d17d5455690474dcb3d66addf7f49bb1f`; parent AI2 PR #63 `fef66d02c7dc56c1b6756f1bdd320f2aab11135e`.
- **AI5 validation overlay:** [Draft PR #90](https://github.com/minhdienhp2013/AUTO-IN/pull/90), HEAD `e8e2d521d7b59ba6bc8b5668207ff2e0b567b83d`, **đúng một commit trực tiếp trên product SHA** và chỉ ba file `tests/acceptance/**` / `docs/acceptance/**`. Nhánh lịch sử PR #18 không bị reset.
- **AI0 product CI đã PASS:** [CODE checks #38597991297](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38597991297) và [composition PostgreSQL #38597991187](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38597991187) đều SUCCESS; Core 38/38, AI2 93/93, composition 26/26, contracts 18/18. **Đây không phải kết quả runner AI5 PR88.**
- **AI5 independent PR88 runner: NOT RUN tại thời điểm tạo file.** Không có log thực thi `tests/acceptance/pr88-official-manual-pg.test.mjs` trên overlay; chỉ cập nhật thành PASS/FAIL sau khi kiểm chứng run ID và job log thật.
- Cây mã **product PR88 không có `web/` hoặc `tests/ui/code008-chromium.py`**, vì vậy Chromium 14 desktop + 14 mobile trên **đúng SHA này = NOT RUN/BLOCKED**. Tuyệt đối không lấy Chromium 28/28 trên PR85/PR86 làm PASS cho PR88.

## Các assertion mới (không tự SKIP)

| Ca | Bằng chứng phải đạt | Trạng thái lần này |
| --- | --- | --- |
| PR88-REGISTRY | OFF mặc định 503, không binding shop/OA/app hoặc binding app sai 503 + 0 receipt | NOT RUN |
| PR88-INGRESS | Synthetic text có chữ ký + registry hợp lệ: 1 inbound + 1 queue; replay/lost ACK không nhân đôi; image/file/click giữ NEEDS_HUMAN và 1 receipt mỗi sự kiện; unmapped là OA-level NULL customer/conversation; chữ ký sai 403, không ghi thêm | NOT RUN |
| PR88-MANUAL-MAPPED | **Đơn thủ công**, cùng customer_id và conversation_id; receipt image mapped đã nhận, 2 pool duyệt cạnh tranh → HTTP 409 `PENDING_INBOUND_REVIEW`, cả direct Core bị 409, **0 approval + 0 print** | NOT RUN — NGUY CƠ RED |
| PR88-MANUAL-UNMAPPED | Đơn thủ công và receipt chưa map OA-level `customer_id/conversation_id=NULL` cùng OA shop; kỳ vọng **HTTP 409 + 0 approval + 0 print**, hai pool/replay giữ receipt nguyên vẹn | NOT RUN — NGUY CƠ RED |
| PR88-APPROVAL-FIRST | Nếu duyệt **trước** khi nhận receipt thì đúng 1 job; receipt đến **sau** vẫn NEEDS_HUMAN, replay/lost ACK không tạo job thứ hai | NOT RUN |

**Phân tích nguồn — chưa coi là kết quả chạy:** `backend/core/service.ts` `OrderService.approve` hiện tìm OA scope chỉ qua `core_ai_draft_proposals WHERE order_id=$1`, và chỉ lấy scope lock/đọc `zalo_official_quarantine` bên trong `if(source.rows.length)`. Đơn thủ công không có proposal nên nhánh guard OA-wide có thể bị bỏ qua dù đã có registry `core_shop_zalo_oa_registry`. Đây là **blocker cần AI1 sửa**, không sửa sản phẩm từ AI5. Chỉ đánh dấu scenario thực tế **FAIL** khi có traceback/TAP trên exact overlay, không giả định test đã chạy.

## Thực thi thật trong isolated CI (AI0 sở hữu workflow)

Checkout **đúng overlay AI5** với `fetch-depth: 0`; Node 24.19, PostgreSQL **18.3** service trên localhost, DB `autoin_test_ai5`; cả `DATABASE_URL`, `TEST_DATABASE_URL` và `AUTOIN_TEST_DATABASE_URL` phải trỏ **cùng một DB**, `AUTOIN_ALLOW_PG_ACCEPTANCE=YES_ISOLATED_TEST_DB`, `AUTOIN_OPERATION_MODE=simulation`. Khởi chạy:

```sh
npm ci
npm run db:migrate
npm run check
node tests/acceptance/run-pr88.mjs --pg
```

Runner yêu cầu cha trực tiếp bằng đúng product SHA, chỉ thay file AI5, PostgreSQL cô lập và **4 bài TAP thật** (một bài ma trận ingress, hai bài manual mapped/unmapped, một bài approval-first). **0 FAIL/0 SKIP/0 TODO** mới đạt. Trong trường hợp manual case bị 200, cần **giữ nguyên assertion FAIL**, lấy đầy đủ TAP traceback, HTTP status, DB approval/job counts, SHA/run ID; chuyển **[AI1] CODE-401 / manual-order OA guard** cùng với AI0 mapping registry. Không thay mock/SQL hay nới kỳ vọng để xanh.

`node tests/acceptance/run-pr88.mjs --browser` cố ý **exit 2 / NOT RUN** khi product không có UI/harness; để thử Chromium cần AI0 tạo đúng cây sản phẩm tích hợp UI/Chromium, sau đó AI5 viết overlay **mới trên product SHA mới** và chạy 14×desktop/14×mobile. Không gọi UI cũ PASS cho PR88.

**Giới hạn:** Fastify `app.inject` + PG thật nhưng webhook chữ ký, payload và user mapping đều **synthetic**; không có OA live; không kết nối máy Ricoh/Windows/iPhone vật lý; TN-037 (210 đơn trong ≥7 ngày sạch) NOT RUN. Không gửi Zalo, không in thật, không merge/deploy.
