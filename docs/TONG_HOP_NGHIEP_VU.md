# Tổng hợp nghiệp vụ và cơ sở điều phối phần mềm in tự động Minh Điến

Ngày tổng hợp: 11/10/2026. AI điều phối: ChatGPT trong cuộc trò chuyện này.

Nguồn: [bản Word gốc](spec/Dac_ta_nghiep_vu_Minh_Dien_2026-10-11.docx), phiên bản nghiệp vụ 1.0, ngày chốt 11/10/2026. Đã đọc toàn bộ nội dung, bốn bảng, phần cần xác minh, nghiệm thu và các quyết định thay thế.

Tài liệu nguồn là căn cứ nghiệp vụ. Bản tổng hợp này dùng để chuẩn bị phân việc, không thay thế đặc tả. Các mục ghi “đề xuất điều phối” là cách tổ chức công việc của AI điều phối, chưa phải quyết định mới của chủ cửa hàng. Bản tổng hợp được lập trước bộ prompt và commit nền. Công nghệ và tích hợp vẫn cần khảo sát; xem PHAN_CONG_AI.md để biết trạng thái hiện tại.

## 1. Mục tiêu và phạm vi đã chốt

Tạo phần mềm độc lập để tự động chuẩn bị đơn in thường gặp, giảm thao tác của cửa hàng và giữ kiểm soát bằng bước nhân viên duyệt mọi lệnh in thật. Luồng bản 1.0 là Zalo OA → công cụ xử lý nội bộ và DeepSeek khi cần → khách xác nhận → nhân viên duyệt → Windows → Ricoh IM7000 → kiểm tra bản giấy → bàn giao → đối soát tiền.

Máy bản 1.0: Windows 11 Pro 25H2, hàng đợi `RMP7000` chính là Ricoh IM7000, IP `192.168.1.195`, cổng RAW TCP `9100`, driver PCL6 V4 Universal. Cấu hình SNMP kiểm tra trạng thái trên cổng Windows đang tắt; điều này không chứng minh thiết bị không hỗ trợ SNMP.

Tiếp nhận PDF, Word, ảnh; Excel, file khó/lỗi, in màu và phân trang màu phức tạp chuyển nhân viên. Canon iX6770 (USB002) và Canon G1010 để giai đoạn sau đối với điều khiển tự in. QR tại quầy trước mắt là QR tĩnh mở OA; QR không chứng minh khách đang tại quầy.

Repo phải độc lập, không sửa app hiện có. Không tự merge hoặc deploy khi chưa được chủ cho phép. Giữ kiến trúc bản 1.0 đơn giản; chưa quyết định ngôn ngữ, framework, cơ sở dữ liệu hoặc nhà cung cấp cloud bằng bản tổng hợp này.

## 2. Đối chiếu đủ các mục nghiệp vụ

