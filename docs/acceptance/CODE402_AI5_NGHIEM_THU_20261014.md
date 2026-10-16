# AI5 — Nghiệm thu độc lập CODE-402 / CODE-008 / CODE-401 — 14/10/2026

## SHA và ranh giới bằng chứng

- PR #31 / `ai0/code006-ports-integration` **HEAD `4822958713e6ee1c728babde790f4c7022ac02bc`**, Draft, bao gồm AI2 source PR #53 **`b7a51220b249d895ddd0a75bb67496300ed3923a`** (Draft); chỉ file AI5 có quyền `tests/acceptance/**`, `docs/acceptance/**`.
- Giữ nguyên toàn bộ lịch sử nhánh AI5 `ai5/dot3-integrated-acceptance`, PR #18. Đã thêm `tests/acceptance/code402-postback-pg.test.mjs`, `code402-product-regression-pg.test.mjs`, kết nối vào `run.mjs`. Không sửa runtime Core/AI2, CI, web, database migrations hay plugin.
- **Chạy độc lập** từ SHA tích hợp AI0 `4822958713e6ee1c728babde790f4c7022ac02bc` + **chỉ 3 file test AI5** trên branch `ai5/code402-independent-acceptance-20261014`, SHA **`646aaa767bd3f37274e48a797ea03488cbbb6c42`**. Đây là **chính xác mã sản phẩm AI0** và overlays nghiệm thu, KHÔNG phải chạy test trên HEAD nhánh PR #18 một mình. `AUTOIN_INTEGRATION_SHA` trong CI ghim SHA checkout `646aaa767bd3f37274e48a797ea03488cbbb6c42`.
- [CODE checks PUSH #38445735081](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38445735081) **SUCCESS**. [Simulation integration PUSH #38445735214](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38445735214) **SUCCESS**: [PostgreSQL 18.3 job #115463524732](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38445735214/job/115463524732), [Chromium job #115463524770](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38445735214/job/115463524770).
- **Lượt đầu** stage `1ec19e499e99a60375bd11efafc909a8fc3f32f9`: PG runner **102 PASS/1 FAIL/19 SKIP** vì AI5 wrapper chạy AI1 Core PG mà thiếu `AI1_BUILD_DIR`; **KHÔNG** phải lỗi sản phẩm. Đã sửa đường build đúng theo repository `scripts/run-core.mjs` sang `dist/backend`, **không bỏ/nới assertions**, toàn CI chạy lại theo final SHA `646aaa767bd3f37274e48a797ea03488cbbb6c42` và PASS.

## Kết quả thực

| Bộ kiểm | PASS | FAIL | SKIP | Ý nghĩa |
|---|---:|---:|---:|---|
| AI5 `node tests/acceptance/run.mjs --integration` | **103** | **0** | **19** | PG cô lập, CODE-402/008/401/405 chạy thật; SKIP legacy, không tính PASS |
| AI5 `run.mjs --http` localhost | **62** | **0** | **67** | Bài PG candidate độc lập vẫn chạy trong HTTP vì TEST_DATABASE_URL cô lập được cấp; 4 wrappers AI1/2/0 SKIP do chế độ khác |
| AI5 `run.mjs --browser-product` | **58** | **0** | **66** | 14 scenario×viewport assertions nằm trong 1 Chromium wrapper; PG-only SKIP có chủ đích |
| CODE-402 AI5 independent PG boundary | **1** | 0 | 0 | Signed webhook/normalizer/AI0 resolver thật + SELECT trên core và candidate tables |
| CODE-402 strict AI2 worker, normalizer, AI0 Fastify PG + CODE401 verified Port | **4** | 0 | 0 | 4 child suites thực, strict TAP counts >0, 0 fail/skip/todo/cancelled |
| CODE-008 PG + composition trước/sau chốt | **11** | 0 | 0 | 9 ca direct, 2 composition; cùng order_id, revision, HTTP409, 0 print, lost ACK, race |
| CODE-405 real Core PG + composition | **11** | 0 | 0 | 5 direct, 6 composition; customer test principal != OA consent |
| Chromium pending_updates 7 status × desktop 1440×900/mobile 390×844 | **14** | 0 | 0 | Synthetic HTTP response, PG-backed authenticated staff UI; approve fail-closed |
| AI3 Python files/print DryRun | **199** | 0 | **1** | Không chứng minh vật lý Ricoh |

## Các bất biến CODE-402 đã chứng minh bằng fixture synthetic ký hợp lệ

1. **Tin `OK`** từ webhook synthetic ký bằng fixture key được giữ ở `pending`, kể cả tin text chứa metadata postback tự khai; không được đẩy thành quyền xác nhận hay candidate hợp lệ khi thiếu challenge.
2. **Structured postback** giữ nguyên dữ liệu normalized trong `zalo_inbound_events`; chỉ sau resolver AI0 kiểm challenge ID và SHA256 token theo record máy chủ, đúng OA/shop/customer/conversation/event/revision/request hash/generation/quote và thời gian received_at, AI2 mới ghi đúng một `zalo_confirmation_candidates.status=PENDING_AI1_REVIEW`. Candidate **không phải** `core_confirmations`.
3. **Sai token** có định dạng 32-byte hợp lệ, sai OA/sai customer, nhận webhook trước khi challenge được cấp (dù occurred_at tự khai hợp lệ), hết hạn challenge, stale revision/generation/quote/HUMAN takeover đều **không thêm candidate**; batch sai được giữ/PENDING/HUMAN theo nhánh. Không lấy bearer/header/text/OA ID do khách tự khai để cho phép xác nhận.
4. **Hai worker đồng thời + webhook duplicate + ACK loss/restart**: 1 candidate gắn đúng event/challenge; replay trả `existing` cùng candidate_id, không tăng số hàng, không tự gửi tin/outbound.
5. **Ranh giới side effect:** AI5 candidate suite kiểm `core_confirmations=0`, `core_approvals=0`, `core_print_jobs=0` sau mọi ca đúng/sai. Ca CODE-401 RIÊNG có thể tạo **xác nhận hợp lệ bởi AI1** sau khi challenge được kiểm chứng; đây là kiểm hồi quy AI1, không được gộp vào tuyên bố 0 confirmations của CODE-402.

## Giới hạn, trách nhiệm và bước tiếp theo

- Đúng quy trình chạy: PostgreSQL 18.3 cô lập + Node24/tsx+CI, HTTP localhost, Chromium desktop/mobile. Browser dùng synthetic `pending_updates` input; fixture signed không phải chữ ký Zalo OA thật; không xác minh profile/customer credential Zalo thật hoặc quyền truy cập API chính thức.
- **SKIP**: 19 legacy ở integration; 67 mode-specific ở HTTP; 66 PG-only ở browser; một Python opt-in HTTPS fixture SKIP. **NOT RUN/BLOCKED**: OA provider thật, in Ricoh Windows thật, iPhone vật lý, 100 đơn/ngày, ≥210 đơn trong ≥7 ngày, tỷ lệ TN-037; không có nhận định V1 DONE.
- **AI0 cần** nhập riêng test AI5 từ HEAD PR #18 vào SHA tích hợp kế tiếp, chạy lại ghim SHA mới trên push, giữ PR #31 Draft, bảo đảm review resolver production verifier thật và AI1 atomic confirmation event binding trước pilot. **Không merge/deploy hoặc gửi OA/in thật.**
