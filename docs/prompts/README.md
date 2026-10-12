# Prompt code khởi đầu — 6 AI song song

Repo: https://github.com/minhdienhp2013/AUTO-IN.
Gửi prompt đầy đủ đúng vai trò trong lần đầu. Sau đó chỉ gửi mã việc và thay đổi; dùng bàn giao 6 dòng.

| Vai trò | Prompt đầy đủ |
| --- | --- |
| AI0 — Điều phối/khung chung | [AI0_DIEU_PHOI.md](AI0_DIEU_PHOI.md) |
| AI1 — Backend nghiệp vụ | [AI1_NGHIEP_VU.md](AI1_NGHIEP_VU.md) |
| AI2 — Zalo/hội thoại | [AI2_ZALO_HOI_THOAI.md](AI2_ZALO_HOI_THOAI.md) |
| AI3 — Tài liệu/máy in | [AI3_TAI_LIEU_MAY_IN.md](AI3_TAI_LIEU_MAY_IN.md) |
| AI4 — Giao diện | [AI4_GIAO_DIEN.md](AI4_GIAO_DIEN.md) |
| AI5 — Kiểm thử | [AI5_KIEM_THU.md](AI5_KIEM_THU.md) |

[Bộ 6 prompt trong một file](BO_PROMPT_CODE_KHOI_DAU_V1.md).
[Phân công](../PHAN_CONG_AI.md) · [Stack/wire/cách chạy song song](../architecture/KHOI_DAU_CODE_V1.md).

Cùng nền tài liệu mới nhất có bộ này; mỗi AI một nhánh/worktree. AI0 viết config/schema/entry chung; AI1–AI4 viết module/adapter riêng; AI5 viết test/fixture. Khi runtime/API chưa có, viết phần độc lập và dùng mock có nhãn rồi nối tích hợp khi bàn giao. Không coi mock là thử OA/Ricoh/iPhone thật. Chưa khởi chạy AI hay tạo code bằng việc viết các prompt này.

## Giao việc các lượt sau

AI: AIx
Việc: CODE-xxx
BASE SHA: SHA đã kiểm tra
File: phạm vi chính xác
Sửa: yêu cầu mới
Đạt: ca kiểm thử/kết quả cần có

