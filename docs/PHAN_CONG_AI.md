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

## Đợt 2 — CODE-201–205

Theo kiểm tra AI0 và yêu cầu chủ tiếp tục phân việc. Chi tiết nền/nhánh/phạm vi/ca đạt trong [bộ prompt đợt2](prompts/dot-2/README.md). Các phạm vi CODE-101–105 giữ nguyên, không có file hai chủ.

| Mã | AI | Mục tiêu đợt2 |
| --- | --- | --- |
| CODE-201 | AI1 | PostgreSQL thật, hàng đợi theo xác nhận, read model, quyền/generation hội thoại |
| CODE-202 | AI2 | Sửa test DeepSeek; durable queue/dedupe/outbound, nối generation qua Port |
| CODE-203 | AI3 | Bridge processor và artifact tin cậy; agent DryRun với backend sản phẩm |
| CODE-204 | AI4 | Sửa ImportMetaEnv, lock/build; mapper read model, handover và browser |
| CODE-205 | AI5 | Adapter product-backed và nghiệm thu PG/HTTP/DryRun/browser, phân biệt skip |
| CODE-006 | AI0 | Giữ wire AI1 đang dùng, đồng bộ schema/OpenAPI/mapper, root config và composition, bàn giao SHA tích hợp |

AI1–AI4 song song, AI5 chuẩn bị adapter ngay. CODE-006 chỉ nối module đã bàn giao; lỗi trong module trả chủ file. Không tự merge/deploy hoặc bật in thật. Đây là giao việc; chưa ghi các việc mới đã hoàn tất.


## Đợt 3 — CODE-301–305 và CODE-006

Chủ giao tiếp tục song song ngày 11/10/2026. [Prompt đợt 3](prompts/dot-3/README.md) là giao việc hiện hành, giữ phạm vi file cũ.

| AI | Mã | Việc |
| --- | --- | --- |
| AI0 | CODE-006 | Tích hợp simulation, wire/schema/config/composition; cấp SHA cho AI5 |
| AI1 | CODE-301 | Export điểm nối và kiểm PostgreSQL/transaction thật |
| AI2 | CODE-302 | Wiring pipeline/generation gate và durable PG concurrency |
| AI3 | CODE-303 | CLI JSON processor, artifact và DryRun với HTTP sản phẩm |
| AI4 | CODE-304 | Lockfile thật, mapper nested AI1 và kiểm browser |
| AI5 | CODE-305 | Adapter cập nhật và nghiệm thu bản tích hợp PG/HTTP/DryRun/browser |

AI1–AI5 bắt đầu phần độc lập ngay. Ca phụ thuộc CODE-006 chờ SHA tích hợp thật; thiếu môi trường ghi rõ BLOCKED. Không tự merge/deploy/in thật/nhắn khách. Không mở thêm vai trò AI.

## CODE-006 — điểm nối được cấp cho AI0
AI0 sở hữu thêm backend/composition/**, scripts/** và tests/integration/composition/** để nối runtime, migration, processor và kiểm thử tích hợp. Các module AI1–AI5 được nhập nguyên trạng từ SHA đã bàn giao; không đổi chủ file.


## Đợt 4 — CODE-401–405 + AI0 CODE-007 (giao 12/10/2026)

[Chi tiết nhiệm vụ/điều kiện an toàn](architecture/CODE007_PHAN_CONG_20261012.md). Nền tham chiếu tích hợp đã có 6/6 CI SUCCESS: `3f0380abed2294fc18d09294cd6a8c9562108710` trên PR #31. Nhánh AI cá nhân không được tự ghi đè code tích hợp; báo AI0 khi cần đồng bộ hợp đồng.

| AI | Mã | Công việc tiếp theo | PR |
| --- | --- | --- | --- |
| AI0 | CODE-007 | Chốt credential/event-confirmation contract, composition, PostgreSQL, Chromium/DryRun, gom commit và release gate | #31 |
| AI1 | CODE-401 | Confirm khách đúng current revision/hash/quote, idempotency+race cùng transaction; API/Port xác thực | #16 |
| AI2 | CODE-402 | Nhận diện confirmation candidate an toàn từ event, generation/dedupe, không tự xác thực khách | #19 |
| AI3 | CODE-403 | Kiểm chứng nguồn/manifest/preview bất biến và agent UNKNOWN/ACK/restart bằng DryRun | #20 |
| AI4 | CODE-404 | Đồng bộ UI đã được AI0 tích hợp; hiển thị confirmation/quote/read model, fail-closed desktop/mobile | #15 |
| AI5 | CODE-405 | Chạy acceptance đúng integration SHA; PG/HTTP/Chromium/DryRun và ghi rõ LIVE NOT RUN | #18 |

Phạm vi file giữ nguyên bảng CODE-101–105 và bổ sung AI0 `backend/composition/**`, `scripts/**`, `tests/integration/composition/**`; không có file hai chủ. Mỗi AI tự viết và chạy test trong phạm vi, bàn giao commit/PR 6 dòng. Comment PR là kênh lưu giao việc, **không tự khởi động phiên AI khác**. Chưa được merge, deploy, Zalo OA thật hoặc Ricoh thật; chỉ chủ cho phép thử thật.


## Đợt hoàn thiện CODE501–505 và AI0 CODE009 — 16/10/2026

Theo yêu cầu chủ giao tiếp cho các AI sau merge PR110. BASE: `cb2be7a7b84d689dbe6c2c773192f111897c4063`. [Prompt và điều kiện chi tiết](prompts/DOT_HOAN_THIEN_20261016.md).

| AI | Việc mới | Phạm vi và phụ thuộc |
| --- | --- | --- |
| AI1 CODE501 | Contract API quản lý lịch/khóa | Giai đoạn1 chỉ docs/research/AI1_NGHIEP_VU_API.md; chưa code endpoint/schema trước AI0 chốt |
| AI2 CODE502 | Sửa chi phí AI âm/không hợp lệ, lỗi mới đã tái hiện | backend/ai/deepseek.ts + tests/unit/zalo/deepseek.test.mjs; OA thậtOFF, không nghiên cứu chữ ký lặp |
| AI3 CODE503 | Probe Word native Windows chỉ đọc, không in | 2file mới agents/windows/native_word_preflight.py và tests/unit/printing/test_native_word_preflight.py + researchAI3; không bật driver/COM automation |
| AI4 CODE504 | Xử lý permission Promise rejection, lỗi mới đã tái hiện | notifications.ts + App.tsx SettingsView và test thuộc AI4; không đổi layout/backend/SW |
| AI5 CODE505 | LOAD100 batch thực thi, tiếp assignment hiện có | tests/acceptance/load100-product-pg.mjs + fixtures/public/load100 + docs/acceptance/LOAD100_PROTOCOL.md; AI0 nốiCI sau HEAD |
| AI0 CODE009 | Chốt contract, root/CI/composition, tích hợp | Giữ ownership AI0, không sửa module chuyên môn |

Các phần cũ đã PASS giữ nguyên. Nhiệm vụ mới không cho phép merge/deploy/OA/Ricoh thật; scope giai đoạn2 chỉ mở sau contract AI0. Báo cáo6dòng và tách thật/mock/NOTRUN. V1 vẫnBLOCKED.
