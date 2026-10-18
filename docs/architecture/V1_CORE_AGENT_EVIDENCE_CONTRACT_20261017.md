# Hợp đồng bằng chứng in Word/PDF V1 — AI0

**Ngày:** 17/10/2026. **Ứng viên nền:** PR #144, SHA `0673460af71205986b901a21fc7724dbea23c991`. **Tài liệu phạm vi:** [V1_WORD_PDF_SCOPE_20261017.md](V1_WORD_PDF_SCOPE_20261017.md).

Tài liệu này chốt hợp đồng kỹ thuật nội bộ để AI1, AI3 và AI0 nối phần xác nhận, duyệt và Windows agent. Không sửa TN, không bật in thật, không thay API Zalo/OA. PR #152 hiện chỉ tạo Word preview ở trạng thái `REVIEW_REQUIRED`; PR #154 đã ràng buộc Core với request hash/plan/quote nhưng chưa chụp hash byte nguồn/manifest. Hai PR vẫn Draft.

## 1. Bằng chứng chuẩn

AI0/AI3 tạo và xác minh một snapshot bất biến cho đúng shop/order/revision. Hợp đồng nội bộ chuẩn:

```text
PrintEvidenceV1 {
  schema: "ai0.print_evidence.v1"
  shop_id, order_id, revision, request_hash
  sources: [{source_artifact_ref, format, size_bytes, source_sha256}]
  source_set_sha256
  settings_sha256
  manifest_ref, manifest_sha256
  previews: [{index, bytes, sha256}]
  renderer_sha256
  plan_sha256
  printer_id
  printer_capability_sha256
  evidence_sha256
}
```

- Mọi SHA-256 là 64 ký tự hex thường. Hash nguồn tính trên **byte gốc**; Word DOCX vẫn là nguồn in. PDF tạm do Word xuất chỉ được dùng tạo preview PNG rồi xóa, tuyệt đối không đưa vào lệnh in.
- `sources` giữ thứ tự file trong đơn; `source_set_sha256` là SHA-256 của JSON canonical UTF-8 cho danh sách này. Settings gồm số bản, A4/A3, chiều giấy, một/hai mặt, lật cạnh, khoảng trang, scale và lựa chọn đích in. `renderer_sha256` ràng buộc công cụ/phiên bản/định danh môi trường có thể làm thay đổi bố cục; `printer_capability_sha256` ràng buộc máy/queue/driver/capability đã kiểm tra.
- `manifest_sha256` tính trên byte manifest chính xác; manifest ánh xạ từng file nguồn, trang/tờ, settings, renderer, plan và các preview digest. `evidence_sha256` là SHA-256 của JSON canonical UTF-8 gồm toàn bộ trường phía trên trừ chính `evidence_sha256`. Cùng một bộ byte và thiết lập phải cho cùng digest.
- ID file, đường dẫn tuyệt đối, actor, job, lease và khóa bí mật không nằm trong dữ liệu khách gửi để tự xác thực. Server lấy chúng từ DB/storage có quyền; agent nhận ticket có chữ ký/xác thực nội bộ hoặc được dựng trực tiếp từ kết quả truy vấn server. Không tin hash do khách, trình duyệt, AI hoặc tên file tự khai.
- Có thể dùng lại `ai0_verified_plan_manifests` và manifest hiện có nếu thể hiện đủ tuple trên. Nếu phải đổi schema/migration, AI1 gửi đúng migration/diff cho AI0 duyệt trước khi sửa; không mở API công khai mới chỉ để chuyển bằng chứng.

## 2. Gắn vào xác nhận, duyệt và gửi

