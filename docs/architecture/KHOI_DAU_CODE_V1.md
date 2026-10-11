# Khởi đầu code V1 — quyết định điều phối 11/10/2026

Bộ này mở đợt viết code đầu tiên theo yêu cầu chủ. Chưa có scaffold hoặc tích hợp thật. Các quyết định dưới đây là lựa chọn kỹ thuật của AI0 cho đợt khởi đầu, không thay các quy tắc TN.

## Stack và cấu trúc

| Phần | Lựa chọn |
| --- | --- |
| Backend | TypeScript, Node LTS tương thích phiên bản dependency đã khóa, Fastify; một backend duy nhất. |
| Giao diện | React + TypeScript + Vite; web dùng Windows/iPhone, chuẩn bị PWA. |
| Dữ liệu | PostgreSQL; dùng thật trong phép thử transaction/concurrency. Không thay bằng bộ nhớ để báo đạt các ca này. |
| Tài liệu/Windows | Python; phiên bản và công cụ kết xuất/driver do AI3 kiểm chứng, AI0 ghi lại. |
| Kiểm thử | Typecheck/build, test đơn vị/tích hợp; kiểm thử trình duyệt bằng Playwright hoặc công cụ tương đương đã được AI0 khóa. |
| Phát triển | Mô phỏng là mặc định; adapter OA/máy in thật bị tắt cho tới khi có cấu hình và kiểm chứng tương ứng. |

Node/dependency phải xác minh từ tài liệu chính thức và khóa trong lockfile, không dùng nhãn latest không kiểm tra. Không thêm Redis/Kafka/microservices cho đợt này. Chưa chọn nhà cung cấp cloud hoặc triển khai production.

## Trình tự

