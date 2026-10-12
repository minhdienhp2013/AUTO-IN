# AI0 tiếp quản CODE-008 — 12/10/2026

Nền thực tế: `171a74fdeb333bb5b6746d84609ca53a70437867`, PR #31 Draft;
main `e869528482617abbb0a18d140dc15e4c07e0643d` chỉ có CODE-000.
Nguồn AI1 #16 `4c50588a`, staging #35 `a13cebe0`; AI2 #19 `d966c506`,
staging #37 `11e725ab`; AI3 #20 `59d47f8b`; AI4 #15 `ee721abf`;
AI5 #18 `6fd224c0`. Kiểm lại HEAD trước mỗi lần nhận bàn giao.

## Phần AI0 đã sửa trong phiên tiếp quản

- Trigger 004 và các bàn giao CODE-008 đã nằm trong nền; không nhập lại,
  không sửa module AI1–AI5, không xóa test RED.
- `pending-review-errors.ts`: adapter SQL tại composition nhận **đúng**
  `P0001` + message `AI0_PENDING_INBOUND_REVIEW` và chuyển thành Core
  `DomainError PENDING_INBOUND_REVIEW`, HTTP 409, retryable=false. Ánh xạ
  trước wrapper route AI1; Fastify global error handler không thể bắt lỗi mà
  AI1 đã trả 500. Không đổi trigger, rollback, pool lifecycle hay retry.
- Test fault injection kiểm rollback/release, hai đường pool/client,
  lỗi khác giữ nguyên, HTTP không lộ chi tiết SQL. Không gọi đây là PG thật.
- Regression PostgreSQL composition kiểm trigger raw vẫn P0001,
  adapter trả DomainError 409, hai staff HTTP requests cùng bị từ chối,
  0 approval/job và event còn nguyên. Plan/credential trong test có nhãn
  synthetic, không phải AI3/live customer evidence.
- HTTP CI chạy nếu product checks đã PASS dù AI5 acceptance RED; không
  `continue-on-error`, job vẫn FAIL khi AI5 có FAIL.

## Prompt gửi AI1 — thực hiện trước

Bạn là AI1 AUTO-IN, tiếp tục CODE-008 trên PR #16/nhánh cũ.
Đọc AGENTS.md, CODE007, bình luận AI0 mới nhất trên PR #16 và tài liệu này
từ PR #31. Kiểm HEAD thực, giữ lịch sử; chỉ sửa phạm vi AI1.

Hoàn thiện Core Port nguyên tử `apply_incoming_batch` cho AI2:

1. trusted shop/OA do server cấu hình, identity processor thực do server
   xác thực; không nhận Principal từ body/AI2, không giả staff/customer.
2. Trong **một transaction**: kiểm event provenance, khóa generation/
   takeover, resolve 0/1/>1 đơn đang mở theo shop/OA/customer/chat, khóa
   đơn như staff approval, CAS revision/generation, append hoặc tạo theo
   intent rõ. Đừng đọc trước rồi gọi `append_verified_events` ở transaction
   khác; đừng dùng connection/lock ngoài để giả atomicity.
3. Phân biệt appended/existing/created/closed/ambiguous/stale và explicit
   separate. Missing/unmaterialized file vẫn pending, plan NULL; append
   tạo revision/hash mới, không chuyển xác nhận cũ sang bản mới.
4. Pending read model server-scoped, pin order_id/revision/request_hash:
   `current.pending_updates={order_id,revision,request_hash,status,
   unresolved_count,items}`; CLEAR phải có chứng cứ, không chỉ batch DONE.
5. Quy ước lock cùng thứ tự với approval/ingress/takeover để tránh deadlock;
   test PostgreSQL hai connection/worker, lost ACK, replay, tin cũ, takeover
   race, approval race, 0 print job khi pending, append không tạo đơn trùng.
6. Core approve cần kiểm journal đúng shop + event có trong revision hợp lệ,
   không chỉ tồn tại journal; phối hợp trigger AI0, không bypass trigger.

Chốt shape với AI2 trước bàn giao; commit/push/update PR, báo 6 dòng SHA và
PASS/FAIL/SKIP/NOT RUN. Không merge/deploy/OA/Ricoh thật.

## Prompt gửi AI2 — sau hợp đồng AI1

Bạn là AI2 AUTO-IN, tiếp tục CODE-008 PR #19/nhánh cũ.
Đọc bình luận AI0 và bàn giao Core nguyên tử mới của AI1 PR #16; giữ code cũ,
chỉ sửa file AI2. Nối mapper/processor với shape Core đã được kiểm chứng;
không read-before-append hay tạo Principal giả. Khi thiếu Port, ambiguous,
stale hoặc missing file: giữ HELD/NEEDS_HUMAN. Test hai batch >60 giây,
explicit separate, replay/ACK-loss, receipt ordering, generation takeover,
không nhãn ready khi tài liệu chưa materialize. Bàn giao SHA/test 6 dòng;
không tự merge/deploy/OA/in thật. AI0 nối composition sau bàn giao.

## Prompt gửi AI5 — có thể thực hiện ngay phần error contract

Bạn là AI5 AUTO-IN, tiếp tục CODE-008 PR #18/nhánh cũ.
Đọc HEAD thực PR #31, bình luận AI0 và tài liệu này. Chỉ tests/acceptance/**,
docs/acceptance/** và public fixtures theo quyền cũ.

- C008-HTTP-03 và C008-PG-07: Core mới ném DomainError
  `PENDING_INBOUND_REVIEW`, HTTP 409 trước trigger; sửa kỳ vọng raw P0001
  **chỉ ở service path**. Direct SQL trigger vẫn phải kiểm P0001. Giữ
  assertions 0 approval/job, cả hai worker bị từ chối, event bền vững.
- C008-PG-02 giữ RED cho tới khi Core Port nguyên tử được tích hợp. Sau đó
  gọi **Port sản phẩm thật**; vẫn đòi cùng order_id, revision tăng, plan
  đầy đủ file, xác nhận lại, approval đúng revision. Không thay bằng gọi
  append thủ công để tuyên bố automatic pipeline đã đạt.
- Chạy exact integrated SHA, PG/HTTP/Chromium/DryRun; replay/tin cũ/
  lost ACK/generation/approval races. Ghi synthetic và live tách biệt.

Commit/push/update PR, bàn giao 6 dòng. Không bỏ FAIL/chuyển SKIP/merge/deploy.

## Quyết định merge

Chủ đã cho phép merge dần; PR #31 vẫn Draft vì automatic append chưa có
và AI5 chưa GREEN. Không merge toàn bộ hoặc tuyên bố V1/TN-037 đạt.
OA/Ricoh/Windows/iPhone thật và TN-037 210 đơn/7 ngày còn NOT RUN.
