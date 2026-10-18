# AI2 V1-ZALO-08 — hợp đồng media riêng tư từ Zalo OA

**Ngày khảo sát:** 18/10/2026
**Nhánh:** `ai2/v1-zalo-08-provider-media-contract-20261018`
**Base:** `92d39adc8f76a0e7e52e60356e2f18155496d5bc`
**Trạng thái:** `BLOCKED` cho việc nối transport media. Phần khảo sát và hợp đồng thiết kế đã hoàn tất.

## Kết luận

Tài liệu chính thức hiện có **không mô tả một API nhận `event_id`/`attachment_id` rồi xác minh và trả media gắn với OA**. Webhook người dùng gửi tin nhắn có `message.attachments[].payload.url`; tài liệu gọi đây là đường dẫn tải file/ảnh. Metadata attachment nằm trong JSON webhook có `X-ZEvent-Signature`. Với attachment `type=file`, payload còn có `size` và `checksum` MD5. Đây là một chuỗi ràng buộc khả dĩ: xác thực nguyên event theo App/OA đã cấu hình, chọn đúng attachment trong event, tải đúng locator đã ký, rồi so kích thước và MD5 với metadata trong event.

Chuỗi trên **chưa đủ để bật transport cho toàn bộ media V1**:

- Ảnh chỉ có `url` và `thumbnail`; tài liệu không nêu kích thước hay checksum của bytes ảnh. URL được ký trong event nhưng bytes trả về không có digest của Zalo để đối chiếu.
- Công thức chữ ký được công bố, nhưng tài liệu không cung cấp vector chữ ký chính thức để xác nhận cách lấy chính xác bytes/chuỗi `data`. Code hiện tại cũng ghi rõ giả định raw-body chưa được xác minh bằng vector Zalo.
- Không có hợp đồng tải media mô tả phương thức/header xác thực, hạn dùng URL, redirect, status/error, retryability hoặc giới hạn tải inbound. Các ví dụ URL cũng không công bố allowlist host ổn định; ví dụ ảnh có cả `http`.
- Quarantine hiện chỉ lưu SHA-256 của event và một số metadata hạn chế; không giữ attachment locator/checksum/size để tra cứu lại theo `quarantine_id`. `provider_claimed_event_id` chỉ là giá trị tự khai trong payload, không phải khóa xác thực.

Theo ưu tiên V1 Word/PDF, ảnh vẫn được nhận và chuyển nhân viên; chưa cần tải ảnh tự động. Với file PDF/Word, metadata cho phép thiết kế kiểm tra file ở mức MD5 + kích thước, nhưng việc tải thật vẫn phải chờ xác nhận contract HTTP, hạn dùng, giới hạn, chữ ký exact-byte và cách lưu locator riêng tư. **Giữ transport chưa wired; không tải URL từ webhook/khách trong nhiệm vụ này.**

## Bằng chứng từ Zalo và cách diễn giải

| Hạng mục | Tài liệu chính thức nêu | Hệ quả cho AUTO-IN |
| --- | --- | --- |
| Sự kiện người dùng gửi tin | Zalo POST đến webhook URL đã đăng ký; ví dụ có `app_id`, `sender.id`, `recipient.id` (OA), `event_name`, `message.msg_id`, `timestamp`. Header `X-ZEvent-Signature` có công thức `mac = sha256(appId + data + timeStamp + OAsecretKey)`. | Event scope phải được kiểm bằng secret/app/OA từ server registry; `app_id`/`recipient.id` hoặc `oa_id` phải khớp scope đã cấu hình. Không tin ID từ query/client. |
| Ảnh | `message.attachments[]` có `type: image`, `payload.url` (ảnh gốc) và `payload.thumbnail`. Schema công bố không có `size` hoặc `checksum` cho ảnh. | Có thể ràng buộc locator vào event nếu chữ ký hợp lệ; chưa chứng minh bytes tải về là đúng phiên bản ảnh trong event. Không tự động tải/xử lý ảnh. |
| File | `type: file`; payload mẫu có `size`, `name`, `checksum`, `type`, `url`. Tài liệu gọi `checksum` là MD5 của file để kiểm tra toàn vẹn; `url` là đường dẫn tải file. | Với PDF/Word, adapter tương lai phải tải đúng locator lấy từ event đã xác minh, kiểm số byte và MD5 chính xác trên bytes nhận được; sau đó tính SHA-256 cục bộ để tạo artifact identity. MD5 không thay thế chữ ký webhook và không áp dụng nếu thiếu checksum. |
| Endpoint/media auth | Ingress là `POST` tới webhook URL đã đăng ký. Media chỉ có locator `message.attachments[n].payload.url`, được mô tả là URL/đường dẫn tải. Có thể hiểu cần tải URL đó (thường là HTTP GET), nhưng tài liệu không ghi rõ method/header xác thực. Không có endpoint cố định kiểu `GET /media/{event}/{attachment}` hoặc quy định `access_token` cho URL tải. | Đây là URL cụ thể đi kèm event, không phải API tra cứu theo ID. Không suy ra hoặc gửi OA token/secret cho CDN. Không coi URL bất kỳ là API có xác thực theo event/OA. |
| Hạn dùng và lỗi | Trang webhook không công bố TTL, refresh API, trạng thái lỗi tải, mã lỗi, xử lý redirect hay retry semantics. | Ghi đây là chưa biết; không đặt TTL hoặc phân loại lỗi giả định thành cam kết của Zalo. |
| Giới hạn inbound | Schema ví dụ nêu kích thước của một file mẫu, không phải giới hạn. Trang webhook không công bố max bytes/loại file inbound tổng quát. | Không dùng kích thước mẫu làm max. Mọi giới hạn local phải cấu hình rõ, stream và dừng trước khi vượt ngưỡng. TN-022 vẫn cần xác minh quyền/định dạng/dung lượng OA. |

