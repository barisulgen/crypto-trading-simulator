// The live store (zustand) and the WebSocket client that feeds it.
import { create } from 'zustand';
import { api, ApiError, onUnauthorized } from './api.ts';
import type {
  AccountSnapshot,
  Candle,
  HealthMap,
  Interval,
  LiquidationDetail,
  Market,
  MarketHealth,
  Meta,
  NoticeMessage,
  PerpMark,
  ServerMessage,
  Ticker,
  WireAggTrade,
  WireLevel,
  WireOrder,
  WirePerpOrder,
  WirePerpRules,
  WirePosition,
} from './api.ts';
import { setPerpRules, setRules } from './format.ts';
import { bannerEntries } from './positions.ts';
import type { BannerEntry } from './positions.ts';

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
  /** On a liquidation notice: its figures as data. */
  liquidation?: LiquidationDetail;
}

/** The coin and market (spot or its USD-margined perpetual) the trade screen shows. */
export interface Selection {
  symbol: string;
  market: Market;
}

/** The state the reducer touches (everything the server sends). */
export interface LiveData {
  /** Spot 24 h tickers. */
  tickers: Record<string, Ticker>;
  /** Futures 24 h tickers (the perpetual's own last price and change). */
  perpTickers: Record<string, Ticker>;
  /** Top of the book of the selected market and symbol. */
  book: { market: Market; symbol: string; bids: WireLevel[]; asks: WireLevel[] } | null;
  /** Recent trades of the selected market and symbol, newest first. */
  trades: WireAggTrade[];
  /** Latest kline of the selected market, symbol and interval. */
  kline: { market: Market; symbol: string; interval: Interval; candle: Candle } | null;
  /** Spot feed health by symbol. */
  health: HealthMap;
  /** Feed health of every market and symbol, keyed 'spot:BTCUSDT' / 'perp:BTCUSDT'. */
  markets: MarketHealth;
  /** The market keys whose data is catching up after a gap. */
  catchingUp: string[];
  /** Perp mark price, index price and funding by symbol. */
  marks: Record<string, PerpMark>;
  /** Open perp positions; null until the server has sent them. */
  positions: WirePosition[] | null;
  account: AccountSnapshot | null;
  /** Open spot orders, newest first. */
  orders: WireOrder[];
  /** Open perp orders, newest first. */
  perpOrders: WirePerpOrder[];
  notices: Notice[];
  noticeSeq: number;
  /**
   * Liquidation notices not yet acknowledged, oldest first. Kept apart from `notices`, whose cap
   * could drop one before its alert has been seen.
   */
  liquidationQueue: Notice[];
  /**
   * The margin warning banner: each position near liquidation at its last live level (see
   * bannerEntries). Held here, not in the banner, so a level held over a stale mark survives a
   * remount of the screen.
   */
  banner: BannerEntry[];
  /**
   * Bumped whenever fills may have changed, so views showing fills know to reload them: every
   * fill, partial-fill, liquidation or catch-up notice, a change in the open orders of either
   * market (ids, status, filled quantity) and a change in wallet balances. Not bumped by the 1 s
   * account push when only prices moved.
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
  /** Why the session ended ('Session expired; log in again'); empty on a first visit. */
  loginNotice: string;
  /** Times our WebSocket opened again after the first connection (views reload what they may have missed). */
  reconnects: number;
  /** The last order-book price the owner clicked (the order form prefills its limit price); `seq` changes on every click. */
  priceClick: { price: string; seq: number } | null;
  /** Show `symbol` in `market` (default: the market shown now). */
  select(symbol: string, market?: Market): void;
  setInterval(interval: Interval): void;
  setAccount(account: AccountSnapshot): void;
  pushNotice(level: Notice['level'], text: string): void;
  dismissNotice(id: number): void;
  /** The owner has seen the liquidation alert of notice `id` (the notice itself stays). */
  acknowledgeLiquidation(id: number): void;
  priceClicked(price: string): void;
}

export function initialLiveData(): LiveData {
  return {
    tickers: {},
    perpTickers: {},
    book: null,
    trades: [],
    kline: null,
    health: {},
    markets: {},
    catchingUp: [],
    marks: {},
    positions: null,
    account: null,
    orders: [],
    perpOrders: [],
    notices: [],
    noticeSeq: 0,
    liquidationQueue: [],
    banner: [],
    fillSeq: 0,
    selected: { symbol: 'BTCUSDT', market: 'spot' },
    interval: '15m',
  };
}

