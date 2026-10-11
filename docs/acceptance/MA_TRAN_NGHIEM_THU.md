# AUTO-IN — ma trận nghiệm thu CODE-105

**Mặc định tất cả ca nghiệm thu sản phẩm CHƯA CHẠY.** Fixture PASS không phải bằng chứng phần mềm đúng. Chỉ dùng giấy tờ tổng hợp, không dùng file khách.

| TN | Chủ code | Ca thử / yêu cầu | Bằng chứng |
|---|---|---|---|
| TN-001 | AI2 | gom tin | INTEGRATION NOT RUN |
| TN-002 | AI2 | tuyến mua hàng | INTEGRATION NOT RUN |
| TN-003 | AI2 | ngoài giờ | INTEGRATION NOT RUN |
| TN-004 | AI3 | file ZIP >5 | INTEGRATION NOT RUN |
| TN-005 | AI2/AI3 | nhận diện | INTEGRATION NOT RUN |
| TN-005A | AI2/AI3 | local before LLM | INTEGRATION NOT RUN |
| TN-006 | AI2 | trả lời | INTEGRATION NOT RUN |
| TN-007 | AI1 | unapproved_order, stale_revision | INTEGRATION NOT RUN |
| TN-008 | AI4 | push | INTEGRATION NOT RUN |
| TN-009 | AI3 | capability | INTEGRATION NOT RUN |
| TN-010 | AI4 | QR | INTEGRATION NOT RUN |
| TN-011 | AI1/AI3 | unauthorized_preview | INTEGRATION NOT RUN |
| TN-012 | AI1/AI2/AI3 | unknown_after_crash, duplicate_webhook | INTEGRATION NOT RUN |
| TN-013 | AI2 | cost alarms | INTEGRATION NOT RUN |
| TN-014 | AI2 | rule version | INTEGRATION NOT RUN |
| TN-015 | AI0/AI5 | 210/7 days | FIELD / GATE NOT RUN |
| TN-016 | AI0 | end-to-end | INTEGRATION NOT RUN |
| TN-017 | AI1 | forged_actor | INTEGRATION NOT RUN |
| TN-018 | AI3 | long text | INTEGRATION NOT RUN |
| TN-019 | AI1 | deposit_short | INTEGRATION NOT RUN |
| TN-020 | AI1 | customer retention | INTEGRATION NOT RUN |
| TN-021 | AI2/AI5 | 90%/80% metrics | FIELD / GATE NOT RUN |
| TN-022 | AI2 | OA verification | FIELD / GATE NOT RUN |
| TN-023 | AI3 | spooler | FIELD / GATE NOT RUN |
| TN-024 | AI1 | audit | INTEGRATION NOT RUN |
| TN-025 | AI3 | sheets/faces/pages | INTEGRATION NOT RUN |
| TN-026 | AI1 | sending_revision_race | INTEGRATION NOT RUN |
| TN-027 | AI1/AI2 | handover_race | INTEGRATION NOT RUN |
| TN-028 | AI1/AI2 | holiday | INTEGRATION NOT RUN |
| TN-029 | AI3 | duplex/scale | INTEGRATION NOT RUN |
| TN-030 | AI1 | partial_delivery_exception | INTEGRATION NOT RUN |
| TN-031 | AI1 | abandoned/reminders | INTEGRATION NOT RUN |
| TN-032 | AI1/AI4 | mode/owner | INTEGRATION NOT RUN |
| TN-033 | AI1 | large_quote_unconfirmed, deposit_short | INTEGRATION NOT RUN |
| TN-034 | AI3 | file fonts/preview | INTEGRATION NOT RUN |
| TN-035 | AI1/AI3 | manual_lock, unknown_after_crash | INTEGRATION NOT RUN |
| TN-036 | AI1 | partial_delivery_exception | INTEGRATION NOT RUN |
| TN-037 | AI0/AI5 | release gate | FIELD / GATE NOT RUN |

**Chặn P0:** thiếu duyệt, stale, trùng job, giả quyền, UNKNOWN tự retry, in sai, rò dữ liệu. Có P0 phải chuyển SAFE qua AI0, sửa đúng module và chạy lại; không tự in thật.

**TN-021/037:** yêu cầu nhận diện ≥90%, hội thoại phổ biến tự xử lý ≥80%; mẫu số khóa trước, thiếu dự đoán tính sai, không loại ca khó; bước nhân viên duyệt là bắt buộc và không tính là lỗi của AI. 210 đơn đạt trong ≥7 ngày sạch lỗi nghiêm trọng + mô phỏng 100 đơn/ngày, OA/Ricoh/iPhone có bằng chứng thật, chủ duyệt mở chính thức. Chưa có các bằng chứng đó.

## CODE-305 — ma trận bổ sung đợt 3 (2026-10-11)

**BASE MODULE:** `5707b81128e7e84180db57865896d52d256dac33`. **Tích hợp CODE-006:** CHƯA CÓ SHA tại thời điểm viết. Các dòng dưới chỉ là ca đã **viết code**, sản phẩm vẫn **NOT RUN / BLOCKED**. Kết quả selftest không chuyển trạng thái nghiệm thu.

| TN | Test trên sản phẩm thật (simulation, PostgreSQL test) | Chủ xử lý lỗi | Trạng thái |
| --- | --- | --- | --- |
| TN-007, TN-026 | PG-01–04, PG-13, PG-16–17: stale/claim kép/mark kép/FIFO xác nhận khác thứ tự duyệt | AI1 | NOT RUN |
| TN-012, TN-023, TN-035 | PG-05/11, DRYRUN-12/18: UNKNOWN, crash journal, không gửi lại, không chứng minh giấy thật | AI1/AI3 | NOT RUN |
| TN-017 | PG-14 printer scope; HTTP anonymous staff/agent denial | AI1/AI0 | NOT RUN |
| TN-019, TN-030, TN-033, TN-036 | PG-07–10, PG-15: giá/cọc/hoàn/đóng ngoại lệ còn nợ | AI1 | NOT RUN |
| TN-027 | PG-19/20: generation cũ bị chặn và handover đồng thời | AI1/AI2 | NOT RUN |
| TN-001, TN-012, TN-022 | HTTP-ZALO-01 từ chối webhook không chữ ký nếu AI2 ingress tích hợp | AI0/AI2 | NOT RUN |
| TN-008, TN-010, TN-032 | UI browser local Chromium; mobile viewport không phải iPhone thật | AI4 | NOT RUN |
| TN-015, TN-021, TN-037 | 90%/80%, 100 đơn/ngày, 210 đơn ≥7 ngày, OA/Ricoh/iPhone thật và bằng chứng release gate | AI0/AI5 | FIELD NOT RUN |

**Release gate bổ sung:** yêu cầu `evidence.integration_sha` 40 ký tự và `evidence.product_runs.pg/http/dryrun/browser` từng mục có `status:'PASS'`, `fail:0`, `skip:0`, `pass >= 1` và **cùng SHA**; các điều kiện nghiệp vụ/thiết bị TN-037 trước đây vẫn giữ nguyên. Một bài SKIP không phải PASS.

**Nguyên tắc báo cáo:** Bất kỳ ca P0 FAIL -> SAFE, không tự gửi in, không tự nhắn OA. File/code AI5 chỉ báo lỗi, chủ module tương ứng sửa. Mọi báo cáo phải ghi SHA, lệnh tái hiện, observed/expected và bằng chứng đã che thông tin nhạy cảm.
