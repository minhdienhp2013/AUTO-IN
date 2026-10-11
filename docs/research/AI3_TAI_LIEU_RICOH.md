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

## Cập nhật AI3 — nhận diện cấu trúc trang PDF (TN-005/TN-005A)

- Phân tích cục bộ bằng PyMuPDF `page.get_text('blocks')` và `page.get_image_info()`: dấu hiệu chữ số, ảnh raster, hỗn hợp hoặc trang trống/vector. Không OCR và không gửi nội dung văn bản ra API/DeepSeek; chỉ trả số ký tự, số ảnh và tỷ lệ ảnh lớn nhất.
- Processor trả `page_content_signals`, `content_kind_counts`, `content_review_recommended`; tài liệu có ảnh/vector cần xem trực quan, không tự chọn màu/đen trắng và không coi là bằng chứng lệnh in đúng.
- Kiểm thử mới: 3 ca unit chạy thật trên Linux (PyMuPDF/Pillow); ca tích hợp `inspect` được thêm vào bộ test và cần kiểm lại cùng toàn suite khi AI0 ghép nhánh. Windows/Ricoh vẫn chưa thử thật.


## CODE-203 — Processor bridge / AI0 Port (đợt 2)

**Module base** `72647b4e8d489c506f8814ac7565116d0d1a16df`, scaffold AI0 `a681fe91f24f3b0cec61cb72887cc0928d9460ca` (giữ nguyên file chung được lấy vào nhánh mới). Không sửa `contracts/**` hoặc HTTP wire AI1.

### AI0 gọi qua stdin / stdout JSON

```bash
python -m workers.documents.bridge \
  --input-root /srv/autoin/incoming-readonly \
  --artifact-root /srv/autoin/private-processor-artifacts \
  < request.json
```

Hai root do AI0 cấu hình/cấp quyền riêng trong backend/worker, **không lấy từ body khách**. Root vào chứa file đã lưu/cách ly; root ra là thư mục private, chỉ backend/processor đọc. Worker POSIX dùng `openat` + `O_NOFOLLOW` từng thành phần, không hỗ trợ hạ mức bảo vệ sang `open` theo symlink Windows. Tên tài liệu trong request là path POSIX tương đối dưới input-root, không phải URL, không phải file do khách chỉ định tùy ý; chặn traversal/symlink/path tuyệt đối. Không log văn bản/ảnh/lease/token. Cấp giới hạn root/quota/cleanup ở AI0. Không dùng lối này làm Windows print driver.

**Input v1**, `expected_request_hash` là hash *đã lưu ở DB* do AI1 tính `sha256(canonical(request_data))`. AI0 chỉ dùng JSON ổn định; số nguyên phải an toàn theo JS, reject float. `request_data` hiện chỉ ánh xạ chính xác một field `documents` để tránh tạo `READY` sai khi schema khác; nếu mô hình đơn không đúng phải map/chốt với AI0, không bỏ qua field âm thầm:

```json
{
  "request_data": {
    "documents": [
      {"artifact_name":"inbox/received.pdf","copies":3,"duplex":true,
       "paper":"A4","orientation":"portrait","binding":"long_edge","page_range":"all"}
    ]
  },
  "expected_request_hash":"<sha256 of AI1 canonical request_data>"
}
```

**Output** `READY` có `plan` đúng kiểu AI1 `PrintPlan`: `request_hash,document_pages,printed_faces,physical_sheets,ready,printer_id,artifact_ref,verified_by`. Ngoài ra có `content_settings_sha256` (hash bền vững nội dung+tham số+versions+preview hashes, không phụ thuộc thư mục UUID), `renderer_versions`, `preview_artifacts` gồm relative ref/SHA256/bytes, `requires_price_confirmation`, `evidence_kind=local_render_verified_artifacts`. `artifact_ref` là **đường tương đối dưới artifact-root** tới manifest đã ghi, không cho khách đưa đường dẫn; AI0 cần lưu/chốt quyền giải ref và xác minh lại SHA256 khi phục vụ preview. Manifest chứa `paper_plan` từng file/bản; không ghép mặt cuối của file trước sang file sau. Thử ZIP an toàn tối đa 5 tài liệu; Word/Excel hoặc PDF font chưa nhúng/không tin cậy trả `NEEDS_HUMAN`, không đoán trang, không ép mọi định dạng thành PDF.

