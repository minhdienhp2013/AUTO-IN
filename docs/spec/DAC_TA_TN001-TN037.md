# Đặc tả nghiệp vụ in tự động Minh Điến — TN-001–TN-037

Nội dung trích từ bản Word chốt 11/10/2026, gồm TN-005A. Bản Word cùng thư mục là nguồn gốc; bản này giữ nguyên câu chữ và thứ tự các đoạn/bảng, đổi cách trình bày để AI đọc thuận tiện. Không phải bằng chứng đã triển khai hay đã nghiệm thu.

TÀI LIỆU ĐẶC TẢ NGHIỆP VỤ

PHẦN MỀM IN TỰ ĐỘNG MINH ĐIẾN

Phiên bản nghiệp vụ: 1.0  |  Ngày chốt: 11/10/2026  |  Trạng thái: ĐÃ CHỐT QUY TẮC, CHƯA TRIỂN KHAI

Phạm vi: Zalo Official Account → DeepSeek và bộ quy tắc → khách xác nhận → nhân viên duyệt → Windows → Ricoh IM7000 → kiểm tra, bàn giao và đối soát.

| Hạng mục | Quyết định |
| --- | --- |
| Mục đích | Tự động chuẩn bị đơn in thường gặp; nhân viên duyệt mọi lệnh in; giảm thao tác nhưng bảo đảm kiểm soát. |
| Thiết bị bản 1.0 | Ricoh IM7000 (hàng đợi RMP7000), Windows 11 Pro 25H2; LAN 192.168.1.195, RAW TCP 9100, driver PCL6 V4 Universal. |
| Ngoài phạm vi tự in bản 1.0 | Canon G1010 và Canon iX6770; in màu xử lý thủ công; tách trang màu tự động và các chức năng học AI nâng cao để sau. |
| Phê duyệt | Nhân viên có tài khoản hợp lệ duyệt lệnh in. Chỉ chủ cửa hàng phê duyệt in lại, các ngoại lệ tài chính/đã in và đưa hệ thống vào hoạt động chính thức. |
| Nguyên tắc an toàn | Không in chưa duyệt, không in trùng, không suy diễn hoàn tất từ trạng thái gửi lệnh, không tự hoàn tiền hay tiêu hủy giấy. |

Bản này tổng hợp các quyết định nghiệp vụ TN-001 đến TN-037 cùng TN-005A đã được trao đổi/chốt. Những điểm chưa kiểm chứng kỹ thuật được ghi rõ ở Phần V; tài liệu không xác nhận Zalo OA, DeepSeek hoặc Ricoh đã được tích hợp thành công.

I. TỔNG QUAN VÀ PHẠM VI

1. Nguyên tắc vận hành

AI xử lý yêu cầu in ấn, không tự đảm nhận bán nội thất/hàng hóa; nội dung hỏi mua hàng được chuyển người phụ trách.

Khách xác nhận yêu cầu; tất cả lệnh in thật phải được nhân viên có quyền duyệt. Không cho AI tự gửi lệnh chỉ dựa vào sự đồng ý của khách.

Đơn lớn trên 150 tờ hoặc phức tạp được cảnh báo để chủ chọn tiếp quản thủ công hay để AI tiếp tục chuẩn bị; không ép tự động tất cả.

Không xây kiến trúc quá phức tạp ở bản 1.0; repo độc lập, không tự merge/deploy nếu chủ chưa cho phép.

Giờ mặc định AI: 07:00–21:30. Chủ được chỉnh lịch ngày đặc biệt kể cả ngoài khung này. Ngày nghỉ AI tư vấn theo lịch nhưng không gửi in thật.

Ricoh IM7000 là máy đen trắng chính; Canon màu được giữ cho giai đoạn nâng cấp, nhưng yêu cầu in màu vẫn được tiếp nhận và xử lý thủ công.

2. Luồng xử lý điển hình

Tiếp nhận tin và file từ Zalo OA; gom tin theo TN-001.

Xác định có phải yêu cầu in, kiểm tra file và nội dung; hỏi bổ sung nếu thiếu.

Chuẩn bị phiên bản đơn, đếm trang/tờ bằng công cụ thực, tạo preview theo định dạng gốc.

Khách xác nhận thông số; đơn >150 tờ hoặc được đánh dấu chi phí đáng kể phải xác nhận giá do nhân viên nhập.

Nhân viên kiểm tra, xác nhận điều kiện cọc nếu có và duyệt đúng phiên bản đơn.

Windows agent chỉ gửi tới Ricoh nếu cửa hàng cho phép in, lệnh chưa từng gửi và không có khóa thủ công.

