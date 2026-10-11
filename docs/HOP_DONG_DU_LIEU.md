# Hợp đồng dữ liệu và ranh giới duyệt → in

Trạng thái: DỰ THẢO ĐIỀU PHỐI. Các nguyên tắc nghiệp vụ dưới đây bám đặc tả; tên trường, enum, API và cách lưu chưa khóa. AI1/AI2/AI3 gửi đề xuất; chỉ AI0 cập nhật tài liệu chung. Chưa được coi bảng này là API đã triển khai.

## Dữ liệu tối thiểu

| Nhóm | Trường/ý nghĩa dự kiến |
| --- | --- |
| Định danh | order_id, customer_id, conversation_id; ID ổn định, không suy ra cùng khách chỉ bằng nội dung giống nhau. |
| Phiên bản | revision, active_revision, nội dung/thông số có hash; phiên bản cũ giữ lịch sử. |
| Tài liệu | ID/ref nội bộ, định dạng, hash file gốc, bộ kết xuất/phiên bản, preview, lỗi/cảnh báo; quyền truy cập kiểm ở server. |
| Thông số in | Theo từng file: máy đích, A4/A3, chiều, số bản, vùng trang, một/hai mặt, cạnh lật, tỷ lệ, cách ngắt file/bản. |
| Số lượng | document_pages, printed_faces, physical_sheets; từ kết xuất/kế hoạch in thật. Không dùng LLM ước lượng. Mặc định tách từng file và từng bản. |
| Xác nhận khách | revision/hash yêu cầu, thời điểm xác nhận; quote_revision và xác nhận giá khi >150 tờ hoặc chi phí đáng kể được đánh dấu. |
| Duyệt | revision/hash, actor_id/quyền nhân viên, thời điểm; cảnh báo cọc thiếu đã được xem khi có. Dữ liệu do server xác minh, không tin cờ client. |
| Tác vụ in | job_id, order_id, revision/hash, approval_id, máy, trạng thái gửi, journal/ID spooler nếu có, thời điểm/bằng chứng; job_id ổn định qua retry. |
| Hội thoại | AI/nhân viên tiếp quản, generation/token kiểm cạnh tranh, lịch hiệu lực, tạm dừng; trả AI là thao tác chủ động. |
| Giao | số tờ đã giao/chưa giao, kiểm chất lượng, người/thời điểm giao, giao một phần/đủ, đóng xử lý in bình thường/ngoại lệ. |
| Tiền | quote_revision, giá nhân viên nhập, yêu cầu cọc, tiền thực nhận, phải thu/phải hoàn, duyệt hoàn/thực hoàn; độc lập trạng thái in/giao. |
| Vận hành | mô phỏng/thử thật/chính thức/an toàn, lịch mở cửa/ngày nghỉ, khóa xử lý thủ công, quyền cấu hình/mở chính thức. |
| Nhật ký | actor, hành động, ID/phiên bản, thời gian, trước/sau, nguyên nhân; không chép nội dung tài liệu nhạy cảm vào log. |

## Các trục trạng thái

Hội thoại, xác nhận/duyệt đơn, tác vụ in, giao giấy và thanh toán là các trục độc lập. Đóng phần in ngoại lệ không đổi khoản tiền còn theo dõi, không tự ghi đã giao đủ.

Trạng thái gửi dự kiến: NOT_SENT (chắc chắn chưa gửi), SENDING, SENT_UNVERIFIED, UNKNOWN, VERIFIED_DONE. Claim/lease và khóa thủ công là thông tin riêng. Enum chính thức chốt sau khảo sát; không gộp UNKNOWN thành NOT_SENT.

## Ranh giới gửi in

