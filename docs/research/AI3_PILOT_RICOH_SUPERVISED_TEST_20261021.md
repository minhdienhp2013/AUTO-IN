# Hướng dẫn thử có giám sát Word/PDF trên Ricoh

**Trạng thái:** CHỈ CHUẨN BỊ — chưa kết nối OA, chưa chạy trên Windows, chưa gửi lệnh in.

**Contract:** Draft PR #163, base F7 `f7bad4d6039e8f486c0654b18fdbfb3b14763c2f`.
**Fixture công khai:** Draft PR #165, `public-one-page.pdf` SHA-256 `75ff2ebf9db02e33aa38619578e0744769babf68edef8c7045f86f1f365f5910`, `public-one-page.docx` SHA-256 `5c8a1c98a0f3d1117b7f5b2b630609b2b67eadd26be9df24bb62b41a1962f81e`.

## Điều kiện trước khi đặt giấy

1. AI0 phải nối route Core thật cho `PilotWordPdfCandidate` + `PilotPrintAuthorization`; claim, preflight và mark-sending phải đọc lại cùng revision/source/settings/printer/evidence. Mỗi authorization pilot tạo tối đa một job; default pilot off. Không tạo ticket hoặc authorization bằng JSON/CLI do người dùng tự nhập.
2. AI0/AI1 chốt một test vector chính thức cho cách tính `settings_sha256` và `evidence_sha256`, body/response của claim/preflight/mark-sending, cùng cách Core gửi byte nguồn riêng tư cho Agent. Code AI3 hiện dùng canonical serializer hiện có cho settings; evidence digest được so với Core ở cả preflight và mark-sending.
3. AI2 có ingress OA đã xác thực và custody source; AI5/AI6 đã chạy acceptance trên đúng SHA tích hợp. Dùng shop thử riêng. Mã thô, bearer token, tài liệu khách và nội dung file không được ghi vào log.
4. Windows host có Microsoft Word/COM, pywin32, SumatraPDF đã cài theo nguồn kiểm soát và SHA-256 được pin, thư mục spool/journal local có ACL chỉ cho service account, SYSTEM và Administrators. Không dùng UNC, thư mục chia sẻ, desktop người dùng hay máy in mặc định.
5. Queue dành riêng cho Agent phải khớp cấu hình `printer_id=RMP7000`, tên queue, driver Ricoh/PCL6 và port đã khảo sát. Người đứng máy xác nhận trực tiếp đúng Ricoh IM7000, khay A4 và chế độ đen trắng. Windows queue/port không chứng minh được số serial hoặc tình trạng giấy; ghi nhận các mục đó bằng quan sát tại máy.
6. Chốt trước chính sách lật cạnh. Contract #163 hiện chỉ có `duplex: boolean`; adapter tạm ánh xạ duplex sang lật cạnh dài. Không thử duplex thật cho tới khi AI0 xác nhận đây là quy tắc V1 hoặc contract bổ sung trường binding.

Thiếu bất kỳ điều kiện nào thì dừng ở `NEEDS_HUMAN`; không dùng ticket mô phỏng để mở lệnh thật. PR #163/#165 còn là Draft và chưa chứng minh OA hoặc Ricoh thật.

## Trình tự thử một lần

1. Chủ cửa hàng phê duyệt riêng thời gian thử, máy, người đứng máy và số tờ. Ghi SHA tích hợp chính xác; xác nhận service đang dùng queue dành riêng và journal mới/đã đối soát.
2. Chạy mô phỏng trước với hai file công khai ở trên. Xác nhận nguồn DOCX đi vào Microsoft Word và nguồn PDF đi vào PDF renderer, hash/settings/job/printer khớp ticket, Core trả `AUTHORIZED`, journal được ghi trước mark-sending và mock driver được gọi đúng một lần. Đây chỉ là test mô phỏng.
3. Khi mọi gate trên đạt và có phê duyệt riêng, dùng cùng một public fixture tại một lượt. Tạo test authorization qua Core test shop, không sửa ticket bằng tay. Bắt đầu với một bản, A4, đen trắng, một mặt. Thử PDF trước; dừng và đối chiếu tờ giấy với fixture. Sau khi ghi kết quả và xác nhận không có trạng thái UNKNOWN, mới làm một lượt DOCX riêng.
4. Ghi lại exact SHA, job ID, revision, source SHA, settings SHA, printer ID/queue/driver/port, trạng thái Core/Agent, số job spooler, số tờ thực tế, một/hai mặt, khay, độ rõ và người đối soát. Không ghi mã shop hay token.
5. Agent `SENT_UNVERIFIED` chỉ có nghĩa ứng dụng/driver đã nhận lệnh; người đứng máy ghi nhận giấy riêng. Không chuyển trạng thái in thành hoàn tất chỉ từ spooler ACK.

## Dừng và đối soát

- Mất ACK, timeout, Word/COM treo, Sumatra/driver lỗi sau ranh giới gửi, máy offline hoặc kết quả không chắc chắn: giữ `UNKNOWN`, dừng queue/job thử, **không chạy lại và không gửi lại**. Khi Agent khởi động lại, journal unresolved chuyển `UNKNOWN`; Agent chỉ report trạng thái, không gọi native driver lần nữa.
- Đối chiếu hàng đợi Windows, panel Ricoh và giấy thực tế. Chỉ chủ cửa hàng quyết định có tạo một job mới sau khi đối soát; mã mới hoặc restart không mở lại job cũ.
- Spooler nhận job, số job spooler hoặc báo “success” của ứng dụng không chứng minh số bản, mặt in, độ rõ hay giấy đã ra đủ.

## Chưa kiểm chứng

- Windows ACL, Word COM PrintOut, phân trang/font tiếng Việt, cấu hình duplex của Ricoh, Sumatra version/hash, queue/driver/port thật và giấy thật đều NOT RUN.
- Adapter AI3 hiện có `PilotBackendPort`, chưa có transport HTTP nối Core route pilot trên F7. `WindowsNativePrinter` chưa được gọi trong test; test mới dùng fake printer port.
- Windows queue không đọc được serial máy thật trong adapter này; người vận hành phải xác nhận model/serial tại chỗ trước lượt có giấy.
- Mọi ca Zalo OA thật, Core/PostgreSQL, Actions mới, Ricoh thật và giấy thật đều NOT RUN trong lượt này.
