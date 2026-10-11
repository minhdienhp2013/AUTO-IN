# CODE-102 — Zalo OA, hội thoại và DeepSeek (đợt khởi đầu)
Ngày: 2026-10-11. BASE: `84ab02d643622bc7bfdf07eee662d8797bdd84fd`.
Trạng thái: **module mô phỏng/Port**, **KHÔNG** tích hợp OA thật, **KHÔNG** thử tin thật.

## Nguồn chính thức đã tra
- [Zalo Developers — OA/API/Webhook](https://developers.zalo.me/docs/): tài liệu một số mục cần quyền đăng nhập OA/app. Không suy đoán thuật toán chữ ký, trường webhook thực, API gửi, giới hạn tin/đính kèm, callback OA Manager, quyền liên hệ, token và scope. Các mục này **chưa xác minh trên tài khoản được cấp quyền** (TN-022).
- [DeepSeek Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/) và [JSON Output](https://api-docs.deepseek.com/guides/json_mode/): endpoint chat/completions, JSON output + system prompt yêu cầu JSON, token usage. Mẫu giá USD/token là cấu hình xác minh tại lúc triển khai, không hardcode.

## Luồng và ranh giới
1. `ZaloIngress.receive(raw,headers)`: luôn kiểm tra kích thước và **verify trên raw bytes**, rồi mới normalize và `insert_once`. Live verifier/mapping mặc định từ chối tất cả. `SyntheticTestVerifier` / `SyntheticFixtureNormalizer` chỉ cho tests; không import vào composition production.
2. `PostgresInboundEventRepository`: ví dụ transaction atomically `INSERT ... ON CONFLICT` và queue marker. **Phải được AI0/AI1 chốt migration PostgreSQL + transaction boundary** trước khi live.
3. Worker lấy queued events, gom cùng `oa_id + customer_id + conversation_id`; xử lý theo timestamp provider và event ID, hạn đầu 60s, tin sau 10s (không quá hạn 60s). `flushComplete` chỉ gọi theo rules đáng tin. BatchStore live phải có transaction/lease, lock, ack/retry; FixtureBatchStore là **MEMORY MOCK**, không dùng live.
4. `ConversationProcessor`: xem facts từ AI3; local rules trước DeepSeek; chỉ `suggest_draft` qua AI1 và `route_human`. **Không có API quyền duyệt/in, không báo đã in, không ước lượng số trang**.
5. `GatePort` đọc generation/handover do AI1 quản lý. Kiểm lại sau AI và trước xếp outbound; `OutboundPort.reserve_if_current` phải atomically so sánh mode+generation và claim idempotency trong database. `OutboundDispatcher` kiểm gate/lịch lại ngay trước OA I/O, `UNKNOWN` khi kết quả gửi không chắc chắn, **không tự retry**. Tin đã rời đường truyền OA không thể bảo đảm thu hồi nếu takeover xảy ra đúng lúc provider nhận.
6. Lịch `Asia/Ho_Chi_Minh`: 07:00–21:30 mặc định, date override có thể ngoài giờ; tạm dừng ngắt trả lời nhưng vẫn nhận/lưu. Ngày nghỉ có thể tư vấn, **AI1/AI3 phải khóa in thật**.
7. File Excel, in màu/phân màu phức tạp, >5 tài liệu kể cả bên trong ZIP, lỗi preview và file khó chuyển người. Retry download đúng **2 lần sau lượt đầu**; giữ inbound khi lỗi. Giá, cọc, quote, xác nhận revision, duyệt thuộc AI1.

## Điểm tích hợp cần AI0/AI1/AI3 chốt (chưa coi là đã chạy)
- **[AI0 CODE-000]** `backend/app.ts`: raw-body parser chính xác byte, đăng ký `POST /webhooks/zalo`, composition verifier + event repository + worker + guard, cấu hình simulation-first, root scripts/TypeScript. No fake signature verifier in production.
- **[AI1 CODE-101]** `backend/storage/**`: tables `zalo_inbound_events` UNIQUE(oa_id,event_id) và `zalo_process_queue` tương ứng; transaction runner; durable BatchStore, reply outbox unique outbound_id với atomic claim + conversation generation; idempotent `suggest_draft`, `route_human`, handle handover/return in authenticated backend. Nếu AI1 muốn tên schema khác, cần AI0 cập nhật mapping.
- **[AI3 CODE-103]** `workers/documents/**`: `DocumentFactsPort.inspect` trả file-kind + count_inside ZIP có kiểm tra an toàn + preview_trusted; không tạo số trang giả.
- **[AI0/AI1]** `BudgetPort`: persistent atomic reserve/rate configuration + reconciliation, chi phí theo đơn và cảnh báo 80/95/100.
- **[AI0]** `contracts/**`: chốt path/fields cho các port, queue, outbox và SQL migration; các type ở backend AI2 tạm độc lập theo wire v0.1.

## Chạy unit (sau khi có Node 22 hỗ trợ strip-types hoặc runner được AI0 khóa)
`node --experimental-strip-types --test tests/unit/zalo/*.test.mjs`.
Fixture nằm trực tiếp trong các test và có `synthetic_fixture:true`; **không phải payload Zalo thật**. Không dùng file/khóa khách. Các test không tạo lệnh in, không gửi OA/DeepSeek thật.

## P0 chưa kiểm chứng
Signature/raw-body + event payload thật; OAuth/permission/renew token; text/PDF/Word/ảnh/ZIP/Excel attachments; download URL expiry/cap; webhook trùng/đảo; OA send limits/preview/24h window; OA Manager handover signals; pagination/queue load; durable transactions/restart/parallel worker; DeepSeek timeout/usage/cost production; integration PostgreSQL/AI1/AI3. Chưa đạt TN-022/037 hoặc nghiệm thu 210 đơn/7 ngày.


## CODE-202 — durable PostgreSQL (11/10/2026)

- MODULE_BASE_SHA `ccf5e6e1bb97fb1ca8c70a4b2d1c6ad22d59e682`; SCAFFOLD_SHA `a681fe91f24f3b0cec61cb72887cc0928d9460ca`. Scaffold imported unchanged onto isolated AI2 branch after first DeepSeek test fix.
- First fix `2b22fdff5160b693bc50d381e7e09ccb082bde61` removes one surplus brace in DeepSeek mock. All files changed by AI2 remain in its namespace (besides unchanged scaffold import).
- Migration: `backend/integrations/zalo/migrations/001_zalo_durable.sql`. Owns `zalo_inbound_events`, `zalo_process_queue`, `zalo_batches`, `zalo_batch_items`, `zalo_outbound`; does not modify AI1 migrations. Apply to isolated test database first. Deploy/apply migration is NOT performed here.
- `PostgresConversationQueue.ingest_pending()` atomically moves verified, deduplicated event markers into grouped batches via a PostgreSQL transaction. Parallel intake uses `FOR UPDATE SKIP LOCKED`; unique `(oa_id,event_id)` protects duplicates. `claim_due()` uses leases, `complete()` compares lease token, `fail()` retries after delay then persists `NEEDS_HUMAN`. Original event is not deleted.
- `DurableConversationWorker.tick()` can be invoked by AI0 scheduler, persists intake even when AI has been handed over; failures keep DB state. AI1 operations called by `ConversationProcessor` MUST be idempotent by the event id/key because batch processing is at-least-once, not exactly-once. `NEEDS_HUMAN` must be exposed to staff; no automatic provider send.
- `PostgresOutboundRepository`: unique outbound_id; atomically reserve only `QUEUED` against AI1 `AuthoritativeGateLock.lock_if_current(tx,conversation_id,generation)`. Lock MUST check authoritative AI1 control row `FOR UPDATE` in SAME PostgreSQL transaction; missing row or wrong generation/mode fails closed. `RESERVED` is made `UNKNOWN` after restart/timeout, never re-queued. Status transitions disallow `UNKNOWN/SENT/CANCELLED` replay. `OutboundDispatcher` rechecks the AI1 gate/schedule before OA I/O; provider call already in flight cannot be recalled.
- DeepSeek remains advisory only; it cannot price, approve, or print. Zalo webhook live verification and live OA sender remain DISABLED without provider-verified signature/payload/permissions. Do not substitute the synthetic fixture verifier in live composition. Outside schedule, inbound is persisted; ordinary replies are cancelled before provider call.

### AI0 / AI1 port and operational dependencies

[AI0 CODE-006] Provide real `PgTransactions` wrapper around AI1 `PgStore.tx`, the scheduler calling `DurableConversationWorker.tick()`, real raw-byte Fastify ingress (signature verification required), schedule guard, `ZaloIngress` composition and an operator view for `NEEDS_HUMAN` / `UNKNOWN`. Do not enable live Zalo send until official provider contract is verified. AI0 also wires AI3 `DocumentFactsPort` and AI1 `OrderDraftPort`.

[AI1 CODE-201] AI1 HEAD `ebdd740` now contains `backend/storage/migrations/004_conversation_generation.sql` with `core_conversation_controls(shop_id,conversation_id,generation,status)`, handover/return increments generation. AI2 implemented `CoreConversationGate` in `backend/integrations/zalo/core-gate.ts` using that exact table, shop-scoped `SELECT ... FOR UPDATE` inside the outgoing reservation transaction. AI0 must inject a trusted shop_id and the real shared PgTransactions runner. AI1 must ensure `suggest_draft` / `route_human` idempotency and server-authenticated control. AI2 never updates AI1 tables.

### Verified / not verified

- **PASS (local reconstructed working tree, Node v22.16.0):** `node --experimental-strip-types --test tests/unit/zalo/*.test.mjs`: 25 PASS / 0 FAIL / 1 SKIP (PG). `tsc --noEmit` strict NodeNext over new AI2 durable/worker/core-gate source also PASS, using locally installed TypeScript v5.8.3. These are local reconstructed-file checks, not a GitHub checkout or CI proof.
- **SKIP:** real PostgreSQL test `tests/unit/zalo/postgres-integration.test.mjs` needs an isolated database `AUTOIN_TEST_DATABASE_URL` and package `pg`. Run this with migrated disposable schema and verify independent sessions. Do not call mock tests a PostgreSQL PASS.
- **NOT RUN:** live OA provider verification/messages, external DeepSeek network, Fastify/AI1 full integration, actual production DB, 100/day load, TN-022/037 and 210 orders/7 days. No real customer message, print instruction, merge or deploy.

