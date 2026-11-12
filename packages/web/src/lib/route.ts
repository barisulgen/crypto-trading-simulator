// Hash routes without a router: '#/' is Trade, '#/history?symbol=BTCUSDT&...' is History,
// '#/stats?symbol=BTCUSDT&...' is Stats.
import { useSyncExternalStore } from 'react';

export type RoutePath = '/' | '/history' | '/stats';

const PATHS: readonly RoutePath[] = ['/', '/history', '/stats'];

export interface Route {
  path: RoutePath;
  params: URLSearchParams;
}

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, '') || '/';
  const q = raw.indexOf('?');
  const path = q === -1 ? raw : raw.slice(0, q);
  const params = new URLSearchParams(q === -1 ? '' : raw.slice(q + 1));
  return { path: PATHS.find((p) => p === path) ?? '/', params };
}

/** The href for a route, e.g. href('/history', { symbol: 'BTCUSDT' }) -> '#/history?symbol=BTCUSDT'. */
export function href(path: RoutePath, params: Record<string, string> = {}): string {
  const q = new URLSearchParams(params).toString();
  return `#${path}${q ? `?${q}` : ''}`;
}

export function navigate(path: RoutePath, params: Record<string, string> = {}): void {
  location.hash = href(path, params);
}

/** The trade screen's market and coin as kept in the hash: '#/?m=perp&s=BTCUSDT'. */
export interface TradeSelection {
  symbol: string;
  market: 'spot' | 'perp';
}

/**
 * The market and coin the trade hash asks for: `m` (spot or perp) and `s` (a known symbol), each
 * taken from `current` when absent or not one we know.
 */
export function selectionFromParams(
  params: URLSearchParams,
  symbols: string[],
  current: TradeSelection,
): TradeSelection {
  const m = params.get('m');
  const s = params.get('s');
  return {
    market: m === 'spot' || m === 'perp' ? m : current.market,
    symbol: s !== null && symbols.includes(s) ? s : current.symbol,
  };
}

/** The hash parameters for a market and coin. */
export function selectionParams(sel: TradeSelection): Record<string, string> {
  return { m: sel.market, s: sel.symbol };
}

/**
 * The address the trade screen should show for its selection, or null to leave `hash` as it is:
 * when it already shows the selection, or when it is not the trade route. The trade screen still
 * renders once with a new address (a History link, Back, Forward) before the app swaps it out, and
 * writing its selection then would undo that navigation.
 */
export function selectionHref(hash: string, sel: TradeSelection): string | null {
  if (parseHash(hash).path !== '/') return null;
  const next = href('/', selectionParams(sel));
  return next === hash ? null : next;
}

/**
 * Write the trade selection into the address without a new history entry or a hashchange event;
 * does nothing once the address has left the trade route.
 */
export function replaceSelection(sel: TradeSelection): void {
  const next = selectionHref(location.hash, sel);
  if (next !== null) history.replaceState(history.state, '', next);
}

const subscribe = (cb: () => void) => {
  window.addEventListener('hashchange', cb);
  return () => window.removeEventListener('hashchange', cb);
};

/** The current route; re-renders on hash changes. */
export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, () => location.hash);
  return parseHash(hash);
}