Output lỗi chỉ `{schema,status:"NEEDS_HUMAN",reason_code,ready:false}` (không lộ path/file/data nội bộ), process exit 2. `READY` exit 0. Dù có `READY`, đây chỉ là **processor-derived evidence**: AI0 **phải** gọi `OrderService.publishVerifiedPlan(processorPrincipal,orderId,{expected_revision,plan,idempotency_key})` trong luồng nội bộ có credential scope processor, server so đúng request_hash/revision trước publish; publish sẽ tăng revision và bắt khách xác nhận + nhân viên duyệt lại. KHÔNG nhận plan từ client hoặc AI tự duyệt. `READY` không xác nhận nội dung đã in ra giấy/không thay thế kiểm tra preview của người.

### Agent / backend và ca chứng minh

Giữ nguyên `HttpBackendClient` theo wire AI1 HEAD `fc0ca14`: `lease_token` (không đổi sang `lease_id` hoặc `send_authorization_id` của scaffold chưa tích hợp). Mọi HTTP dùng HTTPS, scoped Bearer agent, chặn redirect và không có bypass TLS. Server phải thực hiện quyền scope/printer/revision/approval, claim/preflight/mark-sending nguyên tử trước tác dụng driver; journal SQLite `WAL+synchronous=FULL` ghi BOUNDARY trước mark, crash/mất ACK => UNKNOWN, restart chỉ report, không gọi driver lần 2. Không tin spooler là bằng chứng đủ giấy. `GuardedWindowsDriver` cố ý BLOCKED.

Tệp test mới:
- `tests/unit/documents/test_bridge.py`: synthetic real PyMuPDF/Pillow PDF/ảnh, hash/preview, PDF font không nhúng, ZIP hợp lệ và nguy hiểm, file hỏng, traversal/symlink, tách bản duplex.
- `tests/unit/printing/test_backend_simulation.py`: HTTP AI1 wire mock **có trạng thái** cho mất ACK mark-sending, crash sau driver, mất ACK report, khởi động lại mà không gọi driver thêm.
- Lệnh cần chạy: `python -m pytest -q tests/unit/documents tests/unit/printing`; `python -m compileall -q workers/documents agents/windows tests/unit/documents tests/unit/printing`.
- **Các kiểm thử của commit CODE-203 cần được chạy lại trên checkout đủ file, chưa được coi là đạt chỉ vì 47/47 test CODE-103 trước đó đã chạy.** AI0 cung cấp SHA/backend composition + PostgreSQL thật để AI5 chạy product integration; fake HTTP không thay thế live backend. Windows 11 / Ricoh IM7000 / OA vẫn CHƯA chạy. Không in thật, merge, deploy.


## CODE-303 — CLI JSON processor + HTTPS DryRun (đợt 3)

- **MODULE BASE:** `31e73ea2607f25d521561a6c3fe9fda733900db5`, nhánh `ai3/dot3-processor-dryrun`. Chỉ sửa AI3 namespace.
- **Đọc STDIN / ghi STDOUT JSON duy nhất**, tối đa 256 KiB; không nhận file path gốc, renderer metadata hoặc quyền duyệt trực tiếp từ người dùng. Trùng key JSON, NaN/Infinity, JSON lỗi, hash không khớp, thiếu chứng cứ và unsupported → `NEEDS_HUMAN` + `reason_code`. Thời hạn POSIX `SIGALRM` 1–120 giây, mặc định 45 giây; xóa preview nháp khi timeout, không phát lệnh in. Tất cả dữ liệu ngoại lệ/traceback được ẩn khỏi stdout; Node phải có timeout/kill độc lập và giới hạn kích thước response.
- Command từ AI0 trusted process:
  ```sh
  python -m workers.documents.bridge \
    --input-root /var/lib/autoin/incoming \
    --artifact-root /var/lib/autoin/private-artifacts \
    --timeout-seconds 45 < synthetic-request.json
  ```
  Chỉ server AI0 được cung cấp root và hash DB đã lưu; tên `artifact_name` phải là đường tương đối ở input-root. Root output phải tồn tại, private và bền vững; API phục vụ preview luôn xác thực người xem và kiểm SHA trước khi đọc artifact. Worker không đi theo symlink hay cho phép đọc ngoài root. Không lưu raw tài liệu khách vào Git/log.
