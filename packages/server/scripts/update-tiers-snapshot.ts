// Refreshes src/binance/tiers-snapshot.json from Binance's public brackets endpoint (one GET, no key).
// Needs no secrets: deliberately does not load .env.local or loadConfig. Writes nothing unless every
// coin has checked brackets.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PauseController } from '../src/binance/restCore.ts';
import { checkTiers, fetchUnofficialBrackets, parseUnofficialBrackets, toSnapshot } from '../src/binance/tiers.ts';
import { COINS } from '../src/config.ts';
import { createLogger } from '../src/log.ts';

const OUT = fileURLToPath(new URL('../src/binance/tiers-snapshot.json', import.meta.url));
const symbols = COINS.map((c) => `${c}USDT`);
const logger = createLogger([]);

try {
  const fetchedAt = Date.now();
  const raw = await fetchUnofficialBrackets(fetch, new PauseController(Date.now, logger));
  const brackets = parseUnofficialBrackets(raw, symbols);
  const problem = checkTiers(brackets, symbols);
  if (problem !== null) throw new Error(problem);
  writeFileSync(OUT, `${JSON.stringify(toSnapshot({ fetchedAt, brackets }, 'unofficial', symbols), null, 2)}\n`);
  for (const s of symbols) {
    const b = brackets[s]!;
    logger.info(`${s}: ${b.length} brackets, max leverage ${b[0]!.maxLeverage}x up to ${b[0]!.cap.toString()} USDT`);
  }
  logger.info(`Wrote ${OUT} (${new Date(fetchedAt).toISOString()})`);
} catch (e) {
  logger.error(`Tier snapshot not updated: ${(e as Error).message}`);
  process.exitCode = 1;
}
