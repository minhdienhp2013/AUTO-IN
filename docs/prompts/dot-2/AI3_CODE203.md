# AI3 — CODE-203

Đọc README.md của thư mục này, báo cáo kiểm tra, AGENTS.md và TN-009/012/023/025/029/034/035. Tạo nhánh ai3/dot2-processor-agent-bridge từ 72647b4e8d489c506f8814ac7565116d0d1a16df; lấy khung a681fe9 theo hướng dẫn chung.

Chỉ sửa workers/documents/**, agents/windows/**, tests/unit/documents/**, tests/unit/printing/** và docs/research/AI3_TAI_LIEU_RICOH.md.

1. Giữ wire HttpBackendClient đang bám AI1 (lease_token/result/evidence_kind); chưa tự chuyển sang lease_id/send_authorization_id của schema scaffold. AI0 chịu trách nhiệm đồng bộ exports và mapper. Khóa dependency Python trong phạm vi mình.
2. Cung cấp bridge processor có input/output JSON rõ để AI0 gọi từ backend: hash file/nội dung/thông số, renderer/version, count trang/mặt/tờ và preview artifact/ref có kiểm chứng. Không tin metadata khách; chưa có file/renderer đáng tin phải NEEDS_HUMAN. Không expose đường dẫn file tùy ý hoặc đọc vượt thư mục artifact được cấp.
3. Test product-backed PDF/ảnh synthetic, duplex từng file/bản, file hỏng/ZIP nguy hiểm/font không tin cậy; chuẩn bị mapping publishVerifiedPlan của AI1 và tài liệu Port. Word/Excel chưa hỗ trợ ghi rõ, không ép mọi file sang PDF.
4. Bổ sung phép thử agent với backend simulation của AI0 khi nhận SHA tích hợp: claim→preflight→mark-sending→journal SQLite bền vững→DryRun→report; mất ACK/crash/restart phải UNKNOWN, không gọi driver lần hai. Mock HTTP cũ chỉ là unit-test. HTTPS/scoped token/redirect guard giữ nguyên; không tạo bypass TLS để vượt test.

Bàn giao6dòng: SHA/PR, bridge + fixtures, pytest và kết quả thật, backend tích hợp/Windows/Ricoh chưa chạy. Driver thật tiếp tục khóa; không phát lệnh in thật, merge/deploy hoặc sửa namespace khác.
