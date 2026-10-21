# Hướng dẫn thử có giám sát Word/PDF trên Ricoh

**Trạng thái:** CHỈ CHUẨN BỊ — chưa kết nối OA, chưa chạy trên Windows, chưa gửi lệnh in.

**Wire:** AI0 pilot wire khóa ngày 21/10/2026, bắt đầu từ F7 `f7bad4d6039e8f486c0654b18fdbfb3b14763c2f`; AI3 dùng lane Core pilot riêng, không thay route duyệt/in cũ.
**Fixture công khai:** `public-one-page.pdf` SHA-256 `75ff2ebf9db02e33aa38619578e0744769babf68edef8c7045f86f1f365f5910`, `public-one-page.docx` SHA-256 `5c8a1c98a0f3d1117b7f5b2b630609b2b67eadd26be9df24bb62b41a1962f81e`.

## Điều kiện trước khi đặt giấy

1. `PilotHttpBackendClient` gọi lane Core pilot riêng cho `PilotWordPdfCandidate` + `PilotPrintAuthorization` qua `/internal/v1/pilot/print-jobs/claim`, `/source`, `/preflight`, `/mark-sending` và `/reports`; đây không phải route duyệt/in cũ. Trước khi thử thật, xác minh các route trên đúng SHA tích hợp trong môi trường thử cô lập. Claim, preflight và mark-sending phải đọc lại cùng revision/source/settings/printer/evidence. Mỗi authorization pilot tạo tối đa một job; pilot mặc định tắt. Không tạo ticket hoặc authorization bằng JSON/CLI do người dùng tự nhập.
2. Wire đã chốt `settings_sha256` bằng JSON canonical; vector settings được kiểm trong unit test AI3. Core tạo `evidence_sha256`; Agent đối chiếu digest và các binding ở preflight/mark-sending. Trước thử thật vẫn phải xác minh đúng SHA tích hợp và route Core hoạt động trong môi trường thử cô lập.
3. Trước thử thật, xác minh ingress OA và custody source của AI2 cùng acceptance AI5/AI6 trên đúng SHA tích hợp. Dùng shop thử riêng. Mã thô, bearer token, tài liệu khách và nội dung file không được ghi vào log.
4. Windows host có Microsoft Word/COM, pywin32, SumatraPDF đã cài theo nguồn kiểm soát và SHA-256 được pin, thư mục spool/journal local có ACL chỉ cho service account, SYSTEM và Administrators. Không dùng UNC, thư mục chia sẻ, desktop người dùng hay máy in mặc định.
5. Queue dành riêng cho Agent phải khớp cấu hình `printer_id=RMP7000`, tên queue, driver Ricoh/PCL6 và port đã khảo sát. Người đứng máy xác nhận trực tiếp đúng Ricoh IM7000, khay A4 và chế độ đen trắng. Windows queue/port không chứng minh được số serial hoặc tình trạng giấy; ghi nhận các mục đó bằng quan sát tại máy.
6. Quy tắc duplex đã chốt: `duplex=true` là A4 lật cạnh dài; `false` là một mặt. Chỉ thử duplex sau khi driver/DEVMODE đọc lại đúng giá trị cạnh dài trên Windows thử nghiệm; chính sách giấy thật chưa được kiểm chứng.
7. DOCX mở trong worker Word riêng, đặt A4 trong bộ nhớ, giữ hướng gốc, đếm lại trang rồi gọi `PrintOut` đúng một lần. Deadline hoặc worker ACK không rõ thành `UNKNOWN`; không gửi lại. Mỗi section được đặt A4 trước khi đếm, nhưng font/Word/driver thật vẫn phải được kiểm thử trên host Windows.
8. Agent kiểm tra settings trước khi gửi. Với duplex, chỉ chấp nhận DEVMODE lật cạnh dài; nếu driver trả giá trị khác hoặc không đọc lại được thì dừng. Chưa có kết quả từ driver/Ricoh thật.
9. DEVMODE dùng mặc định theo tài khoản Agent (Win32 level 9), đọc lại A4/đen trắng và simplex hoặc long-edge duplex theo yêu cầu, rồi khôi phục cấu hình cũ. Nếu không đọc lại/xác minh/khôi phục được thì dừng; không thay global default của queue.

