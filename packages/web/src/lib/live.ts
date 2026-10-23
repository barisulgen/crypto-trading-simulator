// The live store (zustand) and the WebSocket client that feeds it.
import { create } from 'zustand';
import { api, ApiError, onUnauthorized } from './api.ts';
import type {
  AccountSnapshot,
  Candle,
  HealthMap,
  Interval,
  Meta,
  NoticeMessage,
  ServerMessage,
  Ticker,
  WireAggTrade,
  WireLevel,
  WireOrder,
} from './api.ts';
import { setRules } from './format.ts';

const TRADES_KEPT = 100;
/** An identical notice text arriving within this window bumps the earlier toast's count instead. */
const NOTICE_COLLAPSE_MS = 1000;
/** Notices kept in the store (oldest dropped first). */
const NOTICES_KEPT = 50;
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 10_000;
/** The backoff starts over only after a connection stayed open this long (no fast flapping). */
const STABLE_OPEN_MS = 5000;
/** The server pushes tickers every second: a socket silent this long is dead, whatever it claims. */
const SILENT_MS = 5000;
/** While exchange rules are missing for some symbol, /api/meta is asked again at most this often. */
const META_RETRY_MS = 5000;

export interface Notice {
  id: number;
  kind: NoticeMessage['kind'] | 'local';
  level: NoticeMessage['level'];
  text: string;
  /** When it (or its latest identical copy) arrived, ms. */
  at: number;
  /** How many identical copies arrived in quick succession. */
  count: number;
}

export interface Selection {
  symbol: string;
  market: 'spot';
}

/** The state the reducer touches (everything the server sends). */
export interface LiveData {
  tickers: Record<string, Ticker>;
  /** Top of the book of the selected symbol. */
  book: { symbol: string; bids: WireLevel[]; asks: WireLevel[] } | null;
  /** Recent trades of the selected symbol, newest first. */
  trades: WireAggTrade[];
  /** Latest kline of the selected symbol and interval. */
  kline: { symbol: string; interval: Interval; candle: Candle } | null;
  health: HealthMap;
  account: AccountSnapshot | null;
  /** Open orders, newest first. */
  orders: WireOrder[];
  notices: Notice[];
  noticeSeq: number;
  /**
   * Bumped whenever fills may have changed, so views showing fills know to reload them: every
   * fill or partial-fill notice, a change in the open orders (ids, status, filled quantity) and a
   * change in wallet balances. Not bumped by the 1 s account push when only prices moved.
   */
  fillSeq: number;
  selected: Selection;
  interval: Interval;
}

export type Connection = 'connecting' | 'open' | 'down';

export interface LiveState extends LiveData {
  meta: Meta | null;
  /** The WebSocket to our own server. */
  conn: Connection;
  /** LAN password mode and no session: show the login screen. */
  needsLogin: boolean;
  /** Times our WebSocket opened again after the first connection (views reload what they may have missed). */
  reconnects: number;
  /** The last order-book price the owner clicked (the order form prefills its limit price); `seq` changes on every click. */
  priceClick: { price: string; seq: number } | null;
  select(symbol: string): void;
  setInterval(interval: Interval): void;
  setAccount(account: AccountSnapshot): void;
  pushNotice(level: Notice['level'], text: string): void;
  dismissNotice(id: number): void;
  priceClicked(price: string): void;
}

export function initialLiveData(): LiveData {
  return {
    tickers: {},
    book: null,
    trades: [],
    kline: null,
    health: {},
    account: null,
    orders: [],
    notices: [],
    noticeSeq: 0,
    fillSeq: 0,
    selected: { symbol: 'BTCUSDT', market: 'spot' },
    interval: '15m',
  };
}

function addNotice(
  s: Pick<LiveData, 'notices' | 'noticeSeq'>,
  n: Pick<Notice, 'kind' | 'level' | 'text'>,
  now: number,
): Pick<LiveData, 'notices' | 'noticeSeq'> {
  const same = s.notices.findLastIndex((x) => x.text === n.text && x.level === n.level);
  const prev = s.notices[same];
  // Errors stay until dismissed, so a repeat of one still on screen is folded into it, however late.
  if (prev && (prev.level === 'error' || now - prev.at < NOTICE_COLLAPSE_MS)) {
    const notices = [...s.notices];
    notices[same] = { ...prev, at: now, count: prev.count + 1 };
    return { notices, noticeSeq: s.noticeSeq };
  }
  const id = s.noticeSeq + 1;
  return { notices: [...s.notices, { id, ...n, at: now, count: 1 }].slice(-NOTICES_KEPT), noticeSeq: id };
}

