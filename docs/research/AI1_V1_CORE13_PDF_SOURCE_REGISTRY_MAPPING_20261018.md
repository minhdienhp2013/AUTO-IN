# AI1 V1-CORE-13 — PDF source provenance mapping

**Candidate/base inspected:** `ai0/v1-word-pdf-candidate-20261018` at `71a59b5bf78ebb35f8e18e99d31a0730c661c0a7` (AI1 PDF source contract, AI4 projection, and AI3 adapter are present).
**Review branch:** `ai1/v1-core-13-pdf-source-registry-map-20261018`, created from that exact SHA.
**Scope:** read-only schema/code research; no product code, migration, or TN changed.

## Kết luận

Với các luồng **simulation hiện có**, Core có thể dựng bằng chứng `order → event → artifact → revision/hash` cho một PDF nếu reader kiểm tra đồng thời các hàng liên kết và nội dung private storage. Không thể chứng minh chỉ từ `core_revisions.request_data`: request data hiện lưu `artifact_name` (locator), còn SHA-256 nguồn nằm ở artifact registry. `ai0_inbound_artifact_drafts.settings_sha256` là cầu nối hiện có giữa request data và source SHA, nhưng không có FK trực tiếp từ revision đến artifact.

Đường **PDF Zalo thật chưa được chứng minh**. `zalo_official_quarantine` giữ `raw_sha256`, loại, scope đã map, trạng thái và thời điểm nhận; không giữ attachment bytes/locator/checksum để dựng `ai0_inbound_document_artifacts`. Vì thế candidate này mới có thể đọc nguồn PDF đã đăng ký qua adapter AI0; `TrustedPdfReviewSourceReader` chưa được nối trong composition.

Ngay cả sau khi AI0 nối source reader, snapshot hiện tại **chưa tương thích với parser input của worker PDF AI3**. Core giữ `request_data` gốc dạng `documents:[{artifact_name,copies,duplex,paper}]`; worker `native_pdf_artifacts._request_settings` chỉ nhận `{documents:[{format:"PDF",copies}],settings:{paper,orientation,duplex,binding,page_range?}}` và từ chối key lạ/thiếu với `PDF_REQUEST_SHAPE_UNSUPPORTED`. Không được sửa `request_data` trước khi hash kiểm tra hoặc âm thầm đổi dữ liệu revision. Cần AI0/AI3 chốt mapper tường minh từ request đã xác minh sang settings preview; giữ nguyên raw `request_data` và `request_hash` làm anchor, kiểm `artifact_name` khớp verified source, rồi chỉ suy ra `format:"PDF"` từ source đã xác minh. Chưa có mapper này thì PDF preview end-to-end vẫn BLOCKED.

Không cần sửa TN để nối provenance nội bộ. Với đúng một source PDF và simulation path, có thể dùng các bảng hiện tại làm đầu vào reader. Bảng binding riêng chỉ cần thiết nếu AI0 muốn ràng buộc nguồn theo từng revision bằng FK/record chuẩn hóa thay vì tính lại mối nối khi đọc, hoặc khi mở rộng sang nhiều tệp. Không được dùng bảng mới để ngầm tuyên bố đã có transport Zalo thật.

## Những ràng buộc hiện có