| Mục | Nội dung phải giữ khi thiết kế và phân việc |
| --- | --- |
| TN-001 | Gom tin: sau tin đầu tối đa 60 giây, tin kế tiếp khoảng 10 giây; có thể trả lời sớm nếu đủ thông tin. Gom đúng khách và phiên, không tách đơn vô cớ. Cách phối hợp hai mốc thời gian cần mô tả rõ trong thiết kế để kiểm thử. |
| TN-002 | Xử lý yêu cầu in; yêu cầu mua hàng/nội thất thông báo riêng người phụ trách. Nếu một tin có cả hai nhu cầu vẫn tiếp tục phần in. |
| TN-003 | AI chỉ trả lời theo lịch hiệu lực; mặc định 07:00–21:30 giờ Việt Nam. Ngoài giờ vẫn nhận/lưu tin và file, im lặng về hội thoại thông thường. Lịch ngoại lệ theo TN-028. |
| TN-004 | PDF, Word, ảnh được tiếp nhận/phân loại; Excel và file khó/lỗi chuyển người. Trên 5 tài liệu thực cần người kiểm tra; ZIP đếm tài liệu bên trong. Quyền nhận định dạng/dung lượng của OA phải thử thật. |
| TN-005 | Nhận diện văn bản, bài tập, ảnh và nhu cầu màu/đen trắng; đề xuất cách in thông dụng nhưng không đoán điều chưa rõ. Phân trang màu phức tạp làm thủ công. Ảnh chụp chữ không bắt buộc OCR rồi dựng lại. |
| TN-005A | Ưu tiên đọc cấu trúc, PyMuPDF/OCR nội bộ/rules/cache; DeepSeek chỉ khi cần hiểu yêu cầu hoặc xử lý điều chưa rõ. Số trang lấy từ kết xuất thật. Theo dõi token/chi phí, hạn chế đưa tài liệu nhạy cảm ra ngoài. |
| TN-006 | Xưng tôi–bạn, ngắn và rõ; không bịa giá, không báo đã in thiếu bằng chứng. Thói quen khách cần khách xác nhận khi áp dụng; yêu cầu hiện tại ưu tiên. Nhân viên tiếp quản thì AI dừng đúng hội thoại. |
| TN-007 | Khách xác nhận trước, nhân viên hợp lệ duyệt trước in thật. Xếp hàng theo thời điểm khách hoàn tất xác nhận; đơn thiếu dữ liệu không chặn đơn khác. Thay đổi đáng kể cần xác nhận lại. |
| TN-008 | Thông báo iPhone và Windows cho chờ duyệt, cần người, hủy, lỗi máy; mở đúng đơn khi chạm. Thử PWA/Web Push trên iPhone thật. Ngoài giờ ưu tiên cảnh báo khẩn, thông báo thường theo lịch. |
| TN-009 | Chọn máy theo danh sách/capability thực, không dùng máy mặc định làm căn cứ. Ricoh đen trắng/duplex; Canon thủ công. Đổi máy đích cần nhân viên xác nhận; mất kết nối giữ hàng đợi an toàn. |
| TN-010 | QR tĩnh mở OA trước; QR động để sau. Nhân viên đánh dấu khách tại quầy và ưu tiên riêng. Zalo cá nhân làm thủ công. |
| TN-011 | File gốc, preview, OCR/cache lưu tối đa 30 ngày sau hoàn tất hoặc đóng hợp lệ, sau đó xóa theo chính sách. Chỉ người có quyền xem. Yêu cầu xóa hợp lệ đã xác minh cần xử lý kịp thời. File đơn chưa đóng, backup và nghĩa vụ pháp lý cần thiết kế/đánh giá riêng. |
| TN-012 | Tải file lỗi thử lại tối đa 2 lần rồi chuyển người. DeepSeek lỗi không mất đơn. Chỉ tự tiếp tục lệnh đã duyệt chắc chắn chưa gửi khi khôi phục. Đã gửi hoặc chưa rõ giữ kiểm tra. Khử webhook/lệnh lặp. |
| TN-013 | Mục tiêu OA + AI + server/cloud 2–3 triệu đồng/tháng, không gồm giấy/mực/điện. Theo dõi theo nhóm công việc/đơn, cảnh báo 80/95/100%. Hết hạn mức AI vẫn giữ đơn. |
| TN-014 | Quy tắc chung/riêng khách có màn hình xem/sửa, phiên bản và khôi phục. Thói quen AI đề xuất chỉ có hiệu lực sau quản lý phê duyệt. Học chủ động nâng cao để sau. |
| TN-015 | Thử 30 đơn/ngày trong 7 ngày, tổng 210 ca; mô phỏng 100 đơn/ngày. Kiểm tra file, điện thoại, Ricoh, khôi phục, bảo mật và lỗi. Chủ nghiệm thu. TN-037 quy định cổng nghiệm thu cuối. |
| TN-016 | Sản phẩm đầu-cuối nhưng giới hạn để ổn định; repo riêng, không sửa các app hiện có, không tự merge/deploy. Cá nhân hóa cơ bản, chức năng nâng cao để sau. |
| TN-017 | Nhân viên hợp lệ duyệt in lần đầu, tiếp quản/cập nhật theo quyền. Chỉ chủ duyệt in lại/bổ sung sau lỗi, quản lý cấu hình nhạy cảm và ngoại lệ quan trọng. Có nhật ký và xử lý thao tác đồng thời. |
| TN-018 | Văn bản dài thành tài liệu giữ nguyên nội dung; hỏi định dạng nếu cần, mặc định đề xuất A4/Times New Roman 14. Khách xác nhận bố cục; preview và đếm trang từ kết xuất thật. |
| TN-019 | Trên 150 tờ vật lý cảnh báo xem xét cọc; nhân viên quyết định có yêu cầu và số tiền. Không tự định cọc/hoàn cọc. TN-033 cho phép duyệt khi thiếu cọc sau cảnh báo và ghi khoản thiếu. |
| TN-020 | Hồ sơ/thói quen khách lưu 24 tháng từ giao dịch cuối, tách vòng đời file. Không giữ nội dung tài liệu/OCR quá hạn để cá nhân hóa. Quyền xóa/nghĩa vụ pháp lý đánh giá riêng. |
| TN-021 | Nhận diện ≥90%, tự xử lý hội thoại thông dụng trong phạm vi ≥80%. Nhân viên duyệt bắt buộc không là thất bại AI. Tách chuyển người hợp lệ và nhận diện sai. Không chấp nhận in sai nghiêm trọng, in trùng, lộ dữ liệu. |
| TN-022 | Thử OA/app đã cấp quyền: tin, PDF/Word/ảnh/ZIP/Excel, dung lượng, URL/tải file, webhook lặp, bảo mật/token, giới hạn gửi/phân quyền. Không lấy hạn upload của OA làm hạn file khách gửi. Không hỗ trợ thì chuyển phương án/nhân viên. |
| TN-023 | Thiết bị theo cấu hình đã nêu; chỉ tự báo in xong khi có bằng chứng thiết bị đủ tin cậy. Nếu Windows chỉ cho biết đã gửi, nhân viên kiểm tra và xác nhận. Canon chưa vào tự in bản 1.0. |
| TN-024 | Lưu đơn, người duyệt, máy, bản, trạng thái, lỗi, in lại, cọc, bàn giao. Lịch sử vận hành 24 tháng; file/preview theo TN-011. Chứng từ pháp lý quản lý riêng. |
| TN-025 | Tách trang tài liệu, mặt in và tờ giấy vật lý; tính theo file, bản, một/hai mặt, vùng giấy, ngắt bản. Mặc định từng file/từng bản riêng, không tự ghép hai file trên một tờ hai mặt. Trên 150 tờ căn cứ giấy vật lý. |
| TN-026 | Sửa/thêm file khi chắc chắn chưa gửi: giữ lệnh cũ, tạo phiên bản mới, tính lại, khách xác nhận lại, nhân viên duyệt lại. Đã gửi/chưa rõ không tự sửa/in lại. Hủy lúc đang in báo khẩn để người kiểm tra. |
| TN-027 | Tiếp quản chặn cả phản hồi AI đang soạn; vẫn nhận tin/file; khách khác không ảnh hưởng. Tránh hai nhân viên ghi đè. Chỉ thao tác chủ động trả lại AI mới tiếp tục, không tự bật theo giờ hay sau đóng đơn. |
| TN-028 | Chủ đặt lịch đặc biệt kể cả ngoài giờ mặc định. Ngày nghỉ AI có thể tư vấn theo lịch nhưng không gửi in thật. Tạm dừng AI chặn cả phản hồi đang xử lý. Chỉnh lịch đúng quyền; đơn đã duyệt chờ mở cửa. |
| TN-029 | Giữ A4/A3, chiều, số bản, duplex, lật cạnh dài/ngắn, tách file. Mặc định chỉ thu nhỏ khi cần vừa vùng in, giữ tỷ lệ, không tự phóng lớn. Kích thước quan trọng/chữ sát mép/cấu hình chưa rõ hỏi hoặc chuyển người. Thử khay/driver thật. |
| TN-030 | Tách đang in, in xong/chờ kiểm tra, sẵn sàng giao, đã giao, đóng. Nhân viên kiểm chất lượng, ghi giao thủ công, thời gian/người giao, cọc/đã thu/còn phải thu. Có giao một phần; không lấy in xong làm đã giao. |
| TN-031 | Chưa xác nhận: nhắc sau 24 giờ nếu lịch/quyền OA cho phép; 72 giờ đánh dấu bỏ dở, nhân viên xem xét đóng. Đã in/chờ nhận: nhắc 3 ngày, quá hạn 7 ngày, 30 ngày báo chủ xem giấy tồn. Không tự xóa, tiêu hủy hay xóa cọc/công nợ/lịch sử. |
| TN-032 | Có mô phỏng, thử thật có kiểm soát, chính thức, an toàn. Đạt nghiệm thu và chủ duyệt thì mở toàn bộ đơn hợp lệ ngay; vẫn giữ nhân viên duyệt mọi lệnh. Có thể về an toàn khi lỗi. |
| TN-033 | AI không định giá. >150 tờ và đơn được nhân viên đánh dấu chi phí đáng kể phải khách xác nhận giá do nhân viên nhập. Không đặt ngưỡng tiền cố định. Nhân viên xác minh tiền mặt/chuyển khoản; ảnh chuyển khoản không là chứng cứ đã nhận. Lưu giá/phiên bản/đã thu/phải thu/cọc. Thiếu cọc vẫn có thể duyệt sau cảnh báo, ghi thiếu. Đơn lớn/phức tạp cảnh báo chủ chọn thủ công hay AI tiếp tục chuẩn bị. |
| TN-034 | Không bắt mọi file thành PDF; dùng bộ xử lý theo định dạng gốc. Preview theo đường xử lý phù hợp, so với giấy Ricoh thật. Khách xem tóm tắt/trang đại diện nếu OA hỗ trợ, xem thêm/toàn bộ an toàn; nhân viên xem đủ và cảnh báo. Font/file/preview không đáng tin chuyển người, không tự in. Sửa đầu ra cần xác nhận lại, khóa phiên bản nội dung/cấu hình. |
| TN-035 | Trước in ngoài app phải chuyển xử lý thủ công để khóa tự động và kiểm tra lệnh chạy; ghi kết quả thực sau in. Khôi phục/chấm dứt ngày nghỉ chỉ tiếp tục lệnh đã duyệt còn hiệu lực, chắc chắn chưa gửi và an toàn, không duyệt lại. Đã gửi/chưa rõ đối soát; spooler không chứng minh đủ giấy. Chỉ chủ duyệt in lại/bổ sung. |
| TN-036 | Nhân viên đóng bỏ dở/hủy trước in chỉ khi chưa thu tiền và chắc chắn không có lệnh chạy. Có cọc/cần hoàn/đã in/khách không nhận cần chủ. Chủ có thể đóng phần xử lý in ngoại lệ dù còn phải thu/phải hoàn, theo dõi tiền riêng, ghi giấy giao/chưa giao đúng thực tế. Không giả giao đủ, tự hoàn, tự tiêu hủy. Duyệt hoàn khác hoàn thực tế. |
| TN-037 | ≥90% nhận diện, ≥80% tự xử lý hội thoại thông dụng, 210 đơn đạt trong tối thiểu 7 ngày; mô phỏng 100 đơn/ngày. Không in chưa duyệt/trùng/sai nghiêm trọng/lộ hay mất dữ liệu. Lỗi nghiêm trọng dừng, sửa, thử lại ca liên quan; loại ca bản lỗi, tích lũy đủ 210 ca đạt trong tối thiểu 7 ngày sạch. Chỉ chủ duyệt báo cáo và mở chính thức. |