/** Merge new trades into the list: newest first by trade id, no duplicates, at most TRADES_KEPT. */
function mergeTrades(current: WireAggTrade[], incoming: WireAggTrade[]): WireAggTrade[] {
  const byId = new Map<number, WireAggTrade>();
  for (const t of current) byId.set(t.id, t);
  for (const t of incoming) byId.set(t.id, t);
  return [...byId.values()].sort((a, b) => b.id - a.id).slice(0, TRADES_KEPT);
}

/** Open orders as far as fills are concerned: which ones, their status and filled quantity. */
function ordersKey(orders: WireOrder[]): string {
  return orders
    .map((o) => `${o.id}:${o.status}:${o.filledQty}`)
    .sort()
    .join('|');
}

/** Wallet balances only (prices and totals move every second; balances move on fills, deposits, locks). */
function balancesKey(a: AccountSnapshot): string {
  return JSON.stringify(a.balances);
}

/** What one server message changes. Pure: `now` is the arrival time. */
export function reduce(s: LiveData, msg: ServerMessage, now: number): Partial<LiveData> {
  switch (msg.type) {
    case 'tickers':
      return { tickers: msg.tickers };
    case 'health':
      return { health: msg.health };
    case 'account': {
      const moved = s.account !== null && balancesKey(s.account) !== balancesKey(msg.account);
      return moved ? { account: msg.account, fillSeq: s.fillSeq + 1 } : { account: msg.account };
    }
    case 'orders': {
      const moved = ordersKey(s.orders) !== ordersKey(msg.orders);
      return moved ? { orders: msg.orders, fillSeq: s.fillSeq + 1 } : { orders: msg.orders };
    }
    case 'notice': {
      const notices = addNotice(s, { kind: msg.kind, level: msg.level, text: msg.text }, now);
      const filled = msg.kind === 'fill' || msg.kind === 'partial_fill';
      return filled ? { ...notices, fillSeq: s.fillSeq + 1 } : notices;
    }
    case 'error':
      return addNotice(s, { kind: 'local', level: 'error', text: msg.error }, now);
    case 'book':
      if (msg.symbol !== s.selected.symbol) return {};
      return { book: { symbol: msg.symbol, bids: msg.bids, asks: msg.asks } };
    case 'trades':
      if (msg.symbol !== s.selected.symbol) return {};
      return { trades: mergeTrades(s.trades, msg.trades) };
    case 'kline':
      if (msg.symbol !== s.selected.symbol || msg.interval !== s.interval) return {};
      return { kline: { symbol: msg.symbol, interval: msg.interval, candle: msg.candle } };
    default:
      return {};
  }
}

export const useLive = create<LiveState>()((set) => ({
  ...initialLiveData(),
  meta: null,
  conn: 'connecting',
  needsLogin: false,
  reconnects: 0,
  priceClick: null,
  select(symbol) {
    set((s) =>
      s.selected.symbol === symbol ? {} : { selected: { symbol, market: 'spot' }, book: null, trades: [], kline: null },
    );
    subscribe();
  },
  setInterval(interval) {
    set((s) => (s.interval === interval ? {} : { interval, kline: null }));
    subscribe();
  },
  setAccount(account) {
    set({ account });
  },
  pushNotice(level, text) {
    set((s) => addNotice(s, { kind: 'local', level, text }, Date.now()));
  },
  dismissNotice(id) {
    set((s) => ({ notices: s.notices.filter((n) => n.id !== id) }));
  },
  priceClicked(price) {
    set((s) => ({ priceClick: { price, seq: (s.priceClick?.seq ?? 0) + 1 } }));
  },
}));

// ---- WebSocket client ----

let socket: WebSocket | null = null;
let retryDelay = RETRY_MIN_MS;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
/** When the current socket opened, ms; null while not open. */
let openedAt: number | null = null;
let started = false;
/** Whether any socket has opened yet (the next open is then a reconnect). */
let everOpened = false;
/** Fires when the current socket has sent nothing for SILENT_MS. */
let silenceTimer: ReturnType<typeof setTimeout> | null = null;
/** When /api/meta was last asked for, ms. */
let metaAskedAt = 0;