Xác minh kết quả in, kiểm tra chất lượng, thông báo sẵn sàng nhận, ghi bàn giao và thanh toán.

II. TOÀN BỘ QUY TẮC ĐÃ CHỐT

A. Tiếp nhận, AI và hội thoại

TN-001  |  Gom và hiểu tin nhắn

Sau tin nhắn đầu tiên, gom tối đa 60 giây; tin nhắn kế tiếp gom trong khoảng 10 giây. AI có thể trả lời sớm khi đã chắc chắn yêu cầu đủ thông tin. Các tin ngắn liên tiếp thuộc đúng cuộc hội thoại/phiên, không tách thành nhiều đơn vô cớ.

TN-002  |  Giới hạn phạm vi hỏi đáp

AI ưu tiên phần in ấn. Nếu khách đồng thời hỏi mua nội thất/hàng hóa, AI vẫn xử lý in và thông báo riêng người phụ trách phần mua hàng; AI không tự nhận làm nhân viên bán nội thất.

TN-003  |  Giờ AI mặc định

AI chỉ trả lời trong lịch có hiệu lực. Mặc định 07:00–21:30 theo giờ Việt Nam; ngoài giờ im lặng, vẫn nhận và lưu tin/file. Quyền sửa lịch ngoại lệ của chủ được làm rõ ở TN-028 và quyết định cuối về giờ đặc biệt.

TN-004  |  Định dạng và số lượng tài liệu

Tiếp nhận/phân loại PDF, Word và ảnh; Excel giao nhân viên; định dạng khó/lỗi cũng chuyển người. Nếu đơn có trên 5 tài liệu thực (ZIP phải đếm file tài liệu bên trong) thì yêu cầu người kiểm tra. Hỗ trợ kỹ thuật của Zalo cần kiểm chứng ở TN-022.

TN-005  |  Phân loại yêu cầu in

Quy tắc nhận diện văn bản, bài tập, ảnh và nhu cầu màu/đen trắng; đề xuất phương án thông dụng nhưng không tự khẳng định khi thiếu thông tin. Bản 1.0: phân trang màu/đen trắng phức tạp do nhân viên thủ công; ảnh chụp văn bản không bắt buộc OCR rồi dựng lại.

TN-005A  |  Tiết kiệm chi phí xử lý

Ưu tiên công cụ xử lý nội bộ (đọc cấu trúc tài liệu, PyMuPDF/OCR nội bộ/rules), cache phù hợp và chỉ gọi DeepSeek khi thực sự cần hiểu yêu cầu hoặc trường hợp không rõ. Không dùng LLM để ước lượng số trang thay cho kết xuất. Theo dõi token, chi phí, không gửi tài liệu nhạy cảm ra ngoài nếu không cần thiết.

TN-006  |  Cách trả lời và trí nhớ theo khách

Xưng hô “tôi–bạn”, gọn, rõ, không bịa giá hoặc báo đã in khi chưa có bằng chứng. Quy tắc quen của khách phải được khách xác nhận khi áp dụng; yêu cầu hiện tại của khách luôn ưu tiên hơn thói quen cũ. Khi nhân viên tiếp quản, AI dừng đúng hội thoại.

TN-007  |  Xác nhận và duyệt lệnh

Khách xác nhận yêu cầu trước, nhân viên hợp lệ duyệt trước khi in thật. Hàng đợi xếp theo thời điểm khách hoàn tất xác nhận, đơn thiếu thông tin không chặn đơn khác. Thay đổi đáng kể phải xác nhận lại. Quyền nhân viên được cập nhật bởi TN-017.

TN-008  |  Cảnh báo và thông báo

Thông báo tới iPhone và Windows cho đơn chờ duyệt, cần người, hủy hoặc lỗi máy; chạm thông báo mở đúng đơn. Ưu tiên thử PWA/Web Push trên iPhone, không giả định chắc chắn thông báo luôn tới. Ngoài giờ chỉ ưu tiên cảnh báo khẩn, thông báo thường theo lịch.

B. Máy in, dữ liệu và tính ổn định

TN-009  |  Định tuyến máy in

Máy điều khiển in Windows sử dụng danh sách máy/capability thật; không phụ thuộc máy in mặc định. Ricoh IM7000 xử lý đen trắng/duplex; Canon màu bản 1.0 để thủ công. Thay máy in đích phải được nhân viên xác nhận; lỗi kết nối giữ hàng đợi an toàn.

TN-010  |  QR tại quầy

Dùng QR tĩnh để mở Zalo OA trước; QR động/màn hình nâng cao triển khai sau. QR không chứng minh khách đang ở cửa hàng. Nhân viên có thể đánh dấu “Khách tại quầy” và sắp xếp ưu tiên riêng. Zalo cá nhân được xử lý thủ công.