## 3. Luồng chuẩn và các tình huống rẽ nhánh

1. Nhận webhook, xác định đúng khách/phiên, khử lặp và gom tin.
2. Kiểm tra lịch AI, trạng thái tiếp quản, loại yêu cầu và file. Ngoài giờ vẫn nhận/lưu; nhân viên tiếp quản thì chặn phản hồi AI kể cả phản hồi đang tạo.
3. Kiểm tra file, đọc/kết xuất bằng công cụ phù hợp, hỏi thiếu thông tin. File khó, Excel, nhiều tài liệu, font lỗi hoặc preview không đáng tin cần người kiểm tra.
4. Tạo phiên bản đơn cùng file, preview, thông số, số trang/mặt/tờ thật. Khách xác nhận đúng phiên bản.
5. Nếu trên 150 tờ hoặc đánh dấu chi phí đáng kể: nhân viên nhập giá, khách xác nhận giá. Nhân viên quyết định cọc và xác minh thực nhận; thiếu cọc phải cảnh báo/ghi nhận nhưng không tự khóa cứng quyền duyệt.
6. Nhân viên duyệt đúng phiên bản. Đơn xếp theo thời điểm khách xác nhận; đơn thiếu dữ liệu không chặn đơn khác.
7. Trước gửi, kiểm tra lại phiên bản, quyền duyệt, chế độ vận hành, ngày nghỉ, khóa thủ công và việc tác vụ đã từng gửi hay chưa. Đơn sửa làm mất hiệu lực đường in của phiên bản cũ; không xóa lịch sử.
8. Windows gửi đúng máy với thông số đã khóa. Nếu đã gửi hoặc chưa rõ kết quả thì giữ đối soát, không tự gửi lại.
9. Có chứng cứ đáng tin hoặc nhân viên kiểm tra để xác nhận in xong. Nhân viên kiểm chất lượng rồi đặt sẵn sàng giao.
10. Ghi giao đủ/một phần/chưa nhận, tiền thực thu và khoản còn thiếu. Đóng bình thường/ngoại lệ đúng quyền; phần tài chính tiếp tục theo dõi nếu chưa đối soát.