1. **Khách xác nhận:** server chỉ tạo xác nhận khi snapshot nguồn/manifest/preview/settings hiện tại đã được xác minh. Ghi `evidence_sha256` vào bản ghi/audit xác nhận trong cùng transaction với revision/request hash và customer/order scope. Client có thể gửi digest đang xem để phát hiện stale, nhưng digest đó không phải bằng chứng; server tự tính/đối chiếu.
2. **Nhân viên duyệt:** trong transaction, kiểm quyền TN-017, active revision, khách xác nhận, giá nếu TN-033 yêu cầu và `evidence_sha256` hiện hành. UI phải mở preview tin cậy của đúng digest; thao tác duyệt là xác nhận nhân viên đã kiểm tra bản preview đó. Snapshot duyệt và job lưu cùng digest, quote/plan hash và printer binding.
3. **Claim/preflight/send:** Core và AI0 dựng ticket từ DB, không nhận tuple quyền hạn từ request body. Kiểm lại order, revision, request hash, approval, evidence digest, source bytes, manifest bytes, settings, previews, renderer và capability máy trước agent preflight và ngay sát ranh giới gửi. Bất kỳ sai lệch nào trả stale/needs-human, giữ đơn, không tạo hoặc gửi job mới.
4. **Thay đổi:** file, tập file/thứ tự, settings, preview, renderer, plan hoặc printer capability đổi ⇒ evidence digest mới. Xác nhận và duyệt cũ không dùng được; phải tạo revision/plan theo quy trình hiện hành rồi khách và nhân viên xác nhận lại.
5. **Định dạng:** PDF đi qua PDF processor trên PDF gốc. DOCX phải mở/đếm/render preview bằng Word native trên bản byte riêng tư; chỉ cho phép tạo job sau khi layout/font được nhân viên kiểm tra. Nếu Word COM, font, bố cục hoặc preview không chắc chắn thì giữ `NEEDS_HUMAN`. Preview PDF tạm không thay DOCX làm nguồn in.

## 3. Idempotency và ACK không rõ

- Mỗi job có một `job_id` và idempotency key bền vững do server tạo, ràng buộc với shop/order/revision/evidence/printer. Retry cùng key và cùng payload chỉ đọc/trả trạng thái hiện có; cùng key với payload khác bị từ chối.
- Chuyển Core `NOT_SENT → SENDING` chỉ một lần bằng CAS. Windows agent ghi journal bền trước side effect. Nếu `markSending` ACK, driver ACK, mạng hoặc tiến trình không rõ sau ranh giới gửi, đặt `UNKNOWN`; retry không gọi driver lần nữa. Không chuyển `SENDING/UNKNOWN` về `NOT_SENT`.
- `SENT`/spooler accepted không đồng nghĩa đủ giấy in. Trạng thái xác minh giấy vẫn riêng theo TN-023/TN-035. Chỉ chủ được tạo job in lại riêng sau đối soát theo TN-017/TN-035.

## 4. Phạm vi tích hợp và kiểm thử

- **AI0:** xác minh tuple từ file/manifest do server quản lý; cung cấp Core-to-agent ticket; nối cả PDF và Word vào cùng read model `verified_print_evidence`; kiểm thử PostgreSQL/Fastify/agent mô phỏng trên đúng SHA.
- **AI1:** chụp `evidence_sha256` vào xác nhận, duyệt/job và kiểm tra lại tại claim/preflight/mark-sending; giữ các cổng quote/quyền/current revision và UNKNOWN hiện có.
- **AI3:** xuất manifest canonical theo tuple; xác minh lại đúng byte nguồn/manifest/settings/preview/renderer; mở DOCX native như nguồn in và trả evidence đủ điều kiện sau khi nhân viên review. Không gọi driver thật, không tự bật lệnh Ricoh.
- **AI5:** nghiệm thu exact candidate SHA: thay từng digest làm xác nhận/duyệt stale; đổi source cùng path bị phát hiện; lỗi Word/preview giữ đơn; retry/SENDING/UNKNOWN không gọi driver lần hai; PDF/DOCX đều giữ nguồn gốc; ảnh, màu, CCCD, TEMhoa, ZIP/Excel không tạo print job tự động.
- **AI2/AI4:** giữ intake/routing và hiển thị status do server xác thực. Nhãn ảnh/định dạng không hỗ trợ là chờ nhân viên; không tuyên bố đã xử lý. Không đổi schema/chung API khi chưa nhận contract riêng.

## 5. Giới hạn