TN-011  |  Riêng tư và hạn lưu file

Lưu tài liệu gốc, preview, OCR/cache tối đa 30 ngày sau khi đơn hoàn tất hoặc được đóng hợp lệ rồi xóa theo chính sách. Chỉ người được cấp quyền được xem. Yêu cầu xóa hợp lệ/đã xác minh cần được thực hiện kịp thời trong phạm vi hệ thống được kiểm soát. Thời hạn cho đơn chưa đóng cần chính sách giám sát và đóng ngoại lệ ở TN-031/036; bản sao lưu và nghĩa vụ pháp lý cần đánh giá riêng.

TN-012  |  Phục hồi và chống in trùng

Tải file Zalo lỗi có thể thử lại tối đa 2 lần rồi chuyển người. DeepSeek lỗi thì giữ yêu cầu/hàng đợi; không làm mất đơn. Mất mạng/Windows tắt: chỉ tự tiếp tục tác vụ đã duyệt và chắc chắn chưa từng gửi. Tác vụ đã gửi hoặc không rõ kết quả giữ lại kiểm tra; không tự in lại. Khử webhook/lệnh bị lặp.

TN-013  |  Theo dõi chi phí

Mục tiêu chi phí Zalo OA + AI + server/cloud là 2–3 triệu đồng/tháng (không tính giấy/mực/điện). Theo dõi chi phí theo nhóm công việc/đơn, cache hợp lý; cảnh báo ở mức 80%, 95%, 100%. Vượt hạn mức AI không được làm mất đơn.

TN-014  |  Học thói quen và quy tắc

Lưu quy tắc chung và riêng theo khách, có giao diện xem/sửa, lịch sử phiên bản và khả năng khôi phục. AI có thể phát hiện thói quen mới để đề xuất nhưng chỉ hiệu lực sau khi người quản lý phê duyệt; phần học chủ động nâng cao để sau bản 1.0.

TN-015  |  Thử nghiệm vận hành

Kiểm thử 30 đơn/ngày trong 7 ngày (210 ca), mô phỏng tải 100 đơn/ngày; chủ cửa hàng nghiệm thu. Không chấp nhận trường hợp in chưa duyệt hoặc in trùng. Kết hợp thử file, điện thoại, Ricoh, khôi phục, bảo mật và các tình huống lỗi.

TN-016  |  Phạm vi phát triển bản 1.0

Làm sản phẩm đầu-cuối Zalo → AI → khách xác nhận → nhân viên duyệt → in thật → bàn giao, nhưng giới hạn tính năng để ổn định. Repo riêng, không sửa các app hiện có, không tự merge hoặc deploy. Quy tắc khách quen chỉ ở mức cơ bản; công cụ nâng cao để các bản sau.

TN-017  |  Vai trò và quyền hạn

Nhân viên hợp lệ được duyệt in thật, tiếp quản và cập nhật đơn trong quyền được cấp. Chỉ chủ phê duyệt in lại/in bổ sung sau lỗi; chủ quản lý cấu hình nhạy cảm và các ngoại lệ quan trọng. Lưu lịch sử người thực hiện; tránh hai nhân viên cùng thay trạng thái.

TN-018  |  Văn bản dài thành tài liệu

Khách gửi văn bản dài qua Zalo: giữ nội dung chính xác, không tự viết lại; hỏi định dạng nếu cần, mặc định đề xuất A4/Times New Roman cỡ 14 nếu chưa có yêu cầu. Khách xác nhận bố cục; dùng trình kết xuất tài liệu để xem preview và đếm số trang thật.

C. Thanh toán, khách hàng và xác minh khả năng thật

TN-019  |  Cọc đơn nhiều giấy

Đơn trên 150 tờ giấy thực tế được cảnh báo xem xét đặt cọc; nhân viên quyết định có yêu cầu cọc và mức cọc. Không tự ấn định tiền cọc hoặc hoàn cọc. Quy tắc sau cùng TN-033 cho phép nhân viên duyệt dù chưa thu đủ cọc sau khi xem cảnh báo và ghi nhận khoản thiếu.

TN-020  |  Hồ sơ khách

Thông tin khách và thói quen in lưu 24 tháng từ lần giao dịch cuối theo quy tắc đã chốt; tách khỏi vòng đời file khách. Không giữ nguyên nội dung tài liệu/OCR đã quá hạn chỉ để phục vụ cá nhân hóa. Quyền xóa và nghĩa vụ lưu theo pháp luật đánh giá riêng.

