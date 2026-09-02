/**
 * CFTC Rule 4.13(a)(3) de minimis relief, and the ECP test behind it.
 *
 * This module decides whether the fund launches in six weeks or twelve months,
 * and it is the reason the engine exists before the vehicle does.
 *
 * The fund holds only US Treasury bills and enters deliverable USD/ILS forwards
 * with notional at roughly 100% of NAV, rolled quarterly, solely to denominate
 * NAV in shekels. If the Treasury Secretary's 2012 determination means those
 * forwards are not commodity interests, none of this is engaged at all. If it
 * does not, 4.13(a)(3) is the relief, and it has two alternative arms:
 *
 *   (i)  aggregate initial margin + premiums  <=   5% of liquidation value
 *   (ii) aggregate net notional value          <= 100% of liquidation value
 *
 * Either arm suffices. We expect to be comfortably inside (i) and sitting exactly
 * on the boundary of (ii) — which is why the margin arm is the one that carries
 * the strategy, and why a margin-call day that raises posted IM is a compliance
 * event and not just a funding event.
 *
 * The timing rule is the part software gets wrong: the test bites *at the time
 * the most recent commodity-interest position was established*. It is a pre-trade
 * gate, not a nightly report. `preTradeCheck` is the gate; `monitor` is the
 * report, and a monitor breach is a warning to stop trading, not a violation.
 *
 * [VERIFY — every threshold and every interpretation here is the subject of the
 * memo commissioned at BUILD-ROUTES.md §4. This is our reading, encoded so it can
 * be corrected in one place. Nothing here is legal advice.]
 */

import { Fixed, Rounding } from '../domain/fixed';

export const RATIO_SCALE = 8;

const ONE = Fixed.parse('1', 0);
const HUNDRED = Fixed.parse('100', 0);

/** 5% of liquidation value. Arm (i). */
export const MARGIN_LIMIT = Fixed.parse('0.05', 2);
/** 100% of liquidation value. Arm (ii). */
export const NOTIONAL_LIMIT = ONE;

/** CEA 1a(18): ECP asset thresholds. A commodity pool qualifies at the lower one. */
export const ECP_THRESHOLD_POOL_USD = Fixed.parse('5000000', 0);
export const ECP_THRESHOLD_OTHER_USD = Fixed.parse('10000000', 0);

export interface PoolState {
  /**
   * Liquidation value of the pool's portfolio, base currency, *after taking into
   * account unrealised profits and losses*. That clause is in the rule and it
   * matters: a forward book marked against us shrinks the denominator on both
   * arms at exactly the moment the numerator is least likely to fall.
   */
  readonly liquidationValue: Fixed;
  /** Aggregate initial margin, premiums and minimum security deposit posted. */
  readonly aggregateInitialMargin: Fixed;
  /** Aggregate net notional of commodity-interest positions. */
  readonly aggregateNetNotional: Fixed;
}

export interface ArmResult {
  readonly ratio: Fixed;
  readonly limit: Fixed;
  readonly pass: boolean;
  /** Headroom in the same units as the numerator: how much more before breach. */
  readonly headroom: Fixed;
}

export interface TradingTestResult {
  readonly marginArm: ArmResult;
  readonly notionalArm: ArmResult;
  /** Either arm suffices. */
  readonly pass: boolean;
  /** Which arm is actually carrying relief right now. */
  readonly reliedOn: 'MARGIN' | 'NOTIONAL' | 'BOTH' | 'NEITHER';
}

function arm(numerator: Fixed, liquidationValue: Fixed, limit: Fixed): ArmResult {
  if (liquidationValue.isZero() || liquidationValue.isNegative()) {
    return { ratio: Fixed.zero(RATIO_SCALE), limit, pass: false, headroom: Fixed.zero(RATIO_SCALE) };
  }
  const ratio = numerator.div(liquidationValue, RATIO_SCALE, Rounding.Ceil);
  const allowed = liquidationValue.mul(limit);
  return {
    ratio,
    limit,
    pass: ratio.lte(limit),
    headroom: allowed.sub(numerator).rescale(2, Rounding.Floor),
  };
}

/** The 4.13(a)(3) trading test, both arms. */
export function tradingTest(s: PoolState): TradingTestResult {
  const marginArm = arm(s.aggregateInitialMargin, s.liquidationValue, MARGIN_LIMIT);
  const notionalArm = arm(s.aggregateNetNotional, s.liquidationValue, NOTIONAL_LIMIT);
  const reliedOn = marginArm.pass && notionalArm.pass
    ? 'BOTH'
    : marginArm.pass
      ? 'MARGIN'
      : notionalArm.pass
        ? 'NOTIONAL'
        : 'NEITHER';
  return { marginArm, notionalArm, pass: marginArm.pass || notionalArm.pass, reliedOn };
}

// ---------------------------------------------------------------------------
// The other three conditions. The trading test is necessary, not sufficient.