1. Cả 6 AI bắt đầu song song từ cùng commit tài liệu có bộ prompt code này. Nếu main chưa có các tài liệu này, dùng HEAD thực của ai0/nen-tang-dieu-phoi-v1, ghi BASE SHA thật. Mỗi AI một nhánh/worktree.
2. CODE-000: AI0 viết cấu hình root/runtime, contracts/**, entry/composition backend và công cụ kiểm tra schema. AI0 không tạo hoặc sửa file module của AI1–AI5. Tạo nhánh ai0/khoi-tao-code-v1; đọc hợp đồng wire v0.1 dưới đây trước khi viết types/schema.
3. CODE-101–105: AI1–AI4 viết module trong phạm vi riêng ngay; AI5 viết fixture/test độc lập. API/runtime chưa có dùng Port/adapter/mock được gắn nhãn, làm phần độc lập trước; không chờ OA/máy thật hoặc chờ mọi AI khác hoàn tất. Dependency/config chung gửi AI0 bổ sung. Manifest riêng nằm trong phạm vi một AI có thể do AI đó tạo.
4. AI0 bàn giao scaffold commit sớm. Các AI lấy thay đổi chung vào nhánh riêng, giải quyết xung đột thuộc phạm vi mình và chạy kiểm thử. Không tự ghi đè hoặc lấy toàn bộ mã AI khác chỉ để build.
5. CODE-006: AI0 tích hợp trên nhánh riêng, nối plugin/UI/adapter và chạy toàn luồng mô phỏng. Thử thật và nghiệm thu TN-037 là bước sau, không thể thay bằng mock.

## Sở hữu file

AI0 giữ cấu hình root/build/CI/lockfile, contracts/**, backend/app.ts (hoặc file composition tương đương do AI0 ghi rõ), docs/architecture/** và tài liệu điều phối chung. Nếu scaffold tạo file entry mới, AI0 cập nhật PHAN_CONG_AI trước bàn giao.

AI1: backend/core/**, backend/api/**, backend/storage/**, backend/jobs/**, tests/unit/core/**, tests/integration/core/**.
AI2: backend/integrations/zalo/**, backend/conversation/**, backend/ai/**, tests/unit/zalo/**.
AI3: workers/documents/**, agents/windows/**, tests/unit/documents/**, tests/unit/printing/**.
AI4: web/**, tests/ui/** (gồm manifest/config riêng của web).
AI5: tests/acceptance/**, tests/fixtures/public/**, docs/acceptance/**.

AI1/AI2 xuất plugin/hàm theo hợp đồng; AI0 nối chúng vào backend entry. AI0 không tạo web/**; AI4 tự tạo project web và manifest/config/lock riêng. AI3 giữ manifest/lock Python bên trong hai phạm vi của mình. Cấu hình/lock ở root chỉ AI0 sửa. Mỗi AI tự thử module; AI5 kiểm tra độc lập.

## Hợp đồng wire v0.1 cho đợt song song

- Schema cùng ID, revision, hash tài liệu/thông số, quote_revision, confirmation, approval, job_id, actor/quyền, chế độ mô phỏng/thật, trạng thái riêng và loại bằng chứng.
- API/sự kiện tối thiểu cho tạo/sửa/xác nhận/duyệt đơn; quote/tiền/giao; tiếp quản/lịch/thủ công; claim/preflight/mark-sending/report tác vụ; lỗi quyền/phiên bản/idempotency.
- Adapter Port cho Zalo, hiểu ý định, repository, document processor và print driver. Python dùng schema/JSON chung; không tự sao chép định nghĩa khác.
- Server là nguồn quyền; không tin actor/role/approved của client. Principal giả chỉ trong phép thử, không lọt đường chạy thật.
- Chuyển sang SENDING phải được server cho phép nguyên tử trước tác dụng in; local journal bền vững trước gọi driver. Crash/mơ hồ giữ UNKNOWN. Preflight không cấp quyền vô hạn; lease hết hạn không biến lệnh có thể đã gửi thành NOT_SENT.
- mode=simulation và evidence_kind=simulated không được dùng làm bằng chứng đã in thật. Adapter thật fail closed nếu thiếu quyền/cấu hình.
- Thay đổi sau khi khóa: AI0 cập nhật schema/API và consumer liên quan cùng ca kiểm thử.

Tên trường JSON dùng snake_case. ID chuỗi ổn định; revision là số nguyên tăng, request_hash là SHA-256 của nội dung/cấu hình chuẩn hóa; thời điểm lưu UTC, lịch tính Asia/Ho_Chi_Minh. Tiền là số nguyên VND, không để AI suy ra giá.

Job state: NOT_SENT, SENDING, SENT_UNVERIFIED, UNKNOWN, VERIFIED_DONE, SIMULATED_DONE. VERIFIED_DONE chỉ cho bằng chứng thật; SIMULATED_DONE không được làm UI báo đã in giấy thật. mode: simulation, controlled_test, production, safe. Actor/quyền lấy từ phiên hoặc credential đã xác thực ở server.

Request thay đổi dùng expected_revision; idempotency_key gắn actor+hành động+hash payload. Cùng khóa/cùng payload trả kết quả cũ an toàn; cùng khóa/khác payload trả 409. Lỗi chung: {error:{code,message,retryable,current_revision?}}. HTTP 401/403 cho xác thực/quyền; 409 cho phiên bản/xung đột; 422 cho nghiệp vụ/dữ liệu không hợp lệ; 503 cho phần chưa sẵn sàng.

| API tối thiểu | Chủ code | Ý nghĩa |
| --- | --- | --- |
| /api/v1/auth/login, /logout, /me | AI1 | Phiên nhân viên/chủ; không tin role do client gửi. |
| GET/POST /api/v1/orders; GET /api/v1/orders/{order_id} | AI1 | Xem/tạo đơn theo quyền; tạo đơn còn nháp. |
| POST /api/v1/orders/{order_id}/revisions | AI1 | Bản mới khi chưa gửi; giữ lịch sử và xác nhận/duyệt lại. |
| POST /api/v1/orders/{order_id}/confirmations | AI1 | Xác nhận khách từ kênh/credential đã xác minh; không cho AI tự giả khách. |
| POST /api/v1/orders/{order_id}/approvals | AI1 | Duyệt đúng phiên bản/giá và cảnh báo cọc. |
| POST /api/v1/orders/{order_id}/quote, /payments, /deliveries, /manual | AI1 | Giá/tiền/giao/khóa thủ công độc lập, theo quyền. |
| POST /internal/v1/print-jobs/claim | AI1 | Nhận tác vụ hợp lệ chắc chắn chưa gửi; credential agent theo scope. |
| POST /internal/v1/print-jobs/{job_id}/preflight, /mark-sending, /reports | AI1 | Kiểm lại/cho phép gửi nguyên tử/báo bằng chứng. mark-sending phải thành công trước gọi driver. |
| POST /api/v1/conversations/{conversation_id}/handover, /return-to-ai | AI1 | Tiếp quản/trả AI, thay generation; AI2 nhận sự kiện qua Port. |
| POST /webhooks/zalo | AI2 | Verify provider, normalize/persist/khử lặp trước xử lý. |
| GET /health | AI0 | Health runtime; không chứng minh tính năng chưa nối đã hoạt động. |

Các API liệt kê nhiều suffix trong cùng ô phải được tách thành route riêng khi AI0 tạo OpenAPI. AI0 viết body/response/schema chi tiết và fixture chuẩn bám tên/ý nghĩa này; gửi sớm cho consumer. Nếu chưa có schema code, consumer viết model nội bộ + mapper/Port theo bảng này, không tự công bố API mới.

Không cấp thời gian sống lease cứng trong prompt; AI0/AI1 chốt theo ca cạnh tranh. Khi đã SENDING hoặc mơ hồ, lease hết hạn cũng không cho claim lại như NOT_SENT. Đơn đã gửi có thay đổi phải đối soát, không sửa job cũ để in lại.

## Đầu ra đợt đầu

Đăng nhập theo quyền → tạo đơn/file mẫu → preview/count thực khi công cụ có sẵn → khách xác nhận phiên bản → nhân viên duyệt → agent mô phỏng nhận/gửi/report → kiểm tra/giao/tiền. Bước mô phỏng phải được hiển thị rõ. File không xử lý đáng tin phải chuyển người, không làm giả preview/số trang.

Thông báo Push và OA/Ricoh thật chỉ được đánh dấu đã kiểm chứng bằng thử tương ứng. Không tạo nút bật production để bù các phần chưa có.

## Tham khảo chính thức

- Fastify TypeScript: https://fastify.dev/docs/latest/Reference/TypeScript/
- Vite/React-TypeScript và yêu cầu Node: https://vite.dev/guide/
- PostgreSQL locking: https://www.postgresql.org/docs/current/explicit-locking.html