TN-021  |  Tiêu chí chính xác

Độ chính xác nhận diện ≥90%; tỷ lệ tự xử lý yêu cầu hội thoại thông dụng trong phạm vi bản 1.0 ≥80%. Bước nhân viên duyệt bắt buộc không bị tính là thất bại của AI. Tách phép đo chuyển người hợp lệ với lỗi nhận diện; lỗi in sai nghiêm trọng, in trùng, lộ dữ liệu là chỉ tiêu không chấp nhận.

TN-022  |  Kiểm chứng Zalo OpenAPI

Trước khi kết nối thật, thử app/OA đã cấp quyền với tin nhắn, PDF/Word/ảnh/ZIP/Excel, giới hạn dung lượng, tải file, thời hạn URL, webhook lặp, kiểm tra bảo mật/token, giới hạn gửi và phân quyền. Không đồng nhất hạn mức tải lên của OA với hạn mức file khách gửi vào. Định dạng không hỗ trợ chuyển phương án khác hoặc nhân viên.

TN-023  |  Thiết bị thực tế và xác nhận in xong

Windows 11 Pro 25H2; hàng đợi RMP7000 đã được chủ xác nhận chính là Ricoh IM7000; IP 192.168.1.195, RAW TCP 9100, driver PCL6 V4 Universal; SNMP kiểm tra trạng thái trên cổng đang tắt. Canon iX6770 dùng USB002, Canon G1010 chưa khảo sát, đều để sau bản 1.0. Chỉ tự báo in xong khi có bằng chứng thiết bị đủ tin cậy; nếu Windows chỉ báo đã gửi thì nhân viên xác nhận sau kiểm tra.

TN-024  |  Lịch sử và nhật ký

Ghi đơn, nhân viên duyệt, máy, số bản, trạng thái, lỗi, in lại, cọc, bàn giao. Lịch sử vận hành thông thường lưu 24 tháng. Nội dung file và preview xóa theo TN-011; chứng từ phải lưu theo quy định pháp luật được quản lý riêng.

TN-025  |  Trang, mặt in và tờ giấy

Tính riêng số trang tài liệu, số mặt in và tờ giấy vật lý theo file, số bản, in một/hai mặt, vùng giấy và ngắt bản. Mặc định in từng file và từng bản riêng, không tự ghép hai tài liệu trên cùng tờ hai mặt; chỉ ghép khi được yêu cầu và xác nhận. Dùng tờ giấy vật lý để xác định ngưỡng trên 150 tờ.

TN-026  |  Sửa đơn và thêm file

Lưu từng phiên bản đơn. Nếu khách thêm file/đổi số bản, giấy, mặt in khi lệnh chắc chắn chưa gửi: giữ lệnh cũ, tạo phiên bản mới, tính lại, khách xác nhận lại, nhân viên duyệt lại. Lệnh đã gửi/không rõ kết quả không tự sửa/in lại. Yêu cầu hủy trong lúc đang in phải báo khẩn để người kiểm tra.

TN-027  |  Nhân viên tiếp quản AI

AI dừng gửi tin ngay khi nhân viên tiếp quản và chặn phản hồi đang soạn; tin/file vẫn được tiếp nhận. Các khách khác không bị ảnh hưởng. Tránh ghi đè giữa hai nhân viên. Chỉ nhân viên chủ động “Trả lại cho AI” mới tiếp tục; không tự bật theo thời gian hoặc sau đóng đơn.

D. Lịch, in, giao và đơn tồn

TN-028  |  Ngày nghỉ và giờ hoạt động ngoại lệ

Giờ mặc định 07:00–21:30. Chủ được đặt giờ đặc biệt kể cả ngoài khung này cho ngày cụ thể; AI chỉ trả lời trong lịch hiệu lực. Ngày nghỉ cửa hàng AI vẫn tư vấn theo lịch nhưng KHÔNG gửi lệnh in thật. Có nút tạm dừng AI, chặn cả câu trả lời đang xử lý, chỉ người được quyền chỉnh lịch. Đơn đã duyệt giữ chờ mở cửa theo TN-035.

TN-029  |  Khổ giấy, tỷ lệ và duplex

Ricoh IM7000 là máy in đen trắng bản 1.0; giữ khổ A4/A3, chiều, số bản, lật cạnh dài/ngắn, từng file riêng. Mặc định chỉ thu nhỏ khi cần để vừa vùng in, giữ tỷ lệ, không tự phóng lớn. Nếu có rủi ro ảnh hưởng kích thước quan trọng, chữ sát mép hay cấu hình chưa rõ thì hỏi hoặc chuyển người. Phải thử driver/khay thật.