Nhánh thủ công cần được đặt trước khi in ngoài app và kiểm tra tác vụ đang chạy. Nhánh in lại/bổ sung sau lỗi chỉ mở khi chủ duyệt. Khách hủy trong lúc in cần báo khẩn, không được giả định hủy thành công chỉ vì đã nhận yêu cầu.

## 4. Quyền và trạng thái không được nhập làm một

| Trục trạng thái | Nội dung cần theo dõi riêng |
| --- | --- |
| Hội thoại | AI đang xử lý, cần người, nhân viên tiếp quản, trả lại AI, ngoài giờ/tạm dừng. |
| Đơn và phiên bản | Bổ sung, chờ xác nhận, đã xác nhận, chờ duyệt, đã duyệt, sửa phiên bản, bỏ dở. |
| Tác vụ in | Chắc chắn chưa gửi, đang gửi, đã gửi/chưa rõ, in xong có chứng cứ, thủ công, khóa tự động, cần chủ duyệt in lại. |
| Giao giấy | Chờ kiểm tra, sẵn sàng giao, giao một phần, giao đủ, chưa nhận/quá hạn, đóng ngoại lệ. |
| Thanh toán | Chưa thu, yêu cầu cọc, thu một phần/đủ/dư, phải thu, chờ hoàn, duyệt hoàn, hoàn thực tế. |

