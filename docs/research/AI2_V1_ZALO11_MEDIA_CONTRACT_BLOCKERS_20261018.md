# AI2 V1-ZALO-11 — NO-GO bàn giao media inbound

**Ngày kiểm tra:** 18/10/2026
**Nhánh:** `ai2/v1-zalo-11-media-contract-blockers-20261018`
**Base:** `71a59b5bf78ebb35f8e18e99d31a0730c661c0a7`
**Kết luận:** `NO-GO` cho tải bytes PDF/Word từ Zalo OA. Chưa có contract tải inbound chính thức đủ để viết downloader fail-closed.

## Quyết định

Giữ tệp `user_send_image`/`user_send_file` trong quarantine và hàng chờ nhân viên. Candidate này xác thực bằng công thức giả định, nhưng chưa có vector chữ ký do Zalo phát để chứng minh cách ghép đúng bytes. Payload attachment chỉ cho biết một `url`; không có hợp đồng tải chính thức xác nhận method, auth, TTL, host/redirect, giới hạn inbound hoặc lỗi/retry. Vì vậy URL trong payload chưa phải bằng chứng đủ để gọi mạng hay ghi bytes vào private custody.

Phạm vi này không thay đổi Core, webhook, TN, schema, secrets hoặc transport. Nghiên cứu V1-ZALO-10 vẫn là nguồn chi tiết về contract được tài liệu Zalo nêu và chưa nêu; báo cáo này chốt tác động của thiếu hụt đó lên candidate và hướng xử lý thủ công.

## Bằng chứng trong candidate

| Luồng/nguồn | Bằng chứng tại base | Điều được chứng minh | Điều chưa được chứng minh |
| --- | --- | --- | --- |
| Webhook và quarantine | `backend/integrations/zalo/official-webhook.ts:4-18, 64-86`; `backend/integrations/zalo/official-quarantine.ts:41-80, 98-130` | Có kiểm tra chữ ký theo công thức cục bộ, OA server config, ánh xạ sender server-side và lưu quarantine khử trùng lặp theo `(oa_id, raw_sha256)`. | Chữ ký chưa đối chiếu vector Zalo. `message.msg_id` là provider claim. Raw payload/attachment locator không được giữ để tải lại. |
| Custody record | `backend/integrations/zalo/migrations/004_official_quarantine.sql:4-27` | Bản ghi giữ OA, event SHA-256, loại, customer/conversation đã map, trạng thái và thời gian; unique theo OA + event hash. | Không có attachment id/index, URL, tên, size, checksum hoặc media bytes. Không thể tái dựng một attachment cụ thể từ row này. |
| Hàng chờ người | `backend/core/inbound-review-items.ts:5-23, 31-80, 90-106`; `backend/composition/official-zalo-simulation.ts:55-93` | Chỉ scope OA/shop do server cấu hình mới được đưa quarantine image/file sang staff queue `NEEDS_HUMAN` / `AWAITING_MEDIA`. Queue trả metadata giới hạn, không trả URL hoặc bytes. Lỗi ghi pointer trả 503; webhook replay có thể sửa khoảng hở sau commit quarantine. | Đây là tuyến review metadata, không phải file đã được nhận/kiểm tra hoặc gắn vào order. Người gửi không nhận được thông báo thành công từ thao tác tạo queue. |
| Kiểm thử official runtime | `tests/integration/composition/official-zalo-runtime-pg.test.mjs:12-45, 111-186` | Test yêu cầu PostgreSQL và xác nhận fixture image/file ở quarantine, queue replay idempotent, queue là `AWAITING_MEDIA`, không biến ảnh thành text event; pending review chặn approval. | Test tự ký JSON bằng cùng công thức giả định trong test, dùng app/OA/secret tổng hợp. Không có Zalo, HTTP media GET, file bytes, downloader hay thiết bị thật. |
| Đường PDF mô phỏng khác | `tests/integration/composition/zalo-artifact-worker-pg.test.mjs:23-29, 46-103, 105-142` | Một harness PostgreSQL khác tạo PDF giả, nạp bytes qua `/internal/simulation/inbound-artifacts` và kiểm thử pipeline artifact/proposal. | Đây là fixture tổng hợp riêng, không tải `attachments[].payload.url`; sự kiện/file reference, ingest, button, môi trường và PDF đều do test tạo. Nó không chứng minh PDF/Word inbound từ OA hoặc thay thế hàng chờ quarantine. |
| Transport custody tham khảo | Local reference branch `1fc6a6e6f35c1832bb877cceee1bd8751b089fe7` không nằm trong base; `backend/integrations/zalo/private-media-custody.ts` không tồn tại tại base này. | Có thể dùng để xem thiết kế transport tổng quát nếu được tích hợp và rà soát sau. | Không phải code của candidate, không có adapter/provider contract Zalo, và fixture `event_binding.verified` tự tạo không xác thực được Zalo. Không dùng làm bằng chứng cho phép tải. |

