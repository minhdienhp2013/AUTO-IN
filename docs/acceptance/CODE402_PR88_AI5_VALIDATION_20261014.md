# AI5 — PR88 exact d1b5503 independent quarantine/manual acceptance

Ngày 14/10/2026. **Validation-only, chưa chạy pilot hoặc máy in/Zalo thật.**

## Định danh và xuất xứ

- **Product Draft PR #88 HEAD bất biến:** `d1b550355f53c6aa5bd2bf475ae93964842eff99`. Product CI [CODE checks #38603991306](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38603991306) **SUCCESS** và [composition PostgreSQL #38603991196](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38603991196) **SUCCESS**; Core 39/39, composition 26/26, AI2 93/93, contracts 18/18; không đồng nghĩa AI5 runner đã chạy.
- **AI5 overlay mới:** được tạo từ **parent trực tiếp** product SHA trên. Giữ nguyên lịch sử PR #18 và overlay cũ PR #90 `e8e2d521d7b59ba6bc8b5668207ff2e0b567b83d` vốn có parent **cũ** `3093de9d...`, không chạy lại/không nhận PASS của overlay cũ.
- Chỉ đưa ba tệp dưới `tests/acceptance/**` và `docs/acceptance/**`: `pr88-official-manual-pg.test.mjs`, `run-pr88.mjs` và tài liệu này. Định danh commit/PR overlay nằm trong bàn giao PR #18.
- **Mới viết, chưa có log thực thi:** runner AI5 `--pg` **NOT RUN**, 7 ca **NOT RUN**, chưa có kết quả thực tế PASS/FAIL/SKIP từ runner. Bằng chứng từ AI0 trên product SHA khác với nghiệm thu độc lập.

## Ma trận nghiệm thu độc lập (giữ nguyên assertion, tăng bao phủ)

| Nhóm test (7 TAP cases) | Assertion bắt buộc | Đã chạy? |
| --- | --- | --- |
| #1 Synthetic HTTP/registry | Default route `503`; thiếu/wrong shop–OA–app binding `503` và 0 receipt; đúng binding: text 1 durable inbound + 1 queue, replay/lost ACK không nhân đôi; image/file/click `NEEDS_HUMAN` mapped; OA-level unbound `NULL` customer/conversation; sai MAC `403` + 0 extra writes | NOT RUN |
| #2 Manual + mapped | Manual order **0 `core_ai_draft_proposals`**, cùng customer/conversation với receipt image mapped `NEEDS_HUMAN`; HTTP `409 PENDING_INBOUND_REVIEW` và Core pool thứ hai cũng `409`; **0 approvals/0 print jobs**. Sau *review thật về mặt trạng thái fixture*, chỉ bản được phép mới tạo đúng 1 approval/job. | NOT RUN |
| #3 Manual + OA-level unmapped | Manual order trong shop bound tới OA có receipt unmapped `NULL` customer/conversation: HTTP `409 PENDING_INBOUND_REVIEW`, Core pool 2 `409`, **0 approvals/0 print**; chỉ sau staff REVIEWED mới có thể approve | NOT RUN |
| #4 Approval-first basic | Duyệt khi chưa có pending có thể tạo đúng một job; receipt đến sau vẫn `NEEDS_HUMAN`; retry/replay không tạo job thứ hai | NOT RUN |
| #5 Ingress-first transaction race | PostgreSQL pool B giữ `FOR UPDATE` scope + **uncommitted pending receipt**, HTTP approval trên pool A phải **chờ**; sau COMMIT trả `409`, **0 approvals/jobs** | NOT RUN |
| #6 Approval-first transaction race | Core pool A được chặn sau khi đã lấy OA `FOR UPDATE`; HTTP synthetic ingress cùng OA phải **chờ**. Duyệt commit trước tạo **1 approval/job**, receipt commit sau vẫn pending; replay/second approval không tạo job thứ hai | NOT RUN |
| #7 Full review gate | Khi 2 receipt (mapped + OA-level unmapped) pending thì `409`; review 1 vẫn `409` + 0 job; review đủ 2 thì theo các điều kiện duyệt hiện hành mới được `200` + đúng 1 job; replay không trùng | NOT RUN |

Các ca concurrency dùng hai `pg.Pool` độc lập; race #5 dùng transaction SQL cô lập nắm lock OA theo cùng contract AI2, race #6 dùng **Fastify synthetic ingress** trong lúc Core giữ lock. `core_orders`/approval/print giữ các kiểm tra hiện hành; không đưa khách thật vào test. Fixture “REVIEWED” là bước **synthetic test setup**, không chứng minh nhân viên đã đối soát OA thật.

**Source review trên SHA mới:** `backend/core/service.ts` hiện tra `core_shop_zalo_oa_registry`, khóa registry rồi từng OA scope và xét mapped/unmapped ngay cả khi **manual order không có proposal**; source-level blocker ở SHA `3093de9...` đã được AI1 chỉnh. Chỉ công nhận sửa lỗi khi **7 TAP cases thực chạy PASS trên exact overlay**, không suy từ mã nguồn hoặc product CI.

## Phương pháp chạy có thể kiểm toán

**Chỉ trên isolated GitHub CI do AI0 vận hành**, checkout SHA overlay mới, `fetch-depth: 0`, Node 24.19+, PostgreSQL 18.3 localhost, cùng DB `autoin_test_ai5` cho ba URL env `DATABASE_URL`, `TEST_DATABASE_URL`, `AUTOIN_TEST_DATABASE_URL`, `AUTOIN_ALLOW_PG_ACCEPTANCE=YES_ISOLATED_TEST_DB`, `AUTOIN_OPERATION_MODE=simulation`.

```sh
npm ci
npm run db:migrate
npm run check
node tests/acceptance/run-pr88.mjs --pg
```

`run-pr88.mjs` từ chối checkout sai parent `d1b5503...`, file ngoài AI5 scope, URL database không cô lập và chỉ chấp nhận TAP: **7 tests / 7 PASS / 0 FAIL / 0 SKIP / 0 cancelled / 0 TODO**. Nếu có **FAIL**, giữ nguyên assertion, gửi **exact SHA, case name, TAP stack, HTTP status/response code, approval/print counts, logs + run ID** về AI1 (Core), AI2 (quarantine) hoặc AI0 (composition/migration) theo ownership. Không đổi test kỳ vọng để CI xanh.

**Chromium desktop/mobile: NOT RUN** trên đúng product SHA vì PR #88 không có `web/`, `web/package-lock.json` hoặc Chromium harness; lệnh `--browser` cố ý exit 2 / NOT RUN. UI CI từng PASS trên PR #85 **không** chuyển sang SHA PR #88.

**Live release gates — NOT RUN:** xác minh chữ ký Zalo OA do provider phát sinh, bytes canonical, OA/customer identity/callback chính thức; Ricoh/Windows thật, iPhone vật lý, TN-037 (210 đơn thật ≥7 ngày sạch). Không gửi Zalo OA, in thật, merge hoặc deploy.
