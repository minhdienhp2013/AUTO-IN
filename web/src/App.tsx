import type { FormEvent, ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle, ArrowDownToLine, ArrowLeft, Bell, BookOpen, Check, CheckCheck, ChevronDown, ChevronRight,
  CircleHelp, ClipboardCheck, Clock3, CreditCard, FileText, Hand, History, LayoutDashboard, LockKeyhole,
  LogOut, Menu, MonitorSmartphone, MoreHorizontal, PackageCheck, PauseCircle, Play, Printer,
  RefreshCw, Search, Settings2, ShieldAlert, ShieldCheck, SlidersHorizontal, Smartphone, UserRound,
  Wallet, X
} from 'lucide-react';
import { ApiFault, isDemo, makePort, newMutationKey, snapshotFromPort, type PrintPort } from './api.ts';
import {
  availableVerifiedSheets, conversationLabels, deliveryLabels, depositShortfall, hasValidApprovalInputs, isPrintUncertain, money,
  orderLabels, paymentLabels, printLabels, receivable,
  type ActionKind, type OrderView, type OperationMode, type StaffSession, type VerifiedFileFact
} from './domain.ts';
import { notificationCapability, orderFromNavigation, requestLocalNotifications } from './notifications.ts';

type View = 'orders' | 'overview' | 'settings';
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
  const [mode, setMode] = useState<OperationMode>(useDemo ? 'simulation' : 'unverified');
  const [view, setView] = useState<View>('orders');
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<DetailTab>('document');
  const [mobileDetail, setMobileDetail] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [loading, setLoading] = useState(true);
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
  const [deliveryValue, setDeliveryValue] = useState('');
  const [verifiedValue, setVerifiedValue] = useState('');
  const [paperNote, setPaperNote] = useState('');
  const [depositAck, setDepositAck] = useState(false);
  const [confirmManual, setConfirmManual] = useState(false);
  const lock = useRef(false);
  const selectedIdRef = useRef<string | null>(null);

  const selectedOrder = orders.find(o => o.order_id === selected) ?? null;
  useEffect(() => { selectedIdRef.current = selected; }, [selected]);
  const load = useCallback(async (onlyOrders = false) => {
    setError(null);
    try {
      const snapshot = onlyOrders ? null : await snapshotFromPort(port);
      const list = snapshot?.orders ?? await port.listOrders();
      if (snapshot) { setSession(snapshot.session); setMode(snapshot.mode); }
      const id = selectedIdRef.current;
      if (!useDemo && id && (snapshot?.session || onlyOrders)) {
        const detail = await port.getOrder(id);
        setOrders(list.some(o => o.order_id === id)
          ? list.map(o => o.order_id === id ? detail : o) : [detail, ...list]);
      } else setOrders(list);
      setApiHealthy(true);
    } catch (e) {
      const fault = e as ApiFault;
      if (fault.status === 401) { setSession(null); setOrders([]); setSelected(null); }
      if (fault.status === 0 || fault.status === 503) setApiHealthy(false);
      setError(fault.message || 'Không kết nối được.');
    } finally { setLoading(false); }
  }, []);

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
    if (term && !`${o.order_id} ${o.customer_name} ${o.documents.map(d => d.filename).join(' ')}`.toLocaleLowerCase('vi-VN').includes(term)) return false;
    if (filter === 'approval') return o.order_state === 'confirmed';
    if (filter === 'attention') return o.urgent || o.conversation_state === 'needs_human' || isPrintUncertain(o.print_state);
    if (filter === 'delivery') return ['ready','partial','quality_check'].includes(o.delivery_state);
    return true;
  }).sort((a,b) => (Number(b.urgent)-Number(a.urgent)) || b.created_at.localeCompare(a.created_at)), [orders, query, filter]);
  const totals = useMemo(() => ({
    waiting: orders.filter(o => o.order_state === 'confirmed').length,
    attention: orders.filter(o => o.urgent || o.print_state === 'UNKNOWN' || o.conversation_state === 'needs_human').length,
    ready: orders.filter(o => ['ready','partial'].includes(o.delivery_state)).length,
    count: orders.length,
  }), [orders]);

  const act = async (kind: ActionKind, payload: Record<string, string|number|boolean|null> = {}, reason = 'Đã lưu thao tác') => {
    if (!selectedOrder || lock.current) return;
    lock.current = true; setBusy(true); setToast(null); setError(null);
    try {
      const changed = await port.mutate(selectedOrder, kind, payload, newMutationKey());
      setOrders(prev => prev.map(o => o.order_id === changed.order_id ? changed : o));
      setToast(useDemo ? `ĐÃ MÔ PHỎNG: ${reason}. Không có tác vụ thật.` : `${reason}. Đã đối chiếu dữ liệu từ API.`);
      setValue(''); setDeliveryValue(''); setDepositAck(false);
    } catch (e) {
      const fault = e as ApiFault;
      if (fault.status === 401) { setSession(null); setOrders([]); setSelected(null); }
      if (fault.status === 0 || fault.status === 503) setApiHealthy(false);
      setError((fault.message ?? 'Không thể thực hiện.') + (fault.status === 409 ? ' Không tự thực hiện lại; đang tải dữ liệu mới.' : ''));
      if (fault.status === 409) {
        try { const latest = await port.getOrder(selectedOrder.order_id); setOrders(prev => prev.map(o => o.order_id === latest.order_id ? latest : o)); }
        catch { /* preserve error; no success */ }
      }
    } finally { lock.current = false; setBusy(false); }
  };
  const doLogin = async (ev: FormEvent) => {
    ev.preventDefault(); setBusy(true); setError(null);
    try { setSession(await port.login(loginShop, loginUser, loginPassword)); await load(true); setLoginPassword(''); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const doLogout = async () => {
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
  const canApprove = Boolean(canWork && selectedOrder && hasValidApprovalInputs(selectedOrder));
  const printAttention = selectedOrder ? isPrintUncertain(selectedOrder.print_state) : false;

  return <div className="shell">
    <aside className={`sidebar ${menuOpen ? 'sidebar-open' : ''}`}>
      <div className="brand"><div className="brand-mark"><Printer size={22} strokeWidth={2.5}/></div><div><b>MINH ĐIẾN</b><small>AUTO-IN / PRINT DESK</small></div></div>
      <div className="sidebar-caption">KHÔNG GIAN LÀM VIỆC</div>
      <nav aria-label="Điều hướng chính" className="nav">
        <button className={view === 'overview' ? 'active' : ''} onClick={() => {setView('overview');setMenuOpen(false)}}><LayoutDashboard size={19}/> Tổng quan</button>
        <button className={view === 'orders' ? 'active' : ''} onClick={() => {setView('orders');setMenuOpen(false);setMobileDetail(false)}}><BookOpen size={19}/> Quản lý đơn in <span className="nav-count">{totals.count}</span></button>
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
        <div className="top-left"><button aria-label="Mở menu" className="menu-icon" onClick={() => setMenuOpen(x=>!x)}><Menu size={22}/></button><div className="breadcrumb">Vận hành <ChevronRight size={14}/> <strong>{view === 'orders' ? 'Quản lý đơn in' : view === 'overview' ? 'Tổng quan' : 'Cài đặt'}</strong></div></div>
        <div className="top-right"><span data-testid="operation-mode" className={`mode-pill ${modeTone(mode)}`}><span className="status-dot"/>{labelMode(mode)}</span><button className="icon-button" title="Làm mới" aria-label="Làm mới dữ liệu" disabled={loading || busy} onClick={()=>void load()}><RefreshCw size={19}/></button><div className="user-avatar" title={session?.display_name ?? 'Chưa đăng nhập'}><UserRound size={19}/></div></div>
      </header>
      <div className="content">
        {error && <div className="banner error" role="alert" data-testid="api-error"><AlertCircle size={19}/><span>{error}</span><button aria-label="Đóng lỗi" onClick={()=>setError(null)}><X size={17}/></button></div>}
        {!apiHealthy && !useDemo && <div className="banner error" role="alert" data-testid="api-error"><ShieldAlert size={19}/><span>Không xác minh được API. Dữ liệu cũ chỉ để tham khảo; các thao tác ghi đã tạm khóa.</span></div>}
        {toast && <div className="banner success" role="status"><Check size={19}/><span>{toast}</span><button aria-label="Đóng thông báo" onClick={()=>setToast(null)}><X size={17}/></button></div>}
        {!useDemo && !session && !loading ? <section className="login-card"><div className="login-icon"><LockKeyhole/></div><h1>Đăng nhập nhân viên</h1><p>Đăng nhập bằng tài khoản cấp từ máy chủ AUTO-IN. Quyền được kiểm tra tại server.</p><form data-testid="staff-login" onSubmit={doLogin}><label>Mã cửa hàng<input autoComplete="organization" required value={loginShop} onChange={e=>setLoginShop(e.target.value)} /></label><label>Tên đăng nhập<input autoComplete="username" required value={loginUser} onChange={e=>setLoginUser(e.target.value)}/></label><label>Mật khẩu<input autoComplete="current-password" type="password" required value={loginPassword} onChange={e=>setLoginPassword(e.target.value)}/></label><button className="primary" disabled={busy}>Đăng nhập an toàn</button></form></section>
          : loading ? <div className="empty-center"><RefreshCw className="spin" size={26}/> Đang tải dữ liệu…</div>
          : view === 'settings' ? <SettingsView mode={mode} session={session} onLogout={()=>void doLogout()}/>
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
                <div data-testid="order-list" className="order-scroll">{filtered.length === 0 ? <div className="empty-panel">Không có đơn phù hợp.</div> : filtered.map(order=><button key={order.order_id} onClick={()=>doSelect(order.order_id)} className={`order-card ${selected===order.order_id?'selected':''}`} aria-current={selected===order.order_id?'true':undefined}>
                  <div className="order-row"><span className="order-id">{order.order_id}</span><span className="order-time"><Clock3 size={12}/>{time(order.created_at)}</span></div>
                  <div className="order-customer">{order.customer_name} {order.urgent && <span className="urgent-label">ƯU TIÊN</span>}</div>
                  <div className="order-description">{order.documents.length ? `${order.documents.length} tài liệu · ${order.total_sheets ?? '?'} tờ` : 'Chưa có tài liệu'}</div>
                  <div className="order-row footer"><span className={`state-chip ${statusTone(order)}`}>{order.print_state === 'UNKNOWN' ? printLabels.UNKNOWN : orderLabels[order.order_state]}</span><ChevronRight size={16}/></div>
                </button>)}</div>
                <div className="panel-foot"><span className="dot-legend"/> Dữ liệu {useDemo?'mô phỏng, không có khách thật':'trả về từ server'}</div>
              </div>
              <div data-testid="order-detail" className="detail-panel">{selectedOrder ? <>
                <div className="detail-head"><div className="detail-title"><button className="back-mobile" aria-label="Về danh sách" onClick={()=>setMobileDetail(false)}><ArrowLeft size={20}/></button><div><p className="eyebrow">CHI TIẾT ĐƠN IN <span>· LẦN SỬA {selectedOrder.revision}</span></p><h2>{selectedOrder.order_id}</h2></div></div><span className={`state-chip ${statusTone(selectedOrder)}`}>{orderLabels[selectedOrder.order_state]}</span></div>
                {useDemo && <div className="simulation-note"><AlertCircle size={17}/> <strong>DEMO:</strong> mọi thao tác trong trang chỉ thay đổi dữ liệu giả lập. Không gửi Zalo, không in hoặc thu tiền thật.</div>}
                {printAttention && <div className="risk-note"><ShieldAlert size={20}/><div><strong>Lệnh in cần đối soát</strong><p>{printLabels[selectedOrder.print_state]}. Không tự gửi lại; chỉ chủ cửa hàng duyệt in lại sau kiểm tra thực tế.</p></div></div>}
                <div className="detail-customer"><div className="person-icon"><UserRound size={20}/></div><div><strong>{selectedOrder.customer_name}</strong><small>Khách hàng · {selectedOrder.conversation_id ?? 'Chưa có hội thoại'}</small></div><span className="muted-date">{time(selectedOrder.created_at)}</span></div>
                <div className="axis-grid" aria-label="Năm trạng thái độc lập"><Axis title="Hội thoại" label={conversationLabels[selectedOrder.conversation_state]}/><Axis title="Đơn hàng" label={orderLabels[selectedOrder.order_state]}/><Axis title="In giấy" label={selectedOrder.print_state==='VERIFIED_DONE' && selectedOrder.total_sheets!==null && (selectedOrder.verified_sheets===null || selectedOrder.verified_sheets < selectedOrder.total_sheets) ? 'Giấy thật chưa xác minh đủ' : printLabels[selectedOrder.print_state]} warn={printAttention || selectedOrder.print_state==='SIMULATED_DONE'}/><Axis title="Giao giấy" label={deliveryLabels[selectedOrder.delivery_state]}/><Axis title="Thanh toán" label={paymentLabels[selectedOrder.payment_state]}/></div>
                <div className="detail-tabs" role="tablist"><button role="tab" aria-selected={detailTab==='document'} className={detailTab==='document'?'on':''} onClick={()=>setDetailTab('document')}><FileText size={17}/> Tài liệu & duyệt</button><button role="tab" aria-selected={detailTab==='activity'} className={detailTab==='activity'?'on':''} onClick={()=>setDetailTab('activity')}><History size={17}/> Lịch sử ({selectedOrder.audit.length})</button></div>
                {detailTab==='activity' ? <div className="activity-content">{selectedOrder.audit.length === 0 ? <div className="empty-panel">Chưa có dữ liệu lịch sử từ API (không tự suy đoán).</div> : selectedOrder.audit.map((row,i)=><div className="activity" key={`${row.at}-${i}`}><span className="activity-dot"/><div><strong>{row.action}</strong><p>{row.summary}</p><small>{row.actor} · {time(row.at)}</small></div></div>)}</div> : <div className="detail-scroll">
                  <div className="section-head"><h3><FileText size={18}/> Tài liệu đính kèm</h3><span>{selectedOrder.documents.length} file</span></div>
                  {!useDemo && <VerifiedPreviewGallery key={`${selectedOrder.order_id}:${selectedOrder.revision}:${selectedOrder.request_hash}`} port={port} order={selectedOrder}/>}
                  {selectedOrder.documents.map(d=><div className="doc-box" key={d.document_id}><div className="doc-primary"><div className="file-icon"><FileText size={23}/></div><div className="doc-name"><strong>{d.filename}</strong><small>{d.format} · {d.paper} · {d.orientation==='portrait'?'Dọc':'Ngang'} · {d.duplex?'Hai mặt':'Một mặt'} · {d.copies} bản</small></div>{d.preview_trusted ? <span className="verified-label"><ShieldCheck size={15}/> Đã kiểm</span> : <span className="invalid-label"><AlertCircle size={15}/> Chưa tin cậy</span>}</div>
                    <div className="doc-stats"><div><span>Trang gốc</span><b>{d.pages ?? '—'}</b></div><div><span>Mặt in</span><b>{d.printed_faces ?? '—'}</b></div><div><span>Tờ giấy</span><b>{d.physical_sheets ?? '—'}</b></div></div>
                    <Preview url={d.preview_url} trusted={d.preview_trusted}/>{d.warnings.map((w,i)=><p className="inline-warning" key={i}><AlertCircle size={15}/> {w}</p>)}
                  </div>)}
                  {selectedOrder.documents.length===0 && <div className="empty-panel">API chưa cấp dữ liệu phân tách theo từng file; ảnh raster xác minh (nếu có) không phải bằng chứng khách đã xác nhận. Kế hoạch in tổng hợp: {selectedOrder.total_sheets??'chưa xác minh'} tờ; không dùng số này thay preview để duyệt.</div>}
                  {selectedOrder.warnings.length>0 && <div className="warnings"><strong><ShieldAlert size={17}/> Cảnh báo cần đọc</strong>{selectedOrder.warnings.map((w,i)=><p key={i}>• {w}</p>)}</div>}
                  <div className="section-head spaced"><h3><Wallet size={18}/> Giá & tiền</h3><span>Nhân viên xác nhận</span></div>
                  <div className="money-stats"><div><span>Giá đơn</span><strong>{money(selectedOrder.amount_vnd)}</strong></div><div><span>Đã nhận</span><strong>{money(selectedOrder.received_vnd)}</strong></div><div><span>Còn phải thu</span><strong className="accent-amount">{money(receivable(selectedOrder))}</strong></div></div>
                  {depositShortfall(selectedOrder)>0 && <div className="deposit-alert"><AlertCircle size={17}/><span>Chưa đủ cọc: thiếu <b>{money(depositShortfall(selectedOrder))}</b>. Nhân viên có quyền vẫn có thể duyệt sau khi xác nhận đã đọc cảnh báo.</span></div>}
                  <div className="forms-grid"><div className="input-group"><label htmlFor="amount">Giá mới / khoản tiền (VND)</label><input id="amount" inputMode="numeric" type="number" min="0" step="1" placeholder="Nhập số VND" value={value} onChange={e=>setValue(e.target.value)} disabled={busy}/></div><div className="input-group"><label htmlFor="paymentMethod">Phương thức nhận tiền</label><select id="paymentMethod" value={paymentMethod} onChange={e=>setPaymentMethod(e.target.value as 'cash'|'bank_transfer')} disabled={busy}><option value="cash">Tiền mặt</option><option value="bank_transfer">Chuyển khoản đã kiểm tra</option></select></div></div>
                  <div className="forms-grid" style={{marginTop: 12}}><div className="input-group"><label htmlFor="deposit">Yêu cầu đặt cọc (VND)</label><input id="deposit" inputMode="numeric" type="number" min="0" step="1" value={depositValue} onChange={e=>setDepositValue(e.target.value)} disabled={busy}/></div><label className="acknowledge"><input type="checkbox" checked={significantCost} onChange={e=>setSignificantCost(e.target.checked)} disabled={busy}/> Chi phí đáng kể — cần khách xác nhận giá</label></div>
                  <div className="action-row"><button className="outline-btn" disabled={busy||!canWork||printAttention} onClick={()=>submitAmount('quote')}><CreditCard size={16}/> Ghi giá nhân viên</button><button className="outline-btn" disabled={busy||!canWork} onClick={()=>submitAmount('payment')}><Wallet size={16}/> Ghi tiền thực nhận</button></div>
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
                {detailTab==='document' && <div className="approve-footer"><div className="approval-copy"><strong>Phê duyệt phiên bản {selectedOrder.revision}</strong><small>{selectedOrder.confirmed_revision===selectedOrder.revision?'Khách đã xác nhận đúng phiên bản':useDemo?'Khách chưa xác nhận phiên bản hiện tại':'API chưa cung cấp bằng chứng khách xác nhận'} · cần preview đủ tin cậy</small>
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
function Stat({ icon,label,value,note,color,onClick }: { icon: ReactNode; label: string; value: number; note: string; color: string; onClick:()=>void }) {
  return <button className="stat-card" onClick={onClick}><div className={`stat-icon ${color}`}>{icon}</div><span>{label}</span><strong>{value.toString().padStart(2,'0')}</strong><small>{note}</small></button>;
}
function Axis({title,label,warn=false}:{title:string;label:string;warn?:boolean}) {return <div className="axis-item"><span>{title}</span><strong className={warn?'warn-text':''}>{label}</strong></div>}
/** Preview is *only* a read-only staff aid. This never sets DocumentView.preview_trusted
 * and never changes hasValidApprovalInputs/confirmed_revision/order approval.
 * Object URLs are ephemeral, never persisted or placed in a request URL. */
function VerifiedPreviewGallery({port,order}:{port:PrintPort;order:OrderView}) {
  const [urls,setUrls]=useState<string[]>([]);
  const [facts,setFacts]=useState<VerifiedFileFact[]>([]);
  const [status,setStatus]=useState<'loading'|'verified'|'unavailable'>('loading');
  useEffect(()=>{
    let cancelled=false;
    const owned:string[]=[];
    setUrls([]);
    setFacts([]);
    setStatus('loading');
    void port.loadVerifiedPreviewPages(order).then(({pages,files})=>{
      if(cancelled) return;
      if(!pages.length){setStatus('unavailable');return;}
      for(const page of pages) owned.push(URL.createObjectURL(page));
      if(cancelled){owned.forEach(url=>URL.revokeObjectURL(url));return;}
      setFacts(files);
      setUrls([...owned]);
      setStatus('verified');
    }).catch(()=>{
      if(!cancelled){setFacts([]);setUrls([]);setStatus('unavailable');}
    });
    return ()=>{
      cancelled=true;
      owned.forEach(url=>URL.revokeObjectURL(url));
    };
  },[port,order.order_id,order.revision,order.request_hash]);
  return <section className="verified-previews" data-testid="verified-preview-gallery" aria-label="Ảnh xem trước đã xác minh">
    <strong><ShieldCheck size={15}/> Xem trước bản raster theo phiên bản {order.revision}</strong>
    {status==='loading' && <p role="status">Đang kiểm tra manifest, SHA-256 và quyền đọc ảnh…</p>}
    {status==='unavailable' && <p data-testid="preview-unavailable">Chưa thể xác minh đầy đủ ảnh xem trước. Không dùng ảnh thiếu tin cậy để duyệt in.</p>}
    {status==='verified' && facts.length>0 && <div className="verified-document-list" data-testid="verified-document-list">
      <h4>Thông số từng file do AI3 xác minh</h4>
      {facts.map(f=><div className="verified-document-row" data-testid="verified-document-row" key={f.index}>
        <div className="verified-document-title"><FileText size={16}/> <b>{f.label}</b> <small>{f.format}</small></div>
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
    {status==='verified' && facts.length===0 && <p data-testid="document-facts-unavailable">Chưa có thông số từng file đã được AI3 xác minh; không suy đoán số trang hoặc số tờ.</p>}
    {status==='verified' && <div className="verified-preview-grid">
      {urls.map((url,index)=><figure key={url}>
        <img data-testid="verified-preview-image" src={url} alt={`Ảnh xem trước đã xác minh, trang ${index+1}`} loading="lazy"/>
        <figcaption>Trang {index+1}/{urls.length} · đã kiểm tra SHA-256</figcaption>
      </figure>)}
    </div>}
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
  return <section className="settings-page"><p className="eyebrow">CẤU HÌNH VẬN HÀNH</p><h1>Cài đặt & lịch</h1><p className="subtext">Những chức năng chưa có API sẽ hiển thị chưa sẵn sàng, không tự lưu trên trình duyệt.</p>
    <div className="settings-grid"><div className="settings-box"><div className="setting-heading"><Clock3/><div><h3>Giờ hoạt động & ngày nghỉ</h3><p>Mặc định 07:00–21:30, múi giờ Việt Nam</p></div></div><p>Lịch ngoại lệ có thể nằm ngoài khung mặc định. Ngày nghỉ không gửi lệnh in thật, kể cả khi AI vẫn tư vấn.</p><button className="outline-btn" disabled>Chỉnh lịch — chờ API quyền</button></div>
    <div className="settings-box"><div className="setting-heading"><ShieldCheck/><div><h3>Chế độ vận hành</h3><p>{labelMode(mode)}</p></div></div><p>Chỉ chủ được mở chính thức sau nghiệm thu. Giao diện không tự thay chế độ máy chủ.</p><button className="outline-btn" disabled>Đổi chế độ — chưa có API</button></div>
    <div className="settings-box"><div className="setting-heading"><Bell/><div><h3>Thông báo thiết bị</h3><p>{permission==='unsupported'?'Trình duyệt chưa hỗ trợ':permission==='granted-no-subscription'?'Đã cấp quyền, chưa nối Web Push':permission==='permission-denied'?'Đã từ chối quyền':'Chưa cấp quyền thông báo'}</p></div></div><p>Web Push thật chưa được kết nối; thông báo sẽ mở đúng đơn sau khi có backend phát Push được xác thực.</p><button className="outline-btn" disabled={permission!=='needs-permission'} onClick={async()=>setPermission(await requestLocalNotifications())}>Yêu cầu quyền thiết bị</button></div>
    <div className="settings-box"><div className="setting-heading"><SlidersHorizontal/><div><h3>Quy tắc khách quen</h3><p>Quy tắc chỉ hiệu lực sau phê duyệt</p></div></div><p>Quy tắc khách, nhật ký sửa và phục hồi phiên bản đang chờ hợp đồng API.</p><button className="outline-btn" disabled>Quản lý quy tắc — chờ API</button></div></div>
    <div className="account-box"><span><UserRound size={19}/>{session?.display_name??'Chưa có tài khoản'} · {session?.role==='owner'?'Chủ':'Nhân viên'}</span><button className="outline-btn" onClick={onLogout}><LogOut size={16}/> Đăng xuất</button></div>
  </section>;
}
export default App;