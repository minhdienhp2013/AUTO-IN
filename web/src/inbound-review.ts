export interface InboundReviewItem {
  id:string;
  kind:'image'|'file';
  status:'NEEDS_HUMAN';
  media_state:'AWAITING_MEDIA';
  raw_event_sha256:string;
  received_at:string;
  mapped_customer:boolean;
}

const object=(value:unknown):Record<string,unknown>=>
  value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
const exactKeys=(value:Record<string,unknown>,keys:readonly string[])=>
  Object.keys(value).sort().join('|')===[...keys].sort().join('|');
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digest=/^[0-9a-f]{64}$/;
const timestamp=/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/;
const keys=['id','kind','status','media_state','raw_event_sha256','received_at','mapped_customer'] as const;

/** Decode only the exact staff queue response. A malformed row invalidates the whole read. */
export function parseInboundReviewItems(raw:unknown):InboundReviewItem[]{
  const envelope=object(raw);
  if(!exactKeys(envelope,['items'])||!Array.isArray(envelope.items)||envelope.items.length>100)
    throw new TypeError('INVALID_INBOUND_REVIEW_ITEMS');
  const ids=new Set<string>();
  return envelope.items.map((value):InboundReviewItem=>{
    const item=object(value);
    if(!exactKeys(item,keys)||typeof item.id!=='string'||!uuid.test(item.id)||ids.has(item.id)||
       (item.kind!=='image'&&item.kind!=='file')||item.status!=='NEEDS_HUMAN'||
       item.media_state!=='AWAITING_MEDIA'||typeof item.raw_event_sha256!=='string'||
       !digest.test(item.raw_event_sha256)||typeof item.received_at!=='string'||
       !timestamp.test(item.received_at)||!Number.isFinite(Date.parse(item.received_at))||
       typeof item.mapped_customer!=='boolean')
      throw new TypeError('INVALID_INBOUND_REVIEW_ITEMS');
    ids.add(item.id);
    return {id:item.id,kind:item.kind,status:'NEEDS_HUMAN',media_state:'AWAITING_MEDIA',
      raw_event_sha256:item.raw_event_sha256,received_at:item.received_at,
      mapped_customer:item.mapped_customer};
  });
}

/** These rows describe inbound event metadata, never a saved or processed file. */
export function inboundReviewItemCopy(item:InboundReviewItem):{title:string;message:string;customer:string}{
  return {
    title:item.kind==='image'?'Sự kiện gửi ảnh':'Sự kiện gửi tệp',
    message:'Sự kiện đã được ghi nhận; tệp gốc chưa được lưu hoặc chưa sẵn sàng. Cần nhân viên xử lý.',
    customer:item.mapped_customer?'Đã ghép mã khách':'Chưa ghép mã khách',
  };
}

export function inboundReviewErrorMessage(error:unknown):string{
  const status=typeof object(error).status==='number'?object(error).status as number:-1;
  if(status===401)return 'Phiên đăng nhập hết hạn; đăng nhập lại để tải hàng chờ. Chưa có dữ liệu hiện hành.';
  if(status===403)return 'Tài khoản không có quyền xem hàng chờ sự kiện đến.';
  if(status===409)return 'Máy chủ chưa xác nhận được hàng chờ hiện hành. Tải lại để đối soát.';
  if(status===503)return 'Hàng chờ chưa sẵn sàng hoặc dữ liệu không đúng hợp đồng. Không dùng dữ liệu cũ.';
  if(status===0)return 'Mất kết nối máy chủ. Hàng chờ chưa được xác minh; không dùng dữ liệu cũ.';
  return 'Không thể xác minh hàng chờ. Tải lại sau khi máy chủ hoạt động.';
}
