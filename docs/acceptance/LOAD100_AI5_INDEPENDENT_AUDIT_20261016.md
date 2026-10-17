# AI5 — kiểm toán độc lập LOAD100 trên AI0 PR118 (16/10/2026)

## Chốt trạng thái và nguồn bằng chứng

**Kết luận: PASS — chỉ batch 100 đơn tổng hợp trong môi trường cô lập.** Không phải nghiệm thu phát hành V1 hoặc TN-037.

- Sản phẩm được kiểm: PR #118, đúng commit bất biến `920b9e308e9a1adf0161d929f5622fcd11a2d54c`, BASE `cb2be7a7b84d689dbe6c2c773192f111897c4063`; AI5 source PR #117 trước kiểm toán: `8bf4e3957c18297a926b68066093bbda9d08cd83`.
- Workflow [38906081351 / job 116989875514](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38906081351/job/116989875514): **SUCCESS**, checkout đã in `EXACT_LOAD100_CANDIDATE_SHA=920b9e308e9a1adf0161d929f5622fcd11a2d54c`; chạy Node 24, Python 3.12.15, PostgreSQL **18.3** trên database riêng `autoin_test_load100`, API loopback và AI2/AI3 sản phẩm.
- Artifact [GitHub Actions ID 12048840071](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38906081351/artifacts/12048840071), tên `load100-diagnostic-920b9e308e9a1adf0161d929f5622fcd11a2d54c`, SHA-256 **ZIP** `fc80913e30098f83ed9a1db9fdfda944a753ec8cc941d13060f278ed07d46300`. Đã tải và giải nén độc lập, không chỉ dựa vào mô tả PR. ZIP có `autoin-load100-report.json` (18.938 bytes, SHA-256 `59cd99f11a53baf0ab01eabbf862807d436f66c8ca73a9294f9cfdd9639907cc`) và `autoin-load100.tap` (19.036 bytes, SHA-256 `a14cdfd023be9c4f57555c574e7aa833a1bbb09445a5ff0d4e34575d6ad12807`). JSON nhúng trong TAP khớp tuyệt đối với file report riêng.
- Đã đối chiếu **cùng Git blob SHA** trên PR #117 và PR #118 của 5 file: harness `0cc595dd75741b04c2da5cce169cc857eb687647`; protocol `3b942a90596bbfd83b7bf4a8216cf7f237aafc68`; manifest `9d1a46aaf4fe54454df34420f6575b74591e731f`; PDF `260290d509fbbbf78fd4a5c541a68aa5aed9c8b0`; PNG `0cda452c68b157c73afe0a33a43ad9ae52a8ffa8`. AI0 không thay blob của AI5.

## Bảng đối chiếu độc lập và phạm vi chứng minh

| Hạng mục | Bằng chứng đối chiếu | Kết quả |
| --- | --- | --- |
| Kết quả batch | JSON `status=PASS`, `submitted=100`, `completed=100`, `failed=0`; TAP `ok 1`, `1..1` | **PASS** |
| Đơn duy nhất | JSON `unique_order_ids=100`; harness SQL tạo `idByCase` theo customer/conversation, assert có **100 UUID khác nhau** và 100 bản ghi Core không lẫn shop | **PASS theo assertions chạy thật** |
| Replay inbound | `replay_events=20`; harness yêu cầu HTTP `status=duplicate` cho mỗi event được gửi lại | **PASS** |
| Replay giả mất HTTP response | `lost_success_response_replays=20`; harness bỏ body 2xx ở client rồi gửi lại cùng key/body, assert order, status, revision=2 và `ai0_source_adoption_receipts.response` | **PASS (synthetic)** |
| Revision | `controlled_core_revisions=100`, `revisions_verified=100`; harness truy vấn **300 core_revisions** và assert từng UUID có lịch sử đúng `[1,2,3]` | **PASS theo SQL assertions** |
| Exact source | 100 khóa event trong `expected_source_sha256` và `observed_source_sha256` khớp từng khóa 001–100, 80 PNG/20 PDF; harness còn kiểm `ai3.document_bridge.v1/files[0].file_sha256` | **PASS** |
| Durable worker | `ingested=100, claimed=100, processed=100, held=0, needs_human=0, retry=0` | **PASS** |
| Hai queue | `zalo_batches: 100 DONE / 0 pending`; `zalo_process_queue: 100 COMMITTED / 0 pending`; `queue_peak=100` | **PASS** |
| Guards trước/sau | `confirmations=0, approvals=0, print_jobs=0` ở cả hai mốc | **PASS** |
| HTTP/nguồn số liệu | `http_errors=[]`; 5 HTTP, 2 worker/2 pool, 2 processor theo limits; stage latency có 100 processor và 120 adopt | **PASS** |
| Thời gian/tốc độ | `elapsed_ms=30504` = **30,504 giây**; `100/30,504=3,278258589...`, làm tròn **3,28 đơn/giây** | **PASS — throughput của batch** |
| Regression trong cùng job | 18 contract + 39 Core + 93 AI2 + 29 composition, **179 PASS / 0 FAIL / 0 SKIP** trong bốn nhóm; bao gồm staff-adopt HTTP | **PASS** |

