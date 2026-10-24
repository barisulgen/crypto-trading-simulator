# Crypto Trading Simulator

> **Simulator only — not financial advice.** This app trades **fake money**. It never places real orders and never connects to a real exchange account. Nothing in this repository is investment, trading or financial advice. Results in a simulator, however strict, do not guarantee results with real money. Use at your own risk.

A personal web app for practising crypto trading against **live Binance prices**. It is deliberately **stricter than exchange demo modes**, so practice results are an honest preview of what real money would have done:

- **Market orders walk the real order book.** Large orders fill at progressively worse prices, and the slippage is recorded on every fill.
- **Limit orders fill only on trade-through.** A price merely *touching* your limit fills nothing, because you are assumed to be in the queue. A fill happens only when real trades go *through* your price, and only for as much volume as actually traded.
- **Real fees, maker vs. taker** (Binance's standard schedule). Spot fees are charged in the asset you receive.
- **Execution delay of 100–300 ms** on every order, so the price can move between clicking and filling.
- **Real exchange rules:** tick size, step size, minimum notional and percent-price bands. An order that breaks them is rejected with a clear reason, never quietly adjusted.
- **No fills on stale data.** If the live feed drops or lags, trading pauses for the affected coins and the screen says so.
- **Leverage that can hurt.** Perpetual futures with isolated margin, Binance's real leverage tiers, liquidation on the mark price and real funding payments.
- **Honest catch-up after downtime.** Stops, limit fills, funding and liquidations that would have happened while the app was closed are applied from Binance's price history, choosing the outcome less favourable to you when the history cannot tell, and are marked as estimated.
- **An honest record:**
  - Every deposit, order, fill, fee, rejection, position, funding payment, liquidation, feed gap and catch-up is kept in an append-only history.
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
| 2 | Leverage with isolated margin, liquidation on mark price with maintenance tiers, funding, liquidation warnings, catch-up after downtime | ✅ Done |
| 3 | Stats page, equity curve, BTC buy-and-hold benchmark, CSV export | Planned |
| 4 | Cross margin, trade journal and tags, account reset with seasons | Planned |

**Older databases are test data.** A database recorded before catch-up existed may be missing what happened while the app was closed. For such a database the app shows a **TEST DATA** band across the top, and the server says so when it starts. Run `npm run db:wipe` to delete it and start real practice; a new database shows no band.

## Leverage

The leverage wallet trades Binance's USDⓈ-M **perpetual futures** for the same ten coins, long or short, against their own live order books, trades and mark prices. Move money into it with **Transfer**, or deposit into it directly.

- **Isolated margin.** Each coin has at most one position (one-way mode), with its own margin. If it is liquidated, only that margin is lost; the rest of the leverage wallet is untouched. You can add or remove margin on an open position, and set a stop-loss and take-profit on it. Cross margin is not available yet.
- **Leverage tiers.** The maximum leverage and the maintenance margin follow Binance's tiers for the coin and the position's size. The app reads them from Binance's **official signed endpoint**, using a read-only API key. If that fails, it falls back to an **unofficial public Binance web endpoint**, which is undocumented and may change or disappear without notice. If both fail, it uses a snapshot of the tiers bundled with the project. The trade screen always shows the date and source of the tiers in use. `npm run tiers:snapshot` refreshes the bundled snapshot from the public endpoint.
- **Liquidation.** A position is liquidated when the **mark price** (not the last trade) reaches its liquidation price. Its whole margin is lost, including a liquidation fee at Binance's rate for the coin. Warnings appear as the margin ratio passes 50 %, 80 % and 90 %, and a liquidation shows an alert that stays until you acknowledge it. Nothing is liquidated on a stale mark price.
- **Funding.** Positions pay or receive funding at each coin's real funding times, at the rate Binance settles. A payment comes out of the position's margin. Every payment is recorded in the history and shown on the position.
- **Catch-up.** When the live data stops (the app was closed, or the connection dropped) and comes back, each affected coin and market shows **Catching up** and refuses new orders until the gap is applied. The gap is replayed from Binance's 1-minute candles, mark-price candles, funding history and, for limit orders, its recorded trades. Where the candles cannot tell what happened first, the outcome less favourable to you is chosen, and a close estimated this way never loses more than the position's margin. Everything applied this way is marked **estimated** in the history, with what it was estimated from, and a summary of each catch-up is recorded with it. Binance keeps futures trade history for about two days; a resting perp limit order whose gap is older than that is cancelled at the start of the gap rather than guessed.

## Requirements

- **Node.js 22.12 or newer** (with npm).
- **Network access to `api.binance.com`, `stream.binance.com`, `fapi.binance.com`, `fstream.binance.com` and `www.binance.com`** (the last only for the leverage tiers' fallback). Binance is not available in some countries (for example the United States), and the app needs it for live data.
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

3. **(Optional; used for the leverage tiers)** Create a **read-only** Binance API key:
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
- `npm run feed:smoke`: a 20-second check that all 10 coins stream live from Binance, spot and perpetual, with mark prices.
- `npm run tiers:snapshot`: refreshes the bundled leverage-tier snapshot (`packages/server/src/binance/tiers-snapshot.json`) from Binance's public endpoint. It needs no API key, and writes nothing unless every coin's tiers check out.
- `npm run db:wipe`: deletes the local database (`data/sim.sqlite`, or `DB_PATH`) after you type `WIPE`. Stop the server first.

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
- leverage tiers, margin, liquidation on the mark price and funding;
- catch-up after a gap, including the worst-case ordering when the history cannot tell;
- Binance rate-limit safeguards.

## Project layout

```
packages/
  engine/   Pure TypeScript trading engine (no I/O; exact decimal maths)
  server/   Binance spot and futures market data, order-book sync, feed health, funding, catch-up, SQLite, REST + WebSocket API
  web/      React trade screen and history
```

## License

[MIT](LICENSE) © Barış Ülgen
