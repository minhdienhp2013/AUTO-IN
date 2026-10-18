# AI2 V1-ZALO-12 — đối chiếu tài liệu Zalo OA về media inbound

**Ngày tra cứu:** 18/10/2026
**Nhánh:** `ai2/v1-zalo-12-official-inbound-doc-research-20261018`
**Base:** `ceee7706186757b4147c623efc339e8af09f1ced`
**Kết luận:** public docs mô tả webhook và metadata attachment; chưa công bố đủ contract để tải/giải phóng bytes inbound. Giữ NO-GO downloader.

## Phạm vi và kết luận chính

Chỉ tra cứu tài liệu Zalo OA chính thức tại `developers.zalo.me` và bản tài liệu hiện hành được phục vụ từ `stc-developers.zdn.vn`. Không dùng tài liệu của bên thứ ba và không dùng API upload outbound để suy ra tải inbound. Không gọi API/OA, không dùng credential và không tải URL media.

Tài liệu **“Sự kiện người dùng gửi tin nhắn”** nêu event `user_send_file`/`user_send_image`, webhook `POST` tới URL đã đăng ký, công thức `X-ZEvent-Signature`, cùng `message.attachments[]`. File attachment mẫu có `size`, `name`, `checksum` MD5, `type` và `url`; mô tả URL là đường dẫn download. Đây là bằng chứng về field trong event, không phải hướng dẫn HTTP tải hoàn chỉnh.

Không tìm thấy một API inbound riêng nhận event/attachment ID để lấy bytes, hoặc đặc tả chính thức cho HTTP method/header xác thực khi lấy URL trong attachment. Các trang đã rà soát cũng không quy định TTL/refresh, redirect/host policy, retry/rate/error semantics, giới hạn dung lượng inbound, deletion hay retention của media. Do đó chưa đủ căn cứ để viết downloader hoặc xác nhận bytes tải về khớp với file gốc.

## Kết quả theo hạng mục

| Hạng mục | Tài liệu Zalo OA công khai | Kết quả cho AUTO-IN |
| --- | --- | --- |
| Webhook inbound | “Sự kiện người dùng gửi tin nhắn” nêu request `POST`, JSON, URL webhook đã đăng ký; payload có `app_id`, `sender`, `recipient` (OA), `event_name`, `message`, `timestamp`. | **Được mô tả một phần.** Có cấu trúc event và webhook ingress. Đây không phải endpoint để ứng dụng tải file từ Zalo. |
| Attachment/event binding | `message.attachments` là mảng nằm trong message; `message.msg_id` được mô tả là ID tin nhắn. Phần tử file có `type: file` cùng `payload`. | **Được mô tả theo cấu trúc JSON.** Không thấy `attachment_id` ổn định hay API lookup theo ID. Mảng `attachments` thuộc event đã ký nếu chữ ký được xác minh, nhưng tài liệu không nêu versioning hoặc quy tắc định danh riêng từng phần tử. |
| Locator và endpoint | File payload có `url`, được mô tả là đường dẫn để download. | **Chỉ có locator trong event.** Không có endpoint inbound riêng, HTTP method cụ thể, request path chuẩn hoặc response contract. GET chỉ là suy luận thường gặp từ thao tác download, không phải điều tài liệu xác nhận. |
| Webhook signature | Tài liệu nêu `X-ZEvent-Signature` theo công thức `sha256(appId + data + timeStamp + OAsecretKey)` và mô tả `data` là chuỗi JSON của event; timestamp là thời điểm request, tính millisecond. | **Có công thức, thiếu kiểm chứng exact-byte.** Không có golden vector do Zalo phát, quy tắc raw HTTP bytes so với JSON sau parse/serialize, encoding/newline/escaping chuẩn hóa hay định dạng chữ ký mẫu có thể xác minh độc lập. Đây là chữ ký của webhook, không phải tài liệu xác thực GET media. |
| Auth khi tải media | Không thấy quy định access token, cookie, header, signature, scope hay việc URL tự chứa quyền truy cập. | **Không được tài liệu hóa trong các trang đã rà soát.** Không suy ra cần/không cần OA token; không gửi secret hoặc token đến URL. |
| Bytes và checksum | File mẫu ghi `size` là kích thước file và `checksum` là MD5 để kiểm tra toàn vẹn; ví dụ size được biểu diễn bằng chuỗi số. | **Có checksum metadata một phần.** Không thấy đơn vị/đảm bảo bắt buộc của `size`, checksum có áp dụng cho mọi file hay cách đối chiếu đúng bytes HTTP (raw body, content-encoding/transfer) không. `checksum` trong ví dụ không phải exact-byte test vector. |
| Ảnh | Ví dụ image có `thumbnail` và `url` ảnh gốc; không thấy `size` hoặc checksum bytes trong schema ví dụ. Một số URL ví dụ dùng `http`, file sample dùng `https`. | **Chưa có kiểm tra integrity cho ảnh từ docs.** Scheme trong ví dụ không phải chính sách TLS. Không suy luận HTTP được phép hoặc hostname đó là allowlist. |
| TTL/expiry/refresh | Không thấy thời hạn URL, mốc bắt đầu tính hạn, one-time/reusable, API lấy URL mới hoặc hành vi khi URL hết hạn. | **Không được tài liệu hóa trong các trang đã rà soát.** Không thiết kế xử lý dựa trên TTL giả định. |
| Redirect/host/TLS | Không thấy quy tắc redirect, hostname/CDN allowlist, giới hạn hop, TLS, port hay DNS/IP policy. | **Không được tài liệu hóa.** URL mẫu không đủ để tạo allowlist an toàn. |
| Retry, rate/error | Tài liệu webhook overview mô tả Zalo gửi POST đến webhook; không thấy trong các trang đã rà soát lịch retry inbound, HTTP error mapping, rate limit, `Retry-After` hoặc retry đối với GET media. | **Không được tài liệu hóa trong các trang đã rà soát.** Không dùng retry webhook để suy ra retry tải media. Quy tắc nội bộ TN-012 vẫn riêng: tối đa hai lần thử tải sau khi một downloader được phê duyệt và có contract. |
| Size limit, deletion/retention | Có một field size trong ví dụ attachment file nhưng không có max inbound; không thấy API xóa media hay retention/expiry policy. | **Không được tài liệu hóa.** Không suy giới hạn inbound từ endpoint upload outbound hoặc kích thước của file ví dụ. |

