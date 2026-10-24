# AI1 — controlled_test grant V1

## V1 cấp quyền và thu hồi

- Không có grant nào khi mới migrate. `core_shop_settings` mặc định `mode='simulation'`, `printing_enabled=false`; grant table có `enabled=false` mặc định. Không thêm public grant API.
- V1 cấp/thu hồi bằng giao dịch DB của operator có credential quản trị hạn chế. Owner phải xác nhận shop, order, printer và thời hạn qua kênh vận hành được ghi ticket trước khi operator chạy. Operator không lấy actor/role từ HTTP hoặc OA.
- Grant phải tham chiếu đúng một `shop_id`, `order_id`, `printer_id`; order thuộc shop đó; `configured_by` là user đang active, `role='owner'` cùng shop. Core đối chiếu lại những điều kiện này ở mỗi gate.
- Thời hạn tối đa đề xuất và được Core ép là 30 phút theo đồng hồ PostgreSQL. Khi cấp, đặt `updated_at=clock_timestamp()` và `expires_at=clock_timestamp()+interval '30 minutes'` (hoặc thời gian ngắn hơn). Core từ chối timestamp tương lai và mọi grant có `expires_at > updated_at + interval '30 minutes'`. Không gia hạn một grant đang bật; thao tác lặp trả 0 hàng và phải rollback. Muốn cấp lại sau hết hạn/thu hồi phải có owner xác nhận mới và audit mới.
- Giao dịch cấp đồng thời đặt shop sang `controlled_test` và `printing_enabled=true` qua cấu hình operator. Giao dịch thu hồi đặt grant `enabled=false` và trả shop về `simulation` / `printing_enabled=false`. Audit trạng thái shop và grant trong cùng transaction. Grant đơn lẻ không đổi mode hoặc bật in.
- Cùng transaction phải thêm `core_audit` với `actor_id` là owner đã xác nhận, `action` là `controlled_test.scope.granted` hoặc `controlled_test.scope.revoked`, `order_id` đúng scope, `details` gồm `printer_id`, thời hạn/trạng thái và mã ticket vận hành. Không ghi mã khách, token, bytes, path, URL hoặc nội dung tài liệu. Lưu phê duyệt owner và danh tính operator trong ticket vận hành; không dùng row audit thay cho phê duyệt.
- Không xóa row khi thu hồi. Nếu owner không còn active, Core đã fail-closed; operator vẫn được thu hồi khẩn cấp và ghi danh tính/ticket trong `core_audit`.

Quy trình grant trong một transaction: khóa shop/order/owner; xác nhận shop/order cùng tenant, order có revision hiện hành, owner active cùng shop và owner đã duyệt ticket; bật mode controlled_test; insert/update đúng tuple với DB clock; chỉ cho phép `ON CONFLICT` nếu row cũ đã disabled hoặc hết hạn; ghi `core_audit`; commit khi có đúng một grant. Nếu kiểm tra không trả đúng một row, row grant không được tạo, mode không được bật và operator rollback.

SQL runbook tối thiểu (operator thay psql variables bằng ID từ ticket; dừng và `ROLLBACK` nếu bất kỳ bước nào trả khác một hàng):

```sql
BEGIN;

SELECT ss.shop_id, o.id AS order_id, o.active_revision, u.id AS owner_id
FROM core_shop_settings ss
JOIN core_orders o ON o.shop_id=ss.shop_id
JOIN core_revisions r ON r.order_id=o.id AND r.revision=o.active_revision
JOIN core_users u ON u.shop_id=ss.shop_id AND u.id=:'owner_id'::uuid
WHERE ss.shop_id=:'shop_id'
  AND o.id=:'order_id'::uuid
  AND u.role='owner' AND u.active
FOR UPDATE OF ss,o,u;

UPDATE core_shop_settings
SET mode='controlled_test', printing_enabled=true
WHERE shop_id=:'shop_id'
RETURNING shop_id;

WITH issue_clock AS (SELECT clock_timestamp() AS issued_at)
INSERT INTO core_print_controlled_test_scopes
 (shop_id,order_id,printer_id,enabled,expires_at,configured_by,updated_at)
SELECT :'shop_id', :'order_id'::uuid, :'printer_id', true,
       issue_clock.issued_at + interval '30 minutes', :'owner_id'::uuid,
       issue_clock.issued_at
FROM issue_clock
ON CONFLICT (shop_id,order_id,printer_id) DO UPDATE
SET enabled=true, expires_at=EXCLUDED.expires_at,
    configured_by=EXCLUDED.configured_by, updated_at=EXCLUDED.updated_at
WHERE NOT core_print_controlled_test_scopes.enabled
   OR core_print_controlled_test_scopes.expires_at<=clock_timestamp()
RETURNING shop_id,order_id,printer_id,configured_by,expires_at;

INSERT INTO core_audit(id,shop_id,actor_id,action,order_id,details)
SELECT gen_random_uuid(),s.shop_id,s.configured_by::text,
       'controlled_test.scope.granted',s.order_id,
       jsonb_build_object('printer_id',s.printer_id,'expires_at',s.expires_at,
                          'mode','controlled_test','printing_enabled',true,
                          'ticket_ref',:'ticket_ref')
FROM core_print_controlled_test_scopes s
WHERE s.shop_id=:'shop_id' AND s.order_id=:'order_id'::uuid
  AND s.printer_id=:'printer_id' AND s.enabled;

COMMIT;
```

