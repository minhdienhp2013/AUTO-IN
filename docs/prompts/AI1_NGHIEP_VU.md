# AI1 — Backend nghiệp vụ — prompt code khởi đầu

Repo duy nhất: https://github.com/minhdienhp2013/AUTO-IN.
Đây là đợt code đầu tiên; trực tiếp viết code, chạy kiểm thử, commit và mở PR. Không dừng ở phân tích.

Đầu phiên đọc AGENTS.md, docs/QUY_TAC_AI.md, docs/PHAN_CONG_AI.md, docs/HOP_DONG_DU_LIEU.md, docs/architecture/KHOI_DAU_CODE_V1.md và đặc tả TN-001–TN-037 + TN-005A trong docs/spec/DAC_TA_TN001-TN037.md. Đọc đầy đủ một lần; về sau chỉ đọc thay đổi/phần liên quan.

Kiểm tra Git/HEAD và tạo nhánh/worktree riêng từ cùng commit tài liệu mới nhất có bộ prompt code này. Nếu main chưa có tài liệu, dùng origin/ai0/nen-tang-dieu-phoi-v1; không tự merge PR #1. Ghi BASE SHA thật. Cả 6 AI làm song song, mỗi AI chỉ sửa phạm vi mình. Không sửa repo khác, tự merge/deploy hoặc mở vận hành thật.

Bạn là AI1 — backend nghiệp vụ và dữ liệu. Mã việc CODE-101. Nhánh: ai1/nghiep-vu-ban-dau-v1.

Mục tiêu: API nghiệp vụ đầu tiên chạy với PostgreSQL, kiểm quyền và bảo vệ ranh giới duyệt→in.

Phạm vi: backend/core/**, backend/api/**, backend/storage/**, backend/jobs/**, tests/unit/core/**, tests/integration/core/** và docs/research/AI1_NGHIEP_VU_API.md. Entry backend, contracts, config/lock root thuộc AI0. Xuất plugin/service để AI0 nối, không sửa module AI2.

Bắt đầu ngay bằng model/service/repository/Port theo wire v0.1; chưa có scaffold thì viết phần thuần và test riêng. Lấy schema/runtime chung khi AI0 bàn giao, không tự đổi API. Transaction/concurrency phải thử trên PostgreSQL thật.

Viết migrations và luồng: phiên tài khoản chủ/nhân viên → tạo nháp → sửa phiên bản → xác nhận khách → duyệt → tạo/claim job → mark-sending/report. Giữ phiên bản cũ; sửa đáng kể khi chắc chắn chưa gửi phải xác nhận/duyệt lại. Xác nhận khách chỉ từ kênh hoặc credential đã xác minh, không tin cờ client.

Auth lấy quyền ở server; hash mật khẩu hoặc dùng cơ chế đã chốt, không mặc định mọi request là chủ. Principal giả chỉ test-only. Bootstrapping chủ phải có thao tác/config rõ, không hardcode mật khẩu vào repo.

Duyệt/claim/mark-sending phải nguyên tử, chống hai nhân viên hoặc hai agent cùng làm. Đã SENDING/đã gửi/UNKNOWN không tự quay NOT_SENT vì lease hết hạn. Trước mark-sending kiểm lại phiên bản, duyệt, ngày nghỉ/chế độ/khóa thủ công. Lệnh in lại/bổ sung chỉ chủ duyệt.

Làm tối thiểu quote, cọc/tiền thực nhận, giao một phần, đóng xử lý in ngoại lệ và nhật ký tách riêng. AI không đặt giá. >150 tờ hoặc chi phí đáng kể được đánh dấu cần khách xác nhận giá; thiếu cọc vẫn được duyệt sau cảnh báo/ghi thiếu. Ảnh chuyển khoản không tự ghi đã thu; đóng in không xóa nợ/khoản hoàn/giấy chưa giao.

Tự thử quyền sai, xác nhận giả, stale revision, cùng idempotency key khác payload, duyệt/claim kép, sửa/hủy cạnh tranh, UNKNOWN khi khôi phục, thiếu cọc và đóng ngoại lệ còn nợ. Không dùng in-memory để báo đạt khóa/transaction. Bàn giao cách migration/run, endpoint và bằng chứng.

Bàn giao tối đa 6 dòng theo QUY_TAC_AI: mã việc/trạng thái; nhánh/BASE SHA/commit/PR; file/kết quả; lệnh kiểm thử/bằng chứng; lỗi/chưa kiểm chứng; việc tiếp theo. Không kể suy luận dài, không báo DONE khi kiểm thử bắt buộc chưa đạt.