Đây là hợp đồng cho ứng viên mã mô phỏng. Các PR AI1/AI3/AI4 hiện có CI của riêng nhánh, chưa phải nghiệm thu exact integrated candidate. OA thật, Windows/Word/Ricoh thật, giấy thật, Safari iPhone và TN-037 vẫn là các cổng riêng chưa chạy. Không merge, deploy, nhắn khách thật hoặc in thật theo tài liệu này.

## 6. Quyết định schema AI0 — 18/10/2026

Để lưu digest xuyên suốt challenge/xác nhận khách/duyệt/job, ứng viên dùng migration tiếp theo sau 010: `backend/storage/migrations/011_print_evidence_binding.sql`. Thêm `evidence_sha256 CHAR(64)` nullable vào `core_confirmation_challenges`, `core_confirmations`, `core_approvals` và `core_print_jobs`; CHECK mọi giá trị khác NULL là SHA-256 hex thường 64 ký tự. Không đặt default, không backfill từ client hoặc từ audit lịch sử. Các hàng lịch sử NULL không được dùng cho luồng gửi V1; cần tạo lại evidence hiện hành, khách xác nhận và nhân viên duyệt. Không tạo bảng evidence riêng cho byte evidence: TrustedPrintEvidencePort của AI0/AI3 xác minh lại byte gốc, manifest, preview, settings, renderer, plan và capability máy từ nguồn phía server khi Core đã khóa đúng order/revision. Audit vẫn lưu lịch sử thao tác, không thay thế các cột ràng buộc. Không mở API công khai cho digest và không cho phép retry SENDING/UNKNOWN.

## 7. Biên nhận nhân viên đã kiểm tra preview — quyết định AI0, 18/10/2026

Preview phải được một nhân viên xác thực kiểm tra trước khi Core phát hành challenge/xác nhận khách; sau đó nhân viên vẫn phải thực hiện bước duyệt lệnh riêng theo TN-007. Việc kiểm preview và duyệt lệnh là hai thao tác khác nhau. Áp dụng cho cả PDF và Word; DOCX vẫn giữ nguyên làm nguồn in. Nếu preview, font, bố cục, trang/tờ hoặc thông số chưa chắc chắn thì giữ đơn và chuyển xử lý thủ công.

- AI1 tạo migration sau 011, đề xuất tên `012_preview_review_receipts.sql`, với biên nhận Core lưu bền vững gắn `shop_id`, `order_id`, active `revision`, `request_hash`, `evidence_sha256`, actor nhân viên và thời điểm. Biên nhận không chứa lại byte/manifest và không thay `TrustedPrintEvidencePort`; digest bằng chứng phải do Core tính từ Port tin cậy trong transaction. Không backfill receipt cũ.
- Thêm thao tác staff-authenticated `POST /api/v1/orders/:order_id/preview-reviews`. Body tối thiểu: `expected_revision`, `expected_request_hash`, `expected_evidence_sha256`, `decision: "checked"`, `idempotency_key`. Các giá trị `expected_*` chỉ là điều kiện so khớp phiên bản đang xem; Core khóa order, tự đọc revision/plan và tự tính evidence. Không có endpoint public cho khách gửi receipt hoặc digest để cấp quyền.
- Receipt chỉ hợp lệ khi cả shop/order/revision/request hash/evidence SHA khớp snapshot hiện tại. Thay file, preview, renderer, settings, plan hoặc capability làm receipt cũ không khớp và buộc nhân viên xem lại. Idempotency replay cùng actor/key/payload trả lại một receipt; payload khác bị từ chối.
- Khi V1 evidence Port được bật, challenge/xác nhận khách, duyệt/tạo job, claim, preflight và mark-sending đều phải thấy receipt hiện hành. Mỗi chặng vẫn tự xác minh evidence và các ràng buộc quyền/revision/idempotency; receipt không thay xác nhận khách hoặc duyệt nhân viên. Thiếu/sai receipt trả stale/needs-human, không tạo challenge mới, approval hoặc job.
- Read model chỉ cho nhân viên đã xác thực biết digest hiện hành và receipt matching/missing để tải đúng preview và gửi điều kiện `expected_*`. Mọi phản hồi lỗi preview giữ đơn. Không đưa hash hoặc đường dẫn riêng tư ra kênh OA/khách.
- AI0 composition nhận `ai3.native_word_preview.v1` để tạo evidence và phục vụ preview chỉ khi nguồn DOCX, byte manifest/PNG, renderer Word, counts, plan và capability đều được xác minh. `ready:false` / `requires_staff_review:true` của manifest Word là cổng review bắt buộc, không phải quyền in; trước biên nhận vẫn fail closed. Không thay DOCX bằng PDF tạm.
- AI3 xác minh biên nhận được AI0/AI1 dựng từ DB cùng đúng evidence/preview digest; không tin dataclass, actor, approval ID hoặc cờ do browser gửi. Dù mô phỏng qua review, `allowed_to_print=false`, queue submission false và thiết bị thật vẫn chưa được chứng minh.
- AI4 hiển thị riêng trạng thái “cần nhân viên kiểm tra preview” và thao tác kiểm tra trước xác nhận khách; bước “Duyệt lệnh in” vẫn riêng. Chỉ staff/owner được Core cấp quyền mới thấy hoặc gửi thao tác này.
- AI5 kiểm tra exact integrated candidate SHA: thiếu receipt, receipt sai actor/shop/revision/hash, drift từng digest, replay/cùng key khác payload, và PDF/DOCX luồng review → customer confirmation → staff approval; các ca chưa chạy phải giữ `NOT_RUN`.

