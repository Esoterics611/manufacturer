/**
 * Creations and redemptions, swing-priced.
 *
 * `PLAN.md` §11: the arriving or departing holder bears the mark-to-market
 * between their order and the hedge execution — never the existing ones. Orders
 * are accepted until a daily cutoff, priced at the NAV struck immediately after
 * the hedge adjustment executes in the fixing window, and charged a fee with a
 * fixed component and a variable component equal to actual execution cost.
 *
 * That last clause is the reason this module needs the execution cost as an
 * input rather than a parameter: passing on an estimate is a subsidy in one
 * direction and a hidden fee in the other.
 *
 * The creation unit is $1m — small on purpose. The ETF norm is $2-5m, and the
 * whole arbitrage depends on the unit being small enough that the participants
 * who would close a NAV gap can actually afford to.
 */

import { Fixed, Rounding } from '../domain/fixed';
import { NavStrike } from '../nav/nav';

const BP = Fixed.parse("10000", 0);

export enum DealSide {
  Create = 'CREATE',
  Redeem = 'REDEEM',
}

export interface DealingParams {
  /** Fixed component, a fraction of NAV. Covers the fund's own order handling. */
  readonly fixedFee: Fixed;
  /** Minimum creation unit, USDC. */
  readonly minimumCreationUsdc: Fixed;
  /** Cutoff, minutes before the fixing, after which an order goes to the next strike. */
  readonly cutoffMinutesBeforeFixing: number;
}

export const DEFAULT_DEALING: DealingParams = {
  fixedFee: Fixed.parse('0.0005', 6),
  minimumCreationUsdc: Fixed.parse('1000000', 6),
  cutoffMinutesBeforeFixing: 60,
};

export interface DealRequest {
  readonly side: DealSide;
  /** For a creation: USDC delivered. For a redemption: units surrendered. */
  readonly amount: Fixed;
  /**
   * Actual cost of the hedge adjustment this order caused, as a fraction of the
   * order's value. Measured, not estimated: traded forward against the parity
   * forward struck at the same fixing, plus spread paid.
   */
  readonly realisedExecutionCost: Fixed;
}

export interface DealResult {
  readonly side: DealSide;
  /** Total swing charged, as a fraction of NAV. */
  readonly swing: Fixed;
  readonly swingBp: Fixed;
  /** Price per unit actually dealt, USDC. */
  readonly dealPriceUsdc: Fixed;
  /** Units issued (create) or units cancelled (redeem). */
  readonly units: Fixed;
  /** USDC paid in (create) or paid out (redeem). */
  readonly usdc: Fixed;
  /** Value retained in the fund for the benefit of existing holders. */
  readonly swingRetainedUsdc: Fixed;
}

export class BelowMinimumError extends Error {
  constructor(amount: Fixed, minimum: Fixed) {
    super(`creation of ${amount} USDC is below the ${minimum} USDC creation unit`);
    this.name = 'BelowMinimumError';
  }
}

/**
 * Price a deal against a struck NAV.
 *
 * Creations pay NAV x (1 + swing); redemptions receive NAV x (1 - swing). Both
 * signs move value toward the fund, which is the point: the existing holder is
 * held harmless in both directions.
 */
export function price(
  nav: NavStrike,
  req: DealRequest,
  p: DealingParams = DEFAULT_DEALING,
): DealResult {
  const swing = p.fixedFee.add(req.realisedExecutionCost).rescale(8, Rounding.Ceil);
  const one = Fixed.parse('1', 0);

  if (req.side === DealSide.Create) {
    if (req.amount.lt(p.minimumCreationUsdc)) {
      throw new BelowMinimumError(req.amount, p.minimumCreationUsdc);
    }
    const dealPriceUsdc = nav.navPerUnitUsdc.mul(one.add(swing)).rescale(6, Rounding.Ceil);
    const units = dealPriceUsdc.isZero()
      ? Fixed.zero(18)
      : req.amount.div(dealPriceUsdc, 18, Rounding.Floor);
    const atNav = units.mul(nav.navPerUnitUsdc).rescale(6, Rounding.Floor);
    const usdc = units.mul(dealPriceUsdc).rescale(6, Rounding.Ceil);
    return {
      side: req.side,
      swing,
      swingBp: swing.mul(BP).rescale(2),
      dealPriceUsdc,
      units,
      usdc,
      swingRetainedUsdc: usdc.sub(atNav),
    };
  }

  const dealPriceUsdc = nav.navPerUnitUsdc.mul(one.sub(swing)).rescale(6, Rounding.Floor);
  const units = req.amount;
  const usdc = units.mul(dealPriceUsdc).rescale(6, Rounding.Floor);
  const atNav = units.mul(nav.navPerUnitUsdc).rescale(6, Rounding.Floor);
  return {
    side: req.side,
    swing,
    swingBp: swing.mul(BP).rescale(2),
    dealPriceUsdc,
    units,
    usdc,
    swingRetainedUsdc: atNav.sub(usdc),
  };
}

/**
 * The hedge adjustment a creation or redemption forces.
 *
 * The fund targets a 1.00 hedge ratio, so every dollar in or out moves the
 * forward notional by the same amount. This is the number that goes into
 * `preTradeCheck` before the order is accepted — an order the fund cannot hedge
 * without breaching 4.13(a)(3) is an order the fund refuses.
 */
export function hedgeDelta(result: DealResult): Fixed {
  return result.side === DealSide.Create ? result.usdc : result.usdc.neg();
}
