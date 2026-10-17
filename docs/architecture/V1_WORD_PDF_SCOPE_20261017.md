# Phạm vi V1 ưu tiên Word/PDF và Phase 2

**Ngày điều phối:** 17/10/2026. **Candidate nền kiểm tra:** PR #144, SHA `0673460af71205986b901a21fc7724dbea23c991`; nhánh `ai0/tn005-trigger-dispatch-pg-20261017`. **Main hiện hành:** `cb2be7a7b84d689dbe6c2c773192f111897c4063`.

Tài liệu này ghi nhận hướng ưu tiên mới của chủ dự án. Nó không sửa hay thay thế các quyết định TN đã chốt. Mục tiêu tuần tới là hoàn thành **ứng viên mã V1 Word/PDF** để chủ xem xét; tài liệu này không tuyên bố phần mềm đã sẵn sàng mở vận hành thật. Nguồn TN gốc vẫn là [đặc tả TN-001–TN-037 và TN-005A](../spec/DAC_TA_TN001-TN037.md).

## 1. Mục tiêu và ranh giới V1

V1 tự động hóa Word/PDF theo luồng: nhận và lưu file → thu thập yêu cầu in đã rõ → kiểm tra/preflight và tạo preview → khách xác nhận đúng phiên bản → nhân viên hợp lệ duyệt → agent gửi tối đa một lần tới máy đã chọn → ghi nhận ACK/lỗi/kết quả và đối soát giấy.

- Tiếp nhận và giữ đơn/file ngay; không chờ AI để mở đơn. Áp dụng đúng quy tắc gom tin, giờ hoạt động, ngày nghỉ và tiếp tục sau giờ theo TN-003, TN-028, TN-035 cùng TN liên quan. Không thêm một khoảng chờ mới làm mất hoặc trì hoãn file.
- Tự động xử lý trong V1 chỉ gồm Word/PDF đã qua bộ xử lý tương ứng. PDF được render/preflight bằng đường PDF. Word phải dùng đường Word native trên Windows đã kiểm chứng; không lấy DOCX đổi thành PDF làm đầu vào lệnh in.
- Preflight phải ràng buộc file nguồn, revision, yêu cầu và thông số in; kiểm số trang/mặt/tờ, A4/A3, chiều giấy, số bản, một/hai mặt, lật cạnh, vùng in và preview. Nếu file/font/bố cục/preview hoặc capability máy không đáng tin thì giữ đơn và chuyển nhân viên.
- Khách xác nhận và nhân viên duyệt cùng phiên bản hiện hành. Bất kỳ file, revision, quote hoặc thông số in nào đổi đều làm mất hiệu lực xác nhận/duyệt cũ theo hợp đồng phù hợp.
- Agent/server kiểm lại quyền, revision, nguồn, manifest, preview, plan và máy đích sát lúc gửi. Lệnh có idempotency; ACK mơ hồ/lỗi mạng sau ranh giới gửi thành UNKNOWN và chờ đối soát, không tự gửi lại.
- Ưu tiên Ricoh IM7000/RMP7000 đen trắng theo TN-009, TN-023, TN-029. Máy/queue/capability phải lấy từ cấu hình đã kiểm chứng, không dùng máy mặc định. Yêu cầu màu chuyển nhân viên, không âm thầm đổi thành đen trắng.
- JEV/DeepSeek chỉ có thể gợi ý; lỗi AI/mạng không được làm mất đơn hay chặn đường nhập và xử lý thủ công.
- Nếu TN-004 yêu cầu tiếp nhận ảnh, vẫn nhận và lưu ảnh; V1 chỉ phân tuyến theo định dạng/yêu cầu tường minh và đưa vào hàng chờ nhân viên. Không OCR, nhận diện nội dung ảnh, chỉnh ảnh, dàn CCCD, điền TEMhoa hoặc tự động in màu.
- Excel, ZIP và loại khác giữ nguyên TN hiện hành: Excel/định dạng chưa hỗ trợ chuyển người; ZIP phải đếm tài liệu thật bên trong và đơn trên 5 tài liệu cần người kiểm tra. Không tự thêm bộ xử lý.
- File gốc, order và thông tin cần thiết được giữ theo TN-011. Không xóa dữ liệu khi chưa có trạng thái đóng đơn có thẩm quyền, legal hold, backup và đồ thị tham chiếu được chốt an toàn.