Nhân viên hợp lệ có quyền duyệt lần đầu; tiếp quản, nhập giá/xác nhận tiền, xử lý thủ công theo quyền. Nhân viên chỉ tự đóng bỏ dở/hủy trước in khi chưa thu tiền và không có lệnh chạy.

Chỉ chủ duyệt in lại/bổ sung sau lỗi, ngoại lệ đã in/có cọc/cần hoàn/khách không nhận, quyết định giấy tồn và mở vận hành chính thức. Quyền chỉnh lịch có thể được phân cấp theo đặc tả; không suy rộng thành quyền mở chính thức.

## 5. Những quyết định sau cùng phải được đưa vào mọi prompt liên quan

- In theo định dạng gốc phù hợp; không ép chuẩn hóa mọi file thành PDF.
- Chi phí đáng kể do nhân viên đánh dấu theo đơn; không tự tạo ngưỡng tiền cố định.
- Thiếu cọc vẫn có thể duyệt sau cảnh báo và ghi thiếu; không tạo khóa cứng trái TN-033.
- Nghiệm thu đạt và chủ cho phép thì mở toàn bộ đơn hợp lệ ngay; không áp dụng yêu cầu mở dần ba ngày đã thay thế.
- 07:00–21:30 là mặc định; chủ có thể đặt giờ đặc biệt ngoài khung cho ngày cụ thể.
- Sau mở cửa/khởi động lại chỉ tiếp tục tác vụ đã duyệt còn hiệu lực chắc chắn chưa gửi và an toàn; không bắt duyệt lại tác vụ này, không gửi lại tác vụ mơ hồ.
- Đóng phần in ngoại lệ không xóa khoản phải thu/phải hoàn, không giả đã giao đủ.
- QR mở OA không là bằng chứng khách tại cửa hàng.
- Spooler báo đã gửi/hoàn thành không là bằng chứng bản giấy đã in đủ.
- Nhân viên tiếp quản phải chặn cả tin AI đang soạn; AI chỉ trở lại khi được trả quyền chủ động.

