/**
 * The dollar leg: a ladder of US Treasury bills.
 *
 * Bills are quoted on a discount basis, ACT/360. Two valuation policies matter
 * and the fund must pick one per bucket and disclose it:
 *
 *   amortised cost  — straight-line accretion from purchase price to par.
 *                     Defensible under ~60 days to maturity, and it is what makes
 *                     a stable NAV stable.
 *   marked          — priced off the current discount rate. Honest at any tenor,
 *                     and it puts rate moves into the NAV where a holder can see
 *                     them.
 *
 * The fund's ladder is short by construction, but the choice is a disclosure item
 * and not a default, so both are implemented and the bucket carries the policy.
 */

import { Fixed, Rounding } from '../domain/fixed';
import { DayCount, actualDays, yearFraction } from '../domain/daycount';

export enum ValuationPolicy {
  AmortisedCost = 'AMORTISED_COST',
  Marked = 'MARKED',
}

export interface Bill {
  readonly cusip: string;
  /** Face value at maturity, USD. */
  readonly face: Fixed;
  readonly purchaseDate: Date;
  readonly maturityDate: Date;
  /** Price paid per unit of face, e.g. 0.99 for a 1% discount over the period. */
  readonly purchasePrice: Fixed;
  readonly policy: ValuationPolicy;
}

export const PRICE_SCALE = 10;

/** Price per unit of face from a quoted discount rate: `1 - d * days/360`. */
export function discountPrice(discountRate: Fixed, from: Date, to: Date): Fixed {
  const yf = yearFraction(from, to, DayCount.Act360);
  return Fixed.parse('1', 0).sub(discountRate.mul(yf)).rescale(PRICE_SCALE, Rounding.HalfEven);
}

/** The simple money-market yield implied by a purchase price held to maturity. */
export function moneyMarketYield(purchasePrice: Fixed, from: Date, to: Date): Fixed {
  const yf = yearFraction(from, to, DayCount.Act360);
  const gain = Fixed.parse('1', 0).sub(purchasePrice);
  return gain.div(purchasePrice.mul(yf), 12, Rounding.HalfEven);
}

/** Straight-line accretion from purchase price to par. */
export function amortisedPrice(b: Bill, asOf: Date): Fixed {
  const total = actualDays(b.purchaseDate, b.maturityDate);
  if (total <= 0) return Fixed.parse('1', 0).rescale(PRICE_SCALE);
  const elapsed = Math.min(Math.max(actualDays(b.purchaseDate, asOf), 0), total);
  const discount = Fixed.parse('1', 0).sub(b.purchasePrice);
  const accreted = discount
    .mul(Fixed.parse(String(elapsed), 0))
    .div(Fixed.parse(String(total), 0), PRICE_SCALE, Rounding.HalfEven);
  return b.purchasePrice.add(accreted).rescale(PRICE_SCALE, Rounding.HalfEven);
}

export function valuePrice(b: Bill, asOf: Date, marketDiscountRate?: Fixed): Fixed {
  if (b.policy === ValuationPolicy.AmortisedCost || marketDiscountRate === undefined) {
    return amortisedPrice(b, asOf);
  }
  return discountPrice(marketDiscountRate, asOf, b.maturityDate);
}

/** USD value of one bill at `asOf`. */
export function billValue(b: Bill, asOf: Date, marketDiscountRate?: Fixed): Fixed {
  return b.face.mul(valuePrice(b, asOf, marketDiscountRate)).rescale(2, Rounding.HalfEven);
}

/** USD value of the ladder. */
export function ladderValue(
  bills: readonly Bill[],
  asOf: Date,
  marks: ReadonlyMap<string, Fixed> = new Map(),
): Fixed {
  return bills.reduce(
    (a, b) => a.add(billValue(b, asOf, marks.get(b.cusip))),
    Fixed.zero(2),
  );
}

/** Face maturing on or before `by`. This is what refills the redemption facility. */
export function maturingFace(bills: readonly Bill[], by: Date): Fixed {
  return bills
    .filter((b) => b.maturityDate.getTime() <= by.getTime())
    .reduce((a, b) => a.add(b.face), Fixed.zero(2));
}

/** Weighted-average days to maturity. The ladder's one shape parameter. */
export function weightedAverageMaturity(bills: readonly Bill[], asOf: Date): Fixed {
  const totalFace = bills.reduce((a, b) => a.add(b.face), Fixed.zero(2));
  if (totalFace.isZero()) return Fixed.zero(4);
  let weighted = Fixed.zero(6);
  for (const b of bills) {
    const days = Math.max(actualDays(asOf, b.maturityDate), 0);
    weighted = weighted.add(b.face.mul(Fixed.parse(String(days), 0)));
  }
  return weighted.div(totalFace, 4, Rounding.HalfEven);
}
