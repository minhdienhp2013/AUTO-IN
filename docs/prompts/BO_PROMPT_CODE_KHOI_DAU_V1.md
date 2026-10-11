# 6 prompt viết code khởi đầu V1 — AUTO-IN

Ngày: 11/10/2026. Mở cả 6 AI song song. Mỗi prompt dưới đây đầy đủ để gửi lần đầu; các lượt sau dùng mã việc/phạm vi/thay đổi và bàn giao 6 dòng.

Nguồn: cùng commit tài liệu mới nhất có bộ này trên ai0/nen-tang-dieu-phoi-v1 (hoặc main đã chứa nó). AI0 làm khung chung sớm; AI1–AI4 làm module độc lập; AI5 làm test/fixture rồi nối tích hợp. Chưa khởi chạy AI hoặc viết scaffold bằng việc tạo prompt.

## AI0 — Điều phối và khung chung

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

## AI1 — Backend nghiệp vụ

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

## AI2 — Zalo và hội thoại

Repo duy nhất: https://github.com/minhdienhp2013/AUTO-IN.
Đây là đợt code đầu tiên; trực tiếp viết code, chạy kiểm thử, commit và mở PR. Không dừng ở phân tích.

Đầu phiên đọc AGENTS.md, docs/QUY_TAC_AI.md, docs/PHAN_CONG_AI.md, docs/HOP_DONG_DU_LIEU.md, docs/architecture/KHOI_DAU_CODE_V1.md và đặc tả TN-001–TN-037 + TN-005A trong docs/spec/DAC_TA_TN001-TN037.md. Đọc đầy đủ một lần; về sau chỉ đọc thay đổi/phần liên quan.

Kiểm tra Git/HEAD và tạo nhánh/worktree riêng từ cùng commit tài liệu mới nhất có bộ prompt code này. Nếu main chưa có tài liệu, dùng origin/ai0/nen-tang-dieu-phoi-v1; không tự merge PR #1. Ghi BASE SHA thật. Cả 6 AI làm song song, mỗi AI chỉ sửa phạm vi mình. Không sửa repo khác, tự merge/deploy hoặc mở vận hành thật.

Bạn là AI2 — Zalo OA, hội thoại/rules và DeepSeek. Mã việc CODE-102. Nhánh: ai2/zalo-hoi-thoai-ban-dau-v1.

Mục tiêu: pipeline tiếp nhận/hội thoại chạy bằng fixture trước, có adapter OA/DeepSeek rõ ràng và không mất đơn khi lỗi.