## Hệ quả triển khai

- Không tải `attachments[].payload.url` ở candidate. Giữ event trong quarantine/hàng chờ nhân viên `NEEDS_HUMAN` / `AWAITING_MEDIA` theo tuyến hiện tại; không coi metadata là artifact bytes đã xác minh.
- Không tạo order/proposal/confirmation/approval/print job hoặc thông báo hoàn tất dựa trên attachment chưa có custody bytes.
- Để mở downloader PDF/Word, cần Zalo xác nhận bằng tài liệu hoặc trả lời hỗ trợ chính thức: method/path/headers/auth; ràng buộc event/OA/attachment; TTL và cách refresh; redirect/host/TLS policy; giới hạn bytes/loại file và semantics của size/MD5 trên bytes chính xác; status/error/rate/retry; policy xóa/retention; cùng vector chữ ký webhook exact-byte.
- Chỉ sau khi có contract mới chạy synthetic tests cho transport. Kiểm chứng OA thật theo TN-022 là cổng riêng và cần chủ cửa hàng phê duyệt; nhiệm vụ này chưa thực hiện.

## Trạng thái repo tại lúc làm

- Base `ceee7706186757b4147c623efc339e8af09f1ced` tồn tại cục bộ và là parent trực tiếp của nhánh này. GitHub API không tìm thấy SHA đó; candidate SHA đang local-only.
- GitHub `main` tại `cb2be7a7b84d689dbe6c2c773192f111897c4063`. PR #156 Draft, HEAD `b68298b7d4436b22c66b91deec542ae55ce48d68`; PR #160 Draft, HEAD `c909202035787fb15ffceb2cd2d48097f92684cb`. Actions `CODE checks` và `AI0 composition integration` ở hai HEAD đều SUCCESS; comments/review comments rỗng. Các workflow đó là kiểm thử synthetic, không xác minh tải media live.
- Không có PR/Actions cho nhánh V1-ZALO-12 này; không push/merge/deploy.

## Nguồn Zalo OA chính thức

1. [Zalo For Developers — Sự kiện người dùng gửi tin nhắn](https://developers.zalo.me/docs/api/official-account-api/webhook/su-kien-nguoi-dung-gui-tin-nhan-post-3720) — event schema, webhook method/signature, attachment file/image.
2. [Zalo For Developers — bản tài liệu webhook hiện hành: Sự kiện người dùng gửi tin nhắn](https://stc-developers.zdn.vn/docs/v2/official-account/webhook/tin-nhan/su-kien-nguoi-dung-gui-tin-nhan?lang=vi) — đối chiếu schema `user_send_file`, `user_send_image` và các field `size`, `checksum`, `url`.
3. [Zalo For Developers — Giới thiệu về Webhook](https://developers.zalo.me/docs/official-account/webhook/tong-quan) — mô tả chung về POST event tới webhook URL đã đăng ký.