## 6. Vòng đời dữ liệu và thời điểm nhắc việc

| Dữ liệu hoặc sự kiện | Mốc đã chốt | Điều kiện và giới hạn |
| --- | --- | --- |
| File gốc, preview, OCR/cache | Tối đa 30 ngày sau hoàn tất/đóng hợp lệ | Quyền truy cập chặt; file đơn chưa đóng, backup và xóa theo yêu cầu hợp lệ cần chính sách riêng. |
| Hồ sơ/thói quen khách | 24 tháng từ giao dịch cuối | Không giữ nội dung tài liệu hết hạn để cá nhân hóa. |
| Lịch sử vận hành | 24 tháng | Chứng từ pháp lý quản lý riêng, không tự suy ra thời hạn pháp luật. |
| Khách chưa xác nhận | Nhắc sau 24 giờ, bỏ dở sau 72 giờ | Nhắc đúng lịch và quyền OA; nhân viên xem xét đóng, không tự xóa. |
| Bản in chưa nhận | Nhắc 3 ngày, quá hạn 7 ngày, báo chủ sau 30 ngày | Không tự tiêu hủy, hoàn cọc hoặc xóa công nợ. |
| Chi phí OA/AI/cloud | Mục tiêu 2–3 triệu/tháng; cảnh báo 80/95/100% | Mục tiêu ngân sách, chưa phải báo giá đã kiểm chứng; hết hạn mức AI không mất đơn. |

## 7. Kiểm chứng kỹ thuật trước triển khai và nghiệm thu

P0 theo tài liệu là điều kiện an toàn cần kiểm chứng trước in thật; P1 là điều kiện chất lượng/vận hành cần kiểm chứng trước nghiệm thu. Việc khảo sát chất lượng đường in nên làm sớm để tránh thiết kế trên giả định sai.

| Mức | Nhóm | Bằng chứng phải thu được |
| --- | --- | --- |
| P0 | Zalo OA/MDCO | Quyền thật; nhận/tải từng định dạng và dung lượng; URL hết hạn; lặp/thứ tự webhook; gắn đúng khách/phiên; gửi phản hồi/preview/nhắc; token và bảo mật. Tên MDCO trong nguồn chưa mô tả chi tiết, cần xác minh ý nghĩa và hệ liên quan. |
| P0 | Danh tính/quyền | Chủ/nhân viên, xem file, duyệt/tiếp quản, cạnh tranh hai nhân viên, yêu cầu giả, nhật ký. |
| P0 | Duyệt đến gửi in | Khóa đúng file/thông số/phiên bản; thao tác nhất quán khi đồng thời; bấm kép, lặp webhook; sửa/hủy sát lúc gửi. |
| P0 | Windows/Ricoh | Máy thật; reboot giữa lệnh; spooler crash; mất mạng; kẹt giấy; nguồn bằng chứng in hoàn tất và phương án người kiểm tra khi thiếu. |
| P0 | Thủ công/đối soát | Khóa trước in ngoài app; không giả lệnh chạy/đã gửi là chưa gửi; khôi phục không gửi trùng. |
| P0 | Tiền/ngoại lệ | Ảnh chuyển khoản không tự xác nhận; giá bắt buộc đúng điều kiện; thiếu cọc; quyền hoàn/đóng ngoại lệ và còn công nợ. |
| P0 | File/riêng tư | File mật khẩu, ZIP nhiều tài liệu, ZIP bomb, path traversal, file lỗi, giới hạn tải; token/file nhạy cảm, xóa và backup. |
| P1 | Word/PDF/ảnh | Bộ xử lý Windows thực, không hộp thoại chặn; font Việt, font thiếu/thay, bảng/ngắt trang, EXIF/chiều; Excel chuyển tay. |
| P1 | Khổ/khay/duplex | A4/A3 thật, cạnh dài/ngắn, số bản, tách file/bản, vừa vùng in không phóng lớn; đối chiếu giấy và preview. |
| P1 | Preview | Đúng đường in, cảnh báo/trang đại diện, khách xem thêm an toàn, nhân viên xem đầy đủ. |
| P1 | iPhone/Windows | Duyệt iPhone thật, khóa màn hình, mất mạng, Web Push, đồng bộ và mở đúng đơn/thông báo khẩn. |
| P1 | Chi phí/tải | Token, cache, OA/cloud, cảnh báo ngân sách, 100 đơn/ngày mô phỏng với nhiều khách/file cùng lúc. |

