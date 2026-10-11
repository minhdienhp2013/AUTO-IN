# AI4 — CODE-204

Đọc README.md của thư mục này, báo cáo kiểm tra, AGENTS.md và TN-007/008/017/027/030/033/036. Tạo nhánh ai4/dot2-web-build-readmodel từ fde9cdccb6aad888fada378567590f8f325ab635; lấy khung a681fe9 theo hướng dẫn chung.

Chỉ sửa web/**, tests/ui/** và docs/research/AI4_GIAO_DIEN_THONG_BAO.md. Manifest/config/lock web thuộc bạn; root/contracts/backend thuộc AI0/AI1.

1. Sửa ngay TS2559 web/src/api.ts dòng17: khai báo ImportMetaEnv cho VITE_DEMO_MODE/VITE_API_BASE_URL đúng TypeScript/Vite, không dùng any để giấu lỗi. Tạo web/package-lock.json với dependency đã ghim. Chạy `npm ci`, `npm test`, `npm run typecheck`, `npm run build`; commit bản build đạt sớm.
2. Giữ Bearer/login shop_id và body AI1 đang dùng theo quyết định đợt2. Khi AI1 bàn giao read model, cập nhật mapper cho confirmations/quote/approval/preview/mode/generation thực; thiếu dữ liệu vẫn khóa duyệt, không hardcode true.
3. Nối handover/return-to-ai sau khi route AI1 có; test403/409/mất mạng/nhân viên khác cập nhật. Giữ stale-revision phải tải lại và người thao tác lại; không retry mutation hoặc fallback demo khi API lỗi.
4. Test Windows/mobile viewport và tạo điểm nối ổn định cho AI5 browser tests; demo vẫn ghi MÔ PHỎNG. SIMULATED_DONE/UNKNOWN hoặc giấy kiểm chứng chưa đủ không hiển thị đã in đủ/giao đủ. Không mở nút production/in lại để bù thiếu nghiệp vụ.

Bàn giao6dòng: SHA/PR, lockfile/build/test thật, read model đã/chưa nối, browser giả lập và iPhone/Push chưa thử. Không tự merge/deploy.
