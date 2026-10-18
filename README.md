# Crypto Trading Simulator

> **Simulator only — not financial advice.** This app trades **fake money**. It never places real orders and never connects to a real exchange account. Nothing in this repository is investment, trading or financial advice. Results in a simulator, however strict, do not guarantee results with real money. Use at your own risk.

A personal web app for practising crypto trading against **live Binance prices**. It is deliberately **stricter than exchange demo modes**, so practice results are an honest preview of what real money would have done:

- **Market orders walk the real order book.** Large orders fill at progressively worse prices, and the slippage is recorded on every fill.
- **Limit orders fill only on trade-through.** A price merely *touching* your limit fills nothing, because you are assumed to be in the queue. A fill happens only when real trades go *through* your price, and only for as much volume as actually traded.
- **Real fees, maker vs. taker** (Binance's standard schedule). Spot fees are charged in the asset you receive.
- **Execution delay of 100–300 ms** on every order, so the price can move between clicking and filling.
- **Real exchange rules:** tick size, step size, minimum notional and percent-price bands. An order that breaks them is rejected with a clear reason, never quietly adjusted.
- **No fills on stale data.** If the live feed drops or lags, trading pauses for the affected coins and the screen says so.
- **An honest record:**
  - Every deposit, order, fill, fee, rejection and feed gap is kept in an append-only history.
  - Profit and loss is measured against total money deposited.
  - Topping up never hides a loss.

Ten liquid coins are available, each against USDT: BTC, ETH, SOL, NEAR, XRP, BNB, DOGE, SUI, HYPE and AVAX.

## Screenshots

_Screenshots coming soon._

<!-- Add images here, e.g. ![Trade screen](screenshots/trade.png) -->

## Status

Built in phases:

| Phase | Scope | Status |
|---|---|---|
| 1 | Live market data, trade screen, deposits and transfers, spot trading (market, limit, post-only, stop-loss, take-profit, linked SL/TP pairs), fees, history | ✅ Done |
| 2 | Leverage with isolated margin, liquidation on mark price with maintenance tiers, funding, liquidation warnings, catch-up after downtime | Planned |
| 3 | Stats page, equity curve, BTC buy-and-hold benchmark, CSV export | Planned |
| 4 | Cross margin, trade journal and tags, account reset with seasons | Planned |

**Phase 1 data is test data.** Phase 1 has no catch-up for time the app was offline, so its records are labelled as test data, and `npm run db:wipe` clears them. Real practice is meant to start with Phase 2.

### A note on margin tiers (Phase 2)

Leverage needs Binance's maintenance-margin tiers. The app will read them from Binance's **official signed endpoint**, using a read-only API key. If that fails, it falls back to an **unofficial public Binance web endpoint**, which is undocumented and may change or disappear without notice. If both fail, it uses a snapshot of the tiers bundled with the project. The screen always shows the date and source of the tiers in use.

## Requirements

- **Node.js 22.12 or newer** (with npm).
- **Network access to `api.binance.com` and `stream.binance.com`.** Binance is not available in some countries (for example the United States), and the app needs it for live data.
- Windows, macOS or Linux. The SQLite driver (`better-sqlite3`) ships prebuilt binaries for common platforms. Elsewhere it compiles from source and needs a C++ build toolchain.

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create your local settings file:

   ```bash
   cp .env.example .env.local
   ```

   On Windows PowerShell: `Copy-Item .env.example .env.local`. Every variable is optional and documented in `.env.example`, and `.env.local` is git-ignored.

3. **(Optional in Phase 1; used from Phase 2)** Create a **read-only** Binance API key:
   - In Binance API Management, create a key with **"Enable Reading" only**.
   - Do **not** enable spot/margin trading, futures, withdrawals or transfers. The simulator never needs them.
   - Put the key and secret in `.env.local` as `BINANCE_KEY` and `BINANCE_SECRET`.
   - The key never leaves the server: it is never logged, stored in the database or sent to the browser.

## Running

```bash
npm start
```

This builds the web app and starts the server at **http://127.0.0.1:8787**. Stop it with **Ctrl+C** in the same terminal.

- `npm run dev`: server and web app with hot reload. Open the URL Vite prints.
- `npm run feed:smoke`: a 20-second check that all 10 coins stream live from Binance.
- `npm run db:wipe`: deletes the local database (`data/sim.sqlite`) after you type `WIPE`.

By default the server only listens on this computer. To use it from your phone on the same network, set `HOST` (for example `0.0.0.0`) **and** `APP_PASSWORD` in `.env.local`; the app then asks for that password.

## Testing

```bash
npm test          # engine, server and web test suites
npm run typecheck
```

The trading engine is covered by worked-example tests. For example: this market order on this order book fills at exactly this average price, with this slippage and this fee. The tests cover:

- book walking and thin books;
- trade-through limit fills and partial fills;
- maker vs. taker fees;
- stops in price gaps;
- linked pairs;
- reservations against double-spending;
- staleness handling;
- Binance rate-limit safeguards.

## Project layout

```
packages/
  engine/   Pure TypeScript trading engine (no I/O; exact decimal maths)
  server/   Binance market data, order-book sync, feed health, SQLite, REST + WebSocket API
  web/      React trade screen and history
```

## License

[MIT](LICENSE) © Barış Ülgen