| Bảng | Dữ liệu có thể dùng | Giới hạn |
|---|---|---|
| `ai0_inbound_document_artifacts` (`backend/composition/migrations/001_document_artifacts.sql:2-15`) | PK `(shop_id, oa_id, event_id)`; `conversation_id`, `customer_id`, `artifact_ref`, source SHA, `manifest_ref` và manifest SHA. | FK event chỉ gồm `(oa_id,event_id)`, không ràng buộc shop/OA với registry. Không có `order_id`, revision hay `request_hash`. |
| `ai0_inbound_artifact_drafts` (`003_inbound_drafts.sql:4-19`) | Một event có trạng thái `PENDING`/`CREATED`; khi hoàn tất có `order_id`, actor, `settings_sha256`, thời gian. `order_id` là unique. Đây là mối nối bền `event → order`. | Không nhận `PENDING` làm bằng chứng; không lưu source SHA riêng hay revision/hash được Core tạo. |
| `ai0_source_adoption_receipts` (`006_source_adoption_receipts.sql:3-19`) | Idempotency theo shop/actor/key; unique theo shop/OA/event; `payload_sha256`, response và thời gian hoàn tất. | `response` là JSON, không có FK/cột chuẩn hóa tới order hoặc revision. Receipt PENDING không chứng minh adoption đã commit. |
| `core_revisions` (`backend/storage/migrations/001_core.sql:33-39`) | `(order_id,revision)`, `request_data`, `request_hash`; Core tính hash trên canonical request data. | `request_data.documents[].artifact_name` giữ ref, không giữ source SHA hoặc event ID. |

### Draft ban đầu

`verifiedSyntheticSource` lấy event từ DB, so `customer_id`/`conversation_id`, kiểm kind/filename, đọc manifest `ai3.upload_snapshot.v1` có đúng một file, rồi xác minh byte size và SHA (`backend/composition/inbound-draft.ts:70-110`). `prepareSyntheticInboundDraft` đặt `artifact_ref` vào `request_data.documents[0].artifact_name` và tạo:

```text
settings_sha256 = SHA256(canonical({
  request_data,
  customer_id,
  conversation_id,
  sha256: source_sha256
}))
```

`createSyntheticInboundDraft` ghi reservation trước, gọi Core `createDraft`, rồi mới chuyển draft thành `CREATED` và gắn `order_id` (`inbound-draft.ts:131-170`). Khi đọc, chỉ chấp nhận chính xác một document PDF; nối `d.order_id = o.id`, `d.(shop_id,oa_id,event_id) = a.(shop_id,oa_id,event_id)`, event cùng OA, rồi kiểm active revision có đúng `request_hash = SHA256(canonical(request_data))`, `artifact_name = a.artifact_ref` và tính lại `settings_sha256` từ revision 1 cùng artifact SHA. Event, artifact và order phải cùng customer/conversation; shop↔OA phải khớp `core_shop_zalo_oa_registry`/trusted composition scope. Thiếu hoặc có nhiều hơn một document thì từ chối.

Điều này chứng minh được mối nối trong simulation nếu toàn bộ điều kiện được tính lại; chỉ nhìn `artifact_name` thì không đủ. `settings_sha256` không chứa shop/OA/event ID, nên nó không thay thế các khóa join và kiểm tra tenant.

### Source adoption

`verifySyntheticSuggestionTarget` yêu cầu AI2 proposal thuộc đúng shop/OA/order/customer/conversation, revision đầu còn hiện hành và `request_data` có `source: "zalo_ai_suggestion"` cùng đúng event được chọn (`backend/composition/synthetic-suggestion-adopt.ts:16-46`). Adoption dùng cùng `prepareSyntheticInboundDraft`, ghi draft `PENDING`, gọi Core `revise(expected_revision: 1)` tạo revision 2, rồi hoàn tất draft với `order_id` (`:58-90`). HTTP wrapper ghi adoption receipt trước và lưu response sau khi Core/adoption hoàn tất (`backend/composition/source-adoption-http.ts:36-71`).

Với adoption, reader cần yêu cầu tất cả điều kiện sau:

1. Revision 1 của đúng proposal khớp order/shop/OA/customer/conversation; `event_ids` phải đúng một phần tử và bằng source event đã chọn, như guard hiện có. Nếu proposal gom nhiều event, fail closed.
2. Draft cho event đó ở `CREATED`, `completed_at` có giá trị, `order_id` khớp order. Event, artifact và order cùng shop/OA/customer/conversation.
3. Adoption receipt cùng shop/OA/event đã hoàn tất; `response.order_id` đúng order, `response.revision` đúng 2 và các cờ response đúng contract. Không coi JSON receipt thiếu/sai là nguồn thay thế cho draft/revision.
4. Revision 2 có đúng một document PDF dùng `artifact_ref`; `d.settings_sha256` tính lại khớp revision 2, customer/conversation và source SHA. Revision active hiện tại phải vẫn trỏ đúng `artifact_ref`, và `request_hash` phải khớp canonical `request_data` của revision đó.

