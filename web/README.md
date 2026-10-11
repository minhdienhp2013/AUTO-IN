# AUTO-IN Minh Điến — giao diện CODE-104

Ứng dụng React + TypeScript + Vite độc lập (AI4). Mặc định **MÔ PHỎNG**, dùng dữ liệu tổng hợp trong `src/fixtures.ts`; không kết nối Zalo/Ricoh, không nhận tiền thật.

## Chạy thử

Yêu cầu Node >=20.19.0. Cần kết nối registry/npm để cài đúng các phiên bản đã ghim trong `package.json`:

```bash
cd web
npm install
npm run dev
npm test
npm run typecheck
npm run build
```

Mở `http://localhost:5174` (cấu hình máy khác vào LAN chỉ cho môi trường demo được phép). **Chưa có lockfile** do môi trường thực thi AI4 không truy cập registry; cần tạo `web/package-lock.json` bằng `npm install --package-lock-only` và CI kiểm tra sau khi có registry. Không khẳng định đã build/test trình duyệt khi chưa có dependencies. Không chỉnh lock/config root (AI0 quản lý).

## Mô phỏng/live

Mặc định `VITE_DEMO_MODE` không có hoặc khác chuỗi `false`: mô phỏng, có nhãn trên header và trên chi tiết. Tài khoản giả lập trong test: `demo-staff` hoặc `demo-owner` (chỉ đổi vai trong phiên demo). Không dùng dữ liệu/credential thật ở demo.

Để gọi server thật, cần xác nhận contract và môi trường bảo mật: `VITE_DEMO_MODE=false VITE_API_BASE_URL=https://<server-duoc-cap-quyen> npm run dev`. Live theo CODE-101 của AI1 dùng đăng nhập gồm `shop_id`, `username`, `password` và phiên **Bearer token chỉ giữ trong bộ nhớ**; `/api/v1/auth/me` kiểm tra principal từ server. Không lưu token/quyền vào localStorage, sessionStorage hoặc URL; tải lại trang phải đăng nhập lại. Cần cùng origin hoặc cấu hình CORS server an toàn trước khi thử ngoài localhost. HTTP/network/401/403/409/503 trả lỗi rõ, **không fallback sang demo**. Chưa có API để đọc mode server nên header ghi **CHƯA XÁC MINH CHẾ ĐỘ SERVER**; không tự đoán live là production. Tránh cross-origin chưa cấu hình CORS/CSRF.

Mọi thao tác ghi yêu cầu phiên bản gửi `expected_revision`, `request_hash`, `idempotency_key` và `Idempotency-Key`; khóa nút khi đang gọi. 409 tự tải phiên bản mới và yêu cầu người thao tác lại; không retry tự động. Sau API thành công vẫn tải lại trạng thái server nếu mutation chỉ trả biên nhận. Server luôn kiểm quyền/phiên bản, client chỉ hiển thị gợi ý.

## Lối nối còn chờ AI0 / AI1 / AI3

- **AI1 hiện có (CODE-101)**: đã đối chiếu các route hiện hữu và dùng mapper riêng cho `{orders:[...]}` và `{order,revisions,jobs,quote,received_vnd,...}`. Đã đồng bộ tên `acknowledge_deposit_shortage`, `deposit_required_vnd`, `significant_cost`, `direction:'received'`, `method:'bank_transfer'`, `physical_sheets`, `reason`, `evidence_kind:'staff_inspected'`. `verify-paper` chỉ mở cho một job thật `UNKNOWN`/`SENT_UNVERIFIED` và phải nhập số giấy/ghi chú sau kiểm tra trực tiếp. Chưa có server chạy/PG thật để test HTTP live.
- **AI0/AI1 cần bổ sung read model**: xác nhận khách theo phiên/hash, xác nhận giá/quote_revision, preview từng file/trust, tổng trang/mặt/tờ và cảnh báo, hội thoại/owner permissions/audit, chế độ/lịch/notification. API AI1 hiện trả dữ liệu lõi nhưng **không trả confirmations và preview** nên trên live duyệt in vẫn bị khóa (an toàn). Route owner `reprint`/`close-exception` đã có trong AI1 nhưng UI chưa mở vì thiếu quy trình đối soát và xác thực nghiệm thu. Live handover/return-to-AI tạm khóa vì AI1 chưa register route hội thoại.
- **AI3**: URL preview ngắn hạn an toàn theo phiên, độ tin cậy preview, số trang/mặt/tờ kiểm chứng bằng processor. Không dựng bản xem trước giả khi thiếu.
- **AI0/AI2**: backend phát Web Push (VAPID/subscription, quyền truy cập, lịch/khẩn). `public/sw.js` chỉ xử lý payload `order_id`/revision & điều hướng cùng origin; cấp permission không có nghĩa push đã hoạt động. Phải thử trên iPhone thật.

Không có nút in trực tiếp, gửi lại lệnh, đóng ngoại lệ đã in, mở production trên giao diện V1 này. Mọi máy in thật cần duyệt và thiết bị kiểm chứng trước.