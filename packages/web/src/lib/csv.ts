// History as a spreadsheet file (pure): one line per recorded event, exact decimals as recorded,
// in one of two formats, both UTF-8 with a byte order mark, RFC 4180 quoting and CRLF line ends:
// 'standard' (',' between fields, '.' as the decimal mark) and 'excel-eu' (';' between fields and
// ',' as the decimal mark in the numeric columns, which opens directly in Excel with Turkish or
// European settings). Also the paging loop that gathers every row a filter matches.
import type { HistoryPage, HistoryRow } from './api.ts';
import { describeEvent } from './history.ts';

export type CsvFormat = 'standard' | 'excel-eu';

export const CSV_COLUMNS = [
  'id',
  'time_utc',
  'time_local',
  'type',
  'market',
  'symbol',
  'side',
  'qty',
  'price',
  'quote',
  'fee',
  'fee_asset',
  'fee_usd',
  'liquidity',
  'slippage_usd',
  'drift_usd',
  'best_at_arrival',
  'best_at_submit_or_trigger',
  'trigger_price',
  'realized_pnl',
  'amount',
  'wallet',
  'estimated',
  'details',
] as const;

type Column = (typeof CSV_COLUMNS)[number];

/** The server's page size cap. */
export const EXPORT_PAGE_SIZE = 200;

/** 'YYYY-MM-DD HH:mm:ss' of a moment in a time zone; empty for a time that is not a moment. */
export function localTimeText(ms: number, tz: string): string {
  if (!Number.isFinite(ms)) return '';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const get = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

type Bag = Record<string, unknown> | null | undefined;

const obj = (v: unknown): Bag => (v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : null);
/** A recorded value as text; empty when the event has none. */
const text = (v: unknown): string => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');

/** The columns one event fills, from its payload; anything it lacks stays empty. */
function payloadColumns(row: HistoryRow): Partial<Record<Column, string>> {
  const p = obj(row.payload);
  if (!p) return {};
  switch (row.type) {
    case 'fill': {
      const f = obj(p.fill);
      return {
        side: text(f?.side),
        qty: text(f?.qty),
        price: text(f?.price),
        quote: text(f?.quote),
        fee: text(f?.fee),
        fee_asset: text(f?.feeAsset),
        fee_usd: text(f?.feeUsd),
        liquidity: text(f?.liquidity),
        slippage_usd: text(f?.slippageUsd),
        drift_usd: text(f?.driftUsd),
        best_at_arrival: text(f?.bestAtArrival),
        best_at_submit_or_trigger: text(f?.bestAtSubmit),
        trigger_price: text(f?.triggerPrice),
        realized_pnl: text(f?.realizedPnl),
      };
    }
    case 'order_placed':
    case 'order_cancelled':
    case 'cancel_rejected':
    case 'order_rejected':
    case 'order_triggered':
      return { side: text(obj(p.order)?.side) };
    case 'position_opened':
      return { side: text(obj(p.position)?.side) };
    case 'position_closed':
      return { side: text(obj(p.position)?.side), price: text(p.exitPrice), realized_pnl: text(p.realizedPnl) };
    case 'round_trip_closed':
      return { realized_pnl: text(obj(p.roundTrip)?.pnl) };
    case 'funding':
      return { side: text(p.side), price: text(p.markPrice), amount: text(p.amount) };
    case 'liquidation':
      return { side: text(obj(p.position)?.side), price: text(p.markPrice), amount: text(p.marginLost) };
    case 'deposit':
      return { amount: text(p.amount), wallet: text(p.wallet) };
    case 'transfer':
      return { amount: text(p.amount), wallet: `${text(p.from)}→${text(p.to)}` };
    default:
      return {};
  }
}

/** What History shows for the event: its title and each label: value, then any note and list. */
function detailsOf(row: HistoryRow): string {
  const v = describeEvent(row);
  const parts = [v.label, ...v.fields.map((f) => `${f.label}: ${f.value}`)];
  if (v.note) parts.push(`${v.note.label}: ${v.note.text}`);
  if (v.list) parts.push(`${v.list.label}: ${v.list.items.join('; ')}`);
  return parts.join(' · ');
}

function marketOf(row: HistoryRow): string {
  if (row.symbol === null) return '';
  const perp = row.market === 'perp' || obj(row.payload)?.market === 'perp';
  return perp ? 'perp' : 'spot';
}

/** Columns holding numbers; the Excel format gives these a decimal comma. */
const NUMERIC_COLUMNS: ReadonlySet<Column> = new Set<Column>([
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
]);

const PLAIN_DECIMAL = /^-?\d+(\.\d+)?$/;

/** One field, quoted when it holds a separator, a quote or a line break (quotes doubled). */
function quote(s: string, quoted: RegExp): string {
  return quoted.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Every row as a CSV file's text, newest first as given; `tz` is the zone of time_local.
 * 'standard' is ',' between fields and '.' decimals. 'excel-eu' is ';' between fields and, in the
 * numeric columns, ',' as the decimal mark on a plain decimal number (every digit kept, never
 * quoted so Excel still reads it as a number); a comma elsewhere is quoted.
 */
export function historyCsv(rows: HistoryRow[], tz: string, format: CsvFormat = 'standard'): string {
  const excel = format === 'excel-eu';
  const sep = excel ? ';' : ',';
  const quoted = excel ? /[;",\r\n]/ : /[",\r\n]/;
  const lines = [CSV_COLUMNS.join(sep)];
  for (const row of rows) {
    const cols: Record<Column, string> = {
      id: String(row.id),
      time_utc: Number.isFinite(row.time) ? new Date(row.time).toISOString() : '',
      time_local: localTimeText(row.time, tz),
      type: row.type,
      market: marketOf(row),
      symbol: row.symbol ?? '',
      side: '',
      qty: '',
      price: '',
      quote: '',
      fee: '',
      fee_asset: '',
      fee_usd: '',
      liquidity: '',
      slippage_usd: '',
      drift_usd: '',
      best_at_arrival: '',
      best_at_submit_or_trigger: '',
      trigger_price: '',
      realized_pnl: '',
      amount: '',
      wallet: '',
      estimated: obj(row.payload)?.catchUp ? 'yes' : '',
      details: detailsOf(row),
      ...payloadColumns(row),
    };
    lines.push(
      CSV_COLUMNS.map((c) => {
        const v = cols[c];
        return excel && NUMERIC_COLUMNS.has(c) && PLAIN_DECIMAL.test(v) ? v.replace('.', ',') : quote(v, quoted);
      }).join(sep),
    );
  }
  return `﻿${lines.join('\r\n')}\r\n`;
}

/**
 * Every row a filter matches: pages back with the server's cursor until it is null. Nothing is
 * returned unless every page arrived (an error rejects), and a cursor that does not move is an
 * error rather than an endless loop.
 */
export async function fetchAllHistory(
  fetchPage: (before?: number) => Promise<HistoryPage>,
  onProgress?: (rows: number) => void,
): Promise<HistoryRow[]> {
  const rows: HistoryRow[] = [];
  const seen = new Set<number>();
  let before: number | undefined;
  for (;;) {
    const page = await fetchPage(before);
    for (const r of page.rows) {
      if (!seen.has(r.id)) {
        seen.add(r.id);
        rows.push(r);
      }
    }
    onProgress?.(rows.length);
    if (page.nextBefore === null) return rows;
    if (page.nextBefore === before) throw new Error('The history cursor did not move');
    before = page.nextBefore;
  }
}
