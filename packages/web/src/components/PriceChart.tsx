// Candle chart of the selected coin and market (lightweight-charts v5) with the owner's fills as
// markers and, on a perpetual with an open position, its entry and liquidation prices.
import { useEffect, useRef, useState } from 'react';
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  LineStyle,
  TickMarkType,
  createChart,
  createSeriesMarkers,
} from 'lightweight-charts';
import type {
  AutoscaleInfo,
  CandlestickData,
  DeepPartial,
  IChartApi,
  IPriceLine,
  ISeriesApi,
  ISeriesMarkersPluginApi,
  ChartOptions,
  SeriesMarker,
  Time,
  UTCTimestamp,
} from 'lightweight-charts';
import { api, INTERVALS } from '../lib/api.ts';
import type { Candle, Interval, Market, WireFillRow } from '../lib/api.ts';
import { fmtQty, tickDecimals } from '../lib/format.ts';
import { feedOf, useLive } from '../lib/live.ts';
import type { LiveState } from '../lib/live.ts';
import {
  applyKline,
  fillMarkers,
  fmtChartTime,
  fmtTick,
  liquidationMark,
  mergeCandles,
  perpMarkers,
  toBar,
} from '../lib/market.ts';
import type { LiquidationMark } from '../lib/market.ts';
import { chartLines } from '../lib/positions.ts';
import { Button, Segmented } from './ui.tsx';

/** Load older candles when the left edge of the view comes within this many bars of the oldest one. */
const LOAD_OLDER_WITHIN = 30;
const FILLS_LIMIT = 500;
/** Bars of room right of the forming candle, so its fill markers clear the price axis. */
const RIGHT_OFFSET = 6;
/** The same with a position's entry and liquidation labels at the right edge. */
const LABELLED_RIGHT_OFFSET = 16;
/** Liquidations loaded for the perp chart's markers (the history API's page limit). */
const LIQUIDATIONS_LIMIT = 200;

/** The 1m-1d timeframe switch (chart panel header). */
export function IntervalPicker() {
  const interval = useLive((s) => s.interval);
  const setInterval = useLive((s) => s.setInterval);
  return (
    <Segmented
      label="Timeframe"
      value={interval}
      onChange={setInterval}
      options={INTERVALS.map((i) => ({ value: i, label: i }))}
      className="flex-none"
    />
  );
}

interface Palette {
  panel: string;
  line: string;
  fg: string;
  muted: string;
  faint: string;
  raised: string;
  up: string;
  down: string;
}

/** The theme tokens (styles/theme.css) as the chart's colours; read again on every theme switch. */
function readPalette(): Palette {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(`--ink-${name}`).trim();
  return {
    panel: v('panel'),
    line: v('line'),
    fg: v('fg'),
    muted: v('muted'),
    faint: v('faint'),
    raised: v('raised'),
    up: v('up'),
    down: v('down'),
  };
}

function chartOptions(p: Palette): DeepPartial<ChartOptions> {
  const axisLabel = { color: p.faint, labelBackgroundColor: p.raised, style: LineStyle.Dashed, width: 1 as const };
  return {
    layout: {
      background: { type: ColorType.Solid, color: p.panel },
      textColor: p.muted,
      fontFamily: "'Archivo Variable', 'Archivo', system-ui, sans-serif",
      fontSize: 11,
    },
    grid: { vertLines: { color: p.raised }, horzLines: { color: p.raised } },
    crosshair: { mode: CrosshairMode.Normal, vertLine: axisLabel, horzLine: axisLabel },
    rightPriceScale: { borderColor: p.line },
    timeScale: { borderColor: p.line },
  };
}

/** Local-time axis labels; candle times stay true UTC timestamps. */
function tickLabel(time: Time, type: TickMarkType): string {
  const ms = (time as number) * 1000;
  switch (type) {
    case TickMarkType.Year:
      return fmtTick(ms, 'year');
    case TickMarkType.Month:
      return fmtTick(ms, 'month');
    case TickMarkType.DayOfMonth:
      return fmtTick(ms, 'day');
    default:
      return fmtTick(ms, 'time');
  }
}

const bar = (c: Candle): CandlestickData<Time> => {
  const b = toBar(c);
  return { ...b, time: b.time as UTCTimestamp };
};

