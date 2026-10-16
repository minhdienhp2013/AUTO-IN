# Đợt hoàn thiện tiếp theo — AI0 và AI1–AI5, 16/10/2026

## Nền và quy tắc chung

BASE duy nhất: main `cb2be7a7b84d689dbe6c2c773192f111897c4063`, tree `e3794dfc0e45dc45b60c9965df1dfee5ce014a85`. PR110 đã merge theo lệnh chủ; CODE checks38886308557 và composition38886308700 SUCCESS. Nghiệm thu exact candidate ee9c8b2 nằm ở AI5 PR18 HEAD ef10b56b.

Đây là việc MỚI để hoàn thiện phần thiếu, không mở lại CODE008/401/402/403 đã PASS. Mỗi AI đọc đủ AGENTS.md/QUY_TAC_AI/PHAN_CONG_AI và đặc tả liên quan, kiểm HEAD/diff trước ghi; dùng nhánh/worktree riêng từ BASE, tạo Draft PR riêng. Không merge toàn lịch sử PR cũ. Không hai AI sửa cùng file. Shared contracts/root config/CI/composition thuộc AI0; khi thiếu hợp đồng, gửi shape và BLOCKED cụ thể trước khi nối. Báo trực tiếp tối đa6dòng: trạng thái; branch/base/HEAD/PR; file; kết quả và chứng cứ; blocker; việc AI0 cần.

Không tự merge/deploy/bật OA/in thật hoặc gọi DeepSeek thật. Bàn giao SAFE/DryRun và mock có nhãn; không dùng mô phỏng thay nghiệm thu thiết bị. Thay đổi code phải tự kiểm thử; thiếu môi trường ghi NOT RUN. V1 vẫn BLOCKED.

## AI1 — CODE501: chốt hợp đồng quản lý lịch và khóa vận hành

**Việc đầu tiên:** kiểm gap mới: SettingsView còn nút lịch disabled, Core có core_shop_settings và printingAllowed nhưng chưa có API quản lý lịch. Đọc TN lịch/ngày nghỉ và gate hiện hành. Không chạy lại bộ CODE401 chỉ để tạo báo cáo lặp.

