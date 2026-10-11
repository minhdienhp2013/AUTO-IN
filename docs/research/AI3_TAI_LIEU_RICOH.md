# AI3 — CODE-103: tài liệu và agent Windows/Ricoh

## Đã kiểm thử bằng công cụ thật ở môi trường Linux

- BASE: 84ab02d643622bc7bfdf07eee662d8797bdd84fd. Python 3.13.5, PyMuPDF 1.26.7, Pillow 12.3.0, pytest 9.0.2.
- Chạy: python -m pytest -q tests/unit/documents tests/unit/printing — 43/43 PASSED (local).
- PDF tổng hợp thật được đọc và render preview bằng PyMuPDF; ảnh PNG dùng Pillow và EXIF transpose. Preview đầu/giữa/cuối không chứng minh giấy Ricoh tương ứng.
- Trang tài liệu, mặt in, tờ vật lý tính riêng. Ví dụ 3 trang × 3 bản, duplex: 9 mặt và **6 tờ** (không phải 5); file và bản không ghép mặt sau.
- ZIP chặn traversal, symlink, mật khẩu, zip-bomb, giới hạn tài liệu. Word, Excel và các lỗi font/đường in chưa xác minh chuyển NEEDS_HUMAN; tuyệt đối không đoán trang.
- Agent mode=simulation + DryRunDriver; SQLite WAL/synchronous=FULL ghi dấu trước driver. Crash ở ranh giới chuyển UNKNOWN, không tự in lại. SIMULATED_DONE không phải VERIFIED_DONE.

## Hợp đồng cần AI0/AI1 nối

- CLI processor: python -m workers.documents.cli inspect FILE.pdf --preview-dir PREVIEWS
- CLI plan: python -m workers.documents.cli plan PLAN.json (JSON files[])
- CLI DryRun: python -m agents.windows.cli JOB.json --journal PERSISTENT.sqlite (chỉ mô phỏng)
- JSON snake_case gồm status, reason_code, document_pages, printed_faces, physical_sheets, evidence_kind; không lưu nội dung tài liệu khách vào log.
- HttpBackendClient HTTPS/token hạn chế scope dự kiến gọi POST /internal/v1/print-jobs/claim, /{job_id}/preflight, /{job_id}/mark-sending, /{job_id}/reports. Phần body/response từ AI0/AI1 chưa nối với server thực; giả định response job/allow/allowed/job_id/revision/request_hash phải được xác nhận. Server là nơi kiểm quyền, duyệt, revision/hash, lịch, manual lock, atomic mark-sending.
- GuardedWindowsDriver hiện cố ý fail closed; không có lựa chọn CLI mở in thật, không gửi raw PDF/Word qua cổng 9100. Không phụ thuộc máy in mặc định.

## Chưa xác minh trên Windows/Ricoh — phải được duyệt trước mọi lệnh thử thật

- Windows 11 Pro 25H2, hàng đợi RMP7000, Ricoh IM7000 192.168.1.195, RAW TCP 9100, PCL6 V4 Universal.
- Driver in PDF/Word/ảnh từ ứng dụng đúng, khay A4/A3, hướng giấy, lật dài/ngắn, thu nhỏ vừa vùng nhưng không phóng lớn, font tiếng Việt, so sánh preview với giấy.
- Spooler crash, mất mạng, kẹt giấy, thiếu giấy, ID spooler và bằng chứng in đủ; spooler đã nhận việc không phải VERIFIED_DONE.
- Cần nhân viên xác minh chất lượng và bàn giao riêng; không gộp trạng thái in, giao, tiền.
- Không có kiểm chứng thật Windows, Ricoh, OA, PostgreSQL, API kết nối, iPhone hay nghiệm thu TN-037; mọi mục này vẫn CHƯA THỬ.

Đây chỉ là code khởi đầu CODE-103, không mở vận hành thật.


## Cập nhật CODE-103 — tiếp tục nối hợp đồng AI1 (không mở in thật)

- Đã kiểm tra `backend/core/service.ts` và `backend/api/routes.ts` trên nhánh `ai0/nen-tang-dieu-phoi-v1`. Adapter HTTP gửi đúng body hiện có: claim `{printer_id,idempotency_key}`; preflight `{expected_revision,lease_token}`; mark-sending thêm `idempotency_key`; reports dùng `{expected_revision,lease_token,result,evidence_kind,idempotency_key}`. Đó vẫn chỉ là kiểm thử bằng fake HTTP, chưa có credential/API server chạy thực.
- `claim` trả `job_id,order_id,revision,request_hash,approval_id,printer_id,lease_token,lease_seconds,mode`; preflight trả `allowed` và mark-sending trả `state=SENDING`. Không dựa vào cờ client `approved`, `manual_lock` hay `print_state`.
- CLI cho phép gọi HTTPS API nội bộ **chỉ trong mô phỏng**: `AUTO_IN_AGENT_TOKEN=... python -m agents.windows.cli --api-base-url https://backend.example --journal /persistent/safe.sqlite`; bảo vệ token khỏi argv, không có công tắc in thật. Chỉ chạy khi agent token có scope và server ở `simulation`.
- Journal có thể chứa `lease_token` runtime để báo lại trạng thái sau crash; cần đường dẫn lưu trữ an toàn không đưa vào Git/ZIP, POSIX file 0600, Windows ACL **chưa thử**. Crash luôn lưu `UNKNOWN` và báo không chắc chắn về server khi có thể, không gọi lại driver. Báo kết quả mất mạng sau restart chỉ gọi report idempotent, không reprint.
- Test mới: kiểm HTTP body/ack/state, mock end-to-end dùng AI1 wire, thiếu token, quyền local journal, symlink, ảnh sai phần mở rộng, EXIF xoay. **43/43 PASS local Linux**. Chưa phải thử HTTP server thật, Windows 11 hoặc Ricoh.

- HTTPS client không tự đi theo HTTP 30x redirect để tránh phát tán Bearer token sang host khác. Ca kiểm thử redirect bị từ chối nằm trong 43 ca đạt.
