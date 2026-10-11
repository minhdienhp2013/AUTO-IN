import type { OrderView, StaffSession, OperationMode } from './domain.ts';
// All identifiers and names below are synthetic. Never insert real customer data into fixtures.
export const demoSession: StaffSession = { actor_id: 'demo-staff-01', display_name: 'Nhân viên demo', role: 'staff', can_approve: true, can_manage_schedule: false };
export const demoMode: OperationMode = 'simulation';
export const demoOrders: OrderView[] = [
  {
    order_id: 'MD-260001', customer_name: 'Khách mẫu 01', conversation_generation: 1, conversation_claimed_by: null, conversation_id: 'conv-demo-01', revision: 3, request_hash: 'sha256:demo-request-03', quote_revision: 2,
    confirmed_revision: 3, confirmed_quote_revision: 2, order_state: 'confirmed', conversation_state: 'ai', print_state: 'NOT_SENT', delivery_state: 'not_ready', payment_state: 'partial',
    amount_vnd: 88000, required_deposit_vnd: 50000, received_vnd: 30000, large_cost_flag: false, delivered_sheets: 0, verified_sheets: null, total_sheets: 120,
    urgent: true, created_at: '2026-10-11T05:20:00Z', warnings: ['Cọc còn thiếu 20.000 đ', 'Kiểm tra trang cuối trước khi duyệt'], manual_lock: false,
    documents: [
      { document_id: 'doc-demo-01', filename: 'Tai_lieu_on_tap.pdf', format: 'PDF', pages: 30, printed_faces: 120, physical_sheets: 120, copies: 4, paper: 'A4', duplex: false, orientation: 'portrait', preview_url: null, preview_trusted: true, warnings: [] },
    ],
    audit: [{ at: '2026-10-11T05:25:00Z', actor: 'Hệ thống mô phỏng', action: 'CUSTOMER_CONFIRMED', summary: 'Khách đã xác nhận phiên bản 3 (fixture)' }],
  },
  {
    order_id: 'MD-260002', customer_name: 'Khách mẫu 02', conversation_generation: 1, conversation_claimed_by: null, conversation_id: 'conv-demo-02', revision: 1, request_hash: 'sha256:demo-request-02', quote_revision: null,
    confirmed_revision: null, confirmed_quote_revision: null, order_state: 'awaiting_customer', conversation_state: 'needs_human', print_state: 'NOT_SENT', delivery_state: 'not_ready', payment_state: 'unpaid',
    amount_vnd: null, required_deposit_vnd: 0, received_vnd: 0, large_cost_flag: false, delivered_sheets: 0, verified_sheets: null, total_sheets: null,
    urgent: false, created_at: '2026-10-11T04:35:00Z', warnings: ['Word thiếu font, chưa có preview đáng tin'], manual_lock: false,
    documents: [{ document_id: 'doc-demo-02', filename: 'Don_xin_xac_nhan.docx', format: 'Word', pages: null, printed_faces: null, physical_sheets: null, copies: 1, paper: 'A4', duplex: false, orientation: 'portrait', preview_url: null, preview_trusted: false, warnings: ['Không xác minh được font'] }],
    audit: [{ at: '2026-10-11T04:35:00Z', actor: 'Hệ thống mô phỏng', action: 'NEEDS_HUMAN', summary: 'Cần nhân viên kiểm tra file (fixture)' }],
  },
  {
    order_id: 'MD-260003', customer_name: 'Khách mẫu 03', conversation_generation: 1, conversation_claimed_by: 'demo-staff-01', conversation_id: 'conv-demo-03', revision: 2, request_hash: 'sha256:demo-request-07', quote_revision: 1,
    confirmed_revision: 2, confirmed_quote_revision: 1, order_state: 'approved', conversation_state: 'staff', print_state: 'UNKNOWN', delivery_state: 'quality_check', payment_state: 'partial',
    amount_vnd: 150000, required_deposit_vnd: 100000, received_vnd: 100000, large_cost_flag: true, delivered_sheets: 0, verified_sheets: null, total_sheets: 180,
    urgent: true, created_at: '2026-10-11T03:00:00Z', warnings: ['Trạng thái lệnh không rõ: tuyệt đối không tự gửi lại'], manual_lock: true,
    documents: [{ document_id: 'doc-demo-03', filename: 'Ho_so_demo.pdf', format: 'PDF', pages: 90, printed_faces: 180, physical_sheets: 180, copies: 2, paper: 'A4', duplex: false, orientation: 'portrait', preview_url: null, preview_trusted: true, warnings: [] }],
    audit: [{ at: '2026-10-11T04:12:00Z', actor: 'Hệ thống mô phỏng', action: 'PRINT_UNKNOWN', summary: 'Mất kết nối sau mark-sending (fixture)' }],
  },
  {
    order_id: 'MD-260004', customer_name: 'Khách mẫu 04', conversation_generation: 1, conversation_claimed_by: null, conversation_id: 'conv-demo-04', revision: 1, request_hash: 'sha256:demo-request-09', quote_revision: 1,
    confirmed_revision: 1, confirmed_quote_revision: 1, order_state: 'approved', conversation_state: 'ai', print_state: 'SIMULATED_DONE', delivery_state: 'partial', payment_state: 'partial',
    amount_vnd: 40000, required_deposit_vnd: 0, received_vnd: 20000, large_cost_flag: false, delivered_sheets: 10, verified_sheets: null, total_sheets: 20,
    urgent: false, created_at: '2026-10-10T12:00:00Z', warnings: ['Giao một phần chỉ là dữ liệu mô phỏng, không chứng minh giấy thật'], manual_lock: false,
    documents: [{ document_id: 'doc-demo-04', filename: 'Bai_tap_mau.jpg', format: 'Ảnh', pages: 2, printed_faces: 20, physical_sheets: 20, copies: 10, paper: 'A4', duplex: false, orientation: 'portrait', preview_url: null, preview_trusted: true, warnings: [] }],
    audit: [{ at: '2026-10-10T12:30:00Z', actor: 'DryRunDriver', action: 'SIMULATED_DONE', summary: 'Giả lập hoàn thành, không có giấy thật' }],
  },
];