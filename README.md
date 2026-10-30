# AUTO-IN Minh Điến

V1 in tự động: Zalo OA → chuẩn bị đơn → khách xác nhận → nhân viên duyệt → Windows/Ricoh → kiểm tra/giao/tiền.

CODE-000 cung cấp khung Fastify, hợp đồng JSON/TypeScript/OpenAPI, fixture tổng hợp và kiểm thử. Các module AI1–AI5 nằm trên nhánh riêng và chưa được nối vào CLI này. Endpoint chưa nối trả 503; endpoint cần quyền trả 401 khi chưa có bộ xác thực. `/health` chỉ xác nhận tiến trình chạy.

## Chạy khung

Node 24.19.0, npm 11.9.0 là phiên bản đã kiểm thử. Dependency được khóa trong package-lock.json.

```sh
npm ci
npm run check
npm run dev
# GET http://127.0.0.1:3000/health
```

Mặc định `simulation`, bind localhost. Đổi `HOST`/`PORT`/`AUTO_IN_MODE` bằng biến môi trường; `.env.example` chỉ là ví dụ, không tự được nạp. `production` và `controlled_test` bị từ chối khởi động trong khung này. Không có token OA, tài khoản chủ mặc định hay driver in thật.

## PostgreSQL phát triển

```sh
docker compose up -d postgres
```

Compose là cấu hình phát triển (mật khẩu mẫu, bind localhost), chưa phải triển khai production. AI1 sở hữu migration và nghiệp vụ transaction; CODE-000 không tự chạy migration hoặc bootstrap tài khoản. `DATABASE_URL` chưa được CLI scaffold sử dụng trước CODE-006.

## Webhook staging cục bộ trên Windows

Để thử nhận webhook inbound bằng OA/user thử nghiệm trên máy Windows, xem [hướng dẫn PowerShell staging cục bộ](docs/architecture/LOCAL_WINDOWS_STAGING_20261030.md). Chế độ này chỉ nhận webhook được ký và allow-list, dùng database PostgreSQL test riêng trên loopback, không mở API nhân viên, không gửi tin, không tải file và không in. Mặc định không chạy; cần bật đủ biến opt-in trong phiên PowerShell hiện tại. Tunnel công khai chỉ là bước thủ công riêng và không được khởi động bởi ứng dụng.

## Máy chủ VPS mô phỏng

Hồ sơ chuẩn bị backend simulation trên VPS và cho Windows agent kết nối HTTPS ở [hướng dẫn VPS simulation](docs/architecture/VPS_SIMULATION_HOSTING_20261030.md). Cấu hình này giữ PostgreSQL và backend trên VPS, chỉ mở route agent cần thiết qua Caddy, và không nối OA thật hoặc cho phép in giấy. Đây chưa phải quy trình production hay cấu hình đã triển khai.

## Hợp đồng và điểm nối

- `contracts/schemas.ts`: nguồn schema và types; `generated/schema.json` cho Python, `generated/openapi.json` cho API.
- `npm run contracts:generate`: cập nhật bản sinh; `contracts:check`: từ chối bản sinh cũ.
- `contracts/hash.ts` và `fixtures/hash-vector.json`: canonical JSON + SHA-256 đã đối chiếu bằng Python.
- `backend/app.ts`: `buildApp({auth,handlers,zaloWebhook})` nhận adapter tin cậy do server nối; không có test principal trong CLI.
- [CODE-000 và bàn giao](docs/architecture/CODE000_BAN_GIAO.md): ranh giới, đối chiếu module đã có, việc các AI cần nối.
- [Phân công](docs/PHAN_CONG_AI.md), [đặc tả TN](docs/spec/DAC_TA_TN001-TN037.md), [quy tắc AI](docs/QUY_TAC_AI.md).

Không tự merge/deploy. Mô phỏng không chứng minh giấy đã in thật; OA/Ricoh/iPhone và TN-037 cần kiểm thử riêng.