Những điểm chưa ấn định: bảng giá; công cụ Word/PDF/ảnh và trạng thái máy đáng tin; hạn mức/quyền nhắn tin OA; tín hiệu tiếp quản khi trả lời trực tiếp OA Manager; cách tính mẫu số 90%/80%; thời hạn dữ liệu đơn chưa đóng và backup; chính sách pháp lý; cọc đơn nhỏ trong trường hợp đặc biệt. Không tự biến các điểm này thành quy tắc đã chốt.

## 8. Đề xuất điều phối và chia nhóm công việc

Các nhóm dưới đây là phương án tổ chức để chuẩn bị prompt, chưa phải chỉ định file hoặc tạo AI thực thi. Một AI có thể đảm nhiệm nhiều nhóm ở các đợt khác nhau; không cần mở tất cả cùng lúc.

| Vai trò dự kiến | Phạm vi trách nhiệm | Phụ thuộc chính |
| --- | --- | --- |
| AI điều phối — cuộc trò chuyện này | Giữ đặc tả; khảo sát repo/AGENTS.md/Git; chốt giao diện giữa phần mềm; phân file; theo dõi TN; review, tích hợp có kiểm thử; báo cáo và bàn giao cho chủ. | Đầu vào là đặc tả và kết quả khảo sát; không tự đổi nghiệp vụ hoặc tự merge/deploy. |
| AI nền tảng nghiệp vụ và bảo mật | Mô hình đơn/phiên bản/trạng thái, quyền, lịch sử, khóa cạnh tranh, hợp đồng dữ liệu, file/riêng tư. | Nền chung do điều phối kiểm soát; thống nhất trước các nhóm tích hợp. |
| AI Zalo và hội thoại | Webhook, tải file, gom tin, lịch/tiếp quản, DeepSeek/rules, khách xác nhận, thói quen cơ bản và chi phí AI. | Kết quả OA thật; mô hình phiên bản/xác nhận/quyền. |
| AI xử lý tài liệu | PDF/Word/ảnh/văn bản dài, kiểm tra file/ZIP/font, kết xuất, đếm trang/mặt/tờ, preview và cấu hình in. | Kết quả thử đường in Windows; hợp đồng tài liệu và capability máy. |
| AI Windows và máy in | Agent, máy đích thật, nhận lệnh đã duyệt, khóa gửi, khôi phục, theo dõi/đối soát, thủ công và in lại theo quyền. | Hợp đồng duyệt/phiên bản và gói in đã khóa; khảo sát Ricoh thật. |
| AI giao diện vận hành | Windows/iPhone, danh sách/chi tiết/duyệt, giá/cọc, giao một phần, ngoại lệ, lịch/tiếp quản, thông báo. | API/quyền/trạng thái đã thống nhất; không tự thêm quy tắc thanh toán. |
| AI kiểm thử độc lập | Bộ ca theo TN, lỗi/cạnh tranh/bảo mật/khôi phục, đo 90%/80%, 210 ca/7 ngày, tải, báo cáo nghiệm thu. | Kịch bản thống nhất từ đầu; tham gia kiểm tra các hợp đồng trước và trong tích hợp. |

Bốn hợp đồng cần điều phối thống nhất trước khi giao nhóm chạy song song: (1) dữ liệu đơn và phiên bản; (2) file/preview/số trang và thông số in; (3) bằng chứng duyệt cùng quyền gửi/khôi phục; (4) sự kiện trạng thái, nhật ký, giao giấy và tiền. Chi tiết schema/API/file chỉ chốt sau khảo sát repo và công nghệ.

## 9. Thứ tự triển khai đề xuất