- Mẫu request (placeholder hash phải lấy từ AI1 DB, không dùng giá trị khách gửi):
  ```json
  {
    "request_data": {"documents": [
      {"artifact_name":"inbox/example.pdf","copies":2,"duplex":true,
       "paper":"A4","orientation":"portrait","binding":"long_edge","page_range":"all"}
    ]},
    "expected_request_hash":"<sha256(AI1 canonical(request_data))>"
  }
  ```
  Nếu PDF này thực có 3 trang, đã render được và font được tin cậy, kết quả có `plan` tương thích **AI1 PrintPlan**:
  ```json
  {
    "schema":"ai3.document_bridge.v1",
    "status":"READY",
    "plan":{
      "request_hash":"<DB request_hash>", "physical_sheets":4,
      "document_pages":3, "printed_faces":6, "ready":true,
      "printer_id":"RMP7000",
      "artifact_ref":"doc-<generated-id>/manifest.json",
      "verified_by":"ai3.processor.v1"
    },
    "evidence_kind":"local_render_verified_artifacts",
    "content_settings_sha256":"<sha256 stable evidence>",
    "renderer_versions":{"pymupdf":"<pinned version>","pillow":"<pinned version>"},
    "preview_artifacts":[{"ref":"doc-<generated-id>/<preview>.png","sha256":"<sha256>","bytes":12345}],
    "requires_price_confirmation":false
  }
  ```
  Preview `bytes`/refs/hash ví dụ phía trên chỉ là **cấu trúc minh họa**, không phải artifact đã sinh. `artifact_ref` là tương đối, không phải URL công khai hay đường dẫn để người dùng chọn. Manifest thật có `files[]` gồm file_sha256, settings_sha256, render_method, document_pages, printed_faces, physical_sheets, warnings; `paper_plan[]` phân theo file/bản và `previews[]` mỗi preview gồm ref/sha256/bytes. Không tự coi `READY` là đã in giấy.
