/**
 * The NAV strike.
 *
 * The fund's accounting currency is the shekel. Its assets are dollars. That is
 * the entire product, and it means the strike is not an addition — it is a
 * translation, and the rate used for the translation is a disclosed input with a
 * named fixing time, not "the spot at the time we ran it".
 *
 * `PLAN.md` §11 policy, enforced here:
 *   - one strike per joint good business day, inside the fixing window;
 *   - no strike, creation or redemption outside it;
 *   - a stale NAV is published with its staleness attached.
 */

import { Fixed, Rounding } from '../domain/fixed';
import { FxRate, ILS, USDC } from '../domain/money';
import { DayCount, yearFraction } from '../domain/daycount';
import { HolidaySet, assertSeeded, isJointBusinessDay, staleDays } from '../domain/calendar';

export const NAV_SCALE = 8;
export const UNIT_SCALE = 18;

export interface NavInputs {
  readonly asOf: Date;
  /** USD value of the T-bill ladder. */
  readonly billsUsd: Fixed;
  /** USD cash, including margin posted at the prime broker. */
  readonly cashUsd: Fixed;
  /** ILS cash, if any. Normally zero — the fund holds no shekel assets. */
  readonly cashIls: Fixed;
  /** Unrealised P&L on the forward book, ILS. */
  readonly forwardMtmIls: Fixed;
  /** Management fee accrued and unpaid, ILS. */
  readonly accruedFeeIls: Fixed;
  /** Administration, audit, custody accrued and unpaid, ILS. */
  readonly otherAccrualsIls: Fixed;
  /** Units outstanding, 18dp. */
  readonly unitsOutstanding: Fixed;
  /** The fixing. USD/ILS at the published fixing time. */
  readonly strikeSpot: FxRate;
  readonly lastStrike: Date;
}

export interface NavStrike {
  readonly asOf: Date;
  readonly grossAssetsIls: Fixed;
  readonly liabilitiesIls: Fixed;
  readonly netAssetsIls: Fixed;
  readonly navPerUnitIls: Fixed;
  /** The redemption reference: net assets translated back to USDC at the fixing. */
  readonly navPerUnitUsdc: Fixed;
  readonly unitsOutstanding: Fixed;
  readonly strikeSpot: FxRate;
  /** Days since the previous strike. 1 on a normal day; 3 across a weekend. */
  readonly staleDays: number;
}

export class OffWindowStrikeError extends Error {
  constructor(asOf: Date) {
    super(`${asOf.toISOString().slice(0, 10)} is not a joint business day: no strike, no dealing`);
    this.name = 'OffWindowStrikeError';
  }
}

export function strikeNav(i: NavInputs, cals: readonly HolidaySet[]): NavStrike {
  assertSeeded(cals);
  if (!isJointBusinessDay(i.asOf, cals)) throw new OffWindowStrikeError(i.asOf);

  const usdAssets = i.billsUsd.add(i.cashUsd);
  const usdInIls = usdAssets.mul(i.strikeSpot.rate);
  const grossAssetsIls = usdInIls.add(i.cashIls).add(i.forwardMtmIls).rescale(2, Rounding.HalfEven);
  const liabilitiesIls = i.accruedFeeIls.add(i.otherAccrualsIls).rescale(2, Rounding.HalfEven);
  const netAssetsIls = grossAssetsIls.sub(liabilitiesIls);

  const navPerUnitIls = i.unitsOutstanding.isZero()
    ? Fixed.zero(NAV_SCALE)
    : netAssetsIls.div(i.unitsOutstanding, NAV_SCALE, Rounding.Floor);

  const navPerUnitUsdc = i.unitsOutstanding.isZero()
    ? Fixed.zero(USDC.scale)
    : navPerUnitIls.div(i.strikeSpot.rate, USDC.scale, Rounding.Floor);

  return {
    asOf: i.asOf,
    grossAssetsIls,
    liabilitiesIls,
    netAssetsIls,
    navPerUnitIls,
    navPerUnitUsdc,
    unitsOutstanding: i.unitsOutstanding,
    strikeSpot: i.strikeSpot,
    staleDays: staleDays(i.asOf, i.lastStrike),
  };
}

/**
 * Daily management fee accrual on the prior strike's net assets.
 *
 * ILS basis, ACT/365F, accrued every calendar day including the days the fund
 * does not strike — the holder owns the fund on Saturday too. `[VERIFY the ILS
 * basis with the administrator; see daycount.ts.]`
 */
export function accrueFee(
  priorNetAssetsIls: Fixed,
  annualFeeRate: Fixed,
  from: Date,
  to: Date,
): Fixed {
  const yf = yearFraction(from, to, DayCount.Act365F);
  return priorNetAssetsIls.mul(annualFeeRate).mul(yf).rescale(ILS.scale, Rounding.Ceil);
}

// ---------------------------------------------------------------------------
// The published cost line. BUILD-ROUTES.md §7.9: the basis is a disclosed number,
// not tracking error. This is the structure that gets published, monthly.

export interface CostLine {
  /** Headline shekel policy rate for the period, annualised. */
  readonly grossPolicyRate: Fixed;
  /** Management fee, annualised. */
  readonly managementFee: Fixed;
  /** Realised cross-currency basis paid on the period's rolls, annualised. */
  readonly basisCost: Fixed;
  /** Execution and crowded-side cost beyond mid, annualised. */
  readonly executionCost: Fixed;
  /** Custody, administration and audit, annualised. */
  readonly operatingCost: Fixed;
}

export interface CostReport extends CostLine {
  readonly totalDrag: Fixed;
  readonly netToHolder: Fixed;
  /** Each component in basis points, for the table that actually gets read. */
  readonly bp: Readonly<Record<keyof CostLine | 'totalDrag' | 'netToHolder', string>>;
}

export function costReport(c: CostLine): CostReport {
  const totalDrag = c.managementFee.add(c.basisCost).add(c.executionCost).add(c.operatingCost);
  const netToHolder = c.grossPolicyRate.sub(totalDrag);
  const toBp = (f: Fixed): string =>
    f.mul(Fixed.parse('10000', 0)).rescale(1, Rounding.HalfEven).toString();
  return {
    ...c,
    totalDrag,
    netToHolder,
    bp: {
      grossPolicyRate: toBp(c.grossPolicyRate),
      managementFee: toBp(c.managementFee),
      basisCost: toBp(c.basisCost),
      executionCost: toBp(c.executionCost),
      operatingCost: toBp(c.operatingCost),
      totalDrag: toBp(totalDrag),
      netToHolder: toBp(netToHolder),
    },
  };
}

/**
 * The fee test from `PLAN.md` §8: the fee must fit inside the carry, and the
 * whole drag must leave the product winning on yield without a tax subsidy.
 * At a 3.00% policy rate — the Bank of Israel's own 12-month forecast, not
 * today's 4.00% — 30bp of basis plus a 45bp fee is 25% of gross. That is the
 * number to design against, and it is why the fee cannot be set off a 4% screen.
 */
export function feeTest(c: CostReport, maxShareOfGross: Fixed): { pass: boolean; share: Fixed } {
  if (c.grossPolicyRate.isZero()) return { pass: false, share: Fixed.zero(6) };
  const share = c.totalDrag.div(c.grossPolicyRate, 6, Rounding.Ceil);
  return { pass: share.lte(maxShareOfGross), share };
}