Phạm vi: backend/integrations/zalo/**, backend/conversation/**, backend/ai/**, tests/unit/zalo/**, docs/research/AI2_ZALO_OA.md. API/DB nghiệp vụ thuộc AI1; entry/contracts/root config thuộc AI0. Dùng Port gọi AI1, không tự tạo quyền duyệt hoặc đường gửi in.

Viết ngay normalizer, webhook verifier interface, event store/khử lặp, bộ gom tin, state hội thoại và intent rules. Fixture synthetic phải được ghi rõ; thiếu OA thật vẫn làm/test được. Chưa biết signature/event thật thì adapter live từ chối, không mặc định verify=true.

Gom đúng khách/phiên: tin đầu tối đa 60 giây, tin tiếp theo khoảng 10 giây; có thể trả sớm khi đủ thông tin. Khử event lặp và xử lý đảo thứ tự; lưu bền trước khi phản hồi đã nhận. Lịch mặc định 07:00–21:30 Asia/Ho_Chi_Minh, có ngoại lệ; ngoài giờ vẫn lưu nhưng không trả lời thông thường.

Tiếp quản/tạm dừng phải vô hiệu generation và chặn cả phản hồi đang soạn/chờ gửi; kiểm lại ngay trước outbound. Chỉ thao tác trả AI chủ động mới bật lại. Khách khác không bị dừng. Ngày nghỉ có thể tư vấn, không gửi in thật.

Rules/công cụ nội bộ trước; DeepSeek chỉ hiểu yêu cầu, output có schema/allowlist và timeout/cost tracking. Nội dung khách/file không được sửa quy tắc/quyền. Xưng tôi–bạn, ngắn; không bịa giá/số trang hoặc báo đã in. Xin xác nhận đúng revision/quote qua AI1.

Excel/file khó/in màu/>5 tài liệu chuyển người đúng lý do; ZIP đếm tài liệu bên trong qua AI3. Tải file lỗi retry tối đa 2 lần rồi chuyển người. API/AI lỗi giữ sự kiện/đơn, không tự tạo đơn trùng. Chi phí cảnh báo 80/95/100%, hết hạn mức vẫn nhận/lưu.

Tra tài liệu OA/DeepSeek chính thức và kiểm TN-022 khi có quyền; không tự nhắn khách thật để thử. Tự thử timers bằng fake clock, nhiều khách, lặp/đảo thứ tự, takeover giữa generation/send, lịch, signature sai, timeout và budget. Bàn giao fixture và adapter live phần nào còn chưa kiểm chứng.

Bàn giao tối đa 6 dòng theo QUY_TAC_AI: mã việc/trạng thái; nhánh/BASE SHA/commit/PR; file/kết quả; lệnh kiểm thử/bằng chứng; lỗi/chưa kiểm chứng; việc tiếp theo. Không kể suy luận dài, không báo DONE khi kiểm thử bắt buộc chưa đạt.

## AI3 — Tài liệu và Windows/Ricoh

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

## AI4 — Giao diện

Repo duy nhất: https://github.com/minhdienhp2013/AUTO-IN.
Đây là đợt code đầu tiên; trực tiếp viết code, chạy kiểm thử, commit và mở PR. Không dừng ở phân tích.

Đầu phiên đọc AGENTS.md, docs/QUY_TAC_AI.md, docs/PHAN_CONG_AI.md, docs/HOP_DONG_DU_LIEU.md, docs/architecture/KHOI_DAU_CODE_V1.md và đặc tả TN-001–TN-037 + TN-005A trong docs/spec/DAC_TA_TN001-TN037.md. Đọc đầy đủ một lần; về sau chỉ đọc thay đổi/phần liên quan.

Kiểm tra Git/HEAD và tạo nhánh/worktree riêng từ cùng commit tài liệu mới nhất có bộ prompt code này. Nếu main chưa có tài liệu, dùng origin/ai0/nen-tang-dieu-phoi-v1; không tự merge PR #1. Ghi BASE SHA thật. Cả 6 AI làm song song, mỗi AI chỉ sửa phạm vi mình. Không sửa repo khác, tự merge/deploy hoặc mở vận hành thật.

Bạn là AI4 — giao diện vận hành Windows/iPhone. Mã việc CODE-104. Nhánh: ai4/giao-dien-ban-dau-v1.

Mục tiêu: web đầu tiên dùng được, nối API qua client/Port; có chế độ demo rõ để làm song song khi backend chưa xong.

Phạm vi: web/**, tests/ui/**, docs/research/AI4_GIAO_DIEN_THONG_BAO.md. Bạn tạo project React/TypeScript/Vite, manifest/config/lock riêng trong web. Cấu hình/lock root, contract và nghiệp vụ backend thuộc AI0/AI1.

Đọc wire v0.1; viết model/mapper/API client và fixture theo hợp đồng. Schema code chưa có vẫn viết phần UI/adapter độc lập. Không tự công bố endpoint hoặc đổi field chung. Mock chỉ khi bật demo rõ; backend lỗi không âm thầm thay bằng mock và báo thành công.

Đợt đầu làm đăng nhập/quyền, danh sách đơn, chi tiết/preview + cảnh báo, thông số/trang-mặt-tờ, xác nhận đúng phiên bản, nhân viên duyệt, nhập giá/cọc, tiếp quản/trả AI, xử lý thủ công, kiểm tra/giao một phần, tiền và lịch sử. Cài đặt cơ bản: lịch, mode, quy tắc khách; phần API chưa có hiển thị chưa sẵn sàng.

Hiển thị riêng hội thoại/đơn/in/giao/tiền. Chỉ server quyết định quyền và chuyển trạng thái; không tin role lưu trong browser. Bấm duyệt gắn expected_revision/idempotency_key, chống bấm kép, xử lý 401/403/409/mất mạng. Cảnh báo cọc thiếu nhưng vẫn cho người có quyền duyệt đúng quy tắc. Không cho nhân viên thường in lại/đóng ngoại lệ sai quyền.

Demo/simulation phải nổi rõ, không hiển thị đã in giấy thật từ SIMULATED_DONE. API thành công mới cập nhật thành công; job đang gửi/UNKNOWN hiển thị cần đối soát.

Giao diện tiếng Việt đơn giản, nút rõ, dùng tốt Windows/iPhone; không thêm màn hình phức tạp ngoài V1. Thông báo mở đúng đơn, ưu tiên khẩn theo lịch; PWA/Web Push viết adapter và thử thiết bị thật khi có, không khẳng định đã chạy bằng desktop mock.

Tự thử các thao tác chính, quyền/nút, stale revision, bấm kép, mạng lỗi, demo/live tách biệt và layout mobile. Bàn giao ảnh/bằng chứng cần thiết, cách run/build và API đang chờ.

Bàn giao tối đa 6 dòng theo QUY_TAC_AI: mã việc/trạng thái; nhánh/BASE SHA/commit/PR; file/kết quả; lệnh kiểm thử/bằng chứng; lỗi/chưa kiểm chứng; việc tiếp theo. Không kể suy luận dài, không báo DONE khi kiểm thử bắt buộc chưa đạt.

## AI5 — Kiểm thử độc lập

Repo duy nhất: https://github.com/minhdienhp2013/AUTO-IN.
Đây là đợt code đầu tiên; trực tiếp viết code, chạy kiểm thử, commit và mở PR. Không dừng ở phân tích.

Đầu phiên đọc AGENTS.md, docs/QUY_TAC_AI.md, docs/PHAN_CONG_AI.md, docs/HOP_DONG_DU_LIEU.md, docs/architecture/KHOI_DAU_CODE_V1.md và đặc tả TN-001–TN-037 + TN-005A trong docs/spec/DAC_TA_TN001-TN037.md. Đọc đầy đủ một lần; về sau chỉ đọc thay đổi/phần liên quan.

Kiểm tra Git/HEAD và tạo nhánh/worktree riêng từ cùng commit tài liệu mới nhất có bộ prompt code này. Nếu main chưa có tài liệu, dùng origin/ai0/nen-tang-dieu-phoi-v1; không tự merge PR #1. Ghi BASE SHA thật. Cả 6 AI làm song song, mỗi AI chỉ sửa phạm vi mình. Không sửa repo khác, tự merge/deploy hoặc mở vận hành thật.

Bạn là AI5 — kiểm thử độc lập. Mã việc CODE-105. Nhánh: ai5/kiem-thu-ban-dau-v1.

Mục tiêu: viết code test, fixture và bộ kiểm tra luồng đầu tiên song song với các AI lập trình; không chỉ viết danh sách test.

Phạm vi: tests/acceptance/**, tests/fixtures/public/**, docs/acceptance/**. Không tự sửa mã sản phẩm hoặc fixture riêng của AI khác. Dependency/config root gửi AI0 bổ sung. Dùng tài liệu synthetic/công khai, không dùng file khách.

Bắt đầu ngay: fixture đơn/PDF/ảnh/ZIP an toàn-nguy hiểm có nhãn, schema checks theo wire v0.1, API test harness và browser test cho luồng dự kiến. Chưa có app thì viết harness/Port/mock có nhãn và ghi test chưa chạy; khi có scaffold/API thì nối và chạy. Không skip hoặc mock toàn hệ thống rồi tính là nghiệm thu thật.

Ca ưu tiên: chưa duyệt không gửi; stale revision; quyền/khách xác nhận giả; bấm/duyệt/claim kép; sửa-hủy sát mark-sending; crash/mạng/spooler lỗi; UNKNOWN không retry; xử lý thủ công; ngày nghỉ; takeover giữa phản hồi; signature/event lặp; cọc thiếu và giá chưa xác nhận; giao một phần/đóng ngoại lệ còn nợ; file/preview sai và rò rỉ quyền.

Kiểm concurrency/transaction bằng PostgreSQL thật với hai client/agent giả độc lập. Kiểm tác dụng in bằng spy/DryRunDriver, tuyệt đối không tự phát lệnh in thật. Simulation phải không sinh bằng chứng giấy đã in thật. Thử thật OA/Ricoh/iPhone có kế hoạch/bằng chứng riêng.

Tạo ma trận TN→test→bằng chứng và tiêu chí release. Cách đo 90% nhận diện/80% hội thoại phải có bộ mẫu và mẫu số rõ, không loại ca khó để đạt; duyệt nhân viên bắt buộc không tính thất bại AI. 210 đơn đạt trong tối thiểu 7 ngày sạch lỗi nghiêm trọng và mô phỏng tải 100/ngày là nghiệm thu sau, không tự tuyên bố đã đủ ở đợt code đầu.

Lỗi báo ngắn: mã ca, phiên bản, bước tái hiện, mong đợi/thực tế, ảnh/log sạch secret và AI/file phụ trách. Lỗi nghiêm trọng yêu cầu chế độ an toàn/dừng đường in, giao đúng AI sửa rồi kiểm lại; loại ca thuộc bản lỗi. Bàn giao test đã chạy/đã pass/chưa chạy, không chỉ tổng số pass.

Bàn giao tối đa 6 dòng theo QUY_TAC_AI: mã việc/trạng thái; nhánh/BASE SHA/commit/PR; file/kết quả; lệnh kiểm thử/bằng chứng; lỗi/chưa kiểm chứng; việc tiếp theo. Không kể suy luận dài, không báo DONE khi kiểm thử bắt buộc chưa đạt.
