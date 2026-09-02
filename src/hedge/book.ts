/**
 * The forward book.
 *
 * Two numbers matter more than any other in this file, and neither is a P&L:
 * aggregate net notional and aggregate initial margin. They are the two arms of
 * the CFTC 4.13(a)(3) de minimis test, and the book exists partly to keep them
 * computable on demand and correct at the moment a ticket is written.
 *
 * Netting convention is deliberately conservative: positions net only within the
 * same pair *and* the same value date. CFTC guidance on netting for the notional
 * test is not written with a bilateral deliverable-forward book in mind, and the
 * only safe direction to be wrong in is the direction that reports a larger
 * number. `grossNotional` is reported alongside so the choice is visible.
 * [VERIFY with the CPO memo — question 3 of BUILD-ROUTES.md §4.]
 */

import { Fixed, Rounding } from '../domain/fixed';
import { FxRate } from '../domain/money';
import { isoDate } from '../domain/calendar';
import { ForwardPosition, mtmQuote, signedBaseNotional } from './forward';

export interface Mark {
  /** Market forward to this position's value date. */
  readonly forward: FxRate;
  /** Quote-currency discount rate for the remaining life. */
  readonly quoteRate: Fixed;
  /** Remaining year fraction on the quote basis. */
  readonly remainingYf: Fixed;
}

export class ForwardBook {
  constructor(private readonly positions: readonly ForwardPosition[] = []) {}

  with(p: ForwardPosition): ForwardBook {
    return new ForwardBook([...this.positions, p]);
  }

  without(id: string): ForwardBook {
    return new ForwardBook(this.positions.filter((p) => p.id !== id));
  }

  all(): readonly ForwardPosition[] {
    return this.positions;
  }

  open(asOf: Date): ForwardBook {
    return new ForwardBook(this.positions.filter((p) => p.valueDate.getTime() > asOf.getTime()));
  }

  /** Sum of |notional| across every ticket, base currency. */
  grossNotional(): Fixed {
    return this.positions.reduce(
      (a, p) => a.add(p.baseNotional),
      Fixed.zero(0),
    );
  }

  /**
   * Net notional, base currency: net inside each (pair, value date) bucket, then
   * sum the absolute value of each bucket.
   */
  netNotional(): Fixed {
    const buckets = new Map<string, Fixed>();
    for (const p of this.positions) {
      const key = `${p.base.code}/${p.quote.code}@${isoDate(p.valueDate)}`;
      const prev = buckets.get(key) ?? Fixed.zero(0);
      buckets.set(key, prev.add(signedBaseNotional(p)));
    }
    let total = Fixed.zero(0);
    for (const v of buckets.values()) total = total.add(v.abs());
    return total;
  }

  /** Aggregate initial margin posted, base currency. */
  initialMargin(): Fixed {
    return this.positions.reduce((a, p) => a.add(p.initialMargin), Fixed.zero(0));
  }

  /** Unrealised P&L in quote currency, given a mark per position id. */
  unrealisedQuote(marks: ReadonlyMap<string, Mark>): Fixed {
    let total = Fixed.zero(0);
    for (const p of this.positions) {
      const m = marks.get(p.id);
      if (!m) throw new RangeError(`no mark for position ${p.id}`);
      total = total.add(mtmQuote(p, m.forward, m.quoteRate, m.remainingYf));
    }
    return total.rescale(6, Rounding.HalfEven);
  }

  /** Positions maturing on or before `by`. The roll queue. */
  maturingBy(by: Date): readonly ForwardPosition[] {
    return this.positions.filter((p) => p.valueDate.getTime() <= by.getTime());
  }

  /**
   * Hedge ratio: net notional over the fund's base-currency NAV equivalent.
   * The mandate targets 1.00 — the fund denominates NAV in shekels, it does not
   * take a currency view. Drift outside a band is a rebalance trigger, and the
   * upper edge of the band is also the 100% arm of the 4.13(a)(3) test, so the
   * two constraints are the same constraint.
   */
  hedgeRatio(navInBase: Fixed, scale = 6): Fixed {
    if (navInBase.isZero()) return Fixed.zero(scale);
    return this.netNotional().div(navInBase, scale, Rounding.HalfEven);
  }
}
