# Quy tắc chung AI V1

Bạn làm V1 phần mềm in tự động Minh Điến, repo riêng: https://github.com/minhdienhp2013/AUTO-IN.
Nguồn nghiệp vụ: docs/spec/DAC_TA_TN001-TN037.md (bản Word gốc cùng thư mục), TN-001–TN-037 và TN-005A, chốt 11/10/2026.

## Bắt buộc trước mọi nhiệm vụ

- AI0, trước mỗi nhiệm vụ mới hoặc mỗi lần tiếp tục sau bàn giao/ngắt quãng, phải đọc lại toàn văn AGENTS.md, docs/QUY_TAC_AI.md (file này) và docs/PHAN_CONG_AI.md. Kiểm tra GitHub mới nhất: main, branch/base SHA, HEAD, bàn giao/bình luận và Actions của PR liên quan; đọc đặc tả/hợp đồng liên quan trước khi làm. Không dựa riêng vào lịch sử chat hay SHA từng được báo trước đó.
- Trước mọi thao tác ghi code/tài liệu hoặc thay đổi PR/bình luận, AI0 xác minh lại HEAD và diff hiện hành của nhánh/PR bị ảnh hưởng. Nếu không đọc được quy tắc hoặc trạng thái nguồn, dừng thao tác ghi, nêu blocker và tiếp tục phần chỉ đọc độc lập.
- AI chuyên môn đọc AGENTS.md, file này, docs/PHAN_CONG_AI.md và prompt/assignment hiện hành trước khi nhận nhiệm vụ mới. Trong cùng nhiệm vụ đang tiếp tục, đọc phần thay đổi liên quan và kiểm tra handoff mới nhất.

## Song song hóa công việc

- AI0 chủ động rà soát mỗi đợt việc để mặc định giao đồng thời cho AI1–AI5 khi có từ hai phần việc độc lập, không phụ thuộc và có ranh giới file/hợp đồng rõ. Mỗi prompt phải nêu đúng AI sở hữu, mục tiêu, file được sửa, base SHA, phụ thuộc, kiểm thử và điều kiện bàn giao.
- Làm tuần tự khi các việc phụ thuộc API/schema/migration chung, sửa cùng file, cần một hợp đồng được chốt trước hoặc phải tích hợp/kiểm tra đầu ra trước khi bước sau bắt đầu. Không tạo song song giả tạo hay giao trùng phạm vi.
- Bình luận GitHub chỉ là nơi lưu bàn giao, không tự khởi động phiên AI khác. Khi cần AI chuyên môn làm việc, AI0 đưa prompt rõ ràng để chủ cửa hàng gửi đúng cuộc trò chuyện AI; tiếp tục các phần độc lập khác trong lúc chờ.

## Quy tắc thực hiện

- Dùng nhánh/worktree riêng; giữ thay đổi của người khác. Chỉ sửa phạm vi file điều phối giao. Các đường dẫn trong bảng phân công là phạm vi được cấp; chưa có mã nguồn không có nghĩa được tự mở rộng. Đổi hợp đồng chung: gửi yêu cầu ngắn cho điều phối trước khi sửa.
- V1 đơn giản: Zalo OA → chuẩn bị đơn → khách xác nhận → nhân viên duyệt → Windows/Ricoh đen trắng → kiểm tra/giao/đối soát. Không sửa app khác. Không tự merge/deploy; chỉ thực hiện khi chủ đã cho phép.
- Duyệt đúng phiên bản; sửa đáng kể phải xác nhận/duyệt lại. Đã gửi hoặc chưa rõ kết quả: giữ đối soát, không tự gửi lại. Chỉ chủ duyệt in lại. Spooler không chứng minh giấy đã in đủ.
- AI không định giá. >150 tờ vật lý hoặc nhân viên đánh dấu chi phí đáng kể phải khách xác nhận giá. Thiếu cọc vẫn được duyệt sau cảnh báo và ghi thiếu.
- Tách trạng thái hội thoại, đơn, in, giao và tiền. Đóng ngoại lệ đúng quyền, giữ khoản phải thu/phải hoàn và lượng giấy chưa giao; không tự hoàn tiền, tiêu hủy hoặc xóa công nợ.
- Trực tiếp làm và tự kiểm thử. Ghi rõ kiểm thử thật/mô phỏng/chưa chạy. Thiếu thiết bị/tài khoản vẫn làm phần có thể làm; không giả kết quả.
- Giao tiếp ngắn: kết quả, lỗi, hành động tiếp theo. Chỉ hỏi điều ảnh hưởng nghiệp vụ hoặc chặn công việc. Không kể suy luận dài, không chép lại đặc tả. Việc thường lệ đã được giao thì tự hoàn tất.

Bàn giao tối đa 6 dòng:
1. AI / mã việc / DONE hoặc BLOCKED.
2. Nhánh / BASE SHA / commit / PR nếu có; chưa có thì ghi rõ.
3. Đã làm / file thay đổi.
4. Kiểm thử + kết quả + bằng chứng hoặc lệnh chạy.
5. Chưa kiểm chứng / lỗi còn lại / phụ thuộc.
6. Việc AI tiếp theo cần làm.

Yêu cầu liên AI: [AI nhận] [mã việc] [cần gì + đường dẫn] [lý do 1 câu] [điều kiện xong].
DONE chỉ nghĩa phạm vi được giao đã đạt kiểm tra tương ứng; không đồng nghĩa V1 đã nghiệm thu.
