# AI0 tiếp quản và tích hợp kiểm thử — 16/10/2026

Đã đọc toàn văn AGENTS.md, QUY_TAC_AI.md, PHAN_CONG_AI.md và bàn giao mới nhất trước khi làm. Main kiểm tra từ GitHub: `423adb1a40d2b4a3c65dcf13c7ff36dbdbf97338`. Nhánh mới `ai0/integration-reviewed-gates-20261016` bắt đầu trực tiếp tại main, không nhập lịch sử phân nhánh cũ.

## Phạm vi nhập nguyên blob

| Nguồn | File được nhập |
| --- | --- |
| AI3 #101 `7fcb80e659529c058d43b67314b6e8032c1972fb` | `agents/windows/controlled_spooler.py`, `tests/unit/printing/test_controlled_spooler_403.py`, `tests/unit/documents/test_preview_revision_handoff_403.py` |
| AI4 #103 `d300317a54d2dc03941939df7085d868627983cd` | `tests/ui/code008-product-pg.mjs`, `tests/ui/code008-product-browser.py`, `tests/ui/code008-preview-stale-browser.py` |
| AI0 #106 `2b633fac33c9352268200ecb1c60983a56591fcc` | `tests/integration/composition/https-agent-product-pg.test.mjs` |
| AI0 #108 `2026acfb3e20de799da6c31b9b6950487ab87cdb` | `tests/integration/composition/sealed-preview-stale-product-pg.test.mjs` |
| AI0 #109 `d36f2731df7467b3986a194a1fbcb02a45e91515` | `tests/integration/composition/code008-preview-stale-browser-driver.mjs` |

Không nhập tài liệu nghiên cứu cũ, workflow pin SHA cũ hoặc toàn bộ lịch sử các PR. Không sửa backend, web runtime, workers processor hay hợp đồng. Module fake spooler AI3 được nhập nguyên trạng, CLI vẫn DryRun. AI1 #99 không còn thay đổi cần nhập so với main.

## Bằng chứng hiện có và kiểm thử mới

AI5 PR18 HEAD `2357d23f98b07e62b7c36b8582b957eb65154dd8` đã nghiệm thu độc lập PR109: hai ca Chromium thật PASS tại source `3c376eb5`, run38797342425. Không giao lại audit đó.

PR108 có bổ sung mới sau lần ghi ma trận: assertion đọc và so sánh đủ ba cột anchor `artifact_ref,manifest_sha256,request_hash`. AI5 đã kiểm chứng chỉ đọc trong lượt tiếp quản: run38833864141/job116758461317 SUCCESS, checkout `de52c11e123037c7fe16c555494a9b7774baa2bd`, 1 PASS/0 FAIL/0 SKIP, preview catalog/PNG 200→409 và confirmation/approval/print-job 0→0. Ma trận lịch sử ở PR18 chưa ghi bằng chứng bổ sung này.

Workflow mới `.github/workflows/ai0-reviewed-integration.yml` checkout đúng `github.sha`, in `EXACT_REVIEWED_INTEGRATION_SHA`, chạy PostgreSQL18.3 cô lập, Python, strict root checks/Core/AI2/composition/HTTPS DryRun, React production và toàn bộ harness Chromium mới trên cùng SHA. Đây là lượt kiểm thử mới; không dùng PASS cũ làm kết quả của nhánh mới. Phân biệt 14 browser baseline, 4 nhóm HTTP extra, 2 browser GET503 và 2 browser stale409. Fixture có mutation chủ đích; browser passive mutation=0 không có nghĩa toàn DB không thay đổi.

## Phân công vòng kế

- AI0 chạy và kiểm tra workflow trên candidate SHA; lỗi điểm nối/CI thuộc AI0. Không merge hoặc deploy.
- AI1–AI4 giữ phần đã hoàn thành; chỉ nhận lỗi tái hiện cụ thể đúng file sở hữu. AI2 tiếp tục OA thật OFF; không giao nghiên cứu chữ ký lặp.
- AI5 sau khi workflow tích hợp hoàn thành: đối chiếu checkout SHA, blob import và kết quả từng suite; chỉ sửa `tests/acceptance/**`, `docs/acceptance/**` khi có bằng chứng mới. Cập nhật giới hạn SQL-anchor đã được đóng bằng run38833864141, giữ lịch sử. Báo trực tiếp 6 dòng. Bình luận PR không tự khởi động các cuộc trò chuyện AI khác.

V1 vẫn BLOCKED. Safari iPhone vật lý 10/10, OA chữ ký provider thật, Windows/Ricoh/giấy thật và TN037 ≥210 đơn/≥7 ngày sạch vẫn NOT RUN. Việc tích hợp kiểm thử không cấp quyền merge/deploy/OA/in thật.
