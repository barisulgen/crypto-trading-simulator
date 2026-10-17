// Candle chart of the selected coin (lightweight-charts v5) with the owner's fills as markers.
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
  CandlestickData,
  DeepPartial,
  IChartApi,
  ISeriesApi,
  ISeriesMarkersPluginApi,
  ChartOptions,
  SeriesMarker,
  Time,
  UTCTimestamp,
} from 'lightweight-charts';
import { api, INTERVALS } from '../lib/api.ts';
import type { Candle, Interval, WireFill } from '../lib/api.ts';
import { fmtQty, tickDecimals } from '../lib/format.ts';
import { useLive } from '../lib/live.ts';
import { applyKline, fillMarkers, fmtChartTime, fmtTick, mergeCandles, toBar } from '../lib/market.ts';
import { Button, Segmented } from './ui.tsx';

/** Load older candles when the left edge of the view comes within this many bars of the oldest one. */
const LOAD_OLDER_WITHIN = 30;
const FILLS_LIMIT = 500;

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

/**
 * Candles of `symbol` at `interval`: history from GET /api/candles, the forming candle from the
 * live `kline` messages, older history loaded as the owner scrolls left, and a marker per fill.
 * Colours follow the light/dark theme; times show in local time. While the coin's feed is stale
 * the last-price line is dimmed.
 */
export function PriceChart({ symbol, interval }: { symbol: string; interval: Interval }) {
  const box = useRef<HTMLDivElement>(null);
  const live = useRef<Live | null>(null);
  const candles = useRef<Candle[]>([]);
  const fills = useRef<WireFill[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const fillSeq = useLive((s) => s.fillSeq);
  const fresh = useLive((s) => s.health[symbol]?.fresh !== false);
  const tick = useLive((s) => s.meta?.rules[symbol]?.tickSize);

  /** Redraw the fill markers for the candles now loaded. */
  const drawMarkers = () => {
    const l = live.current;
    const first = candles.current[0];
    const last = candles.current.at(-1);
    if (!l) return;
    if (!first || !last) return l.markers.setMarkers([]);
    const markers = fillMarkers(
      // Until this symbol's fills arrive, the list may still hold the previous symbol's.
      fills.current.filter((f) => f.symbol === symbol),
      interval,
      { from: first.time, to: last.time },
      { up: l.palette.up, down: l.palette.down },
      (q) => fmtQty(symbol, q),
    );
    l.markers.setMarkers(markers.map((m) => ({ ...m, time: m.time as UTCTimestamp }) satisfies SeriesMarker<Time>));
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
        // Room right of the forming candle, so its fill markers clear the price axis.
        rightOffset: 6,
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
    };
    const themeWatch = new MutationObserver(recolour);
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => {
      themeWatch.disconnect();
      live.current = null;
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

    api.candles(symbol, interval).then(
      (rows) => {
        if (!current) return;
        let all = mergeCandles([], rows);
        // A kline that arrived while the history loaded.
        const k = useLive.getState().kline;
        if (k && k.symbol === symbol && k.interval === interval) all = applyKline(all, k.candle) ?? all;
        show(all);
        l.chart.timeScale().scrollToRealTime();
        setStatus('ready');
      },
      (e: unknown) => {
        if (!current) return;
        setError((e as Error).message);
        setStatus('error');
      },
    );

    const unsubscribe = useLive.subscribe((s, prev) => {
      const k = s.kline;
      if (k === prev.kline || !k || k.symbol !== symbol || k.interval !== interval) return;
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
      api.candles(symbol, interval, oldest.time - 1).then(
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
  }, [symbol, interval, attempt]);

  // The owner's fills: on symbol change and after every fill notice (kept on screen while reloading).
  useEffect(() => {
    let current = true;
    api.fills({ symbol, limit: FILLS_LIMIT }).then(
      (rows) => {
        if (!current) return;
        fills.current = rows;
        redraw.current();
      },
      () => {}, // markers are an extra: on failure they stay as they were until the next fill
    );
    return () => {
      current = false;
    };
  }, [symbol, fillSeq]);

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
