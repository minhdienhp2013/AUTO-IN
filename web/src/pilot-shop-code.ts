import { createElement as h, useCallback, useEffect, useRef, useState } from 'react';
import { orderLabels, printLabels, type OrderView, type StaffSession } from './domain.ts';

/** UI mirror of the authenticated display DTO in the locked AI0 pilot wire. */
export interface PilotShopCodeDisplay {
  readonly schema: 'ai0.pilot_shop_code_display.v1';
  readonly shop_id: string;
  readonly code: string;
  readonly expires_at: string;
  readonly server_time: string;
}

/** Port boundary; the browser displays only a value returned by the server. */
export interface PilotShopCodePort {
  loadCurrentShopCode(): Promise<PilotShopCodeDisplay>;
}

export type PilotShopCodeState =
  | { status: 'loading' }
  | { status: 'unauthenticated' }
  | { status: 'session-expired' }
  | { status: 'expired' }
  | { status: 'unavailable' }
  | { status: 'ready'; display: PilotShopCodeDisplay; receivedAt: number; remainingAtReceiptMs: number };

const MAX_CODE_WINDOW_MS = 30 * 60 * 1000;
const SHOP_CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{10}$/;
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const isUtcTimestamp = (value: unknown): value is string =>
  typeof value === 'string' && value.endsWith('Z') && Number.isFinite(Date.parse(value));

export function parsePilotShopCodeDisplay(value: unknown): PilotShopCodeDisplay | null {
  const raw = object(value);
  if (raw.schema !== 'ai0.pilot_shop_code_display.v1' ||
      typeof raw.shop_id !== 'string' || !raw.shop_id ||
      typeof raw.code !== 'string' || !SHOP_CODE_PATTERN.test(raw.code) ||
      !isUtcTimestamp(raw.expires_at) || !isUtcTimestamp(raw.server_time)) return null;
  const lifetime = Date.parse(raw.expires_at) - Date.parse(raw.server_time);
  if (lifetime <= 0 || lifetime > MAX_CODE_WINDOW_MS) return null;
  return {
    schema: 'ai0.pilot_shop_code_display.v1',
    shop_id: raw.shop_id,
    code: raw.code,
    expires_at: raw.expires_at,
    server_time: raw.server_time,
  };
}

function faultStatus(error: unknown): number | null {
  const value = object(error).status;
  return typeof value === 'number' ? value : null;
}

/** No persistence: the code lives only in the authenticated view's memory. */
export async function loadPilotShopCode(
  port: PilotShopCodePort,
  session: StaffSession | null,
  authenticatedShopId: string | null,
  monotonicNow: () => number = () => performance.now(),
): Promise<PilotShopCodeState> {
  if (!session || !['staff', 'owner'].includes(session.role) || !authenticatedShopId) {
    return { status: 'unauthenticated' };
  }
  const requestStartedAt = monotonicNow();
  try {
    const display = parsePilotShopCodeDisplay(await port.loadCurrentShopCode());
    const receivedAt = monotonicNow();
    if (!display || display.shop_id !== authenticatedShopId) return { status: 'unavailable' };
    const lifetime = Date.parse(display.expires_at) - Date.parse(display.server_time);
    const remainingAtReceiptMs = lifetime - Math.max(0, receivedAt - requestStartedAt);
    if (remainingAtReceiptMs <= 0) return { status: 'expired' };
    return { status: 'ready', display, receivedAt, remainingAtReceiptMs };
  } catch (error) {
    return faultStatus(error) === 401 ? { status: 'session-expired' } : { status: 'unavailable' };
  }
}

const formatTimestamp = (value: string) => new Date(value).toLocaleString('vi-VN', {
  day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
});

