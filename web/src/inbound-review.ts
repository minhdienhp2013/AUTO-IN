export interface QuarantinedInboundReviewItem {
  source:'quarantine';
  id:string;
  kind:'image'|'file';
  status:'NEEDS_HUMAN';
  media_state:'AWAITING_MEDIA';
  raw_event_sha256:string;
  received_at:string;
  mapped_customer:boolean;
}
export interface PilotIntakeReviewItem {
  source:'pilot_intake';
  id:string;
  kind:'pilot_intake';
  status:'NEEDS_HUMAN';
  received_at:string;
  reason_code?:'COLOR_PRINT';
}
export type InboundReviewItem=QuarantinedInboundReviewItem|PilotIntakeReviewItem;

const object=(value:unknown):Record<string,unknown>=>
  value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
const exactKeys=(value:Record<string,unknown>,keys:readonly string[])=>
  Object.keys(value).sort().join('|')===[...keys].sort().join('|');
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digest=/^[0-9a-f]{64}$/;
const timestamp=/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/;
const quarantineKeys=['source','id','kind','status','media_state','raw_event_sha256','received_at','mapped_customer'] as const;
const pilotIntakeKeys=['source','id','kind','status','received_at'] as const;

/** Decode only the exact staff queue response. A malformed row invalidates the whole read. */
export function parseInboundReviewItems(raw:unknown):InboundReviewItem[]{
  const envelope=object(raw);
  if(!exactKeys(envelope,['items'])||!Array.isArray(envelope.items)||envelope.items.length>100)
    throw new TypeError('INVALID_INBOUND_REVIEW_ITEMS');
  const ids=new Set<string>();
  return envelope.items.map((value):InboundReviewItem=>{
    const item=object(value);
    const commonValid=typeof item.id==='string'&&uuid.test(item.id)&&
      typeof item.received_at==='string'&&timestamp.test(item.received_at)&&
      Number.isFinite(Date.parse(item.received_at))&&item.status==='NEEDS_HUMAN';
    if(!commonValid||typeof item.source!=='string')
      throw new TypeError('INVALID_INBOUND_REVIEW_ITEMS');
    const identity=`${item.source}:${item.id}`;
    if(ids.has(identity))throw new TypeError('INVALID_INBOUND_REVIEW_ITEMS');
    ids.add(identity);
    if(item.source==='quarantine'){
      if(!exactKeys(item,quarantineKeys)||(item.kind!=='image'&&item.kind!=='file')||
         item.media_state!=='AWAITING_MEDIA'||typeof item.raw_event_sha256!=='string'||
         !digest.test(item.raw_event_sha256)||typeof item.mapped_customer!=='boolean')
        throw new TypeError('INVALID_INBOUND_REVIEW_ITEMS');
      return {source:'quarantine',id:item.id as string,kind:item.kind,status:'NEEDS_HUMAN',
        media_state:'AWAITING_MEDIA',raw_event_sha256:item.raw_event_sha256,
        received_at:item.received_at as string,mapped_customer:item.mapped_customer};
    }
    if(item.source==='pilot_intake'){
      const hasReason=Object.hasOwn(item,'reason_code');
      if((!exactKeys(item,pilotIntakeKeys)&&!exactKeys(item,[...pilotIntakeKeys,'reason_code']))||
         item.kind!=='pilot_intake'||(hasReason&&item.reason_code!=='COLOR_PRINT'))
        throw new TypeError('INVALID_INBOUND_REVIEW_ITEMS');
      return {source:'pilot_intake',id:item.id as string,kind:'pilot_intake',status:'NEEDS_HUMAN',
        received_at:item.received_at as string,...(hasReason?{reason_code:'COLOR_PRINT' as const}:{})};
    }
    throw new TypeError('INVALID_INBOUND_REVIEW_ITEMS');
  });
}

/** These rows describe server-held review metadata, never a file ready to print. */
export function inboundReviewItemCopy(item:InboundReviewItem):{title:string;message:string;customer:string}{
  if(item.source==='pilot_intake'){
    if(item.reason_code==='COLOR_PRINT')return {
      title:'Yêu cầu in màu cần nhân viên',
      message:'Core đã ghi nhận lựa chọn in màu. Nhân viên xử lý tiếp; không tạo lệnh in tự động.',
      customer:'Yêu cầu pilot',
    };
    return {
      title:'Yêu cầu cần nhân viên',
      message:'Lý do chi tiết chưa được hiển thị; nhân viên cần đối soát hồ sơ Core.',
      customer:'Yêu cầu pilot',
    };
  }
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
