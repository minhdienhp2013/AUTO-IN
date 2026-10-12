# AI5 — CODE-205

Đọc README.md của thư mục này, báo cáo kiểm tra, AGENTS.md, ma trận nghiệm thu và TN-015/021/037. Tạo nhánh ai5/dot2-product-acceptance từ 2038863949e8366e9e6742472d4992f2cf224601; lấy khung a681fe9 theo hướng dẫn chung.

Chỉ sửa tests/acceptance/**, tests/fixtures/public/** và docs/acceptance/**. Không sửa code sản phẩm hoặc root config/lock; dependency chung yêu cầu AI0.

1. Viết createAcceptanceAdapter thật trong tests/acceptance/**, nối module sản phẩm/DB test PostgreSQL và AI3 DryRunDriver. Không dùng mock rồi gắn product-backed. Chuẩn bị ngay; nhận SHA nhánh tích hợp từ AI0 để chạy. Không lấy/gộp module AI khác vào nhánh sản phẩm của mình.
2. Chạy transaction/concurrency với ít nhất hai connection độc lập: duyệt kép, claim kép, sửa/hủy sát mark-sending, idempotency đổi payload, UNKNOWN/crash, ngày nghỉ/thủ công, cọc thiếu/giá, hoàn/giao/đóng ngoại lệ. Thêm ca thứ tự xác nhận khác thứ tự duyệt và giấy kiểm chứng một phần. DB test phải riêng; không reset/xóa DB thật.
3. Chạy HTTP quyền trên server simulation thật (401/403 đúng error.code), UI browser sau AI4 build đạt, agent simulation sau AI0/AI3 nối. Thiếu endpoint không coi404/422/500 là đạt bảo mật; bỏ qua phải báo NOT RUN.
4. Gửi lỗi đúng AI1–AI4 kèm SHA/repro/expected/actual; AI0 xử lý điểm nối chung. Không tự sửa namespace họ hoặc hạ gate để test xanh. Giữ OA/Ricoh/iPhone thật và210đơn/7ngày chưa kiểm chứng.

Bàn giao6dòng: SHA/PR, số PASS/FAIL/SKIP riêng cho self-test/product, lệnh và bằng chứng PG/HTTP/browser/DryRun, blocker và lỗi theo AI phụ trách. Không merge/deploy/in thật.
