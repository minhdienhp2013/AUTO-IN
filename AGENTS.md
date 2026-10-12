# AGENTS.md

Repo duy nhất: minhdienhp2013/AUTO-IN. V1 in tự động Minh Điến.

## Đọc và làm

- Đầu phiên: kiểm tra Git/nhánh/HEAD, đọc docs/QUY_TAC_AI.md, docs/PHAN_CONG_AI.md, docs/HOP_DONG_DU_LIEU.md, docs/architecture/KHOI_DAU_CODE_V1.md và đặc tả docs/spec/DAC_TA_TN001-TN037.md.
- Các lượt tiếp theo chỉ đọc phần liên quan/thay đổi. Đặc tả gốc ưu tiên khi bản rút gọn thiếu nội dung; quyết định mới của chủ phải được cập nhật rõ.
- Làm trên nhánh/worktree riêng. Chỉ sửa file được giao; giữ thay đổi của người khác. Thay API/schema/quy tắc chung gửi AI0 chốt trước.
- Đợt CODE-000/CODE-101–105 được mở song song trong PHAN_CONG_AI. Chỉ làm đợt khởi đầu được giao, chưa coi là hoàn tất toàn bộ V1. AI0 giữ file chung; mỗi AI giữ module riêng.
- Tự triển khai/kiểm thử phần được giao; báo kiểm thử thật/mô phỏng/chưa chạy. Bàn giao theo mẫu 6 dòng trong QUY_TAC_AI.
- Không tự merge/deploy hoặc mở vận hành thật nếu chủ chưa cho phép. Lệnh in thử thật cũng phải được duyệt.
- Không lưu token, khóa API, tài liệu khách, log chứa nội dung khách vào Git. Dữ liệu thử dùng tài liệu công khai/tổng hợp.
- Ưu tiên giải pháp đơn giản; không tự thêm tính năng ngoài V1. Trả lời ngắn theo kết quả, lỗi và việc tiếp theo.

## Điểm bắt buộc

Duyệt đúng phiên bản; không tự gửi lại lệnh đã gửi/chưa rõ; chỉ chủ duyệt in lại. AI không định giá. Cọc thiếu được duyệt sau cảnh báo và ghi thiếu. Tách in/giao/tiền; đóng ngoại lệ giữ khoản phải thu/phải hoàn và lượng giấy chưa giao. Không ép mọi tài liệu sang PDF. Không tự cho AI trả lời lại sau tiếp quản. Không dùng spooler làm bằng chứng đủ giấy.

