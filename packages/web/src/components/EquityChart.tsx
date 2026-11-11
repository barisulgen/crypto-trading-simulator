// The Stats page's equity chart (lightweight-charts v5). Top pane: the curve, what was put in as a
// step line and, for the whole account, the BTC buy-and-hold benchmark, with deposits (or a
// wallet's transfers) marked and every drawdown period shaded. Bottom pane: how far the P&L is
// below its running peak.
import { useEffect, useMemo, useRef, useState } from 'react';
import { BaselineSeries, LineSeries, LineStyle, LineType, createChart, createSeriesMarkers } from 'lightweight-charts';
import type {
  IChartApi,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesPrimitive,
  SeriesAttachedParameter,
  SeriesMarker,
  Time,
  UTCTimestamp,
} from 'lightweight-charts';
import type { WireStatsReport } from '../lib/api.ts';
import { baselinePoints, chartCaption, chartData, chartLegend, edgeRoom, linePoints } from '../lib/equityChart.ts';
import type { ChartMarker, ChartShade } from '../lib/equityChart.ts';
import { fmtChartTime } from '../lib/market.ts';
import { chartOptions, readPalette, tickLabel } from './chartTheme.ts';
import type { Palette } from './chartTheme.ts';

const AXIS = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** Axis and crosshair dollars: '$1,234.56', '-$350.00'. */
const axisUsd = (p: number) => `${p < 0 ? '-' : ''}$${AXIS.format(Math.abs(p))}`;

const NONE = 'transparent';
const FONT = "11px 'Archivo Variable', 'Archivo', system-ui, sans-serif";
/** Space kept beside a marker label, besides half its width. */
const LABEL_PAD = 6;

/** Half the widest marker label in pixels, plus a little: the room needed at each end of the curve. */
function labelRoom(markers: ChartMarker[]): number {
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) return 40;
  ctx.font = FONT;
  return Math.max(0, ...markers.map((m) => ctx.measureText(m.text).width)) / 2 + LABEL_PAD;
}

/** Fills each drawdown period across the full height of the pane, behind the lines. */
class DrawdownShading implements ISeriesPrimitive<Time> {
  private chart: IChartApi | null = null;
  private readonly shades: ChartShade[];
  private readonly color: string;
  private readonly views: readonly IPrimitivePaneView[];

  constructor(shades: ChartShade[], color: string) {
    this.shades = shades;
    this.color = color;
    const renderer: IPrimitivePaneRenderer = { draw: (target) => this.draw(target) };
    this.views = [{ zOrder: () => 'bottom', renderer: () => renderer }];
  }

  attached(param: SeriesAttachedParameter<Time>): void {
    this.chart = param.chart as IChartApi;
  }

  detached(): void {
    this.chart = null;
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this.views;
  }

  private draw(target: Parameters<IPrimitivePaneRenderer['draw']>[0]): void {
    const scale = this.chart?.timeScale();
    if (!scale) return;
    target.useBitmapCoordinateSpace(({ context, bitmapSize, horizontalPixelRatio }) => {
      context.fillStyle = this.color;
      for (const s of this.shades) {
        const from = scale.timeToCoordinate(s.from as UTCTimestamp);
        const to = scale.timeToCoordinate(s.to as UTCTimestamp);
        if (from === null || to === null) continue;
        const left = Math.round(from * horizontalPixelRatio);
        context.fillRect(left, 0, Math.max(1, Math.round(to * horizontalPixelRatio) - left), bitmapSize.height);
      }
    });
  }
}

function marker(m: ChartMarker, p: Palette): SeriesMarker<Time> {
  const time = m.time as UTCTimestamp;
  // Above the line, so the line never strikes the label through.
  if (m.kind === 'deposit') return { time, position: 'aboveBar', shape: 'arrowUp', color: p.fg, text: m.text };
  return { time, position: 'aboveBar', shape: 'circle', color: p.muted, text: m.text };
}

function Swatch({ className }: { className: string }) {
  return <span aria-hidden className={`inline-block w-4 flex-none ${className}`} />;
}

/**
 * The equity curve of a stats report. `unrealisedAdded`: a coin's last point includes what it
 * holds now, as the page's headline says.
 */