function addNotice(
  s: Pick<LiveData, 'notices' | 'noticeSeq'>,
  n: Pick<Notice, 'kind' | 'level' | 'text' | 'liquidation'>,
  now: number,
): Pick<LiveData, 'notices' | 'noticeSeq'> {
  // A liquidation is never folded into another: each one is shown, and alerted, on its own.
  const same = n.kind === 'liquidation' ? -1 : s.notices.findLastIndex((x) => x.text === n.text && x.level === n.level);
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
function ordersKey(orders: (WireOrder | WirePerpOrder)[]): string {
  return orders
    .map((o) => `${o.id}:${o.status}:${o.filledQty}`)
    .sort()
    .join('|');
}

/** Wallet balances only (prices and totals move every second; balances move on fills, deposits, locks). */
function balancesKey(a: AccountSnapshot): string {
  return JSON.stringify(a.balances);
}

/** Notices after which the owner's fills (or the chart's fill and liquidation markers) may have changed. */
const FILL_NOTICES: ReadonlySet<NoticeMessage['kind']> = new Set(['fill', 'partial_fill', 'liquidation', 'catch_up']);

/**
 * What showing `next` changes: nothing when it is shown already; otherwise the book, trades and
 * kline of the previous market and coin are dropped, so none of them is ever shown as the new one's.
 */
export function selectionChange(s: Pick<LiveData, 'selected'>, next: Selection): Partial<LiveData> {
  if (s.selected.symbol === next.symbol && s.selected.market === next.market) return {};
  return { selected: { symbol: next.symbol, market: next.market }, book: null, trades: [], kline: null };
}

/**
 * The feed health of one market's symbol: spot from the per-symbol health, perp from the
 * per-market one; undefined until the server has said.
 */
export function feedOf(
  s: Pick<LiveData, 'health' | 'markets'>,
  market: Market,
  symbol: string,
): { fresh: boolean; reason: string | null } | undefined {
  return market === 'spot' ? s.health[symbol] : s.markets[`perp:${symbol}`];
}

/**
 * A feed's state as the owner is shown it: live; catching up (fresh again, but the gap's history is
 * still being applied, so trading on it waits); interrupted (no fresh data); or not reported yet.
 */
export type FeedState = 'live' | 'catching_up' | 'interrupted' | 'unknown';

const MARKETS: readonly Market[] = ['spot', 'perp'];

/**
 * The state of one market's symbol. Health comes from the per-market map (spot falls back to the
 * per-symbol one); catching up from the list of keys catching up or either map's flag. A feed that
 * is not fresh is interrupted, whatever catch-up is pending.
 */
export function feedStatus(
  s: Pick<LiveData, 'health' | 'markets' | 'catchingUp'>,
  market: Market,
  symbol: string,
): { state: FeedState; reason: string | null } {
  const key = `${market}:${symbol}`;
  const spot = market === 'spot' ? s.health[symbol] : undefined;
  const h = s.markets[key] ?? spot;
  if (h && !h.fresh) return { state: 'interrupted', reason: h.reason };
  if (s.catchingUp.includes(key) || s.markets[key]?.catchingUp === true || spot?.catchingUp === true) {
    return { state: 'catching_up', reason: null };
  }
  return h ? { state: 'live', reason: null } : { state: 'unknown', reason: null };
}

export interface FeedSummary {
  /** Every feed: both markets of every coin. */
  feeds: number;
  /** Feeds the server has reported on. */
  known: number;
  interrupted: number;
  catchingUp: number;
}

/** How many of the coins' spot and perp feeds are interrupted or catching up. */
export function feedSummary(s: Pick<LiveData, 'health' | 'markets' | 'catchingUp'>, symbols: readonly string[]): FeedSummary {
  const out: FeedSummary = { feeds: symbols.length * MARKETS.length, known: 0, interrupted: 0, catchingUp: 0 };
  for (const symbol of symbols) {
    for (const market of MARKETS) {
      const { state } = feedStatus(s, market, symbol);
      if (state !== 'unknown') out.known += 1;
      if (state === 'interrupted') out.interrupted += 1;
      if (state === 'catching_up') out.catchingUp += 1;
    }
  }
  return out;
}

/** The feeds catching up now, in coin order, spot before perp. */
export function catchingUpFeeds(s: Pick<LiveData, 'health' | 'markets' | 'catchingUp'>, symbols: readonly string[]): Selection[] {
  const out: Selection[] = [];
  for (const symbol of symbols) {
    for (const market of MARKETS) if (feedStatus(s, market, symbol).state === 'catching_up') out.push({ symbol, market });
  }
  return out;
}

/**
 * Why a transfer out of the leverage wallet is off now, or null: while any perpetual catches up, or
 * while one with a position or open orders has stale data (its feed interrupted or its mark stale),
 * the server refuses it (409), since that catch-up may still charge funding or margin to the wallet.
 */
export function leverageTransferBlock(
  s: Pick<LiveData, 'health' | 'markets' | 'catchingUp' | 'positions' | 'perpOrders'>,
): string | null {
  const perps = new Set([
    ...Object.keys(s.markets).filter((k) => k.startsWith('perp:')).map((k) => k.slice(5)),
    ...s.catchingUp.filter((k) => k.startsWith('perp:')).map((k) => k.slice(5)),
  ]);
  if ([...perps].some((symbol) => feedStatus(s, 'perp', symbol).state === 'catching_up')) {
    return 'Catching up after a data gap: transfers from the leverage wallet resume when it is done';
  }
  const open = [...(s.positions ?? []).map((p) => p.symbol), ...s.perpOrders.map((o) => o.symbol)];
  for (const symbol of new Set(open)) {
    const markStale = (s.positions ?? []).some((p) => p.symbol === symbol && !p.markFresh);
    if (feedStatus(s, 'perp', symbol).state === 'interrupted' || markStale) {
      return `Live data interrupted on ${symbol.replace(/USDT$/, '')} perp: transfers from the leverage wallet resume once it is back and caught up`;
    }
  }
  return null;
}

/** Whether a book, trades or kline message is for the market and coin shown (no market means spot). */
function isSelected(s: LiveData, msg: { market?: Market; symbol: string }): boolean {
  return msg.symbol === s.selected.symbol && (msg.market ?? 'spot') === s.selected.market;
}

/** What one server message changes. Pure: `now` is the arrival time. */
export function reduce(s: LiveData, msg: ServerMessage, now: number): Partial<LiveData> {
  switch (msg.type) {
    case 'tickers':
      return { tickers: msg.tickers, perpTickers: msg.perpTickers ?? {} };
    case 'health':
      return { health: msg.health, markets: msg.markets ?? {}, catchingUp: msg.catchingUp ?? [] };
    case 'marks':
      return { marks: msg.marks };
    case 'positions':
      return { positions: msg.positions };
    case 'account': {
      const moved = s.account !== null && balancesKey(s.account) !== balancesKey(msg.account);
      return moved ? { account: msg.account, fillSeq: s.fillSeq + 1 } : { account: msg.account };
    }
    case 'orders': {
      const perpOrders = msg.perpOrders ?? [];
      const moved =
        ordersKey(s.orders) !== ordersKey(msg.orders) || ordersKey(s.perpOrders) !== ordersKey(perpOrders);
      const next = { orders: msg.orders, perpOrders };
      return moved ? { ...next, fillSeq: s.fillSeq + 1 } : next;
    }
    case 'notice': {
      const n = { kind: msg.kind, level: msg.level, text: msg.text, ...(msg.liquidation ? { liquidation: msg.liquidation } : {}) };
      const added = addNotice(s, n, now);
      // A liquidation is never folded, so the notice just added is the last one.
      const notices =
        msg.kind === 'liquidation' ? { ...added, liquidationQueue: [...s.liquidationQueue, added.notices.at(-1)!] } : added;
      return FILL_NOTICES.has(msg.kind) ? { ...notices, fillSeq: s.fillSeq + 1 } : notices;
    }
    case 'error':
      return addNotice(s, { kind: 'local', level: 'error', text: msg.error }, now);
    case 'book':
      if (!isSelected(s, msg)) return {};
      return { book: { market: s.selected.market, symbol: msg.symbol, bids: msg.bids, asks: msg.asks } };
    case 'trades':
      if (!isSelected(s, msg)) return {};
      return { trades: mergeTrades(s.trades, msg.trades) };
    case 'kline':
      if (!isSelected(s, msg) || msg.interval !== s.interval) return {};
      return { kline: { market: s.selected.market, symbol: msg.symbol, interval: msg.interval, candle: msg.candle } };
    default:
      return {};
  }
}

export const useLive = create<LiveState>()((set) => ({
  ...initialLiveData(),
  meta: null,
  conn: 'connecting',
  needsLogin: false,
  loginNotice: '',
  reconnects: 0,
  priceClick: null,
  select(symbol, market) {
    set((s) => selectionChange(s, { symbol, market: market ?? s.selected.market }));
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
  acknowledgeLiquidation(id) {
    set((s) => ({ liquidationQueue: s.liquidationQueue.filter((n) => n.id !== id) }));
  },
  priceClicked(price) {
    set((s) => ({ priceClick: { price, seq: (s.priceClick?.seq ?? 0) + 1 } }));
  },
}));

// The banner follows the positions, our connection and the rules (the tick of the liquidation
// price); whatever it held over a mark that is not live is kept in the store.
useLive.subscribe((s, prev) => {
  if (s.positions === prev.positions && s.conn === prev.conn && s.meta === prev.meta) return;
  const banner = bannerEntries(s.banner, s.positions, {
    down: s.conn !== 'open',
    tick: (symbol) => s.meta?.perp?.[symbol]?.rules?.tickSize ?? undefined,
  });
  if (JSON.stringify(banner) !== JSON.stringify(s.banner)) useLive.setState({ banner });
});

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
  socket.send(JSON.stringify({ type: 'subscribe', market: selected.market, symbol: selected.symbol, interval }));
}

/** The perp rules loaded so far, by symbol. */
function perpRulesOf(meta: Meta): Record<string, WirePerpRules> {
  const out: Record<string, WirePerpRules> = {};
  for (const [symbol, p] of Object.entries(meta.perp ?? {})) if (p.rules) out[symbol] = p.rules;
  return out;
}

/** Load /api/meta (coins, rules of both markets, fees, season) into the store and the formatters. */
export async function loadMeta(): Promise<void> {
  metaAskedAt = Date.now();
  try {
    const meta = await api.meta();
    setRules(meta.rules);
    setPerpRules(perpRulesOf(meta));
    useLive.setState({ meta });
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 401) {
      useLive.getState().pushNotice('error', `Could not load market rules: ${(e as Error).message}`);
    }
  }
}

