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
