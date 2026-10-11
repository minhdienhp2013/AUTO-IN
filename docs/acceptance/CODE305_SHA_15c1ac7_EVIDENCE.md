# CODE-305 — bằng chứng CI trên SHA tích hợp 15c1ac7

Ngày kiểm tra: 2026-10-12 (Asia/Bangkok). Không phải nghiệm thu V1.

- **HEAD tích hợp:** `15c1ac75859914b2cc07d5a98bf57c18973cbbb2`, nhánh `ai0/tich-hop-simulation-v1`, PR #21 Draft.
- **Push trực tiếp HEAD** (không nhầm với pull_request merge ref): [Simulation integration run 38163402985](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38163402985), job 114540857865: SUCCESS; [CODE checks run 38163402992](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38163402992): SUCCESS.
- PR workflow riêng trên merge ref 60e5236, không thay thế bằng chứng run push nói trên.
- PostgreSQL CI: PostgreSQL 18.3 thật, DB synthetic autoin_test_305; npm ci và db:migrate PASS; tests core 13 PASS, Zalo 32 PASS, composition 8 PASS (đều 0 FAIL/0 SKIP).
- AI5 `node tests/acceptance/run.mjs --integration`: 20/20 bài PG/DryRun sản phẩm PASS, 0 FAIL, 0 SKIP trong nhóm product. Runner toàn phần 50 PASS / 0 FAIL / 19 SKIP (19 bài legacy không nối). Đây là kiểm thử simulation, không có Ricoh thật.
- HTTP local `node tests/acceptance/run.mjs --http`: 6 PASS (5 ca anonymous + readiness); toàn runner 36 PASS / 0 FAIL / 40 SKIP (PG/DryRun không kích hoạt, legacy SKIP, HTTP-ZALO-01 SKIP). Đây chỉ là kiểm tra quyền anonymous; chưa đủ HTTP quyền đã xác thực.
- **Webhook synthetic**: tests/integration/composition/zalo-http-pg.test.mjs PASS trong workflow check/composition. Payload raw byte với verifier synthetic được đưa qua Fastify injection, kiểm chữ ký sai 403, OA sai 422, nhận 200, duplicate 200, 1 event và 1 queued row trong PostgreSQL. Đây là **synthetic provider fixture**, KHÔNG phải Zalo OA live; app server mặc định health.zalo_webhook_configured=false.
- **Browser UI:** NOT RUN / BLOCKED. Cả AI4 6d8d88f và tích hợp 15c1ac7 đều chưa có web/package-lock.json. Chưa có npm ci web + browser end-to-end, dù web unit/typecheck có kết quả ở báo cáo AI0.
- **Nghiệm thu TN-037:** BLOCKED. Chưa có OA thật, Ricoh thật, iPhone thật, 100 đơn/ngày và 210 đơn >=7 ngày cùng ngưỡng nhận diện >=90% và tự xử lý >=80%.

## Phân loại chính thức tại SHA này

| Nhóm | PASS | FAIL | SKIP / NOT RUN | Giới hạn |
|---|---:|---:|---|---|
| PG + DryRun product cases AI5 | 20 | 0 | 0 | PostgreSQL thật trong CI, driver mô phỏng |
| HTTP readiness + anonymous auth | 6 | 0 | 0 | Không chứng minh auth staff/customer/agent E2E |
| Synthetic raw webhook Fastify + PG | 1 | 0 | 0 | Không dùng provider Zalo OA thật |
| Browser UI | 0 | 0 | NOT RUN | Thiếu lockfile/build AI4 |
| Live Zalo OA, Ricoh, iPhone | 0 | 0 | NOT RUN | Chờ nghiệm thu thiết bị |
| TN-037 | 0 | 0 | BLOCKED | Chưa đủ tất cả gate |

## Chứng cứ và lệnh tái hiện

- SHA chạy: `15c1ac75859914b2cc07d5a98bf57c18973cbbb2` ; biến `AUTOIN_INTEGRATION_SHA` trong workflow push khớp.
- Lệnh CI: `npm ci`, `npm run db:migrate`, `npm run check`, `node tests/acceptance/run.mjs --integration`, `node tests/acceptance/run.mjs --http` với local server simulation.
- Lượt thực thi nằm ở GitHub Actions đã xác minh qua run/job logs. Không nhận rằng kiểm thử được chạy lại từ máy của AI5: container hiện không có mạng Github/npm và PostgreSQL local.
- Mỗi SHA tích hợp mới bắt buộc kiểm lại, không kế thừa PASS cũ; AI0 phối hợp AI5 chạy test mới đã bổ sung ở nhánh AI5.

## Đầu mối

- AI0: CODE-006 composition/server và phát hành SHA mới, cấu hình CI.
- AI1: lỗi PostgreSQL, revision, payment, permissions.
- AI2: synthetic inbound pipeline / Zalo OA verifier / generation và outbound.
- AI3: bridge journal, dry-run, artifact.
- AI4: bổ sung web/package-lock.json, npm ci, build và browser.

Không tự merge/deploy/gửi khách hoặc phát lệnh in.
