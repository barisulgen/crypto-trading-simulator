import { describe, expect, it } from 'vitest';
import type { HistoryPage, HistoryRow } from '../src/lib/api.ts';
import { CSV_COLUMNS, fetchAllHistory, historyCsv, localTimeText } from '../src/lib/csv.ts';
import type { CsvFormat } from '../src/lib/csv.ts';
import { loadCsvFormat, saveCsvFormat } from '../src/lib/csvFormat.ts';

/** A small RFC 4180 reader: rows of fields, quotes and doubled quotes undone. */
function parse(text: string, sep = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) {
      row.push(field);
      field = '';
    } else if (c === '\r' && text[i + 1] === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i++;
    } else field += c;
  }
  return rows;
}

const TZ = 'Europe/Istanbul';
const T0 = Date.UTC(2026, 9, 18, 21, 5, 9, 123); // 2026-10-19 00:05:09 in Istanbul (UTC+3)

const row = (over: Partial<HistoryRow> & { type: string; payload: unknown }): HistoryRow => ({
  id: 1,
  time: T0,
  symbol: null,
  market: null,
  ...over,
});

/** The record of a one-row export, keyed by column name. */
function record(r: HistoryRow): Record<string, string> {
  const [head, line] = parse(historyCsv([r], TZ).slice(1));
  expect(head).toEqual([...CSV_COLUMNS]);
  return Object.fromEntries(head!.map((h, i) => [h, line![i]!]));
}

const spotFill = {
  id: 'f1',
  orderId: 'o1',
  symbol: 'BTCUSDT',
  side: 'buy',
  qty: '0.00123456',
  price: '67890.12',
  quote: '83.8147',
  liquidity: 'taker',
  feeAsset: 'BTC',
  fee: '0.000001234',
  feeUsd: '0.0838',
  bestAtArrival: '67889.99',
  bestAtSubmit: '67880.5',
  slippageUsd: '0.0012',
  driftUsd: '-0.0034',
  triggerPrice: null,
  realizedPnl: null,
  roundTripId: null,
  time: T0,
};

const order = (type: string, extra: object = {}) => ({
  id: 'o1',
  symbol: 'BTCUSDT',
  side: 'buy',
  type,
  status: 'filled',
  qty: '0.00123456',
  quoteQty: null,
  price: null,
  triggerPrice: null,
  ocoGroupId: null,
  attach: null,
  ...extra,
});