## 2. Phase 2

Các mục sau không phải tiêu chí để làm chậm luồng Word/PDF V1; chỉ mở sau khi lõi V1 ổn định và có phạm vi/acceptance riêng:

1. OCR, nhận dạng nội dung/loại tài liệu từ ảnh hoặc nhiều trang; benchmark OCR đa dạng (PR #149).
2. Chỉnh phối cảnh, crop, làm nét, sửa hướng và tái tạo ảnh chụp văn bản.
3. Nhận diện/dàn trang CCCD, các giấy tờ tùy thân và kiểm soát kích thước mặt trước/mặt sau.
4. Nhận dạng chữ, tự điền, tích hợp phần mềm và tự động tạo/in TEMhoa.
5. Tách trang màu/đen trắng tự động, chọn Canon hoặc điều khiển in màu.
6. Tự động hóa Excel, ZIP phức tạp và các định dạng chưa được xác minh.
7. Tự động phân loại nội dung theo ngành/tài liệu, học theo dữ liệu và phụ thuộc vào LLM.

Việc kiểm chứng Zalo OA có quyền thật, Windows/Ricoh thật, iPhone Safari/Web Push và mở vận hành vẫn là **cổng kiểm chứng vận hành**, không được coi là đã xong vì CI mô phỏng xanh.

## 3. Những gì đã có, đang làm và còn thiếu

| Mảng | Đã có bằng chứng trên repo/candidate | Còn thiếu để đạt phạm vi mới |
| --- | --- | --- |
| Core đơn, revision, xác nhận, duyệt | Core có transaction PostgreSQL, revision/hash, xác nhận khách, quyền nhân viên, idempotency, khóa trước khi gửi và hàng rào tin/file chưa đối soát. Publish plan tạo revision mới; khách phải xác nhận lại revision đó. | Chốt cùng AI0/AI3 cách lưu và kiểm tra trực tiếp source SHA, settings digest, manifest/preview digest xuyên suốt xác nhận → duyệt → claim/preflight → agent. Kiểm thử mọi thay đổi file/thông số làm stale; không tạo job thứ hai sau retry/UNKNOWN. |
| Zalo và thu yêu cầu | Có ingress/quarantine, gom đơn và giờ lịch, callback/confirmation candidate cùng các test mô phỏng. PR #145 bổ sung rà tài liệu nút/callback chính thức. | Không có bằng chứng OA thật, chữ ký callback/golden vector và tải file từ OA thật. Hoàn thiện route theo loại file và lời khách, giữ chính sách gom tin/giờ hoạt động; không để AI/DeepSeek là điều kiện nhận Word/PDF. |
| PDF và Word native | PDF có đường đọc/render/preview và kiểm tra hash ở worker. Processor hiện giữ DOCX ở NEEDS_HUMAN với lý do WORD_RENDER_PATH_NOT_VERIFIED. PR #116 chỉ kiểm tra tĩnh registry/dependency; không khởi chạy COM, không render. | Word native preflight/preview/page count và đối chiếu font/layout trên Windows trung tâm; luồng PDF/Word qua backend thật theo contract; xác minh khổ/chiều/duplex/khay và chuẩn bị ca thử được chủ giám sát. |
| Windows agent/Ricoh | Agent có journal bền, simulation, UNKNOWN và cấm resend; test spooler chỉ dùng InMemorySpooler giả. GuardedWindowsDriver cố ý fail-closed. | Chưa có adapter Windows/Ricoh production được kiểm chứng. Cần server/agent binding nguồn và plan, lấy queue/capability thật, ghi ACK/lỗi, đối soát giấy; lệnh in thật chỉ chạy sau chủ duyệt riêng. |
| Giao diện và hàng chờ | UI có read model, trạng thái order/in, preview cho nhân viên, khóa duyệt khi thiếu bằng chứng, xác minh giấy và nhóm attention/needs_human. | Chưa có bằng chứng end-to-end rằng ảnh/CCCD/TEMhoa/format chưa hỗ trợ tạo hàng chờ có nhãn/lý do và nhân viên tiếp nhận được; cần thể hiện rõ “đã nhận, chuyển nhân viên, chưa tự xử lý”. |
| Acceptance | PR #143/#144 có nghiệm thu AI5 cho synthetic TN005 dispatch và LOAD100 trên đúng candidate. PR #144 có CODE checks và composition jobs SUCCESS; unified job kiểm SHA chính xác `0673460af71205986b901a21fc7724dbea23c991`. | Chưa có acceptance Word/PDF native, customer confirmation → staff approval → agent, retry/ACK mơ hồ và handoff ảnh trên candidate tích hợp mới. |
| Vận hành thật | Chưa có bằng chứng gửi OA thật, Windows/Ricoh thật, giấy thực tế, Safari iPhone hoặc 210 đơn sạch/7 ngày. | Chuẩn bị checklist; chỉ làm sau khi chủ cửa hàng duyệt rõ account/OA/máy, một mã đơn, revision/hash, số bản/tờ và người đứng máy. |

## 4. Trạng thái PR liên quan khi kiểm tra ngày 17/10/2026

- **main:** `cb2be7a7b84d689dbe6c2c773192f111897c4063`.
- **PR #143:** Draft, HEAD `244ba4144a7a304e0a03c5122cdcfa1813e90d06`; AI5 PASS trong phạm vi mô phỏng TN005/LOAD100. Không phải nghiệm thu Word/PDF hay thiết bị thật.
- **PR #144:** Draft, HEAD `0673460af71205986b901a21fc7724dbea23c991`, base #143 HEAD. Chỉ đổi composition test/workflow. CODE checks và composition đều SUCCESS; test đầu-cuối đang dùng sender tổng hợp, không có OA/Windows/Ricoh thật.
- **PR #145 AI2:** tài liệu nút/callback Zalo; không đổi sender/provider. OA thật/callback ký số vẫn BLOCKED.
- **PR #146 AI3:** kiểm kê TN-011 chỉ đọc; không có cleanup runtime hay xóa dữ liệu.
- **PR #147 AI4:** thêm harness WebKit/notification, không đổi product UI; WebKit runtime NOT RUN và không có iPhone thật.
- **PR #148 AI1:** đề xuất hợp đồng retention/closure, không có code/schema/migration/delete. Kết luận hiện tại: chưa có terminal event hợp lệ để chạy xóa tự động.
- **PR #149 AI5:** benchmark OCR tổng hợp thuộc Phase 2; HEAD mới nhất quan sát `6b34a4639988f893b22f8f1f198ccb634b4be6c1`, Actions đang chạy tại thời điểm rà soát. Không đưa vào V1 acceptance.
- **PR #116 AI3:** kiểm tra tĩnh Word trên Windows, không phải native render hoặc in. Khi chuyển AI3 sang V1 native work, không tiếp tục sửa nhánh #116 đồng thời; tạo nhánh mới trên candidate dưới đây và ghi rõ nếu thay thế phạm vi của #116.

Không PR nào được merge/deploy trong lượt này.

## 5. Đối chiếu TN và nội dung cần chủ duyệt

| TN | Đối chiếu với ưu tiên mới |
| --- | --- |
| TN-003, TN-028, TN-035 | Giữ giờ trả lời/giờ nghỉ, vẫn nhận và lưu tin/file ngoài giờ; chỉ tiếp tục lệnh đủ điều kiện và chắc chắn chưa gửi. |
| TN-004 | Tiếp nhận PDF/Word/ảnh; Excel giao người; ZIP đếm file tài liệu; trên 5 tài liệu cần người. Ảnh trong V1 được nhận nhưng chỉ chuyển nhân viên, không tự xử lý. |
| TN-005, TN-005A | **Xung đột phạm vi cần ghi thành quyết định:** TN-005 nói tới nhận diện bài tập/ảnh và nhu cầu màu/đen trắng; hướng mới giới hạn theo định dạng và yêu cầu tường minh, không nhận diện nội dung/ảnh hay phụ thuộc DeepSeek cho luồng cốt lõi. Đề xuất chủ duyệt sửa TN-005 thành: “Trong phạm vi V1, chỉ phân tuyến theo định dạng tệp và yêu cầu khách chọn/nói rõ; không OCR/nhận dạng nội dung ảnh, không tự phân trang màu/đen trắng. Word/PDF đủ preflight đi theo luồng đen trắng; ảnh, yêu cầu màu, CCCD/TEMhoa, loại khác hoặc không chắc chắn chuyển nhân viên. Các khả năng nhận dạng nội dung và tự động hóa màu chuyển Phase 2.” Chưa sửa file đặc tả TN. |
| TN-007, TN-017 | Giữ khách xác nhận trước, nhân viên hợp lệ duyệt đúng revision trước khi in; mọi nhân viên hợp lệ được duyệt theo quyền. Chỉ chủ duyệt in lại. Ràng buộc hash file/thông số là yêu cầu an toàn bổ sung, không được bỏ các cổng đã chốt. |
| TN-009, TN-023, TN-029 | Dùng Windows trung tâm và Ricoh IM7000/RMP7000 đen trắng; giữ A4/A3, hướng, khổ, lật cạnh, số bản; thử driver/khay thật trước kết luận. Hồ sơ cấu hình chưa thay thế kiểm tra máy đang kết nối. |
| TN-011 | Giữ hạn lưu 30 ngày sau khi hoàn tất/đóng hợp lệ. PR #148/#146 phát hiện chưa có terminal event đủ thẩm quyền. Không tự xóa; AI0 cần chốt hợp đồng closure trước khi làm retention worker. |
| TN-012 | File tải có giới hạn retry theo TN rồi chuyển người; lỗi AI/mạng giữ đơn. Chỉ tiếp tục tác vụ đã duyệt và chắc chắn chưa gửi; tác vụ đã gửi/ACK mơ hồ không tự gửi lại. |
| TN-016, TN-022, TN-037 | TN-016 yêu cầu đầu-cuối tới in/giao; TN-022 yêu cầu kiểm chứng OA thật; TN-037 giữ ngưỡng nhận diện ≥90%, hội thoại ≥80%, 210 đơn sạch trong ≥7 ngày và tải mô phỏng 100/ngày. Đây là cổng nghiệm thu/mở vận hành, không thể tuyên bố PASS bằng candidate mô phỏng. Ưu tiên mới có thể hoàn tất **ứng viên Word/PDF** trước; nếu chủ muốn miễn/đổi ngưỡng TN-037 cho một đợt chạy giới hạn, cần chủ duyệt văn bản sửa TN và mẫu số mới. Không tự xóa cổng này khỏi đặc tả. |
| TN-034 | Giữ định dạng gốc và bộ xử lý tương ứng. DOCX phải in từ Word/native path; preview không làm đầu vào thay thế cho file Word. Lỗi font/layout/preview không chắc chắn chuyển nhân viên. |

**Điểm cần chủ quyết định:** có duyệt nội dung đề xuất sửa TN-005 ở trên và giữ TN-037 là cổng mở vận hành thật sau khi ứng viên mã hoàn tất hay muốn ban hành một gate riêng cho pilot Word/PDF? Cho đến khi có quyết định, tài liệu TN không đổi và V1 không được gọi là đã mở vận hành thật.

## 6. Phân công mới trên cùng candidate

Base chung: PR #144 HEAD `0673460af71205986b901a21fc7724dbea23c991`, nhánh `ai0/tn005-trigger-dispatch-pg-20261017`. Mỗi AI tạo branch riêng; không sửa chéo phạm vi. Đây là prompt để chủ gửi vào từng phiên AI chuyên môn, theo quy tắc repo; comment PR không tự chạy AI.

| AI / branch đề xuất | Việc cần làm và phạm vi file | Lệnh kiểm tra/điều kiện bàn giao |
| --- | --- | --- |
| AI0 / `ai0/v1-word-pdf-scope-20261017` | Chốt contract tạm Core↔processor↔agent với AI1/AI3: order, revision, request hash, source SHA list, settings/content digest, manifest/preview digest, approval và idempotency key. Nối module sau khi các AI bàn giao; không sửa file sở hữu AI1–AI5. | Trên candidate tích hợp mới: `npm run check`; Python compile/pytest; web build/Chromium; acceptance AI5 đúng SHA. Báo từng mock/simulated/live. |
| AI1 / `ai1/v1-core-print-binding-20261017` | **[AI1][V1-CORE-01]** Rà và hoàn tất contract Core ràng buộc xác nhận/duyệt/job với file hash và thông số in hiện hành; thay đổi nào cũng stale xác nhận cũ; chống job trùng/retry/UNKNOWN. Chỉ sửa backend/core/**, backend/api/**, backend/storage/**, backend/jobs/**, tests/unit/core/**, tests/integration/core/**. Không sửa retention theo PR #148 trong nhiệm vụ này. Chờ AI0 chốt schema chung trước khi đổi wire. | `npm run test:core`, `npm run test:composition`; thêm PostgreSQL ca stale file/settings, khách sai đơn, sửa revision, race duyệt hai lần, ACK mơ hồ. Bàn giao branch/base/HEAD, ca và lệnh. |
| AI2 / `ai2/v1-file-intake-routing-20261017` | **[AI2][V1-ZALO-01]** Hoàn thiện inbound Word/PDF và route ảnh/Excel/ZIP/không hỗ trợ sang hàng chờ người; giữ batching/giờ TN, chống webhook lặp, đúng shop/OA/customer/conversation, không tự xác nhận hoặc tự duyệt. Chỉ sửa backend/integrations/zalo/**, backend/conversation/**, backend/ai/**, tests/unit/zalo/**. Không gửi OA thật; không sửa docs/research/AI2_ZALO_OA.md đang thuộc PR #145. | `npm run test:zalo`; thêm synthetic tests ngoài giờ, file lặp, định dạng ảnh/không rõ, nhiều hơn 5 file, chuyển người và lỗi tải. Ghi OA thật NOT RUN. |
| AI3 / `ai3/v1-native-word-pdf-agent-20261017` | **[AI3][V1-NATIVE-01]** Làm native Word/PDF preflight, preview, số trang/tờ và thông số Windows; mở DOCX bằng Word native, in từ bản gốc, không ép DOCX→PDF làm đầu vào. Tạo đường agent/Ricoh fail-closed khi thiếu evidence; chuẩn bị runbook cho ca Windows/Ricoh do chủ đứng máy duyệt. Chỉ sửa workers/documents/**, agents/windows/**, tests/unit/documents/**, tests/unit/printing/** và file runbook mới trong docs/research/. Không gọi driver thật/in giấy. Không sửa nhánh PR #116 đồng thời; báo nếu branch mới thay thế PR #116. | `python -m compileall -q workers/documents agents/windows tests/unit/documents tests/unit/printing`; `python -m pytest -q tests/unit/documents tests/unit/printing`. Ghi rõ Windows COM/render/Ricoh thật NOT RUN nếu thiếu host/approval. |
| AI4 / `ai4/v1-manual-routing-queue-20261017` | **[AI4][V1-QUEUE-01]** Làm UI hiển thị tình trạng Word/PDF, preview/version, lỗi/UNKNOWN, và hàng chờ gắn nhãn “đã nhận—chờ nhân viên” cho ảnh/CCCD/TEMhoa/màu/định dạng chưa hỗ trợ. Không báo đã xử lý/in; giữ quyền nhân viên và hiển thị đúng trạng thái server. Chỉ sửa web/src/** và tạo tests/ui/v1-word-pdf-routing.test.ts. Không sửa web/package.json hiện có trong PR #147. | `cd web && npm ci && npm test && npm run typecheck && VITE_DEMO_MODE=false npm run build && npm run test:chromium:code008`. Bàn giao screenshot/test output và giới hạn browser thật. |
| AI5 / `ai5/v1-word-pdf-acceptance-20261017` | **[AI5][V1-ACCEPTANCE-01]** Không tiếp tục OCR benchmark như điều kiện V1; giữ PR #149 Draft/Phase 2. Tạo ma trận độc lập và tests trong docs/acceptance/V1_WORD_PDF_ACCEPTANCE_20261017.md, tests/acceptance/v1-word-pdf/**, tests/fixtures/public/v1-word-pdf/**; không sửa sản phẩm. Trước hết chuẩn bị ca, sau khi AI0 tích hợp thì chạy đúng candidate SHA và review artifact/hash. | Chạy candidate integration `npm run check`, Python compile/pytest, UI Chromium và bộ V1 mới. Ít nhất cover source/settings changed, stale confirmation, staff role, duplicate submit, UNKNOWN no retry, lỗi AI/mạng giữ đơn, ảnh chuyển người, không tạo print job. Không dùng CI của PR riêng làm bằng chứng thay candidate. |

Các lệnh trên là lệnh repo hiện có tại base candidate. AI phải bổ sung ca kiểm thử mới theo hợp đồng đã được AI0 chốt; không báo PASS chỉ từ unit test không chạy trên candidate tích hợp.

## 7. Phụ thuộc, rủi ro và cổng kiểm chứng

- **Hợp đồng chung:** AI1 và AI3 cùng chạm ranh giới hash/manifest/plan/agent. AI0 phải chốt tuple dữ liệu trước khi tích hợp; không tự thêm field hoặc thay tên API lẫn nhau.
- **OA thật:** tài liệu/CI hiện chưa chứng minh quyền OA, callback ký thật, tải file/preview và giới hạn gửi. Phải có test account/secret được chủ cấp và test plan riêng; hiện tại dùng fixture/synthetic.
- **Word native:** COM có sẵn hoặc Registry có không chưa chứng minh render. Cần host Windows trung tâm, font thực dùng, file test công khai, Word mở/đếm trang/preview; chưa in cho đến khi chủ duyệt.
- **Ricoh thật:** cấu hình IP/queue/driver trong TN là tham chiếu. Chủ/nhân viên phải đối chiếu model/serial, queue, port, khay A4/A3, duplex, lật cạnh và người đứng cạnh máy. Mất ACK, driver crash hoặc kết quả không rõ phải dừng và đối soát.
- **TN-011:** chưa có terminal order event có thẩm quyền; không triển khai xóa file thật cho tới khi chốt hợp đồng và backup/legal hold.
- **TN-037:** không thể khẳng định vận hành đạt trong tuần nếu chưa có 7 ngày sạch/210 đơn và các chỉ tiêu khác; ứng viên mã và vận hành thật phải được báo hai trạng thái khác nhau.
- **Thử nghiệm live cần chủ thực hiện:** sau khi AI0 đưa ra một candidate, chủ chọn một đơn/file không chứa dữ liệu khách, xác nhận revision/hash/thông số, duyệt một job cụ thể, đứng cùng nhân viên tại Windows/Ricoh, kiểm model/serial/queue và đếm giấy thực ra. Chủ cần phê duyệt trước khi agent được bật; không chạy lệnh in thử trong nhiệm vụ này.

## 8. Nghiệm thu ứng viên V1

1. Word/PDF từ nhận file → preflight/preview native → khách xác nhận tuple hiện hành → nhân viên hợp lệ duyệt → agent kiểm lại evidence và gửi tối đa một lần → status/ACK/lỗi được ghi, kết quả giấy được nhân viên đối soát.
2. Đổi file, nguồn hash, revision, quote hoặc thông số làm xác nhận/duyệt cũ mất hiệu lực.
3. Retry hoặc ACK mơ hồ không tạo lần gửi thứ hai; trạng thái không chắc chắn phải là UNKNOWN và chờ người xử lý.
4. Lỗi AI/mạng/file giữ nguyên đơn và có tuyến nhân viên; không dùng AI để đoán số trang hoặc nội dung.
5. Ảnh/CCCD/TEMhoa/màu/loại chưa kiểm thử được nhận theo TN hiện hành khi hỗ trợ, gắn rõ tuyến nhân viên, không tự động xử lý.
6. Báo riêng PASS mô phỏng, staging, host Windows và thiết bị thật. Không tuyên bố vận hành thật nếu chưa có bằng chứng OA/Windows/Ricoh và quyết định chủ theo TN-037.