export function PilotShopCodePanelView({
  authenticatedStaff, apiHealthy, state, orders, remainingMs, onRefresh, refreshing = false,
}: {
  authenticatedStaff: boolean;
  apiHealthy: boolean;
  state: PilotShopCodeState;
  orders: readonly OrderView[];
  remainingMs: number | null;
  onRefresh: () => void;
  refreshing?: boolean;
}) {
  if (!authenticatedStaff) return h('section', { className: 'pilot-code-page', 'data-testid': 'pilot-code-page' },
    h('h1', null, 'Mã cửa hàng'),
    h('p', { role: 'alert', 'data-testid': 'pilot-code-locked' }, 'Đăng nhập nhân viên để xem mã cửa hàng.'));

  // Order read-model health is independent from the shop-code route: a failed
  // order refresh hides old orders without masking a fresh authenticated code.
  const visibleState = state;
  let codeContent;
  if (visibleState.status === 'ready') {
    const seconds = Math.max(0, Math.ceil((remainingMs ?? 0) / 1000));
    codeContent = h('div', { className: 'pilot-code-value', 'data-testid': 'pilot-code-ready' },
      h('span', { className: 'pilot-code-label' }, 'Mã hiện hành do máy chủ cấp'),
      // React renders this as escaped text; never interpret the server value as markup.
      h('code', { 'data-testid': 'pilot-code-value' }, visibleState.display.code),
      h('p', null, 'Đổi mã lúc ', h('time', { dateTime: visibleState.display.expires_at, 'data-testid': 'pilot-code-expiry' }, formatTimestamp(visibleState.display.expires_at))),
      h('small', { 'data-testid': 'pilot-code-countdown' }, `Còn khoảng ${Math.floor(seconds / 60)} phút ${seconds % 60} giây · tính theo giờ máy chủ.`));
  } else if (visibleState.status === 'loading') {
    codeContent = h('p', { role: 'status', 'data-testid': 'pilot-code-loading' }, 'Đang tải mã hiện hành từ máy chủ…');
  } else if (visibleState.status === 'session-expired') {
    codeContent = h('p', { role: 'alert', 'data-testid': 'pilot-code-unavailable' }, 'Phiên đăng nhập hết hạn. Đăng nhập lại để xem mã; mã cũ đã được ẩn.');
  } else if (visibleState.status === 'expired') {
    codeContent = h('p', { role: 'status', 'data-testid': 'pilot-code-unavailable' }, 'Mã đã hết hạn. Đang yêu cầu mã hiện hành từ máy chủ…');
  } else if (visibleState.status === 'unauthenticated') {
    codeContent = h('p', { role: 'alert', 'data-testid': 'pilot-code-locked' }, 'Đăng nhập nhân viên để xem mã cửa hàng.');
  } else {
    codeContent = h('p', { role: 'alert', 'data-testid': 'pilot-code-unavailable' }, 'Chưa xác minh được mã hiện hành. Mã cũ đã được ẩn; cần nhân viên kiểm tra kết nối.');
  }

  const statusContent = !apiHealthy
    ? h('p', { role: 'alert', 'data-testid': 'pilot-orders-unknown' }, 'Chưa xác minh được read model. Trạng thái đơn hiện là UNKNOWN; cần nhân viên kiểm tra.')
    : orders.length === 0
      ? h('p', { className: 'pilot-code-empty', 'data-testid': 'pilot-orders-empty' }, 'Máy chủ chưa trả đơn nào trong danh sách hiện tại.')
      : h('div', { className: 'pilot-order-list', 'data-testid': 'pilot-order-list' },
        ...orders.map(order => h('article', { className: 'pilot-order-card', key: order.order_id, 'data-testid': 'pilot-order' },
          h('div', { className: 'pilot-order-heading' },
            h('strong', null, order.order_id),
            h('span', { className: order.print_state === 'UNKNOWN' ? 'pilot-order-unknown' : 'pilot-order-state', 'data-testid': 'pilot-print-state' }, order.print_state)),
          h('p', null, 'Đơn: ', orderLabels[order.order_state]),
          h('p', null, 'Lệnh in: ', printLabels[order.print_state]),
          order.print_state === 'UNKNOWN' ? h('small', null, 'Cần nhân viên đối soát; không tự gửi lại lệnh.') : null)));

  return h('section', { className: 'pilot-code-page', 'data-testid': 'pilot-code-page', 'aria-labelledby': 'pilot-code-title' },
    h('header', { className: 'pilot-code-heading' },
      h('div', null,
        h('p', { className: 'eyebrow' }, 'V1 PILOT · NHÂN VIÊN'),
        h('h1', { id: 'pilot-code-title' }, 'Mã cửa hàng'),
        h('p', { className: 'subtext' }, 'Khách gửi mã cùng Word/PDF gốc và thông số qua Zalo OA. Core xác minh dữ liệu trước khi cấp lệnh.')),
      h('button', { className: 'outline-btn', type: 'button', disabled: refreshing, onClick: onRefresh, 'data-testid': 'pilot-code-refresh' }, refreshing ? 'Đang làm mới…' : 'Làm mới')),
    h('div', { className: 'pilot-code-safety' }, 'Mã chỉ hiển thị trong phiên nhân viên đã xác thực. Máy chủ là nguồn mã duy nhất; trình duyệt không tạo hoặc lưu mã vào bộ nhớ lâu dài.'),
    h('section', { className: 'pilot-code-card', 'aria-label': 'Mã shop hiện hành' }, codeContent),
    h('section', { className: 'pilot-order-status', 'aria-labelledby': 'pilot-order-status-title' },
      h('div', { className: 'pilot-order-status-heading' },
        h('div', null, h('h2', { id: 'pilot-order-status-title' }, 'Trạng thái đơn'),
          h('p', null, 'Trạng thái chỉ lấy từ read model hiện hành của máy chủ.'))),
      statusContent));
}

