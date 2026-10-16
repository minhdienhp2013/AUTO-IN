# AI0 CODE009 — quyết định hợp đồng, 16/10/2026

BASE main `cb2be7a7b84d689dbe6c2c773192f111897c4063`. Đã đọc đủ ba luật, PR113 HEAD `8af14e63` và PR117 HEAD `495eb579`. Chưa merge/deploy/OA/in thật.

## AI1 CODE501 — được triển khai giai đoạn2 theo các quyết định sau

- GET/PATCH `/api/v1/settings/schedule`; GET owner/staff, PATCH owner từ session máy chủ. Shop chỉ từ principal, không nhận shop/actor/role/mode/printing_enabled trong PATCH. Giữ mode và printing_enabled không đổi. GET no-store.
- Chỉ lịch/khóa **in**: timezone `Asia/Ho_Chi_Minh`, giờ HH:mm, mở<đóng, `24:00` chỉ close, không qua đêm; tối đa730 ngày Gregorian hợp lệ, không trùng, lưu sắp xếp. AI reply schedule/special-date override/pause tách hợp đồng khác; không dùng manual_lock in làm pause AI.
- AI1 sở hữu migration mới `backend/storage/migrations/008_shop_schedule.sql` và manifest migration Core; version BIGINT1..9007199254740991, metadata update và bảng audit shop riêng. Không sửa migration cũ, không xóa audit tự động. Chuyển BIGINT pg string bằng kiểm tra số an toàn trước tính toán.
- Version/CAS và PgStore.once; auth/validation trước replay. No-op đúng version không tăng version/audit; key mới version cũ409; cùng key payload khác409. Response replay là snapshot cũ, UI GET lại. Giữ envelope hiện hành `{error:{code,message,retryable}}`; stale409 `STALE_SETTINGS_VERSION`, chưa thêm current_version vào shared errors.
- PATCH chỉ khóa settings row, không khóa order/job. Giữ thứ tự order→job→settings ở print gate. Claim không candidate trả job:null; candidate gặp shop đóng409 PRINT_CLOSED. Preflight/markSending kiểm lại; không đổi SENDING/UNKNOWN hoặc tự resend.
- AI1 được sửa service mới, factory, routes/RouteRegistrar hỗ trợ PATCH, migration/manifest và test trong phạm vi AI1. AI0 nối PATCH thật tại composition/shared OpenAPI/runner sau bàn giao; AI4 nối UI sau contract. Không tự sửa file AI0/AI4.
- Kiểm PostgreSQL18.3 hai pool + Fastify thật: quyền/cross-shop/invalid fields/date/version/replay/no-op; PATCH-before-markSending và thứ tự ngược. Kết quả phải giữ mode/printing_enabled, số jobs/approvals đúng và không in thật. Phân biệt DB-unavailable503 có kiểm soát với lỗi logic500, không blanket catch.

## LOAD100 — adopt nguồn vào chính đơn AI2 hiện có

POST `/internal/simulation/inbound-artifacts/:event_id/adopt`, staff/owner Bearer từ Core auth, chỉ khi cấu hình syntheticArtifactIngest và shop simulation. Body đúng `{order_id,paper,copies,duplex,idempotency_key}`; order UUID, paper A4/A3, copies1..20, duplex boolean, key1..128 ký tự chữ/số/:/_/-. Không nhận path/hash/customer/event trong body.

AI0 wrapper gọi nguyên helper provenance `adoptSyntheticSuggestedSource` và Core.revise; không tạo order mới. Receipt HTTP200 `{status:'adopted',order_id,revision:2,requires_customer_confirmation:true,preview_trusted:false}`, no-store. Cùng actor/key/payload trả cùng receipt đã commit, kể cả order đã có revision sau; payload khác hoặc key khác trên event đã dùng409. Scope/quyền/mode kiểm trước replay. Receipt PENDING409 `SOURCE_ADOPTION_PENDING_RECONCILIATION`, không thử Core lại sau crash mơ hồ. Lần tranh chấp khi chưa có receipt409 IN_PROGRESS, client không được suy thành đã thành công.

Migration AI0 riêng `006_source_adoption_receipts.sql` không xung đột migration Core008 của AI1. Không giữ connection/transaction trong lúc gọi Core qua pool khác; tránh cạn pool khi5HTTP song song. Receipt commit tách Core: crash ở giữa có thể cần đối soát, tuyệt đối không tự đoán/revise lại.

## AI5 — lỗi harness phải sửa đúng ownership trước nghiệm thu số đo

Review chỉ đọc PR117 HEAD495eb579 phát hiện throughput chia thêm100; worker kiểm `w.errors` dù không có field đó. AI5 sửa công thức đo và kiểm các field thực `held/needs_human/retry`; nêu rõ retry nào chấp nhận. Bổ sung assertion replay revision/status và lịch sử revisions1,2,3; queue không còn pending ở cả durable process queue và batches; JSON ghi exact source SHA. Bảo đảm bounded tasks kết thúc/hủy trước cleanup khi có lỗi. Đừng tạo bộ LOAD100 thứ hai.

AI0 chạy harness nguyên blob trên candidate mới để kiểm điểm nối, nhưng chưa gọi đó là nghiệm thu LOAD100 hoàn chỉnh khi các giới hạn số đo/assertion trên chưa được AI5 xử lý. Kết quả100 batch không thay24giờ/210đơn thật/7ngày/TN037.