Thay đổi này chỉ bổ sung biên nhận review, không thay TN, không đổi định dạng của nguồn in và không mở vận hành thật. Evidence bytes tiếp tục do Port đọc lại; bảng receipt chỉ lưu hành động nhân viên đã xem đúng snapshot. Base điều phối hiện tại là candidate cô lập `a5dad6591fa739b46701538b9d93afab4c6eb608`; phần code đang chờ AI1/AI3/AI4 và AI0 composition phải được nghiệm thu lại trên một SHA tích hợp mới.

## 8. DTO nguồn Word và manifest — quyết định AI0, 18/10/2026

Để tránh mỗi module định nghĩa một manifest khác nhau, mọi nhánh mới dùng đúng các kiểu sau. Đây là contract nội bộ; không phải API Zalo/OA hay quyền xác nhận/in.

### AI1 → AI3: snapshot trong tiến trình máy chủ

```ts
WordReviewSourceV1 {
  schema: "ai0.word_review_source.v1";
  shop_id: string;
  order_id: string;
  active_revision: number;
  request_hash: string;       // SHA-256 canonical UTF-8 request_data
  request_data: unknown;      // giữ nguyên dữ liệu DB; không chuẩn hóa lại
  source: {
    format: "DOCX";
    artifact_ref: string;
    sha256: string;           // SHA-256 byte DOCX gốc
    size_bytes: number;
  };
  manifest: { ref: string; sha256: string };
  private_bytes: { source: Uint8Array; manifest: Uint8Array };
}
```

`private_bytes` chỉ tồn tại server-to-worker trong bộ nhớ; tuyệt đối không serialize ra JSON/browser/log. `artifact_ref` và `manifest.ref` là locator opaque tương đối trong private storage (ví dụ `bundle-id/source.docx`, `bundle-id/manifest.json`), cùng bundle ID; không phải URL, đường dẫn tuyệt đối, tên do khách gửi hay đường dẫn có `..`.

Byte manifest được hash đúng nguyên trạng và parse theo UTF-8 JSON không có khóa lặp. Schema chính xác:

```json
{
  "schema": "ai0.word_review_manifest.v1",
  "manifest_ref": "bundle-id/manifest.json",
  "shop_id": "...",
  "order_id": "...",
  "active_revision": 1,
  "request_hash": "<64 lowercase hex>",
  "source": {
    "format": "DOCX",
    "artifact_ref": "bundle-id/source.docx",
    "sha256": "<64 lowercase hex>",
    "size_bytes": 1
  }
}
```

