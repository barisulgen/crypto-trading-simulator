// Composition root: config -> DB -> engine -> live market data -> runner -> REST + WebSocket API.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { emptyPerpState, PerpEngine, SimEngine, SpotEngine } from '@sim/engine';
import { buildApp } from './api/http.ts';
import { ClientHub } from './api/ws.ts';
import { FuturesRest } from './binance/futuresRest.ts';
import { BinanceRest } from './binance/rest.ts';
import { PauseController } from './binance/restCore.ts';
import { fetchUnofficialBrackets, TierLoader } from './binance/tiers.ts';
import { loadConfig } from './config.ts';
import { currentSeasonId, openDb } from './db/db.ts';
import { loadLedger, loadSpotState } from './db/store.ts';
import { createLogger } from './log.ts';
import { CandleService } from './market/candles.ts';
import { FeedHealth } from './market/feedHealth.ts';
import { LocalBook } from './market/localBook.ts';
import { MarketData } from './market/marketData.ts';
import { PerpFeed, perpHealth } from './market/perpFeed.ts';
import { PerpMarketData } from './market/perpMarketData.ts';
import { SpotFeed } from './market/spotFeed.ts';
import { ConnectLimiter, defaultSetTimer } from './market/ws.ts';
import { EngineRunner } from './runner.ts';
import { onShutdownSignals } from './shutdownSignals.ts';

const WEB_DIST = fileURLToPath(new URL('../../web/dist/', import.meta.url));

const config = loadConfig();
const logger = createLogger(config.secrets);
const db = openDb(config.dbPath);
const seasonId = currentSeasonId(db);
const ledger = loadLedger(db, seasonId, ['USDT', ...config.coins]);
const sim = new SimEngine(
  ledger,
  new SpotEngine(loadSpotState(db, seasonId, ledger)),
  new PerpEngine(emptyPerpState(ledger)),
);

// Binance limits REST calls and WebSocket connection attempts per IP: one pause and one
// connection limiter for every client.
const pause = new PauseController(Date.now, logger);
const limiter = new ConnectLimiter();
const rest = new BinanceRest(fetch, Date.now, { logger, pause });
const futuresRest = new FuturesRest(fetch, Date.now, { logger, pause });
const health = new FeedHealth(config.symbols, config.health);
const books = new Map(config.symbols.map((s) => [s, new LocalBook()]));
const feed = new SpotFeed({ symbols: config.symbols, rest, health, books, logger, limiter });
const market = new MarketData({ symbols: config.symbols, feed, books, health, rest, logger });
const candles = {
  spot: new CandleService({ rest, logger, limiter }),
  perp: new CandleService({ market: 'perp', rest: futuresRest, logger, limiter }),
};

const perpHealths = perpHealth(config.symbols, config.health);
const perpBooks = new Map(config.symbols.map((s) => [s, new LocalBook({ mode: 'futures' })]));
const perpFeed = new PerpFeed({ symbols: config.symbols, rest: futuresRest, health: perpHealths, books: perpBooks, logger, limiter });
const tiers = new TierLoader({
  symbols: config.symbols,
  rest: futuresRest,
  credentials: config.binanceCredentials,
  unofficial: () => fetchUnofficialBrackets(fetch, pause),
  logger,
});
const perpMarket = new PerpMarketData({
  symbols: config.symbols,
  feed: perpFeed,
  books: perpBooks,
  health: perpHealths,
  rest: futuresRest,
  tiers,
  logger,
});

let hub: ClientHub | null = null;
let app: FastifyInstance | null = null;
let shuttingDown = false;

async function shutdown(code: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  runner.stop();
  hub?.stop();
  feed.close();
  market.stop();
  perpFeed.close();
  perpMarket.stop();
  candles.spot.close();
  candles.perp.close();
  rest.dispose(); // queued REST requests are dropped, never sent after shutdown began
  futuresRest.dispose();
  await app?.close().catch(() => {});
  db.close();
  process.exit(code);
}

const runner = new EngineRunner({
  db,
  seasonId,
  sim,
  market,
  health,
  symbols: config.symbols,
  fees: config.fees.spot,
  now: Date.now,
  rng: Math.random,
  setTimer: defaultSetTimer,
  onBroadcast: (msg) => hub?.broadcast(msg),
  // Memory may be ahead of the database: never keep running (the runner has logged the cause).
  onFatal: () => setImmediate(() => void shutdown(1)),
  logger,
});
hub = new ClientHub({ market, candles, runner, symbols: config.symbols, setTimer: defaultSetTimer, logger });

app = await buildApp({
  runner,
  market,
  hub,
  candles,
  db,
  seasonId,
  coins: config.coins,
  symbols: config.symbols,
  fees: config.fees,
  appPassword: config.appPassword,
  logger,
  webDist: existsSync(WEB_DIST) ? WEB_DIST : null,
});

// The runner listens for trades before the feed starts, so none is missed.
runner.start();
hub.start();
market.start();
feed.start();
perpMarket.start();
perpFeed.start();

onShutdownSignals(process, () => void shutdown(0));

try {
  await app.listen({ host: config.host, port: config.port });
  logger.info(`Server listening on http://${config.host}:${config.port} (season ${seasonId}, TEST DATA - Phase 1)`);
} catch (e) {
  logger.error(`Could not listen on ${config.host}:${config.port}: ${(e as Error).message}`);
  await shutdown(1);
}