- **Mapping tại AI0, KHÔNG giao quyền cho client**: sau khi giải artifact private + so hash/revision trong PostgreSQL, chỉ gọi `OrderService.publishVerifiedPlan(processorPrincipal, orderId, {expected_revision: stored.active_revision, plan: result.plan, idempotency_key: stable_key})`. AI1 sẽ tăng revision và buộc khách xác nhận/nhân viên duyệt lại. Không dùng `plan` từ public JSON. Nếu request_data backend có field khác `documents` như mapper AI1, AI0 cần chốt chuyển đổi nhưng giữ nguyên hash của *request_data đã lưu*; bridge hiện intentionally fail-closed `UNMAPPED_REQUEST_FIELDS` để tránh chấp nhận sai kế hoạch.
- **Exit code:** 0 READY; 2 NEEDS_HUMAN. Ví dụ `{"schema":"ai3.document_bridge.v1","status":"NEEDS_HUMAN","reason_code":"PROCESSING_TIMEOUT","ready":false}`. Không expose file path, nội dung PDF hoặc exception message trong lỗi. Không tự OCR hay đoán fonts; Word/Excel vẫn NEEDS_HUMAN.
- **Agent CLI:** `AUTO_IN_AGENT_TOKEN=... python -m agents.windows.cli --api-base-url https://localhost:PORT --journal /secure/agent.sqlite --http-timeout-seconds 10`. Scoped token đặt trong ENV, **không trên argv/URL**; HTTPS xác minh cert đầy đủ (nếu CA local, chỉ đặt `SSL_CERT_FILE`), chặn HTTP và redirect. CLI chỉ tạo `DryRunDriver`, kết quả một dòng JSON không stack trace/token. Luồng claim → preflight → server atomic mark-sending → journal SQLite → DryRun → report; lost ACK/crash giữ UNKNOWN và restart KHÔNG gọi driver lại. Driver Ricoh luôn khóa.
- **Tests:** `tests/unit/documents/test_bridge_cli.py` chạy subprocess thật với PDF/PNG synthetic, JSON lỗi, giới hạn, deadline, deterministic hash; `tests/unit/printing/test_localhost_tls.py` dùng socket TLS local CA (server mô phỏng có trạng thái, **không phải backend AI0**), journal/restart/ACK lost; `tests/unit/printing/test_cli303.py` CLI agent JSON/redaction; `tests/unit/printing/test_product_backend_optin.py` là gate **backend sản phẩm thực sự**, mặc định SKIP cho tới khi AI0 có CODE-006 composition.
- **Chạy độc lập:** `python -m pip install -r workers/documents/requirements-test.txt && python -m compileall -q workers/documents agents/windows tests/unit/documents tests/unit/printing && python -m pytest -q tests/unit/documents tests/unit/printing`. AI0 đã báo **70/70 PASS trên SHA 31e73ea trước CODE-303**; các ca mới chỉ được xác nhận khi chính suite được chạy trên HEAD CODE-303. Root CI Node thành công không đồng nghĩa pytest đã chạy.
- **Chạy product-backed khi AI0 cấp SHA/start/TLS/PG test, không bao giờ dùng môi trường production:**
  ```sh
  AUTOIN_CODE303_RUN_PRODUCT_DRYRUN=YES_SIMULATION_ONLY \
  AUTOIN_CODE303_HTTPS_URL=https://localhost:PORT \
  AUTOIN_CODE303_AGENT_TOKEN=REPLACE_WITH_TEST_SCOPED_AGENT_TOKEN \
  SSL_CERT_FILE=/path/to/trusted-test-ca.pem \
  python -m pytest -q tests/unit/printing/test_product_backend_optin.py
  ```
  Server phải có PostgreSQL test thật, 1 tác vụ mode=simulation được khách xác nhận/nhân viên duyệt hợp lệ, HTTPS scoped credential. Test yêu cầu `SIMULATED_DONE`, paper_verified=false, restart không gửi trùng; không có job thì SKIP, không xem là PASS. AI0/AI5 nghiệm thu HTTP/PG. Windows 11 / Ricoh thật / OA vẫn **NOT RUN**; không in thật, merge hay deploy.

## AI3 — rà soát độc lập CODE-103 → 203 → 303; chuẩn bị bàn giao AI3 High (chưa bàn giao)

**Ngày:** 2026-10-11. **Phạm vi:** chỉ module AI3. Nguồn: spec TN-005/TN-005A/TN-009/TN-012/TN-023/TN-025/TN-029/TN-034/TN-035/TN-037; code GitHub tại HEAD CODE-303 `107d00e41cc4c10a0bb3fd1c59fcdfcb8e919cf5`; Draft PR #2 → #10 → #17. Không suy đoán từ lời báo DONE.

### Tình trạng có bằng chứng

| Thành phần | Kiểm chứng đã biết | Chưa đạt |
|---|---|---|
| CODE-103 PDF/ảnh/ZIP, page profile, DryRun/journal | AI0 đã checkout và báo 47/47 pytest PASS ở BASE `72647b4` | Windows/Ricoh thật, đường native driver |
| CODE-203 bridge/Python dependencies, SHA-256, preview, JSON plan | AI0 đã checkout và báo **70/70 pytest + compileall PASS** ở `31e73ea` | Chưa có endpoint processor → AI1/PostgreSQL thực |
| CODE-303 CLI input, timeout, HTTPS-localhost simulator, agent CLI | CI Node `npm run check` PASS ở `107d00e`; *không chạy Python*. Test Python mới đã commit | HEAD CODE-303 pytest/compileall NOT RUN; Fastify/PG product DryRun NOT RUN |
| Rà soát này: snapshot bản gốc đã kiểm chứng | Code + pytest regression mới commit trên nhánh audit | **Python tests của snapshot chưa chạy**; backend/driver chưa xác nhận đọc artifact mới |

