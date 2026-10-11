# Đợt 3 — tích hợp simulation

Chủ yêu cầu tiếp tục ngày 11/10/2026. AI1–AI5 làm song song trong phạm vi cũ. Dùng prompt riêng AI1_CODE301 đến AI5_CODE305. Đây là giao việc mới, chưa ghi DONE.

AI0 tiếp tục CODE-006: tạo nhánh ai0/tich-hop-simulation-v1 từ nền chung hiện hành, ghép bàn giao đã kiểm tra bằng Git trên nhánh tích hợp riêng (không merge PR/main), đồng bộ contracts/OpenAPI theo wire AI1, config/root lock/build/CI, Fastify/auth/PG/processor/AI2 composition. Cấp SHA tích hợp và lệnh migration/start simulation cho AI5 sớm; không chờ thử OA/Ricoh. Lỗi module trả đúng chủ file, không ghi đè code chuyên môn.

Các namespace giữ nguyên theo PHAN_CONG_AI; AI0 chỉ dùng backend/app.ts, backend/server.ts, contracts/** và root config/CI/tài liệu chung. Nếu cần điểm nối mới, cập nhật quyền sở hữu trước khi tạo. AI1 xuất core/auth/repository/plugin, AI2 xuất factory pipeline/gate, AI3 xuất CLI JSON, AI4 nối mapper, AI5 kiểm tra độc lập.

Nguồn module đã kiểm: AI1 ebdd740; AI2 9b43135; AI3 31e73ea; AI4 694179c; AI5 5707b81. Xem báo cáo chung để biết ca đã chạy. Không gọi scaffold health/401 hoặc unit mock là bằng chứng tích hợp. Chưa có SHA CODE-006 tại lúc phân việc; AI5 chuẩn bị ngay và chạy phần phụ thuộc khi được bàn giao.

Mặc định simulation, secrets không vào Git, không tự merge/deploy/in thật/nhắn khách. DONE chỉ cho phạm vi kiểm đã đạt; PostgreSQL/HTTP/browser chưa chạy phải ghi BLOCKED/SKIP cụ thể. Không mở thêm vai trò AI ngoài AI0–AI5.
