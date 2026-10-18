# AI2 V1-ZALO-09 — tuyến nhân viên cho attachment chưa có bytes xác minh

**Ngày:** 18/10/2026

**Nhánh:** `ai2/v1-zalo-09-manual-media-route-20261018`

**Base:** `4843009ef3f2999c75630b967007ec900f2cef0d`

**Trạng thái:** Hoàn tất trong phạm vi AI2 mô phỏng; không bật live transport.

## Kết quả kiểm tra

- `createOfficialZaloWebhookAdapter` chỉ đưa `user_send_text` vào normalizer hội thoại. Sự kiện `user_send_image`, `user_send_file` và event chưa hỗ trợ đi vào `createOfficialZaloQuarantineReceiver`, với `status=NEEDS_HUMAN`, `pending=true` và loại giới hạn `image`/`file`.
- OA lấy từ cấu hình server. Sender chỉ gắn shop/customer/conversation nếu `resolve_verified_user` trả mapping server-side. OA mismatch bị từ chối; event không có mapping được giữ ở cấp OA. Không đọc order id, revision, attachment URL, tên file hay nội dung từ payload để tạo order hoặc chọn attachment.
- Quarantine lưu `raw_sha256`, loại, scope đã map nếu có, `provider_claimed_event_id` chưa được xác minh độc lập, trạng thái và thời điểm. Không lưu URL, filename, bytes, attachment index hay order claim. Không có downloader, OCR, proposal, confirmation, approval hoặc print-job Port trong nhánh AI2 này.
- Ở simulation composition hiện có, receipt quarantine `image`/`file` còn pending được AI0 chuyển thành staff item `NEEDS_HUMAN` / `AWAITING_MEDIA`. Danh sách nhân viên trả metadata hạn chế; chưa có bytes nên đây là phiếu chờ xử lý/yêu cầu khách gửi lại theo hướng dẫn nhân viên, không phải tài liệu đã sẵn sàng để in.
- AI2 không phát thông báo khách và không đưa văn bản khách vào outbox. HTTP 200 của webhook chỉ xác nhận event đã được lưu/quarantine cho Zalo; nó không phải phản hồi cho khách và không khẳng định đã nhận hoặc xử lý được nội dung file. Chưa có bằng chứng khách đã được thông báo. Nếu về sau cần trả lời khách, phải dùng outbox/quyền gửi đã duyệt và nội dung nói rõ “tệp chưa xác minh; yêu cầu đang chờ nhân viên”, không dùng thông điệp hoàn tất.
- Replay cùng raw event trả lại một quarantine receipt; receipt trùng còn pending có thể giúp AI0 sửa khoảng trống tạo staff pointer sau sự cố. Đây là retry idempotent của ingress/queue, không phải retry tải media. Không tải URL webhook/khách và không áp dụng giới hạn hai lần tải TN-012 khi chưa có transport.

## Kiểm soát mới

`tests/unit/zalo/official-quarantine.test.mjs` bổ sung fixture synthetic cho:

1. Nhiều attachment không xác định được phần cần in; claim order/revision giả và `msg_id` trùng một text event đã nhận không thể chọn file, ghi đè text hoặc liên kết đơn.
2. Event image thiếu bytes (chỉ có metadata URL): vẫn `NEEDS_HUMAN`; không gọi mạng, không lưu locator/bytes và không chuyển normal event.
3. App/OA claim sai: từ chối trước DB write.
4. Bốn webhook cùng raw event chạy đồng thời: một receipt `held`, các lượt còn lại `duplicate`, không có normal event/downstream effect.
5. Response không có customer message/copy xác nhận thành công.

## Kiểm thử local

- `node --experimental-strip-types --test tests/unit/zalo/official-quarantine.test.mjs`: **8 PASS / 0 FAIL**.
- `npm run test:zalo` với Node `v24.19.0`: **161 PASS / 6 SKIP / 1 test-file failure**. Ca lỗi duy nhất là `tests/unit/zalo/typecheck-strict.test.mjs` không nạp được package `typescript` (`ERR_MODULE_NOT_FOUND`); 6 test PostgreSQL được bỏ qua vì thiếu `TEST_DATABASE_URL`/`AUTOIN_TEST_DATABASE_URL`.
- Các test PostgreSQL Core/simulation được trích dẫn dưới đây chưa được chạy trong môi trường này; chúng không được tính là bằng chứng PASS của SHA V1-ZALO-09.

Các bằng chứng Core/simulation đã có trên base và được để nguyên:

- `tests/unit/core/inbound-review-items.test.cjs`: staff item `NEEDS_HUMAN`/`AWAITING_MEDIA`, replay không tạo order, scope nhân viên bị giới hạn, thiếu quarantine/DB lỗi đóng an toàn.
- `tests/integration/composition/official-zalo-runtime-pg.test.mjs`: signed synthetic image/file vào staff queue, retry sửa queue-gap, HTTP approval đang chờ trả 409, không có approval/print job do gate.

## Giới hạn

- Đây là test synthetic, không xác thực chữ ký bằng vector do Zalo cấp, không gọi API/OA thật, không chứng minh bytes hoặc file của khách đã được custody.
- Core queue hiện chỉ giữ phiếu chờ và safe metadata; AI2 không có locator/bytes để nhân viên mở file. Nhân viên cần dùng quy trình đã được chủ duyệt để yêu cầu gửi lại hoặc nhận file qua kênh an toàn.
- Khả năng truyền attachment của OA, thời hạn URL, xác thực media HTTP, redirect, lỗi, kích thước inbound và digest ảnh vẫn `NOT RUN`/chưa xác minh theo TN-022. Không merge, deploy, nhắn khách hoặc in thật.