describe('historyCsv', () => {
  it('starts with a UTF-8 byte order mark, then the header, with CRLF line ends', () => {
    const text = historyCsv([row({ type: 'feed_gap', payload: { startedAt: T0, endedAt: T0 + 1000, reason: 'x' } })], TZ);
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text.slice(1).split('\r\n')[0]).toBe(CSV_COLUMNS.join(','));
    expect(text.endsWith('\r\n')).toBe(true);
    expect(text.replace(/\r\n/g, '').includes('\n')).toBe(false);
    expect(parse(text.slice(1))).toHaveLength(2);
  });

  it('is just the header for no rows', () => {
    expect(historyCsv([], TZ)).toBe(`﻿${CSV_COLUMNS.join(',')}\r\n`);
  });

  it('has the columns in the agreed order', () => {
    expect(CSV_COLUMNS.join(',')).toBe(
      'id,time_utc,time_local,type,market,symbol,side,qty,price,quote,fee,fee_asset,fee_usd,liquidity,slippage_usd,drift_usd,best_at_arrival,best_at_submit_or_trigger,trigger_price,realized_pnl,amount,wallet,estimated,details',
    );
  });

  it('writes a spot fill with every recorded decimal unrounded', () => {
    const r = record(row({ id: 41, type: 'fill', symbol: 'BTCUSDT', market: 'spot', payload: { fill: spotFill, order: order('market') } }));
    expect(r).toMatchObject({
      id: '41',
      time_utc: '2026-10-18T21:05:09.123Z',
      time_local: '2026-10-19 00:05:09',
      type: 'fill',
      market: 'spot',
      symbol: 'BTCUSDT',
      side: 'buy',
      qty: '0.00123456',
      price: '67890.12',
      quote: '83.8147',
      fee: '0.000001234',
      fee_asset: 'BTC',
      fee_usd: '0.0838',
      liquidity: 'taker',
      slippage_usd: '0.0012',
      drift_usd: '-0.0034',
      best_at_arrival: '67889.99',
      best_at_submit_or_trigger: '67880.5',
      trigger_price: '',
      realized_pnl: '',
      amount: '',
      wallet: '',
      estimated: '',
    });
    expect(r.details!.startsWith('Fill · Side: Buy')).toBe(true);
  });

  it("puts a stop fill's best at submit, trigger price and realized P&L in their columns", () => {
    const r = record(
      row({
        type: 'fill',
        symbol: 'BTCUSDT',
        market: 'spot',
        payload: {
          fill: { ...spotFill, side: 'sell', triggerPrice: '65000', bestAtSubmit: '66000.5', realizedPnl: '-12.5' },
          order: order('stop_loss', { side: 'sell', triggerPrice: '65000' }),
        },
      }),
    );
    expect(r.best_at_submit_or_trigger).toBe('66000.5');
    expect(r.trigger_price).toBe('65000');
    expect(r.realized_pnl).toBe('-12.5');
    expect(r.side).toBe('sell');
  });

  it('leaves a missing best price empty, never 0', () => {
    const r = record(
      row({
        type: 'fill',
        symbol: 'BTCUSDT',
        market: 'spot',
        payload: { fill: { ...spotFill, bestAtArrival: null, bestAtSubmit: null }, order: order('market') },
      }),
    );
    expect(r.best_at_arrival).toBe('');
    expect(r.best_at_submit_or_trigger).toBe('');
  });

  it('writes a perp fill from its perp payload', () => {
    const r = record(
      row({
        type: 'fill',
        symbol: 'ETHUSDT',
        market: 'perp',
        payload: {
          market: 'perp',
          fill: { ...spotFill, symbol: 'ETHUSDT', market: 'perp', positionId: 'p1', marginIn: '10', uncovered: null, feeAsset: 'USDT', realizedPnl: '3.21' },
          order: order('market', { symbol: 'ETHUSDT', leverage: 5, reduceOnly: false, closePosition: false }),
        },
      }),
    );
    expect(r.market).toBe('perp');
    expect(r.realized_pnl).toBe('3.21');
    expect(r.fee_asset).toBe('USDT');
  });

  it('writes a funding payment: amount, mark price and the position side', () => {
    const r = record(
      row({
        type: 'funding',
        symbol: 'BTCUSDT',
        market: 'perp',
        payload: {
          market: 'perp',
          time: T0,
          symbol: 'BTCUSDT',
          positionId: 'p1',
          fundingTime: T0,
          rate: '0.0001',
          markPrice: '67001.5',
          qty: '0.5',
          side: 'long',
          amount: '-3.35007',
          target: 'margin',
          uncollected: null,
        },
      }),
    );
    expect(r).toMatchObject({
      type: 'funding',
      market: 'perp',
      symbol: 'BTCUSDT',
      side: 'long',
      price: '67001.5',
      amount: '-3.35007',
      qty: '',
      fee: '',
      realized_pnl: '',
      wallet: '',
    });
    expect(r.details!.startsWith('Funding paid · Position: Long')).toBe(true);
  });

  it('writes a liquidation: the margin lost as amount, the mark as price', () => {
    const position = {
      id: 'p1',
      symbol: 'BTCUSDT',
      side: 'short',
      qty: '0.2',
      entryPrice: '60000',
      leverage: 25,
      margin: '480',
      openedAt: T0 - 1000,
      realizedPnl: '0',
      fees: '1',
      funding: '0',
    };
    const r = record(
      row({
        type: 'liquidation',
        symbol: 'BTCUSDT',
        market: 'perp',
        payload: {
          market: 'perp',
          time: T0,
          symbol: 'BTCUSDT',
          position,
          markPrice: '62400.1',
          marginLost: '479.12345',
          tradingLoss: '470',
          liquidationFee: '9.12345',
          remainder: '0',
          feeRateKnown: true,
          cancelledOrderIds: [],
        },
      }),
    );
    expect(r).toMatchObject({ side: 'short', price: '62400.1', amount: '479.12345', realized_pnl: '', qty: '' });
  });

  it('writes a deposit: amount and wallet, no market or symbol', () => {
    const r = record(row({ type: 'deposit', payload: { time: T0, wallet: 'leverage', amount: '1000.5', totalDeposited: '3000.5', btcAsk: '67000' } }));
    expect(r).toMatchObject({ type: 'deposit', market: '', symbol: '', amount: '1000.5', wallet: 'leverage', side: '', price: '', realized_pnl: '' });
    expect(r.details).toContain('Deposit');
  });

  it('writes a transfer: the amount and from to', () => {
    const r = record(row({ type: 'transfer', payload: { time: T0, from: 'spot', to: 'leverage', amount: '250' } }));
    expect(r).toMatchObject({ amount: '250', wallet: 'spot→leverage' });
  });

  it('writes a position close: exit price and realized P&L', () => {
    const position = {
      id: 'p1',
      symbol: 'BTCUSDT',
      side: 'long',
      qty: '0',
      entryPrice: '60000',
      leverage: 10,
      margin: '100',
      openedAt: T0 - 5000,
      realizedPnl: '5',
      fees: '1',
      funding: '0',
    };
    const r = record(
      row({
        type: 'position_closed',
        symbol: 'BTCUSDT',
        market: 'perp',
        payload: { market: 'perp', time: T0, position, exitPrice: '61000.25', realizedPnl: '5.5', fees: '1', funding: '0', holdMs: 5000, reason: 'closed' },
      }),
    );
    expect(r).toMatchObject({ side: 'long', price: '61000.25', realized_pnl: '5.5', amount: '' });
  });

  it('writes a round trip: its P&L as realized P&L', () => {
    const r = record(
      row({
        type: 'round_trip_closed',
        symbol: 'ETHUSDT',
        market: 'spot',
        payload: { time: T0, roundTrip: { id: 'r1', symbol: 'ETHUSDT', openedAt: T0 - 60000, closedAt: T0, pnl: '-7.77' } },
      }),
    );
    expect(r.realized_pnl).toBe('-7.77');
    expect(r.side).toBe('');
  });

  it("takes an order event's side from its order and fills nothing else", () => {
    const r = record(row({ type: 'order_placed', symbol: 'BTCUSDT', market: 'spot', payload: { order: order('limit', { side: 'sell', price: '70000' }) } }));
    expect(r.side).toBe('sell');
    expect(r.price).toBe('');
    expect(r.qty).toBe('');
  });

  it('marks a catch-up row as estimated', () => {
    const r = record(
      row({
        type: 'fill',
        symbol: 'BTCUSDT',
        market: 'spot',
        payload: { fill: spotFill, order: order('market'), catchUp: { from: T0 - 1000, to: T0, basis: 'candle_worst_price' } },
      }),
    );
    expect(r.estimated).toBe('yes');
  });

  it('writes one line for every event type, even one it cannot read', () => {
    const rows = ['deposit', 'transfer', 'leverage_set', 'margin_changed', 'order_placed', 'catch_up', 'feed_gap', 'mystery'].map((type, i) =>
      row({ id: i + 1, type, payload: null }),
    );
    const parsed = parse(historyCsv(rows, TZ).slice(1));
    expect(parsed).toHaveLength(rows.length + 1);
    for (const line of parsed) expect(line).toHaveLength(CSV_COLUMNS.length);
    expect(parsed[1]![23]).toContain('Unreadable event (deposit)');
  });

  it('quotes a field holding a comma, a quote and a newline, and reads back unchanged', () => {
    const reason = 'a, "b"\nc';
    const text = historyCsv([row({ type: 'feed_gap', payload: { startedAt: T0, endedAt: T0 + 1000, reason } })], TZ);
    expect(text).toContain('Reason: a, ""b""\nc"');
    expect(text).toContain(',"Data gap');
    const r = parse(text.slice(1))[1]!;
    expect(r).toHaveLength(CSV_COLUMNS.length);
    expect(r[23]).toContain(reason);
  });

  it('keeps a plain field unquoted', () => {
    const line = historyCsv([row({ id: 7, type: 'transfer', payload: { time: T0, from: 'spot', to: 'leverage', amount: '250' } })], TZ).split('\r\n')[1]!;
    expect(line.startsWith('7,2026-10-18T21:05:09.123Z,2026-10-19 00:05:09,transfer,,,')).toBe(true);
  });

  it('puts the visible text in details: the title and each label: value, joined with a dot', () => {
    const r = record(row({ type: 'transfer', payload: { time: T0, from: 'spot', to: 'leverage', amount: '250' } }));
    expect(r.details).toMatch(/^Transfer · Amount: .*250.* · From: Spot · To: Leverage$/);
  });
});