interface Live {
  chart: IChartApi;
  series: ISeriesApi<'Candlestick'>;
  markers: ISeriesMarkersPluginApi<Time>;
  palette: Palette;
}

/** The owner's fills (and, for a perpetual, liquidations) of one market and symbol, for the markers. */
interface MarkerData {
  market: Market;
  symbol: string;
  /** Newest first, as GET /api/fills returns them. */
  fills: WireFillRow[];
  liquidations: LiquidationMark[];
  /** False when the fill list stopped at its limit (older fills exist). */
  complete: boolean;
}

/**
 * Candles of `symbol` in `market` at `interval`: history from GET /api/candles, the forming candle
 * from the live `kline` messages, older history loaded as the owner scrolls left, and a marker
 * per fill (on a perpetual: entries, increases, reductions, closes and liquidations). With an
 * open perp position, its entry price is a line and its liquidation price a red line labelled
 * 'Liq.' and the price. Colours follow the light/dark theme; times show in local time. While the
 * market's feed is stale the last-price line is dimmed, and the position's lines while its mark is
 * stale or our connection is down.
 */
export function PriceChart({ market, symbol, interval }: { market: Market; symbol: string; interval: Interval }) {
  const box = useRef<HTMLDivElement>(null);
  const live = useRef<Live | null>(null);
  const candles = useRef<Candle[]>([]);
  const markerData = useRef<MarkerData | null>(null);
  const positionLines = useRef<IPriceLine[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const fillSeq = useLive((s) => s.fillSeq);
  const reconnects = useLive((s) => s.reconnects);
  const fresh = useLive((s) => feedOf(s, market, symbol)?.fresh !== false);
  const tick = useLive((s) =>
    market === 'perp' ? s.meta?.perp?.[symbol]?.rules?.tickSize : s.meta?.rules[symbol]?.tickSize,
  );
  // The open position's prices only (not the position, which is pushed anew every second).
  const position = (s: LiveState) => (market === 'perp' ? s.positions?.find((p) => p.symbol === symbol) : undefined);
  const entryPrice = useLive((s) => chartLines(position(s), tick, s.conn !== 'open').entry);
  // At the tick, rounded towards the mark as the notices show it; the axis label shows exactly this.
  const liqPrice = useLive((s) => chartLines(position(s), tick, s.conn !== 'open').liq);
  // Dimmed like the last-price line while our connection is down or the position's mark is not
  // live: the prices themselves hold, but how near the mark is to them cannot be judged.
  const linesLive = useLive((s) => !chartLines(position(s), tick, s.conn !== 'open').dimmed);

  /** Redraw the fill markers for the candles now loaded. */
  const drawMarkers = () => {
    const l = live.current;
    const first = candles.current[0];
    const last = candles.current.at(-1);
    const data = markerData.current;
    if (!l) return;
    // Until this market and symbol's fills arrive, the data may still be the previous one's.
    if (!first || !last || !data || data.market !== market || data.symbol !== symbol) return l.markers.setMarkers([]);
    const range = { from: first.time, to: last.time };
    const colors = { up: l.palette.up, down: l.palette.down };
    const qty = (q: string) => fmtQty(symbol, q, { market });
    const markers =
      market === 'perp'
        ? perpMarkers(data.fills, data.liquidations, { complete: data.complete }, interval, range, colors, qty)
        : fillMarkers(data.fills, interval, range, colors, qty);
    l.markers.setMarkers(markers.map((m) => ({ ...m, time: m.time as UTCTimestamp }) satisfies SeriesMarker<Time>));
  };
  /** The open position's entry line and red liquidation-price line (none without a position). */
  const drawPositionLines = () => {
    const l = live.current;
    if (!l) return;
    for (const line of positionLines.current) l.series.removePriceLine(line);
    positionLines.current = [];
    // The chart draws each title beside the line's price on the axis: 'Liq.' then the price.
    const greyed = { color: l.palette.faint, style: LineStyle.Dotted };
    const entry = { title: 'Entry', width: 1 as const, ...(linesLive ? { color: l.palette.muted, style: LineStyle.Dashed } : greyed) };
    const liq = { title: 'Liq.', width: 2 as const, ...(linesLive ? { color: l.palette.down, style: LineStyle.Solid } : greyed) };
    const lines = [
      entryPrice !== null && { ...entry, price: entryPrice },
      liqPrice !== null && { ...liq, price: liqPrice },
    ].filter((x) => x !== false);
    for (const line of lines) {
      positionLines.current.push(
        l.series.createPriceLine({
          price: Number(line.price),
          color: line.color,
          lineWidth: line.width,
          lineStyle: line.style,
          axisLabelVisible: true,
          title: line.title,
        }),
      );
    }
    // The price scale stretches to keep both lines in view, however far the liquidation price is.
    const prices = lines.map((x) => Number(x.price));
    l.series.applyOptions({
      autoscaleInfoProvider: (original: () => AutoscaleInfo | null) => {
        const res = original();
        if (!res?.priceRange || prices.length === 0) return res;
        return {
          ...res,
          priceRange: {
            minValue: Math.min(res.priceRange.minValue, ...prices),
            maxValue: Math.max(res.priceRange.maxValue, ...prices),
          },
        };
      },
    });
    // Room right of the latest candle for the line labels, so its fill markers stay clear of them
    // (changed only when the lines come or go: setting it scrolls the view).
    const rightOffset = lines.length > 0 ? LABELLED_RIGHT_OFFSET : RIGHT_OFFSET;
    if (l.chart.timeScale().options().rightOffset !== rightOffset) l.chart.timeScale().applyOptions({ rightOffset });
  };
  /** The last-price line (and its axis label): dimmed while the coin's feed is stale. */
  const styleLastPrice = () => {
    const l = live.current;
    l?.series.applyOptions(
      fresh
        ? { priceLineColor: '', priceLineStyle: LineStyle.Dashed }
        : { priceLineColor: l.palette.faint, priceLineStyle: LineStyle.Dotted },
    );
  };
  // Effects below always call the latest closures.
  const redraw = useRef(drawMarkers);
  redraw.current = drawMarkers;
  const restyle = useRef(styleLastPrice);
  restyle.current = styleLastPrice;
  const relines = useRef(drawPositionLines);
  relines.current = drawPositionLines;

  // The chart itself: created once, recoloured on every theme switch.
  useEffect(() => {
    const el = box.current!;
    const palette = readPalette();
    const chart = createChart(el, {
      ...chartOptions(palette),
      autoSize: true,
      localization: { timeFormatter: (t: Time) => fmtChartTime((t as number) * 1000) },
      timeScale: {
        borderColor: palette.line,
        timeVisible: true,
        secondsVisible: false,
        rightOffset: RIGHT_OFFSET,
        tickMarkFormatter: tickLabel,
      },
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: palette.up,
      downColor: palette.down,
      borderUpColor: palette.up,
      borderDownColor: palette.down,
      wickUpColor: palette.up,
      wickDownColor: palette.down,
    });
    const markers = createSeriesMarkers(series, []);
    live.current = { chart, series, markers, palette };

    const recolour = () => {
      const p = readPalette();
      live.current = { chart, series, markers, palette: p };
      chart.applyOptions(chartOptions(p));
      series.applyOptions({
        upColor: p.up,
        downColor: p.down,
        borderUpColor: p.up,
        borderDownColor: p.down,
        wickUpColor: p.up,
        wickDownColor: p.down,
      });
      redraw.current();
      restyle.current();
      relines.current();
    };
    const themeWatch = new MutationObserver(recolour);
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => {
      themeWatch.disconnect();
      live.current = null;
      positionLines.current = [];
      chart.remove();
    };
  }, []);

  // Axis prices with the coin's tick decimals and thousands separators, like the rest of the screen.
  useEffect(() => {
    if (!tick) return;
    const dp = tickDecimals(tick);
    const nf = new Intl.NumberFormat('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
    live.current?.series.applyOptions({
      priceFormat: { type: 'custom', minMove: Number(tick), formatter: (p: number) => nf.format(p) },
    });
  }, [tick]);

  // A stale feed dims the last-price line: the price may be out of date.
  useEffect(() => restyle.current(), [fresh]);

  // The position's lines follow its entry and liquidation price (and go with the position).
  useEffect(() => relines.current(), [market, symbol, entryPrice, liqPrice, tick, linesLive]);

  // History, live candles and older pages for this symbol and interval.
  useEffect(() => {
    const l = live.current!;
    let current = true;
    let exhausted = false;
    let loadingOlder = false;
    candles.current = [];
    l.series.setData([]);
    redraw.current();
    setStatus('loading');

    const show = (rows: Candle[]) => {
      candles.current = rows;
      l.series.setData(rows.map(bar));
      redraw.current();
    };

    /** The kline the store holds now, if it belongs to this chart (it may be newer than the history). */
    const withKline = (rows: Candle[]) => {
      const k = useLive.getState().kline;
      return k && k.market === market && k.symbol === symbol && k.interval === interval
        ? (applyKline(rows, k.candle) ?? rows)
        : rows;
    };

    api.candles(symbol, interval, undefined, market).then(
      (rows) => {
        if (!current) return;
        show(withKline(mergeCandles([], rows)));
        l.chart.timeScale().scrollToRealTime();
        setStatus('ready');
      },
      (e: unknown) => {
        if (!current) return;
        setError((e as Error).message);
        setStatus('error');
      },
    );

    // After a reconnect: reload the latest page and merge it in, repairing candles missed while
    // we were offline. An outage longer than one page leaves a gap, so then start over from it.
    const repair = () => {
      api.candles(symbol, interval, undefined, market).then(
        (rows) => {
          if (!current || rows.length === 0) return;
          const latest = mergeCandles([], rows);
          const last = candles.current.at(-1);
          const gap = !last || latest[0]!.time > last.time;
          if (gap) exhausted = false;
          show(withKline(gap ? latest : mergeCandles(candles.current, latest)));
          if (!last) l.chart.timeScale().scrollToRealTime();
          setStatus('ready');
        },
        (e: unknown) => console.warn(`Could not reload candles after reconnecting: ${(e as Error).message}`),
      );
    };

    const unsubscribe = useLive.subscribe((s, prev) => {
      if (s.reconnects !== prev.reconnects) repair();
      const k = s.kline;
      if (k === prev.kline || !k || k.market !== market || k.symbol !== symbol || k.interval !== interval) return;
      const next = applyKline(candles.current, k.candle);
      if (!next) return;
      const added = next.length > candles.current.length;
      candles.current = next;
      l.series.update(bar(k.candle));
      if (added) redraw.current();
    });

    const loadOlder = () => {
      const oldest = candles.current[0];
      if (!oldest || exhausted || loadingOlder) return;
      loadingOlder = true;
      api.candles(symbol, interval, oldest.time - 1, market).then(
        (rows) => {
          loadingOlder = false;
          if (!current) return;
          const older = rows.filter((c) => c.time < oldest.time);
          if (older.length === 0) {
            exhausted = true;
            return;
          }
          show(mergeCandles(older, candles.current));
        },
        () => {
          loadingOlder = false; // try again on the next scroll
        },
      );
    };
    const onRange = (range: { from: number } | null) => {
      if (range && range.from < LOAD_OLDER_WITHIN) loadOlder();
    };
    l.chart.timeScale().subscribeVisibleLogicalRangeChange(onRange);

    return () => {
      current = false;
      unsubscribe();
      l.chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRange);
    };
  }, [market, symbol, interval, attempt]);

  // The owner's fills (and a perpetual's liquidations): on a market or symbol change, whenever
  // fills may have changed (fillSeq) and after a reconnect. The previous markers stay on screen
  // while reloading and if a reload fails.
  useEffect(() => {
    let current = true;
    const fills = api.fills({ symbol, limit: FILLS_LIMIT, market });
    const liquidations =
      market === 'perp'
        ? api
            .history({ symbol, market: 'perp', types: ['liquidation'], limit: LIQUIDATIONS_LIMIT })
            .then((page) => page.rows.flatMap((r) => liquidationMark(r) ?? []))
        : Promise.resolve([]);
    Promise.all([fills, liquidations]).then(
      ([rows, liqs]) => {
        if (!current) return;
        markerData.current = { market, symbol, fills: rows, liquidations: liqs, complete: rows.length < FILLS_LIMIT };
        redraw.current();
      },
      (e: unknown) => console.warn(`Could not load fills for the chart markers: ${(e as Error).message}`),
    );
    return () => {
      current = false;
    };
  }, [market, symbol, fillSeq, reconnects]);

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={box} className="absolute inset-0" />
      {status !== 'ready' && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 p-6 text-center text-xs">
          {status === 'loading' ? (
            <span className="text-faint">Loading candles</span>
          ) : (
            <>
              <span className="text-muted">Could not load candles: {error}</span>
              <Button onClick={() => setAttempt((n) => n + 1)}>Retry</Button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