1. Khách xác nhận yêu cầu của active_revision. Nếu cần xác nhận giá thì phải đúng quote_revision do nhân viên nhập. Thiếu cọc chỉ cảnh báo/ghi thiếu, không tự khóa cứng.
2. Server duyệt/claim theo thao tác nguyên tử: đúng quyền/phiên bản, không trùng job, không sửa/hủy/khóa thủ công cạnh tranh. Đơn chưa đủ thông tin không chặn đơn khác; thứ tự mặc định theo lúc khách hoàn tất xác nhận.
3. Agent nhận quyền gửi gắn với job/phiên bản; kiểm lại hiệu lực, lịch mở cửa, chế độ, máy/capability, khóa và việc đã từng gửi. Không dựa vào máy in mặc định.
4. Ghi dấu bền vững trước khi gọi đường in. Nếu crash/mất mạng ở ranh giới gửi mà không chứng minh chưa gửi thì chuyển UNKNOWN, giữ đối soát. Không coi transaction database hoặc retry là bảo đảm giấy in đúng một lần.
5. Spooler báo gửi/hoàn thành không chứng minh bản giấy đủ. Chỉ VERIFIED_DONE khi có chứng cứ thiết bị đủ tin cậy hoặc nhân viên kiểm tra/xác nhận; còn cần bước kiểm chất lượng và giao riêng.
6. Khởi động lại/mở cửa: chỉ tiếp tục đơn đã duyệt còn hiệu lực, chắc chắn chưa gửi và không bị khóa. Không bắt duyệt lại những đơn an toàn này; không tự gửi lại lệnh đã gửi/UNKNOWN.
7. Đổi nội dung/thông số đáng kể khi chắc chắn chưa gửi: giữ phiên bản/lệnh cũ trong lịch sử, tạo bản mới, khách xác nhận lại, nhân viên duyệt lại. Đã gửi/UNKNOWN thì đối soát; hủy lúc in báo khẩn, không giả hủy thành công.
8. In ngoài app: chuyển xử lý thủ công để khóa tự động trước, kiểm tra lệnh đang chạy; sau in ghi kết quả thực. Khóa không chứng minh lệnh đang in đã dừng. Chỉ chủ phê duyệt in lại/bổ sung sau lỗi.

## Hội thoại và phản hồi

AI2 nhận/lưu sự kiện và file, khử webhook lặp; chỉ đề xuất nội dung/yêu cầu đơn qua API AI1. DeepSeek không được cấp quyền duyệt/gửi in.

Tiếp quản/tạm dừng thay generation và chặn phản hồi đang soạn/chờ gửi. Kiểm lại quyền trả lời và lịch ngay trước gửi OA; sự kiện/file vẫn được lưu. Không tự trả AI sau thời gian/đóng đơn. Tin đã được OA nhận phải ghi nhận đúng thực tế, không giả rằng có thể thu hồi.

Ngoài lịch AI vẫn nhận/lưu nhưng không trả lời thông thường. Ngày nghỉ có thể tư vấn theo lịch AI, nhưng không gửi in thật. Giới hạn OA và tín hiệu OA Manager phải kiểm chứng, không suy đoán.

## Quyền, dữ liệu và tích hợp

Backend AI1 là đầu mối kiểm tra quyền, tiền và chuyển trạng thái; AI4 hiển thị nhưng không là lớp bảo vệ duy nhất. Ảnh chuyển khoản không tự xác nhận đã thu tiền.

AI3 cung cấp artifact/kế hoạch in thực; lỗi font/preview không tin cậy chuyển người. Không ép mọi file sang PDF. AI2 không đọc/lưu tài liệu vượt quyền hoặc đưa ra LLM khi không cần thiết.

File gốc/preview/OCR/cache tối đa 30 ngày sau hoàn tất/đóng hợp lệ; hồ sơ khách 24 tháng từ giao dịch cuối, lịch sử vận hành 24 tháng. Chính sách đơn chưa đóng/backup/chứng từ còn cần chốt, không tự đặt thời hạn mới.

Sự kiện/UI/thông báo phải gắn order_id + revision và kiểm quyền người xem. Chọn endpoint, schema, cơ chế xác thực, transport và stack sau khảo sát; mọi thay đổi chung do AI0 chốt.

## Ca chặn trước in thật

Duyệt kép; sửa/hủy sát gửi; crash trước/sau lời gọi driver; lệnh mơ hồ; in thủ công; ngày nghỉ; quyền giả; giá chưa xác nhận khi bắt buộc; cọc thiếu đúng cảnh báo; file/preview sai; xác nhận hoàn tất không đủ chứng cứ. Chưa đạt thì giữ mô phỏng hoặc chuyển người.

