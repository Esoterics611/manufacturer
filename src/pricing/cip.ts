/**
 * Covered interest parity — the mechanism the whole product rests on.
 *
 *   F = S x (1 + r_quote * T_quote) / (1 + r_base * T_base)
 *
 * Hold dollars, sell them forward for shekels, and the dollar rate cancels
 * exactly. That is not an approximation; it is what a forward price is.
 * The fund earns the shekel rate while never owning a shekel asset.
 *
 * What CIP does not give you is the traded price. The traded forward sits off
 * the parity forward by the cross-currency basis, and in USD/ILS specifically we
 * are on the crowded side of it — Israeli institutions hold ~$300bn of foreign
 * assets and hedge ~$90bn back to shekels, which is this exact trade. We join
 * that flow, we do not arbitrage it, and we pay the queue price. `basisBp`
 * measures what we paid; it is a published cost line, not tracking error.
 */

import { Fixed, Rounding } from '../domain/fixed';
import { FX_SCALE, FxRate, Currency } from '../domain/money';
import { simpleGrowth } from '../domain/daycount';

/** Rates and year fractions are held at 12dp; bp results at 2dp. */
export const RATE_SCALE = 12;
export const BP_SCALE = 4;

export interface CipInputs {
  /** Spot, quoted base/quote — for USD/ILS, ILS per USD. */
  readonly spot: FxRate;
  /** Simple money-market rate on the base currency (USD), e.g. 0.0387. */
  readonly baseRate: Fixed;
  /** Simple money-market rate on the quote currency (ILS), e.g. 0.0400. */
  readonly quoteRate: Fixed;
  /** Year fraction on the base leg's own basis (ACT/360 for USD). */
  readonly baseYf: Fixed;
  /** Year fraction on the quote leg's own basis (ACT/365F for ILS). */
  readonly quoteYf: Fixed;
}

/** The parity forward. No basis, no spread — the arithmetic price. */
export function cipForward(i: CipInputs): FxRate {
  const num = simpleGrowth(i.quoteRate, i.quoteYf, RATE_SCALE);
  const den = simpleGrowth(i.baseRate, i.baseYf, RATE_SCALE);
  const ratio = num.div(den, RATE_SCALE, Rounding.HalfEven);
  return FxRate.from(i.spot.base, i.spot.quote, i.spot.rate.mul(ratio).rescale(FX_SCALE));
}

/** F - S, in quote-currency units of the pair. Positive when the quote rate is higher. */
export function forwardPoints(forward: FxRate, spot: FxRate): Fixed {
  assertSamePair(forward, spot);
  return forward.rate.sub(spot.rate);
}

/**
 * The quote-currency rate a traded forward actually implies, given the base rate.
 * This is what the fund earns, as opposed to what the central bank publishes.
 *
 *   r_quote = ((F/S) * (1 + r_base*T_base) - 1) / T_quote
 */
export function impliedQuoteRate(
  traded: FxRate,
  spot: FxRate,
  baseRate: Fixed,
  baseYf: Fixed,
  quoteYf: Fixed,
): Fixed {
  assertSamePair(traded, spot);
  const fOverS = traded.rate.div(spot.rate, RATE_SCALE, Rounding.HalfEven);
  const grown = fOverS.mul(simpleGrowth(baseRate, baseYf, RATE_SCALE));
  const excess = grown.sub(Fixed.parse('1', 0));
  return excess.div(quoteYf, RATE_SCALE, Rounding.HalfEven);
}

/**
 * The cross-currency basis, in basis points, as an annualised rate deviation.
 *
 *   basis = implied_quote_rate(traded) - quote_rate(cash)
 *
 * Negative means the synthetic earns less than the cash shekel rate: we paid to
 * join the hedging queue. USD/ILS median is about -17.7bp; the crowded-side cost
 * on a real ticket is larger, and 20-40bp is the honest budget.
 */
export function basisBp(traded: FxRate, i: CipInputs): Fixed {
  const implied = impliedQuoteRate(traded, i.spot, i.baseRate, i.baseYf, i.quoteYf);
  const deviation = implied.sub(i.quoteRate);
  return deviation.mul(Fixed.parse('10000', 0)).rescale(BP_SCALE, Rounding.HalfEven);
}

/** Apply a basis in bp to the parity forward, producing an executable mark. */
export function forwardFromBasis(i: CipInputs, bp: Fixed): FxRate {
  const shifted: CipInputs = {
    ...i,
    quoteRate: i.quoteRate.add(bp.div(Fixed.parse('10000', 0), RATE_SCALE, Rounding.HalfEven)),
  };
  return cipForward(shifted);
}

// ---------------------------------------------------------------------------

export interface SyntheticLeg {
  /** Base-currency principal at inception, e.g. USD 10,000,000. */
  readonly baseNotional: Fixed;
  /** Value of that principal in quote currency at inception spot. */
  readonly quoteStart: Fixed;
  /** Base principal grown at the base rate to maturity. */
  readonly baseAtMaturity: Fixed;
  /** That amount delivered into the forward. */
  readonly quoteAtMaturity: Fixed;
  /** Period return in quote-currency terms. */
  readonly periodReturn: Fixed;
  /** Simple-annualised period return — the number the term sheet quotes. */
  readonly annualised: Fixed;
}

/**
 * The whole product on one function: hold base-currency bills, deliver into a
 * forward, earn the quote-currency rate.
 *
 * Pass the *traded* forward, not the parity forward. The difference between the
 * two is the basis, and it shows up here as a lower annualised number — which is
 * exactly where it should show up.
 */
export function syntheticLeg(
  baseNotional: Fixed,
  spot: FxRate,
  traded: FxRate,
  baseRate: Fixed,
  baseYf: Fixed,
  quoteYf: Fixed,
): SyntheticLeg {
  assertSamePair(traded, spot);
  const quoteStart = baseNotional.mul(spot.rate).rescale(spot.quote.scale, Rounding.HalfEven);
  const baseAtMaturity = baseNotional
    .mul(simpleGrowth(baseRate, baseYf, RATE_SCALE))
    .rescale(spot.base.scale, Rounding.HalfEven);
  const quoteAtMaturity = baseAtMaturity
    .mul(traded.rate)
    .rescale(spot.quote.scale, Rounding.HalfEven);
  const periodReturn = quoteAtMaturity
    .sub(quoteStart)
    .div(quoteStart, RATE_SCALE, Rounding.HalfEven);
  const annualised = periodReturn.div(quoteYf, RATE_SCALE, Rounding.HalfEven);
  return { baseNotional, quoteStart, baseAtMaturity, quoteAtMaturity, periodReturn, annualised };
}

function assertSamePair(a: FxRate, b: FxRate): void {
  if (a.base.code !== b.base.code || a.quote.code !== b.quote.code) {
    throw new TypeError(`pair mismatch: ${a.pair()} vs ${b.pair()}`);
  }
}

export function pairOf(base: Currency, quote: Currency): string {
  return `${base.code}/${quote.code}`;
}