const SEP: Record<CsvFormat, string> = { standard: ',', 'excel-eu': ';' };
const NUMERIC = [
  'qty',
  'price',
  'quote',
  'fee',
  'fee_usd',
  'slippage_usd',
  'drift_usd',
  'best_at_arrival',
  'best_at_submit_or_trigger',
  'trigger_price',
  'realized_pnl',
  'amount',
];

const fullFill = { ...spotFill, triggerPrice: '67000.5', realizedPnl: '-12.5' };

describe('historyCsv in the Excel (Turkish/European) format', () => {
  const fillRow = row({ id: 5, type: 'fill', symbol: 'BTCUSDT', market: 'spot', payload: { fill: fullFill, order: order('market') } });
  const transfer = (amount: string) =>
    row({ id: 7, type: 'transfer', payload: { time: T0, from: 'spot', to: 'leverage', amount } });

  it('is the standard output when no format is given', () => {
    const rows = [fillRow, transfer('250')];
    expect(historyCsv(rows, TZ)).toBe(historyCsv(rows, TZ, 'standard'));
  });

  it('joins the header with semicolons, with a byte order mark, CRLF and no sep line', () => {
    const text = historyCsv([fillRow], TZ, 'excel-eu');
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text.slice(1).split('\r\n')[0]).toBe(CSV_COLUMNS.join(';'));
    expect(text.endsWith('\r\n')).toBe(true);
    expect(text.replace(/\r\n/g, '').includes('\n')).toBe(false);
    expect(text.toLowerCase()).not.toContain('sep=');
    expect(historyCsv([], TZ, 'excel-eu')).toBe(`﻿${CSV_COLUMNS.join(';')}\r\n`);
  });

  it('writes comma decimals in every numeric column, every digit kept and nothing quoted', () => {
    const text = historyCsv([fillRow], TZ, 'excel-eu');
    const line = parse(text.slice(1), ';')[1]!;
    const r = Object.fromEntries(CSV_COLUMNS.map((c, i) => [c, line[i]!]));
    expect(r).toMatchObject({
      qty: '0,00123456',
      price: '67890,12',
      quote: '83,8147',
      fee: '0,000001234',
      fee_usd: '0,0838',
      slippage_usd: '0,0012',
      drift_usd: '-0,0034',
      best_at_arrival: '67889,99',
      best_at_submit_or_trigger: '67880,5',
      trigger_price: '67000,5',
      realized_pnl: '-12,5',
    });
    expect(text).toContain(';0,000001234;');
    expect(text).toContain(';-12,5;');
    expect(text).not.toMatch(/"-?\d+,\d+"/);
  });

  it('keeps an integer amount as it is and converts a decimal one', () => {
    const get = (amount: string) =>
      parse(historyCsv([transfer(amount)], TZ, 'excel-eu').slice(1), ';')[1]![CSV_COLUMNS.indexOf('amount')];
    expect(get('250')).toBe('250');
    expect(get('250.75')).toBe('250,75');
    expect(get('-0.5')).toBe('-0,5');
  });

  it('leaves non-numeric text in a numeric column, and every other column, unchanged', () => {
    const r = parse(historyCsv([transfer('1.5 USDT')], TZ, 'excel-eu').slice(1), ';')[1]!;
    expect(r[CSV_COLUMNS.indexOf('amount')]).toBe('1.5 USDT');
    expect(r[CSV_COLUMNS.indexOf('time_utc')]).toBe('2026-10-18T21:05:09.123Z');
    expect(r[CSV_COLUMNS.indexOf('id')]).toBe('7');
  });

  it.each(['standard', 'excel-eu'] as const)('quotes text with a comma, a semicolon and a quote correctly in %s and reads it back', (format) => {
    const reason = 'bad, worse; "worst"';
    const text = historyCsv([row({ type: 'feed_gap', payload: { startedAt: T0, endedAt: T0 + 1000, reason } })], TZ, format);
    const r = parse(text.slice(1), SEP[format])[1]!;
    expect(r).toHaveLength(CSV_COLUMNS.length);
    expect(r[CSV_COLUMNS.indexOf('details')]).toContain(reason);
    expect(text).toContain('""worst""');
  });

  it('quotes a comma in a text field of the Excel format', () => {
    const text = historyCsv([row({ type: 'feed_gap', payload: { startedAt: T0, endedAt: T0 + 1000, reason: 'a, b' } })], TZ, 'excel-eu');
    expect(text).toContain(';"Data gap');
  });

  it.each(['standard', 'excel-eu'] as const)('reads a whole %s file back: rows, columns, estimated flag and exact numbers', (format) => {
    const rows = [
      fillRow,
      row({
        id: 2,
        type: 'fill',
        symbol: 'BTCUSDT',
        market: 'spot',
        payload: { fill: { ...fullFill, id: 'f2', realizedPnl: null }, order: order('market'), catchUp: { from: T0 - 1000, to: T0, basis: 'candle_worst_price' } },
      }),
      transfer('250'),
      row({ id: 4, type: 'funding', symbol: 'BTCUSDT', market: 'perp', payload: { market: 'perp', side: 'long', markPrice: '61000.25', amount: '-0.0123' } }),
      row({ id: 9, type: 'feed_gap', payload: { startedAt: T0, endedAt: T0 + 1000, reason: 'a; b, c' } }),
    ];
    const parsed = parse(historyCsv(rows, TZ, format).slice(1), SEP[format]);
    expect(parsed).toHaveLength(rows.length + 1);
    for (const line of parsed) expect(line).toHaveLength(CSV_COLUMNS.length);
    const rec = (i: number) => Object.fromEntries(CSV_COLUMNS.map((c, k) => [c, parsed[i]![k]!]));
    expect(rec(1).estimated).toBe('');
    expect(rec(2).estimated).toBe('yes');
    const num = (i: number, c: string) => (format === 'excel-eu' ? rec(i)[c]!.replace(',', '.') : rec(i)[c]!);
    expect(num(1, 'qty')).toBe('0.00123456');
    expect(num(1, 'fee')).toBe('0.000001234');
    expect(num(1, 'drift_usd')).toBe('-0.0034');
    expect(num(1, 'realized_pnl')).toBe('-12.5');
    expect(num(3, 'amount')).toBe('250');
    expect(num(4, 'price')).toBe('61000.25');
    expect(num(4, 'amount')).toBe('-0.0123');
    for (const c of NUMERIC) for (let i = 1; i <= rows.length; i++) expect(rec(i)[c]).not.toContain('"');
  });
});

