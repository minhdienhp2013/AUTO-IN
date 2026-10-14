export const coreDetail = () => ({
  order: { id: 'order-ai1', shop_id:'store-demo', customer_id:'customer-01', conversation_id:'conv-01', active_revision:3,
    manual_lock:false, print_closed:false, delivered_sheets:0, created_at:'2026-10-11T04:00:00Z' },
  revisions: [{order_id:'order-ai1',revision:1,request_hash:'old-hash',plan:null},
    {order_id:'order-ai1',revision:3,request_hash:'req-hash',plan:{request_hash:'req-hash',physical_sheets:180,document_pages:90,
      printed_faces:180,ready:true,verified_by:'processor',artifact_ref:'private:artifact',printer_id:'RMP7000'}}],
  jobs:[], quote:{order_id:'order-ai1',quote_revision:2,amount_vnd:150000,deposit_required_vnd:100000,significant_cost:true}, received_vnd:45000,
  receivable_vnd:105000, refundable_vnd:0,
});