### Không nhầm API upload với tải file khách gửi

Tài liệu upload file mô tả `POST https://openapi.zalo.me/v2.0/oa/upload/file` với `access_token` để **đẩy file từ hệ thống đối tác lên Zalo và nhận token dùng khi gửi tin**. Đây không phải API tải attachment do khách gửi về. Endpoint đó không xác minh ràng buộc event/OA của file inbound; giới hạn PDF/DOC/DOCX/CSV tối đa 5 MB của upload outbound cũng không phải giới hạn inbound. Hợp đồng này không dùng endpoint upload hoặc `access_token` của luồng outbound để suy diễn API download inbound.

## Hợp đồng thiết kế cho adapter tương lai

Contract này là yêu cầu fail-closed, chưa phải implementation hay provider verification.

### Nguồn và nhận dạng

1. Chỉ nhận source từ hàng quarantine đã được ingress xác thực chữ ký và resolve bằng `quarantine_id` cùng registry server-side `(shop_id, oa_id, app_id)`. Payload/URL do browser, nhân viên hoặc khách truyền vào không được dùng làm locator.
2. Lưu `raw_event_sha256` của đúng raw event. Khi đối chiếu lại, event hash, quarantine row, app, OA, `event_name`, `message.msg_id` và attachment phải khớp. `message.msg_id` vẫn là claim để đối soát, không thay `raw_event_sha256` làm idempotency key.
3. Event phải xác định được đúng OA: `oa_id` hoặc `recipient.id` phải khớp OA được cấu hình. Nếu thiếu hoặc mâu thuẫn thì giữ ở OA-level `NEEDS_HUMAN`; không tự gán theo customer.
4. Chọn một attachment cụ thể bằng vị trí trong mảng + `type` + digest event. Nếu có nhiều attachment nhưng source không chỉ rõ phần cần lấy, không chọn phần tử đầu theo phỏng đoán; giữ người kiểm tra.
5. Locator/checksum/size cần được giữ tạm thời theo một storage contract riêng tư có quyền truy cập và retention rõ ràng, hoặc được xử lý trong lúc ingress còn raw event. Không ghi URL chứa capability vào log, DTO trình duyệt, error, analytics hay thông báo. Hạn dùng URL chưa biết nên không thiết kế luồng tải muộn dựa trên thời gian giả định.

### Tải và xác minh bytes

- Chỉ dùng URL lấy từ attachment thuộc event đã xác thực; tuyệt đối không nhận URL người dùng tự gửi. Trước khi implementation, AI0 cần chốt URL/metadata custody và allowlist host. Mỗi redirect phải bị từ chối hoặc kiểm lại scheme, host, DNS/IP và giới hạn theo từng hop; không forward OA secret/token.
- Với `type=file`, yêu cầu `size` là số nguyên dương, `checksum` đủ định dạng MD5, URL đúng attachment. Tải theo stream với timeout, byte cap cấu hình, tổng byte bằng `size`, MD5(bytes) bằng checksum. Chỉ sau đó mới tính SHA-256(bytes), ghi private object và manifest.
- Với `type=image`, nếu provider chưa bổ sung checksum/kích thước hoặc contract bất biến tương đương được Zalo xác nhận thì **không tải vào custody tự động**; giữ metadata và chuyển người.
- URL lỗi, redirect ngoài policy, response rỗng, quá giới hạn, sai byte count/hash, content không đọc được hoặc source thay đổi đều phải fail closed: không tạo manifest, không giải phóng quarantine và không mutate đơn/proposal/confirmation/approval/print job.
- Theo TN-012, lỗi tải có thể thử lại tối đa 2 lần rồi chuyển người; retry phải cùng source/event/attachment và không biến event replay thành download mới ngoài giới hạn đó. Zalo chưa công bố status nào transient/permanent, vì vậy implementation phải ghi riêng policy local, không gán đó là semantics chính thức.

### Ranh giới trạng thái và lưu trữ

