import type { FormEvent, ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle, ArrowDownToLine, ArrowLeft, Bell, BookOpen, Check, CheckCheck, ChevronDown, ChevronRight,
  CircleHelp, ClipboardCheck, Clock3, CreditCard, FileText, Hand, History, LayoutDashboard, LockKeyhole,
  Inbox, LogOut, Menu, MonitorSmartphone, MoreHorizontal, PackageCheck, PauseCircle, Play, Printer,
  RefreshCw, Search, Settings2, ShieldAlert, ShieldCheck, SlidersHorizontal, Smartphone, UserRound,
  Wallet, X
} from 'lucide-react';
import { ApiFault, isDemo, loadPilotOrderDetails, makePort, newMutationKey, snapshotFromPort, type PrintPort } from './api.ts';
import {
  availableVerifiedSheets, confirmationReadiness, conversationLabels, deliveryLabels, depositShortfall, hasValidApprovalInputs, isPrintUncertain, money,
  orderLabels, paymentLabels, printLabels, receivable,
  type ActionKind, type OrderView, type OperationMode, type StaffSession, type VerifiedFileFact
} from './domain.ts';
import { notificationCapability, orderFromNavigation, requestLocalNotifications } from './notifications.ts';
import { canEditShopSchedule, draftFromSchedule, saveShopScheduleAndRead, scheduleErrorText, type ShopSchedule, type ScheduleDraft } from './shop-schedule.ts';
import { canApproveAfterInboundReview, canEditPrintRequest, groupOpenOrdersByChat, hasClearPendingInbound,
  requiresCustomerReconfirmation } from './code008.ts';
import { manualQueueRowsForDisplay, pendingStaffQueue, routeVerifiedDocument } from './v1-routing.ts';
import { previewReviewBlock, previewReviewBlockMessage, previewReviewErrorMessage,
  previewReviewSequence } from './preview-review.ts';
import { inboundReviewErrorMessage, inboundReviewItemCopy, type InboundReviewItem } from './inbound-review.ts';
import { parseWordReviewPreview, WordReviewPanel,
  type WordReviewIdentity, type WordReviewPanelState, type WordReviewPageObjectUrl } from './word-review-panel.ts';
import { parsePdfReviewPreview, PdfReviewPanel,
  type PdfReviewIdentity, type PdfReviewPanelState, type PdfReviewPageObjectUrl } from './pdf-review-panel.ts';
import { PilotShopCodePanel } from './pilot-shop-code.ts';

type View = 'orders' | 'overview' | 'settings' | 'inbound-review' | 'shop-code';
type DetailTab = 'document' | 'activity';
type Filter = 'all' | 'approval' | 'attention' | 'delivery';
const port: PrintPort = makePort();
const useDemo = isDemo();
const time = (date: string) => { const d = new Date(date); return Number.isNaN(d.valueOf()) ? '—' : d.toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }); };
const statusTone = (order: OrderView) => order.print_state === 'UNKNOWN' || order.urgent ? 'danger' : order.order_state === 'confirmed' ? 'amber' : 'neutral';
const labelMode = (mode: OperationMode) => ({ simulation: 'MÔ PHỎNG · KHÔNG IN THẬT', controlled_test: 'THỬ NGHIỆM CÓ KIỂM SOÁT', production: 'VẬN HÀNH CHÍNH THỨC', safe: 'CHẾ ĐỘ AN TOÀN', unverified: 'CHƯA XÁC MINH CHẾ ĐỘ SERVER' }[mode]);
const modeTone = (mode: OperationMode) => mode === 'simulation' ? 'demo' : mode === 'unverified' || mode === 'safe' ? 'warn' : 'live';

