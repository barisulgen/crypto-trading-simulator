// Live check of the spot feed: runs 20 s against Binance, prints one line per coin and the REST weight used, exits 0.
// Needs no secrets: deliberately does not load .env.local or loadConfig.
import { BinanceRest } from '../src/binance/rest.ts';
import { COINS } from '../src/config.ts';
import { createLogger } from '../src/log.ts';
import { FeedHealth } from '../src/market/feedHealth.ts';
import { LocalBook } from '../src/market/localBook.ts';
import { MarketData } from '../src/market/marketData.ts';
import { SpotFeed } from '../src/market/spotFeed.ts';

const RUN_MS = 20_000;
const symbols = COINS.map((c) => `${c}USDT`);
const logger = createLogger([]);
const rest = new BinanceRest(fetch, Date.now, { logger });
const health = new FeedHealth(symbols, { silentMs: 15000, lagMs: 5000, noUpdateMs: 120000 });
const books = new Map(symbols.map((s) => [s, new LocalBook()]));
const feed = new SpotFeed({ symbols, rest, health, books, logger });
const md = new MarketData({ symbols, feed, books, health, rest, logger });

const trades = new Map(symbols.map((s) => [s, 0]));
md.on('trade', (s: string) => trades.set(s, (trades.get(s) ?? 0) + 1));

md.start();
feed.start();

setTimeout(() => {
  for (const s of symbols) {
    const bid = books.get(s)!.bestBid()?.price;
    const ask = books.get(s)!.bestAsk()?.price;
    const spread = bid && ask ? ask.minus(bid).toString() : 'n/a';
    const fresh = md.isFresh(s);
    console.log(
      `${s.padEnd(9)} fresh=${fresh} bid=${bid?.toString() ?? 'n/a'} ask=${ask?.toString() ?? 'n/a'} spread=${spread} trades=${trades.get(s)}${fresh ? '' : ` reason="${health.reason(s, Date.now())}"`}`,
    );
  }
  console.log(`REST weight used ${rest.usedWeight}/${rest.budget} (last 60 s)`);
  md.stop();
  feed.close();
  process.exit(0);
}, RUN_MS);