TN-030  |  Giao hàng, thu tiền và đóng đơn

Tách đang in → in xong/chờ kiểm tra → sẵn sàng giao → đã giao → đóng đơn. Nhân viên kiểm tra chất lượng, xác nhận bàn giao thủ công, ghi thời điểm/người giao, khoản cọc/đã thu/còn phải thu; hỗ trợ giao một phần. Không tự coi máy in xong là khách đã nhận hoặc tự đóng đơn chưa giao.

TN-031  |  Đơn bỏ dở và bản in khách chưa nhận

Khách chưa xác nhận: nhắc sau 24 giờ nếu giờ/ quyền Zalo cho phép; sau 72 giờ đánh dấu bỏ dở, nhân viên xem xét đóng, không tự xóa. Đã in/chờ nhận: nhắc sau 3 ngày, quá hạn sau 7 ngày, sau 30 ngày báo chủ xem xét bản giấy; không tự tiêu hủy, không xóa cọc/công nợ, vẫn giữ lịch sử.

TN-032  |  Chuyển sang vận hành chính thức

Có chế độ mô phỏng, thử nghiệm thật có kiểm soát, chính thức và an toàn. Sau khi kiểm thử đạt, chỉ chủ phê duyệt mở toàn bộ đơn hợp lệ ngay (không bắt buộc mở tăng dần 3 ngày). Bản 1.0 vẫn giữ bắt buộc nhân viên duyệt mọi lệnh và có thể về chế độ an toàn khi phát sinh lỗi.

TN-033  |  Giá, cọc và đơn lớn thủ công

AI không tự định giá. Đơn trên 150 tờ bắt buộc khách xác nhận giá do nhân viên nhập; đơn ít tờ nhưng nhân viên đánh dấu chi phí đáng kể cũng phải xác nhận, KHÔNG đặt ngưỡng tiền cố định. Đơn thường có thể thu khi giao. Tiền mặt/chuyển khoản do nhân viên xác minh thủ công; ảnh chuyển khoản không chứng minh đã nhận. Ghi giá/đã thu/còn phải thu, phiên bản giá, giao dịch cọc. Nếu cọc thiếu, nhân viên vẫn được duyệt sau cảnh báo và ghi khoản thiếu. Đơn >150 tờ hoặc phức tạp cảnh báo chủ chọn xử lý thủ công hay để AI tiếp tục.

TN-034  |  Preview, định dạng gốc và lỗi font

KHÔNG bắt buộc chuyển tất cả sang PDF. In từ PDF, Word, ảnh qua bộ xử lý tương ứng; preview được tạo theo đường xử lý phù hợp, so sánh với Ricoh thật. Khách nhận tóm tắt + một số trang đại diện nếu Zalo cho phép, có thể xem thêm/toàn bộ an toàn. Nhân viên xem đủ và kiểm tra cảnh báo. Thiếu font, file lỗi, preview không đáng tin: chuyển nhân viên, không tự in; khắc phục và xác nhận lại nếu đầu ra đổi. Khóa phiên bản nội dung/cấu hình in.

TN-035  |  Đối soát, in thủ công, khôi phục

Trước khi in ngoài phần mềm, nhân viên có quyền PHẢI đặt đơn “Xử lý thủ công” để khóa tự động và kiểm tra lệnh đang chạy; sau in ghi kết quả thực. Windows mở lại/ngày nghỉ kết thúc: tự tiếp tục chỉ những đơn đã duyệt, còn hiệu lực, chắc chắn chưa gửi và an toàn, không duyệt lại. Lệnh đã gửi/không rõ kết quả phải kiểm tra. Lưu ID đơn/tác vụ/phiên bản/người duyệt/thời gian; spooler không đủ bằng chứng in xong. Chỉ chủ duyệt in lại/bổ sung.

TN-036  |  Đóng ngoại lệ và đối soát tiền

Nhân viên được đóng đơn bỏ dở/hủy trước khi in nếu chưa thu tiền và chắc chắn không có lệnh in đang chạy. Nếu đã thu cọc, cần hoàn tiền, đã in, hoặc khách không nhận sau 30 ngày: chủ phê duyệt. Chủ có thể đóng phần xử lý in theo diện ngoại lệ dù còn công nợ/khoản phải hoàn, vẫn theo dõi tiền riêng, ghi giấy đã giao/chưa giao, tuyệt đối không giả giao đủ. Không tự hoàn tiền, không tự tiêu hủy giấy, phân biệt duyệt hoàn với thực hoàn.

TN-037  |  Nghiệm thu cuối