function App() {
  const [session, setSession] = useState<StaffSession | null>(null);
  const [orders, setOrders] = useState<OrderView[]>([]);
  const [inboundItems,setInboundItems]=useState<InboundReviewItem[]|null>(null);
  const [inboundLoading,setInboundLoading]=useState(false);
  const [inboundError,setInboundError]=useState<string|null>(null);
  const [mode, setMode] = useState<OperationMode>(useDemo ? 'simulation' : 'unverified');
  const [view, setView] = useState<View>('orders');
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<DetailTab>('document');
  const [mobileDetail, setMobileDetail] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [chatLoading, setChatLoading] = useState(false);
  const [chatLoaded, setChatLoaded] = useState(false);
  const requestEpoch = useRef(0);
  const inboundEpoch=useRef(0);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loginShop, setLoginShop] = useState('');
  const [loginUser, setLoginUser] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [value, setValue] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<'cash'|'bank_transfer'>('cash');
  const [depositValue, setDepositValue] = useState('0');
  const [significantCost, setSignificantCost] = useState(false);
  const [manualReason, setManualReason] = useState('');
  const [apiHealthy, setApiHealthy] = useState(true);
  const clearExpiredStaffSession = useCallback(() => {
    setSession(null);setOrders([]);setSelected(null);setInboundItems(null);setApiHealthy(false);
  },[]);
  const [deliveryValue, setDeliveryValue] = useState('');
  const [verifiedValue, setVerifiedValue] = useState('');
  const [paperNote, setPaperNote] = useState('');
  const [depositAck, setDepositAck] = useState(false);
  const [confirmManual, setConfirmManual] = useState(false);
  const lock = useRef(false);
  const selectedIdRef = useRef<string | null>(null);

  const selectedOrder = orders.find(o => o.order_id === selected) ?? null;
  const firstWordDocument=selectedOrder?.documents.find(d=>['DOC','DOCX','WORD'].includes(d.format.trim().toUpperCase()))??null;
  useEffect(() => { selectedIdRef.current = selected; }, [selected]);
  const load = useCallback(async (onlyOrders = false, pilotOrderDetails = false): Promise<boolean> => {
    requestEpoch.current++;
    setChatLoaded(false);
    setChatLoading(false);
    setError(null);
    try {
      const snapshot = onlyOrders ? null : await snapshotFromPort(port);
      const list = snapshot?.orders ?? await port.listOrders();
      if (snapshot) { setSession(snapshot.session); setMode(snapshot.mode); }
      const id = selectedIdRef.current;
      if (!useDemo && pilotOrderDetails) {
        const details = await loadPilotOrderDetails(list, orderId => port.getOrder(orderId));
        const byId = new Map(details.map(detail => [detail.order_id, detail]));
        setOrders(list.map(summary => byId.get(summary.order_id) ?? summary));
      } else if (!useDemo && id && (snapshot?.session || onlyOrders)) {
        const detail = await port.getOrder(id);
        setOrders(list.some(o => o.order_id === id)
          ? list.map(o => o.order_id === id ? detail : o) : [detail, ...list]);
      } else setOrders(list);
      setApiHealthy(true);
      return true;
    } catch (e) {
      const fault = e as ApiFault;
      if (fault.status === 401) { inboundEpoch.current++;setSession(null);setOrders([]);setSelected(null);setInboundItems(null); }
      setApiHealthy(false);
      setError(fault.message || 'Không kết nối được.');
      return false;
    } finally { setLoading(false); }
  }, []);
  const refreshPilotOrders = useCallback(() => load(true, true), [load]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const { id } = orderFromNavigation(window.location.search);
    if (id && session) { setSelected(id); setView('orders'); setMobileDetail(true); }
    else if (!selected && orders.length > 0) setSelected(orders[0].order_id);
  }, [orders, selected]);
  useEffect(() => { setValue(''); setDeliveryValue(''); setVerifiedValue(''); setPaperNote(''); setDepositAck(false); setConfirmManual(false); setManualReason(''); setDetailTab('document'); }, [selected]);
  useEffect(() => {
    if (!selectedOrder) return;
    setDepositValue(String(selectedOrder.required_deposit_vnd));
    setSignificantCost(selectedOrder.large_cost_flag);
  }, [selectedOrder?.order_id, selectedOrder?.quote_revision]);
  useEffect(() => {
    if (!selected || !session || useDemo) return;
    let cancelled = false;
    void port.getOrder(selected).then(latest => {
      if (!cancelled) {
        setApiHealthy(true);
        setOrders(prev => prev.some(o => o.order_id === latest.order_id)
          ? prev.map(o => o.order_id === latest.order_id ? latest : o)
          : [latest, ...prev]);
        const navRevision = orderFromNavigation(window.location.search).revision;
        if (navRevision !== null && navRevision !== latest.revision) setError(`Thông báo thuộc phiên bản ${navRevision}; đơn hiện tại đã ở phiên bản ${latest.revision}. Cần đọc lại trước khi thao tác.`);
      }
    }).catch((e: ApiFault) => {
      if (!cancelled) { if(e.status===401) {setSession(null);setOrders([]);setSelected(null);} setError(e.message || 'Không tải được đơn từ API.'); setApiHealthy(false); }
    });
    return () => { cancelled = true; };
  }, [selected, session?.actor_id]);
  const filtered = useMemo(() => orders.filter(o => {
    const term = query.trim().toLocaleLowerCase('vi-VN');
    if (term && !`${o.order_id} ${o.customer_name} ${o.conversation_id??''} ${o.documents.map(d => d.filename).join(' ')}`.toLocaleLowerCase('vi-VN').includes(term)) return false;
    if (filter === 'approval') return o.order_state === 'confirmed';
    if (filter === 'attention') return o.urgent || o.conversation_state === 'needs_human' || isPrintUncertain(o.print_state);
    if (filter === 'delivery') return ['ready','partial','quality_check'].includes(o.delivery_state);
    return true;
  }).sort((a,b) => (Number(b.urgent)-Number(a.urgent)) || b.created_at.localeCompare(a.created_at)), [orders, query, filter]);
  const openChatGroups = useMemo(() => chatLoaded ? groupOpenOrdersByChat(orders) : [],
    [chatLoaded,orders]);
  const loadInboundReviewQueue=async()=>{
    if(useDemo||!session)return;
    const epoch=++inboundEpoch.current;
    setInboundItems(null);setInboundError(null);setInboundLoading(true);
    try{
      const items=await port.listInboundReviewItems();
      if(epoch!==inboundEpoch.current)return;
      setInboundItems(items);
    }catch(error){
      if(epoch!==inboundEpoch.current)return;
      const fault=error as ApiFault;
      setInboundError(inboundReviewErrorMessage(fault));
      if(fault.status===401){setSession(null);setOrders([]);setSelected(null);setInboundItems(null);}
    }finally{if(epoch===inboundEpoch.current)setInboundLoading(false);}
  };
  const loadChatGroups = async () => {
    if(useDemo || !session || busy || chatLoading) return;
    const epoch=++requestEpoch.current;
    setChatLoaded(false);
    setChatLoading(true);
    setError(null);
    try {
      // AI1 list endpoint does not expose conversation_id. Load each scoped
      // detail before grouping; never equate two orders by customer_id alone.
      const summaries=await port.listOrders();
      const detailed:OrderView[]=[];
      for(let i=0;i<summaries.length;i+=4){
        const batch=await Promise.all(summaries.slice(i,i+4).map(o=>port.getOrder(o.order_id)));
        for(let j=0;j<batch.length;j++){
          const item=summaries[i+j];
          if(batch[j].order_id!==item.order_id || batch[j].revision<item.revision)
            throw new ApiFault(409,'CHAT_DETAIL_STALE','Danh sách và chi tiết đơn không còn cùng phiên bản.');
        }
        detailed.push(...batch);
        if(requestEpoch.current!==epoch) return;
      }
      if(requestEpoch.current!==epoch) return;
      setOrders(detailed);
      setChatLoaded(true);
      setApiHealthy(true);
    } catch(e){
      if(requestEpoch.current!==epoch) return;
      const fault=e as ApiFault;
      setChatLoaded(false);
      setApiHealthy(false);
      if(fault.status===401){setSession(null);setOrders([]);setSelected(null);}
      setError(fault.message||'Không thể đọc đủ đơn theo khách và chat; không nhóm dữ liệu thiếu.');
    } finally {
      if(requestEpoch.current===epoch)setChatLoading(false);
    }
  };
  const totals = useMemo(() => ({
    waiting: orders.filter(o => o.order_state === 'confirmed').length,
    attention: orders.filter(o => o.urgent || o.print_state === 'UNKNOWN' || o.conversation_state === 'needs_human').length,
    ready: orders.filter(o => ['ready','partial'].includes(o.delivery_state)).length,
    count: orders.length,
  }), [orders]);

  const act = async (kind: ActionKind, payload: Record<string, string|number|boolean|null> = {}, reason = 'Đã lưu thao tác') => {
    if (!selectedOrder || lock.current) return;
    if(kind==='quote' && !canEditPrintRequest(selectedOrder)){
      setError('Đơn đã chốt in hoặc có lệnh in: không sửa giá/yêu cầu trên đơn cũ.');return;
    }
    if(kind==='approve' && !useDemo && !canApproveAfterInboundReview(selectedOrder)){
      setError('Chưa có chứng cứ tin/file đã được xử lý hết hoặc thiếu xác nhận/preview; không được chốt in.');return;
    }
    lock.current = true; setBusy(true); setToast(null); setError(null);
    try {
      const changed = await port.mutate(selectedOrder, kind, payload, newMutationKey());
      setOrders(prev => prev.map(o => o.order_id === changed.order_id ? changed : o));
      setToast(useDemo ? `ĐÃ MÔ PHỎNG: ${reason}. Không có tác vụ thật.` : `${reason}. Đã đối chiếu dữ liệu từ API.`);
      setValue(''); setDeliveryValue(''); setDepositAck(false);
    } catch (e) {
      const fault = e as ApiFault;
      if (fault.status === 401) { setSession(null); setOrders([]); setSelected(null); }
      if (fault.status === 0 || fault.status === 503 || fault.status === 409) setApiHealthy(false);
      setError((fault.message ?? 'Không thể thực hiện.') + (fault.status === 409 ? ' Không tự thực hiện lại; đang tải dữ liệu mới.' : ''));
      if (fault.status === 409) {
        try { const latest = await port.getOrder(selectedOrder.order_id); setOrders(prev => prev.map(o => o.order_id === latest.order_id ? latest : o)); setApiHealthy(true); }
        catch { /* preserve error; no success */ }
      }
    } finally { lock.current = false; setBusy(false); }
  };
  const doLogin = async (ev: FormEvent) => {
    inboundEpoch.current++;setInboundItems(null);setInboundError(null);
    requestEpoch.current++;
    setChatLoaded(false);setChatLoading(false);
    ev.preventDefault(); setBusy(true); setError(null);
    try { setSession(await port.login(loginShop, loginUser, loginPassword)); setView('shop-code'); await load(true); setLoginPassword(''); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const doLogout = async () => {
    inboundEpoch.current++;setInboundItems(null);setInboundError(null);
    requestEpoch.current++;
    setChatLoaded(false);setChatLoading(false);
    setError(null);
    try { await port.logout(); }
    catch (e) { setError('Phiên cục bộ đã hủy. Có thể chưa thông báo được server: ' + (e as Error).message); }
    finally { setSession(null); setOrders([]); setSelected(null); }
  };
  const doSelect = (id: string) => {
    setSelected(id); setMobileDetail(true); setDetailTab('document');
    const url = new URL(window.location.href); url.searchParams.set('order_id', id); url.searchParams.delete('revision');
    window.history.replaceState({}, '', url);
  };
  const submitAmount = (kind: 'quote'|'payment') => {
    const v = Number(value);
    if (!Number.isSafeInteger(v) || v < 0 || (kind === 'payment' && v === 0) || value.trim() === '') { setError('Số tiền phải là số nguyên VND hợp lệ.'); return; }
    const dep = Number(depositValue);
    if (kind === 'quote' && (depositValue.trim() === '' || !Number.isSafeInteger(dep) || dep < 0)) { setError('Mức cọc phải là số nguyên VND không âm.'); return; }
    void act(kind, kind === 'payment' ? { amount_vnd: v, method: paymentMethod, direction: 'received' } : { amount_vnd: v, deposit_required_vnd: dep, significant_cost: significantCost }, kind === 'quote' ? 'Đã ghi giá nhân viên nhập' : 'Đã ghi khoản thực nhận');
  };
  const canWork = Boolean(session?.can_approve && apiHealthy);
  const canApprove = Boolean(canWork && selectedOrder &&
    (useDemo ? hasValidApprovalInputs(selectedOrder) : canApproveAfterInboundReview(selectedOrder)));
  const canEditRequest = Boolean(selectedOrder && canEditPrintRequest(selectedOrder));
  const printAttention = selectedOrder ? isPrintUncertain(selectedOrder.print_state) : false;
  const confirmation = selectedOrder ? confirmationReadiness(selectedOrder) : null;
  const manualQueueRows = selectedOrder ? manualQueueRowsForDisplay(selectedOrder) : null;

  return <div className="shell">
    <aside className={`sidebar ${menuOpen ? 'sidebar-open' : ''}`}>
      <div className="brand"><div className="brand-mark"><Printer size={22} strokeWidth={2.5}/></div><div><b>MINH ĐIẾN</b><small>AUTO-IN / PRINT DESK</small></div></div>
      <div className="sidebar-caption">KHÔNG GIAN LÀM VIỆC</div>
      <nav aria-label="Điều hướng chính" className="nav">
        <button className={view === 'overview' ? 'active' : ''} onClick={() => {setView('overview');setMenuOpen(false)}}><LayoutDashboard size={19}/> Tổng quan</button>
        <button className={view === 'orders' ? 'active' : ''} onClick={() => {setView('orders');setMenuOpen(false);setMobileDetail(false)}}><BookOpen size={19}/> Quản lý đơn in <span className="nav-count">{totals.count}</span></button>
        {!useDemo&&session&&<button className={view==='shop-code'?'active':''} data-testid="pilot-shop-code-nav" onClick={()=>{setView('shop-code');setMenuOpen(false);setMobileDetail(false)}}><LockKeyhole size={19}/> Mã cửa hàng</button>}
        {!useDemo&&session&&<button className={view==='inbound-review'?'active':''} data-testid="inbound-review-nav" onClick={()=>{setView('inbound-review');setMenuOpen(false);setMobileDetail(false);void loadInboundReviewQueue()}}><Inbox size={19}/> Sự kiện cần nhân viên {inboundItems&&inboundItems.length>0&&<span className="nav-count">{inboundItems.length}</span>}</button>}
        <button disabled title="Chưa có API hội thoại độc lập"><Smartphone size={19}/> Hội thoại <span className="soon">Sớm</span></button>
        <button disabled title="Chưa có API quản lý print job độc lập"><Printer size={19}/> Hàng đợi máy in <span className="soon">Sớm</span></button>
      </nav>
      <div className="sidebar-caption bottom-spaced">HỆ THỐNG</div>
      <nav className="nav" aria-label="Hệ thống"><button className={view === 'settings' ? 'active' : ''} onClick={() => {setView('settings');setMenuOpen(false)}}><Settings2 size={19}/> Cài đặt & lịch</button></nav>
      <div className="sidebar-bottom"><div className="mini-station"><MonitorSmartphone size={20}/><div><strong>Trạm in Minh Điến</strong><span>Ricoh IM7000 · kết nối chưa thử</span></div></div><span className="side-hint">Không điều khiển máy in từ giao diện này</span></div>
    </aside>
    {menuOpen && <button className="mobile-backdrop" onClick={()=>setMenuOpen(false)} aria-label="Đóng điều hướng"/>}
    <div className="main-area">
      <header className="topbar">
        <div className="top-left"><button aria-label="Mở menu" className="menu-icon" onClick={() => setMenuOpen(x=>!x)}><Menu size={22}/></button><div className="breadcrumb">Vận hành <ChevronRight size={14}/> <strong>{view === 'orders' ? 'Quản lý đơn in' : view === 'overview' ? 'Tổng quan' : view==='inbound-review'?'Sự kiện cần nhân viên':view==='shop-code'?'Mã cửa hàng':'Cài đặt'}</strong></div></div>
        <div className="top-right"><span data-testid="operation-mode" className={`mode-pill ${modeTone(mode)}`}><span className="status-dot"/>{labelMode(mode)}</span><button className="icon-button" title="Làm mới" aria-label="Làm mới dữ liệu" disabled={loading || busy || inboundLoading} onClick={()=>view==='inbound-review'?void loadInboundReviewQueue():void load()}><RefreshCw size={19}/></button><div className="user-avatar" title={session?.display_name ?? 'Chưa đăng nhập'}><UserRound size={19}/></div></div>
      </header>
      <div className="content">
        {error && <div className="banner error" role="alert" data-testid="api-error"><AlertCircle size={19}/><span>{error}</span><button aria-label="Đóng lỗi" onClick={()=>setError(null)}><X size={17}/></button></div>}
        {!apiHealthy && !useDemo && <div className="banner error" role="alert" data-testid="api-lock-banner"><ShieldAlert size={19}/><span>Không xác minh được API. Dữ liệu cũ chỉ để tham khảo; các thao tác ghi đã tạm khóa.</span></div>}
        {toast && <div className="banner success" role="status"><Check size={19}/><span>{toast}</span><button aria-label="Đóng thông báo" onClick={()=>setToast(null)}><X size={17}/></button></div>}
        {!useDemo && !session && !loading ? <section className="login-card"><div className="login-icon"><LockKeyhole/></div><h1>Đăng nhập nhân viên</h1><p>Đăng nhập bằng tài khoản cấp từ máy chủ AUTO-IN. Quyền được kiểm tra tại server.</p><form data-testid="staff-login" onSubmit={doLogin}><label>Mã cửa hàng<input autoComplete="organization" required value={loginShop} onChange={e=>setLoginShop(e.target.value)} /></label><label>Tên đăng nhập<input autoComplete="username" required value={loginUser} onChange={e=>setLoginUser(e.target.value)}/></label><label>Mật khẩu<input autoComplete="current-password" type="password" required value={loginPassword} onChange={e=>setLoginPassword(e.target.value)}/></label><button className="primary" disabled={busy}>Đăng nhập an toàn</button></form></section>
          : loading ? <div className="empty-center"><RefreshCw className="spin" size={26}/> Đang tải dữ liệu…</div>
          : view === 'shop-code' ? <PilotShopCodePanel key={`${port.authenticatedShopId()??''}:${session?.actor_id??''}:${session?.role??''}`} port={port} session={session} authenticatedShopId={port.authenticatedShopId()} apiHealthy={apiHealthy} orders={orders} onUnauthorized={clearExpiredStaffSession} onRefreshOrders={refreshPilotOrders}/>
          : view === 'settings' ? <SettingsView mode={mode} session={session} onLogout={()=>void doLogout()}/>
          : view === 'inbound-review' ? <InboundReviewQueue items={inboundItems} loading={inboundLoading} error={inboundError} refresh={()=>void loadInboundReviewQueue()}/>
          : view === 'overview' ? <Overview totals={totals} orders={orders} open={(id)=>{doSelect(id);setView('orders')}}/>
          : <>
            <section className={`page-intro ${mobileDetail ? 'mobile-hidden-detail' : ''}`}><div><p className="eyebrow">BẢNG ĐIỀU KHIỂN · V1</p><h1>Quản lý đơn in</h1><p className="subtext">Theo dõi từ lúc khách xác nhận đến kiểm tra, giao giấy và thanh toán.</p></div><div className="header-actions"><button className="outline-btn" onClick={()=>void load()} disabled={busy}><RefreshCw size={16}/> Làm mới</button><button className="primary" disabled title="Chờ API tạo đơn và xác nhận từ kênh thật">+ Tạo đơn mới</button></div></section>
            <section className={`stat-grid ${mobileDetail ? 'mobile-hidden-detail' : ''}`} aria-label="Tổng hợp đơn">
              <Stat icon={<ClipboardCheck size={21}/>} label="Chờ duyệt" value={totals.waiting} note="Đã được khách xác nhận" color="green" onClick={()=>setFilter('approval')}/>
              <Stat icon={<ShieldAlert size={21}/>} label="Cần chú ý" value={totals.attention} note="Đơn khẩn, lỗi hoặc cần người" color="rose" onClick={()=>setFilter('attention')}/>
              <Stat icon={<PackageCheck size={21}/>} label="Đang chờ giao" value={totals.ready} note="Sẵn sàng hoặc giao một phần" color="amber" onClick={()=>setFilter('delivery')}/>
              <Stat icon={<FileText size={21}/>} label="Tổng đơn" value={totals.count} note={useDemo ? 'Toàn bộ là dữ liệu giả lập' : 'Theo quyền xem hiện tại'} color="blue" onClick={()=>setFilter('all')}/>
            </section>
            <section className={`workspace ${mobileDetail ? 'show-mobile-detail' : ''}`}>
              <div className="order-panel">
                <div className="panel-head"><div><h2>Danh sách đơn</h2><p>{filtered.length} đơn phù hợp</p></div><button className="small-icon" title="Làm mới" onClick={()=>void load(true)} disabled={busy}><MoreHorizontal size={22}/></button></div>
                <div className="order-controls"><div className="searchbox"><Search size={17}/><input aria-label="Tìm theo mã đơn, khách, tên file" placeholder="Tìm mã đơn, khách, tên file…" value={query} onChange={e=>setQuery(e.target.value)}/></div><button className="small-icon" title="Bộ lọc" aria-label="Bộ lọc"><SlidersHorizontal size={19}/></button></div>
                <div className="filters" role="group" aria-label="Lọc đơn">{([['all','Tất cả'],['approval','Chờ duyệt'],['attention','Cần xử lý'],['delivery','Chờ giao']] as [Filter,string][]).map(([key,text])=><button key={key} className={filter===key?'selected':''} onClick={()=>setFilter(key)}>{text}</button>)}</div>
                {!useDemo && <div className="chat-group-panel" data-testid="chat-open-orders">
                  <div className="chat-group-heading"><strong>Đơn đang mở theo khách / cuộc chat</strong>
                    <button className="outline-btn" disabled={busy||chatLoading||!session} onClick={()=>void loadChatGroups()}>
                      {chatLoading?'Đang kiểm tra…':'Tải chi tiết theo chat'}</button></div>
                  {!chatLoaded && <p>Chỉ nhóm sau khi đọc chi tiết đơn đã xác thực. Không gộp các mã đơn dù cùng khách/chat; OA và ý định tạo đơn riêng do backend quyết định.</p>}
                  {chatLoaded && apiHealthy && (openChatGroups.length ? openChatGroups.map(group=><div className="chat-group" key={JSON.stringify([group.customer_id,group.conversation_id])}>
                    <div><strong>Khách: {group.customer_id}</strong><small>Chat: {group.conversation_id} · {group.orders.length} đơn riêng đang mở</small></div>
                    {group.orders.map(o=><button key={o.order_id} className="chat-open-order" onClick={()=>doSelect(o.order_id)}>
                      Đơn {o.order_id} · phiên bản {o.revision} {requiresCustomerReconfirmation(o)?'· CẦN XÁC NHẬN LẠI':''}
                    </button>)}
                  </div>) : <p>Không tìm thấy đơn đang mở có đủ mã khách và chat trong dữ liệu chi tiết; không tự suy đoán liên kết thiếu.</p>)}
                </div>}
                <div data-testid="order-list" className="order-scroll">{filtered.length === 0 ? <div className="empty-panel">Không có đơn phù hợp.</div> : filtered.map(order=><button key={order.order_id} onClick={()=>doSelect(order.order_id)} className={`order-card ${selected===order.order_id?'selected':''}`} aria-current={selected===order.order_id?'true':undefined}>
                  <div className="order-row"><span className="order-id">{order.order_id}</span><span className="order-time"><Clock3 size={12}/>{time(order.created_at)}</span></div>
                  <div className="order-customer">{order.customer_name} {order.urgent && <span className="urgent-label">ƯU TIÊN</span>}</div>
                  <div className="order-description">{order.documents.length ? `${order.documents.length} tài liệu · ${order.total_sheets ?? '?'} tờ` : 'Tài liệu chưa được API liệt kê'}</div>
                  {order.conversation_id && <small>Chat: {order.conversation_id} · phiên bản {order.revision}</small>}
                  {apiHealthy && order.detail_loaded===true && order.v1_manual_queue && <small className="v1-queue-list-label" data-testid="v1-queue-list-label">Đã nhận — chờ nhân viên · {order.v1_manual_queue.items.length} yêu cầu đối soát</small>}
                  <div className="order-row footer"><span className={`state-chip ${statusTone(order)}`}>{order.print_state === 'UNKNOWN' ? printLabels.UNKNOWN : orderLabels[order.order_state]}</span><ChevronRight size={16}/></div>
                </button>)}</div>
                <div className="panel-foot"><span className="dot-legend"/> Dữ liệu {useDemo?'mô phỏng, không có khách thật':'trả về từ server'}</div>
              </div>
              <div data-testid="order-detail" className="detail-panel">{selectedOrder ? <>
                <div className="detail-head"><div className="detail-title"><button className="back-mobile" aria-label="Về danh sách" onClick={()=>setMobileDetail(false)}><ArrowLeft size={20}/></button><div><p className="eyebrow">CHI TIẾT ĐƠN IN <span>· LẦN SỬA {selectedOrder.revision}</span></p><h2>{selectedOrder.order_id}</h2></div></div><span className={`state-chip ${statusTone(selectedOrder)}`}>{orderLabels[selectedOrder.order_state]}</span></div>
                {useDemo && <div className="simulation-note"><AlertCircle size={17}/> <strong>DEMO:</strong> mọi thao tác trong trang chỉ thay đổi dữ liệu giả lập. Không gửi Zalo, không in hoặc thu tiền thật.</div>}
                {printAttention && <div className="risk-note"><ShieldAlert size={20}/><div><strong>Lệnh in cần đối soát</strong><p>{printLabels[selectedOrder.print_state]}. Không tự gửi lại; chỉ chủ cửa hàng duyệt in lại sau kiểm tra thực tế.</p></div></div>}
                <div className="detail-customer"><div className="person-icon"><UserRound size={20}/></div><div><strong>{selectedOrder.customer_name}</strong><small>Khách hàng · {selectedOrder.conversation_id ?? 'Chưa có hội thoại'}</small></div><span className="muted-date">{time(selectedOrder.created_at)}</span></div>
                {!useDemo && <section className="inbound-workflow" data-testid="code008-inbound" aria-label="Tin và file bổ sung trước khi chốt in">
                  <strong>{selectedOrder.detail_loaded!==true?'Chưa xác minh đơn còn mở hay đã chốt':canEditRequest?'Đơn đang mở · trước khi NHÂN VIÊN chốt in':'Đã chốt / khóa yêu cầu in · không tự sửa đơn cũ'}</strong>
                  <p data-testid="code008-revision">Phiên bản đang xử lý: <b>{selectedOrder.revision}</b> · Chat: {selectedOrder.conversation_id??'chưa được server xác minh'}</p>
                  {requiresCustomerReconfirmation(selectedOrder) && <p className="inbound-warning" data-testid="code008-reconfirm">Có phiên bản đơn mới: khách cần xác nhận lại yêu cầu và giá (nếu cần). Xác nhận phiên bản cũ không có hiệu lực.</p>}
                  {apiHealthy && selectedOrder.pending_updates?.state==='clear'
                    ? <p data-testid="code008-clear">CLEAR — Máy chủ xác nhận không có sự kiện bổ sung chưa đối soát cho đúng mã đơn, phiên bản và hash hiện hành. Đây không phải xác nhận của khách.</p>
                    : <p className="inbound-warning" data-testid="code008-blocked">
                        {!apiHealthy || selectedOrder.pending_updates?.state==='unknown' || !selectedOrder.pending_updates
                          ? 'CHƯA XÁC ĐỊNH — API lỗi/thiếu dữ liệu hoặc bằng chứng sai đơn, phiên bản, hash. Đã khóa duyệt in.'
                          : selectedOrder.pending_updates.state==='needs_human'
                            ? 'CẦN NHÂN VIÊN ĐỐI SOÁT — không chốt in trước khi server xác minh lại.'
                            : 'ĐANG CHỜ AI XỬ LÝ — chưa đủ điều kiện chốt in.'}
                      </p>}
                  {apiHealthy && selectedOrder.pending_updates && (selectedOrder.pending_updates.state==='processing' || selectedOrder.pending_updates.state==='needs_human') &&
                    <p data-testid="code008-pending-count">
                      Trạng thái: <b>{selectedOrder.pending_updates.state==='needs_human'?'needs_human':'processing'}</b>.
                      {selectedOrder.pending_updates.unresolved_count === 0
                        ? ' Chưa có mục được liệt kê, nhưng backend chưa chứng thực CLEAR; không được duyệt.'
                        : ` Có ${selectedOrder.pending_updates.unresolved_count} tin/file chưa xử lý; danh sách bên dưới chỉ là metadata an toàn.`}
                    </p>}
                  {(apiHealthy?selectedOrder.pending_updates?.items??[]:[]).map((item,index)=><div className="inbound-item" key={index}>
                    <b>{item.kind==='file'?'File bổ sung':'Tin bổ sung'}: {item.label}</b>
                    <p>{item.summary}</p>
                    {item.received_at && <small>{time(item.received_at)}</small>}
                  </div>)}
                  {(!apiHealthy || selectedOrder.pending_updates?.state==='unknown' || !selectedOrder.pending_updates) && <small>Không thể dùng dữ liệu pending trước đó để duyệt; tải lại chi tiết đơn từ server sau khi API hoạt động.</small>}
                </section>}
                {!useDemo && <section className="v1-routing-panel" data-testid="v1-routing-panel" aria-label="Luồng Word PDF và hàng chờ nhân viên">
                  <strong>V1 · Word/PDF ưu tiên — hàng chờ nhân viên</strong>
                  <p>Word/PDF chỉ hiện thông số từng file khi có preview đúng revision/hash được máy chủ xác minh. Preview không phải xác nhận khách, duyệt in hoặc bằng chứng đã in.</p>
                  <p data-testid="v1-manual-categories">Nhóm chuyển nhân viên khi có phân loại server: Ảnh · CCCD · TEMhoa · Yêu cầu in màu · Định dạng chưa hỗ trợ.</p>
                  {!apiHealthy || selectedOrder.detail_loaded!==true
                    ? <p className="inbound-warning" data-testid="v1-queue-unknown">CHƯA XÁC MINH — không báo đã nhận, đã xử lý hoặc đã in khi thiếu dữ liệu hiện hành.</p>
                    : manualQueueRows
                      ? <div data-testid="v1-server-manual-queue">
                          <p>Máy chủ xác minh hàng chờ theo revision {selectedOrder.revision} và hash hiện hành.</p>
                          {manualQueueRows.map((row,index)=><p data-testid="v1-manual-queued-item" key={index}><b>{row.label}</b> · {row.status}</p>)}
                        </div>
                      : pendingStaffQueue(selectedOrder)
                        ? <div data-testid="v1-generic-manual-queue">
                            <p><b>Đã nhận — chờ nhân viên đối soát:</b> {pendingStaffQueue(selectedOrder)?.count} sự kiện chưa xử lý; máy chủ mới liệt kê {pendingStaffQueue(selectedOrder)?.listed} metadata.</p>
                            <p>Chưa có phân loại ảnh, CCCD, TEMhoa, in màu hay định dạng khác; không suy đoán từ tên file/tin.</p>
                          </div>
                        : <p data-testid="v1-queue-not-confirmed">Chưa có hàng chờ thủ công được máy chủ xác minh. Chỉ xử lý Word/PDF khi có preview và xác nhận đúng phiên bản; không tự kết luận hoàn tất.</p>}
                  <small>Chỉ đọc trạng thái server; nhân viên duyệt, khách xác nhận và điều kiện an toàn hiện hành không thay đổi.</small>
                </section>}
                <div className="axis-grid" aria-label="Năm trạng thái độc lập"><Axis title="Hội thoại" label={conversationLabels[selectedOrder.conversation_state]}/><Axis title="Đơn hàng" label={orderLabels[selectedOrder.order_state]}/><Axis title="In giấy" label={selectedOrder.print_state==='VERIFIED_DONE' && selectedOrder.total_sheets!==null && (selectedOrder.verified_sheets===null || selectedOrder.verified_sheets < selectedOrder.total_sheets) ? 'Giấy thật chưa xác minh đủ' : printLabels[selectedOrder.print_state]} warn={printAttention || selectedOrder.print_state==='SIMULATED_DONE'}/><Axis title="Giao giấy" label={deliveryLabels[selectedOrder.delivery_state]}/><Axis title="Thanh toán" label={paymentLabels[selectedOrder.payment_state]}/></div>
                {!useDemo && confirmation && <section className="confirmation-evidence" data-testid="confirmation-evidence" aria-label="Bằng chứng xác nhận khách và duyệt in">
                  <div><strong>Yêu cầu khách</strong><span data-testid="confirmation-request">{confirmation.request==='confirmed'?'Khách đã xác nhận đúng phiên bản/hash':'Chưa có xác nhận khách đúng phiên bản/hash'}</span></div>
                  <div><strong>Xác nhận giá</strong><span data-testid="confirmation-price">{confirmation.price==='not_required'?'Không cần xác nhận giá riêng':confirmation.price==='confirmed'?'Đã xác nhận đúng phiên bản báo giá':'Chưa xác nhận giá cho đơn trên 150 tờ hoặc chi phí đáng kể'}</span></div>
                  <div><strong>Duyệt của nhân viên</strong><span data-testid="confirmation-staff">{({
                    waiting_customer:'Chờ xác nhận từ khách',waiting_price:'Chờ khách xác nhận giá',waiting_preview:'Cần nhân viên kiểm preview đúng snapshot trước khi duyệt',
                    waiting_staff:apiHealthy&&hasClearPendingInbound(selectedOrder)?'Sẵn sàng để NHÂN VIÊN duyệt':'Chờ đối soát tin/file trước khi NHÂN VIÊN duyệt',already_approved:'Nhân viên đã duyệt trên máy chủ',
                    blocked:'Chưa thể duyệt: lệnh đã gửi/chưa rõ hoặc đơn bị khóa'
                  } as const)[confirmation.staff]}</span></div>
                  <p>Chỉ máy chủ xác thực khách và ghi nhận đúng phiên bản. Nhân viên không thể tự xác nhận thay khách; xem trước không phải bằng chứng đã in.</p>
                </section>}
                <div className="detail-tabs" role="tablist"><button role="tab" aria-selected={detailTab==='document'} className={detailTab==='document'?'on':''} onClick={()=>setDetailTab('document')}><FileText size={17}/> Tài liệu & duyệt</button><button role="tab" aria-selected={detailTab==='activity'} className={detailTab==='activity'?'on':''} onClick={()=>setDetailTab('activity')}><History size={17}/> Lịch sử ({selectedOrder.audit.length})</button></div>
                {detailTab==='activity' ? <div className="activity-content">{selectedOrder.audit.length === 0 ? <div className="empty-panel">Chưa có dữ liệu lịch sử từ API (không tự suy đoán).</div> : selectedOrder.audit.map((row,i)=><div className="activity" key={`${row.at}-${i}`}><span className="activity-dot"/><div><strong>{row.action}</strong><p>{row.summary}</p><small>{row.actor} · {time(row.at)}</small></div></div>)}</div> : <div className="detail-scroll">
                  <div className="section-head"><h3><FileText size={18}/> Tài liệu đính kèm</h3><span>{selectedOrder.documents.length} file</span></div>
                  {!useDemo && <VerifiedPreviewGallery key={`${port.authenticatedShopId()??''}:${session?.actor_id??''}:${session?.role??''}:${selectedOrder.order_id}:${selectedOrder.revision}:${selectedOrder.request_hash}`} port={port} order={selectedOrder} session={session} apiHealthy={apiHealthy} busy={busy} onFreshOrder={fresh=>setOrders(prev=>prev.map(o=>o.order_id===fresh.order_id?fresh:o))}/>}
                  {selectedOrder.documents.map(d=>{
                    const format=d.format.trim().toUpperCase();
                    const isWord=['DOC','DOCX','WORD'].includes(format);
                    const isPdf=format==='PDF';
                    const authenticatedStaff=Boolean(session&&['staff','owner'].includes(session.role));
                    return <div className="doc-box" key={d.document_id} data-testid={isPdf?'pdf-document-row':undefined}>
                      <div className="doc-primary"><div className="file-icon"><FileText size={23}/></div><div className="doc-name"><strong>{d.filename}</strong><small>{d.format} · {d.paper} · {d.orientation==='portrait'?'Dọc':'Ngang'} · {d.duplex?'Hai mặt':'Một mặt'} · {d.copies} bản</small></div>
                        {isWord ? <span className="invalid-label"><AlertCircle size={15}/> Chờ Word snapshot</span>
                          : isPdf ? <span className="invalid-label"><AlertCircle size={15}/> Preview PDF chưa nối</span>
                            : d.preview_trusted ? <span className="verified-label"><ShieldCheck size={15}/> Đã kiểm</span>
                              : <span className="invalid-label"><AlertCircle size={15}/> Chưa tin cậy</span>}
                      </div>
                      <div className="doc-stats"><div><span>Trang gốc</span><b>{d.pages ?? '—'}</b></div><div><span>Mặt in</span><b>{d.printed_faces ?? '—'}</b></div><div><span>Tờ giấy</span><b>{d.physical_sheets ?? '—'}</b></div></div>
                      {isWord
                        ? <p className="inline-warning" data-testid="word-preview-source-gated">Preview Word chỉ hiển thị từ snapshot nguồn hiện hành đã xác minh ở mục review bên dưới.</p>
                        : isPdf
                          ? <p className="inline-warning" data-testid="pdf-preview-source-gated">Preview PDF riêng chưa được nối; không dùng URL preview cũ theo file. Ảnh đã xác minh (nếu có) chỉ hiển thị trong gallery bên trên.</p>
                          : <Preview url={d.preview_url} trusted={d.preview_trusted}/>}
                      {d.warnings.map((w,i)=><p className="inline-warning" key={i}><AlertCircle size={15}/> {w}</p>)}
                      {!useDemo && session && authenticatedStaff && isWord && d===firstWordDocument && <WordReviewClient
                        key={`${selectedOrder.order_id}:${selectedOrder.revision}:${selectedOrder.request_hash}:${session.actor_id}:${session.role}`}
                        port={port} order={selectedOrder} session={session} apiHealthy={apiHealthy}
                        onUnauthorized={clearExpiredStaffSession}/>}
                      {!useDemo && session && authenticatedStaff && isPdf && <PdfReviewClient
                        key={`${selectedOrder.order_id}:${selectedOrder.revision}:${selectedOrder.request_hash}:${d.document_id}`}
                        port={port} order={selectedOrder} session={session} apiHealthy={apiHealthy}
                        onUnauthorized={clearExpiredStaffSession}/>}
                    </div>;
                  })}
                  {selectedOrder.documents.length===0 && <div className="empty-panel">API chưa cấp dữ liệu phân tách theo từng file; ảnh raster xác minh (nếu có) không phải bằng chứng khách đã xác nhận. Kế hoạch in tổng hợp: {selectedOrder.total_sheets??'chưa xác minh'} tờ; không dùng số này thay preview để duyệt.</div>}
                  {selectedOrder.warnings.length>0 && <div className="warnings"><strong><ShieldAlert size={17}/> Cảnh báo cần đọc</strong>{selectedOrder.warnings.map((w,i)=><p key={i}>• {w}</p>)}</div>}
                  <div className="section-head spaced"><h3><Wallet size={18}/> Giá & tiền</h3><span>Nhân viên xác nhận</span></div>
                  <div className="money-stats"><div><span>Giá đơn</span><strong>{money(selectedOrder.amount_vnd)}</strong></div><div><span>Đã nhận</span><strong>{money(selectedOrder.received_vnd)}</strong></div><div><span>Còn phải thu</span><strong className="accent-amount">{money(receivable(selectedOrder))}</strong></div></div>
                  {depositShortfall(selectedOrder)>0 && <div className="deposit-alert"><AlertCircle size={17}/><span>Chưa đủ cọc: thiếu <b>{money(depositShortfall(selectedOrder))}</b>. Nhân viên có quyền vẫn có thể duyệt sau khi xác nhận đã đọc cảnh báo.</span></div>}
                  <div className="forms-grid"><div className="input-group"><label htmlFor="amount">Giá mới / khoản tiền (VND)</label><input id="amount" inputMode="numeric" type="number" min="0" step="1" placeholder="Nhập số VND" value={value} onChange={e=>setValue(e.target.value)} disabled={busy}/></div><div className="input-group"><label htmlFor="paymentMethod">Phương thức nhận tiền</label><select id="paymentMethod" value={paymentMethod} onChange={e=>setPaymentMethod(e.target.value as 'cash'|'bank_transfer')} disabled={busy}><option value="cash">Tiền mặt</option><option value="bank_transfer">Chuyển khoản đã kiểm tra</option></select></div></div>
                  <div className="forms-grid" style={{marginTop: 12}}><div className="input-group"><label htmlFor="deposit">Yêu cầu đặt cọc (VND)</label><input id="deposit" inputMode="numeric" type="number" min="0" step="1" value={depositValue} onChange={e=>setDepositValue(e.target.value)} disabled={busy||!canEditRequest}/></div><label className="acknowledge"><input type="checkbox" checked={significantCost} onChange={e=>setSignificantCost(e.target.checked)} disabled={busy||!canEditRequest}/> Chi phí đáng kể — cần khách xác nhận giá</label></div>
                  <div className="action-row"><button className="outline-btn" disabled={busy||!canWork||!canEditRequest} onClick={()=>submitAmount('quote')}><CreditCard size={16}/> Ghi giá nhân viên</button><button className="outline-btn" disabled={busy||!canWork} onClick={()=>submitAmount('payment')}><Wallet size={16}/> Ghi tiền thực nhận</button></div>
                  <div className="section-head spaced"><h3><PackageCheck size={18}/> Kiểm giấy & giao hàng</h3></div>
                  {!useDemo && selectedOrder.job_id && ['SENT_UNVERIFIED','UNKNOWN'].includes(selectedOrder.print_state) && <div className="paper-verification">
                    <strong>Đối soát giấy thật — tác vụ {selectedOrder.job_id}</strong>
                    <p className="hint">Chỉ xác minh sau khi nhân viên trực tiếp kiểm đủ giấy trên máy. Tác vụ UNKNOWN không được tự gửi lại.</p>
                    <div className="forms-grid"><div className="input-group"><label htmlFor="verifiedSheets">Số tờ đã kiểm thực tế</label><input id="verifiedSheets" inputMode="numeric" type="number" min="1" step="1" value={verifiedValue} onChange={e=>setVerifiedValue(e.target.value)} disabled={busy}/></div><div className="input-group"><label htmlFor="paperNote">Ghi chú kiểm tra</label><input id="paperNote" type="text" value={paperNote} placeholder="Đã đếm đủ giấy, kiểm mặt in..." onChange={e=>setPaperNote(e.target.value)} disabled={busy}/></div></div>
                    <button className="outline-btn" disabled={busy||!canWork||!paperNote.trim()||!Number.isSafeInteger(Number(verifiedValue))||Number(verifiedValue)<1} onClick={()=>void act('verify_paper',{physical_sheets:Number(verifiedValue),evidence_kind:'staff_inspected',note:paperNote.trim()},'Đã ghi kiểm chứng giấy thật')}><ClipboardCheck size={16}/> Xác nhận đã kiểm giấy THẬT</button>
                  </div>}
                  <p className="hint">Giấy đã giao: {selectedOrder.delivered_sheets}/{selectedOrder.total_sheets??'chưa xác định'} tờ. Giấy thực tế đã kiểm: {selectedOrder.verified_sheets??'chưa có bằng chứng'} tờ. Có thể giao một phần đã kiểm, không coi lệnh UNKNOWN là in hoàn tất.</p>
                  {selectedOrder.print_state === 'UNKNOWN' && availableVerifiedSheets(selectedOrder)>0 && <p className="inline-warning" data-testid="partial-paper-warning"><AlertCircle size={15}/> Lệnh UNKNOWN vẫn cần đối soát; chỉ được ghi giao tối đa {availableVerifiedSheets(selectedOrder)} tờ đã được kiểm thực tế.</p>}
                  <div className="action-row"><input className="sheets-input" aria-label="Số tờ giao thật" type="number" inputMode="numeric" min="1" step="1" value={deliveryValue} placeholder="Số tờ giao" onChange={e=>setDeliveryValue(e.target.value)}/><button className="outline-btn" disabled={busy||!canWork||availableVerifiedSheets(selectedOrder)===0} onClick={()=>{const n=Number(deliveryValue); if(!Number.isSafeInteger(n)||n<=0||selectedOrder.verified_sheets===null||n>availableVerifiedSheets(selectedOrder)){setError('Số tờ giao phải là số nguyên dương và không vượt giấy thật đã xác minh còn lại.');return} void act('delivery',{physical_sheets:n},'Đã ghi số tờ thực giao')}}><CheckCheck size={16}/> Xác nhận giao</button></div>
                  <div className="section-head spaced"><h3><Hand size={18}/> Hội thoại & xử lý</h3></div>
                  <div className="action-row"><button className="outline-btn" disabled={busy||!session||(!useDemo&&(!apiHealthy||selectedOrder.conversation_generation===null))||!selectedOrder.conversation_id||selectedOrder.conversation_state==='staff'} onClick={()=>void act('handover',{},'Đã tiếp quản hội thoại')}><PauseCircle size={16}/> Tiếp quản AI</button><button className="outline-btn" disabled={busy||!session||(!useDemo&&(!apiHealthy||selectedOrder.conversation_generation===null||(selectedOrder.conversation_claimed_by!==session.actor_id&&session.role!=='owner')))||!selectedOrder.conversation_id||selectedOrder.conversation_state!=='staff'} onClick={()=>void act('return_to_ai',{},'Đã chủ động trả cho AI')}><Play size={16}/> Trả lại cho AI</button></div>
                  <div className="manual-line"><label>Lý do khóa tự động (bắt buộc)<input className="sheets-input" style={{width:'100%',marginTop:8}} value={manualReason} onChange={e=>setManualReason(e.target.value)} placeholder="Ví dụ: chuyển nhân viên xử lý ngoài app" disabled={busy}/></label><label><input type="checkbox" checked={confirmManual} onChange={e=>setConfirmManual(e.target.checked)} /> Tôi đã kiểm tra lệnh chưa gửi, xác nhận khóa tự động trước khi in ngoài ứng dụng.</label><button className="outline-btn danger-outline" disabled={!confirmManual||!manualReason.trim()||busy||!canWork||selectedOrder.print_state!=='NOT_SENT'||selectedOrder.manual_lock} onClick={()=>void act('manual',{reason:manualReason.trim()},'Đã đặt khóa xử lý thủ công')}><LockKeyhole size={16}/> Xử lý thủ công</button></div>
                  <div className="owner-note"><ShieldCheck size={17}/> In lại/in bổ sung và đóng ngoại lệ đã in/có cọc chỉ dành cho chủ; chờ API riêng và đối soát, không có lối tắt trên giao diện.</div>
                </div>}
                {detailTab==='document' && <div className="approve-footer"><div className="approval-copy"><strong>Phê duyệt phiên bản {selectedOrder.revision}</strong><small>{selectedOrder.confirmed_revision===selectedOrder.revision?'Khách đã xác nhận đúng phiên bản':useDemo?'Khách chưa xác nhận phiên bản hiện tại':'Khách cần xác nhận phiên bản hiện hành'} · cần receipt kiểm preview đúng evidence và hàng đợi bổ sung đã đối soát</small>
                  {depositShortfall(selectedOrder)>0 && <label className="acknowledge"><input type="checkbox" checked={depositAck} onChange={e=>setDepositAck(e.target.checked)}/> Đã đọc cảnh báo thiếu cọc {money(depositShortfall(selectedOrder))}</label>}</div>
                  <button data-testid="approve-action" className="primary approve" disabled={!canApprove || busy || (depositShortfall(selectedOrder)>0&&!depositAck)} onClick={()=>void act('approve',{acknowledge_deposit_shortage:depositAck,...(selectedOrder.quote_revision!==null?{quote_revision:selectedOrder.quote_revision}:{})},'Đã duyệt đúng phiên bản')}><ShieldCheck size={19}/> {busy?'Đang xử lý…':'Duyệt lệnh in'}</button>
                </div>}
              </> : <div className="empty-panel">Chọn một đơn từ danh sách để xem chi tiết.</div>}</div>
            </section>
          </>}
      </div>
    </div>
  </div>;
}
function InboundReviewQueue({items,loading,error,refresh}:{items:InboundReviewItem[]|null;loading:boolean;error:string|null;refresh:()=>void}){
  return <section className="inbound-review-page" data-testid="inbound-review-queue" aria-labelledby="inbound-review-title">
    <div className="inbound-review-heading"><div><p className="eyebrow">HÀNG CHỜ NHÂN VIÊN</p><h1 id="inbound-review-title">Sự kiện đến cần xử lý</h1><p className="subtext">Danh sách chỉ chứa metadata sự kiện đã được máy chủ ghi nhận.</p></div>
      <button className="outline-btn" onClick={refresh} disabled={loading}><RefreshCw size={16}/>{loading?'Đang tải…':'Tải lại hàng chờ'}</button></div>
    <div className="inbound-review-disclaimer" data-testid="inbound-review-media-disclaimer">
      Hàng chờ này không chứng minh byte ảnh/tệp đã được lưu hoặc xử lý. Với trạng thái AWAITING_MEDIA, chưa có file để xem preview, xác nhận khách, duyệt hoặc in.
    </div>
    {error&&<p className="inbound-review-error" role="alert" data-testid="inbound-review-error">{error}</p>}
    {loading&&<p role="status" data-testid="inbound-review-loading">Đang tải trạng thái hiện hành từ máy chủ…</p>}
    {!loading&&!error&&items===null&&<p className="inbound-review-error" role="alert">Chưa xác minh được hàng chờ. Tải lại để đọc dữ liệu từ máy chủ.</p>}
    {!loading&&!error&&items?.length===0&&<p className="inbound-review-empty" data-testid="inbound-review-empty">Máy chủ xác nhận hiện không có sự kiện đang chờ.</p>}
    {!loading&&!error&&items&&items.length>0&&<div className="inbound-review-list" data-testid="inbound-review-list">
      {items.map(item=>{const copy=inboundReviewItemCopy(item);return <article className="inbound-review-card" key={item.id} data-testid="inbound-review-item">
        <div className="inbound-review-card-head"><strong>{copy.title}</strong><span>CẦN NHÂN VIÊN</span></div>
        <p className="inbound-review-awaiting">{copy.message}</p>
        <div className="inbound-review-meta"><span>Mã sự kiện: <code>{item.id}</code></span><span>{copy.customer}</span><time dateTime={item.received_at}>{time(item.received_at)}</time></div>
        <small>Trạng thái máy chủ: {item.status} · {item.media_state}</small>
      </article>;})}
    </div>}
  </section>;
}

function Stat({ icon,label,value,note,color,onClick }: { icon: ReactNode; label: string; value: number; note: string; color: string; onClick:()=>void }) {
  return <button className="stat-card" onClick={onClick}><div className={`stat-icon ${color}`}>{icon}</div><span>{label}</span><strong>{value.toString().padStart(2,'0')}</strong><small>{note}</small></button>;
}
function Axis({title,label,warn=false}:{title:string;label:string;warn?:boolean}) {return <div className="axis-item"><span>{title}</span><strong className={warn?'warn-text':''}>{label}</strong></div>}
function WordReviewClient({port,order,session,apiHealthy,onUnauthorized}:{
  port:PrintPort;order:OrderView;session:StaffSession;apiHealthy:boolean;onUnauthorized:()=>void
}) {
  const authenticatedStaff=['staff','owner'].includes(session.role);
  const identity:WordReviewIdentity={shopId:port.authenticatedShopId()??'',orderId:order.order_id,
    revision:order.revision,requestHash:order.request_hash,authenticatedStaff};
  const requestKey=[identity.shopId,session.actor_id,session.role,order.order_id,order.revision,order.request_hash].join('|');
  const [loadedKey,setLoadedKey]=useState('');
  const [state,setState]=useState<WordReviewPanelState>({status:'LOADING'});
  const [pageObjectUrls,setPageObjectUrls]=useState<WordReviewPageObjectUrl[]>([]);
  useEffect(()=>{
    let cancelled=false;
    const owned:string[]=[];
    setLoadedKey(requestKey);
    setState({status:'LOADING'});
    setPageObjectUrls([]);
    const expected={...identity};
    if(!authenticatedStaff){setState({status:'NOT_WIRED'});return()=>{cancelled=true;};}
    if(!apiHealthy){setState({status:'FAILED'});return()=>{cancelled=true;};}
    if(!identity.shopId||order.detail_loaded!==true||!Number.isSafeInteger(order.revision)||order.revision<1||
        !/^[0-9a-f]{64}$/.test(order.request_hash)){
      setState({status:'STALE'});return()=>{cancelled=true;};
    }
    void port.loadWordReviewPreview(order).then(({projection:rawProjection,pages:blobs})=>{
      if(cancelled)return;
      const projection=parseWordReviewPreview(rawProjection,expected);
      if(!projection)throw new ApiFault(409,'WORD_PREVIEW_STALE','Preview Word không khớp order/revision/hash hiện hành.');
      if(projection.status==='NEEDS_HUMAN'){
        if(blobs.length!==0)throw new ApiFault(409,'WORD_PREVIEW_PAGE_MISMATCH','Trạng thái NEEDS_HUMAN không được có trang preview.');
        setState({status:'CURRENT',projection});
        return;
      }
      if(blobs.length!==projection.pages.length)
        throw new ApiFault(409,'WORD_PREVIEW_PAGE_MISMATCH','Số trang tải về không khớp projection.');
      const verified=projection.pages.map((page,index)=>{
        const blob=blobs[index];
        if(!blob||blob.type!=='image/png'||blob.size!==page.bytes)
          throw new ApiFault(409,'WORD_PREVIEW_PAGE_MISMATCH','Trang PNG tải về không khớp projection.');
        const url=URL.createObjectURL(blob);
        owned.push(url);
        return {index:page.index,sha256:page.sha256,url};
      });
      if(cancelled){owned.forEach(url=>URL.revokeObjectURL(url));owned.length=0;return;}
      setPageObjectUrls(verified);
      setState({status:'CURRENT',projection});
    }).catch(error=>{
      owned.forEach(url=>URL.revokeObjectURL(url));owned.length=0;
      if(cancelled)return;
      setPageObjectUrls([]);
      const status=error instanceof ApiFault?error.status:503;
      setState({status:status===404?'MISSING':status===409?'STALE':'FAILED'});
      if(status===401)onUnauthorized();
    });
    return()=>{cancelled=true;owned.forEach(url=>URL.revokeObjectURL(url));};
  },[apiHealthy,authenticatedStaff,identity.shopId,order.detail_loaded,order.order_id,order.request_hash,
    order.revision,onUnauthorized,port,requestKey,session.actor_id,session.role]);
  const current=loadedKey===requestKey&&apiHealthy&&order.detail_loaded===true;
  return <WordReviewPanel identity={identity} state={current?state:{status:'LOADING'}} receipt="unavailable"
    verifiedPageObjectUrls={current?pageObjectUrls:[]}/>;
}
function PdfReviewClient({port,order,session,apiHealthy,onUnauthorized}:{
  port:PrintPort;order:OrderView;session:StaffSession;apiHealthy:boolean;onUnauthorized:()=>void
}) {
  const authenticatedStaff=['staff','owner'].includes(session.role);
  const identity:PdfReviewIdentity={shopId:port.authenticatedShopId()??'',orderId:order.order_id,
    revision:order.revision,requestHash:order.request_hash,authenticatedStaff};
  const requestKey=[identity.shopId,session.actor_id,session.role,order.order_id,order.revision,order.request_hash].join('|');
  const [loadedKey,setLoadedKey]=useState('');
  const [state,setState]=useState<PdfReviewPanelState>({status:'LOADING'});
  const [pageObjectUrls,setPageObjectUrls]=useState<PdfReviewPageObjectUrl[]>([]);
  useEffect(()=>{
    let cancelled=false;
    const owned:string[]=[];
    setLoadedKey(requestKey);
    setState({status:'LOADING'});
    setPageObjectUrls([]);
    const expected={...identity};
    if(!authenticatedStaff){setState({status:'NOT_WIRED'});return()=>{cancelled=true;};}
    if(!apiHealthy){setState({status:'FAILED'});return()=>{cancelled=true;};}
    if(!identity.shopId||order.detail_loaded!==true||!Number.isSafeInteger(order.revision)||order.revision<1||
        !/^[0-9a-f]{64}$/.test(order.request_hash)){
      setState({status:'STALE'});return()=>{cancelled=true;};
    }
    void port.loadPdfReviewPreview(order).then(({projection:rawProjection,pages:blobs})=>{
      if(cancelled)return;
      const projection=parsePdfReviewPreview(rawProjection,expected);
      if(!projection)throw new ApiFault(409,'PDF_PREVIEW_STALE','Preview PDF không khớp order/revision/hash hiện hành.');
      if(projection.status==='NEEDS_HUMAN'){
        if(blobs.length!==0)throw new ApiFault(409,'PDF_PREVIEW_PAGE_MISMATCH','Trạng thái NEEDS_HUMAN không được có trang preview.');
        setState({status:'CURRENT',projection});
        return;
      }
      if(blobs.length!==projection.pages.length)
        throw new ApiFault(409,'PDF_PREVIEW_PAGE_MISMATCH','Số trang tải về không khớp projection.');
      const verified=projection.pages.map((page,index)=>{
        const blob=blobs[index];
        if(!blob||blob.type!=='image/png'||blob.size!==page.bytes)
          throw new ApiFault(409,'PDF_PREVIEW_PAGE_MISMATCH','Trang PNG tải về không khớp projection.');
        const url=URL.createObjectURL(blob);
        owned.push(url);
        return {index:page.index,sha256:page.sha256,url};
      });
      if(cancelled){owned.forEach(url=>URL.revokeObjectURL(url));owned.length=0;return;}
      setPageObjectUrls(verified);
      setState({status:'CURRENT',projection});
    }).catch(error=>{
      owned.forEach(url=>URL.revokeObjectURL(url));owned.length=0;
      if(cancelled)return;
      setPageObjectUrls([]);
      const status=error instanceof ApiFault?error.status:503;
      setState({status:status===404?'MISSING':status===409?'STALE':'FAILED'});
      if(status===401)onUnauthorized();
    });
    return()=>{cancelled=true;owned.forEach(url=>URL.revokeObjectURL(url));};
  },[apiHealthy,authenticatedStaff,identity.shopId,order.detail_loaded,order.order_id,order.request_hash,
    order.revision,onUnauthorized,port,requestKey,session.actor_id,session.role]);
  const current=loadedKey===requestKey&&apiHealthy&&order.detail_loaded===true;
  return <PdfReviewPanel identity={identity} state={current?state:{status:'LOADING'}}
    verifiedPageObjectUrls={current?pageObjectUrls:[]}/>;
}
/** Preview is *only* a read-only staff aid. This never sets DocumentView.preview_trusted
 * and never changes hasValidApprovalInputs/confirmed_revision/order approval.
 * Object URLs are ephemeral, never persisted or placed in a request URL. */
function VerifiedPreviewGallery({port,order,session,apiHealthy,busy,onFreshOrder}:{port:PrintPort;order:OrderView;session:StaffSession|null;apiHealthy:boolean;busy:boolean;onFreshOrder:(fresh:OrderView)=>void}) {
  const [urls,setUrls]=useState<string[]>([]);
  const [facts,setFacts]=useState<VerifiedFileFact[]>([]);
  const [status,setStatus]=useState<'loading'|'verified'|'unavailable'>('loading');
  const [checked,setChecked]=useState(false);
  const [reviewBusy,setReviewBusy]=useState(false);
  const [reviewError,setReviewError]=useState<string|null>(null);
  const [reviewNotice,setReviewNotice]=useState<string|null>(null);
  const reviewLock=useRef(false);
  const reviewKey=useRef<{fingerprint:string;key:string}|null>(null);
  const shopId=port.authenticatedShopId()??'';
  const actorId=session?.actor_id??'';
  const actorRole=session?.role??'';
  const authenticatedStaff=Boolean(actorId&&['staff','owner'].includes(actorRole));
  const requestKey=[shopId,actorId,actorRole,order.order_id,order.revision,order.request_hash].join('|');
  const [loadedKey,setLoadedKey]=useState('');
  useEffect(()=>{
    let cancelled=false;
    const owned:string[]=[];
    const revokeOwned=()=>{owned.splice(0).forEach(url=>URL.revokeObjectURL(url));};
    setLoadedKey(requestKey);
    setUrls([]);
    setFacts([]);
    setStatus('loading');
    setChecked(false);
    setReviewError(null);
    setReviewNotice(null);
    reviewKey.current=null;
    if(!authenticatedStaff||!apiHealthy||!shopId||order.detail_loaded!==true){
      setStatus('unavailable');
      return()=>{cancelled=true;revokeOwned();};
    }
    void port.loadVerifiedPreviewPages(order).then(({pages,files})=>{
      if(cancelled) return;
      if(!pages.length){setStatus('unavailable');return;}
      for(const page of pages) owned.push(URL.createObjectURL(page));
      if(cancelled){revokeOwned();return;}
      setFacts(files);
      setUrls([...owned]);
      setStatus('verified');
    }).catch(()=>{
      revokeOwned();
      if(!cancelled){setFacts([]);setUrls([]);setStatus('unavailable');}
    });
    return ()=>{
      cancelled=true;
      revokeOwned();
    };
  },[apiHealthy,authenticatedStaff,actorId,actorRole,shopId,port,order.detail_loaded,order.order_id,order.revision,order.request_hash,requestKey,session?.actor_id,session?.role]);
  const identityCurrent=loadedKey===requestKey;
  const current=identityCurrent&&authenticatedStaff&&apiHealthy&&order.detail_loaded===true;
  const visibleStatus:typeof status=!identityCurrent?'loading':!authenticatedStaff||!apiHealthy||order.detail_loaded!==true?'unavailable':status;
  const visibleUrls=current?urls:[];
  const visibleFacts=current?facts:[];
  const evidenceSha=order.print_evidence?.evidence_sha256??'';
  const block=previewReviewBlock({order,staff:session,apiHealthy,simulation:useDemo,
    previewVerified:current&&status==='verified',previewPages:visibleUrls.length,previewFiles:visibleFacts,
    checked,busy:busy||reviewBusy});
  const sequence=previewReviewSequence(order);
  const canRenderReviewAction=Boolean(session&&session.can_approve&&['staff','owner'].includes(session.role));
  const submitReview=async()=>{
    if(reviewLock.current||block!=='allowed'||!evidenceSha)return;
    reviewLock.current=true;
    setReviewBusy(true);setReviewError(null);setReviewNotice(null);
    const fingerprint=[order.order_id,order.revision,order.request_hash,evidenceSha].join('|');
    if(reviewKey.current?.fingerprint!==fingerprint)
      reviewKey.current={fingerprint,key:newMutationKey()};
    const key=reviewKey.current.key;
    try{
      const fresh=await port.reviewPreview(order,evidenceSha,key);
      reviewKey.current=null;
      onFreshOrder(fresh);
      setChecked(false);
      setReviewNotice('Máy chủ đã xác nhận receipt nhân viên khớp revision, request hash và evidence SHA hiện hành.');
    }catch(error){
      const fault=error as ApiFault;
      setReviewError(previewReviewErrorMessage(fault.code??'UNKNOWN',fault.message??'Không ghi được receipt kiểm preview.'));
      if(fault.status===401){reviewKey.current=null;}
      if(fault.status===0||fault.status===409||fault.status===503){
        try{
          const fresh=await port.getOrder(order.order_id);
          onFreshOrder(fresh);
          if(fresh.preview_review?.status==='matching'&&fresh.print_evidence?.evidence_sha256===evidenceSha){
            reviewKey.current=null;
            setReviewNotice('Đã tải lại và xác minh receipt đã được lưu trên máy chủ.');
            setReviewError(null);
          }
        }catch{/* Preserve the original error; do not retry the write automatically. */}
      }
    }finally{reviewLock.current=false;setReviewBusy(false);}
  };
  return <section className="verified-previews" data-testid="verified-preview-gallery" aria-label="Ảnh xem trước đã xác minh">
    <strong><ShieldCheck size={15}/> Xem trước bản raster theo phiên bản {order.revision}</strong>
    {visibleStatus==='loading' && <p role="status">Đang kiểm tra manifest, SHA-256 và quyền đọc ảnh…</p>}
    {visibleStatus==='unavailable' && <p data-testid="preview-unavailable">Chưa thể xác minh đầy đủ ảnh xem trước. Không dùng ảnh thiếu tin cậy để duyệt in.</p>}
    {visibleStatus==='verified' && visibleFacts.length>0 && <div className="verified-document-list" data-testid="verified-document-list">
      <h4>Thông số từng file do AI3 xác minh</h4>
      {visibleFacts.map(f=><div className="verified-document-row" data-testid="verified-document-row" key={f.index}>
        <div className="verified-document-title"><FileText size={16}/> <b>{f.label}</b> <small>{f.format}</small></div>
        <p className="v1-word-pdf-status" data-testid="v1-word-pdf-status">
          {routeVerifiedDocument(f)==='word'?'Word/DOCX':routeVerifiedDocument(f)==='pdf'?'PDF':'Ngoài luồng Word/PDF V1 — chờ nhân viên'}
          {' · Preview đã xác minh theo revision '+order.revision+' và hash hiện hành; chưa xác nhận khách, chưa duyệt và không xác nhận đã in.'}
        </p>
        <div className="verified-document-metrics">
          <span>Trang gốc <b>{f.document_pages}</b></span>
          <span>Mặt in <b>{f.printed_faces}</b></span>
          <span>Tờ giấy <b>{f.physical_sheets}</b></span>
          <span>Số bản <b>{f.copies}</b></span>
          <span>Khổ <b>{f.paper}</b></span>
          <span>{f.duplex?'Hai mặt':'Một mặt'} · {f.orientation==='landscape'?'Ngang':'Dọc'}</span>
        </div>
        {f.warnings.length>0 && <p>AI3 khuyến nghị nhân viên kiểm tra nội dung trước khi duyệt.</p>}
      </div>)}
    </div>}
    {visibleStatus==='verified' && visibleFacts.length===0 && <p data-testid="document-facts-unavailable">Chưa có thông số từng file đã được AI3 xác minh; không suy đoán số trang hoặc số tờ.</p>}
    {visibleStatus==='verified' && <div className="verified-preview-grid">
      {visibleUrls.map((url,index)=><figure key={url}>
        <img data-testid="verified-preview-image" src={url} alt={`Ảnh xem trước đã xác minh, trang ${index+1}`} loading="lazy"/>
        <figcaption>Trang {index+1}/{visibleUrls.length} · đã kiểm tra SHA-256</figcaption>
      </figure>)}
    </div>}
    <section className="preview-review-workflow" data-testid="preview-review-workflow" aria-label="Kiểm preview, xác nhận khách và duyệt riêng">
      <h4>Trình tự Word/PDF V1</h4>
      <div className="preview-review-snapshot" data-testid="preview-review-snapshot">
        <b>Snapshot hiện hành</b><span>Revision {order.revision}</span>
        <span>Request hash: <code>{order.request_hash||'chưa có'}</code></span>
        <span>Evidence SHA-256: <code>{evidenceSha||'chưa được máy chủ cấp'}</code></span>
      </div>
      <ol className="preview-review-steps">
        <li data-testid="preview-review-step-staff"><b>1. Nhân viên kiểm tra preview</b><span>{sequence.staff_preview==='complete'
          ? `Đã có receipt khớp snapshot${order.preview_review?.reviewer_id?` · nhân viên ${order.preview_review.reviewer_id}`:''}.`
          : sequence.staff_preview==='blocked'?'Chưa có evidence máy chủ; chưa thể kiểm tra/ghi receipt.':'Cần nhân viên xác thực xem các trang và thông số trước khi tiếp tục.'}</span>
          {order.preview_review?.status==='missing'&&<small data-testid="preview-review-missing">Chưa có receipt cho snapshot hiện hành.</small>}
          {order.preview_review?.status==='stale'&&<small className="preview-review-stale" data-testid="preview-review-stale">Receipt cũ: revision {order.preview_review.revision??'không rõ'} / hash không khớp snapshot hiện hành. Cần kiểm tra lại preview.</small>}
          {order.preview_review?.status==='unavailable'&&<small data-testid="preview-review-unavailable">Không đọc được trạng thái evidence/receipt từ API hiện hành.</small>}
          {visibleStatus==='verified'&&visibleFacts.some(f=>f.warnings.length>0)&&<small className="preview-review-stale" data-testid="preview-review-renderer-warnings">AI3 có cảnh báo: {visibleFacts.flatMap(f=>f.warnings).join(', ')}. Nếu font, bố cục hoặc thông số còn chưa chắc chắn, giữ đơn để xử lý thủ công.</small>}
          {canRenderReviewAction&&sequence.staff_preview!=='complete'&&<>
            {visibleStatus==='verified'&&visibleUrls.length>0&&visibleFacts.length>0&&visibleFacts.every(f=>routeVerifiedDocument(f)!=='staff_only')&&<label className="preview-review-ack"><input data-testid="preview-review-ack" type="checkbox" checked={checked} onChange={e=>setChecked(e.target.checked)} disabled={busy||reviewBusy}/><span>Tôi đã xem toàn bộ preview và thông số; tôi sẽ giữ đơn chuyển xử lý thủ công nếu phát hiện lỗi hoặc còn điểm chưa chắc chắn.</span></label>}
            <button data-testid="preview-review-action" className="outline-btn" disabled={block!=='allowed'} onClick={()=>void submitReview()}>
              <ClipboardCheck size={16}/>{reviewBusy?'Đang ghi nhận…':order.preview_review?.status==='stale'?'Kiểm tra lại preview hiện hành':'Ghi nhận đã kiểm tra preview'}
            </button>
            {block!=='allowed'&&<small data-testid="preview-review-disabled-reason">{previewReviewBlockMessage(block)}</small>}
          </>}
          {!canRenderReviewAction&&<small data-testid="preview-review-permission">Thao tác chỉ dành cho nhân viên/chủ đã đăng nhập và được cấp quyền.</small>}
        </li>
        <li data-testid="preview-review-step-customer"><b>2. Khách xác nhận đúng phiên bản</b><span>{sequence.customer_confirmation==='complete'
          ?'Máy chủ đã ghi nhận khách xác nhận đúng revision/hash hiện hành.'
          :sequence.customer_confirmation==='stale'
            ?'Xác nhận cũ không còn được coi là hiện hành vì receipt/evidence preview không khớp; giữ đơn và yêu cầu xác nhận lại sau khi kiểm tra preview mới.'
          :sequence.customer_confirmation==='next'
            ?'Bước tiếp theo: yêu cầu khách xác nhận qua luồng hiện có. Màn hình này không tự gửi tin Zalo/OA.'
            :'Chỉ yêu cầu khách xác nhận sau khi nhân viên đã kiểm tra đúng preview hiện hành.'}</span></li>
        <li data-testid="preview-review-step-approval"><b>3. Nhân viên duyệt lệnh in — thao tác riêng</b><span>{sequence.staff_approval==='complete'
          ?'Máy chủ ghi nhận duyệt riêng; trạng thái này không xác nhận đã in.'
          :sequence.staff_approval==='ready'
            ?'Đủ dữ liệu để nhân viên dùng nút “Duyệt lệnh in” riêng bên dưới.'
            :'Chưa thể duyệt; cần receipt hiện hành, xác nhận khách và các cổng an toàn khác.'}</span></li>
      </ol>
      {reviewError&&<p className="preview-review-error" role="alert" data-testid="preview-review-error">{reviewError}</p>}
      {reviewNotice&&<p className="preview-review-notice" role="status" data-testid="preview-review-notice">{reviewNotice}</p>}
    </section>
    <p className="preview-disclaimer">Ảnh xem trước không phải xác nhận của khách và không chứng minh đã in hoặc giao giấy thật.</p>
  </section>;
}
function Preview({url,trusted}:{url:string|null;trusted:boolean}) {
  let safeUrl: string|null = null;
  if (url && trusted) { try { const candidate = new URL(url, window.location.origin); if (candidate.origin===window.location.origin && candidate.protocol===window.location.protocol) safeUrl=candidate.href; } catch {/* ignore */} }
  return <div className="preview-placeholder"><div className="preview-paper"><FileText size={33}/><span>PREVIEW</span></div><div><strong>{safeUrl ? 'Bản xem trước xác thực' : 'Chưa có ảnh preview để hiển thị'}</strong><p>{safeUrl ? 'Mở tài liệu do máy chủ cấp theo phiên đã xác nhận.' : 'Không dựng nội dung giả. Cần bộ xử lý tài liệu cung cấp preview đáng tin.'}</p>{safeUrl && <a className="preview-link" href={safeUrl} target="_blank" rel="noopener noreferrer">Mở bản xem trước <ArrowDownToLine size={15}/></a>}</div></div>;
}
function Overview({totals,orders,open}:{totals:{waiting:number;attention:number;ready:number;count:number};orders:OrderView[];open:(id:string)=>void}) {
  return <section className="overview"><p className="eyebrow">AUTO-IN MINH ĐIẾN</p><h1>Tổng quan vận hành</h1><p className="subtext">Các con số chỉ phản ánh danh sách đơn trả về trong phiên hiện tại.</p><div className="stat-grid"><Stat icon={<ClipboardCheck/>} label="Chờ duyệt" value={totals.waiting} note="Cần nhân viên" color="green" onClick={()=>orders.find(o=>o.order_state==='confirmed')&&open(orders.find(o=>o.order_state==='confirmed')!.order_id)}/><Stat icon={<ShieldAlert/>} label="Cần xử lý" value={totals.attention} note="Ưu tiên hoặc rủi ro" color="rose" onClick={()=>orders[0]&&open(orders[0].order_id)}/><Stat icon={<PackageCheck/>} label="Chờ giao" value={totals.ready} note="Theo trạng thái giao" color="amber" onClick={()=>orders[0]&&open(orders[0].order_id)}/><Stat icon={<FileText/>} label="Tổng đơn" value={totals.count} note="Chỉ số trong phiên" color="blue" onClick={()=>orders[0]&&open(orders[0].order_id)}/></div><div className="overview-section"><h2>Đơn mới cần xem</h2>{orders.slice(0,4).map(o=><button className="overview-order" key={o.order_id} onClick={()=>open(o.order_id)}><span><b>{o.order_id}</b> · {o.customer_name}</span><span>{printLabels[o.print_state]} <ChevronRight size={17}/></span></button>)}</div></section>;
}
function SettingsView({mode,session,onLogout}:{mode:OperationMode;session:StaffSession|null;onLogout:()=>void}) {
  const [permission,setPermission] = useState(notificationCapability);
  const [permissionBusy,setPermissionBusy] = useState(false);
  const permissionInFlight = useRef(false);
  const [shopSchedule,setShopSchedule] = useState<ShopSchedule|null>(null);
  const [scheduleDraft,setScheduleDraft] = useState<ScheduleDraft|null>(null);
  const [scheduleLoading,setScheduleLoading] = useState(false);
  const [scheduleSaving,setScheduleSaving] = useState(false);
  const [scheduleError,setScheduleError] = useState<string|null>(null);
  const [scheduleLocalError,setScheduleLocalError] = useState<string|null>(null);
  const [scheduleMessage,setScheduleMessage] = useState<string|null>(null);
  const scheduleInFlight = useRef(false);
  const scheduleWriteAllowed = !useDemo && canEditShopSchedule(session?.role,session?.can_manage_schedule===true);
  useEffect(()=>{
    let cancelled=false;
    if(useDemo||!session){setShopSchedule(null);setScheduleDraft(null);return;}
    setScheduleLoading(true);setScheduleError(null);setScheduleMessage(null);
    void port.getShopSchedule().then(value=>{
      if(!cancelled){setShopSchedule(value);setScheduleDraft(draftFromSchedule(value));}
    }).catch((error:unknown)=>{
      if(!cancelled){setShopSchedule(null);setScheduleDraft(null);setScheduleError(scheduleErrorText(error));}
    }).finally(()=>{if(!cancelled)setScheduleLoading(false);});
    return ()=>{cancelled=true;};
  },[session?.actor_id]);
  const refreshSchedule=async()=>{
    if(useDemo||!session||scheduleInFlight.current||scheduleLoading||scheduleSaving)return;
    scheduleInFlight.current=true;setScheduleLoading(true);
    setScheduleError(null);setScheduleLocalError(null);setScheduleMessage(null);
    try{
      const value=await port.getShopSchedule();
      setShopSchedule(value);setScheduleDraft(draftFromSchedule(value));
    }catch(error){
      setShopSchedule(null);setScheduleDraft(null);setScheduleError(scheduleErrorText(error));
    }finally{scheduleInFlight.current=false;setScheduleLoading(false);}
  };
  const saveSchedule=async()=>{
    if(!scheduleWriteAllowed||!shopSchedule||!scheduleDraft||scheduleError||
       scheduleLoading||scheduleSaving||scheduleInFlight.current)return;
    scheduleInFlight.current=true;setScheduleSaving(true);
    setScheduleLocalError(null);setScheduleMessage(null);
    try{
      const result=await saveShopScheduleAndRead(port,shopSchedule,scheduleDraft,newMutationKey());
      if(result.fresh){
        setShopSchedule(result.fresh);setScheduleDraft(draftFromSchedule(result.fresh));
      }
      if(result.kind==='unchanged')setScheduleMessage('Lịch không có thay đổi.');
      else if(result.kind==='saved')setScheduleMessage('Đã lưu và GET xác minh lại phiên bản lịch từ máy chủ.');
      else setScheduleError(scheduleErrorText(result.failure)+
        (result.readbackFailed?' Không đọc lại được; không tự gửi lại PATCH.':
        ' Đã đọc lại dữ liệu máy chủ; kiểm tra rồi bấm Tải lại để sửa tiếp.'));
    }catch(error){
      setScheduleLocalError(error instanceof Error?error.message:'Dữ liệu lịch không hợp lệ.');
    }finally{scheduleInFlight.current=false;setScheduleSaving(false);}
  };

  const askNotificationPermission = async () => {
    // Prevent duplicate prompts and never prompt outside a real user click.
    if (permissionInFlight.current) return;
    const current = notificationCapability();
    if (current !== 'needs-permission') { setPermission(current); return; }
    permissionInFlight.current = true;
    setPermissionBusy(true);
    try {
      setPermission(await requestLocalNotifications());
    } catch {
      // Defensive UI boundary if the adapter unexpectedly fails later.
      const latest = notificationCapability();
      setPermission(latest === 'needs-permission' ? 'permission-error' : latest);
    } finally {
      permissionInFlight.current = false;
      setPermissionBusy(false);
    }
  };
  return <section className="settings-page"><p className="eyebrow">CẤU HÌNH VẬN HÀNH</p><h1>Cài đặt & lịch</h1><p className="subtext">Những chức năng chưa có API sẽ hiển thị chưa sẵn sàng, không tự lưu trên trình duyệt.</p>
    <div className="settings-grid"><div className="settings-box" data-testid="schedule-box">
      <div className="setting-heading"><Clock3/><div><h3>Giờ hoạt động & ngày nghỉ</h3>
      <p>{shopSchedule?'Lịch shop · phiên bản '+shopSchedule.version:scheduleLoading?'Đang đọc lịch từ máy chủ':'Chưa xác minh lịch shop'}</p></div></div>
      <p>Đây là lịch và khóa <strong>gửi lệnh in</strong> của cửa hàng; không tạm dừng AI tư vấn hoặc tự bật in thật.</p>
      {useDemo ? <p data-testid="schedule-demo">Chế độ demo: không có API lịch shop, không lưu thay đổi.</p>
      : <>
        {scheduleError && <p role="alert" data-testid="schedule-error" className="schedule-alert">{scheduleError}</p>}
        {scheduleLocalError && <p role="alert" data-testid="schedule-validation-error" className="schedule-alert">{scheduleLocalError}</p>}
        {scheduleMessage && <p role="status" data-testid="schedule-status">{scheduleMessage}</p>}
        {!scheduleWriteAllowed && <p data-testid="schedule-view-only">Chỉ chủ cửa hàng được sửa lịch; nhân viên có quyền xem.</p>}
        {shopSchedule && scheduleDraft && <>
          <p data-testid="schedule-guard" className="hint">Múi giờ: {shopSchedule.timezone}; mode máy chủ: {shopSchedule.operational_guard.mode}; printing_enabled: {String(shopSchedule.operational_guard.printing_enabled)} (chỉ đọc; không xác nhận máy đang in).</p>
          <form data-testid="schedule-form" onSubmit={event=>{event.preventDefault();void saveSchedule();}}>
            <fieldset className="shop-schedule-fields" disabled={!scheduleWriteAllowed||!!scheduleError||scheduleLoading||scheduleSaving}>
              <label>Giờ mở in (HH:mm)<input data-testid="schedule-open-at" value={scheduleDraft.open_at} inputMode="numeric" onChange={e=>setScheduleDraft({...scheduleDraft,open_at:e.target.value})} /></label>
              <label>Giờ đóng in (HH:mm)<input data-testid="schedule-close-at" value={scheduleDraft.close_at} inputMode="numeric" onChange={e=>setScheduleDraft({...scheduleDraft,close_at:e.target.value})} /></label>
              <label className="schedule-full-width">Ngày nghỉ (YYYY-MM-DD, cách nhau dấu phẩy / xuống dòng)
                <textarea data-testid="schedule-holidays" rows={2} value={scheduleDraft.holiday_dates} onChange={e=>setScheduleDraft({...scheduleDraft,holiday_dates:e.target.value})}/>
              </label>
              <label className="schedule-manual-lock schedule-full-width"><input type="checkbox" data-testid="schedule-manual-lock" checked={scheduleDraft.manual_lock} onChange={e=>setScheduleDraft({...scheduleDraft,manual_lock:e.target.checked})}/> Tạm khóa gửi lệnh in của shop (không dừng AI)</label>
            </fieldset>
            {scheduleWriteAllowed && <button type="submit" data-testid="schedule-save" className="outline-btn" disabled={!!scheduleError||scheduleLoading||scheduleSaving}>{scheduleSaving?'Đang ghi và xác minh…':'Lưu lịch (chủ cửa hàng)'}</button>}
          </form>
        </>}
        <button className="outline-btn" data-testid="schedule-refresh" disabled={scheduleLoading||scheduleSaving} onClick={()=>{void refreshSchedule();}}>{scheduleLoading?'Đang tải lịch…':'Tải lại lịch từ máy chủ'}</button>
      </>}
    </div>
    <div className="settings-box"><div className="setting-heading"><ShieldCheck/><div><h3>Chế độ vận hành</h3><p>{labelMode(mode)}</p></div></div><p>Chỉ chủ được mở chính thức sau nghiệm thu. Giao diện không tự thay chế độ máy chủ.</p><button className="outline-btn" disabled>Đổi chế độ — chưa có API</button></div>
    <div className="settings-box"><div className="setting-heading"><Bell/><div><h3>Thông báo thiết bị</h3><p role={permission==='permission-error'?'alert':undefined}>{permission==='unsupported'?'Trình duyệt hoặc kết nối HTTPS chưa hỗ trợ thông báo':permission==='granted-no-subscription'?'Đã cấp quyền, chưa nối Web Push':permission==='permission-denied'?'Đã từ chối quyền — kiểm tra cài đặt trình duyệt':permission==='permission-error'?'Yêu cầu quyền thất bại. Có thể thử lại; Web Push chưa kết nối.':'Chưa cấp quyền thông báo'}</p></div></div><p>Web Push thật chưa được kết nối; thông báo sẽ mở đúng đơn sau khi có backend phát Push được xác thực.</p><button className="outline-btn" disabled={permissionBusy || (permission!=='needs-permission' && permission!=='permission-error')} onClick={()=>{void askNotificationPermission();}}>{permissionBusy?'Đang yêu cầu quyền…':permission==='permission-error'?'Thử lại yêu cầu quyền':'Yêu cầu quyền thiết bị'}</button></div>
    <div className="settings-box"><div className="setting-heading"><SlidersHorizontal/><div><h3>Quy tắc khách quen</h3><p>Quy tắc chỉ hiệu lực sau phê duyệt</p></div></div><p>Quy tắc khách, nhật ký sửa và phục hồi phiên bản đang chờ hợp đồng API.</p><button className="outline-btn" disabled>Quản lý quy tắc — chờ API</button></div></div>
    <div className="account-box"><span><UserRound size={19}/>{session?.display_name??'Chưa có tài khoản'} · {session?.role==='owner'?'Chủ':'Nhân viên'}</span><button className="outline-btn" onClick={onLogout}><LogOut size={16}/> Đăng xuất</button></div>
  </section>;
}
export default App;