Dữ liệu nguồn chính xác:
- **PNG** SHA-256 `d16adb1bdd203c2d26eec5fdbcf327dcda70d0282ea253d7c75d230d2b425510`, 80 event.
- **PDF** SHA-256 `2f23535722b9d2fcc65f136aa39a55ba36226512318a2dd610a2ba7e42fcf8e8`, 20 event; PDF 1 trang vector không dùng font, **không hạ guard sản phẩm**.
- **Latencies p95 (ms):** webhook 15,35; upload 16,72; adopt 35,54; staff preview 11,29; AI3 processor 485,78. Các giá trị là dữ liệu máy chạy CI, **không phải SLA**.

## Giới hạn bằng chứng, SKIP và NOT RUN

1. ZIP JSON/TAP **không lưu danh sách 100 UUID order_id hoặc 300 revision rows**. Do đó AI5 kiểm độc lập được các con số tổng, tính nhất quán 100 expected/observed SHA và các assertions SQL trong harness **đã thực thi thành công**, nhưng **không thể tái đếm độc lập từng UUID/revision chỉ bằng JSON artifact**. Không gọi đây là một truy vấn PostgreSQL mới do AI5 chạy. Khi cần khả năng kiểm toán từng dòng ngoài log, đề xuất AI0 bổ sung artifact mapping đã khử thông tin riêng tư, nhưng **không phải lỗi FAIL của batch này**.
2. Cả 80 PNG dùng cùng một chuỗi byte; cả 20 PDF dùng cùng một chuỗi byte. Đối chiếu hash **không phát hiện được tráo hai nguồn cùng loại/cùng hash**; chưa chứng minh khả năng phát hiện mọi lỗi rò nhầm file giữa khách hàng.
3. Đầu ra `PASS` chỉ xác nhận **một batch synthetic** chạy đủ trên Fastify/PostgreSQL/AI2/AI3, không chứng minh 100 **đơn mỗi 24 giờ**, không là benchmark ngày hoặc 210 đơn thật trong **ít nhất 7 ngày sạch**, không đo tỷ lệ nhận diện ≥90% hay hội thoại tự xử lý ≥80%.
4. **NOT RUN:** Zalo OA thật/provider-signed, DeepSeek thật, Ricoh/Windows/Word/giấy thật, Safari iPhone thật, TN-037 liên tục 7 ngày. Không có quyền chuyển V1 sang vận hành.
5. **FAIL 0/SKIP 0** chỉ áp dụng cho job synthetic và bốn nhóm regression yêu cầu của job này; các kiểm thử thiết bị/provider ngoài phạm vi là **NOT RUN**, không được đổi thành SKIP 0 để đánh lừa release gate. Lịch sử candidate cũ `021bd277` FAIL do PDF Helvetica không nhúng được giữ nguyên là FAIL lịch sử; không suy lại thành PASS.
6. CI tệp `LOAD100_JSON` ghi `product_commit_sha=920b9e...`; `queue_drain` xác nhận 100 DONE/COMMITTED. Dữ liệu `elapsed_ms` là thời gian riêng hàm test (30,504 giây), khác tổng thời gian job CI cài dependency và regression.

## Bàn giao

- **AI5 CODE505: PASS batch mô phỏng 100/100; V1 BLOCKED.** Không thay đổi test harness hoặc sản phẩm.
- AI0 ghi nhận bằng chứng này trên candidate; nếu định làm release phải tiếp tục nghiệm thu TN-037/thiết bị/provider thật và quyết định theo luật.
- Không tự merge, không deploy, không bật OA, không bật in thật.