Revision 2 và receipt hiện giúp suy ra lịch sử adoption, nhưng receipt không có FK tới order/revision. Các revision sau cũng không lưu source SHA trực tiếp; reader phải xác minh chuỗi từ adoption revision tới active revision, cùng artifact ref, và xác minh lại byte/hash. Nếu yêu cầu quan hệ được database cưỡng chế, nên thêm binding record chuẩn hóa thay vì dựa vào JSON response.

## Query/mapping tối thiểu cho AI0

Reader nên lấy `shop_id` từ staff principal và OA từ trusted server registry/config; không lấy shop, OA, order, event hoặc locator từ client. Khóa Core order trước khi đọc, rồi lấy active revision và provenance rows theo scope. Hình dạng truy vấn tối thiểu:

```sql
SELECT o.id, o.shop_id, o.customer_id, o.conversation_id, o.active_revision,
       cur.request_hash, cur.request_data,
       d.oa_id, d.event_id, d.status, d.order_id, d.settings_sha256,
       a.artifact_ref, a.sha256, a.manifest_ref, a.manifest_sha256,
       e.customer_id AS event_customer, e.conversation_id AS event_conversation,
       e.payload_json, oa.app_id
FROM core_orders o
JOIN core_revisions cur ON cur.order_id=o.id AND cur.revision=o.active_revision
JOIN ai0_inbound_artifact_drafts d
  ON d.order_id=o.id AND d.shop_id=o.shop_id AND d.status='CREATED'
JOIN ai0_inbound_document_artifacts a
  ON (a.shop_id,a.oa_id,a.event_id)=(d.shop_id,d.oa_id,d.event_id)
JOIN zalo_inbound_events e ON (e.oa_id,e.event_id)=(a.oa_id,a.event_id)
JOIN core_shop_zalo_oa_registry oa
  ON (oa.shop_id,oa.oa_id)=(a.shop_id,a.oa_id)
WHERE o.id=$1 AND o.shop_id=$2;
```

Ứng dụng phải yêu cầu đúng một kết quả và xác minh manifest/source bytes trong private storage. Với adoption, truy vấn bổ sung revision 1/2, `core_ai_draft_proposals`, `ai0_source_adoption_receipts`; kiểm tra receipt `completed_at`, JSON response khớp order/revision, event fingerprint và mối nối request data như trên. Không chấp nhận thiếu bảng/registry, zero hoặc nhiều rows, event scope lệch, draft/receipt PENDING, revision không active, request hash sai, nhiều tệp/attachment, manifest không đúng schema hoặc source không phải PDF.

Manifest hiện có là `ai3.upload_snapshot.v1` và không chứa shop/order/revision/request hash. Nó chỉ có thể làm bằng chứng artifact bytes sau khi DB manifest SHA và file SHA/size được kiểm lại. Để cấp contract CORE-12, AI0 phải dựng/đọc một manifest sibling `ai0.pdf_review_manifest.v1` gắn scope đang xác minh, một PDF, `artifact_ref`, source SHA và byte size. Manifest mới phải được hash chính xác, không lấy digest từ tên file, webhook, request body hoặc UI.

## Race, giới hạn và hành vi fail-closed

