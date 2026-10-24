import { useMemo, useReducer, type Dispatch, type SetStateAction } from 'react';
import type { OrderView, StaffSession } from './domain.ts';
import type { InboundReviewItem } from './inbound-review.ts';
import { classifySessionFailure, type SessionRequestScope } from './session-request.ts';

/** Data that must leave the staff UI together when its authenticated session ends. */
export interface StaffSessionUiState {
  session: StaffSession | null;
  orders: OrderView[];
  selected: string | null;
  inboundItems: InboundReviewItem[] | null;
}

export const initialStaffSessionUiState: StaffSessionUiState = {
  session: null, orders: [], selected: null, inboundItems: null,
};

export type StaffSessionUiAction =
  | { type: 'session'; value: SetStateAction<StaffSession | null> }
  | { type: 'orders'; value: SetStateAction<OrderView[]> }
  | { type: 'selected'; value: SetStateAction<string | null> }
  | { type: 'inbound-items'; value: SetStateAction<InboundReviewItem[] | null> }
  | { type: 'clear' }
  | { type: 'request-401'; expected: SessionRequestScope; current: SessionRequestScope };

const apply = <T,>(previous: T, value: SetStateAction<T>): T =>
  typeof value === 'function' ? (value as (previous: T) => T)(previous) : value;

const cleared = (state: StaffSessionUiState): StaffSessionUiState => ({
  ...state, session: null, orders: [], selected: null, inboundItems: null,
});

export function staffSessionUiReducer(state: StaffSessionUiState, action: StaffSessionUiAction): StaffSessionUiState {
  switch (action.type) {
    case 'session': return { ...state, session: apply(state.session, action.value) };
    case 'orders': return { ...state, orders: apply(state.orders, action.value) };
    case 'selected': return { ...state, selected: apply(state.selected, action.value) };
    case 'inbound-items': return { ...state, inboundItems: apply(state.inboundItems, action.value) };
    case 'clear': return cleared(state);
    case 'request-401':
      return classifySessionFailure(401, action.expected, action.current) === 'unauthorized' ? cleared(state) : state;
  }
}

function actions(dispatch: Dispatch<StaffSessionUiAction>) {
  return {
    setSession: (value: SetStateAction<StaffSession | null>) => dispatch({ type: 'session', value }),
    setOrders: (value: SetStateAction<OrderView[]>) => dispatch({ type: 'orders', value }),
    setSelected: (value: SetStateAction<string | null>) => dispatch({ type: 'selected', value }),
    setInboundItems: (value: SetStateAction<InboundReviewItem[] | null>) => dispatch({ type: 'inbound-items', value }),
    clearSession: () => dispatch({ type: 'clear' }),
    clearAfter401: (expected: SessionRequestScope, current: SessionRequestScope) =>
      dispatch({ type: 'request-401', expected, current }),
  };
}

export function useStaffSessionUiState() {
  const [state, dispatch] = useReducer(staffSessionUiReducer, initialStaffSessionUiState);
  const setters = useMemo(() => actions(dispatch), [dispatch]);
  return { ...state, ...setters };
}
