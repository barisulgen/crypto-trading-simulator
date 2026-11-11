// What every chart shares: the theme tokens as colours, the base chart options, and local-time
// axis labels (chart times stay true UTC timestamps).
import { ColorType, CrosshairMode, LineStyle, TickMarkType } from 'lightweight-charts';
import type { ChartOptions, DeepPartial, Time } from 'lightweight-charts';
import { fmtTick } from '../lib/market.ts';

export interface Palette {
  panel: string;
  line: string;
  fg: string;
  muted: string;
  faint: string;
  raised: string;
  up: string;
  down: string;
  downSoft: string;
  focus: string;
}

/** The theme tokens (styles/theme.css) as the chart's colours; read again on every theme switch. */
export function readPalette(): Palette {
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
    downSoft: v('down-soft'),
    focus: v('focus'),
  };
}

export function chartOptions(p: Palette): DeepPartial<ChartOptions> {
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

/** Local-time axis labels; chart times stay true UTC timestamps. */
export function tickLabel(time: Time, type: TickMarkType): string {
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