The operator verifies each `RETURNING` count before proceeding; an already-enabled unexpired row must produce no grant row and is rolled back, so retry cannot silently extend its TTL. Revoke uses the same lock/transaction discipline, updates only that tuple to `enabled=false` and `expires_at=LEAST(expires_at,clock_timestamp())`, turns the shop back to simulation/off, and writes `controlled_test.scope.revoked` to `core_audit` before commit.

Quy trình thu hồi: khóa tuple; đặt `enabled=false`, `expires_at=LEAST(expires_at, clock_timestamp())`, `updated_at=clock_timestamp()`; ghi `core_audit` cùng transaction; đặt shop về simulation và tắt `printing_enabled`; commit. Operator có thể thực hiện thu hồi khẩn cấp dù owner không hoạt động. Sau khi `mark-sending` đã commit thành `SENDING`, revoke không thể rút lại lệnh đã vượt ranh giới gửi; nó chặn mọi gate/lệnh mới và không được dùng để resend `UNKNOWN`.

## Kiểm tra trong Core

`controlledTestScopeExistsSql` loại khỏi queue mọi row thiếu grant, sai tenant/owner/printer, disabled, hết hạn, timestamp tương lai hoặc TTL dài hơn 30 phút. Sau khi chọn ứng viên, Core khóa lại grant và xác minh scope bằng `enforceModeScope` trước khi claim lease. `preflight` và `markSending` gọi lại cùng gate trong transaction đang giữ khóa. Lane pilot dùng cùng điều kiện tại `claimPilot` và qua `assertPilotReady` ở `preflightPilot` / `markPilotSending`.

Nếu grant hết hạn/thu hồi giữa các bước thì preflight hoặc mark-sending bị từ chối, job vẫn `NOT_SENT` và chưa đi qua ranh giới gửi. Mode simulation không cần grant và vẫn là mặc định. `UNKNOWN` không nằm trong queue `NOT_SENT`; trạng thái đó không tự được claim hoặc gửi lại.

## Quyết định sản phẩm cần chốt

Khuyến nghị V1: grant một lần cho đúng **một job của revision hiện hành**, tối đa 30 phút. Thời hạn 30 phút đã được Core kiểm soát; ràng buộc one-shot chưa nằm trong schema hiện tại vì grant hiện gắn shop/order/printer, không gắn revision/job. Nếu giữ scope order-level, một job mới được tạo có thể dùng grant còn hạn sau khi revision đổi; evidence/current-revision/lease vẫn phải hợp lệ, và job `SENDING`/`UNKNOWN` không được resend. Chọn one-shot cần migration và ràng buộc atomic ở Core; chọn scope order-level cho V1 đơn giản hơn nhưng cho phép nhiều job mới trong cùng order trong cửa sổ grant. Đến khi chủ sản phẩm chốt, operator chỉ cấp một grant đang bật cho một order thử và dừng sau job đầu tiên; đây là biện pháp vận hành, chưa phải bảo đảm one-shot ở mức Core.

## Giới hạn

V1 không có màn hình hoặc endpoint owner để cấp grant. Cơ chế operator DB chỉ phù hợp khi có DB operator được phân quyền, ticket phê duyệt owner và audit cùng transaction; nếu môi trường triển khai không có ba điều kiện đó, giữ `mode='simulation'` và `printing_enabled=false`. Việc nối operator command/route và xác minh quy trình vận hành thuộc AI0. Tài liệu này không cho phép gọi OA thật hoặc gửi lệnh in thật.