export interface OfferingConditions {
  /** Interests offered without registration under the Securities Act (506(c)/Reg S). */
  readonly exemptFromSecuritiesRegistration: boolean;
  /** Interests not marketed as a vehicle for trading in commodity interests. */
  readonly notMarketedAsCommodityVehicle: boolean;
  /** Every participant is accredited / QEP / knowledgeable employee / QP. */
  readonly allParticipantsEligible: boolean;
}

export interface ExemptionReport {
  readonly trading: TradingTestResult;
  readonly offering: OfferingConditions;
  readonly available: boolean;
  readonly failures: readonly string[];
}

export function assessExemption(s: PoolState, o: OfferingConditions): ExemptionReport {
  const trading = tradingTest(s);
  const failures: string[] = [];
  if (!trading.pass) {
    failures.push(
      `4.13(a)(3) trading test: margin ${pct(trading.marginArm.ratio)} of LV (limit 5%), ` +
        `net notional ${pct(trading.notionalArm.ratio)} of LV (limit 100%)`,
    );
  }
  if (!o.exemptFromSecuritiesRegistration) failures.push('interests are not privately offered');
  if (!o.notMarketedAsCommodityVehicle) {
    failures.push('marketing presents the fund as a commodity-interest vehicle');
  }
  if (!o.allParticipantsEligible) failures.push('a participant is outside the eligible class');
  return { trading, offering: o, available: failures.length === 0, failures };
}

// ---------------------------------------------------------------------------
// Pre-trade gate. This is the one that must be wired into the ticket path.

export interface ProposedTrade {
  /** Initial margin the new ticket will require, base currency. */
  readonly additionalInitialMargin: Fixed;
  /** Change in aggregate net notional the ticket produces (may be negative). */
  readonly netNotionalDelta: Fixed;
}

export interface PreTradeResult {
  readonly before: TradingTestResult;
  readonly after: TradingTestResult;
  readonly allowed: boolean;
  readonly reason: string;
}

/**
 * Evaluate the pool *as it would stand immediately after* the proposed ticket.
 *
 * A ticket that would leave the pool failing both arms is refused. A ticket that
 * leaves only the notional arm failing is allowed, because the margin arm still
 * carries relief — but the result names which arm is carrying it, so the desk can
 * see when it is running on one engine.
 */
export function preTradeCheck(s: PoolState, t: ProposedTrade): PreTradeResult {
  const before = tradingTest(s);
  const after = tradingTest({
    liquidationValue: s.liquidationValue,
    aggregateInitialMargin: s.aggregateInitialMargin.add(t.additionalInitialMargin),
    aggregateNetNotional: s.aggregateNetNotional.add(t.netNotionalDelta),
  });
  if (!after.pass) {
    return {
      before,
      after,
      allowed: false,
      reason:
        `refused: post-trade margin ${pct(after.marginArm.ratio)} of LV and net notional ` +
        `${pct(after.notionalArm.ratio)} of LV breach both arms of 4.13(a)(3)`,
    };
  }
  return {
    before,
    after,
    allowed: true,
    reason: `on the ${after.reliedOn.toLowerCase()} arm`,
  };
}

// ---------------------------------------------------------------------------

export interface EcpResult {
  readonly qualifies: boolean;
  readonly threshold: Fixed;
  readonly reason: string;
}

/**
 * Eligible contract participant. If the fund is an ECP the retail foreign
 * exchange dealer rules do not reach it — which is the difference between an FX
 * prime brokerage line and no line at all.
 *
 * A commodity pool qualifies at $5m of total assets; other entities at $10m.
 * Note the asymmetry: being a commodity pool *lowers* this bar while raising the
 * CPO one. The two questions have opposite signs and must not be conflated.
 */
export function eligibleContractParticipant(totalAssets: Fixed, isCommodityPool: boolean): EcpResult {
  const threshold = isCommodityPool ? ECP_THRESHOLD_POOL_USD : ECP_THRESHOLD_OTHER_USD;
  const qualifies = totalAssets.gt(threshold);
  return {
    qualifies,
    threshold,
    reason: qualifies
      ? `total assets ${totalAssets} exceed the ${threshold} threshold`
      : `total assets ${totalAssets} do not exceed ${threshold}: RFED analysis is live, and the ` +
        `fund must not trade FX forwards until it does`,
  };
}

/**
 * If 4.13(a)(3) is unavailable, Rule 4.7 is the fallback: register as CPO, then
 * claim relief from the full disclosure and reporting regime on the basis that
 * every participant is a qualified eligible person. It costs a quarter and NFA
 * membership; it does not stop the product.
 */
export function fallbackPath(report: ExemptionReport, allQep: boolean): string {
  if (report.available) return '4.13(a)(3): no CPO registration';
  if (allQep) return '4.7: register as CPO, claim QEP relief, join NFA. Budget one quarter.';
  return 'full CPO registration with Part 4 disclosure and reporting. Reconsider Route A.';
}

function pct(ratio: Fixed): string {
  return `${ratio.mul(HUNDRED).rescale(4, Rounding.HalfEven).toString()}%`;
}
