# AI2 — CODE-202

Đọc README.md của thư mục này, báo cáo kiểm tra, AGENTS.md và TN-001/003/005A/006/012/022/027/028. Tạo nhánh ai2/dot2-zalo-tests-durable từ ccf5e6e1bb97fb1ca8c70a4b2d1c6ad22d59e682; lấy khung a681fe9 theo hướng dẫn chung.

Chỉ sửa backend/integrations/zalo/**, backend/conversation/**, backend/ai/**, tests/unit/zalo/** và docs/research/AI2_ZALO_OA.md.

1. Sửa ngay dấu đóng thừa ở tests/unit/zalo/deepseek.test.mjs dòng10–11. Chạy `node --experimental-strip-types --test tests/unit/zalo/*.test.mjs` toàn bộ, không thay bằng smoke type-erasure. Commit bản sửa nhỏ đầu tiên để AI0 nhận.
2. Hoàn thiện implementation durable cho event dedupe, batch/retry và outbound reservation trong namespace mình; không chỉ có interface/mock. Migrations AI2 nằm backend/integrations/zalo/**; không sửa migration AI1. Test PG thật khi có DB, ghi rõ nếu chưa chạy.
3. Nối qua Port generation/quyền từ AI1: tiếp quản lúc đang gọi DeepSeek hoặc trước OA send phải chặn phản hồi cũ; restart/UNKNOWN không tự gửi lại; ngoài lịch vẫn lưu inbound. AI1 giữ control record, AI2 giữ queue/reservation. Thiếu Port thì gửi đề xuất AI0 và vẫn test phần độc lập.
4. Webhook thật tiếp tục fail closed khi chưa xác minh chữ ký/payload/provider; cung cấp hàm nhận raw bytes để AI0 nối Fastify. Không nhắn khách thật, không tự đoán header/thuật toán OA. AI chỉ đề xuất draft, không định giá/duyệt/in.

Bàn giao6dòng: SHA/PR, suite Node/typecheck, migration/Port cần nối, PASS/FAIL/SKIP và phần OA chưa thử. Không sửa root/contracts/module khác, không merge/deploy.
