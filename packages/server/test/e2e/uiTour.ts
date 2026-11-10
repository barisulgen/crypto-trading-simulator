// Drives the real server and the built web app against the fake Binance through the states worth
// looking at (margin warnings, a liquidation, a funding payment, a limit fill, catching up after an
// outage and restart, the estimated history rows), and has a screenshot tool capture each at a
// desktop and a phone width. A report-only check: it asserts nothing beyond reaching each state.
//
// usage: npx tsx packages/server/test/e2e/uiTour.ts <out-dir> <cdp-shot.mjs>
//   (build the web app first: npm run build). The screenshot tool is called as
//   `node <cdp-shot.mjs> <url> <out-dir> <shots.json>` with shots [{ name, w, h, mobile?, url, tab? }].
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { D, Decimal } from '@sim/engine';
import { FakeBinance, START_PRICES, SYMBOLS } from './fakeBinance.ts';
import { allFresh, printOpeningTrades, ServerProcess, tempDir, waitFor } from './harness.ts';
import { deposit, longMarkAtRatio, openPosition, position, waitOrderStatus } from './ops.ts';

const [outArg, cdpArg] = process.argv.slice(2);
if (!outArg || !cdpArg) throw new Error('usage: uiTour.ts <out-dir> <cdp-shot.mjs>');
const out: string = outArg;
const cdpShot: string = cdpArg;
if (!existsSync(fileURLToPath(new URL('../../../web/dist/index.html', import.meta.url)))) throw new Error('Build the web app first (npm run build)');
mkdirSync(out, { recursive: true });

const SYMBOL = 'BTCUSDT';

// Asynchronous: the fake Binance runs in this process and must keep streaming while Chrome works.
const run = promisify(execFile);

async function shoot(server: ServerProcess, name: string, route: string, opts: { phoneTab?: string; wait?: number } = {}): Promise<void> {
  const url = `${server.url}/${route}`;
  const shots = [
    { name: `${name}-1280`, w: 1280, h: 900, url, wait: opts.wait ?? 5000 },
    { name: `${name}-390`, w: 390, h: 844, mobile: true, url, wait: opts.wait ?? 5000, ...(opts.phoneTab ? { tab: opts.phoneTab } : {}) },
  ];
  const spec = join(out, `${name}.json`);
  writeFileSync(spec, JSON.stringify(shots));
  console.log((await run(process.execPath, [cdpShot, url, out, spec], { encoding: 'utf8' })).stdout.trim());
}

