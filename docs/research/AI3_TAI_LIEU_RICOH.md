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


## CODE-303 — nối lại sau PR tích hợp #21 (12/10/2026)

**SHA đối chiếu AI0** `15c1ac75859914b2cc07d5a98bf57c18973cbbb2` trên `ai0/tich-hop-simulation-v1` (Draft PR #21). **BASE nhánh AI3 giữ** `26479054dafa787fbe46991905e1fc431f9d53f1` (PR #20); các commit AI3 cũ không bị thay thế.

### Hợp đồng backend AI1 có thực — không thiếu route DryRun

Đã kiểm trực tiếp `backend/api/routes.ts`, `backend/core/service.ts`, `backend/composition/runtime.ts`, `backend/server.ts` tại SHA #21. Phần HTTP AI1 đăng ký đủ 4 endpoint:

| Method/path | Request JSON | Phản hồi thành công |
|---|---|---|
| POST `/internal/v1/print-jobs/claim` | `{printer_id:"RMP7000",idempotency_key}` | `{job:null}` hoặc `{job:{job_id,order_id,revision,request_hash,approval_id,printer_id,lease_token,lease_seconds,mode:"simulation"}}` |
| POST `/internal/v1/print-jobs/{job_id}/preflight` | `{expected_revision,lease_token}` | `{allowed:true,job_id,revision,mode:"simulation",approval_id}` |
| POST `/internal/v1/print-jobs/{job_id}/mark-sending` | `{expected_revision,lease_token,idempotency_key}` | `{job_id,state:"SENDING",mode:"simulation"}`; AI1 chuyển trạng thái nguyên tử trong PG |
| POST `/internal/v1/print-jobs/{job_id}/reports` | `{expected_revision,lease_token,result:"simulated_done"|"unknown",evidence_kind:"simulated"|"agent_uncertain",idempotency_key}` | `{job_id,state:"SIMULATED_DONE"|"UNKNOWN"}` |

HTTP status 200 mới là ACK được xác minh thêm ID/state; 401/403/409/422/5xx hoặc mất ACK **không được tính là đã xác nhận gửi**. `HttpBackendClient` giữ tên `lease_token` và `result/evidence_kind`, dùng Bearer scoped principal `print_agent` có `printer_ids:["RMP7000"]`. Runtime AI0 chỉ cho shop mode simulation ở send boundary. **Không cần AI0 tạo thêm endpoint** để chạy DryRun. Thiếu điều kiện vận hành kiểm chứng: server HTTPS localhost **có bật** `AUTOIN_TLS_CERT`/`AUTOIN_TLS_KEY`, danh tính trong `AUTOIN_IDENTITIES_FILE`, PostgreSQL `autoin_test*` và fixture đơn có plan → khách xác nhận → nhân viên duyệt. Backend theo PR #21 **không tự tạo một approved job** khi gọi claim; trả `job:null` nếu hàng đợi chưa có. Không chuyển `job:null` thành PASS sản phẩm.

### CLI thật (chỉ simulation)

```bash
# Dùng riêng DB PostgreSQL test, không phải dữ liệu cửa hàng; AI0 chuẩn bị
# DATABASE_URL=postgresql://...@127.0.0.1:5432/autoin_test_305
# AUTOIN_TLS_KEY=/private/test-key.pem
# AUTOIN_TLS_CERT=/private/test-cert.pem
# AUTOIN_IDENTITIES_FILE=/private/simulation-identities.json
# PORT=3443 HOST=127.0.0.1 AUTO_IN_MODE=simulation npm start

# Sau khi AI0 đã seed một approved job đủ điều kiện (fixture tổng hợp):
export AUTO_IN_AGENT_TOKEN='TEST_SCOPED_AGENT_TOKEN_FROM_AI0'
export SSL_CERT_FILE='/private/trusted-test-ca.pem'
python -m agents.windows.cli \
  --api-base-url https://localhost:3443 \
  --journal /private/persistent-agent-journal.sqlite \
  --http-timeout-seconds 10
```

- `--api-base-url` của CLI giờ **chỉ nhận HTTPS loopback** (`localhost/127.0.0.1/::1`, cổng tường minh, không path/userinfo/query/fragment); không thêm TLS `verify=False`, không dùng HTTP LAN, không cho token trên URL/argv. Nếu server AI0 chỉ khởi động HTTP (mặc định khi không có TLS key/cert), agent chủ động chặn; AI0 cần khởi động HTTPS test, **không phải thiếu API**.
- Agent chỉ tạo `DryRunDriver`, không gọi Windows spooler/RAW 9100/Ricoh; `Journal` SQLite persist trạng thái BOUNDARY trước mark-sending, ARMED/DRIVER_CALLED, UNKNOWN khi crash/mất ACK; recovery report idempotent nhưng **không gửi driver lại**. `SIMULATED_DONE` phải `paper_verified:false`, không là `VERIFIED_DONE`.
- Test localhost TLS ở `tests/unit/printing/test_localhost_tls.py` dùng **server giả qua socket TLS thật** cho luồng thành công, mất ACK mark/report và 4 ranh giới crash; **không gọi đó là backend sản phẩm**.
- Test sản phẩm thực tế `tests/unit/printing/test_product_backend_optin.py` sử dụng **Fastify + PG của AI0** qua HTTPS: default SKIP khi chưa bật. Khi bật `AUTOIN_CODE303_RUN_PRODUCT_DRYRUN=YES_SIMULATION_ONLY`, thiếu URL/token/approved job phải FAIL. Mỗi lần chạy chỉ sử dụng **một job mới** và scenario có thể là `normal`, `cli`, `lost_mark_ack`, `lost_report_ack`, `before_mark_sending`, `after_mark_sending`, `after_journal_before_driver`, `after_driver`. Với lost ACK client cố ý bỏ ACK **sau khi backend AI1 đã commit transaction**; không phải fake HTTP. Chạy lại với job mới cho từng scenario:
  ```bash
  AUTOIN_CODE303_RUN_PRODUCT_DRYRUN=YES_SIMULATION_ONLY \
  AUTOIN_CODE303_HTTPS_URL=https://localhost:3443 \
  AUTOIN_CODE303_AGENT_TOKEN='TEST_SCOPED_AGENT_TOKEN_FROM_AI0' \
  AUTOIN_CODE303_SCENARIO=normal \
  SSL_CERT_FILE=/private/trusted-test-ca.pem \
  python -m pytest -q tests/unit/printing/test_product_backend_optin.py
  ```
  Chạy `AUTOIN_CODE303_SCENARIO=cli` cho subprocess Windows-agent thực, rồi các ca fault; **AI0/AI5 cấp lại fixture mới trước mỗi lần**. Để test normal có đúng một eligible job, tránh in thêm đơn khác khi chạy lại. **Không lưu secret/DB URL vào Git, không bao giờ trỏ đến cửa hàng thật**.

### Trạng thái bằng chứng và yêu cầu AI0/AI5

- PR #21 tại SHA `15c1ac7` đã báo (và CI chạy) Python **95 PASS/1 SKIP**, AI5 PG/DryRun sản phẩm **20/20 PASS** trên snapshot AI3 trước những thay đổi mới; đó không chứng minh agent CLI HTTPS product path mới đạt.
- Nhánh AI3 này bổ sung chặn CLI remote, bài kiểm ACK/crash TLS socket, gate product HTTPS/PG strict. Cần **AI0 nhập đúng SHA mới** vào nhánh simulation rồi chạy GitHub Actions `.github/workflows/integration.yml` (workflow thuộc AI0, AI3 không sửa). CI mặc định sản phẩm opt-in vẫn SKIP nếu chưa seed HTTPS agent test. AI5 phải chạy opt-in trên **Fastify thật với cert/token/job**; report riêng PASS/FAIL/SKIP.
- Còn thiếu **đường chứng minh print thực**: backend job claim chỉ mang `request_hash`/revision, chưa có ký nhận manifest/source artifact hoặc native driver; tuyệt đối không mở driver thật/không tự lấy file gốc. Khi có driver Windows đã xác minh, AI0 phải cấp ref/hash nguồn bất biến và so lại SHA từng source sát lúc in. Ricoh A4/A3/duplex/font/spooler chưa chạy; Windows ACL journal cũng chưa chứng minh.


## CODE-303 — Port DocumentFact[] dành cho AI2 / AI0 (12/10/2026)

**Chính xác nguồn kiểu:** `backend/conversation/rules.ts` PR tích hợp #21 định nghĩa
`DocumentFact { kind: "pdf"|"word"|"image"|"excel"|"unknown"|"zip"; count_inside?: number; preview_trusted?: boolean }`.
Không thay `backend/conversation/**` hoặc contracts AI0.

**Port Python:** `workers.documents.fact_inspect.inspect(batch, artifact_root=<SERVER_PRIVATE_ROOT>) -> list[DocumentFact]`. JSON CLI:
```sh
python -m workers.documents.fact_inspect \
  --artifact-root /private/autoin/verified-artifacts \
  --timeout-seconds 45 < batch.json
```
`batch.json` dạng sau (tất cả ref/hash phải lấy từ hồ sơ artifact ở **server**, không được copy từ trường file name/URL/zalo-event/client):
```json
{
  "batch": [
    {
      "artifact_ref": "doc-a1b2c3d4/source-000-<64hex-sha256>.pdf",
      "sha256": "<64hex-sha256>",
      "manifest_ref": "doc-a1b2c3d4/manifest.json",
      "manifest_sha256": "<64hex-sha256-of-stored-manifest>"
    },
    {
      "artifact_ref": "doc-e5f6a7b8/source-000-<64hex-sha256>.zip",
      "sha256": "<64hex-sha256>",
      "manifest_ref": "doc-e5f6a7b8/manifest.json",
      "manifest_sha256": "<64hex-sha256-of-stored-manifest>"
    }
  ]
}
```
`artifact_ref` phải là ref private của **snapshot bất biến** do pipeline server tạo (`doc-*/source-XXX-<sha>.<extension>`), không phải input path, public URL, Zalo attachment URL hay client name. Tệp ZIP raw cần được **AI0 lưu thành snapshot riêng và đăng ký ref/hash tại DB hoặc manifest server tin cậy** trước khi gọi Port; bridge in hiện tại chụp từng file sau giải nén, chưa chụp ZIP container raw, vì vậy **chưa có tự động nối upload ZIP → batch Port**. Nếu AI0 không có snapshot đáng tin cậy, trả UNKNOWN, không mở file trực tiếp từ webhook.

**Output khi đủ chứng cứ (không có đường dẫn, nội dung file, OCR, số trang hoặc hash):**
```json
{
  "schema": "ai3.document_facts.v1",
  "status": "READY",
  "facts": [
    {"kind":"pdf","preview_trusted":true},
    {"kind":"image","preview_trusted":true},
    {"kind":"zip","count_inside":2,"preview_trusted":true}
  ]
}
```
Mỗi phần tử trong `facts` có đúng các key AI2 đang hiểu. Hàm `inspect` Python trả trực tiếp mảng facts; CLI bọc `schema/status/reason_code/facts` để AI0 phân biệt tình trạng. Nếu **bất kỳ** phần tử thiếu/hash sai/symlink/ZIP lỗi/bị sửa/font PDF chưa nhúng/render hỏng/format chưa xác minh, `status:"NEEDS_HUMAN"` và phần tử `{"kind":"unknown","preview_trusted":false}` hoặc `{"kind":"word"|"excel"|"zip","preview_trusted":false}` phù hợp. Không suy ra `document_pages` từ metadata đoán, không nâng `preview_trusted` nếu chưa thực render.

**Kiểm chứng an toàn:** Bắt buộc bốn trường `artifact_ref`, `sha256`, `manifest_ref`, `manifest_sha256` **đều do AI0 lấy từ DB đáng tin cậy**; không còn chấp nhận cặp ref/hash tự khai. Mở manifest bằng `O_NOFOLLOW` từng path segment, so SHA-256 manifest với digest lưu server, so `files[]` chứa đúng một `source_artifact_ref`/digest/size, sau đó mới mở snapshot bằng dirfd và xác minh bytes SHA-256 cùng kích thước, *trước* giải mã PDF/Pillow/ZIP. Hỏng/sai/thiếu manifest hoặc snapshot đều UNKNOWN/NEEDS_HUMAN. Chỉ xem nội dung những bytes đã hash; không đọc lại inbound. PDF phải đọc được và không dùng font chưa nhúng; ảnh phải Pillow render được; ZIP kiểm traversal/symlink/password/compression/giới hạn file, kiểm thực từng member, chỉ trả `count_inside` khi ZIP cấu trúc an toàn. Word/Excel nhận biết loại nhưng `preview_trusted:false`, không đoán số trang, chuyển người. Bản copy preview chỉ tạo tạm, không mở in.

**Giới hạn tích hợp:** Quyền cấp `artifact_ref`/hash thuộc AI0 backend và quyền đọc nguồn thuộc server, **không thuộc AI2/webhook**. Port không thể tự chứng minh một chuỗi do khách gửi là ref đáng tin: AI0 phải kiểm subject/shop/order/manifest trong DB trước khi gọi, bảo vệ artifact-root (owner/quota/cleanup), và không giao đường dẫn lẫn SHA từ raw webhook sang Port. `inspect(batch)` không tự tạo đơn hoặc duyệt in. Dữ liệu sai/thiếu vẫn được nhận để chuyển nhân viên, không mặc định `PRINT`.

**Kiểm thử:** `tests/unit/documents/test_fact_inspect.py` có PDF/ảnh thật (fitz/Pillow), ZIP nhiều file/hỏng/path traversal, bản snapshot thay đổi/hash mismatch, thiếu nguồn, từ chối path khách/URL/symlink, CLI JSON và định dạng đúng AI2. Chạy:
```sh
python -m compileall -q workers/documents agents/windows tests/unit/documents tests/unit/printing
python -m pytest -q tests/unit/documents tests/unit/printing
```
Đây là Port module AI3; AI0 sẽ map JSON CLI đầu ra thành `DocumentFact[]` cho AI2 và chịu trách nhiệm kiểm DB/ref. PR #24 vẫn là chứng cứ **100 PASS / 1 SKIP của SHA trước lần bổ sung Port**, không chứng minh những bài mới đã chạy.

### Cập nhật điều kiện an toàn — manifest có hash từ DB

Port `inspect(batch)` đã được nâng lên yêu cầu **bốn** trường chứng cứ server: `artifact_ref`, `sha256`, `manifest_ref`, `manifest_sha256` (không phải hai trường). Bản tích hợp AI0 hiện gọi `inspectDocumentRequest` để tạo manifest: giá trị `evidenceHash` từ `backend/composition/processor.ts` là SHA-256 **raw manifest bytes**, phù hợp `manifest_sha256`; nhưng AI0 phải tự lưu vào PostgreSQL cùng liên kết shop/order/artifact một cách đáng tin trước khi gọi Port. Không được cho webhook truyền hash/ref thay cho record DB.

Manifest do `workers.documents.bridge` sinh dùng schema `ai3.document_bridge.v1`, có `files[]`, `source_artifact_ref`, `file_sha256`, `size_bytes`, `request_hash`, `content_settings_sha256`. Với upload từ server chưa qua bridge, AI0 có thể tạo một private immutable manifest theo `ai3.upload_snapshot.v1` và `files[]` tương tự (bắt buộc có `source_artifact_ref/file_sha256/size_bytes`), rồi lưu **SHA-256 manifest** trong server DB. Port không tự sinh bằng chứng, không nhận metadata của khách; thiếu manifest hoặc record phải trả UNKNOWN.

ZIP raw chỉ có khi AI0 đã lưu **container ZIP raw** theo quy tắc snapshot/manifest này; bridge in hiện có lưu từng thành viên sau giải nén, chưa làm bằng chứng riêng cho container ZIP. Thử nghiệm dữ liệu từ fixture tự tạo không đồng nghĩa AI0 đã nối upload ZIP thật.

Các test hồi quy có fixture server-ingest với manifest SHA được ghim; kiểm thêm trường hợp giữ nguyên file nhưng xóa/sửa manifest, manifest trỏ hash/size sai, file thay đổi, mất file, lỗi I/O đọc manifest/bytes, symlink manifest, và kiểm tương thích *thực tế* manifest do bridge tạo. Khi CI chưa hoàn tất, không gọi số PASS từ PR #24/#26 là bằng chứng cho commit sửa lần này.


## CODE-403 (12/10/2026) — Ranh giới bất biến source → manifest → preview → approved revision → DryRun

**Phân công:** `docs/architecture/CODE007_PHAN_CONG_20261012.md` tại `e16f69ace72f41b82bd7438cc97b0c275fc57f64`; AI0 tham chiếu tích hợp `3f0380abed2294fc18d09294cd6a8c9562108710` (PR #31). **Nhánh code AI3:** `ai3/audit-handover-code103-303`, PR #20; giữ nguyên lịch sử và tất cả commit CODE-103/203/303.

### Port mới: kiểm chứng toàn bộ bằng chứng đã đóng băng

`workers.documents.evidence_guard.verify_approved_evidence(trusted, artifact_root=private_root)` là **Port nội bộ Python server-only**, không phải API khách hàng. AI0 phải lấy `trusted` **từ PostgreSQL đã kiểm soát shop/order/actor/revision**, không lấy từ webhook, AI hoặc trường do client truyền. Cấu trúc:

```json
{
  "active_revision": 3,
  "approval_revision": 3,
  "request_hash": "<sha256-of-current-request-from-DB>",
  "approval_id": "<verified-staff-approval-id-from-DB>",
  "manifest_ref": "doc-<private-id>/manifest.json",
  "manifest_sha256": "<sha256-of-persisted-manifest-bytes>",
  "plan": {
    "request_hash": "<sha256-of-current-request-from-DB>",
    "physical_sheets": 6,
    "document_pages": 3,
    "printed_faces": 9,
    "ready": true,
    "printer_id": "RMP7000",
    "artifact_ref": "doc-<private-id>/manifest.json",
    "verified_by": "ai3.processor.v1"
  }
}
```

- So `active_revision == approval_revision`, `request_hash` với plan/manifest, exact manifest ref và SHA256 manifest bytes; chỉ nhận schema AI3 đã biết. Không có đường dẫn tuyệt đối/URL đến file khách.
- Đọc snapshot với `bridge._read_scoped` (dirfd + `O_NOFOLLOW` từng thành phần), so SHA256 + kích thước + tên ref `source-<index>-<sha>`, chặn thiếu/sai/trùng ref.
- So từng `paper_plan` với `processor.plan` tái tính từ số trang đã xác minh, copies, duplex, page selection, A4/A3/binding; cộng tổng `document_pages/printed_faces/physical_sheets`; nếu tổng tờ trên 150 đặt `requires_price_confirmation:true`. **Không tự xác nhận giá** — AI1 phải xác nhận/duyệt dựa trên chứng cứ khách đúng phiên bản và quote hiện hành.
- Kiểm từng PNG raster riêng: private ref thuộc manifest hiện hành, tên được gắn SHA nguồn/index, SHA256 bytes, size, PNG signature và Pillow decode/verify; tối thiểu một preview cho mỗi file. Tính lại `content_settings_sha256` theo cùng bằng chứng chuẩn bridge. Sai nguồn sau render, PNG đổi, manifest thay, giả counts, lỗi I/O hoặc stale revision → `NEEDS_HUMAN` fail closed.
- `READY` xuất metadata tối thiểu gồm `revision,request_hash,manifest_sha256,content_settings_sha256,source_sha256[],preview_sha256[],document_count,preview_count,document_pages,printed_faces,physical_sheets,requires_price_confirmation`; luôn ghi `paper_verified:false`, `print_evidence_kind:"pre_send_document_only"`. **Không trả file ref**, không kết luận khách đã xác nhận, đơn đã được nhân viên duyệt hợp lệ, máy đã in hay đã giao giấy.
- Port này KHÔNG được tự gọi từ request web/public với payload do khách chọn. AI0 phải thực hiện xác thực và ràng buộc qua AI1 transaction trước/sau điểm kiểm chứng; khi revision hoặc hash thay đổi trong lúc kiểm, cần bắt đầu lại bằng trạng thái mới và không sử dụng proof cũ.

### Windows Agent chỉ DryRun và chống gửi lặp

`agents/windows/agent.py` có thêm thuộc tính tùy chọn `evidence_gate` cho `PrintAgent`: callback Python do server/agent integration tin cậy cấp, nhận job AI1, trả **đúng boolean True** khi chứng cứ được xác nhận. Nếu trả `False/None`, object truthy hoặc throw lỗi I/O → BLOCKED ngay **trước** `journal.begin`, `mark_sending`, và driver. Callback không được lấy từ trường JSON khách/job, không phải lối bật in thật. Nếu không được cấu hình, agent tiếp tục phụ thuộc backend AI1 authoritative preflight như trước; **không được diễn giải rằng toàn đường sản phẩm đã tích hợp evidence_guard**.

Đường `BOUNDARY`, `ARMED`, `DRIVER_CALLED`, `UNKNOWN` giữ SQLite WAL + synchronous FULL. Mất ACK `mark-sending` hoặc crash/restart phải fail closed, không tự resend DryRun hay driver thật. Mất ACK `report` chỉ report/reconcile lại idempotent; `SIMULATED_DONE` không phải `VERIFIED_DONE`, không có giấy thật được xác minh.

### Test thật và điểm chặn

- Tests thuộc AI3: `tests/unit/documents/test_evidence_guard_403.py` (PDF thật, PNG thật, ZIP giải nén 2 file, nhiều file, duplex/copies, 151 tờ, render timeout, source/manifest/raster tamper, missing file, active revision stale, tổng count giả); `tests/unit/printing/test_evidence_gate_403.py` (gate không hợp lệ, storage error, revision khác, false/truthy, crash after driver, lost report ACK, restart không gọi lại driver). Các bộ test cũ còn nguyên.
- Test CI dùng nhánh staging [PR #32](https://github.com/minhdienhp2013/AUTO-IN/pull/32) được tạo trên nền **AI0 3f0380a**, chỉ nhập 4 file CODE-403 của AI3. `CODE checks` run **38213521187 SUCCESS**; `Simulation integration` run **38213521205 SUCCESS**, Python `167 passed, 1 skipped`, PostgreSQL/AI5 acceptance `58 pass, 19 skip`, Chromium product-browser PASS. Đây là CI Python/PG/Chromium **synthetic**, KHÔNG phải Ricoh/Windows/OA thật. `compileall` riêng chưa chạy, không ghi PASS.
- **[AI0 CODE-007 cần nối]** Trong composition server-owned: sau khi staff approve/AI1 giữ đúng revision, lấy proof từ `ai0_verified_plan_manifests` và AI1 active revision/approval, gọi Port trước send boundary; phát sinh revision mới, thay PNG/manifest/source hoặc thiếu quote/current challenge phải block/quay về NEEDS_HUMAN. Không cấp input `trusted` từ client; không đổi hợp đồng AI1 trong AI3. Agent Windows không giữ DB hoặc private root server, vì vậy không thể tự hoàn tất end-to-end mà không có Port/binding của AI0. **Windows/Ricoh NOT RUN**, Zalo OA thật NOT RUN, V1/TN-037 chưa nghiệm thu; không merge/deploy/in thật.


## CODE-403 — HTTPS CLI evidence gate (13/10/2026)

Đường `python -m agents.windows.cli --api-base-url https://localhost:PORT --journal PERSISTENT.sqlite` **chỉ DryRun**, được nối với `HttpBackendClient.evidence_verified` qua `PrintAgent.evidence_gate`. Fixture CLI dùng `FakeBackend` độc lập, không giả giấy thật.

- Cache bằng chứng chỉ tạo từ **HTTP 200 HTTPS preflight thật** có đồng thời `allowed is True`, `document_evidence_verified is True` (boolean Python chính xác, không phải `1`/`"true"`), `job_id`, `revision` (int, không bool), `approval_id`, `mode=simulation` khớp claim. Máy chủ AI0 phải xác thực job, shop, lease, request_hash, nguồn/manifest/PNG/approval/current revision qua PostgreSQL; client không tự xét hay tin metadata khách.
- Cache private ràng buộc chính xác bộ `(job_id,order_id,revision,request_hash,approval_id,lease_token)` từ claim. Mỗi claim/preflight mới xóa cache; thay bất kỳ trường nào đều trả `False`; mark-sending chỉ được gọi sau preflight hợp lệ và xóa cache **trước khi** POST, kể cả khi ACK mất.
- **Chỉ** HTTP status `409` có JSON `{"error":{"code":"DOCUMENT_EVIDENCE_UNVERIFIED"}}` từ HTTPS preflight chuyển `BLOCKED` **trước** journal, `mark-sending` và driver. 409 mã khác, phản hồi không hợp lệ, 503/mạng/mất ACK không bị đổi thành BLOCKED hay tự retry; CLI giữ `UNKNOWN`/đối soát. 409 ở mark-sending **sau** journal đi lối `UNKNOWN`, không gọi driver, tuyệt đối không resend.
- Mọi lỗi/đối soát vẫn dùng SQLite WAL + `synchronous=FULL` và chỉ báo `SIMULATED_DONE`/`paper_verified:false`, không `VERIFIED_DONE`. Không đọc tệp khách cho chứng cứ.

Các ca mô phỏng mới thuộc AI3: `tests/unit/printing/test_https_evidence_gate_403.py` (identity/cache/replay/cờ đúng-sai, HTTP 409 chính xác và khác mã, lỗi socket, mark bị từ chối), `tests/unit/printing/test_localhost_tls.py` (CLI subprocess HTTPS cert tin cậy, restart, 409, mark denial, ACK loss). Hai fixture cũ `test_backend_http.py` và `test_backend_simulation.py` được cập nhật **chỉ để thêm cờ 200 đúng từ server**, không bỏ/nới kịch bản chống in trùng.

Chạy `python -m compileall -q workers/documents agents/windows tests/unit/documents tests/unit/printing` và `python -m pytest -q tests/unit/documents tests/unit/printing`. GitHub Actions staging PR #32 giữ lịch sử bằng merge commit không force, parent AI0 SHA `9c9920bed560ca073b783f2d2a6d0db67c4abeb9`, chỉ mang thay đổi file AI3; branch PR #20 không reset. Lượt kiểm thử Windows/Ricoh/OA thật vẫn **NOT RUN**, HTTPS PostgreSQL mới cần CI PASS riêng từng commit; không tuyên bố V1 nghiệm thu.


## CHECKLIST NGHIỆM THU WINDOWS/RICOH CÓ KIỂM SOÁT — CHƯA ĐƯỢC PHÉP CHẠY (14/10/2026)

**Phạm vi:** Bảng này là thủ tục chuẩn bị cho **một job thử duy nhất sau khi chủ cửa hàng phê duyệt riêng**, không phải lệnh triển khai, không phải giấy phép mở driver. Tính đến cập nhật tài liệu, **Windows/Ricoh vật lý: NOT RUN**. `GuardedWindowsDriver` trong `agents/windows/agent.py` vẫn cố ý **fail-closed**; CLI hiện chỉ khởi tạo `DryRunDriver`. Không tự sửa để bật driver in thật, không thử TCP/RAW 9100, Windows spooler, máy Ricoh hay Zalo OA. Nếu bất kỳ điều kiện tiên quyết nào chưa đạt, **STOP** và chỉ tiếp tục DryRun độc lập.

### A. Điều kiện bắt buộc trước khi chủ cho phép một job thử

- [ ] **Chủ cửa hàng chấp thuận bằng văn bản riêng**: tên người duyệt, thời điểm, phạm vi, mã máy, *một* mã `job_id` và `order_id` thử, `revision`, `request_hash`, tối đa số trang/bản/tờ và người giám sát đứng tại máy. Chấp thuận phải có **trước** bất kỳ lần gửi thật; không mặc định chấp thuận từ việc chạy CI, trạng thái `READY`, preflight hoặc quyền nhân viên.
- [ ] AI0/AI1/AI5 xác nhận **môi trường thử cô lập**: shop `simulation`/fixture không chứa dữ liệu khách thật, tài khoản agent chỉ có quyền máy thử, TLS/CA được tin cậy, PostgreSQL và kho snapshot private hợp lệ. Không gửi token/secret vào argv, log, ảnh chụp hay tài liệu bàn giao. Xác nhận có phương án khóa/thu hồi quyền và dừng thử ngay.
- [ ] **Đường in thật được thiết kế, review bảo mật và duyệt độc lập**: hiện chưa có trong CLI; cần xác minh adapter Windows, quyền ACL của SQLite journal, định danh driver, file/hashing sát ranh giới gửi, cơ chế lệnh đơn lần và rollback thủ công. **Nếu `GuardedWindowsDriver` vẫn từ chối: STOP; không monkeypatch/bỏ gate để thử máy.**
- [ ] Nhân viên được phân công đã chuẩn bị giấy thử A4/A3, khay đúng, đủ giấy, người kiểm đếm giấy thực tế, chỗ giữ riêng giấy thử, phương án xử lý kẹt/hủy có ghi nhận. Thử bằng dữ liệu tổng hợp (không có thông tin khách).

### B. Nhận diện đúng thiết bị — xác minh lại tại hiện trường, không suy đoán từ IP

- [ ] Ghi nhận *tại Windows* tên queue và `printer_id` đã cấp quyền; hồ sơ khảo sát trước đây là **`RMP7000` → Ricoh IM7000, IP `192.168.1.195`, PCL6 V4 Universal**. Đây là **tham chiếu chưa tái kiểm chứng**, không phải bằng chứng nhận diện máy đang kết nối.
- [ ] Người phụ trách Windows + người đứng cạnh máy **đối chiếu đồng thời** hostname/IP, nhãn model/serial tại thân máy, địa chỉ driver/port, queue và `printer_id` từ backend; chụp/ghi biên bản phần **không chứa token/tài liệu khách**. Không chọn máy Windows mặc định; nếu nhiều máy cùng model/địa chỉ hoặc serial không khớp: **STOP**.
- [ ] Xác nhận khay, mặt in, A4/A3, duplex cạnh dài/ngắn, khổ giấy/vùng không in và driver thực dùng. Nếu file Word/Excel hoặc font cần xử lý chưa được render/đếm trang tin cậy: `NEEDS_HUMAN`, **STOP**, không ép mọi file sang PDF để lách kiểm tra.

### C. Đóng băng chứng cứ và đối chiếu preview/manifest trước khi cho phép gửi

- [ ] Server lấy `shop_id/order_id/job_id/active_revision/approval_id/request_hash/lease_token` từ **PostgreSQL đã xác thực**, không lấy từ webhook/tên file/JSON khách. Job phải đúng revision/khách xác nhận giá nếu cần (>150 tờ)/nhân viên duyệt; chỉ một job đủ điều kiện, không có job khác có thể bị agent claim nhầm.
- [ ] Đối chiếu `manifest_ref`, SHA-256 manifest từ DB, hash và kích thước từng source snapshot, PNG preview đã render, `content_settings_sha256`, `paper_plan` theo từng file: số trang tài liệu, mặt in, tờ vật lý, số bản, giấy, hướng, duplex. Preview đầu/giữa/cuối là **ảnh tham chiếu**, không là chứng cứ máy sẽ in đúng; nhân viên phải xem preview và so với yêu cầu thử trước khi phê duyệt.
- [ ] AI0 phải xác minh server-side `/preflight` trả `document_evidence_verified: true` **chỉ khi** đúng shop/job/revision/approval/hash/manifest/source; agent HTTPS phải so đúng identity của lease hiện tại, **không dùng cached proof của claim trước**. Server kiểm lại nguồn/chứng cứ ngay `/mark-sending`; sai/thiếu/chỉnh sửa → `DOCUMENT_EVIDENCE_UNVERIFIED` hoặc fail-closed, **STOP**.
- [ ] Chốt dấu thời gian, SHA-256 và mã chứng cứ **không kèm nội dung file/đường dẫn bí mật** trong biên bản; không coi một PNG hợp lệ là xác nhận đã in hay đã giao.

### D. Chỉ một job thử có giám sát — quy trình dự kiến, không thực hiện ở phiên này

- [ ] Người giám sát đặt hệ thống ở trạng thái không nhận thêm job; kiểm máy đúng ID, trạng thái chưa gửi `NOT_SENT`, journal chưa có `BOUNDARY` cho job thử và chỉ có **một** job được cấp. **Không xóa/sửa journal** để làm job có thể in lại.
- [ ] Sau phê duyệt riêng, hệ thống phải thực hiện đúng thứ tự: **claim → preflight + evidence gate → ghi SQLite journal bền vững → mark-sending được server xác nhận → gọi driver một lần**. Trước mỗi ranh giới phải kiểm lease, revision, nguồn/hash và trạng thái máy. **Không dùng test hiện tại để gọi driver thật khi adapter chưa được duyệt.**
- [ ] Ghi nhận cho **cùng một `job_id`**: mốc claim, preflight, `mark-sending`, phản hồi ACK, journal `BOUNDARY/ARMED/DRIVER_CALLED`, dấu vết Windows spooler, trạng thái máy, số tờ đã ra và kết quả đếm kiểm tra bằng người. Phân biệt rõ *ACK server*, *ACK/spooler*, *driver trả về* và *giấy vật lý thực tế*; các loại ACK **không thay thế nhau**.
- [ ] Sau khi có giấy thật: hai người đối chiếu số **tờ vật lý thực ra**, mặt, thứ tự, khay/khổ, font tiếng Việt, bản in và nội dung với preview/plan. Nếu cần trạng thái `VERIFIED_DONE`, chỉ nhân viên có quyền đối soát qua hợp đồng AI1, kèm bằng chứng kiểm đếm thực tế; **spooler “Printed/Completed” hoặc job biến mất khỏi hàng đợi không chứng minh đã in đủ và không được tự nâng `VERIFIED_DONE`**.

### E. UNKNOWN, mất ACK và điều kiện DỪNG tuyệt đối

- [ ] Nếu mất ACK `mark-sending`, đứt mạng, timeout, Windows/driver crash, mất điện, job bị kẹt, source/manifest/preview đổi, revision/approval/lease khác, driver trả kết quả mơ hồ hoặc số tờ ra không khớp: **dừng mọi lệnh gửi tiếp**; ghi `UNKNOWN`/đối soát, giữ journal + DB và bằng chứng nguyên vẹn. **Không tự retry, không tạo job mới để in bù, không bấm lại Print, không xóa queue/journal để vượt chống trùng.**
- [ ] Khi `UNKNOWN`/mất ACK: đối chiếu server `NOT_SENT/SENDING/UNKNOWN`, journal `BOUNDARY/ARMED/DRIVER_CALLED/UNKNOWN`, spooler và **giấy tại máy** với người giám sát; không suy luận `NOT_SENT` chỉ từ lỗi client. Nếu chưa thể khẳng định đã/ chưa in, giữ `UNKNOWN` và **STOP**. Chỉ **chủ cửa hàng** có thể xét **duyệt in lại riêng** sau biên bản đối soát và kiểm tra nghĩa vụ giấy/tiền/giao; không tự kích hoạt lại job cũ.
- [ ] DỪNG ngay nếu máy in nhận diện không đúng, dữ liệu khách thật xuất hiện, thiết bị ngoài phạm vi thử, giấy ra sai số/tờ, chất lượng/font/duplex sai, thiếu người giám sát, token/ACL/journal không đạt, TLS không tin cậy, bất cứ lỗi 409/503/chứng cứ sai, hoặc phát hiện gửi lặp. Khóa thử ở backend/agent, cô lập vật lý nếu cần với người vận hành; giữ toàn bộ dấu vết phục vụ đối soát.

### F. Biên bản kết thúc và điều kiện đánh dấu nghiệm thu

- [ ] Ghi: mã phiên thử; chấp thuận cụ thể của chủ; `job_id/order_id/revision/request_hash` (không tiết lộ lease/token); Windows host, queue, model/serial, port/driver đã đối chiếu; SHA manifest/source/preview; plan trang–mặt–tờ; ACK server, journal và spooler; **số tờ thực kiểm đếm**; ảnh/biên bản giấy thử an toàn; lỗi/UNKNOWN và ai chịu trách nhiệm xử lý.
- [ ] Kết quả được gắn nhãn riêng: **DryRun CI**, **HTTPS + PostgreSQL cô lập với DryRun**, **Windows driver thật**, **Ricoh/giấy thật**. Không chuyển PASS của mức thấp sang mức cao. Chỉ ký `PASS thiết bị thật` khi chủ đã cho phép, driver đã review, tất cả mục A–E đạt, một job thực đã được người giám sát kiểm giấy đủ/đúng và không còn `UNKNOWN` chưa đối soát. Bất kỳ điều kiện thiếu → **BLOCKED / NOT RUN**.
- [ ] Sau thử: vô hiệu hóa/thu hồi credential thử, khóa quyền in thật nếu có, xác nhận không còn job chờ, lưu biên bản nội bộ theo quyền truy cập; **không tự chuyển sang vận hành/deploy**.

**Tình trạng hiện tại:** mới có **DryRun/synthetic + product-backed PostgreSQL/HTTPS**, không có bằng chứng Windows/Ricoh thực. Trong bàn giao AI0 PR #74 có thông tin overlay validation [PR #76](https://github.com/minhdienhp2013/AUTO-IN/pull/76) HEAD `0ee0a74892576cf38dcce539889ad017e27be26b` PASS `compileall`, `199 passed / 1 skipped` Python và `26/26` PostgreSQL/HTTPS integration trên **SHA PR #76**, nhưng đó vẫn là DryRun. **Thiếu:** máy Windows được kiểm soát + xác minh serial/driver/port/queue, adapter driver thật được review và duyệt riêng, chấp thuận một job thật của chủ, người giám sát đếm giấy, quyền/credential/TLS/ACL phù hợp, biên bản đối soát thực tế. **Không thực hiện các bước kết nối/in ở phiên cập nhật tài liệu này.**


## CODE-403 — One-job Windows spooler seam (15/10/2026; FAKE ONLY)

**Trạng thái:** Chỉ code thử ranh giới gửi, **không có adapter kết nối Windows/driver/Ricoh thật**. Module `agents/windows/controlled_spooler.py` thêm `OneJobWindowsSpoolerSeam`, dùng duy nhất `InMemorySpooler` kiểu chính xác (không chấp nhận subclass/transport tùy ý). Đầu vào `OneJobTicket` và `ObservedPrinter` là các **fixture do harness đáng tin cậy cấp**, tuyệt đối không thể dùng chúng làm bằng chứng nhân viên đã duyệt, xác minh serial máy tại hiện trường hay bằng chứng giấy đã in.

- **CLI sản phẩm không thay đổi**, chỉ dùng `DryRunDriver`, `PrintAgent._verify_job` tiếp tục từ chối driver khác; `GuardedWindowsDriver` vẫn fail closed. Không có flag, environment hay trường JSON nào mở đường gửi thật.
- Trước tạo journal, so chính xác `job_id/order_id/revision/request_hash/approval_id/lease_token/printer_id` với ticket một-job; job phải `mode=simulation`, `printer_id=RMP7000`. So mô tả queue/model/serial/driver/port với mock inventory riêng, SHA-256 bytes của manifest/source/preview với hash ticket, rồi yêu cầu preflight trả chính xác `allowed=True`, `document_evidence_verified=True`, job/revision/approval/mode khớp. Thiếu/sai → BLOCKED hoặc `PrintBlocked`, **0 lần gửi, 0 bản ghi ranh giới**. Hash preview test bằng bytes tổng hợp **không chứng minh khả năng render/in thực**.
- SQLite `Journal` WAL + `synchronous=FULL`: `BEGIN IMMEDIATE` kiểm tra toàn journal trống rồi ghi `BOUNDARY` đúng một lần. Dù job cũ hay job khác, đã có bản ghi nào cũng **không cho thêm một job thử**. Journal trên đĩa riêng, persistent và ACL Windows **chưa nghiệm thu**.
- Sau boundary mới gọi callback giả `mark_sending`; ACK không xác nhận → journal `UNKNOWN`, **không gọi spooler**. Trước giả gửi, ghi `DRIVER_CALLED` để crash/mất ACK không tạo lần gửi thứ hai. Mock spooler nhận metadata (job ID, queue) mà không nhận byte file, không mở Win32/RAW9100/cổng máy. Dù spooler giả trả accepted vẫn ghi `UNKNOWN`/awaiting human vì ACK không chứng minh số tờ vật lý; không bao giờ xuất `VERIFIED_DONE`.
- Crash ở `BOUNDARY/ARMED/DRIVER_CALLED` → khởi động lại `recover()` chuyển `UNKNOWN`, không retry. Callback hỏng/mất ACK từ mark hoặc spooler, queue bất thường, job trùng → STOP, giữ journal. **Chỉ chủ** xem xét lệnh in lại riêng sau đối soát; spooler `Completed` không phải bằng chứng in đủ giấy.
- Bài test: `tests/unit/printing/test_controlled_spooler_403.py` kiểm hash/source/preview, old revision/approval/lease, queue/model/serial/driver/port sai, preflight sai, mark/spooler ACK mất, crash 4 mốc, restart và gửi trùng/khác job (0 lần thứ hai), biến môi trường/flag JSON không mở in thật. Chạy `python -m compileall -q workers/documents agents/windows tests/unit/documents tests/unit/printing` và `python -m pytest -q tests/unit/documents tests/unit/printing`. Chỉ coi PASS theo **SHA CI thực tế**.

**Hợp đồng chưa có, phải AI0 + chủ phê duyệt trước in thật:** (1) adapter Windows thật chỉ chọn **queue/driver/port/serial đã xác thực trực tiếp trên máy**, quyền chạy/ACL và nhận diện chống nhầm máy; (2) định dạng gửi từ ứng dụng gốc hoặc print pipeline/driver chính thức đã kiểm thực PDF/Word/ảnh, khổ/duplex/font (không tự đoán RAW 9100/PCL); (3) Port cấp snapshot/manifest/preview bất biến từ DB, hash lại sát điểm gửi và server confirm lại revision/approval/lease; (4) cơ chế một job thật được chủ duyệt và người giám sát đối soát ACK, spooler, **giấy thực đếm bằng người**, xử lý UNKNOWN/no resend. Khi chưa có đủ bốn hợp đồng, **chỉ fake/CI**, Windows/Ricoh thật `NOT RUN`; không tự thay `InMemorySpooler` bằng Win32 hoặc mở driver bằng cờ cấu hình.
