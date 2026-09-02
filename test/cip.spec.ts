/**
 * The document's own arithmetic, as a test.
 *
 * BUILD-ROUTES.md §3.1 is the worked example the whole product rests on. If this
 * file goes red, either the engine is wrong or the document is — and both are
 * findings.
 */

import { Fixed } from '../src/domain/fixed';
import { FxRate, USD, ILS } from '../src/domain/money';
import { DayCount, yearFraction } from '../src/domain/daycount';
import {
  cipForward,
  forwardPoints,
  impliedQuoteRate,
  basisBp,
  forwardFromBasis,
  syntheticLeg,
} from '../src/pricing/cip';

const spot = FxRate.of(USD, ILS, '3.02');
const rUsd = Fixed.parse('0.0387', 6);
const rIls = Fixed.parse('0.0400', 6);
const T = Fixed.parse('0.25', 12);

const flat = { spot, baseRate: rUsd, quoteRate: rIls, baseYf: T, quoteYf: T };

describe('BUILD-ROUTES §3.1 — the synthetic earns the shekel rate', () => {
  it('prices the 3m forward at 3.02098 to the document tolerance', () => {
    const f = cipForward(flat);
    const diff = Math.abs(f.rate.toNumber() - 3.02098);
    expect(diff).toBeLessThanOrEqual(0.00002);
  });

  it('reproduces every row of the worked $10m table', () => {
    const f = cipForward(flat);
    const leg = syntheticLeg(Fixed.parse('10000000', 2), spot, f, rUsd, T, T);

    expect(leg.quoteStart.toString()).toBe('30200000.00');
    expect(leg.baseAtMaturity.toString()).toBe('10096750.00');
    expect(Math.abs(leg.quoteAtMaturity.toNumber() - 30_502_000)).toBeLessThanOrEqual(2000);
    expect(Math.abs(leg.periodReturn.toNumber() * 100 - 1.0)).toBeLessThanOrEqual(0.01);
    expect(Math.abs(leg.annualised.toNumber() * 100 - 4.0)).toBeLessThanOrEqual(0.02);
  });

  it('cancels the USD rate exactly — the shekel return is invariant to it', () => {
    const notional = Fixed.parse('10000000', 2);
    const results = ['0.0100', '0.0387', '0.0600'].map((r) => {
      const rate = Fixed.parse(r, 6);
      const inputs = { ...flat, baseRate: rate };
      const f = cipForward(inputs);
      return syntheticLeg(notional, spot, f, rate, T, T).annualised.toNumber();
    });
    for (const a of results) expect(Math.abs(a - 0.04)).toBeLessThan(1e-6);
  });

  it('quotes forward points as F - S', () => {
    const f = cipForward(flat);
    expect(forwardPoints(f, spot).toNumber()).toBeCloseTo(f.rate.toNumber() - 3.02, 8);
  });
});

describe('the cross-currency basis', () => {
  it('recovers the shekel rate from a parity forward', () => {
    const f = cipForward(flat);
    const implied = impliedQuoteRate(f, spot, rUsd, T, T);
    expect(Math.abs(implied.toNumber() - 0.04)).toBeLessThan(1e-8);
    expect(Math.abs(basisBp(f, flat).toNumber())).toBeLessThan(0.01);
  });

  it('measures the USD/ILS median basis of -17.7bp as a cost, not as noise', () => {
    const traded = forwardFromBasis(flat, Fixed.parse('-17.7', 4));
    const bp = basisBp(traded, flat);
    expect(bp.toNumber()).toBeCloseTo(-17.7, 2);

    const leg = syntheticLeg(Fixed.parse('10000000', 2), spot, traded, rUsd, T, T);
    // The basis lands where it should: in the annualised number the holder sees.
    expect(leg.annualised.toNumber()).toBeCloseTo(0.04 - 0.00177, 5);
  });

  it('prices the honest 20-40bp crowded-side budget as a yield range', () => {
    const lo = syntheticLeg(
      Fixed.parse('10000000', 2), spot, forwardFromBasis(flat, Fixed.parse('-20', 4)), rUsd, T, T,
    ).annualised.toNumber();
    const hi = syntheticLeg(
      Fixed.parse('10000000', 2), spot, forwardFromBasis(flat, Fixed.parse('-40', 4)), rUsd, T, T,
    ).annualised.toNumber();
    expect(lo).toBeCloseTo(0.0380, 4);
    expect(hi).toBeCloseTo(0.0360, 4);
  });
});

describe('the day-count trap', () => {
  it('costs real basis points when the two legs use their own conventions', () => {
    const start = new Date(Date.UTC(2026, 8, 3));
    const end = new Date(Date.UTC(2026, 11, 3)); // 91 days
    const yfUsd = yearFraction(start, end, DayCount.Act360);
    const yfIls = yearFraction(start, end, DayCount.Act365F);
    expect(yfUsd.toNumber()).toBeCloseTo(91 / 360, 9);
    expect(yfIls.toNumber()).toBeCloseTo(91 / 365, 9);

    const mixed = cipForward({ ...flat, baseYf: yfUsd, quoteYf: yfIls });
    const naive = cipForward(flat);
    const gapBp = Math.abs(mixed.rate.toNumber() / naive.rate.toNumber() - 1) * 10_000 * 4;
    // Material: bigger than the fee tolerance, and invisible unless it is named.
    expect(gapBp).toBeGreaterThan(3);
  });
});