describe('the remembered CSV format', () => {
  const store = (initial: Record<string, string> = {}) => {
    const data = { ...initial };
    return {
      data,
      getItem: (k: string) => data[k] ?? null,
      setItem: (k: string, v: string) => {
        data[k] = v;
      },
    };
  };

  it('round-trips a choice under sim-csv-format', () => {
    const s = store();
    saveCsvFormat(s, 'excel-eu');
    expect(s.data['sim-csv-format']).toBe('excel-eu');
    expect(loadCsvFormat(s)).toBe('excel-eu');
    saveCsvFormat(s, 'standard');
    expect(loadCsvFormat(s)).toBe('standard');
  });

  it('is standard when nothing, or something unknown, is stored', () => {
    expect(loadCsvFormat(store())).toBe('standard');
    expect(loadCsvFormat(store({ 'sim-csv-format': 'tsv' }))).toBe('standard');
    expect(loadCsvFormat(null)).toBe('standard');
  });

  it('is standard, and does not throw, when the storage throws', () => {
    const denied = () => {
      throw new Error('denied');
    };
    const bad = { getItem: denied, setItem: denied };
    expect(loadCsvFormat(bad)).toBe('standard');
    expect(() => saveCsvFormat(bad, 'excel-eu')).not.toThrow();
  });
});

