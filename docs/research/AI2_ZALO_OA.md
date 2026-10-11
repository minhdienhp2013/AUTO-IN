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
