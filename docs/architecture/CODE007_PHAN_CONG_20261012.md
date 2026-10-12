# CODE-007 — Giao tiếp tục code cho AI1–AI5, ngày 12/10/2026

**Điều phối:** AI0 | **Nền tham chiếu tích hợp đã PASS:** `3f0380abed2294fc18d09294cd6a8c9562108710` | [PR #31](https://github.com/minhdienhp2013/AUTO-IN/pull/31) Draft | 6/6 CI success, composition 19/19 PASS. **Không gọi đây là bản phát hành V1.**

**Mục tiêu CODE-007:** Một khách có danh tính được xác thực xác nhận chính xác yêu cầu in thuộc active_revision/request_hash (và quote_revision khi buộc xác nhận giá), AI2 xử lý yêu cầu/ứng viên xác nhận an toàn; AI1 ghi nhận xác nhận đúng bằng chứng; AI4 hiển thị trạng thái thật; AI3 kiểm bất biến preview/nguồn đối với quá trình duyệt; AI5 kiểm thử toàn luồng trên synthetic Zalo + real PostgreSQL + real Chromium + DryRun, không động đến OA thật, thiết bị in thật hay người dùng thật.

## Ranh giới bảo mật/hợp đồng AI0 giữ

- Không coi câu “OK”, “đồng ý”, một nút click không chứng thực, một event_id khách tự khai, hoặc nội dung AI tự suy đoán là xác nhận hợp lệ. **Không giả danh Principal customer.** Danh tính và provenance của sự kiện phải qua kênh được máy chủ xác thực và ánh xạ OA/shop/customer/conversation đã khóa. Chỉ xác nhận khi đúng order_id + active_revision + request_hash + loại xác nhận + quote_revision nếu cần. Nếu thiếu bằng chứng/challenge/thông tin → NEEDS_HUMAN/PENDING, không ghi `core_confirmations`.
- AI2 không được trực tiếp ghi `core_confirmations` hoặc tạo xác nhận trên behalf khách; AI0 nối adapter có xác thực sau khi AI1 công bố Port chính thức. Không thay đổi `backend/composition/**` hay `scripts/**` ngoài AI0.
- AI3 preview hash/manifest/tổng số tờ vẫn không phải khách xác nhận hay bằng chứng đã in. Không tự in hoặc làm giả `VERIFIED_DONE`. Mất ACK, crash, UNKNOWN tuyệt đối không tự gửi lại; chỉ chủ có quyền in lại.
- Chỉ trạng thái đã cam kết PostgreSQL qua AI1, có xác nhận request hiện hành và xác nhận giá tương ứng (nếu >150 tờ hoặc chi phí đáng kể) mới đủ điều kiện nhân viên duyệt. **Duyệt là thao tác riêng của nhân viên**, không phải hậu quả tự động của tin nhắn khách. Thiếu cọc cần cảnh báo và ghi thiếu; không chặn tuyệt đối sau khi nhân viên xác nhận cảnh báo. Tách in/giao/tiền.
- Không cấp live Zalo token, thực hiện OA gửi thật, in Ricoh/Windows thật, merge/deploy, hoặc chạy test lên DB sản xuất.
- Mỗi AI cập nhật đúng nhánh/PR hiện có; kiểm tra Git HEAD/AGENTS.md trước sửa; không reset/cherry-pick đè file AI khác. Nếu cần đổi API/schema/wire chung, **đề xuất hợp đồng ngắn với AI0 trước**. Bàn giao tối đa 6 dòng đúng docs/QUY_TAC_AI.md, ghi commit SHA, chạy test thật/SKIP/NOT RUN.

## Nhiệm vụ song song

### AI1 — CODE-401: xác nhận có chứng cứ + giao dịch PostgreSQL
**PR [#16](https://github.com/minhdienhp2013/AUTO-IN/pull/16)**, chỉ sửa `backend/core/**`, `backend/api/**`, `backend/storage/**`, `backend/jobs/**`, test AI1. Kiểm tra và tận dụng `OrderService.confirm` đã có; đề xuất Port để AI0 ghi nhận customer confirmation từ *bằng chứng sự kiện đã được xác minh*, thay vì tạo `Principal customer` dựa vào text/webhook. Ràng buộc shop/customer/conversation/order_id/current revision/hash/kind/quote revision/verified event identity; kiểm idempotency, duplicate, 2 worker, lost ACK, race đổi revision và takeover trong **cùng transaction/row lock**. Bất kỳ stale/replayed/wrong-shop/wrong-customer/challenge-unknown nào đều dừng an toàn. Thử approve trước confirm, sau confirm current revision, quote missing/>150, cạnh tranh; không tạo lệnh in khi chỉ confirm. Không tự sửa schema chung ngoài quyền sở hữu, cần đổi wire báo AI0.

### AI2 — CODE-402: nhận diện ứng viên xác nhận, không giả xác nhận khách
**PR [#19](https://github.com/minhdienhp2013/AUTO-IN/pull/19)**, chỉ sửa `backend/conversation/**`, `backend/integrations/zalo/**`, `backend/ai/**`, test AI2. Phát hiện tin nhắn xác nhận theo hội thoại nhưng KHÔNG biến “OK” thành confirm mặc nhiên. Chỉ phát `confirmation_candidate`/Port cho AI0/AI1 khi một challenge/đơn cụ thể đã được chứng thực về shop/OA/customer/conversation/current revision/hash và tồn tại sự kiện webhook hợp lệ; nếu thiếu thì hỏi lại/chuyển người và không ghi confirm. Bảo toàn durable queue/dedupe/generation lock/takeover; duplicate, hai worker và restart không phát hai hành động; DeepSeek chỉ phân loại intent, không xác thực thay kênh. Thiếu hợp đồng chốt thì triển khai phần thuần + tests, ghi BLOCKED nơi phụ thuộc AI1/AI0.

### AI3 — CODE-403: chứng cứ file bất biến ở ranh giới xác nhận/duyệt
**PR [#20](https://github.com/minhdienhp2013/AUTO-IN/pull/20)**, chỉ sửa `workers/documents/**`, `agents/windows/**`, test AI3 và tài liệu AI3. Thêm tests/guard để revision/hash/file nguồn/rendered PNG/manifest/plan không đổi sau processor: PDF/ảnh/ZIP, thay source/bytes sau tạo preview, ngắt giữa render/preview/agent, nhiều file và >150 tờ, UNKNOWN/lost ACK/crash/restart vẫn fail-closed và không resend. Nếu cần metadata per-file, dùng đúng sealed schema AI3 hiện có; không trả file ref khách tùy ý. Mở rộng DryRunDriver/agent test đủ nhánh, **không bật driver in thật** và không tự xác nhận khách.

### AI4 — CODE-404: giao diện trạng thái xác nhận/duyệt đúng read model
**PR [#15](https://github.com/minhdienhp2013/AUTO-IN/pull/15)**, chỉ sửa `web/**`, `tests/ui/**` (tài liệu AI4 nếu cần). Đồng bộ patch tích hợp AI0 hiện tại từ PR #31: bind native `fetch`, bearer preview `{pages,files}`, gallery + per-file hash, session/Blob cleanup. Đọc AI1 nested read model hiện hành. Hiển thị rõ `chưa có xác nhận khách`, `khách xác nhận đúng revision/hash`, `chưa xác nhận giá` khi >150 tờ/chi phí đáng kể, `sẵn sàng để NHÂN VIÊN duyệt` nếu đủ; KHÔNG tự bấm approve. Không dựng nút tự xác nhận thay khách từ tài khoản staff. Stale revision, logout, 401/409, offline, source hash mismatch, 2 viewport Chromium desktop/mobile: ẩn thông tin xác minh cũ và khóa approve, không tạo kết quả in/giấy giả. Chạy `npm ci`, test, typecheck, build, browser thật; ghi log và SHA.

### AI5 — CODE-405: nghiệm thu chéo có bằng chứng SHA
**PR [#18](https://github.com/minhdienhp2013/AUTO-IN/pull/18)**, chỉ `tests/acceptance/**`, `tests/fixtures/public/**`, `docs/acceptance/**`; không sửa code sản phẩm. Viết test runnable và ma trận cho confirmed vs absent/stale request/price confirmation, 2 worker, duplicate/replay, wrong OA/shop/customer, takeover/generation old, tamper source/preview, >150 sheets quote, thiếu cọc, UNKNOWN/lost ACK/crash/restart, approve by staff only, real browser desktop/mobile và PostgreSQL/DryRun. Chạy test đúng SHA PR #31 sau khi AI0 tích hợp AI1–AI4; phân biệt PASS/FAIL/SKIP/NOT RUN và synthetic-vs-live. Chưa có OA token/Ricoh/210 đơn trong ≥7 ngày → NOT RUN, không đánh dấu V1 DONE.

## Điều kiện bàn giao đợt này

1. AI1–AI4 mỗi người có code/test/commit thật ở nhánh riêng + PR, AI5 có test/ma trận; AI0 tiếp nhận đúng phạm vi, không merge tự động.
2. AI0 quyết định hợp đồng chứng thực customer từ sự kiện trước khi nối (cấm giả `Principal`).
3. PostgreSQL + Fastify + Chromium desktop/mobile + DryRun có kết quả chính xác trên **cùng SHA tích hợp**; mọi lỗi P0 hoặc test FAIL chặn V1.
4. 6 AI không tự merge/deploy, không phát lệnh in thật, không nhắn OA thật. Chỉ chủ cửa hàng được duyệt mở vận hành/in thử thiết bị thật.

**Lưu ý:** Bình luận GitHub giúp bàn giao nhiệm vụ và lưu audit; **không tự khởi chạy agent ChatGPT**. Chủ phải gửi prompt cho từng phiên AI1–AI5 hoặc dùng hệ điều phối có khả năng kích hoạt các phiên đó.


## AI0 CODE-007 — điểm nối kiểm tra sự kiện trước xác thực (bàn giao 12/10/2026)

**Code thực tế:** `backend/composition/confirmation-candidate.ts` và `tests/integration/composition/confirmation-candidate-pg.test.mjs`, commit `c6cafa147f3db53e06a3e127bd4d0548b8afb9a6`; PostgreSQL và Chromium product-browser SUCCESS tại [job PG](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38213473519/job/114692700169). **AI0 composition tăng lên 20/20 PASS**.

Hợp đồng tạm: `preflightSyntheticConfirmationCandidate(SqlPool, trustedScope, input)` chỉ chấp nhận `trustedScope={kind:'synthetic_fixture',shop_id,oa_id}` do server cấu hình, `input={order_id,event_id,expected_revision,expected_request_hash,expected_generation,kind,quote_revision?}`. Kiểm dữ liệu Zalo sự kiện chữ đã được ingress ghi bền, liên kết chính xác shop/OA/customer/conversation/order, control AI (không bị tiếp quản), active revision/hash, verified plan và quote_revision nếu `kind='quote'`. Trả `blocked` với lý do an toàn hoặc `candidate_requires_credential` chứa `customer_credential_verified:false` — **đây không phải xác nhận hoặc quyền duyệt**, không cấp `Principal` và không viết DB.

Ca PG thật sử dụng webhook **fixture có chữ ký**, cố tình gửi văn bản `OK`, kết quả vẫn **0 customer confirmation, 0 approval, 0 print job**. Webhook trùng chỉ lưu một lần; sai khách/OA/shop, stale generation/revision/hash, thiếu plan/quote, HUMAN takeover, khóa thủ công đều fail-closed. Đây là tiền kiểm *read-only*, không thể thay thế giao dịch cùng row lock trong AI1 và không tự khẳng định danh tính khách được xác thực bởi OA thật.

**AI1 CODE-401:** xuất Port ghi nhận xác nhận có **verified credential/challenge/token** và sự kiện nguồn gốc, kiểm lặp lại tất cả điều kiện bên trong **cùng giao dịch PostgreSQL** trước INSERT; không coi kết quả tiền kiểm là quyền ghi.

**AI2 CODE-402:** xuất ứng viên nhận diện tin nhắn (không xác thực/ghi confirm). Bảo đảm OA transport verifier và event persisted đúng phạm vi; nếu không có challenge/credential, phải hỏi lại/chuyển nhân viên; không chuyển `OK` thành xác nhận ngầm.

**AI0 CODE-007 tiếp theo:** chỉ nối hai Port khi AI1 và AI2 bàn giao SHA cùng contract chốt; sau đó thử HTTP+PG đúng SHA, xác nhận customer flow, các ca wrong OA/customer/generation, không gửi OA thật và không in thật. AI3/AI4/AI5 tiếp tục CODE-403/404/405 độc lập. Không merge/deploy; PR #31 vẫn Draft.


## CODE-008 — Quy tắc kinh doanh đã chốt: cùng chat + cùng đợt trao đổi = MỘT đơn

**Chủ cửa hàng chốt ngày 12/10/2026:** Trong phạm vi **cùng shop/OA + cùng customer_id + cùng conversation_id + cùng một đợt trao đổi về việc in**, mọi file và tin nhắn liên quan phải thuộc **một đơn in**, dù gửi thành nhiều tin, nhiều file hoặc qua hơn một lượt gom tin AI2. Không tạo mỗi tin nhắn thành một đơn.

- `MessageBatcher` hiện gom tối đa 60 giây từ tin đầu và chờ 10 giây sau tin bổ sung. **Đây chỉ là cửa sổ xử lý tin, KHÔNG phải ranh giới kết thúc đơn.** Không tự tách đơn chỉ vì hết 60 giây; không tự giả định thêm một mốc 5/10 phút khi chủ chưa chốt ngưỡng.
- Trong cùng đợt: “gửi thêm file”, “in 3 bản”, “đổi A4/A3”, “in hai mặt” là **bổ sung/cập nhật cùng order_id**, tạo `core_revisions` mới và yêu cầu xác nhận lại theo revision/request_hash và quote mới khi cần; các xác nhận cũ không được chuyển sang revision mới.
- Tạo đơn mới khi khách **yêu cầu rõ một đơn riêng** hoặc đơn cũ đã hoàn tất/đóng và có yêu cầu mới. Đơn đã `SENDING/UNKNOWN/DONE` không được lén sửa hay tự gửi lại; chuyển nhân viên nếu có yêu cầu thêm.
- Trường hợp có nhiều đơn cùng khách/hội thoại đang mở, tin đến sau không gắn rõ đơn nào, hoặc không rõ là bổ sung hay đơn mới: **hỏi lại/chuyển nhân viên**, không tạo/hợp nhất đơn ngầm.
- Lưu bền liên kết hội thoại → đợt trao đổi → order_id và event_ids trong PostgreSQL, có khóa/giao dịch xử lý đồng thời giữa 2 worker, replay/idempotency. Cùng event không làm thêm file, thay đổi revision hoặc tạo đơn mới. Tuyệt đối không dùng riêng `customer_id` để gộp giữa các hội thoại hoặc OA.
- Không coi “cùng chat” đồng nghĩa “mọi đơn từ trước tới nay là một đơn”; khi phân đoạn trao đổi không chắc chắn phải giữ dữ liệu và chờ xác nhận của khách/nhân viên.

**Phân công thực hiện:** AI1 phụ trách transaction PostgreSQL/active-order lookup/link, revision/idempotency, từ chối cập nhật đơn locked/sent; AI2 nhận diện ý định bổ sung/đơn mới và giữ batch-vs-order rõ ràng, đối thoại hỏi lại; AI0 nối 2 Port và kiểm thử real PG trên một chat có nhiều đợt batch, AI5 nghiệm thu duplicate/two-worker/stale-confirmation. AI4 hiển thị đơn đang xử lý và báo khi cần xác nhận lại. AI1/AI2 không đổi hợp đồng chung nếu chưa được AI0 chốt.

**Trạng thái:** yêu cầu đã chốt và giao, **CHƯA xác nhận code gộp xuyên batch hoàn thành**. Không đánh dấu V1 PASS chỉ vì một batch tạo một draft.


### Làm rõ từ chủ cửa hàng: ranh giới là lúc **CHỐT IN**, không phải hết thời gian gom tin

Trong **cùng OA/shop, cùng khách, cùng conversation**, mọi nội dung thuộc yêu cầu in được gửi **trước khi nhân viên chốt in** phải cập nhật **cùng order_id**: file đầu tiên, các file đến sau, số bản, khổ giấy, một/hai mặt và chỉnh sửa. Dù các tin đến sau 60 giây hoặc qua nhiều batch, vẫn không tự tạo đơn mới.

- `CHỐT IN` là hành động **duyệt/chốt đơn để in** có thẩm quyền ở AI1 (approval/print job boundary), **không phải** lúc kết thúc batch Zalo, AI đề xuất báo giá, hay khách vừa nhắn "OK". Trước chốt, mỗi thay đổi tạo phiên bản mới, huỷ hiệu lực xác nhận bản/giá cũ khi cần; sau chốt, đơn bất biến về yêu cầu in, không tự chỉnh sửa hoặc in thêm trên cùng job.
- Tin/file đến sau chốt in: không nhập vào order/job đã duyệt; nếu đó là yêu cầu in mới thì mở **đơn mới**, còn không rõ thì hỏi lại/chuyển nhân viên. Không tái sử dụng phiên bản xác nhận của đơn trước và không tự tạo lệnh in.
- Khách nói rõ "tạo đơn riêng" *trước* khi đơn cũ chốt: có thể có hơn một đơn trong cùng chat; tách theo ý định rõ ràng và phải có mã đơn riêng. Nếu việc bổ sung không rõ thuộc đơn nào thì hỏi lại. Không gộp những tin không liên quan việc in chỉ vì cùng chat.
- Điều kiện chống đua: nhân viên chốt in đồng thời khách nhắn bổ sung => phải tuần tự hoá bằng PostgreSQL lock/CAS; không được để thông điệp trước chốt thất lạc mà job in bản cũ; nếu không biết thứ tự chắc chắn thì **chặn và nhờ nhân viên xác nhận lại**, không tự in.
- Nhắc rõ: quy tắc **đã chốt nghiệp vụ, CHƯA được triển khai toàn bộ** trong AI1/AI2. AI5 cần test tin khác batch trước/đúng thời điểm chốt, message replay, song song 2 worker, phát sinh đơn mới sau chốt; không báo PASS nếu chỉ test gom trong 60 giây.