Nhận diện ≥90%, tự xử lý yêu cầu hội thoại thông dụng ≥80%, 210 đơn đạt trong tối thiểu 7 ngày, mô phỏng tải 100 đơn/ngày. Không chấp nhận in chưa duyệt, in trùng, sai bản in nghiêm trọng, lộ/mất dữ liệu. Lỗi nghiêm trọng: dừng, sửa, kiểm thử lại ca liên quan, tích lũy đủ 210 ca đạt trong tối thiểu 7 ngày không lỗi nghiêm trọng; loại ca thuộc bản lỗi. Chỉ chủ duyệt báo cáo và mở vận hành thật.

III. PHÂN QUYỀN VÀ TRẠNG THÁI NGHIỆP VỤ

1. Phân quyền tối thiểu

| Hành động | Nhân viên hợp lệ | Chủ cửa hàng |
| --- | --- | --- |
| Tiếp nhận, xem và chuẩn bị đơn | Theo quyền truy cập | Có |
| Duyệt lệnh in lần đầu | Có | Có |
| Tiếp quản/trả hội thoại AI | Có theo quyền | Có |
| Chuyển in thủ công trước khi in ngoài | Có theo quyền | Có |
| Duyệt in lại/in bổ sung sau lỗi | Không | Có |
| Nhập giá, cọc, xác nhận tiền nhận | Có theo quyền | Có |
| Đóng ngoại lệ chưa in, chưa thu tiền, không có lệnh | Có | Có |
| Đóng ngoại lệ đã in/có cọc/cần hoàn/khách không nhận | Không | Có |
| Quyết định tiêu hủy giấy tồn | Không | Có |
| Chỉnh lịch AI, mở vận hành chính thức | Chỉ theo phân quyền lịch; không được mở chính thức | Có |

2. Các trục trạng thái phải tách riêng

| Trục | Ví dụ trạng thái / cảnh báo |
| --- | --- |
| Hội thoại | AI trả lời; AI cần người; nhân viên tiếp quản; đã trả quyền cho AI; ngoài giờ/tạm nghỉ |
| Khách/đơn | Đang bổ sung; chờ khách xác nhận; đã xác nhận; chờ duyệt; đã duyệt; sửa phiên bản; bỏ dở |
| Lệnh in | Chưa gửi chắc chắn; đang gửi; đã gửi/chưa rõ; in xong có chứng cứ; xử lý thủ công; khóa tự động; cần chủ duyệt in lại |
| Giao hàng | Chờ kiểm tra; sẵn sàng giao; đã giao một phần; đã giao đủ; chưa nhận/quá hạn; đóng ngoại lệ |
| Thanh toán | Chưa thu; yêu cầu cọc; nhận một phần; đã thu đủ; khoản thu dư; chờ hoàn; đã duyệt hoàn; đã hoàn thực tế; còn phải thu |

IV. CÁC ĐIỀU KIỆN AN TOÀN KHÔNG ĐƯỢC VI PHẠM

Không gửi lệnh in thật nếu thiếu khách xác nhận yêu cầu hoặc thiếu nhân viên có quyền duyệt bản đang có hiệu lực.

Không tự động in lại tác vụ đã gửi hoặc không rõ đã đến máy chưa; cần đối soát và chỉ chủ phê duyệt in lại.

Không dùng trạng thái “spooler đã gửi/hoàn thành” để kết luận bản giấy in đủ; không đồng nhất in xong với đã giao.

Không để AI tự đặt giá; đơn trên 150 tờ hay được đánh dấu chi phí đáng kể phải được khách xác nhận giá trước khi duyệt.

Không tự chặn cứng lệnh chỉ vì chưa thu đủ cọc nếu nhân viên đã xem cảnh báo và vẫn duyệt theo TN-033; phải lưu khoản thiếu.

Không âm thầm dùng preview, file hoặc giá của phiên bản cũ khi yêu cầu mới đã thay đổi.

Không tự trở lại AI khi nhân viên tiếp quản; không in tự động đơn đã chuyển thủ công.

Không gửi lệnh in thật trong ngày nghỉ dù AI đang tiếp tục tư vấn; sau mở cửa chỉ tiếp tục đơn chắc chắn chưa gửi.

Không tự đóng như đã giao, không tự hoàn tiền, không tự tiêu hủy giấy hoặc xóa công nợ/lịch sử khi đơn ngoại lệ.

Không khẳng định Zalo OpenAPI, PWA iPhone, xác nhận hoàn tất của Ricoh hoặc tính chính xác Word/preview đã hoạt động nếu chưa kiểm thử thực tế.

V. DANH SÁCH CẦN XÁC MINH KỸ THUẬT