**Nhánh:** ai1/code501-settings-contract-cb2be7a-20261016.
**Phạm vi giai đoạn1:** chỉ docs/research/AI1_NGHIEP_VU_API.md để đề xuất contract; đọc backend/core/**, backend/api/**, backend/storage/**. Chưa sửa API/schema/migration/code trong giai đoạn1.

**Đầu ra:** đề xuất cụ thể GET/PATCH lịch theo shop từ principal server, chỉ owner được ghi; open_at/close_at/timezone/holiday_dates/manual_lock, validation thời gian và ngày, idempotency và concurrency/version kiểm soát ghi đè. Không cho body đổi mode hoặc printing_enabled để mở live. Nêu rõ cách khóa lịch thay đổi cạnh tranh với claim/mark_sending, bảo toàn SENDING/UNKNOWN không tự resend; thay lịch không duyệt hoặc in lại đơn.

Đưa ví dụ request/response/error, migration cần hay không, tên file dự kiến và ma trận PG hai pool/401/403/cross-shop/stale/update-vs-send. AI0 phê chuẩn shared contract trước giai đoạn2 triển khai trong phạm vi Core/API/storage của AI1; không tự mở endpoint mới trong lúc contract chưa chốt. DONE giai đoạn1 nghĩa contract sẵn review, không phải API đã chạy.

## AI2 — CODE502: sửa số liệu chi phí AI không hợp lệ

**Lỗi tái hiện mới trên BASE:** DeepSeekIntentAdapter chấp nhận rate_micro_usd_per_million_input=-1000000, mock usage input_tokens=5, output_tokens=0; classify ghi cost_micro_usd=-5 sau một mock request. Không dùng provider thật.

**Nhánh:** ai2/code502-ai-cost-validation-cb2be7a-20261016.
**Được sửa:** backend/ai/deepseek.ts, tests/unit/zalo/deepseek.test.mjs, docs/research/AI2_ZALO_OA.md chỉ phần bằng chứng lỗi mới nếu cần. Không sửa verifier/OA/CI/Core.

Từ chối cấu hình rates không finite/âm, giá trị usage/cost vượt miền safe integer, timeout không hợp lệ. Kiểm rõ đơn vị và cách làm tròn; không hardcode giá provider. Cấu hình sai phải bị từ chối trước request và trước ghi usage. Bảo vệ options khỏi bị caller sửa sau khi đã validate nếu adapter giữ tham chiếu. Không đổi BudgetPort hoặc giả đã giải quyết atomic budget reservation: nếu thấy race ngân sách, báo contract riêng AI0.

Test negative/NaN/Infinity/overflow/zero-rate hợp lệ và đường bình thường180 microUSD cũ; đảm bảo bad config không gọi transport, không record chi phí âm/NaN. Chạy strict/unit liên quan. Giữ budget exhaustion không mất inbound event theo pipeline hiện có. Không nghiên cứu chữ ký lại; OA thật OFF.

## AI3 — CODE503: tiền kiểm đường Word gốc trên Windows, không in

**Gap mới cần hiện thực:** processor DOCX trả WORD_RENDER_PATH_NOT_VERIFIED, CLI chỉ DryRun. Checklist/spooler giả đã DONE, không viết lại manifest hoặc các ca spooler đã PASS.

**Nhánh:** ai3/code503-word-native-preflight-cb2be7a-20261016.
**Được sửa:** agents/windows/native_word_preflight.py (mới), tests/unit/printing/test_native_word_preflight.py (mới), docs/research/AI3_TAI_LIEU_RICOH.md. Không đổi agent.py/cli.py/processor/bridge hoặc bật driver.

Tạo command tiền kiểm chỉ đọc với output JSON có schema và trạng thái AVAILABLE/UNAVAILABLE/NOT_RUN cùng reason_code; chỉ Windows mới có thể báo platform khả dụng. Xác định các điều kiện có thể kiểm chứng an toàn cho Microsoft Word native automation (nền tảng, phụ thuộc đã cài, đăng ký COM nếu đọc được) và nguồn chứng cứ từng trường. Không cài dependency, khởi chạy Word, mở tài liệu, gọi PrintOut, spooler/RAW9100 hoặc nhận token. Không lấy ProgID/registry tồn tại làm bằng chứng Word render/in đã hoạt động; native_automation_verified và physical_print_verified phải false khi chưa thử riêng.

Nếu thiếu Windows, unit dùng injected read-only probes có nhãn fake và giữ Windows thực NOT RUN. Không sửa manifest dependency riêng nếu chưa cần. Tài liệu đề xuất bước thử Word gốc cần phê duyệt riêng sau này, gồm font tiếng Việt/page count/preview đúng native path; không tự ép Word sang PDF. Nếu không thể tạo probe an toàn có giá trị, báo chính xác contract/thiết bị thiếu thay vì dựng AVAILABLE giả.

## AI4 — CODE504: xử lý lỗi quyền thông báo và tiền kiểm frontend

**Lỗi tái hiện mới:** requestLocalNotifications() để Promise rejection từ Notification.requestPermission() thoát ra; button onClick await không có catch. Fixture throw Error('synthetic permission failure') tạo rejection chưa được xử lý.

**Nhánh:** ai4/code504-notification-errors-cb2be7a-20261016.
**Được sửa:** web/src/notifications.ts, web/src/App.tsx chỉ SettingsView thông báo, test tương ứng dưới web/** hoặc tests/ui/**, docs/research/AI4_GIAO_DIEN_THONG_BAO.md nếu cần. Không sửa tests/ui/code008-product* hoặc stale-browser đã PASS, không backend/SW/CI.

Xử lý requestPermission reject theo trạng thái lỗi rõ, cho phép thử lại an toàn, không hiển thị đã đăng ký Push khi chỉ có permission. Kiểm capability và secure context trước thao tác; không tự hỏi quyền khi load, không tự tạo subscription. Không đổi bố cục, không mở nút lịch trước contract AI1. Test unsupported/denied/default/granted/rejected và trạng thái hồi phục; strict/build + test UI cần thiết. Không thêm test mô phỏng gọi là Safari thật. Safari iPhone10/10 NOT RUN, Web Push end-to-end còn thiếu backend/VAPID/subscription contract, báo đúng phụ thuộc.

## AI5 — CODE505/LOAD100: kiểm thử tải batch100 đơn thực thi

Tiếp tục assignment đã lưu ở PR110 comment6213343752, không tạo nhánh/harness thứ hai nếu đã bắt đầu. Kiểm HEAD thực trước nhận.
**Nhánh:** ai5/tn037-load100-main-cb2be7a-20261016.
**Được sửa:** tests/acceptance/load100-product-pg.mjs, tests/fixtures/public/load100/**, docs/acceptance/LOAD100_PROTOCOL.md. Không sửa sản phẩm/CI, không ghi release PASS khi test chưa chạy.

100 khách/100 hội thoại/100 đơn kỳ vọng, manifest PNG/PDF tổng hợp có expected mapping cố định. Fastify HTTP loopback, PostgreSQL18.3 cô lập, synthetic Zalo runtime/AI2 durable worker, staff upload/adopt API và AI3 processor thật; không SQL giả hoàn thành hoặc mock nghiệp vụ. Tối đa5HTTP/2worker2pool/2processor đồng thời;20event replay và20client-bỏ-response-thành-công-rồi-replay cùng idempotency key. Outbound tắt.

Đo submitted/completed/failed, unique IDs/mapping/file/revision/hash, HTTP lỗi, latency p50/p95/max, elapsed/throughput, queue peak/drain; bộ nhớ nếu có số đo thật. Chốt timeout kỹ thuật trong protocol trước run, không gọi đó là SLA. PASS cần100/100 đúng expected, không mất/trùng/ròscope/backlog ngoài dự kiến; confirmations/approvals/print_jobs=0. Thiếu API hợp lệ thì báo AI0 contract, không bypass.

Bàn giao SHA/command/artifact JSON/TAP. AI0 nối workflow isolated exact SHA sau bàn giao test. Nếu đạt chỉ báo batch mô phỏng100 đơn PASS; không suy thành24giờ,100/ngày vận hành,chi phí provider thật hoặc210đơn/7ngày. Không gán số load_orders_per_day=100 để qua release gate.

## AI0 — CODE009: hợp đồng và tích hợp

1. Review contract AI1 trước khi cấp giai đoạn2; giữ root contracts/schema/config/migrations composition/CI.
2. Nhận code AI2/AI3/AI4 đã tự test, kiểm diff theo ownership, trả lỗi tái hiện đúng chủ; không nhập cả lịch sử.
3. Nhận LOAD100 và nối CI trên candidate mới, DB cô lập, checkout đúng SHA và xuất kết quả; không tính green job không chạy harness là PASS.
4. Nhánh tích hợp mới từ main cập nhật, chạy strict/PG/Python/React/Chromium cần thiết trên cùng SHA; AI5 nghiệm thu bằng chứng mới. Chưa được merge/deploy tự động chỉ vì PR110 trước đã được duyệt.
5. Chuẩn bị contract Web Push và quản lý dữ liệu30ngày/24tháng trong phần chung sau khi rà baseline; không giao AI4 tự chế backend hoặc AI2 nghiên cứu OA lặp.

## Phụ thuộc và cổng hoàn thành

AI2, AI3, AI4 và phần độc lập LOAD100 chạy song song. AI1 giai đoạn2 và UI lịch phụ thuộc AI0 chốt contract. LOAD100 CI phụ thuộc HEAD harness. Không có file chung giữa AI2/AI3/AI4/AI5.

Hoàn tất các nhiệm vụ này vẫn chưa nghiệm thu V1: OA provider-signed, Windows/Word/Ricoh/giấy thật, Safari iPhone10ca và TN037≥210đơn/≥7ngày sạch còn NOT RUN. Đợt này không cấp quyền vận hành thật. Prompt/bình luận là nơi lưu giao việc; chủ gửi đúng cuộc trò chuyện AI để khởi động.