export function PilotShopCodePanel({
  port, session, authenticatedShopId, apiHealthy, orders, onUnauthorized, onRefreshOrders,
}: {
  port: PilotShopCodePort;
  session: StaffSession | null;
  authenticatedShopId: string | null;
  apiHealthy: boolean;
  orders: readonly OrderView[];
  onUnauthorized: () => void;
  onRefreshOrders: () => void;
}) {
  const authenticatedStaff = Boolean(session && ['staff', 'owner'].includes(session.role) && authenticatedShopId);
  const [state, setState] = useState<PilotShopCodeState>({ status: 'loading' });
  const [remainingMs, setRemainingMs] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const requestEpoch = useRef(0);

  const refresh = useCallback(async () => {
    const epoch = ++requestEpoch.current;
    setRemainingMs(null);
    if (!authenticatedStaff) { setState({ status: 'unauthenticated' }); setRefreshing(false); return; }
    setState({ status: 'loading' });
    setRefreshing(true);
    const next = await loadPilotShopCode(port, session, authenticatedShopId);
    if (requestEpoch.current !== epoch) return;
    setState(next);
    setRefreshing(false);
    if (next.status === 'ready') setRemainingMs(next.remainingAtReceiptMs);
    if (next.status === 'session-expired') onUnauthorized();
  }, [authenticatedShopId, authenticatedStaff, onUnauthorized, port, session]);

  useEffect(() => {
    void refresh();
    return () => { requestEpoch.current++; };
  }, [refresh]);

  useEffect(() => {
    if (state.status !== 'ready') return;
    const tick = () => {
      const next = state.remainingAtReceiptMs - (performance.now() - state.receivedAt);
      if (next <= 0) {
        setRemainingMs(0);
        setState({ status: 'expired' });
        void refresh();
      } else setRemainingMs(next);
    };
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [refresh, state]);

  const handleRefresh = () => { onRefreshOrders(); void refresh(); };
  return h(PilotShopCodePanelView, {
    authenticatedStaff,
    apiHealthy,
    state,
    orders,
    remainingMs,
    refreshing,
    onRefresh: handleRefresh,
  });
}
