# AGENTS.md

Repo duy nhất: minhdienhp2013/AUTO-IN. V1 in tự động Minh Điến.

## Đọc và làm

- BẮT BUỘC: mỗi khi AI0 bắt đầu một nhiệm vụ mới hoặc tiếp tục sau bàn giao/ngắt quãng, trước khi làm phải đọc lại toàn văn AGENTS.md, docs/QUY_TAC_AI.md và docs/PHAN_CONG_AI.md; đọc thêm đặc tả/hợp đồng liên quan. Đồng thời kiểm tra trạng thái GitHub hiện tại: main, branch/base SHA, HEAD, bàn giao/bình luận và Actions của PR liên quan. Không dựa riêng vào ký ức hội thoại hoặc SHA cũ.
- Trước mỗi lần sửa code/tài liệu, tạo/cập nhật PR hay ghi bình luận GitHub, kiểm tra lại HEAD và diff của nhánh/PR bị tác động. Nếu không đọc được quy tắc, không thực hiện ghi; báo blocker và tiếp tục phần chỉ đọc độc lập.
- AI chuyên môn đọc AGENTS.md, docs/QUY_TAC_AI.md, docs/PHAN_CONG_AI.md và prompt/assignment hiện hành trước khi nhận mỗi nhiệm vụ mới; trong một nhiệm vụ đang chạy, đọc phần thay đổi liên quan trước khi tiếp tục.
- Các lượt tiếp theo đọc phần liên quan/thay đổi của đặc tả; đặc tả gốc ưu tiên khi bản rút gọn thiếu nội dung. Quyết định mới của chủ phải được cập nhật rõ.
- Làm trên nhánh/worktree riêng. Chỉ sửa file được giao; giữ thay đổi của người khác. Thay API/schema/quy tắc chung gửi AI0 chốt trước.
- Mặc định AI0 phải tìm cách song song hóa: khi có từ hai việc độc lập, giao cho các AI chuyên môn phù hợp cùng lúc, với phạm vi file, base SHA, phụ thuộc và điều kiện nghiệm thu tách bạch. Tuần tự hóa khi có phụ thuộc, thay đổi chung hợp đồng/schema/migration, trùng file hoặc cần tích hợp/kiểm tra kết quả trước bước kế tiếp. Bình luận PR chỉ lưu bàn giao, không tự khởi động cuộc trò chuyện AI; AI0 cung cấp prompt rõ cho chủ cửa hàng gửi tới đúng AI. Không giao trùng quyền sở hữu và không làm thay module AI1–AI5.
- Đợt CODE-000/CODE-101–105 được mở song song trong PHAN_CONG_AI. Chỉ làm đợt khởi đầu được giao, chưa coi là hoàn tất toàn bộ V1. AI0 giữ file chung; mỗi AI giữ module riêng.
- Tự triển khai/kiểm thử phần được giao; báo kiểm thử thật/mô phỏng/chưa chạy. Bàn giao theo mẫu 6 dòng trong QUY_TAC_AI.
- Không tự merge/deploy hoặc mở vận hành thật nếu chủ chưa cho phép. Lệnh in thử thật cũng phải được duyệt.
- Không lưu token, khóa API, tài liệu khách, log chứa nội dung khách vào Git. Dữ liệu thử dùng tài liệu công khai/tổng hợp.
- Ưu tiên giải pháp đơn giản; không tự thêm tính năng ngoài V1. Trả lời ngắn theo kết quả, lỗi và việc tiếp theo.

## Điểm bắt buộc

Duyệt đúng phiên bản; không tự gửi lại lệnh đã gửi/chưa rõ; chỉ chủ duyệt in lại. AI không định giá. Cọc thiếu được duyệt sau cảnh báo và ghi thiếu. Tách in/giao/tiền; đóng ngoại lệ giữ khoản phải thu/phải hoàn và lượng giấy chưa giao. Không ép mọi tài liệu sang PDF. Không tự cho AI trả lời lại sau tiếp quản. Không dùng spooler làm bằng chứng đủ giấy.
