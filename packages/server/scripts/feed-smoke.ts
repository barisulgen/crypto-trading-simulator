// Live check of the spot and perp feeds: runs 20 s against Binance, prints one line per coin and
// market and the REST weight used; exits 0 when every coin is fresh in both markets with a mark
// price, else 1.
// Needs no secrets: deliberately does not load .env.local or loadConfig (tiers come from the
// public brackets endpoint, or the bundled snapshot).
import { FuturesRest } from '../src/binance/futuresRest.ts';
import { BinanceRest } from '../src/binance/rest.ts';
import { PauseController } from '../src/binance/restCore.ts';
import { fetchUnofficialBrackets, TierLoader } from '../src/binance/tiers.ts';
import { COINS } from '../src/config.ts';
import { createLogger } from '../src/log.ts';
import { FeedHealth } from '../src/market/feedHealth.ts';
import { LocalBook } from '../src/market/localBook.ts';
import { MarketData } from '../src/market/marketData.ts';
import { PerpFeed, perpHealth } from '../src/market/perpFeed.ts';
import { PerpMarketData } from '../src/market/perpMarketData.ts';
import { SpotFeed } from '../src/market/spotFeed.ts';
import { ConnectLimiter } from '../src/market/ws.ts';

const RUN_MS = 20_000;
const symbols = COINS.map((c) => `${c}USDT`);
const cfg = { silentMs: 15000, lagMs: 5000, noUpdateMs: 120000 };
const logger = createLogger([]);
const pause = new PauseController(Date.now, logger);
const limiter = new ConnectLimiter();
const rest = new BinanceRest(fetch, Date.now, { logger, pause });
const futuresRest = new FuturesRest(fetch, Date.now, { logger, pause });

const health = new FeedHealth(symbols, cfg);
const books = new Map(symbols.map((s) => [s, new LocalBook()]));
const feed = new SpotFeed({ symbols, rest, health, books, logger, limiter });
const md = new MarketData({ symbols, feed, books, health, rest, logger });

const perpHealths = perpHealth(symbols, cfg);
const perpBooks = new Map(symbols.map((s) => [s, new LocalBook({ mode: 'futures' })]));
const perpFeed = new PerpFeed({ symbols, rest: futuresRest, health: perpHealths, books: perpBooks, logger, limiter });
const tiers = new TierLoader({ symbols, rest: futuresRest, unofficial: () => fetchUnofficialBrackets(fetch, pause), logger });
const perp = new PerpMarketData({ symbols, feed: perpFeed, books: perpBooks, health: perpHealths, rest: futuresRest, tiers, logger });

const count = (emitter: { on(e: 'trade', cb: (s: string) => void): unknown }) => {
  const n = new Map(symbols.map((s) => [s, 0]));
  emitter.on('trade', (s: string) => n.set(s, (n.get(s) ?? 0) + 1));
  return n;
};
const trades = count(md);
const perpTrades = count(perp);

md.start();
feed.start();
perp.start();
perpFeed.start();

setTimeout(() => {
  let spotFresh = 0;
  let perpFresh = 0;
  for (const s of symbols) {
    const bid = books.get(s)!.bestBid()?.price;
    const ask = books.get(s)!.bestAsk()?.price;
    const spread = bid && ask ? ask.minus(bid).toString() : 'n/a';
    const fresh = md.isFresh(s);
    if (fresh) spotFresh++;
    console.log(
      `spot ${s.padEnd(9)} fresh=${fresh} bid=${bid?.toString() ?? 'n/a'} ask=${ask?.toString() ?? 'n/a'} spread=${spread} trades=${trades.get(s)}${fresh ? '' : ` reason="${md.healthSnapshot()[s]!.reason}"`}`,
    );
  }
  const marks = perp.marks();
  for (const s of symbols) {
    const top = perp.bookTop(s, 1);
    const m = marks[s];
    const fresh = perp.isFresh(s) && perp.isMarkFresh(s);
    if (fresh) perpFresh++;
    console.log(
      `perp ${s.padEnd(9)} fresh=${fresh} bid=${top.bids[0]?.price.toString() ?? 'n/a'} ask=${top.asks[0]?.price.toString() ?? 'n/a'} ` +
        `mark=${m?.markPrice.toString() ?? 'n/a'} funding=${m?.fundingRate.toString() ?? 'n/a'} ` +
        `nextFunding=${m ? new Date(m.nextFundingTime).toISOString() : 'n/a'} trades=${perpTrades.get(s)}` +
        `${fresh ? '' : ` reason="${perp.healthSnapshot()[s]!.reason ?? (perp.isMarkFresh(s) ? '' : 'mark stale')}"`}`,
    );
  }
  const tierInfo = perp.tierInfo();
  console.log(`tiers ${tierInfo ? `${tierInfo.source} fetched ${new Date(tierInfo.fetchedAt).toISOString()}` : 'not loaded'}`);
  console.log(`REST weight used: spot ${rest.usedWeight}/${rest.budget}, futures ${futuresRest.usedWeight}/${futuresRest.budget} (last 60 s)`);
  const n = symbols.length;
  console.log(`fresh: spot ${spotFresh}/${n}, perp ${perpFresh}/${n} with marks`);
  md.stop();
  feed.close();
  perp.stop();
  perpFeed.close();
  rest.dispose();
  futuresRest.dispose();
  process.exit(spotFresh === n && perpFresh === n ? 0 : 1);
}, RUN_MS);
