# CODE-000 — khung chung và bàn giao

Nền cố định `84ab02d643622bc7bfdf07eee662d8797bdd84fd`; nhánh `ai0/khoi-tao-code-v1`. Chỉ file AI0. `backend/app.ts` composition, `backend/server.ts` CLI đã được cấp trong PHAN_CONG_AI. CODE-000 không phải CODE-006/V1 hoàn tất.

## Chạy và kiểm tra

Node 24.19.0/npm 11.9.0; Fastify 5.12.5, TypeBox 0.34.52, Ajv 8.20.0; TypeScript 5.9.3, tsx 4.23.15. Khóa package-lock.json. pg8.23.1/@types/pg8.23.1 đã khóa cho AI1; CLI chưa tự nối DB. Script dùng `node --import tsx`, tránh phụ thuộc IPC của CLI tsx. `npm ci`; `npm run check` gồm freshness schema, typecheck, 18 test, build. CI chạy cùng kiểm tra, không deploy. Docker Compose PostgreSQL là cấu hình phát triển, không giả đã kiểm thử container.

## Schema / hash

Nguồn duy nhất: schemas.ts; TS `Static`, JSON Schema draft-07 cho Python và OpenAPI 3.1 được sinh bởi export.ts. Chặn unknown properties, tiền/revision/count phải số nguyên an toàn, timestamp UTC `Z`. Không coercion JSON. Query `limit` chỉ chuyển chuỗi chữ số nguyên thành số trước validate.

Hash canonical v0.1: JSON plain object, khóa sort theo UTF-16, giữ thứ tự array, JSON.stringify số hữu hạn (`-0` thành `0`), UTF-8; không chuẩn hóa Unicode. Từ chối undefined/NaN/Infinity/bigint/accessor/cycle/sparse array. SHA256 lowercase 64 hex trên RequestManifest đã validate, gồm hash file gốc/thông số/thứ tự/nội dung chính xác; không actor/revision/time/state. Golden vector sinh độc lập bằng Python. Đây là tập JSON giới hạn; không tuyên bố hỗ trợ toàn bộ RFC 8785.

Idempotency scope = hash actor/action/key; service AI1 phải lưu hash payload riêng trong transaction: cùng scope + cùng payload replay biên nhận, payload khác 409. Root không giả có DB persistence/transaction. `expected_revision` là phiên bản đang có hiệu lực; row locks/mode snapshot/approval/quote/lease phải do AI1 kiểm trong mark-sending nguyên tử.

## Composition và bảo vệ

`buildApp` nhận `auth.authenticate(request)` từ server, handler theo operationId và plugin raw webhook AI2. Server principal của khung gồm actor_id, role, permissions; khách cần customer_id + verified_channel_id; agent cần agent_id + printer_ids. Resolver phải xác thực credential trước tạo principal; không đọc role/actor từ JSON/header tự khai. Quyền route chỉ là vòng đầu; AI1 vẫn phải kiểm shop/order/customer, ownership ngoại lệ/hoàn/in lại và printer scope cho job trong DB.

Handler nhận principal/mode/params/input đã kiểm schema. Login/logout có hook setSessionCookie nếu adapter chọn cookie; cookie/CSRF/session do AI1 bảo vệ. Nếu dùng Bearer phải nối login transport vào hợp đồng phù hợp trước vận hành. Trả lỗi 401/403/409/422/503 thống nhất; lỗi bất ngờ sanitized500. Response cũng được kiểm schema. `/health` báo các operation đã gắn, không chứng minh module/DB/thiết bị sẵn sàng. Safe/simulation khởi động được; controlled_test/production bị chặn toàn bộ trong CLI CODE-000, chưa có activation owner.

Job JSON schema chặn SIMULATED_DONE ở mode thật, VERIFIED_DONE từ simulated/spooler, NOT_SENT/SENDING có bằng chứng cũ và UNKNOWN thiếu bằng chứng mơ hồ. `validJob` còn kiểm verified_sheets bằng planned physical_sheets. So sánh hash/đúng job/lease/evidence thiết bị phải kiểm ở service, không thể chứng minh bằng shape JSON.

## Đối chiếu consumer đã viết trước scaffold

Các module song song đã tự chốt model nội bộ khi schema AI0 chưa có. **Chưa tương thích trực tiếp**; không mount `registerCoreRoutes` cạnh route cùng đường dẫn của scaffold. CODE-006 cần mapper hoặc AI cập nhật module trong phạm vi mình; chưa nối thì 503.

| Nhóm | Hợp đồng khung | AI1 hiện tại / AI3–AI4 đang dùng |
| --- | --- | --- |
| Danh tính | actor_id / agent + permissions/scopes | id / print_agent + shop_id, verified; resolver chưa nối |
| Login/me | authenticated + principal / principal trực tiếp | shop_id login, token + principal / {principal} |
| Yêu cầu | manifest | request_data |
| Xác nhận | request_hash + quote_revision | kind request/quote; lấy hash từ revision server |
| Duyệt/cọc | deposit_warning_acknowledged / deposit_requested_vnd | acknowledge_deposit_shortage / deposit_required_vnd |
| Agent | lease_id, hash, send_authorization_id, report evidence object | lease_token, result/evidence_kind, mark-sending {job_id,state,mode} |
| Response | read model Order | biên nhận mutation và {order,revisions,jobs,quote,...}; chưa confirmations/preview |
| Hội thoại | handover / return-to-ai | AI1 chưa có route; AI2 có Port/generation |

Không đổi âm thầm wire đang dùng. Các tên trên cần được chốt/đồng bộ ở CODE-006 cùng test HTTP liên module; scaffold chưa được dùng làm API production. Report agent không nhận staff actor; root không nối fake customer/processor để vượt qua thiếu xác minh.

## Bàn giao song song

- AI1: dùng hoặc đề xuất mapper cho canonical contracts; khóa pg ở root do AI0; chạy PG thật + migration 001/002, auth/scope/processor/confirmation/preview read model. Không đưa bypass principal vào runtime.
- AI2: sửa lỗi cú pháp deepseek.test.mjs; nối verified raw webhook và queue/gate durable vào PostgreSQL. Signature OA thật chưa được xác minh nên giữ live fail closed.
- AI3: dùng generated/schema.json khi đồng bộ wire; giữ journal trước driver, UNKNOWN không retry; không thay tất cả đường in thành PDF.
- AI4: sửa ImportMetaEnv trong web scope; tạo lock riêng, build thật; giữ thiếu confirmation/preview thì không duyệt.
- AI5: nối acceptance adapter sản phẩm và PG hai connection độc lập; self-test/skip không phải nghiệm thu. OA/Ricoh/iPhone/210 đơn/7 ngày vẫn chưa kiểm chứng.

Nguồn chính thức đã đối chiếu: Fastify TypeScript + Validation and Serialization, Node release matrix, TypeBox schemas. Không thêm Redis/Kafka/microservices hoặc adapter thật.

## Quyết định tương thích cho đợt2

Ngày11/10/2026 AI0 chốt giữ wire thực tế AI1 fc0ca14 mà AI3/AI4 đang dùng; schema/OpenAPI scaffold sẽ do AI0 đồng bộ ở CODE-006. Consumer chưa đổi sang manifest/lease_id hoặc body khác trong exports. Chi tiết [README đợt2](../prompts/dot-2/README.md); bảng khác biệt bên trên là checklist sửa điểm nối, không là lệnh buộc consumer đổi tất cả body.