- Tạo draft/adoption có nhiều commit: artifact đã lưu nhưng chưa có draft; draft còn `PENDING`; Core đã tạo revision nhưng draft/receipt chưa hoàn tất. Chỉ trạng thái hoàn tất và mọi mối nối khớp mới được đọc; không tự reconcile hoặc tạo lại đơn trong source reader.
- `verifiedSyntheticSource` hiện đọc registry một lần rồi mới đọc manifest/source; file hoặc DB rows có thể đổi giữa các bước. Adapter cần xác minh raw manifest SHA, source bytes SHA/size/PDF header, đọc lại event/artifact/draft/receipt/active revision sau I/O và so snapshot. `readPdfReviewSource` hiện recheck Core revision/request data; việc đó không thay cho recheck quan hệ event/artifact/adoption trong adapter.
- Lock order trước; đọc/khóa các rows provenance phù hợp; sau I/O kiểm scope lại trong transaction isolation cho phép thấy commit mới. Mọi thay đổi revision, event, registry row, artifact ref/hash/manifest, receipt hoặc bytes trong lúc đọc ⇒ stale/needs-human. Không trả bytes/path qua JSON hoặc log.
- Không chọn một file đầu tiên khi proposal/document/attachment có nhiều nguồn; không suy ra PDF từ extension riêng lẻ. Không giữ đơn bằng cách tự gắn file khác có cùng tên. Event không khớp shop/OA/customer/conversation, source digest sai, manifest sai/legacy ambiguous, storage unavailable hoặc database uncertain đều giữ đơn và chuyển người.
- AI3 adapter có thể nhận `ai0.pdf_review_source.v1`, nhưng composition ở SHA này chưa inject `pdfSource`; vì vậy contract chưa được chạy end-to-end. Chỉ coi đây là mapping thiết kế cho AI0, chưa phải PASS sản phẩm.
- Worker AI3 hiện không đọc trực tiếp request shape do draft/adoption tạo: `backend/composition/inbound-draft.ts:120-123` ghi `artifact_name`, `copies`, `duplex`, `paper` bên trong document; `workers/documents/native_pdf_artifacts.py:41-60` đòi `format`/`copies` và object `settings` top-level, chỉ cho phép các field đã liệt kê. Với dữ liệu hiện tại, worker sẽ fail closed ở `PDF_REQUEST_SHAPE_UNSUPPORTED`. AI0/AI3 phải cùng chốt mapper/contract trước khi tính preview PDF là khả dụng; không biến output mapper thành `request_data` Core hoặc hash khác revision.

## TN và đề xuất

- **TN-004:** nhận PDF/Word/ảnh, định dạng khó chuyển người; giới hạn số tài liệu vẫn phải đếm đúng.
- **TN-007/TN-017:** khách xác nhận trước và nhân viên hợp lệ duyệt; source receipt/hash không cấp quyền xác nhận hoặc duyệt.
- **TN-009/TN-023/TN-029:** route máy, printer capability, xác nhận trạng thái và thông số in là bằng chứng/gate riêng, không suy ra từ source mapping.
- **TN-011/TN-012:** giữ quyền xem và retention; file tải lỗi retry theo quy tắc hiện hành rồi chuyển người, không biến lỗi provenance thành gửi/in lại.
- **TN-034:** giữ PDF gốc để xử lý PDF; không dùng manifest/preview hoặc Word-export làm source PDF thay thế.

Không có xung đột buộc sửa TN. Khuyến nghị AI0 trước mắt nối `TrustedPdfReviewSourceReader` dùng các bảng hiện có cho đúng một PDF simulation, với truy vấn/join và recheck nêu trên. Trước khi vận hành OA thật, cần AI2/AI0 triển khai transport media có chữ ký/scope/custody/hash đã kiểm chứng; quarantine hiện tại không cung cấp bytes hoặc locator. Nếu AI0 muốn database-level revision→source FK, hoặc hỗ trợ nhiều tài liệu, chốt thêm migration/binding table với AI1 trước khi code. Đây là thay đổi schema nội bộ, không phải sửa TN.

## Kiểm tra

- `git rev-parse HEAD`: `71a59b5bf78ebb35f8e18e99d31a0730c661c0a7`.
- `git status` và diff trước khi viết: sạch; branch mới bắt đầu đúng base.
- Đây là báo cáo nghiên cứu; không chạy product tests/DB, không thay mã hoặc migration.
