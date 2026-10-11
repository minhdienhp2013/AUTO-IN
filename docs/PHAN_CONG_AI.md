# Phân công đợt code khởi đầu V1 — AUTO-IN

Cả 6 AI được bắt đầu song song theo yêu cầu chủ ngày 11/10/2026. Đợt này thay trạng thái chỉ-khảo-sát/chờ-code ở bảng trước; khảo sát thật vẫn làm trong phạm vi từng AI, không được coi là đã kiểm chứng.

## Nền Git và cách làm song song

- Nền đọc/code: cùng commit tài liệu mới nhất có bộ prompt code khởi đầu trên ai0/nen-tang-dieu-phoi-v1, hoặc main nếu đã chứa bộ đó. Không dùng main chỉ có README.
- Mỗi AI ghi BASE SHA thật và dùng nhánh/worktree riêng. Bộ tài liệu này chưa có scaffold; không bịa CODE_BASE_SHA.
- AI0 làm khung/schema sớm. AI1–AI4 viết module thuần/Port/adapter theo wire v0.1 ngay; AI5 viết fixture/harness. Thiếu API dùng mock có nhãn, không báo thành công giả.
- Khi AI0 bàn giao scaffold, lấy phần chung vào nhánh riêng và chạy kiểm thử; không tự ghi đè file AI khác.
- Đọc docs/architecture/KHOI_DAU_CODE_V1.md để biết stack/wire/ranh giới. Chi tiết body/schema do AI0 bổ sung sớm; thay hợp đồng chung do AI0 chốt.

## Việc và quyền sửa file

| Mã | AI / nhánh | File được sửa | Điều kiện đạt |
| --- | --- | --- | --- |
| CODE-000 | AI0 / ai0/khoi-tao-code-v1 | config/manifest/lock/build/CI root; contracts/**; backend/app.ts, backend/server.ts (entry CODE-000); tests/unit/contracts/**; README.md, AGENTS.md, .gitignore; tài liệu chung/architecture/prompts | Scaffold, schema/API/fixture/Port và script chạy/kiểm tra thật; bàn giao commit sớm. Không tạo/sửa module AI1–AI5. |
| CODE-101 | AI1 / ai1/nghiep-vu-ban-dau-v1 | backend/core/**, backend/api/**, backend/storage/**, backend/jobs/**, tests/unit/core/**, tests/integration/core/**, docs/research/AI1_NGHIEP_VU_API.md | Auth/quyền, đơn/phiên bản/duyệt, job/mark-sending, tiền/giao/ngoại lệ tối thiểu; migration và ca đồng thời trên PostgreSQL thật. |
| CODE-102 | AI2 / ai2/zalo-hoi-thoai-ban-dau-v1 | backend/integrations/zalo/**, backend/conversation/**, backend/ai/**, tests/unit/zalo/**, docs/research/AI2_ZALO_OA.md | Pipeline normalize/verify/dedupe/gom/lịch/tiếp quản/rules/AI/chi phí; adapter+fixture có nhãn; live chưa đủ verify thì từ chối. |
| CODE-103 | AI3 / ai3/tai-lieu-agent-ban-dau-v1 | workers/documents/**, agents/windows/**, tests/unit/documents/**, tests/unit/printing/**, docs/research/AI3_TAI_LIEU_RICOH.md | Processor file thật khi công cụ có; NEEDS_HUMAN khi không tin cậy; count/preview, agent DryRun+journal/UNKNOWN và adapter Windows. |
| CODE-104 | AI4 / ai4/giao-dien-ban-dau-v1 | web/**, tests/ui/**, docs/research/AI4_GIAO_DIEN_THONG_BAO.md | React/Vite project + API client/demo rõ; luồng duyệt/giao/tiền, quyền/lỗi/mất mạng và mobile. web manifest/config/lock thuộc AI4. |
| CODE-105 | AI5 / ai5/kiem-thu-ban-dau-v1 | tests/acceptance/**, tests/fixtures/public/**, docs/acceptance/** | Code test/fixture/harness, ma trận TN và release gate; tách chạy thật/mock/chưa chạy, không tự sửa sản phẩm. |
| CODE-006 | AI0 / nhánh tích hợp riêng | Điểm nối/config/hợp đồng chung; file tích hợp khác chỉ sau cập nhật rõ bảng này | Nối các bàn giao, kiểm toàn luồng mô phỏng; lỗi module trả đúng chủ file. Chỉ thực hiện phần nối khi có module, không chặn việc song song. |

## Ranh giới

- AI0 giữ đặc tả, hợp đồng, bảng này, prompt, root config/lock/CI và composition. Không tạo file sản phẩm trong phạm vi AI khác để làm skeleton.
- AI1/AI2 xuất plugin/service; AI0 nối entry. AI1 không sửa Zalo/conversation/AI; AI2 không sửa core/api/storage/jobs.
- AI3 giữ pipeline và manifest Python riêng. AI4 giữ toàn web, cả manifest/config riêng. Manifest riêng nằm trong phạm vi được cấp chỉ do AI đó sửa; root config/lock chỉ AI0.
- Test đơn vị/tích hợp module thuộc AI viết module. Test nghiệm thu chung thuộc AI5.
- File ngoài bảng gửi AI0 để cấp trước. File mới đã nằm trong phạm vi thì AI được tự tạo, không cần xin lại.
- Dependency/hợp đồng chung: gửi yêu cầu ngắn cho AI0. Mỗi file một đầu mối, không tự mở rộng tính năng.
- Không tự merge/deploy hoặc bật vận hành thật. Lệnh in test thật vẫn phải duyệt. Các AI không tự tạo thêm vai trò ngoài 6 AI đã giao.

## Bàn giao

Mẫu 6 dòng trong QUY_TAC_AI.md. DONE chỉ cho phạm vi kiểm thử đã đạt; phần OA/Ricoh/iPhone chưa thử hoặc nghiệm thu 7 ngày chưa đủ phải ghi rõ.

Lượt sau chỉ gửi mã việc, BASE SHA mới nếu có, file được sửa, yêu cầu thay đổi và ca đạt; không lặp prompt đầy đủ.


## Entry được cấp cho CODE-000

AI0 sở hữu backend/app.ts (composition) và backend/server.ts (CLI). contracts/export.ts sinh contracts/generated/schema.json + openapi.json; consumer không sửa bản sinh. Bộ khung không tạo file trong module AI1–AI5. Nền cố định: 84ab02d643622bc7bfdf07eee662d8797bdd84fd.