**Tóm tắt ranh giới:** event đã ký theo giả định → quarantine bền → hàng chờ nhân viên có thể kiểm tra bằng test tổng hợp. Chưa có bước attachment bytes được ràng buộc và xác minh từ Zalo. Không tạo order/proposal/confirmation/approval/print job từ đường official quarantine này. Dòng PDF synthetic ở trên là luồng thử nghiệm riêng, không chứng minh bước nhận tệp OA.

## Bằng chứng provider còn thiếu trước khi mở downloader

Tài liệu webhook Zalo mô tả `user_send_file`/`user_send_image` và `message.attachments[]`; attachment file mẫu có `size`, `name`, `checksum` (MD5), `type`, `url`, còn attachment ảnh mẫu có URL/thumbnail nhưng không có size/hash bytes. Mô tả URL là đường dẫn tải không xác nhận HTTP request contract. Yêu cầu Zalo cung cấp tài liệu chính thức hoặc trả lời bằng văn bản cho từng mục sau:

1. **Ràng buộc event và attachment:** schema/version chính thức cho `user_send_file`, `user_send_image`; ID hoặc chỉ số attachment ổn định; `message.msg_id` có duy nhất theo OA không; trường nào gắn attachment với đúng `app_id`, `recipient.id` (OA), sender và event. Xác nhận URL trong attachment có phải locator duy nhất, không thể thay bằng claim từ khách/nhân viên. Nêu rõ chính sách khi event chứa nhiều attachment.
2. **GET, auth và response:** method chính xác (có phải HTTPS GET không), request path, required headers/token, credential scope và cách token được cấp/refresh; URL là capability tự chứa hay cần token. Nêu response status, content type/encoding và cách nhận biết bytes hoàn chỉnh. Xác nhận không cần gửi OA secret hoặc webhook token đến host media.
3. **TTL và lấy lại:** thời điểm URL được phát hành, hạn dùng, one-time/reusable, thời gian an toàn cho retry, và API/cơ chế chính thức để lấy URL mới từ event/attachment nếu URL hết hạn. Nêu thời hạn Zalo retry webhook để hệ thống có thể thiết kế custody không phụ thuộc vào suy đoán TTL.
4. **HTTPS, host và redirect:** các hostname chính thức ổn định, port/scheme được hỗ trợ, TLS requirements, redirect có được trả về hay không, tối đa bao nhiêu hop, danh sách host đích và cách xử lý khi redirect. Cần quy tắc đủ cụ thể để kiểm tra từng hop và chặn host ngoài scope; không dùng allowlist suy từ URL mẫu hoặc địa chỉ IP quan sát được.
5. **Giới hạn và toàn vẹn inbound:** giới hạn byte tối đa theo từng loại/tài khoản/OA; đơn vị và ý nghĩa chính xác của `payload.size`; MD5 có bắt buộc và bao phủ chính xác bytes nào (trước/sau HTTP content-encoding) không, định dạng/case của checksum; Zalo có cung cấp size/checksum tương đương cho ảnh không. Không suy giới hạn inbound từ endpoint upload outbound hoặc từ kích thước ví dụ.
6. **Lỗi, rate limit và retry:** status/error code cho URL hết hạn, thiếu auth, không còn quyền, attachment bị xóa, quá dung lượng, giới hạn tốc độ và lỗi tạm thời; `Retry-After`/backoff hoặc retry window; cách phân biệt lỗi retryable với permanent. Ứng dụng vẫn áp TN-012: tối đa hai lần thử tải rồi chuyển nhân viên; chưa gán semantics provider cho mã lỗi chưa được xác nhận.
7. **Vector chữ ký exact-byte:** một hoặc nhiều vector kiểm thử do Zalo phát gồm app ID, OA scope, timestamp chính xác, raw webhook bytes được ký nguyên dạng, header `X-ZEvent-Signature` mong đợi và quy tắc mã hóa/ghép chuỗi. Xác nhận `data` là raw HTTP bytes hay JSON string sau parse/serialize, timestamp lấy từ field nào và biểu diễn số/chuỗi, charset/newline và xử lý khoảng trắng/escaping. Code hiện giả định raw UTF-8 bytes và timestamp từ JSON; test tự sinh không thay vector chính thức.

