import { D } from '@sim/engine';
import type { AggTrade, BookSnapshot, Decimal, PriceLevel, Side } from '@sim/engine';
import type { LocalBook } from './localBook.ts';
import { OwnLiquidity } from './ownLiquidity.ts';
import type { DepthLevels, Ticker } from './streamParse.ts';

const TRADE_RING = 50;

/**
 * What a market keeps per symbol from its feed: the books, the owner's own taker fills held back
 * from the engine's view of them (OwnLiquidity), the last trade price, a newest-first ring of
 * recent trades and the 24 h ticker. Never invents a price.
 */
export class LiveMarket {
  private readonly last = new Map<string, Decimal>();
  private readonly tick = new Map<string, Ticker>();
  private readonly trades = new Map<string, AggTrade[]>();
  private readonly own = new Map<string, OwnLiquidity>();

  constructor(private readonly books: Map<string, LocalBook>) {
    for (const s of books.keys()) this.own.set(s, new OwnLiquidity());
  }

  has(symbol: string): boolean {
    return this.books.has(symbol);
  }

  onTrade(symbol: string, t: AggTrade): void {
    this.last.set(symbol, t.price);
    const ring = this.trades.get(symbol) ?? [];
    ring.unshift(t);
    if (ring.length > TRADE_RING) ring.length = TRADE_RING;
    this.trades.set(symbol, ring);
  }

  onTicker(symbol: string, t: Ticker): void {
    this.tick.set(symbol, t);
  }

  /** A depth update applied to the book: it ends the claims on the levels it set. */
  onBook(symbol: string, levels?: DepthLevels): void {
    const own = this.own.get(symbol);
    if (!own || !levels) return;
    for (const [p] of levels.b) own.onLevelUpdate('bids', D(p));
    for (const [p] of levels.a) own.onLevelUpdate('asks', D(p));
  }

  /** The book was replaced (resync, disconnect or snapshot): every claim ends. */
  onSnapshot(symbol: string): void {
    this.own.get(symbol)?.clear();
  }

  /** The book less what the owner's own taker fills took. */
  book(symbol: string): BookSnapshot {
    const book = this.bookOf(symbol).snapshot();
    const own = this.own.get(symbol);
    if (!own || own.count('bids') + own.count('asks') === 0) return book;
    return { bids: own.apply('bids', book.bids), asks: own.apply('asks', book.asks) };
  }

  /** Best price a taker would hit (best ask for a buy, best bid for a sell), less the owner's own fills. */
  best(symbol: string, side: Side): Decimal | null {
    const bookSide = side === 'buy' ? 'asks' : 'bids';
    const own = this.own.get(symbol);
    const b = this.bookOf(symbol);
    if (!own || own.count(bookSide) === 0) return (side === 'buy' ? b.bestAsk() : b.bestBid())?.price ?? null;
    // Each claim can remove at most one level, so the best left is within the first claims + 1.
    const top = b.snapshot(own.count(bookSide) + 1)[bookSide];
    return own.apply(bookSide, top)[0]?.price ?? null;
  }

  /**
   * The owner's own taker fill took `levels` from the side a `side` order takes (asks for a buy,
   * bids for a sell): later walks see those levels reduced until a depth update touches them.
   */
  consume(symbol: string, side: Side, levels: PriceLevel[]): void {
    const own = this.own.get(symbol);
    if (!own) throw new Error(`Unknown symbol ${symbol}`);
    own.consume(side === 'buy' ? 'asks' : 'bids', levels);
  }

  lastPrice(symbol: string): Decimal | null {
    return this.last.get(symbol) ?? null;
  }

  tickers(): Record<string, Ticker> {
    return Object.fromEntries(this.tick);
  }

  recentTrades(symbol: string, n = TRADE_RING): AggTrade[] {
    return (this.trades.get(symbol) ?? []).slice(0, n);
  }

  /** The real book, as shown to the owner. */
  bookTop(symbol: string, levels = 20): BookSnapshot {
    return this.bookOf(symbol).snapshot(levels);
  }

  private bookOf(symbol: string): LocalBook {
    const b = this.books.get(symbol);
    if (!b) throw new Error(`Unknown symbol ${symbol}`);
    return b;
  }
}