AI1/Core chỉ dựng snapshot từ shop/order/revision/request hiện hành của DB và registry tin cậy, xác minh hash/size/tenant/ref/manifest, rồi đọc lại scope sau I/O để phát hiện revision đổi giữa chừng. Reader chỉ đọc; lỗi hoặc thiếu registry giữ đơn. `request_data` được giữ nguyên; worker chỉ kiểm tra canonical hash và kiểm tra đúng loại DOCX theo facts đã xác minh, không tự đổi request schema hoặc lấy locator từ request.

### AI3 → AI0/UI: kết quả preview native Word

Worker dùng metadata trên và bytes riêng tư để tạo bundle preview có manifest riêng. Kết quả nội bộ phải theo DTO sau (các field `source` và `input_manifest` lặp lại giá trị đã kiểm tra từ snapshot; `manifest_sha256` là hash byte manifest preview do AI3 vừa ghi):

```json
{
  "schema": "ai3.native_word_preview.v1",
  "status": "REVIEW_REQUIRED",
  "shop_id": "...",
  "order_id": "...",
  "active_revision": 1,
  "request_hash": "<64 lowercase hex>",
  "source": {
    "format": "DOCX",
    "artifact_ref": "bundle-id/source.docx",
    "sha256": "<64 lowercase hex>",
    "size_bytes": 1
  },
  "input_manifest": { "ref": "bundle-id/manifest.json", "sha256": "<64 lowercase hex>" },
  "artifact_ref": "word-review-id/manifest.json",
  "manifest_sha256": "<64 lowercase hex>",
  "settings_sha256": "<64 lowercase hex>",
  "preview_artifacts": [{ "ref": "word-review-id/page-1.png", "sha256": "<64 lowercase hex>", "bytes": 8 }],
  "document_pages": 1,
  "printed_faces": 1,
  "physical_sheets": 1,
  "requires_price_confirmation": false,
  "ready": false,
  "allowed_to_print": false,
  "requires_staff_review": true,
  "physical_print_verified": false
}
```

`NEEDS_HUMAN` results retain schema and false authority flags, include a bounded `reason_code`, and do not claim a preview artifact when one was not verified. Trạng thái thành công chỉ là `REVIEW_REQUIRED`; lỗi, DOCX/font/layout không chắc chắn, hash hoặc scope lệch trả `NEEDS_HUMAN`. DOCX byte gốc vẫn là nguồn in; PDF Word tạm chỉ phục vụ dựng preview rồi xóa.

### AI0 → AI4: authenticated UI projection

AI0 composition may project the internal bundle only after authenticating staff scope and rechecking the active order revision. The browser DTO is `ai0.word_review_preview.v1` and contains no source bytes or private storage refs: `shop_id`, `order_id`, `revision`, `request_hash`, `source_sha256`, `manifest_sha256`, `status`, `reason_code?`, `pages:[{index,url,content_type,sha256,bytes}]`, verified counts/settings for display, and the same four false/review-only flags. Page URLs are app-relative endpoints served under the existing staff bearer session; AI4 must never fetch a caller-provided URL. A mismatch, absent endpoint, auth/network error, or stale revision hides all prior preview pages and shows waiting-for-staff. AI4 does not implement this API or infer a source from filename.

AI0 composition chịu trách nhiệm nối Core snapshot → AI3 worker → private preview/evidence registry. AI3 không tự truy cập DB/API, không tự suy diễn `request_data` thành một schema mới và không gửi lệnh in. UI chỉ dùng API có xác thực và read model hiện có/được AI0 cấp; không tạo endpoint giả, không nhận `private_bytes`, không hiển thị preview nếu revision/hash không khớp. Thiếu endpoint/dữ liệu thì giữ trạng thái chờ nhân viên.

AI5 dùng cùng hai manifest schema và anchors này trong ma trận acceptance. Fixture/unit PASS chỉ kiểm tra contract; chỉ bằng chứng sản phẩm trên exact integrated SHA mới được tính là nghiệm thu. Contract này không bật Word native trên host Windows, OA thật hoặc Ricoh thật.