describe('localTimeText', () => {
  it('formats YYYY-MM-DD HH:mm:ss in the given zone', () => {
    expect(localTimeText(T0, 'Europe/Istanbul')).toBe('2026-10-19 00:05:09');
    expect(localTimeText(T0, 'UTC')).toBe('2026-10-18 21:05:09');
  });

  it('writes midnight as 00, not 24', () => {
    expect(localTimeText(Date.UTC(2026, 0, 1, 0, 0, 0), 'UTC')).toBe('2026-01-01 00:00:00');
  });

  it('is empty for a time that is not a moment', () => {
    expect(localTimeText(Number.NaN, 'UTC')).toBe('');
  });
});

describe('fetchAllHistory', () => {
  const rowOf = (id: number): HistoryRow => ({ id, time: id, type: 'deposit', symbol: null, market: null, payload: null });

  it('pages with the cursor until nextBefore is null, in order, and reports progress', async () => {
    const pages: HistoryPage[] = [
      { rows: [rowOf(9), rowOf(8)], nextBefore: 8 },
      { rows: [rowOf(7), rowOf(6)], nextBefore: 6 },
      { rows: [rowOf(5)], nextBefore: null },
    ];
    const asked: (number | undefined)[] = [];
    const progress: number[] = [];
    const rows = await fetchAllHistory(
      async (before) => {
        asked.push(before);
        return pages[asked.length - 1]!;
      },
      (n) => progress.push(n),
    );
    expect(asked).toEqual([undefined, 8, 6]);
    expect(rows.map((r) => r.id)).toEqual([9, 8, 7, 6, 5]);
    expect(progress).toEqual([2, 4, 5]);
  });

  it('returns nothing for an empty history', async () => {
    expect(await fetchAllHistory(async () => ({ rows: [], nextBefore: null }))).toEqual([]);
  });

  it('rejects on an error and returns no partial rows', async () => {
    let n = 0;
    await expect(
      fetchAllHistory(async () => {
        if (++n === 2) throw new Error('boom');
        return { rows: [rowOf(1)], nextBefore: 1 };
      }),
    ).rejects.toThrow('boom');
  });

  it('stops with an error when the cursor does not move', async () => {
    await expect(fetchAllHistory(async (before) => ({ rows: [rowOf(3)], nextBefore: before ?? 4 }))).rejects.toThrow(/cursor/i);
  });
});
