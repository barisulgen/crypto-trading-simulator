import { useEffect, useState } from 'react';
import { AccountBar } from './components/AccountBar.tsx';
import { FeedIndicator } from './components/FeedIndicator.tsx';
import { LoginScreen } from './components/LoginScreen.tsx';
import { Notices } from './components/Notices.tsx';
import { TestBanner } from './components/TestBanner.tsx';
import { startLive, useLive } from './lib/live.ts';
import { href, useRoute } from './lib/route.ts';
import type { RoutePath } from './lib/route.ts';
import { currentTheme, setTheme } from './lib/theme.ts';
import type { Theme } from './lib/theme.ts';
import { HistoryPage } from './pages/HistoryPage.tsx';
import { TradePage } from './pages/TradePage.tsx';

const NAV: { path: RoutePath; label: string }[] = [
  { path: '/', label: 'Trade' },
  { path: '/history', label: 'History' },
];

function ThemeToggle() {
  const [theme, set] = useState<Theme>(currentTheme);
  const next: Theme = theme === 'dark' ? 'light' : 'dark';
  return (
    <button
      type="button"
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
      onClick={() => {
        setTheme(next);
        set(next);
      }}
      className="flex size-7 items-center justify-center rounded-ctl text-muted hover:bg-raised hover:text-fg"
    >
      <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5">
        {theme === 'dark' ? (
          <path d="M13.5 9.5A5.5 5.5 0 1 1 6.5 2.5a4.5 4.5 0 0 0 7 7z" />
        ) : (
          <>
            <circle cx="8" cy="8" r="3" />
            <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.4 1.4M11.6 11.6L13 13M3 13l1.4-1.4M11.6 4.4L13 3" />
          </>
        )}
      </svg>
    </button>
  );
}

function Header({ path }: { path: RoutePath }) {
  return (
    <header className="flex h-10 flex-none items-center gap-3 border-b border-line bg-panel px-3 desk:gap-4 desk:px-4">
      <span className="font-semibold whitespace-nowrap [font-stretch:112%]">Trading Simulator</span>
      <nav aria-label="Pages" className="flex h-full gap-1">
        {NAV.map((n) => (
          <a
            key={n.path}
            href={href(n.path)}
            aria-current={n.path === path ? 'page' : undefined}
            className={`flex items-center px-2 text-sm ${
              n.path === path ? 'text-fg shadow-[inset_0_-2px_0_var(--color-accent)]' : 'text-muted hover:text-fg'
            }`}
          >
            {n.label}
          </a>
        ))}
      </nav>
      <div className="ml-auto flex items-center gap-1">
        <FeedIndicator />
        <ThemeToggle />
      </div>
    </header>
  );
}

export function App() {
  const needsLogin = useLive((s) => s.needsLogin);
  const route = useRoute();
  useEffect(() => startLive(), []);

  return (
    <div className="flex h-dvh min-h-[34rem] flex-col">
      <TestBanner />
      {needsLogin ? (
        <LoginScreen />
      ) : (
        <>
          <Header path={route.path} />
          <AccountBar />
          <main className="min-h-0 flex-1">
            {route.path === '/history' ? <HistoryPage params={route.params} /> : <TradePage />}
          </main>
        </>
      )}
      <Notices />
    </div>
  );
}