### Nguy cơ và việc sửa theo thứ tự ưu tiên

1. **P0 – TOCTOU/sai bản in giữa duyệt và gửi:** CODE-203 chỉ phát hành hash + preview, nhưng không lưu bản gốc bất biến; AI0/driver có thể mở lại file đầu vào đã bị ghi đè. Nhánh audit đã bổ sung `source_artifact_ref`/SHA256/size cho **bản sao bytes** tại artifact-root private và `fsync` từng source; khi lỗi chỉ trả NEEDS_HUMAN. Trước khi thử đường in thật, AI0 phải dùng bản sao đã đóng băng này, so SHA256 từ manifest lần nữa ngay lúc gửi, so cùng request_hash + approved revision + paper_plan; nếu bất kỳ điểm nào không khớp → khóa, không gửi. Đây chưa là kiểm chứng driver end-to-end.
2. **P0 – Không in trùng ở ranh giới mark-sending:** Agent `Journal` ghi BOUNDARY trước mark; nếu mất ACK/crash thì UNKNOWN, recovery chỉ báo lại, không gọi driver. Không được biến UNKNOWN thành NOT_SENT sau lease timeout, hoặc bật retry ngoại tuyến. Khi HTTP/PG thực đạt, AI5 phải kiểm mất ACK trước/sau mark, ngay trước/sau driver, và hai agent cạnh tranh trong PostgreSQL thật.
3. **P0 – Điều kiện VERIFIED_DONE và bản giấy:** `DryRunDriver` chỉ SIMULATED_DONE / paper_verified=false. Không có adapter Windows/Ricoh thật và không có đối soát driver/khay/mặt giấy. Không được dùng spooler làm bằng chứng đủ giấy, hoặc tự đóng/giao/thu tiền.
4. **P1 – Bảo mật thư mục nguồn/preview:** CLI bridge POSIX dùng O_NOFOLLOW/dirfd và giới hạn ZIP. AI0 phải cấp process user + root riêng, chống đường dẫn đổi, giới hạn CPU/RAM/IO/timeout **tại process cha** (SIGALRM một mình không chống được mọi native decode), tránh log nội dung khách, và có chính sách dọn artifact hỏng/mồ côi đúng TN-011. Source snapshot chmod read-only chỉ chống lỗi vô ý; integrity phải kiểm hash lại.
5. **P1 – Giới hạn in ảnh/PDF/Word:** Ảnh hiện có cảnh báo IMAGE_PAPER_SIZE_REQUIRES_CONFIRMATION nhưng `READY` chỉ thể hiện render/count, **không chứng minh khổ in đã được khách xác nhận**. Font PDF chưa nhúng/Word/Excel không có native preview kiểm chứng phải NEEDS_HUMAN. Chưa xác minh PrintPlan A3/A4/duplex/scale trên Ricoh; người duyệt phải nhìn preview/giấy.
6. **P1 – Hợp đồng dữ liệu:** `process_request` cố ý chỉ map `request_data.documents`. AI0 phải đọc request_data đang lưu trong AI1 và cấp adapter chính xác, không nới field silently hoặc cho client tự ghi `expected_request_hash`/plan. `publishVerifiedPlan` chỉ gọi qua principal processor đã xác thực server; tăng revision buộc xác nhận khách/nhân viên duyệt lại.
7. **P1 – HTTPS localhost product test:** `test_localhost_tls.py` chỉ là test socket TLS đến fake backend. `test_product_backend_optin.py` yêu cầu HTTPS localhost + token test + đơn simulation trong PostgreSQL thật; SKIP nếu không có dữ liệu thì gate vẫn chưa đạt. Không được bật xác thực TLS giả hoặc hạ sang HTTP để qua test.
8. **P2 – Journal credential ở Windows:** SQLite local chứa `lease_token` cho khôi phục, POSIX 0600 đã test. Trên Windows cần kiểm ACL user/service cùng file WAL/SHM trước mở vận hành; không đặt journal ở thư mục tạm/shared/network; không commit lease/token.