- Verified media chỉ có thể trở thành artifact gắn với receipt; bước này không xác nhận yêu cầu in, không tạo đơn, không xác nhận khách, không duyệt và không tạo job in.
- Trạng thái phải ở `AWAITING_MEDIA`/`NEEDS_HUMAN` cho tới khi bytes, manifest và review bằng người đủ điều kiện. Không diễn giải `provider_claimed_event_id` hoặc URL còn truy cập được như bằng chứng đã kiểm tra nội dung.
- Theo TN-011, file gốc/preview/OCR/cache xóa tối đa 30 ngày sau khi đơn hoàn tất hoặc đóng hợp lệ. Với đơn/quarantine chưa đóng, cần chính sách giám sát và đóng ngoại lệ theo TN-031/036; không tự xóa khi chưa có trạng thái terminal có thẩm quyền. Backup/legal hold cần chính sách riêng.
- Trên Windows, private ACL/reparse protection phải được kiểm chứng riêng; POSIX mode `0700` không thay cho Windows DACL. Không lưu file private trong web/static directory.

## Ca contract bắt buộc trước khi wired

Không thêm test code trong nhiệm vụ khảo sát vì transport chưa có implementation ở base và không có endpoint/live test được phép dùng. Trước khi mở wiring, cần test synthetic/harness riêng cho:

1. Chữ ký sai, sai `app_id`, sai/mất OA recipient, app/OA registry mismatch, payload/event hash thay đổi.
2. `user_send_file` với một file PDF/DOC/DOCX: attachment cụ thể, URL metadata chỉ lấy từ raw event đã xác thực, byte count và MD5 đúng; SHA-256 artifact/manifest đúng.
3. Sai/mất size hoặc checksum, hash mismatch, attachment URL thay thế, nhiều attachment mơ hồ, mismatch `message.msg_id` claim, response rỗng/oversized/truncated/corrupt.
4. URL không TLS, host không trong allowlist, DNS private/loopback, redirect sang host/IP khác, timeout/abort và không để URL/token lọt log/DTO.
5. `image` thiếu checksum/size luôn giữ người; không tạo object/manifest.
6. Retry cap, duplicate webhook, concurrent capture, source row đổi trong lúc I/O; không tạo đơn, confirmation, approval hoặc print job.
7. ACL/symlink/reparse race, quyền truy cập, dọn file và TN-011 cho artifact đã đóng; kiểm tra Windows thật riêng trước khi dùng trên host trung tâm.

## Kiểm tra repo và giới hạn bằng chứng

- GitHub `main` được kiểm tra ở `cb2be7a7b84d689dbe6c2c773192f111897c4063`. GitHub không tìm thấy base `92d39adc...`, commit V1-ZALO-07 `1fc6a6e6...` hoặc remote branch/PR cho V1-ZALO-07/08; các SHA/branch nêu ở trên chỉ có trong bản sao cục bộ tại lúc kiểm tra. Không có Actions/handoff comments/PR review cho nhánh V1-ZALO-08 để báo.
- Base được chỉ định `92d39adc8f76a0e7e52e60356e2f18155496d5bc` có quarantine nhận sự kiện nhưng không lưu raw event hoặc attachment locator. Migration quarantine lưu `raw_sha256`, `kind`, các ID đã map/claim, trạng thái và thời gian nhận.
- Nhánh/commit V1-ZALO-07 `1fc6a6e6f35c1832bb877cceee1bd8751b089fe7` là code custody thử nghiệm riêng; test với transport tổng hợp không chứng minh Zalo URL/auth/TTL/hash thật và không được nhập vào base này để bật tải thật.
- Tài liệu ưu tiên V1 ngày 18/10/2026 quy định ảnh được nhận và chuyển nhân viên, không OCR/tự xử lý; lõi tự động V1 tập trung Word/PDF. Contract này không mở rộng ảnh thành auto-processing.
- Không gọi API, không dùng OA/account thật, không tải URL từ webhook/khách. Chưa kiểm chứng chữ ký trên vector do Zalo phát, CDN, HTTP headers, TTL, lỗi, kích thước inbound, Windows DACL hoặc retention bằng production data.

## Nguồn

1. [Zalo For Developers — Sự kiện người dùng gửi tin nhắn](https://developers.zalo.me/docs/api/official-account-api/webhook/su-kien-nguoi-dung-gui-tin-nhan-post-3720) — webhook, `X-ZEvent-Signature`, event fields và attachment schemas.
2. [Zalo For Developers — bản tài liệu webhook hiện hành được phục vụ trên host tài liệu Zalo](https://stc-developers.zdn.vn/docs/v2/official-account/webhook/tin-nhan/su-kien-nguoi-dung-gui-tin-nhan?lang=vi) — ví dụ schema chi tiết cho image/file; tra cứu 18/10/2026.
3. [Zalo For Developers — Upload file](https://stc-developers.zdn.vn/docs/v2/official-account/tin-nhan/quan-ly-tin-nhan/upload-file) — `POST https://openapi.zalo.me/v2.0/oa/upload/file`, chỉ tham chiếu để phân biệt upload outbound với download inbound.
4. [Đặc tả TN-001–TN-037 và TN-005A](../spec/DAC_TA_TN001-TN037.md) — TN-004, TN-011, TN-012, TN-022.
5. [Ưu tiên V1 Word/PDF và Phase 2](../architecture/V1_WORD_PDF_SCOPE_20261017.md) — cập nhật 18/10/2026.