1. Khảo sát: xác định repo riêng, đọc AGENTS.md và Git; kiểm chứng OA, Ricoh/Windows, đường xử lý tài liệu và iPhone. Ghi rõ từng kết quả đã thử, chưa thử, chặn bởi thiết bị/quyền.
2. Thiết kế chung: truy vết toàn bộ TN; thống nhất mô hình phiên bản, năm trục trạng thái, quyền, hợp đồng API/tác vụ in và kế hoạch kiểm thử. Duyệt các lựa chọn kỹ thuật cần thiết trước khi chia file.
3. Xây nền và mô phỏng: kiểm tra luồng khách xác nhận → nhân viên duyệt → tác vụ giả lập, sửa/hủy, lặp lệnh, thủ công, ngày nghỉ, khôi phục. Mô phỏng không được gửi in thật.
4. Tích hợp từng phần: OA/hội thoại, xử lý tài liệu, Windows/Ricoh, giao diện/tiền/giao giấy và thông báo. Kiểm tra P0 trước bất kỳ in thật nào; thử thật có kiểm soát theo quyền.
5. Nghiệm thu: bộ mẫu đại diện và cách đo rõ ràng; 210 ca đạt trong tối thiểu 7 ngày, mô phỏng 100 đơn/ngày; lỗi nghiêm trọng xử lý theo TN-037.
6. Bàn giao: báo cáo đủ bằng chứng, giới hạn còn lại, commit/PR và hướng dẫn vận hành; chủ quyết định merge/deploy theo từng ủy quyền và phê duyệt mở chính thức.

## 10. Nội dung bắt buộc của prompt sẽ viết sau

Mỗi prompt phải có mục tiêu cụ thể, mã TN áp dụng, phần được sửa/không được sửa, nhánh/base commit, file sở hữu và phụ thuộc, hợp đồng dùng chung, ca kiểm thử bắt buộc, chứng cứ kiểm thử thật, điều kiện hoàn thành, định dạng báo cáo commit/PR. File dùng chung như schema, quyền và cấu hình do một đầu mối sở hữu; thay đổi cần phối hợp trước.

AI thực thi phải sửa và kiểm thử trong phạm vi được giao, không dừng ở đề xuất. Báo rõ thiết bị/API nào chưa thử thật; không dùng kết quả mô phỏng làm bằng chứng Ricoh/OA đã hoạt động. Nếu yêu cầu gặp điểm chưa chốt, ghi vấn đề cho AI điều phối thay vì tự thay nghiệp vụ. AI điều phối review báo cáo và mã, chạy kiểm tra tích hợp cần thiết trước khi chấp nhận bàn giao.

## 11. Điều kiện nghiệm thu cuối phải giữ nguyên

Nhận diện ít nhất 90%, tự xử lý hội thoại thông dụng trong phạm vi ít nhất 80%. Cách tính và bộ mẫu phải đại diện, không bỏ ca khó tùy tiện; bước nhân viên duyệt bắt buộc không tính là thất bại AI, chuyển người hợp lệ được phân loại riêng.

Cần 210 đơn đạt trong tối thiểu 7 ngày và tải mô phỏng 100 đơn/ngày. Không chấp nhận in chưa duyệt, in trùng, bản in sai nghiêm trọng, lộ hoặc mất dữ liệu. Khi có lỗi nghiêm trọng: dừng, sửa, thử lại ca liên quan, loại ca thuộc phiên bản lỗi, tích lũy đủ 210 ca đạt trong tối thiểu 7 ngày không lỗi nghiêm trọng. Chỉ chủ duyệt báo cáo và mở vận hành chính thức.

## 12. Trạng thái sau lượt tổng hợp này

Đã hoàn thành đọc và tổng hợp đặc tả TN-001 đến TN-037 cùng TN-005A; đã tách quyết định cuối, điều kiện kiểm chứng, phụ thuộc và đề xuất vai trò. Chưa viết prompt giao AI, chưa tạo/đổi repo, chưa triển khai code và chưa xác nhận OA/Ricoh/DeepSeek/iPhone đã tích hợp. Bước chuẩn bị tiếp theo là khảo sát repo riêng và khả năng kỹ thuật thật, rồi viết prompt theo phạm vi file đã xác định.