Thiếu bất kỳ điều kiện nào thì dừng ở `NEEDS_HUMAN`; không dùng ticket mô phỏng để mở lệnh thật. Code, unit test hoặc trạng thái PR không chứng minh OA hay Ricoh thật đã được kiểm thử.

## Trình tự thử một lần

1. Chủ cửa hàng phê duyệt riêng thời gian thử, máy, người đứng máy và số tờ. Ghi SHA tích hợp chính xác; xác nhận service đang dùng queue dành riêng và journal mới/đã đối soát.
2. Chạy DryRun qua Core simulation với fixture công khai. Xác nhận HTTP gọi claim → source → preflight → mark-sending → report; job/source/settings/evidence/printer khớp ticket; kết quả `SIMULATED_DONE`, `driver_called=false`, `spooler_ack=false`. DryRun không mở Word, Sumatra, spooler hoặc Ricoh. Mock-driver assertions chỉ thuộc unit test AI3; chúng không chứng minh DryRun đã gọi driver.
3. Khi mọi gate trên đạt và có phê duyệt riêng, dùng cùng một public fixture tại một lượt. Tạo test authorization qua Core test shop, không sửa ticket bằng tay. Bắt đầu với một bản, A4, đen trắng, một mặt. Thử PDF trước; dừng và đối chiếu tờ giấy với fixture. Sau khi ghi kết quả và xác nhận không có trạng thái UNKNOWN, mới làm một lượt DOCX riêng.
4. Ghi lại exact SHA, job ID, revision, source SHA, settings SHA, printer ID/queue/driver/port, trạng thái Core/Agent, số job spooler, số tờ thực tế, một/hai mặt, khay, độ rõ và người đối soát. Không ghi mã shop hay token.
5. Agent `SENT_UNVERIFIED` chỉ có nghĩa ứng dụng/driver đã nhận lệnh; người đứng máy ghi nhận giấy riêng. Không chuyển trạng thái in thành hoàn tất chỉ từ spooler ACK.

## Dừng và đối soát

- Mất ACK, timeout, Word/COM treo, Sumatra/driver lỗi sau ranh giới gửi, máy offline hoặc kết quả không chắc chắn: giữ `UNKNOWN`, dừng queue/job thử, **không chạy lại và không gửi lại**. Khi Agent khởi động lại, journal unresolved chuyển `UNKNOWN`; Agent chỉ report trạng thái, không gọi native driver lần nữa.
- Đối chiếu hàng đợi Windows, panel Ricoh và giấy thực tế. Chỉ chủ cửa hàng quyết định có tạo một job mới sau khi đối soát; mã mới hoặc restart không mở lại job cũ.
- Spooler nhận job, số job spooler hoặc báo “success” của ứng dụng không chứng minh số bản, mặt in, độ rõ hay giấy đã ra đủ.

## Chưa kiểm chứng

- PostgreSQL, Zalo OA thật, Windows ACL, Word COM PrintOut, phân trang/font tiếng Việt, cấu hình duplex của Ricoh, Sumatra version/hash, queue/driver/port thật và giấy thật đều NOT RUN.
- `PilotHttpBackendClient` dùng các route riêng `/internal/v1/pilot/print-jobs/claim`, `/{job_id}/source`, `/{job_id}/preflight`, `/{job_id}/mark-sending` và `/{job_id}/reports`. Source được tải bằng GET có Bearer agent, `X-AUTO-IN-Pilot-Lease`, `Cache-Control: no-store` cùng header SHA-256/kích thước. Test loopback dùng Core tổng hợp; chưa chứng minh PostgreSQL hay OA live.
- Unit test AI3 dùng COM/process mock để kiểm tra native adapter. `run_pilot_dryrun_once` không gọi mock hoặc native driver; nó chỉ chạy nhánh simulation và báo `driver_called=false`. `WindowsNativePrinter`/Word/Sumatra thật chưa chạy trên Windows.
- Windows queue không đọc được serial máy thật trong adapter này; người vận hành phải xác nhận model/serial tại chỗ trước lượt có giấy.
- Mọi ca PostgreSQL, Zalo OA thật, Windows/Word/Sumatra, Ricoh thật và giấy thật đều NOT RUN trong lượt này. Lệnh in có giấy chỉ là thủ tục tương lai, phải qua đầy đủ gate ở trên, dùng exact SHA tích hợp, có chủ duyệt riêng và người đứng máy; tài liệu này không mở quyền chạy.