### Gate bàn giao cho AI3 mức suy luận High/Extra High sau khi có bản chạy thử

- Đọc lại `AGENTS.md`, spec TN, code/PR #2 #10 #17 và nhánh audit; kiểm git SHA hiện tại, **không merge từ nhánh/module khác tùy tiện**. Phản biện độc lập từng giả định của bản trước, không coi tài liệu này là bằng chứng đạt.
- Kiểm `python -m compileall -q workers/documents agents/windows tests/unit/documents tests/unit/printing`; `python -m pytest -q tests/unit/documents tests/unit/printing` trên HEAD có snapshot. Giữ báo cáo số PASS/FAIL/SKIP thật, log redacted; không dùng số 70 lịch sử để thay cho HEAD mới.
- Chạy CLI PDF/ảnh synthetic trong process thật, đối chiếu snapshot SHA trước và sau khi thay input, PDF embedded/missing font, ZIP traversal/bomb/encrypted, 1/2 mặt theo file/bản, 150/151 tờ; crash/SIGKILL ở nhiều ranh giới.
- Chạy CODE-006 Fastify+PostgreSQL thật với ít nhất hai connection/agent, scoped auth, stale revision, manual lock, lịch/ngày nghỉ, idempotency, claim/preflight/mark-sending/report, lost ACK/lease expiry/restart: **không driver call lần hai**.
- Kiểm lệnh thực tế đến Ricoh IM7000 RMP7000 192.168.1.195 chỉ sau **chủ cho phép từng phép thử thật**. So giấy A4/A3, portrait/landscape, duplex cạnh dài/ngắn, khay, thu nhỏ không phóng lớn, font tiếng Việt, bản giấy thực, kẹt/mất giấy. Chưa có phép thử này phải ghi NOT RUN.
- Nghiệm thu TN-037 của V1 (210 đơn/7 ngày, 100 đơn/ngày mô phỏng, không có lỗi nghiêm trọng) là gate độc lập do AI0/AI5/chủ phê duyệt; không tự merge/deploy, không nhắn khách, không bật live. **Chỉ chuyển cho AI3 mới khi đã có bản phần mềm chạy thử**, theo chỉ đạo chủ.

### Kiểm thử mới của nhánh audit

- `tests/unit/documents/test_source_snapshots.py`: đọc snapshot bytes/hash, thay file inbox nhưng artifact không đổi, kết quả hash bền vững qua lần chạy, ZIP chứa hai source độc lập, lỗi fsync/giới hạn tổng bytes trả NEEDS_HUMAN.
- Chạy: `python -m pip install -r workers/documents/requirements-test.txt && python -m compileall -q workers/documents agents/windows tests/unit/documents tests/unit/printing && python -m pytest -q tests/unit/documents tests/unit/printing`.
- **Status:** code+fixture đã commit; chưa có bằng chứng Python tests của HEAD audit. Không tự nâng thành DONE.

### Hardening bổ sung: bằng chứng giấy trong DryRun

Tại `agents/windows/agent.py`, sau khi gọi DryRunDriver, chỉ coi là `SIMULATED_DONE` nếu `mode=="simulation"`, `evidence_kind=="simulated"` và `paper_verified is False` cùng đúng. Nếu thiếu trường hoặc khai đã xác minh giấy, chuyển `UNKNOWN` và giữ journal để đối soát, tuyệt đối không chuyển thành VERIFIED_DONE. Test mới trong `tests/unit/printing/test_agent.py` cho `paper_verified=True` và thiếu trường. Đây là hardening phạm vi AI3, **chưa có kết quả pytest của HEAD**.
