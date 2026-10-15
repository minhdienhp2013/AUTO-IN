# AUTO-IN — ma trận nghiệm thu CODE-105/CODE-305/CODE-405

## Release-gate HIỆN HÀNH — kiểm tra nguồn 15/10/2026 (giờ Việt Nam)

**Phạm vi:** AI5 đối chiếu HEAD/diff, các báo cáo mới AI2/AI3/AI4 và GitHub Actions vào **15/10/2026**; chỉ cập nhật ma trận release-gate. **Không chạy thêm acceptance hoặc test thiết bị trong lượt cập nhật này.** Các bảng CODE-105/CODE-305/CODE-405 bên dưới là **lịch sử theo SHA**, giữ nguyên; PASS mô phỏng tuyệt đối không đại diện cho PASS vận hành.

**Mốc mã (GitHub đã kiểm tra):** [AI5 PR #18](https://github.com/minhdienhp2013/AUTO-IN/pull/18) Draft, HEAD trước sửa `3e4efa3ea17f0622cfb765470a8008ba94684415`. [Product PR #96](https://github.com/minhdienhp2013/AUTO-IN/pull/96) SHA `7bf2127b1eb8bd508021b3069210f67e893490e9` đã merge; commit merge main trước đó `8f07551c67cc7387a322367a64f532e398db369f` có **cùng Git tree** với product (`2714e43a142c9ac41cda33abe20f5f3ab1ecd2df`). **Main hiện tại `423adb1a40d2b4a3c65dcf13c7ff36dbdbf97338`** là merge PR #100: so với product chỉ thay **`tests/integration/core/postgres.test.cjs` (fixture AI1)**, không thay code sản phẩm, logic runtime hay AI5 assertion. Vì Git tree main **khác** sau fixture, không tuyên bố toàn cây main còn trùng tree product; chỉ kết luận **hành vi sản phẩm được kiểm thử không đổi**. [PR #97 overlay AI5](https://github.com/minhdienhp2013/AUTO-IN/pull/97) `21e6c4f472269572939928e231b044befcc8df85` trên đúng product SHA; [PR #98](https://github.com/minhdienhp2013/AUTO-IN/pull/98) Draft validation-only `7314c885047360e7a02f8b5e77c8cff368608402` không dùng làm evidence AI5 mới.

| Cổng / chủ trách nhiệm | PASS | FAIL | SKIP | NOT RUN / giới hạn release-gate | Nguồn tại đúng SHA |
| --- | ---: | ---: | ---: | --- | --- |
| **AI5 — PostgreSQL 18.3 / Fastify / HTTP synthetic** | **18/18** | 0 | 0 | **AI5 trên main `423adb1a`: NOT RUN**; kết quả cũ áp dụng cho **runtime không đổi**, mặc dù toàn Git tree hiện khác vì fixture PR #100 | [Independent Actions #38657817146](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38657817146), [job PG](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38657817146/job/116171663989); checkout overlay `21e6c4f` / parent product `7bf2127b` |
| **AI5/AI3 — Python DryRun synthetic (chống gửi lại UNKNOWN)** | **42/42** | 0 | 0 | **Ricoh/Windows/giấy thật NOT RUN**; DryRun không chứng minh đã in giấy | Cùng [run #38657817146](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38657817146), PG/HTTP/DryRun job |
| **AI5/AI4 — Chromium desktop/mobile** | **28/28** | 0 | 0 | **iPhone Safari vật lý NOT RUN**; browser sử dụng **synthetic API fixtures**, không phải E2E OA/thiết bị | [Browser job #116171663869](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38657817146/job/116171663869), desktop `1440×900`, mobile `390×844` |
| **AI2 — PR #53 CODE-402, synthetic PostgreSQL** | **93/93** | 0 | 0 | **Zalo OA provider thật NOT RUN**; contract timestamp/chữ ký/callback chỉ nghiên cứu tài liệu; **live route OFF**. Audit nguồn chính thức đã DONE (docs-only), **không phải PASS xác thực MAC OA** | [PR #53](https://github.com/minhdienhp2013/AUTO-IN/pull/53) HEAD `6a6a8f68c8c5dfdd6d52f59f27541dec348b0685`; [PG #38758903496](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38758903496), [CODE #38758904059](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38758904059), [bàn giao mới](https://github.com/minhdienhp2013/AUTO-IN/pull/53#issuecomment-6195594371) |
| **AI3 — PR #74 checklist *một job* Windows/Ricoh** | **Checklist DONE (chỉ tài liệu)** | 0 lỗi checklist được báo | 0 ca thực địa được bỏ qua | **In thật NOT RUN (0 lượt)**: chưa có **duyệt bằng văn bản đúng `job_id/order_id/revision/request_hash`**, giới hạn giấy; chưa xác minh model/serial/driver/queue/port tại máy Windows/Ricoh; chưa có người giám sát và đếm tờ thật. **Không ghi checklist DONE thành test thiết bị PASS** | [PR #74](https://github.com/minhdienhp2013/AUTO-IN/pull/74) HEAD mới `f1a18e94fd41bd889f95ac526018f00cf134cf43`; [bàn giao AI3 mới](https://github.com/minhdienhp2013/AUTO-IN/pull/74#issuecomment-6196683233) |
| **AI3 — one-job spooler giả, Python tài liệu/in (PR #101)** | **243** | **0** | **1** | **CI PR #74 HEAD `f1a18e9` không gọi pytest/compileall → Python NOT RUN tại workflow đó**. PR #101 thực thi Python với **31/31 blob cùng nội dung**; đây là test **`InMemorySpooler`, không hề xác minh Windows/Ricoh thật** | [PR #101](https://github.com/minhdienhp2013/AUTO-IN/pull/101) HEAD `f2ef1f6192427bfa4ff8a5f5bd7cb4fb3aad9d44`; [composition #38766609078](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38766609078), job `116531348496`; [PR #74 CI #38766676778](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38766676778) |
| **AI4 — PR #15 checklist IPH-01…IPH-10** | **Checklist DONE (chỉ tài liệu); vật lý 0/10** | **0** | **0** | **10/10 Safari iPhone NOT RUN**: thiếu **staging được phê duyệt, SHA UI/backend thực sự triển khai, tài khoản thử cô lập và quyền dùng iPhone vật lý**; không có log/ảnh Network từ thiết bị | [PR #15](https://github.com/minhdienhp2013/AUTO-IN/pull/15) HEAD `ff00980e152c21c740183d28569b97f4b6aa9b19`; [tiền kiểm IPH-01–10](https://github.com/minhdienhp2013/AUTO-IN/pull/15#issuecomment-6184020651) |
| **TN-037 / AI0 + chủ cửa hàng — release-gate vận hành** | **0 đơn thực địa được nghiệm thu trong hồ sơ này** | Chưa đo (không suy thành 0 lỗi) | **0 ca thực địa được tính PASS** | **NOT RUN / BLOCKED:** **210 đơn đạt trong tối thiểu 7 ngày sạch** chưa thực hiện; chưa có số đo hiện trường nhận diện ≥90%, xử lý hội thoại ≥80%, thử tải mô phỏng 100 đơn/ngày được xác nhận, hay phê duyệt chính thức của chủ | [Đặc tả TN-015/TN-021/TN-037](../spec/DAC_TA_TN001-TN037.md); [ma trận lịch sử bên dưới](#code-305--ma-trận-bổ-sung-đợt-3-2026-10-11) |

**CI/tài liệu mới nhất — không gộp nguồn khác SHA:** AI2 [CODE #38758904059](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38758904059) và [PG #38758903496](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38758903496) tại HEAD `6a6a8f68` **SUCCESS**: AI2 PG **93 PASS / 0 FAIL / 0 SKIP**; Python **199 PASS / 1 SKIP**. Sau PR #100, main `423adb1a` có [CODE #38756880490](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38756880490) và [composition #38756880427](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38756880427) **SUCCESS**: Core PG **39/39**, AI2 PG **93/93**, composition **26/26**, tất cả 0 FAIL/0 SKIP. Trước đó PR #98 [CODE #38661623589](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38661623589) và [composition #38661623645](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38661623645) cũng SUCCESS; không dùng kết quả ở PR merge ref làm AI5 rerun. **AI5 độc lập vẫn chỉ [run #38657817146](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38657817146)** trên product `7bf2127b`: PG/HTTP **18/18**, Python DryRun **42/42**, Chromium **28/28** synthetic PASS/0 FAIL/0 SKIP. **AI5 acceptance chạy riêng trên main `423adb1a`: NOT RUN** (không cần cho runtime unchanged ở thời điểm này). [Chi tiết](CODE404_PR96_AI5_INDEPENDENT_20261015.md).

**Điểm mới từ nghiên cứu AI2 (15/10/2026, chỉ tài liệu):** [PR53 source audit](https://github.com/minhdienhp2013/AUTO-IN/blob/6a6a8f68c8c5dfdd6d52f59f27541dec348b0685/docs/research/AI2_ZALO_OA.md) đối chiếu OA/ZBS portal (footer build **2026-10-14**, *không* phải schema contract version): ví dụ timestamp công khai **11/12/13 chữ số**, dù mô tả đơn vị ms; công thức `sha256(appId+data+timeStamp+OAsecretKey)` **chưa định nghĩa byte canonical** và không có Zalo-signed golden vector; **user_click_chatnow** khác ZBS **user_click_response_button**, chưa đủ chứng cứ gắn người bấm với challenge/customer; webhook retry khi lỗi kết nối có các mốc **30 giây, 5, 15, 30, 60 phút** — 15/30/60 phút có thể xung đột kiểm freshness ±5 phút **nếu timestamp không được làm mới**. Đây là **rủi ro chưa xác minh**, không tự sửa verifier, nới chống replay hay bật OA. Cần hợp đồng Zalo bản chính thức, raw request ký hợp lệ trong môi trường kín, contract retry/signature/identity và quyền thử OA cụ thể.

**AI5 đối chiếu độc lập AI3 spooler giả (15/10/2026):** [PR #74](https://github.com/minhdienhp2013/AUTO-IN/pull/74) HEAD cũ `c4a1ed9cb175ae612a03cfd486834ccc25936931` thêm đúng **3 file AI3**: `agents/windows/controlled_spooler.py` (in-memory fake only), `tests/unit/printing/test_controlled_spooler_403.py`, `docs/research/AI3_TAI_LIEU_RICOH.md`; HEAD mới `f1a18e94fd41bd889f95ac526018f00cf134cf43` chỉ bổ sung **2 ca test** trong file pytest. **PR #74** [CODE checks #38766676584](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38766676584) và [composition #38766676778](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38766676778) đều SUCCESS **nhưng workflow ở cây PR74 không có bước `python -m pytest` hoặc `python -m compileall`**; do đó **Python pytest tại đúng PR74 HEAD = NOT RUN**, không được coi CI tổng xanh là pytest PASS. **PR #101** (validation overlay trên `main` `423adb1a`, HEAD `f2ef1f6192427bfa4ff8a5f5bd7cb4fb3aad9d44`) có [job `116531348496`](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38766609078/job/116531348496) checkout merge ref `2311c0e92217f522a9f5e94a83c8cfcdc3d31db6`, **chạy thật** `python -m compileall -q workers/documents agents/windows tests/unit/documents tests/unit/printing` (PASS) và `python -m pytest -q tests/unit/documents tests/unit/printing` (**243 PASS / 0 FAIL / 1 SKIP**). AI5 đối chiếu GitHub recursive tree: **31/31 file dưới `workers/documents/**`, `agents/windows/**`, `tests/unit/documents/**`, `tests/unit/printing/**` có blob SHA giống hệt** giữa PR74 HEAD `f1a18e9` và PR101 HEAD `f2ef1f6`; 2 file thêm test sau `c4a1ed9` khiến không được báo một run trực tiếp trên `c4a1ed9`. Mock seam **chỉ nhận đúng lớp `InMemorySpooler`**, CLI vẫn DryRun, spooler giả ACK→`UNKNOWN`/`paper_verified:false`, không có `VERIFIED_DONE` hay retry tự động; **Ricoh/Win32/RAW9100/giấy thật = NOT RUN**. Đây là **bằng chứng mô phỏng mới được kiểm chứng**, đủ cập nhật ma trận chứ **không mở gate vận hành**.

**Release-gate:** **MÔ PHỎNG PASS / VẬN HÀNH THẬT BLOCKED / TN-037 NOT RUN**. **AI3** chờ phê duyệt **đúng 1 job** cùng `request_hash`, thiết bị/queue/driver xác minh tại chỗ, giới hạn giấy và giám sát (spooler không xác nhận giấy đủ). **AI4** chờ staging HTTPS được chủ phê duyệt, UI/backend deployed SHA, tài khoản thử cô lập, quyền thử iPhone 14 Pro Max và đối soát IPH-01…10 (**0 PASS, 0 FAIL, 0 SKIP, 10 NOT RUN**). **TN-037**: **210 đơn đạt/ít nhất 7 ngày sạch NOT RUN**; kết quả kiểm soát thực địa, tiêu chí 90%/80% và chủ phê duyệt chưa có. **Chưa thể tuyên bố V1 DONE, bật OA, in thật, merge hay deploy**.

**Quy tắc điều phối vòng tiếp:** Mỗi AI sau khi hoàn thành **báo cáo ngắn trực tiếp trong hội thoại**: mã việc / PR / HEAD / kiểm thử PASS-FAIL-SKIP-NOT RUN / blocker / chủ sở hữu bước tiếp. Bình luận GitHub là **bằng chứng/bàn giao**, **không tự gọi AI khác hoặc tự khởi động vòng tiếp**. **AI0 kiểm tra diff/CI/bằng chứng rồi mới giao việc tiếp**; khi cây mã sản phẩm thay đổi phải nghiệm thu lại trên exact product SHA, không suy từ CI trước. **AI5 lượt này chỉ sửa ma trận tài liệu, không tạo bằng chứng chạy mới**.

---


## AI5 CODE-402 official quarantine — independent real PostgreSQL 14/10/2026

AI0 product SHA **`25a99ce2d0ddae673489361d7fceca56c3b60151`**, AI5-only overlay SHA **`413860824677f35a7211174d8f243f0bbb471685`** (do not confuse overlay with product HEAD). [Simulation integration PUSH #38489353875](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38489353875) **SUCCESS** (PostgreSQL + Chromium); [CODE checks PUSH #38489353886](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38489353886) **SUCCESS**. PG **109 PASS / 0 FAIL / 19 SKIP**, HTTP **62 PASS / 0 FAIL / 73 SKIP**, browser **58 PASS / 0 FAIL / 72 SKIP**; Chromium status×viewport **14/14 PASS**. C402-OA-01..05 **5/5 PASS** against real `createOfficialZaloWebhookPlugin` Fastify raw-body composition and `zalo_official_quarantine`, no old text-only component or false QUEUED/unsupported assumption. Image/file/click => **NEEDS_HUMAN**, 2 independent PostgreSQL pools, replay same receipt and receipt time, verified MAC wrong OA returns 422, bad MAC 403, unbound text remains OA-only with NULL identity and no body. No candidate/Core confirmation/staff approval/print job/outbound; default live route remains **503/OFF**. First overlay `f355f21` had test fixture ReferenceError (3 FAIL), corrected without weakening assertions. **Current PR #31 has subsequently moved past target; recheck on its latest HEAD before calling current integration DONE**. Official live OA/Windows/Ricoh/physical iPhone/TN-037 **NOT RUN**. No merge/deploy.

---


## CODE-401 AI5 độc lập — mới nhất 14/10/2026

AI0 product PR #31 SHA `1c1b75fd8be7063add12c8510eec9d5d6742df54` + **2 file acceptance AI5** = overlay `f1d334bf90f2506157b12ac7c5a56eefe3267f6b`. [Simulation integration PUSH #38451399440](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38451399440) & [CODE checks #38451399746](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38451399746) đều **SUCCESS**. **PG 104 PASS/0 FAIL/19 SKIP**; **HTTP 62/0/68**; **browser 58/0/67**, Chromium pending_updates **14/14 PASS** desktop/mobile. Ca CODE401 mới dùng Core PG 2 pools, strict postback, signed OK fail-closed, sai scope/token/receipt; bắt buộc `received_at` PG và không tin `occurred_at`; replay & lost ACK, stale revision, handover, staff approve. Lỗi browser ở 2 overlay tiền nhiệm là **harness import Core ngoài integration mode**, đã sửa trước khi đo SUCCESS, không waive assertion. [Chi tiết](CODE401_AI5_INDEPENDENT_1C1B75F_20261014.md). **OA/Ricoh/iPhone/TN037 NOT RUN**.

---


## CODE-402 — AI5 nghiệm thu mới nhất, 14/10/2026

AI0 PR #31 HEAD `4822958713e6ee1c728babde790f4c7022ac02bc`, AI2 PR #53 HEAD `b7a51220b249d895ddd0a75bb67496300ed3923a`; **independent staging SHA `646aaa767bd3f37274e48a797ea03488cbbb6c42`** giữ mã sản phẩm y nguyên, chỉ thêm 3 file test AI5. [CI PUSH integration #38445735214](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38445735214) và [CODE checks #38445735081](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38445735081) đều SUCCESS. **PG 103 PASS/0 FAIL/19 SKIP; HTTP 62 PASS/0 FAIL/67 SKIP; browser 58 PASS/0 FAIL/66 SKIP**, Chromium 14/14 status×viewport PASS. CODE-402 1 independent signed-postback PG + 4 strict real AI2/AI1/AI0/normalizer suites PASS; candidate chỉ `PENDING_AI1_REVIEW`, không xác nhận/duyệt/in. C008 11/11 PASS; CODE405 11/11 PASS. [Ma trận chi tiết](CODE402_AI5_NGHIEM_THU_20261014.md). **Zalo OA/Ricoh/iPhone/TN-037 NOT RUN/BLOCKED.**

---


## CODE-008 AI5 — PR #48 Chromium 14/14 PASS, 13/10/2026

PR #48 nền `816adb5fd7ff24cc98cd5841c95a8d25a523e45d`; **staging CI push đúng SHA `33f793af444045cbc1c15387ec748f00847a21a5`** sau khi chỉ sửa harness AI5. [Simulation integration #38369695822](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38369695822) cả hai job PG/Chromium **SUCCESS**; [CODE checks #38369695850](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38369695850) SUCCESS. PG **98 PASS/0 FAIL/19 SKIP**, HTTP **61 PASS/0 FAIL/63 SKIP**, Chromium status **14/14 PASS** trên 1440×900/390×844. Chẩn đoán: lỗi parser kỳ vọng câu ở sai phần tử và đua loading trong **test harness AI5**, không phải lỗi sản phẩm AI4. Giữ fail-closed/khóa duyệt, không waiver. [Báo cáo chi tiết](CODE008_CHROMIUM_PR48_20261013.md). **Chưa CI trên SHA PR #18 mới**, AI0 chưa nhập patch AI5 mới vào PR #48/#31; TN-037/Zalo OA/Ricoh/iPhone thật **NOT RUN**.

---


## CODE-008/CODE-405 — AI5 kiểm trên AI0 SHA 9fb2bf1 (13/10/2026)

AI0 #31 HEAD `9fb2bf1bcd1ca9d59b912adf60d7fb8f3cabca54` có [CI PUSH integration SUCCESS](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38362911714): **91 PASS/0 FAIL/19 SKIP** PG, **54 PASS/0 FAIL/63 SKIP** HTTP, Chromium desktop/mobile PASS tổng quát. AI5 phát hiện **2 lỗi hiển thị read-model AI4** bằng test mới trên staging SHA `6a317e4f6abc68127fc0fbd020d1fd58cf03e06a` (chỉ +2 test AI5): [PG job](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38364941554/job/115187703075) **96 PASS/2 FAIL/19 SKIP**, HTTP **59 PASS/2 FAIL/63 SKIP**. Thực hiện đầy đủ CODE-008 9/9 PG + 2/2 composition và CODE405 5/5 PG + 6/6 composition **PASS**, không viện SKIP. **C008-UI-02/03 FAIL**: processing(0)/needs_human(0) bị đổi thành unknown; hệ thống vẫn khóa duyệt nhưng hiện sai trạng thái. AI4 PR #47 đã có fix cần AI0 nhập; Chromium 14 status×viewport mới **NOT RUN** do CI chưa chạy wrapper. Báo cáo [CODE008_AI5_AUDIT_SHA_9FB2BF1_20261013.md](CODE008_AI5_AUDIT_SHA_9FB2BF1_20261013.md). **TN-037 chưa đủ**.

---


## CODE-008 — MỚI NHẤT, 13/10/2026 (PG staging GREEN, V1 chưa DONE)

**AI0 PR #31 HEAD `faa0668c326393cc6a49cfa74fe682a606aeddb1`**, AI5 test-only staging **`0730cbd14f5386a431f74593ba0e4e49c8518490`**, hai workflow push [checks](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38283185322) / [integration](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38283185321) đều **SUCCESS**. [Bằng chứng chi tiết C008-PG-02](CODE008_NGHIEM_THU_20261012.md).

- **C008-PG-02 PASS** trên real PostgreSQL: signed synthetic webhook → artifact image registered + AI3 verification → AI2 durable worker ×2 → AI1 atomic `apply_incoming_batch` → **cùng order_id, revision mới, 0 approval/print job, không chuyển xác nhận cũ**, replay idempotent. Không manual append.
- **CODE-008 mới: 11/11 PASS**, CI AI5 `--integration` **91 PASS/0 FAIL/19 SKIP**, `--http` **54 PASS/0 FAIL/63 SKIP**; AI3 167 PASS/1 SKIP. Chromium desktop/mobile PASS.
- **Chưa nghiệm thu:** CI trên **SHA tích hợp PR31 mới có test AI5**, OA/Ricoh/iPhone thật, TN-037/210 đơn 7 ngày **NOT RUN/BLOCKED**. Kết quả RED bên dưới là lịch sử của pipeline chỉ gọi guarded propose() và **không** chạy worker.

---


## CODE-008 — HIỆN HÀNH (12/10/2026), P0 BLOCKED

AI5 đã viết/chạy độc lập PostgreSQL trên staging **`7dfefc4e51f0e603c38411f2ed85ac3ac90cc489`** dựa từ AI0 `c88fa3b`, **không sửa product**. [Ma trận/evidence chi tiết](CODE008_NGHIEM_THU_20261012.md) · [PG CI](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38245126219/job/114796979545).

| Phạm vi | PASS | FAIL | SKIP / NOT RUN |
|---|---:|---:|---|
| 9 ca CODE-008 direct PG (hai file >60s, revision, HTTP, race/replay, post-approve) | **7** | **2 P0** | 0 |
| 2 wrapper AI0 composition PG dùng TAP, đúng SHA | **2** | 0 | 0 |
| Toàn AI5 `--integration`, PG 18.3 | **89** | **2** | **19 SKIP** |
| Chromium React/Fastify PG desktop 1440×900 + mobile 390×844 | PASS | 0 | 0 |
| `--http` riêng | — | — | **NOT RUN** (PG step FAIL trước) |
| OA official, Ricoh, iPhone, explicit separate-order Port, TN-037 | — | — | **NOT RUN/BLOCKED** |

**Hai blocker bắt buộc chưa hoàn tất:** (1) file signed đến trước staff approve **chưa làm tăng active revision**; (2) trigger PG `AI0_PENDING_INBOUND_REVIEW` chặn chốt đúng nhưng Fastify **500 thay vì 409**. Bảo vệ giữ HELD, chống chia đơn/auto-print **không tương đương** tự nối đầy đủ file. Không waiver, không DONE V1.

---


## CODE-405 — AI5 đã đồng bộ patch 7 lỗi, xác minh đúng SHA (12/10/2026)

**AI5 PR #18** giữ nhánh `ai5/dot3-integrated-acceptance`, không reset/sửa sản phẩm. Bản sửa nghiệm thu được đồng bộ **nguyên blob từ AI0 commit `823237342dd9b6d0c1db5430e72b311d197056d9`**: `code405-composition-pg.test.mjs`, `integrated-webhook.test.mjs`, `code405-subprocess-evidence.mjs`, `code405-subprocess-evidence.test.mjs`, `run.mjs`. Không xóa ca test; 7 lỗi cũ là 6 wrapper composition và 1 webhook nested test.

**Root cause:** Node v24 test runner parent kế thừa `NODE_TEST_CONTEXT=child-v8` vào child `node --test` làm child bị bỏ qua và đôi khi exit 0 với output rỗng. Node reporter mặc định là spec không khớp parser TAP cũ. **Fix:** child chạy `--test-reporter=tap` và `isolatedTestChildEnv()` xóa `NODE_TEST_CONTEXT`; `assertVerifiedTapSummary()` yêu cầu output không rỗng, đủ 6 bộ đếm `tests/pass/fail/skipped/cancelled/todo`, `tests>0`, `pass===tests`, tất cả fail/skip/cancelled/todo=0. Không hard-code 1 test: file nguồn có thể nhiều test.

### Bằng chứng chính xác

- **GitHub Actions PUSH đúng AI0 SHA `823237342dd9b6d0c1db5430e72b311d197056d9`:** [CODE checks #38216608448](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38216608448) SUCCESS; [Simulation integration #38216608417](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38216608417) SUCCESS với job [PostgreSQL 114702715075](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38216608417/job/114702715075) và [Chromium 114702714940](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38216608417/job/114702714940) SUCCESS. Git checkout job và AUTOIN_INTEGRATION_SHA đã được đối chiếu đúng SHA; 2 workflow pull_request khác cũng SUCCESS nhưng không dùng thay push.
- **PostgreSQL CI:** AI1 core **23 PASS/0 FAIL/0 SKIP**, AI2 **50 PASS/0 FAIL/0 SKIP**, composition **20 PASS/0 FAIL/0 SKIP**; AI3 **167 PASS/0 FAIL/1 SKIP**. AI5 `node tests/acceptance/run.mjs --integration`: **80 PASS/0 FAIL/19 SKIP**, gồm **7/7 bài trước FAIL đã PASS**; HTTP `--http`: **54 PASS/0 FAIL/52 SKIP**. SKIP ở runner khác chế độ không chuyển thành PASS.
- **Chromium product CI:** `web/package-lock.json`, `npm ci`, `VITE_DEMO_MODE=false` build; Fastify + PG synthetic staff session, desktop **1440×900 PASS**, mobile **390×844 PASS**, preview PNG tamper bị từ chối và không tự approve/print/deliver. Không phải iPhone thật.
- **AI5 local độc lập:** kiểm hash `git hash-object` của **hai blob** `code405-subprocess-evidence.mjs` (`810f1e97dceff534c023ab90fae29bef8892871d`) và test (`1645362c6654201721eb432b30a241f72bfc5769`) **trùng GitHub AI0**. `node --test tests/acceptance/code405-subprocess-evidence.test.mjs tests/acceptance/code405-exact-sha.test.mjs` trên Node v22.16.0: **11 PASS / 0 FAIL / 0 SKIP / 0 CANCELLED / 0 TODO**, trong đó **nested child thật** chạy ≥3 test, không chỉ parse fixture.
- **Giới hạn nguồn chứng cứ:** không có PostgreSQL server/npm registry/GitHub git DNS để chạy lại toàn repo từ container AI5; PostgreSQL/HTTP/Chromium nói trên là **CI thực thi trên SHA tích hợp AI0**, không phải CI của nhánh AI5 sau sync. 5 blob patch trên nhánh AI5 đã được đối chiếu SHA nguồn; AI0 cần nhập patch vào SHA tích hợp kế tiếp rồi chạy CI đúng SHA để tránh lệch.

| Phạm vi | Trạng thái |
|---|---|
| 7 lỗi harness CODE-405 trên tích hợp `823237342dd9b6d0c1db5430e72b311d197056d9` | **PASS 7/7**, không còn FAIL |
| Bản sửa 5 file trên AI5 branch mới | **COMMITTED**, CI của HEAD nhánh AI5 **NOT RUN** |
| AI5 local selftest parser + nested child | **11 PASS / 0 FAIL / 0 SKIP** |
| CODE-405 Zalo confirmed từ credential/challenge verified thực sự | **NOT RUN**: synthetic OK chỉ candidate, không tạo confirmation |
| Real Zalo OA / Windows Ricoh / iPhone / TN-037 ≥210 đơn trong ≥7 ngày | **NOT RUN / BLOCKED** |

**TN-037 và V1 vẫn BLOCKED**; 7 lỗi kỹ thuật harness đã được sửa không thay cho nghiệm thu kinh doanh, không phát tin OA thật/in Ricoh/merge/deploy.

---

## CODE-405 — cập nhật kết quả CI SHA mới nhất (12/10/2026)

**AI0 PR #31 đã tiến lên HEAD `fb4af186d62adc3d91848f1306576f07cf35f4ee`.** Bằng chứng của `e16f69a` bên dưới trở thành lịch sử; không lấy kết quả cũ thế chỗ. Các lượt **PUSH đúng SHA mới** đã xác minh:

- [CODE checks #38213694609](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38213694609): SUCCESS.
- [Simulation integration #38213694522](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38213694522): SUCCESS; PostgreSQL job `114693400470` và product-browser job `114693400167` đều SUCCESS.
- PR-triggered CI cũng SUCCESS nhưng chạy trên merge ref, không tính thay push; log checkout Git HEAD của cả hai job chính khớp `fb4af186d62adc3d91848f1306576f07cf35f4ee`.

| Hạng mục trên đúng SHA này | PASS | FAIL | SKIP/NOT RUN |
|---|---:|---:|---|
| AI1 core/PostgreSQL | 20 | 0 | 0 |
| AI2 synthetic | 43 | 0 | 0 |
| AI0 composition PG (có signed `OK` candidate preflight) | 20 | 0 | 0 |
| AI3 Python | 140 | 0 | 1 SKIP |
| AI5 existing `--integration` | 58 | 0 | 19 SKIP |
| AI5 existing `--http` | 43 | 0 | 41 SKIP |
| Chromium product Fastify/PG 1440×900 + 390×844 | PASS cả hai viewport | 0 | 0 |
| **6 wrapper composition CODE-405 mới** | — | — | **NOT RUN** trên SHA tích hợp mới |
| 5 PG confirmation cases CODE-405 + browser wrapper mới | — | — | **NOT RUN** trên SHA tích hợp mới |
| OA/Ricoh/iPhone thật, TN-037 | — | — | **NOT RUN/BLOCKED** |

Ca signed synthetic Zalo `OK` của AI0 trả **`candidate_requires_credential` với `customer_credential_verified:false`** và **0 core_confirmations/approvals/print_jobs**. Sai OA/shop/customer, stale revision/hash/generation, quote cũ và HUMAN takeover bị chặn; **không chứng minh đã có customer confirmation hợp lệ**. CODE-405 bây giờ có wrapper gọi đúng bài PG `confirmation-candidate-pg.test.mjs` nhưng wrapper mới vẫn chưa có CI.

**V1/TN-037 vẫn BLOCKED.** Khi AI1/AI2 bàn giao Port sự kiện chứng thực và AI0 tích hợp test AI5, phải chạy lại trên SHA tích hợp kế tiếp. 210 đơn ≥7 ngày, OA/Ricoh/iPhone thật chưa thực hiện.

---

## CODE-405 — trạng thái hiện hành 2026-10-12

**AI0 PR #31 HEAD `e16f69ace72f41b82bd7438cc97b0c275fc57f64`** (CODE-007 giao ngày 12/10). Bằng chứng **push đúng SHA**: CODE checks #38212405872 SUCCESS; Simulation integration #38212405914 SUCCESS, PostgreSQL và product-browser jobs cùng SUCCESS. Check PR runs tách riêng. Báo cáo chi tiết: [CODE405_NGHIEM_THU_20261012.md](CODE405_NGHIEM_THU_20261012.md).

| Hạng mục TN | Đã chạy / chứng cứ | SKIP/NOT RUN |
|---|---|---|
| TN-007/012/017/019/026/027/033/035/036 | AI1 core 20 PASS; composition 19 PASS; AI5 integration 58 PASS CI simulation/PG | AI5 runner còn 19 SKIP |
| TN-001/002/005/006/012/022 (synthetic) | AI2 43 PASS; signed synthetic OA/AI3 document fact verified, tamper → HUMAN | **OA thật NOT RUN** |
| TN-011/025/034 source/preview | Real AI3-derived preview PG tests; SHA/manifest/tamper verified | Thiết bị/giấy thật NOT RUN |
| TN-008/010/032 Chromium | AI0 product-browser job PASS 1440×900/390×844, real Fastify/PG staff session | iPhone thật NOT RUN |
| CODE-405 customer confirmation | New 5 PG direct-service cases written; candidate→verified-event Port chưa nối | **New tests NOT RUN, verified OA confirm NOT RUN** |
| CODE-405 replay/two workers/ACK/DryRun | New 5 composition wrappers written | **New wrappers NOT RUN on new SHA** |
| TN-015/021/037 | Không có báo cáo thực địa đủ mẫu | **BLOCKED, chưa đạt nghiệm thu V1** |

**Những bảng CODE-105/CODE-305 bên dưới là lịch sử; các số của SHA cũ không thay bằng chứng SHA mới.**

---

## Trạng thái hiện hành — xác minh lại 2026-10-12

**HEAD mới nhất PR AI0 #25:** `d3e53461a5cc71d0b96b24b069b5240ca9dcd71e` (Draft, chưa merge). **Không có SHA tích hợp mới hơn** ở thời điểm kiểm tra. Bằng chứng dưới đây lấy từ GitHub Actions **PUSH đúng SHA**; AI5 đọc lại job log, không tự nhận đã chạy PostgreSQL mới trong container.

- [Simulation integration — PUSH #38165256655](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38165256655), job `114546378165`: SUCCESS.
- [CODE checks — PUSH #38165256659](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38165256659): SUCCESS.
- Không dùng SHA cũ `15c1ac7` hoặc PR-triggered merge ref để thay thế.

| Hạng mục kiểm thử | PASS | FAIL | SKIP / NOT RUN | Mức kết luận |
|---|---:|---:|---|---|
| AI1 PostgreSQL/core | 16 | 0 | 0 | CI trên PostgreSQL 18.3 thật |
| AI2 Zalo unit/integration | 36 | 0 | 0 | Simulation, không phải OA live |
| Composition Fastify/PostgreSQL | 9 | 0 | 0 | Có 1 bài synthetic raw webhook → PG (signature/scope/dedupe) |
| AI3 Python documents/printing | 100 | 0 | 1 SKIP | Không tính SKIP thành PASS |
| AI5 PG/DryRun product | 20 | 0 | 0 | Simulation; không phải Ricoh |
| HTTP auth (5) + readiness (1) | 6 | 0 | 0 | Anonymous, không chứng minh auth E2E |
| Full runner --integration | 50 | 0 | 19 SKIP | Legacy/không nối |
| Full runner --http | 36 | 0 | 40 SKIP | PG tắt, legacy và HTTP-ZALO-01 chưa nối runtime mặc định |
| AI5 selftest guard Node local | 6 | 0 | 0 | Chỉ fixture/browser preflight, không kết nối sản phẩm |
| Browser AI4 desktop/mobile | — | — | NOT RUN | AI4 HEAD `dbf4986`: chưa package-lock.json / build |
| HTTPS agent CLI, ACK mất, crash/restart | — | — | NOT RUN | Thiếu test TLS/token/job riêng từng scenario |
| OA thật, Ricoh, iPhone, 100 đơn/ngày, 210 đơn/≥7 ngày | — | — | NOT RUN | Chưa có dữ liệu thực địa |

**TN-037: BLOCKED**, chưa đủ tỷ lệ nhận diện ≥90%, tự xử lý ≥80%, tải 100 đơn/ngày, 210 đơn/ít nhất 7 ngày, thiết bị thật và duyệt chủ. Không đánh dấu toàn hệ thống DONE.

AI4 HEAD `dbf4986da7c7786afbaf6e2a5f9871136867cbad` có báo cáo 48/48 UI unit PASS nhưng lockfile/npm ci/typecheck/build chưa đạt; không đổi thành browser PASS. Bộ test mới trên AI5 PR #18 chưa có CI riêng ở HEAD; phải tích hợp và chạy lại khi có SHA mới.

**Các bảng bên dưới là lịch sử tại thời điểm viết trước; phần này là trạng thái mới nhất.**

---

**Mặc định tất cả ca nghiệm thu sản phẩm CHƯA CHẠY.** Fixture PASS không phải bằng chứng phần mềm đúng. Chỉ dùng giấy tờ tổng hợp, không dùng file khách.

| TN | Chủ code | Ca thử / yêu cầu | Bằng chứng |
|---|---|---|---|
| TN-001 | AI2 | gom tin | INTEGRATION NOT RUN |
| TN-002 | AI2 | tuyến mua hàng | INTEGRATION NOT RUN |
| TN-003 | AI2 | ngoài giờ | INTEGRATION NOT RUN |
| TN-004 | AI3 | file ZIP >5 | INTEGRATION NOT RUN |
| TN-005 | AI2/AI3 | nhận diện | INTEGRATION NOT RUN |
| TN-005A | AI2/AI3 | local before LLM | INTEGRATION NOT RUN |
| TN-006 | AI2 | trả lời | INTEGRATION NOT RUN |
| TN-007 | AI1 | unapproved_order, stale_revision | INTEGRATION NOT RUN |
| TN-008 | AI4 | push | INTEGRATION NOT RUN |
| TN-009 | AI3 | capability | INTEGRATION NOT RUN |
| TN-010 | AI4 | QR | INTEGRATION NOT RUN |
| TN-011 | AI1/AI3 | unauthorized_preview | INTEGRATION NOT RUN |
| TN-012 | AI1/AI2/AI3 | unknown_after_crash, duplicate_webhook | INTEGRATION NOT RUN |
| TN-013 | AI2 | cost alarms | INTEGRATION NOT RUN |
| TN-014 | AI2 | rule version | INTEGRATION NOT RUN |
| TN-015 | AI0/AI5 | 210/7 days | FIELD / GATE NOT RUN |
| TN-016 | AI0 | end-to-end | INTEGRATION NOT RUN |
| TN-017 | AI1 | forged_actor | INTEGRATION NOT RUN |
| TN-018 | AI3 | long text | INTEGRATION NOT RUN |
| TN-019 | AI1 | deposit_short | INTEGRATION NOT RUN |
| TN-020 | AI1 | customer retention | INTEGRATION NOT RUN |
| TN-021 | AI2/AI5 | 90%/80% metrics | FIELD / GATE NOT RUN |
| TN-022 | AI2 | OA verification | FIELD / GATE NOT RUN |
| TN-023 | AI3 | spooler | FIELD / GATE NOT RUN |
| TN-024 | AI1 | audit | INTEGRATION NOT RUN |
| TN-025 | AI3 | sheets/faces/pages | INTEGRATION NOT RUN |
| TN-026 | AI1 | sending_revision_race | INTEGRATION NOT RUN |
| TN-027 | AI1/AI2 | handover_race | INTEGRATION NOT RUN |
| TN-028 | AI1/AI2 | holiday | INTEGRATION NOT RUN |
| TN-029 | AI3 | duplex/scale | INTEGRATION NOT RUN |
| TN-030 | AI1 | partial_delivery_exception | INTEGRATION NOT RUN |
| TN-031 | AI1 | abandoned/reminders | INTEGRATION NOT RUN |
| TN-032 | AI1/AI4 | mode/owner | INTEGRATION NOT RUN |
| TN-033 | AI1 | large_quote_unconfirmed, deposit_short | INTEGRATION NOT RUN |
| TN-034 | AI3 | file fonts/preview | INTEGRATION NOT RUN |
| TN-035 | AI1/AI3 | manual_lock, unknown_after_crash | INTEGRATION NOT RUN |
| TN-036 | AI1 | partial_delivery_exception | INTEGRATION NOT RUN |
| TN-037 | AI0/AI5 | release gate | FIELD / GATE NOT RUN |

**Chặn P0:** thiếu duyệt, stale, trùng job, giả quyền, UNKNOWN tự retry, in sai, rò dữ liệu. Có P0 phải chuyển SAFE qua AI0, sửa đúng module và chạy lại; không tự in thật.

**TN-021/037:** yêu cầu nhận diện ≥90%, hội thoại phổ biến tự xử lý ≥80%; mẫu số khóa trước, thiếu dự đoán tính sai, không loại ca khó; bước nhân viên duyệt là bắt buộc và không tính là lỗi của AI. 210 đơn đạt trong ≥7 ngày sạch lỗi nghiêm trọng + mô phỏng 100 đơn/ngày, OA/Ricoh/iPhone có bằng chứng thật, chủ duyệt mở chính thức. Chưa có các bằng chứng đó.

## CODE-305 — ma trận bổ sung đợt 3 (2026-10-11)

**BASE MODULE:** `5707b81128e7e84180db57865896d52d256dac33`. **Tích hợp CODE-006:** CHƯA CÓ SHA tại thời điểm viết. Các dòng dưới chỉ là ca đã **viết code**, sản phẩm vẫn **NOT RUN / BLOCKED**. Kết quả selftest không chuyển trạng thái nghiệm thu.

| TN | Test trên sản phẩm thật (simulation, PostgreSQL test) | Chủ xử lý lỗi | Trạng thái |
| --- | --- | --- | --- |
| TN-007, TN-026 | PG-01–04, PG-13, PG-16–17: stale/claim kép/mark kép/FIFO xác nhận khác thứ tự duyệt | AI1 | NOT RUN |
| TN-012, TN-023, TN-035 | PG-05/11, DRYRUN-12/18: UNKNOWN, crash journal, không gửi lại, không chứng minh giấy thật | AI1/AI3 | NOT RUN |
| TN-017 | PG-14 printer scope; HTTP anonymous staff/agent denial | AI1/AI0 | NOT RUN |
| TN-019, TN-030, TN-033, TN-036 | PG-07–10, PG-15: giá/cọc/hoàn/đóng ngoại lệ còn nợ | AI1 | NOT RUN |
| TN-027 | PG-19/20: generation cũ bị chặn và handover đồng thời | AI1/AI2 | NOT RUN |
| TN-001, TN-012, TN-022 | HTTP-ZALO-01 từ chối webhook không chữ ký nếu AI2 ingress tích hợp | AI0/AI2 | NOT RUN |
| TN-008, TN-010, TN-032 | UI browser local Chromium; mobile viewport không phải iPhone thật | AI4 | NOT RUN |
| TN-015, TN-021, TN-037 | 90%/80%, 100 đơn/ngày, 210 đơn ≥7 ngày, OA/Ricoh/iPhone thật và bằng chứng release gate | AI0/AI5 | FIELD NOT RUN |

**Release gate bổ sung:** yêu cầu `evidence.integration_sha` 40 ký tự và `evidence.product_runs.pg/http/dryrun/browser` từng mục có `status:'PASS'`, `fail:0`, `skip:0`, `pass >= 1` và **cùng SHA**; các điều kiện nghiệp vụ/thiết bị TN-037 trước đây vẫn giữ nguyên. Một bài SKIP không phải PASS.

**Nguyên tắc báo cáo:** Bất kỳ ca P0 FAIL -> SAFE, không tự gửi in, không tự nhắn OA. File/code AI5 chỉ báo lỗi, chủ module tương ứng sửa. Mọi báo cáo phải ghi SHA, lệnh tái hiện, observed/expected và bằng chứng đã che thông tin nhạy cảm.

## Cập nhật xác minh 2026-10-12

Xem [Bằng chứng SHA 15c1ac7](CODE305_SHA_15c1ac7_EVIDENCE.md). Các bảng NOT RUN ở trên là trạng thái lịch sử trước khi AI0 cấp SHA. Kết quả mới của GitHub Actions **push trực tiếp SHA**: 20 PG/DryRun PASS/0 FAIL/0 SKIP; HTTP auth/readiness 6 PASS/0 FAIL/0 SKIP; 1 bài webhook synthetic Fastify/PostgreSQL PASS. Toàn runner --integration 50 PASS/19 SKIP; --http 36 PASS/40 SKIP (các SKIP không phải kết quả PASS sản phẩm). Browser BLOCKED vì AI4 chưa có package-lock.json. Zalo OA thật, Ricoh thật, iPhone thật và TN-037 vẫn NOT RUN/BLOCKED. Không nâng trạng thái TN-037 dựa trên CI simulation.

## Trạng thái mới trên SHA CODE-006 `d3e53461`

Bảng phía trên và báo cáo `15c1ac7` là lịch sử. Bằng chứng đang có trên [SHA push mới](CODE305_SHA_D3E53461_EVIDENCE.md): AI5 PG/DryRun **20 PASS/0 FAIL/0 SKIP**; HTTP auth/readiness **6 PASS/0 FAIL/0 SKIP**; synthetic raw Fastify→PostgreSQL **PASS** trong 9 ca composition. Toàn runner integration 50 PASS/19 SKIP; HTTP 36 PASS/40 SKIP. Browser desktop/mobile và agent HTTPS fixture mới **NOT RUN**. Zalo OA thật, Ricoh thật, iPhone thật và TN-037 **BLOCKED**. Không lấy kết quả SHA cũ hoặc selftest làm nghiệm thu thực tế.