Đây là điều kiện xác minh trước khi thiết kế chi tiết/triển khai và nghiệm thu; không phải quy tắc nghiệp vụ mới. “P0” là điều kiện an toàn cần kiểm chứng trước khi in thật, “P1” là điều kiện chất lượng/vận hành cần kiểm chứng trước khi nghiệm thu.

| Mức | Nhóm kiểm chứng | Bằng chứng/ca kiểm thử cần có |
| --- | --- | --- |
| P0 | Zalo OA / MDCO | Quyền webhook, nhận văn bản/file, đọc/tải file thật, event lặp, thứ tự và gắn khách/phiên; giới hạn kích thước/định dạng và thời hạn file; giới hạn gửi phản hồi, ảnh/preview, tin nhắc và ngoài giờ. |
| P0 | Danh tính, phân quyền | Xác thực chủ/nhân viên, quyền xem file nhạy cảm, duyệt và tiếp quản; hai nhân viên đồng thời; chống gửi yêu cầu giả/giả webhook; lưu nhật ký. |
| P0 | Ranh giới duyệt → in | Khóa phiên bản tài liệu và thông số, thao tác atomic/khóa cạnh tranh, chống nhấn hai lần/webhook lặp, hủy/sửa ngay khi chuẩn bị gửi. |
| P0 | Windows / Ricoh | Hàng đợi thực RMP7000, IP 192.168.1.195, RAW 9100, PCL6 V4; khởi động lại giữa lệnh, Spooler crash, mất mạng, kẹt giấy, có/không có bằng chứng hoàn tất đáng tin. |
| P0 | Thủ công đối soát | Chuyển thủ công trước lệnh, lệnh đã gửi/đang chạy không bị giả chưa gửi, in Word/PDF ngoài app không bị hệ thống gửi trùng khi khôi phục. |
| P0 | Tiền / quyền điều chỉnh | Ảnh chuyển khoản không tự xác nhận; cảnh báo cọc thiếu, bắt buộc xác nhận giá khi >150 tờ, đối soát hoàn tiền và đóng ngoại lệ đúng quyền. |
| P0 | An toàn file & riêng tư | File mật khẩu, ZIP chứa nhiều tài liệu, ZIP bomb/path traversal, file lỗi, giới hạn tải; dữ liệu nhạy cảm, token OA, quyền truy cập, lưu/xóa và bản sao lưu. |
| P1 | Word và ảnh in từ gốc | Chọn bộ xử lý Word/PDF/ảnh dùng thực tế trên Windows; chạy ổn định không có hộp thoại chặn; font tiếng Việt, thay font, bảng biểu, ngắt trang, Excel chuyển tay, ảnh EXIF/chiều trang. |
| P1 | Khổ giấy Ricoh | Khả năng khay A4/A3 thực tế, lật cạnh dài/ngắn, hai mặt, số bản, tách file/bản, scaling vừa vùng in không phóng lớn; thử in giấy để so với preview. |
| P1 | Preview khách/nhân viên | Tính nhất quán preview với đường in, thứ tự/trang cảnh báo, cách gửi tóm tắt và ảnh đại diện qua OA, đường xem thêm có xác thực và hạn dùng nếu áp dụng. |
| P1 | iPhone và Windows | Phê duyệt từ iPhone thật, khóa màn hình, mất mạng, PWA/Web Push, trạng thái đồng bộ đa thiết bị, mở đúng đơn, thông báo khẩn. |
| P1 | Ngân sách & tải | Đo số token DeepSeek, cache, chi phí OA/cloud, cảnh báo 80/95/100%; 100 đơn/ngày mô phỏng với nhiều khách và file cùng lúc. |

VI. PHẠM VI CHƯA ĐƯỢC XÁC MINH HOẶC CHƯA ẤN ĐỊNH THÔNG SỐ

Zalo OA:  Cần lấy kết quả kiểm tra quyền API, loại file thực nhận, hạn dung lượng, gửi preview và thông báo, giới hạn nhắn tin. Không bảo đảm tự động tiếp quản hội thoại khi nhân viên trả lời trực tiếp trên OA Manager nếu chưa có tín hiệu đồng bộ.

Thiết bị Ricoh:  Khay giấy, vùng in, khả năng trả về trạng thái hoàn tất đáng tin, trình điều khiển in tự động cho từng định dạng cần đo/kiểm thử. SNMP Status Enabled của cổng Windows hiện tắt nhưng chưa kết luận SNMP thiết bị có hay không.

Thanh toán:  Không có ngưỡng tiền cố định cho “chi phí đáng kể”; nhân viên đánh dấu theo đơn. Chưa chốt bảng giá bán cụ thể; giá do cửa hàng nhập. Không xây tính giá AI mặc định.

