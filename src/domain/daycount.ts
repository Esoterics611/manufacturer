/**
 * Day-count fractions.
 *
 * The two conventions the fund actually needs:
 *   ACT/360  — USD money market, and the USD leg of every FX forward.
 *   ACT/365F — the shekel money market and Makam.  [VERIFY with Israeli counsel
 *              /the administrator before the first published NAV: the ILS money
 *              market convention is the one input here we have not sourced.]
 *
 * A mismatched basis between the two legs is worth ~1.4% of the rate differential
 * (365/360 - 1), which at a 4% rate is 5.5bp — larger than the fee tolerance and
 * invisible unless it is named.
 */

import { Fixed, Rounding } from './fixed';

export enum DayCount {
  Act360 = 'ACT/360',
  Act365F = 'ACT/365F',
}

const MS_PER_DAY = 86_400_000;

/** Whole calendar days between two UTC dates. */
export function actualDays(from: Date, to: Date): number {
  const a = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const b = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  return Math.round((b - a) / MS_PER_DAY);
}

/** Scale for year fractions. Twelve places is far beyond any published NAV. */
export const YF_SCALE = 12;

export function yearFraction(from: Date, to: Date, basis: DayCount): Fixed {
  const days = actualDays(from, to);
  if (days < 0) throw new RangeError(`negative period ${from.toISOString()} → ${to.toISOString()}`);
  const denom = basis === DayCount.Act360 ? 360 : 365;
  return Fixed.parse(String(days), 0).div(Fixed.parse(String(denom), 0), YF_SCALE);
}

/** Simple-interest growth factor `1 + r*T`. Money-market convention, not compounded. */
export function simpleGrowth(rate: Fixed, yf: Fixed, scale = 12): Fixed {
  return Fixed.parse('1', 0).add(rate.mul(yf)).rescale(scale, Rounding.HalfEven);
}

/**
 * Annualise a realised period return on a simple basis: `ret / T`.
 * Deliberately simple rather than compounded — it is the number the term sheet
 * quotes and the number the holder will check.
 */
export function annualiseSimple(periodReturn: Fixed, yf: Fixed, scale = 8): Fixed {
  return periodReturn.div(yf, scale, Rounding.HalfEven);
}