const fake = new FakeBinance();
await fake.start();
const tmp = tempDir();
let server = await ServerProcess.start({ fake, dir: tmp.dir, dbPath: tmp.dbPath });
try {
  const watch = await server.client();
  await watch.waitForMessage('health', (h) => allFresh(h, ['spot:BTCUSDT', 'perp:BTCUSDT', 'perp:ETHUSDT']), 30_000);
  watch.close();
  await printOpeningTrades(fake, server);
  const perpPage = `#/?m=perp&s=${SYMBOL}`;

  // Margin warnings at 50, 80 and 90 %.
  await deposit(server, 'leverage', '5000');
  const pos = await openPosition(server, { symbol: SYMBOL, side: 'buy', qty: '0.01', leverage: 50 });
  const meta = await server.get('/api/meta');
  const mmr = D(meta.perp[SYMBOL].brackets[0].mmr);
  for (const ratio of ['0.5', '0.8', '0.9']) {
    const mark = longMarkAtRatio(pos, D(ratio).plus('0.01'), mmr).toDecimalPlaces(1, Decimal.ROUND_DOWN);
    fake.setMark(SYMBOL, { markPrice: mark.toString() });
    await waitFor(`ratio ${ratio}`, async () => D((await position(server, SYMBOL)).marginRatio).gte(ratio));
    await shoot(server, `warning-${Number(ratio) * 100}`, perpPage);
  }

  // The liquidation alert (replayed to the page, which connects after it).
  fake.setMark(SYMBOL, { markPrice: D(pos.liquidationPrice).minus(5).toDecimalPlaces(1, Decimal.ROUND_DOWN).toString() });
  await waitFor('the liquidation', async () => (await position(server, SYMBOL)) === null);
  await shoot(server, 'liquidation-alert', perpPage);
  const [liq] = await server.history({ types: 'liquidation' });
  await server.ok('/api/liquidations/ack', { eventId: liq.id });
  fake.setMark(SYMBOL, { markPrice: START_PRICES[SYMBOL]! });

  // A limit buy that fills on a trade through its price.
  await server.ok('/api/perp/leverage', { symbol: SYMBOL, leverage: 10 });
  const limit = (await server.ok('/api/perp/orders', { symbol: SYMBOL, side: 'buy', type: 'limit', qty: '0.02', price: '79900.0' })).order;
  await waitOrderStatus(server, 'perp', limit.id, ['open']);
  fake.trade('perp', SYMBOL, '79900.0', '0.05');
  fake.trade('perp', SYMBOL, '79899.9', '0.05');
  await waitOrderStatus(server, 'perp', limit.id, ['filled']);
  await shoot(server, 'limit-fill', perpPage, { phoneTab: 'Orders' });
  await shoot(server, 'limit-fill-history', '#/history?market=leverage');

  // A funding payment on the long, a few seconds ahead.
  const T = Math.ceil((Date.now() + 3000) / 1000) * 1000;
  fake.setMark(SYMBOL, { nextFundingTime: T, fundingRate: '0.00012345' });
  await waitFor('the funding time', () => Date.now() > T + 200, 10_000);
  fake.publishFunding(SYMBOL, { fundingTime: T, rate: '0.00012345', markPrice: '80123.45678' });
  await waitFor('the funding row', async () => (await server.history({ types: 'funding' })).length > 0, 70_000, 500);
  await shoot(server, 'funding-history', '#/history?market=leverage');

  // A spot stop and a perp stop-loss, an outage that runs through both, a restart during it.
  await deposit(server, 'spot', '10000');
  const buy = (await server.ok('/api/orders', { symbol: SYMBOL, side: 'buy', type: 'market', qty: '0.05' })).order;
  await waitOrderStatus(server, 'spot', buy.id, ['filled']);
  const stop = (await server.ok('/api/orders', { symbol: SYMBOL, side: 'sell', type: 'stop_loss', qty: '0.04', triggerPrice: '79000' })).order;
  await waitOrderStatus(server, 'spot', stop.id, ['open']);
  const sl = (await server.ok('/api/perp/tpsl', { symbol: SYMBOL, stopLoss: '79000.0' })).orders[0];
  await waitOrderStatus(server, 'perp', sl.id, ['open']);
  fake.outage();
  await new Promise((r) => setTimeout(r, 2000));
  for (const [spot, perp] of [['79500', '79400'], ['78600', '78500'], ['78900', '78800']] as const) {
    fake.trade('spot', SYMBOL, spot, '0.3');
    fake.trade('perp', SYMBOL, perp, '0.3');
    await new Promise((r) => setTimeout(r, 300));
  }
  fake.setMark(SYMBOL, { markPrice: '78800' });
  await server.kill();
  fake.resume();
  fake.holdHistory();
  server = await ServerProcess.start({ fake, dir: tmp.dir, dbPath: tmp.dbPath });
  const live = await server.client();
  await live.waitForMessage('health', (h) => h.markets['spot:BTCUSDT'].catchingUp && h.markets['perp:BTCUSDT'].catchingUp, 30_000);
  for (const s of SYMBOLS) for (const m of ['spot', 'perp'] as const) if (s !== SYMBOL) fake.trade(m, s, START_PRICES[s]!, '0.1');
  await shoot(server, 'catching-up', perpPage, { phoneTab: 'Orders' });
  await shoot(server, 'catching-up-spot', `#/?m=spot&s=${SYMBOL}`);
  const released = live.messages.length;
  fake.releaseHistory();
  await live.waitForMessage('health', (h) => !h.markets['spot:BTCUSDT'].catchingUp && !h.markets['perp:BTCUSDT'].catchingUp, 60_000, released);
  live.close();
  await shoot(server, 'estimated-history', '#/history?symbol=BTCUSDT&types=fill,catch_up');
  await shoot(server, 'estimated-history-leverage', '#/history?market=leverage&symbol=BTCUSDT&types=fill,position_closed,catch_up');
} finally {
  await server.kill();
  await fake.stop();
  tmp.remove();
}
process.exit(0);
