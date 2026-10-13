# AI5 độc lập — CODE-401/CODE-402/CODE-008 trên SHA tích hợp 1c1b75fd8be7063add12c8510eec9d5d6742df54

Ngày ghi bằng chứng: 14/10/2026. **AI5 chỉ sửa tests/acceptance/** và **docs/acceptance/**; PR #18 giữ nhánh `ai5/dot3-integrated-acceptance`. **KHÔNG** sửa Core/AI2/composition/web/workflow, không merge/deploy, không gửi OA hay in máy thật.

## Nguồn/checkout và trạng thái chứng cứ

- **Product SHA mục tiêu**: AI0 Draft PR #31, branch `ai0/code006-ports-integration`, HEAD **`1c1b75fd8be7063add12c8510eec9d5d6742df54`**, bao gồm CODE-401 mới nhất từ AI1 PR #54 và CODE-402 từ AI2. Không gọi kết quả AI0 push trên HEAD này là một lượt nghiệm thu độc lập AI5.
- **Independent overlay**: `ai5/code401-reacceptance-1c1b75f-20261014`, HEAD **`f1d334bf90f2506157b12ac7c5a56eefe3267f6b`** = **đúng product SHA `1c1b75fd8be7063add12c8510eec9d5d6742df54` + đúng 2 file AI5** `tests/acceptance/code401-independent-port-pg.test.cjs` và `tests/acceptance/run.mjs`. Không mang code sản phẩm khác vào overlay. GitHub Actions checkout sạch rồi migrate PG 18.3 cô lập, strict `npm run check` + compile/build, AI3 pytest, acceptance mode riêng và Chromium.
- AI5 new acceptance test **mượn cấu trúc cơ sở và assertions của AI1 test** `tests/integration/core/verified-confirmation-pg.test.cjs`, chạy **trực tiếp trên compiled product Core** với hai Pool độc lập; AI5 bổ sung một ca độc lập sửa `occurred_at` trong PG trông như sau khi cấp challenge, trong khi `received_at` thật ở PG vẫn trước khi cấp. Đây là test dùng fixture synthetic và PostgreSQL trực tiếp, **không phải** bằng chứng official Zalo OA.
- [CODE checks PUSH #38451399746](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38451399746) **SUCCESS**; [Simulation integration PUSH #38451399440](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38451399440) **SUCCESS**, PostgreSQL job **115482937283**, product-browser job **115482937526** đều SUCCESS. Chính SHA overlay trên cùng product HEAD cần nghiệm thu.

## Kết quả chính xác trên overlay cuối

| Suite đã chạy | PASS | FAIL | SKIP | Diễn giải |
|---|---:|---:|---:|---|
| AI5 `--integration`, PostgreSQL 18.3/AI3 DryRun | **104** | **0** | **19** | Chạy ca C401 AI5 mới và toàn C008/C402/C405; 19 legacy SKIP giữ nguyên |
| AI5 `--http`, Fastify localhost | **62** | **0** | **68** | 1 C401 PG mới SKIP theo mode; chỉ C402-PG boundary chạy khi DB được cấu hình; không tính SKIP là PASS |
| AI5 `--browser-product`, React+Fastify/PG | **58** | **0** | **67** | 1 C401 PG mới SKIP theo mode vì browser job không build Core; status-specific Chromium vẫn CHẠY đầy đủ |
| Chromium trạng thái `pending_updates` desktop 1440x900/mobile 390x844 | **14** | **0** | 0 | 7 case × 2 viewport: clear, processing0, needs_human0, processing2, needs_human1, stale_hash, missing; approve fail-closed |
| Strict TypeScript / CODE checks, web build, generic product-browser | **SUCCESS** | 0 | 0 | CI trên đúng overlay SHA |
| AI3 Python unit/docs/print DryRun | **199** | 0 | **1** | 1 opt-in pytest SKIP, không phải Ricoh thật |

### CODE-401 và CODE-402 đã thực sự chứng minh

1. **Signed synthetic `OK`** và `kind=text` kèm `confirmation_postback` tự khai không tạo Core confirmation. Postback sai loại, thêm trường JSON, `unsupported` không có fixture verified marker, sai OA/customer/token đều bị từ chối; event có payload sai hình dạng không được nâng thành sự kiện hợp lệ.
2. **PostgreSQL `received_at` là thời gian tin cậy**: dù cố ý sửa provider-controlled `occurred_at` thành `challenge.created_at+1s`, khi `received_at=created_at-1s`, Core trả `CONFIRMATION_EVENT_OUTSIDE_CHALLENGE`. Trường hợp nhận sau `expires_at` cũng bị từ chối. Challenge đã hết hạn không thể tạo xác nhận mới.
3. **Hai worker hai Pool thật, mất ACK/replay:** chỉ một Core confirmation cho cùng event/challenge, cả hai đường trả `confirmed`/`existing` và **cùng confirmation_id**; webhook duplicate idempotent. Event mới lặp token challenge đã tiêu thụ bị `CONFIRMATION_REPLAY`.
4. **Revision, quote, handover, staff approval:** challenge/revision/hash cũ trả `stale`; thay generation bằng human takeover không xác nhận; quote có xác nhận độc lập; staff approval đòi customer request confirmation và price confirmation theo nghiệp vụ, **không** phát sinh từ candidate. Challenge chưa dùng trước duyệt không được tạo confirmation mới sau duyệt; replay event đã xác nhận cũ chỉ trả `existing` không in thêm.
5. **Ranh giới AI2:** `zalo_confirmation_candidates.status=PENDING_AI1_REVIEW` từ CODE-402 **không tạo** `core_confirmations`, `core_approvals`, `core_print_jobs`; các ca CODE402 strict worker/challenge/duplicate/lost ACK giữ PASS. C401 riêng có thể ghi confirmation sau đã có bằng chứng xác minh vào Port; không bao giờ suy từ câu OK hay candidate.
6. **CODE-008** signed webhook→AI3 verified file→AI2 durable worker→AI1 atomic append trước chốt giữ order_id, tăng revision, xác nhận cũ hết hiệu lực, HTTP409 trước đối soát và không có print job; hồi quy đều PASS trong runner này.

## Trung thực về các lượt FAIL khi chuẩn hóa harness AI5

- Overlay `92b62b13ddbe5e0f42880be5660992c282495dd5`: PG **104 PASS/0 FAIL/19 SKIP**, HTTP **63 PASS/0 FAIL/67 SKIP**, browser chạy 14 scenario PASS nhưng **job FAIL** do test C401 đòi `dist/backend` khi browser không build Core.
- Overlay `6e712367ca23385682e5fe6cf12fc6e55a1beac8`: PG tiếp tục PASS, browser **vẫn FAIL** do `require()` thực hiện lúc module khởi tạo, trước khi Node đánh dấu SKIP. Đây là lỗi harness/mode isolation của AI5, không có chứng cứ lỗi sản phẩm Core.
- Overlay cuối `f1d334bf90f2506157b12ac7c5a56eefe3267f6b`: chỉ import Core khi mode `--integration`; browser/HTTP ghi C401 PG là **SKIP rõ nguyên nhân**, còn `--integration` chạy C401 thật cùng mọi assertion, **104 PASS**. Tất cả workflow trên exact SHA **SUCCESS**. Không bỏ/hạ mức assertion, không ngụy trang FAIL thành PASS. Đây là cách tách chức năng theo đúng môi trường build đã có của từng workflow.

## Release gate còn thiếu

**NOT RUN / BLOCKED:** Chữ ký/webhook thực từ Zalo OA, danh tính và phân quyền OA/khách thật, sự kiện postback provider chính thức, refresh/access-token OA, Ricoh/Windows thật, iPhone vật lý, tải 100 đơn/ngày, ≥210 đơn trong ≥7 ngày và tỷ lệ TN-037. Synthetic fixture HMAC `x-test-fixture-key` **không tương đương** X-ZEvent-Signature chính thức hoặc lời xác nhận người dùng thật. 19/68/67 SKIP thuộc chế độ/legacy, 1 SKIP AI3 opt-in; không được ghi tất cả đã chạy hoặc TN-037 DONE.

**AI0 bước sau:** nhập riêng 2 file AI5 từ PR #18 HEAD vào một SHA tích hợp mới (không tự merge main), kiểm SHA blob và chạy lại CI PUSH đúng SHA; giữ PR #31 Draft. AI0/AI2 chịu trách nhiệm xác minh live OA official adapter/server-owned scope/provenance; AI1 giữ verified-confirmation Core transaction, AI5 chỉ nghiệm thu khi provider contract được bàn giao. Không gửi OA/in Ricoh thật khi chưa có chủ cửa hàng phê duyệt.