export function EquityChart({ report, unrealisedAdded }: { report: WireStatsReport; unrealisedAdded: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const [themes, setThemes] = useState(0);
  const data = useMemo(() => chartData(report), [report]);
  // Points in the same second are one point on the chart.
  const enough = data.value.filter((x) => 'value' in x).length >= 2;
  const scope = report.headline.scope;
  const coin = scope.kind === 'coin';
  const legend = chartLegend(scope, data.benchmark.length > 0);

  // Redrawn in the new colours on every theme switch.
  useEffect(() => {
    const watch = new MutationObserver(() => setThemes((n) => n + 1));
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => watch.disconnect();
  }, []);

  useEffect(() => {
    if (!enough) return;
    const p = readPalette();
    const base = chartOptions(p);
    const chart = createChart(box.current!, {
      ...base,
      layout: { ...base.layout, panes: { separatorColor: p.line, enableResize: false } },
      // Room above the curve for the marker labels; a price label that does not fit is left out.
      rightPriceScale: { ...base.rightPriceScale, scaleMargins: { top: 0.15, bottom: 0.08 }, entireTextOnly: true },
      autoSize: true,
      localization: { timeFormatter: (t: Time) => fmtChartTime((t as number) * 1000), priceFormatter: axisUsd },
      timeScale: {
        borderColor: p.line,
        timeVisible: true,
        secondsVisible: false,
        minBarSpacing: 0.01,
        tickMarkFormatter: tickLabel,
      },
      // The page scrolls under a finger; only sideways drags move the chart.
      handleScroll: { vertTouchDrag: false },
    });
    // A coin's realised P&L only changes at its trades: held flat between them, never sloped.
    const lineType = coin ? LineType.WithSteps : LineType.Simple;
    const quiet = { priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false } as const;
    const deposited = chart.addSeries(LineSeries, {
      ...quiet,
      color: p.muted,
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      lineType: LineType.WithSteps,
    });
    deposited.setData(linePoints(data.deposited));
    if (data.benchmark.length > 0) {
      chart.addSeries(LineSeries, { ...quiet, color: p.focus, lineWidth: 1 }).setData(linePoints(data.benchmark));
    }
    const value = chart.addSeries(LineSeries, { color: p.fg, lineWidth: 2, lineType, priceLineVisible: false });
    value.setData(linePoints(data.value));
    value.attachPrimitive(new DrawdownShading(data.shades, p.downSoft));
    createSeriesMarkers(value, data.markers.map((m) => marker(m, p)));
    chart
      .addSeries(
        BaselineSeries,
        {
          priceLineVisible: false,
          baseValue: { type: 'price', price: 0 },
          topLineColor: NONE,
          topFillColor1: NONE,
          topFillColor2: NONE,
          bottomLineColor: p.down,
          bottomFillColor1: p.downSoft,
          bottomFillColor2: p.downSoft,
          lineWidth: 1,
          lineType,
        },
        1,
      )
      .setData(baselinePoints(data.underwater));
    const [top, bottom] = chart.panes();
    top?.setStretchFactor(3);
    bottom?.setStretchFactor(1);
    // The whole curve, with room at both ends for the labels of markers on its first and last
    // points, sized in pixels once the chart knows its width (and again when that changes).
    const count = new Set([...data.value, ...data.benchmark, ...data.underwater].map((x) => x.time)).size;
    const roomPx = labelRoom(data.markers);
    const fit = (width: number) => {
      const room = edgeRoom(count, width, roomPx);
      chart.timeScale().setVisibleLogicalRange({ from: -room, to: count - 1 + room });
    };
    fit(box.current!.clientWidth);
    chart.timeScale().subscribeSizeChange(fit);
    return () => {
      chart.timeScale().unsubscribeSizeChange(fit);
      chart.remove();
    };
  }, [data, enough, coin, themes]);

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 pt-2 text-2xs">
        <span className="mr-auto flex flex-col">
          <span className="font-semibold text-fg">{chartCaption(scope, unrealisedAdded)}</span>
          {enough && data.offCurve !== null && <span className="text-faint">{data.offCurve}</span>}
        </span>
        {enough && (
          <ul className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted">
            <li className="flex items-center gap-1.5">
              <Swatch className="h-0.5 bg-fg" />
              {legend.value}
            </li>
            <li className="flex items-center gap-1.5">
              <Swatch className="border-t border-dashed border-muted" />
              {legend.deposited}
            </li>
            {legend.benchmark !== null && (
              <li className="flex items-center gap-1.5">
                <Swatch className="h-0.5 bg-focus" />
                {legend.benchmark}
              </li>
            )}
            <li className="flex items-center gap-1.5">
              <Swatch className="h-2.5 border-b border-down bg-down-soft" />
              Below the peak
            </li>
          </ul>
        )}
      </div>
      {enough ? (
        <div className="relative h-72 desk:h-96">
          <div ref={box} className="absolute inset-0" />
        </div>
      ) : (
        <p className="px-3 py-10 text-center text-xs text-muted">Not enough history for a curve yet</p>
      )}
    </div>
  );
}
