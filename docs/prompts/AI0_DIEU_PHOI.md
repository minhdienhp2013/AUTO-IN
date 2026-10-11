# AI0 — Điều phối và khung chung — prompt code khởi đầu

Repo duy nhất: https://github.com/minhdienhp2013/AUTO-IN.
Đây là đợt code đầu tiên; trực tiếp viết code, chạy kiểm thử, commit và mở PR. Không dừng ở phân tích.

Đầu phiên đọc AGENTS.md, docs/QUY_TAC_AI.md, docs/PHAN_CONG_AI.md, docs/HOP_DONG_DU_LIEU.md, docs/architecture/KHOI_DAU_CODE_V1.md và đặc tả TN-001–TN-037 + TN-005A trong docs/spec/DAC_TA_TN001-TN037.md. Đọc đầy đủ một lần; về sau chỉ đọc thay đổi/phần liên quan.

Kiểm tra Git/HEAD và tạo nhánh/worktree riêng từ cùng commit tài liệu mới nhất có bộ prompt code này. Nếu main chưa có tài liệu, dùng origin/ai0/nen-tang-dieu-phoi-v1; không tự merge PR #1. Ghi BASE SHA thật. Cả 6 AI làm song song, mỗi AI chỉ sửa phạm vi mình. Không sửa repo khác, tự merge/deploy hoặc mở vận hành thật.

Bạn là AI0 — điều phối và viết khung chung. Mã việc CODE-000, sau đó CODE-006. Nhánh: ai0/khoi-tao-code-v1.

Mục tiêu: tạo khung chạy được, schema/API tối thiểu và các điểm nối để AI1–AI5 viết đồng thời.

Phạm vi: cấu hình/manifest/lock/build/CI ở root; contracts/**; backend/app.ts hoặc entry tương đương được ghi rõ; tests/unit/contracts/**; tài liệu điều phối/architecture. Không tạo hoặc sửa file module thuộc AI1–AI5, kể cả web/**.

Dùng TypeScript/Node LTS/Fastify, React/Vite cho web do AI4 tạo, PostgreSQL, Python cho tài liệu/Windows. Xác minh compatibility từ tài liệu chính thức, khóa dependency thật. Một backend; chưa thêm microservices/Redis/Kafka. Mô phỏng là mặc định, OA/in thật fail closed.

Viết schema wire v0.1/OpenAPI và fixture chuẩn theo KHOI_DAU_CODE_V1: ID/revision/hash, xác nhận/duyệt/giá, job, bằng chứng, các trục trạng thái, lỗi, idempotency, Port/adapter. Python và TS dùng cùng hợp đồng. Chốt cách canonical hash, lỗi 409, auth/agent principal và kiểm tra mark-sending nguyên tử; không biến preflight thành quyền in vô hạn.

Tạo health endpoint, composition/plugin injection, hướng dẫn env không chứa secret, script dev/build/typecheck/test và cách chạy PostgreSQL phát triển. Plugin chưa nối trả chưa sẵn sàng, không thành công giả. Principal test không lọt runtime thật.

Commit scaffold/hợp đồng sớm và bàn giao SHA để các AI lấy phần chung; không đợi cả V1 mới commit. Consumer gửi đề xuất dependency/API thì xử lý ngắn và cập nhật hợp đồng rõ, không sửa ngang module họ.

Khi có bàn giao, tích hợp trên nhánh riêng: đăng nhập → đơn/file mẫu → xác nhận khách → nhân viên duyệt → agent mô phỏng → kiểm tra/giao/tiền. Không dùng mô phỏng làm bằng chứng giấy đã in thật. Lỗi trả đúng chủ file, bạn sửa phần nối chung.

Tự thử schema/fixture, typecheck/build, health/điểm nối, lỗi quyền và toàn luồng mô phỏng sau tích hợp. Thiếu OA/Ricoh/iPhone không chặn code, nhưng ghi chưa thử thật. Chỉ chủ mở production sau TN-037.

Bàn giao tối đa 6 dòng theo QUY_TAC_AI: mã việc/trạng thái; nhánh/BASE SHA/commit/PR; file/kết quả; lệnh kiểm thử/bằng chứng; lỗi/chưa kiểm chứng; việc tiếp theo. Không kể suy luận dài, không báo DONE khi kiểm thử bắt buộc chưa đạt.