Khi thiếu một mục ảnh hưởng đến xác thực nguồn, giới hạn fetch hoặc kiểm tra bytes, trạng thái vẫn NO-GO. Chỉ sau khi có câu trả lời/provider contract đủ rõ mới thiết kế lại, chạy synthetic contract tests; các bài TN-022 với OA thật vẫn là cổng riêng cần chủ cửa hàng phê duyệt và tự thực hiện.

## Vận hành thủ công để không mất đơn

- Khi webhook chính thức được cấu hình trong simulation/candidate, event image/file đã được quarantine lưu `NEEDS_HUMAN`; nếu OA được map qua registry, Core ghi một staff item `AWAITING_MEDIA`. Nếu không có mapping, giữ ở OA-level; không suy ra khách/order từ payload.
- Nhân viên coi item là **đang chờ xác minh tệp**, không phải tài liệu sẵn sàng in. Không mở URL trong payload, tải thủ công từ URL đó, chạy OCR, tạo đề xuất/đơn, xác nhận khách, duyệt hoặc tạo lệnh in từ item này. Không gửi thông báo khiến khách nghĩ hệ thống đã nhận/xử lý file.
- Nếu queue pointer lỗi sau khi quarantine đã commit, ingress trả 503 để sự kiện được replay; retry này sửa pointer idempotent, không phải một lần tải media. Giữ item/quarantine mở đến khi nhân viên xử lý; không xóa để “dọn queue”.
- Nhân viên dùng quy trình trao đổi/thu nhận tệp riêng đã được chủ cửa hàng duyệt, xác minh khách và yêu cầu, rồi mới tạo/liên kết order theo luồng vận hành thủ công hiện hành. Tệp thu ngoài OA không được ghi nhận là artifact đã xác minh từ OA. Khi customer/order chưa được xác minh, giữ item ở trạng thái chờ và không tự gộp các lần gửi lại.
- Tuân thủ retention TN-011 cho bản tệp được nhân viên thu nhận và quy tắc TN-012 khi sau này có downloader. Việc webhook được ACK sau khi ghi bền chỉ nói rằng event đã được lưu; không khẳng định khách đã được phản hồi hoặc file đã được xử lý.

## Lệnh kiểm tra và giới hạn

- `node --experimental-strip-types --test tests/unit/zalo/official-quarantine.test.mjs`: **8 PASS / 0 FAIL / 0 SKIP**. Đây là test synthetic, không xác thực chữ ký do Zalo phát hoặc tải media.
- `node --import tsx --test tests/integration/composition/official-zalo-runtime-pg.test.mjs`: **BLOCKED trước khi chạy test** vì worktree không có `node_modules` (`ERR_MODULE_NOT_FOUND: tsx`); `TEST_DATABASE_URL` cũng không được cấu hình. Không tính đây là PostgreSQL PASS.
- `git diff --cached --check`: **PASS** sau khi stage đúng file báo cáo; không sửa mã sản phẩm hoặc cấu hình dependency.
- Không gọi OA/account/API, không fetch URL, không gửi tin, không in thật. Chưa kiểm chứng live Zalo, transport, media CDN, hash bytes provider, Windows storage ACL hoặc thiết bị Ricoh.

## Nguồn

1. [Zalo For Developers — Sự kiện người dùng gửi tin nhắn](https://developers.zalo.me/docs/official-account/webhook/tin-nhan/su-kien-nguoi-dung-gui-tin-nhan) — tài liệu event, webhook signature và attachment được tham chiếu trong V1-ZALO-10.
2. [Zalo For Developers — bản tài liệu webhook hiện hành](https://stc-developers.zdn.vn/docs/v2/official-account/webhook/tin-nhan/su-kien-nguoi-dung-gui-tin-nhan?lang=vi) — schema ví dụ của attachment image/file được tham chiếu trong khảo sát V1-ZALO-10.
3. [Báo cáo AI2 V1-ZALO-10](AI2_V1_PRIVATE_MEDIA_PROVIDER_CONTRACT_20261018.md) — phân biệt tài liệu upload outbound với media inbound và liệt kê contract transport chưa được công bố.
4. [TN-001–TN-037 và TN-005A](../spec/DAC_TA_TN001-TN037.md) — TN-004, TN-011, TN-012, TN-022.
5. [Ưu tiên V1 Word/PDF và Phase 2](../architecture/V1_WORD_PDF_SCOPE_20261017.md) — ảnh chuyển nhân viên, không OCR/tự xử lý trong V1.