/** Whether the loaded meta lacks spot or perp rules for a configured symbol (or is not loaded at all). */
function rulesMissing(): boolean {
  const meta = useLive.getState().meta;
  if (!meta) return true;
  return Object.keys(meta.rules).length < meta.symbols.length || Object.values(meta.perp ?? {}).some((p) => !p.rules);
}

function clearSilence(): void {
  if (silenceTimer !== null) clearTimeout(silenceTimer);
  silenceTimer = null;
}

/**
 * The current socket is gone; it last worked at `workedUntil`. Only a connection that held for a
 * while resets the backoff: accept-then-drop, or accept-then-silence, keeps doubling.
 */
function connectionEnded(workedUntil: number): void {
  clearSilence();
  if (openedAt !== null && workedUntil - openedAt >= STABLE_OPEN_MS) retryDelay = RETRY_MIN_MS;
  openedAt = null;
}

/**
 * Forget a socket without waiting for its close event (a dead one may never send it). It last
 * worked at `workedUntil` (default now).
 */
function detach(ws: WebSocket, workedUntil = Date.now()): void {
  ws.onopen = ws.onmessage = ws.onclose = null;
  try {
    ws.close();
  } catch {
    // already gone
  }
  if (socket === ws) socket = null;
  connectionEnded(workedUntil);
}

function armSilence(ws: WebSocket): void {
  clearSilence();
  const heardAt = Date.now();
  silenceTimer = setTimeout(() => {
    silenceTimer = null;
    if (socket !== ws) return;
    // It last worked when it last spoke (or opened).
    detach(ws, heardAt);
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
    connectionEnded(Date.now());
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
  onUnauthorized((message) =>
    useLive.setState((s) => ({
      needsLogin: true,
      // Keep the expiry message when later requests only say a login is required.
      loginNotice: message && message !== 'Login required' ? message : s.loginNotice,
    })),
  );
  void loadMeta();
  connect();
  window.addEventListener('online', reconnectNow);
}

/** After a successful login: reload the data and reconnect. */
export function afterLogin(): void {
  useLive.setState({ needsLogin: false, loginNotice: '' });
  void loadMeta();
  reconnectNow();
}
