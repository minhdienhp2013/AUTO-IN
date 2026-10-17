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
