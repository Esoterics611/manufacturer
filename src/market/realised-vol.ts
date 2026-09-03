/**
 * Realised volatility from a price series.
 *
 * The facility's haircut prices off USD/ILS volatility, and until now that input
 * was a guess carried over from a research document. It no longer has to be:
 * the Bank of Israel publishes its daily representative rate through a public
 * SDMX endpoint, so the number can be computed from the primary source and
 * re-computed every morning.
 *
 * Log returns, sample standard deviation, annualised on 252 trading days. No
 * EWMA and no GARCH: the facility needs a number it can publish in a term sheet
 * and defend to a holder who recomputes it, and a decay parameter nobody can
 * check is worse than a slightly stale estimate that anybody can.
 */

import { Fixed, Rounding } from '../domain/fixed';

export const TRADING_DAYS_PER_YEAR = 252;

export interface PricePoint {
  /** ISO date, `YYYY-MM-DD`. */
  readonly date: string;
  readonly rate: number;
}

export interface VolWindow {
  readonly label: string;
  readonly observations: number;
  readonly annualised: Fixed;
}

export interface VolReport {
  readonly source: string;
  readonly firstDate: string;
  readonly lastDate: string;
  readonly lastRate: Fixed;
  readonly observations: number;
  readonly windows: readonly VolWindow[];
  /** The window the engine should price off. */
  readonly headline: VolWindow;
  /** Largest single-day move in the most recent 30 sessions, as a fraction. */
  readonly maxDailyMove30d: Fixed;
}

function logReturns(px: readonly PricePoint[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < px.length; i++) {
    const a = px[i - 1]!.rate;
    const b = px[i]!.rate;
    if (a > 0 && b > 0) out.push(Math.log(b / a));
  }
  return out;
}

function sampleStdev(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const ss = xs.reduce((a, b) => a + (b - mean) ** 2, 0);
  return Math.sqrt(ss / (xs.length - 1));
}

/** Annualised realised volatility over the last `window` returns; 0 means all of them. */
export function realisedVol(px: readonly PricePoint[], window = 0): Fixed {
  const lr = logReturns(px);
  const slice = window > 0 ? lr.slice(-window) : lr;
  const v = sampleStdev(slice) * Math.sqrt(TRADING_DAYS_PER_YEAR);
  return Fixed.fromNumber(v, 6, Rounding.HalfEven);
}

/**
 * The headline window is one year.
 *
 * Thirty days is too jumpy to publish a haircut against — it halves and doubles
 * on single events. The full sample spans the 2023-24 war period and overstates
 * a calmer regime. A year is long enough to be stable and short enough to be
 * about the market the fund is actually trading in, and the report prints the
 * others alongside so the choice is visible rather than assumed.
 */
export function volReport(px: readonly PricePoint[], source: string): VolReport {
  const sorted = [...px].sort((a, b) => a.date.localeCompare(b.date));
  if (sorted.length < 2) throw new RangeError('need at least two observations');

  const windows: VolWindow[] = [
    { label: '30d', observations: 30, annualised: realisedVol(sorted, 30) },
    { label: '90d', observations: 90, annualised: realisedVol(sorted, 90) },
    { label: '1y', observations: 252, annualised: realisedVol(sorted, 252) },
    { label: 'full', observations: sorted.length - 1, annualised: realisedVol(sorted, 0) },
  ];
  const headline = windows.find((w) => w.label === '1y')!;

  const recent = logReturns(sorted).slice(-30).map(Math.abs);
  const maxDaily = recent.length ? Math.max(...recent) : 0;

  return {
    source,
    firstDate: sorted[0]!.date,
    lastDate: sorted[sorted.length - 1]!.date,
    lastRate: Fixed.fromNumber(sorted[sorted.length - 1]!.rate, 4),
    observations: sorted.length,
    windows,
    headline,
    maxDailyMove30d: Fixed.fromNumber(maxDaily, 6),
  };
}

/**
 * How many sigmas the largest recent daily move was.
 *
 * The number that decides whether a haircut is a price or a giveaway. If the
 * facility's cover is 1.5 sigma and the market printed 2.5 last week, the cover
 * is not cover.
 */
export function stressSigmas(r: VolReport): Fixed {
  const dailySigma = r.headline.annualised.toNumber() / Math.sqrt(TRADING_DAYS_PER_YEAR);
  if (dailySigma === 0) return Fixed.zero(2);
  return Fixed.fromNumber(r.maxDailyMove30d.toNumber() / dailySigma, 2);
}

/** Parse the Bank of Israel SDMX CSV export of a representative-rate series. */
export function parseBoiCsv(text: string): PricePoint[] {
  const lines = text.replace(/\r/g, '').split('\n').filter((l) => l.trim());
  const header = lines[0]!.split(',');
  const iDate = header.indexOf('TIME_PERIOD');
  const iVal = header.indexOf('OBS_VALUE');
  if (iDate < 0 || iVal < 0) throw new SyntaxError('not a BOI SDMX csv export');
  const out: PricePoint[] = [];
  for (const line of lines.slice(1)) {
    const cells = line.split(',');
    const date = cells[iDate];
    const raw = cells[iVal];
    if (!date || !raw) continue;
    const rate = Number(raw);
    if (Number.isFinite(rate) && rate > 0) out.push({ date, rate });
  }
  return out;
}