Tiền cọc đơn nhỏ:  Nguyên tắc đã chốt là đơn >150 tờ được nhắc xem xét cọc, đơn thường có thể thu khi giao; chưa có quyết định cấm tuyệt đối việc nhân viên yêu cầu cọc cho đơn nhỏ có hoàn cảnh đặc biệt.

Bản sao lưu và thời hạn dữ liệu chưa đóng:  Quy tắc 30 ngày tính từ khi đóng đơn đã chốt. Cần thiết kế quy trình xử lý file của đơn chưa đóng, thời hạn giữ bản sao lưu và chứng từ theo yêu cầu pháp lý mà không tự thay quyết định.

Nghiệm thu 90%/80%:  Cần chốt bộ mẫu thử đại diện, cách tính mẫu số, phân loại yêu cầu trong/ngoài phạm vi bản 1.0, thế nào là chuyển người hợp lệ; không được tùy tiện loại ca khó để đạt chỉ tiêu.

Cấu hình Canon:  Canon iX6770 xác minh cổng USB002; Canon G1010 và driver cụ thể chưa khảo sát vì hai máy màu để sau. Không đưa điều khiển in màu tự động vào điều kiện bắt buộc bản 1.0.

VII. KẾ HOẠCH XÁC MINH VÀ NGHIỆM THU

1.  Xác minh Zalo OA và khả năng nhận file thật, tình huống quyền truy cập và ngoại lệ; nếu không hỗ trợ thì chốt phương án chuyển người/định dạng khác trước khi phát triển sâu.

2.  Kiểm tra Ricoh trên Windows với PDF, Word, ảnh; đo số trang, khổ giấy, hai mặt, chiều lật, khả năng theo dõi và bản xem trước vs giấy thật.

3.  Kiểm thử hàng đợi, in ngoài phần mềm, quyền duyệt, lệnh bị lặp, khách sửa khi chuẩn bị in, mất mạng và khởi động lại giữa lệnh.

4.  Kiểm thử đủ 210 đơn đạt trong tối thiểu 7 ngày; tỷ lệ nhận diện ≥90%, tự xử lý hội thoại thông dụng ≥80%; mô phỏng tải 100 đơn/ngày.

5.  Khi có lỗi nghiêm trọng: dừng, sửa, chạy lại toàn bộ ca liên quan; không tính ca của bản lỗi; chỉ chấp nhận 210 ca đạt trong thời gian thử nghiệm sạch tối thiểu 7 ngày.

6.  Chủ cửa hàng xem báo cáo, xác nhận không còn lỗi chặn và phê duyệt mở toàn bộ đơn đủ điều kiện. Luôn duy trì quyền nhân viên duyệt trước in và chế độ an toàn.

VIII. GHI CHÚ VỀ CÁC QUYẾT ĐỊNH ĐÃ THAY THẾ

TN-034: lựa chọn cuối là in theo định dạng gốc, KHÔNG bắt buộc chuẩn hóa mọi tài liệu thành PDF trước khi in.

TN-033: lựa chọn cuối là nhân viên đánh dấu chi phí đáng kể theo từng đơn, KHÔNG cấu hình ngưỡng tiền cố định.

TN-033: khi chưa thu đủ cọc, nhân viên được duyệt sau khi xem cảnh báo và ghi khoản thiếu; không thiết kế khóa cứng.

TN-032: sau nghiệm thu và chủ phê duyệt, mở toàn bộ đơn hợp lệ ngay; không áp dụng phương án mở dần trong 3 ngày.

TN-028: chủ được đặt lịch trả lời AI ngoài 07:00–21:30 cho ngày cụ thể; 07:00–21:30 vẫn là giờ mặc định, không còn là giới hạn tuyệt đối.

TN-035: ngày nghỉ kết thúc, chỉ tự tiếp tục lệnh đã duyệt và chắc chắn chưa gửi còn hiệu lực; không duyệt lại, không tự gửi lệnh chưa rõ.

KẾT LUẬN

Các quyết định TN-001 đến TN-037 đủ để chuyển sang giai đoạn khảo sát kỹ thuật chi tiết và thiết kế giải pháp, nhưng việc tích hợp không được coi là khả thi/đã hoàn tất trước khi có bằng chứng thử nghiệm Zalo OA, Ricoh IM7000, công cụ Word/PDF/ảnh và quy trình duyệt-an toàn. Tài liệu này là cơ sở nghiệm thu nghiệp vụ; chưa phải prompt cho AI lập trình hoặc mã nguồn.
