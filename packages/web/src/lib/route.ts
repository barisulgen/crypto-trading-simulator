// Hash routes without a router: '#/' is Trade, '#/history?symbol=BTCUSDT&...' is History.
import { useSyncExternalStore } from 'react';

export type RoutePath = '/' | '/history';

export interface Route {
  path: RoutePath;
  params: URLSearchParams;
}

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, '') || '/';
  const q = raw.indexOf('?');
  const path = q === -1 ? raw : raw.slice(0, q);
  const params = new URLSearchParams(q === -1 ? '' : raw.slice(q + 1));
  return { path: path === '/history' ? '/history' : '/', params };
}

/** The href for a route, e.g. href('/history', { symbol: 'BTCUSDT' }) -> '#/history?symbol=BTCUSDT'. */
export function href(path: RoutePath, params: Record<string, string> = {}): string {
  const q = new URLSearchParams(params).toString();
  return `#${path}${q ? `?${q}` : ''}`;
}

export function navigate(path: RoutePath, params: Record<string, string> = {}): void {
  location.hash = href(path, params);
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
