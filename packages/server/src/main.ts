// Composition root: config -> DB -> engine -> live market data -> runner -> REST + WebSocket API.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { PerpEngine, SimEngine, SpotEngine } from '@sim/engine';
import { buildApp } from './api/http.ts';
import { ClientHub } from './api/ws.ts';
import {
  klineSocketUrl,
  overriddenEndpoints,
  perpDepthStreamUrl,
  perpMarketStreamUrl,
  spotStreamUrl,
  unofficialBracketsUrl,
} from './binance/endpoints.ts';
import { FuturesRest } from './binance/futuresRest.ts';
import { BinanceRest } from './binance/rest.ts';
import { PauseController } from './binance/restCore.ts';
import { fetchUnofficialBrackets, TierLoader } from './binance/tiers.ts';
import { BinanceHistory } from './catchup/history.ts';
import { loadConfig } from './config.ts';
import { currentSeasonId, openDb } from './db/db.ts';
import { isTestData, loadLedger, loadPerpState, loadSpotState } from './db/store.ts';
import { createLogger, listeningLine } from './log.ts';
import { CandleService } from './market/candles.ts';
import { FeedHealth } from './market/feedHealth.ts';
import { LocalBook } from './market/localBook.ts';
import { MarketData } from './market/marketData.ts';
import { PerpFeed, perpHealth } from './market/perpFeed.ts';
import { PerpMarketData } from './market/perpMarketData.ts';
import { SpotFeed } from './market/spotFeed.ts';
import { ConnectLimiter, defaultSetTimer } from './market/ws.ts';
import { FundingService } from './funding/fundingService.ts';
import { EngineRunner } from './runner.ts';
import { onShutdownSignals } from './shutdownSignals.ts';
import { WorkerStats } from './stats/statsService.ts';

const WEB_DIST = fileURLToPath(new URL('../../web/dist/', import.meta.url));

const config = loadConfig();
const logger = createLogger(config.secrets);
const endpoints = config.binance;
const overridden = overriddenEndpoints(endpoints);
if (overridden.length > 0) logger.warn(`Binance endpoints overridden, not live Binance: ${overridden.join(', ')}`);
const db = openDb(config.dbPath);
const seasonId = currentSeasonId(db);
// The stats are read and computed in a worker thread, so a large record never stalls the engine.
const stats = new WorkerStats({ dbPath: config.dbPath, logger });
const ledger = loadLedger(db, seasonId, ['USDT', ...config.coins]);
const sim = new SimEngine(
  ledger,
  new SpotEngine(loadSpotState(db, seasonId, ledger)),
  new PerpEngine(loadPerpState(db, seasonId, ledger)),
);

// Binance limits REST calls and WebSocket connection attempts per IP: one pause and one
// connection limiter for every client.
const pause = new PauseController(Date.now, logger);
const limiter = new ConnectLimiter();
const rest = new BinanceRest(fetch, Date.now, { logger, pause, base: endpoints.spotRest });
const futuresRest = new FuturesRest(fetch, Date.now, { logger, pause, base: endpoints.futuresRest });
const health = new FeedHealth(config.symbols, config.health);
const books = new Map(config.symbols.map((s) => [s, new LocalBook()]));
const feed = new SpotFeed({
  symbols: config.symbols,
  rest,
  health,
  books,
  logger,
  limiter,
  streamUrl: spotStreamUrl(endpoints),
});
const market = new MarketData({ symbols: config.symbols, feed, books, health, rest, logger });
const candles = {
  spot: new CandleService({ rest, logger, limiter, url: klineSocketUrl(endpoints, 'spot') }),
  perp: new CandleService({ market: 'perp', rest: futuresRest, logger, limiter, url: klineSocketUrl(endpoints, 'perp') }),
};

const perpHealths = perpHealth(config.symbols, config.health);
const perpBooks = new Map(config.symbols.map((s) => [s, new LocalBook({ mode: 'futures' })]));
const perpFeed = new PerpFeed({
  symbols: config.symbols,
  rest: futuresRest,
  health: perpHealths,
  books: perpBooks,
  logger,
  limiter,
  depthUrl: perpDepthStreamUrl(endpoints),
  marketUrl: perpMarketStreamUrl(endpoints),
});
const tiers = new TierLoader({
  symbols: config.symbols,
  rest: futuresRest,
  credentials: config.binanceCredentials,
  unofficial: () => fetchUnofficialBrackets(fetch, pause, unofficialBracketsUrl(endpoints)),
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
  funding.stop();
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
  await stats.close().catch(() => {});
  await app?.close().catch(() => {});
  db.close();
  process.exit(code);
}

const runner = new EngineRunner({
  db,
  seasonId,
  sim,
  spotMarket: market,
  perpMarket,
  // PerpMarketData reports a pause to both of its connections' FeedHealth.
  health: { spot: health, perp: perpMarket },
  symbols: config.symbols,
  fees: config.fees,
  now: Date.now,
  rng: Math.random,
  setTimer: defaultSetTimer,
  onBroadcast: (msg) => hub?.broadcast(msg),
  // Memory may be ahead of the database: never keep running (the runner has logged the cause).
  onFatal: () => setImmediate(() => void shutdown(1)),
  logger,
  // Catch-up reads history through the same clients, in the bulk lane of each weight budget.
  history: new BinanceHistory(rest, futuresRest),
  // Bound late: the funding service is built over the runner, and is only called once it runs.
  funding: {
    fundingTimes: (s, start, end) => funding.fundingTimes(s, start, end),
    caughtUp: (s, since) => funding.caughtUp(s, since),
  },
});
const funding = new FundingService({
  rest: futuresRest,
  sim: runner,
  market: perpMarket,
  now: Date.now,
  setTimer: defaultSetTimer,
  logger,
});
hub = new ClientHub({
  market,
  perpMarket,
  candles,
  runner,
  symbols: config.symbols,
  setTimer: defaultSetTimer,
  logger,
  health: () => runner.healthMessage(),
});

app = await buildApp({
  runner,
  market,
  perpMarket,
  hub,
  candles,
  db,
  seasonId,
  stats,
  coins: config.coins,
  symbols: config.symbols,
  fees: config.fees,
  appPassword: config.appPassword,
  logger,
  webDist: existsSync(WEB_DIST) ? WEB_DIST : null,
});

// The runner listens for trades and marks before the feeds start, so none is missed. The perp
// feed starts only once the futures rules and leverage tiers are loaded, so no futures trade or
// mark reaches the engine before what it needs to act on it.
runner.start();
funding.start();
hub.start();
market.start();
feed.start();
perpMarket.start();
void perpMarket.ready().then(() => {
  if (!shuttingDown) perpFeed.start();
});

onShutdownSignals(process, () => void shutdown(0));

try {
  await app.listen({ host: config.host, port: config.port });
  logger.info(listeningLine({ host: config.host, port: config.port, seasonId, testData: isTestData(db) }));
} catch (e) {
  logger.error(`Could not listen on ${config.host}:${config.port}: ${(e as Error).message}`);
  await shutdown(1);
}