function subscribe(): void {
  if (socket?.readyState !== WebSocket.OPEN) return;
  const { selected, interval } = useLive.getState();
  socket.send(JSON.stringify({ type: 'subscribe', symbol: selected.symbol, interval }));
}

/** Load /api/meta (coins, rules, fees, season) into the store and the formatters. */
export async function loadMeta(): Promise<void> {
  metaAskedAt = Date.now();
  try {
    const meta = await api.meta();
    setRules(meta.rules);
    useLive.setState({ meta });
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 401) {
      useLive.getState().pushNotice('error', `Could not load market rules: ${(e as Error).message}`);
    }
  }
}

/** Whether the loaded meta lacks rules for a configured symbol (or is not loaded at all). */
function rulesMissing(): boolean {
  const meta = useLive.getState().meta;
  return !meta || Object.keys(meta.rules).length < meta.symbols.length;
}

function clearSilence(): void {
  if (silenceTimer !== null) clearTimeout(silenceTimer);
  silenceTimer = null;
}

/** Forget a socket without waiting for its close event (a dead one may never send it). */
function detach(ws: WebSocket): void {
  ws.onopen = ws.onmessage = ws.onclose = null;
  try {
    ws.close();
  } catch {
    // already gone
  }
  if (socket === ws) socket = null;
  clearSilence();
  openedAt = null;
}

function armSilence(ws: WebSocket): void {
  clearSilence();
  silenceTimer = setTimeout(() => {
    silenceTimer = null;
    if (socket !== ws) return;
    detach(ws);
    useLive.setState({ conn: 'down' });
    scheduleReconnect();
  }, SILENT_MS);
}

function scheduleReconnect(): void {
  if (retryTimer !== null) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    connect();
  }, retryDelay);
  retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
}

/** A socket that never opened may have been refused for want of a session: ask the REST API. */
async function needsLogin(): Promise<boolean> {
  try {
    await api.meta();
    return false;
  } catch (e) {
    return e instanceof ApiError && e.status === 401;
  }
}

function connect(): void {
  if (socket !== null || useLive.getState().needsLogin) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  socket = ws;
  let opened = false;
  ws.onopen = () => {
    opened = true;
    openedAt = Date.now();
    useLive.setState((s) => ({ conn: 'open', reconnects: everOpened ? s.reconnects + 1 : s.reconnects }));
    everOpened = true;
    subscribe();
    armSilence(ws);
    if (rulesMissing()) void loadMeta();
  };
  ws.onmessage = (ev: MessageEvent<string>) => {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(ev.data) as ServerMessage;
    } catch {
      return;
    }
    armSilence(ws);
    useLive.setState((s) => reduce(s, msg, Date.now()));
    // Rules the server had not loaded at start arrive later: ask again as health messages come in.
    if (msg.type === 'health' && rulesMissing() && Date.now() - metaAskedAt >= META_RETRY_MS) void loadMeta();
  };
  ws.onclose = () => {
    if (socket === ws) socket = null;
    clearSilence();
    // Only a connection that held for a while resets the backoff: accept-then-drop keeps doubling.
    if (openedAt !== null && Date.now() - openedAt >= STABLE_OPEN_MS) retryDelay = RETRY_MIN_MS;
    openedAt = null;
    useLive.setState({ conn: 'down' });
    if (opened) return scheduleReconnect();
    void needsLogin().then((login) => {
      if (!login) scheduleReconnect();
    });
  };
}

/** Reconnect now (network back, or after logging in) instead of waiting out the backoff. */
export function reconnectNow(): void {
  // A socket that is not open (stuck connecting, closing, or dead) is replaced, not trusted.
  if (socket !== null && socket.readyState !== WebSocket.OPEN) {
    detach(socket);
    useLive.setState({ conn: 'down' });
  }
  if (retryTimer !== null) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  retryDelay = RETRY_MIN_MS;
  connect();
}

/** Start the live connection once (idempotent). */
export function startLive(): void {
  if (started) return;
  started = true;
  onUnauthorized(() => useLive.setState({ needsLogin: true }));
  void loadMeta();
  connect();
  window.addEventListener('online', reconnectNow);
}

/** After a successful login: reload the data and reconnect. */
export function afterLogin(): void {
  useLive.setState({ needsLogin: false });
  void loadMeta();
  reconnectNow();
}
