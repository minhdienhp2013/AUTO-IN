# Pilot Word/PDF qua Zalo OA và mã cửa hàng — hợp đồng AI0

**Quyết định chủ ngày 21/10/2026.** Base triển khai: `f7bad4d6039e8f486c0654b18fdbfb3b14763c2f`. Đây là hợp đồng cho ứng viên **pilot tối giản**, chưa phải bằng chứng phát hành hoặc nghiệm thu TN-037. [Quy trình mới trong PR #162](https://github.com/minhdienhp2013/AUTO-IN/pull/162) là nguồn quyết định phạm vi; TN-007/TN-034 và tài liệu 17/10 mô tả luồng đầy đủ trước đây. Không sửa hoặc đánh dấu chúng đã PASS bằng tài liệu này.

## Kết quả cần có

Khách gửi **DOCX/PDF gốc**, đủ số bản, một/hai mặt, khổ A4 đen trắng và mã đang hiển thị tại cửa hàng **qua Zalo OA**. Core xác minh identity OA, shop, đơn, revision, file bytes/hash, thông số và mã còn hạn; tạo tối đa **một** job cho snapshot đó. Windows Agent lấy đúng bytes gốc và gửi một lệnh tới đúng máy đã được cấu hình. Web chỉ hiển thị mã, thời điểm hết hạn và trạng thái cho nhân viên có quyền. Không có preview hoặc thao tác duyệt trên máy trong nhánh pilot. `.doc`, A3, màu, ảnh, CCCD, tem hoa, Excel, ZIP và cấu hình chưa kiểm chứng chuyển `NEEDS_HUMAN`; Jev/DeepSeek không nằm trên đường in.

Pilot giới hạn đơn có số tờ tin cậy **không quá 150**; không rõ số tờ, vượt ngưỡng hoặc nhân viên đánh dấu chi phí đáng kể thì chờ người xử lý/giá. Không dùng AI để suy ra số tờ hoặc giá. Mã là dấu hiệu khách biết mã trong cửa hàng, không chứng minh vị trí tuyệt đối vì có thể được chia sẻ.

## Wire chung v0.1

Kiểu TypeScript nằm ở [`contracts/pilot-word-pdf.ts`](../../contracts/pilot-word-pdf.ts). Chúng **không cấp quyền** chỉ bằng cách được import. Mọi field `shop_id`, `oa_id`, `customer_id`, `provider_event_id` và source ref phải xuất phát từ webhook OA đã xác minh và storage tin cậy; không lấy identity/role, path, hash hoặc MIME chỉ từ text/filename do khách khai.

1. **AI2 → AI1 (OA ingress):** lưu event có xác thực, chống trùng theo `(oa_id, provider_event_id)`; file đi qua custody riêng, đọc lại byte để tính SHA-256, kiểm DOCX/PDF theo nội dung và giới hạn kích thước. OA gửi `PilotWordPdfCandidate` khi file + settings đã đủ; mã khách gửi đi qua `PilotCodeSubmission`. Event có thể đến mọi thứ tự. Text mã tự nó không tạo job.
2. **AI1 → AI4 (mã hiển thị):** `GET /api/v1/pilot/shop-code` trả `PilotShopCodeDisplay` chỉ cho `owner/staff` đã xác thực thuộc shop đang mở. `Cache-Control: no-store`; không gửi mã trong OA outbound, public page hoặc log. Đồng hồ server là chuẩn, UI chỉ đếm ngược từ `server_time` và `expires_at`, rồi refetch khi hết hạn. Endpoint không do browser tạo mã.
3. **AI2 → AI1 (nộp mã):** internal service call cho `PilotCodeSubmission`, hoặc API nội bộ có service identity cố định; không mở endpoint khách public với bearer giả. `shop_id/oa_id/customer_id/conversation_id/order_id/revision` phải đối chiếu dữ liệu đã lưu. Server chỉ trả `WAITING_FOR_FILE`, `WAITING_FOR_SETTINGS`, `WAITING_FOR_CODE`, `NEEDS_HUMAN` hoặc `AUTHORIZED` và reason code hữu hạn; không echo mã.
4. **AI1 → AI3 (job):** Core lưu `PilotPrintAuthorization` cùng job trong **một transaction**; Agent chỉ nhận ticket được Core dựng từ DB và sealed storage. Không có `code` thô trong ticket, job, audit hay journal. Tuple gồm shop/OA/customer/order/revision/request hash/source hash/settings hash/evidence hash/printer/window/event/job. Core/Agent kiểm lại đúng source bytes, settings, revision, printer và quyền pilot tại claim, preflight và ngay trước send.

### Quy tắc mã 30 phút

- Một cửa sổ mã riêng cho từng shop; `expires_at` do server xác định, sau tối đa 30 phút mã cũ hết hiệu lực và mã khác được cấp. Không chấp nhận grace period hoặc clock của browser/OA. Store **hash mã có khóa server** (hoặc primitive tương đương), không lưu plain text trong DB/log; so sánh constant-time. Khóa không vào Git.
- Mã ngắn dùng cho khách phải có rate limit/throttle theo OA customer, shop và nguồn request. Quá nhiều lần sai tạm khóa hoặc chuyển người; không rò mã tồn tại/không tồn tại qua thông báo khác nhau. AI1 quyết định độ dài/bảng ký tự sau khi test UX và chống đoán.
- Mã nhập sớm chỉ được **ủy quyền khi snapshot đầy đủ và mã vẫn còn hạn tại thời điểm transaction tạo job**. Mã sai/hết hạn, sai shop/OA/khách/đơn, file hoặc settings đổi, event trùng và race mã hết hạn đều fail closed. Một mã trong cửa sổ có thể phục vụ các khách khác nhau tại cùng shop, nhưng mỗi order/revision/source/settings chỉ có một authorization/job. Mã mới không reset job `SENDING`, `SENT_UNVERIFIED` hoặc `UNKNOWN`.

### Quyền và tính một lần

- Không dùng route staff approval cũ, cũng không xóa/nới check preview/approval của luồng cũ. AI1 tạo **authorization kind riêng `shop_code_pilot_v1`** và guard riêng tại tạo job/claim/preflight/mark-sending. Pilot chỉ bật cho shop/printer/agent đã cấu hình và kiểm nghiệm; default off. Real mode không được mở chỉ bằng cờ môi trường hay field từ OA/browser.
- Server khóa order và code window trong transaction, kiểm current revision/request hash/source/settings rồi insert authorization/job với unique constraint/idempotency key ràng buộc cùng tuple. Replay cùng key/payload chỉ trả job đã có; cùng key nhưng payload khác là conflict. Thay file/settings tạo revision mới và phải có mã còn hạn; job cũ đã gửi/UNKNOWN tuyệt đối không được resend.
- Agent journal bền trước side effect. Khi claim/mark-sending/driver ACK mơ hồ, `UNKNOWN`; không tự gửi lại. Spooler ACK không chứng minh đủ giấy. Con người đối soát giấy, giao hàng và tiền riêng; chỉ chủ quyết định in lại job mới.

## Ghép theo owner, song song

| Owner | File được sửa | Đầu ra có thể làm ngay | Chờ hợp đồng/đầu vào |
| --- | --- | --- | --- |
| AI0 | `contracts/**`, `backend/composition/**`, `backend/app.ts`, `backend/server.ts`, `tests/integration/composition/**`, docs chung | Wire/route projection, ghép modules và test end-to-end | Module AI1–AI4; cấu hình pilot và host thử |
| AI1 | `backend/core/**`, `backend/api/**`, `backend/storage/**`, `backend/jobs/**`, tests Core | Mã 30 phút, authorization/job riêng, transaction/idempotency/gates | Wire v0.1; AI2 source provenance |
| AI2 | `backend/integrations/zalo/**`, `backend/conversation/**`, `backend/ai/**`, tests Zalo | OA verified ingress, file custody, hỏi settings, nộp mã | Core service contract; OA test credentials |
| AI3 | `workers/documents/**`, `agents/windows/**`, tests documents/printing | DOCX native/PDF gốc, printer ticket, journal/UNKNOWN | Core ticket; Windows/Word/driver test host |
| AI4 | `web/**`, `tests/ui/**` | Mã và trạng thái tối giản, auth/no-store/offline | Core display/read-model API |
| AI5/6/7 | Acceptance / môi trường / review | Fixture, test matrix, CI read-only review theo SHA | Candidate tích hợp exact SHA |

AI1–AI4 làm module và test độc lập trên base F7; AI0 **không sửa thay** file module. Nếu cần field/schema khác, gửi AI0 diff contract trước, chỉ AI0 chốt wire chung. Cổng chuyển `simulation` → in thật, OA thật và Ricoh thật cần thử có giám sát bằng tài liệu công khai, chủ phê duyệt riêng; kiểm run exact SHA. Bản F7 chỉ có runtime simulation; không được coi là pilot đã chạy.

## Gate phát hành pilot

1. CI trên **một SHA tích hợp** PASS Core, OA, Composition/PostgreSQL, Python claim/driver, Web; ca mã sai/hết hạn/race, OA event trùng, source/settings drift, một job duy nhất và UNKNOWN/no-resend có trace gắn SHA.
2. OA test account nhận DOCX/PDF công khai và thông số/mã thật; xác minh event/download/identity. Word/PDF chạy trên Windows với Word/driver đúng và một lượt Ricoh có người đứng máy, đếm giấy thật. DryRun/Chromium synthetic giữ nhãn mô phỏng.
3. Giữ TN-037 bản đầy đủ là gate riêng. Pilot này chưa đáp ứng TN-007/TN-034 cũ do bỏ preview/duyệt, nên release note phải nêu phạm vi và chủ chốt mở pilot; không tự gộp PASS lịch sử F7 hoặc D16.

## Khóa wire tích hợp AI0 — 21/10/2026

Hợp đồng này được khóa cho nhánh tích hợp bắt đầu từ F7. Các kiểu ở trên là wire chung; không module nào tự đổi tên field hoặc tự thêm quyền.

- **Mã cửa hàng:** server phát đúng 10 ký tự Crockford [0-9A-HJKMNP-TV-Z], viết hoa, không dấu gạch. Chỉ trả qua GET /api/v1/pilot/shop-code cho phiên owner/staff cùng shop; response PilotShopCodeDisplay, Cache-Control: no-store. Browser chỉ hiển thị và lấy lại từ server khi hết hạn; không sinh, lưu hoặc gửi mã ra OA/log.
- **AI2 → AI1:** trong-process/internal Core Port, không public endpoint cho khách. Sau khi webhook OA đã xác thực và bytes đã vào private storage, gọi registerPilotCandidate(PilotWordPdfCandidate); khi đủ snapshot thì gọi authorizePilotPrint(PilotCodeSubmission). Candidate chỉ chứa server-derived identity/source refs/hash/settings; code chỉ tồn tại trong submission transient. Core không lưu/log mã thô. Parser chỉ tạo code candidate, không cấp quyền.
- **AI1 → AI3:** dùng riêng /internal/v1/pilot/print-jobs/claim, /internal/v1/pilot/print-jobs/{job_id}/source, /internal/v1/pilot/print-jobs/{job_id}/preflight, /internal/v1/pilot/print-jobs/{job_id}/mark-sending và /internal/v1/pilot/print-jobs/{job_id}/reports. Đây là lane pilot riêng; không thay đổi role, preview/approval hay điều kiện của route claim cũ. Claim trả PilotAgentClaimResponse; agent chỉ tạo PilotPrintWork sau khi lấy đúng byte qua source route có bearer agent + lease còn hạn.
- **Source route:** trả bytes gốc DOCX/PDF (không base64) với Cache-Control: no-store, X-AUTO-IN-Source-SHA256 và X-AUTO-IN-Source-Size. Agent gửi bearer agent cùng `X-AUTO-IN-Pilot-Lease: <lease_token>`; không truyền lease trong query/body. Core phân giải job→source từ registry kín; không nhận URL/path từ Agent/OA. AI3 đối chiếu kích thước/hash/format trước journal.
- **Preflight/mark-sending:** body là PilotAgentGateRequest; response là PilotAgentGateReceipt. Core phải kiểm lại cùng authorization/job/order/revision/request/source/settings/evidence/printer và lease dưới transaction ở cả hai bước. Preflight trả state=AUTHORIZED; mark-sending chỉ chuyển đúng job một lần và trả state=SENDING. Pilot ticket không có trường approval_id.
- **Report:** dùng PilotAgentReport; không gửi source bytes, tài liệu, mã hoặc credential. Trong test DryRun, job phải có mode=simulation; agent báo SIMULATED_DONE với driver_called=false, không gọi Windows/driver/Ricoh. Mất ACK sau send boundary thành UNKNOWN; không claim/resend lại job đó.
- **Hash settings:** SHA-256 lowercase trên UTF-8 của JSON canonical (object keys sort đệ quy, không whitespace, boolean JSON lowercase). Vector: {"color":"black_white","copies":2,"duplex":true,"paper":"A4"} → `e6ed1f13eba6750d851960ef87efb679356b36aad49c20887ac249e55162b486`. Copies 1–99; paper A4; color black/white; `duplex=false` là một mặt và `duplex=true` là hai mặt lật cạnh dài; mọi producer/consumer dùng cùng vector. Áp dụng duplex thật vẫn cần kiểm tra DEVMODE/driver trên Windows/Ricoh.
- **Enablement:** shop/printer/agent mặc định tắt. Simulation chỉ được bật qua cấu hình test cô lập; browser/OA không thể bật pilot hoặc real print. Chuyển sang OA thật, Windows thật hay Ricoh thật cần cổng duyệt riêng của chủ.

Các route nội bộ trên là phần mở rộng wire của PR #163 để AI1/AI3 triển khai; chúng chưa được coi là đã có trong runtime cho đến khi exact-SHA integration test xác nhận.
