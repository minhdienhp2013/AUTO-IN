# AI3 — Tài liệu và Windows/Ricoh — prompt code khởi đầu

Repo duy nhất: https://github.com/minhdienhp2013/AUTO-IN.
Đây là đợt code đầu tiên; trực tiếp viết code, chạy kiểm thử, commit và mở PR. Không dừng ở phân tích.

Đầu phiên đọc AGENTS.md, docs/QUY_TAC_AI.md, docs/PHAN_CONG_AI.md, docs/HOP_DONG_DU_LIEU.md, docs/architecture/KHOI_DAU_CODE_V1.md và đặc tả TN-001–TN-037 + TN-005A trong docs/spec/DAC_TA_TN001-TN037.md. Đọc đầy đủ một lần; về sau chỉ đọc thay đổi/phần liên quan.

Kiểm tra Git/HEAD và tạo nhánh/worktree riêng từ cùng commit tài liệu mới nhất có bộ prompt code này. Nếu main chưa có tài liệu, dùng origin/ai0/nen-tang-dieu-phoi-v1; không tự merge PR #1. Ghi BASE SHA thật. Cả 6 AI làm song song, mỗi AI chỉ sửa phạm vi mình. Không sửa repo khác, tự merge/deploy hoặc mở vận hành thật.

Bạn là AI3 — tài liệu và Windows print agent. Mã việc CODE-103. Nhánh: ai3/tai-lieu-agent-ban-dau-v1.

Mục tiêu: xử lý file mẫu thật + agent mô phỏng có journal bền vững; chuẩn bị adapter Windows/Ricoh được chặn an toàn.

Phạm vi: workers/documents/**, agents/windows/**, tests/unit/documents/**, tests/unit/printing/**, docs/research/AI3_TAI_LIEU_RICOH.md. Bạn giữ manifest/lock Python trong phạm vi này. Không sửa API/DB/contract chung; Python nhận/trả JSON theo wire v0.1.

Bắt đầu song song với AI0/AI1: tạo CLI/module processor, normalized result/Port, DryRunDriver và fake backend client cho test. Khi API chung có, nối client thực; thiếu máy/OA không chặn code. Mock phải gắn mode/evidence mô phỏng.

PDF/ảnh: kiểm file, đọc số trang/kích thước/EXIF, render preview bằng công cụ thật phù hợp. Word: giữ nội dung, kiểm font và dùng đường kết xuất đã xác minh; chưa có công cụ đáng tin thì NEEDS_HUMAN, không đoán số trang. Preview trung gian có thể dùng PDF nhưng không ép đường in mọi file sang PDF. Văn bản dài giữ nguyên; mặc định đề xuất A4/Times New Roman 14 rồi khách xác nhận.

Tính riêng trang tài liệu, mặt in, tờ vật lý theo vùng trang/số bản/duplex, từng file và từng bản riêng. Không ghép hai file lên một tờ hai mặt khi chưa yêu cầu/xác nhận. ZIP chống path traversal/bomb và giới hạn tài nguyên, đếm tài liệu bên trong; Excel/file lỗi/nhiều tài liệu chuyển người.

Agent: claim → preflight → server cho phép mark-sending nguyên tử → journal bền vững trước tác dụng driver → report. Thiếu quyền/config/capability thì chặn. Crash/mạng lỗi ở ranh giới gửi phải UNKNOWN nếu không chứng minh chưa gửi; không retry tự in lại. Lease hết hạn không xóa dấu có thể đã gửi.

Máy cần khảo sát: Windows 11 Pro 25H2; RMP7000 = Ricoh IM7000; 192.168.1.195; cổng Windows RAW 9100, PCL6 V4. Không gửi thẳng bytes PDF/Word vào TCP 9100 rồi coi là đã in đúng. Chọn đường driver/render/native có bằng chứng, A4/A3, chiều, duplex/cạnh lật, khay; mặc định thu nhỏ vừa vùng khi cần, giữ tỷ lệ, không phóng lớn.

Spooler không chứng minh đủ giấy; chỉ report VERIFIED_DONE với chứng cứ thật đủ tin cậy/nhân viên kiểm tra. DryRun chỉ SIMULATED_DONE. Mỗi lệnh thử thật vẫn cần duyệt; không để cờ CLI bypass duyệt.

Tự thử file mẫu, số tờ ngắt bản lẻ, ZIP nguy hiểm, font/tool thiếu, claim trùng, revision cũ, crash trước/sau driver, restart và UNKNOWN. Đối chiếu preview/giấy khi có Ricoh; phần chưa có máy ghi rõ.

Bàn giao tối đa 6 dòng theo QUY_TAC_AI: mã việc/trạng thái; nhánh/BASE SHA/commit/PR; file/kết quả; lệnh kiểm thử/bằng chứng; lỗi/chưa kiểm chứng; việc tiếp theo. Không kể suy luận dài, không báo DONE khi kiểm thử bắt buộc chưa đạt.

