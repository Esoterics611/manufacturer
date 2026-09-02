/**
 * The standing redemption facility.
 *
 * `PLAN.md` §2 and §11: the liquidity mechanism is optional in an ETF and must
 * not be optional here. Authorised participants hold rights, not duties, so a
 * product whose only exit is a market maker's willingness to bid has no floor.
 * This facility is the floor: a capped, issuer-funded pool that redeems for
 * stablecoin around the clock at last-struck NAV less a published haircut.
 *
 * The second effect is the one that pays for it. If the facility bids
 * NAV - 25bp, no market maker can post a bid below NAV - 25bp and expect a fill.
 * The issuer sets the spread ceiling instead of conceding it across the table.
 *
 * ---------------------------------------------------------------------------
 * A correction to `PLAN.md` §11, which this module makes unavoidable.
 *
 * §11 reasons that the facility is safe because "bills do not gap the way a
 * levered carry position does". That is true of the dollar bill fund it was
 * written for. It is *not* true here. This fund's NAV is denominated in shekels
 * and the facility pays dollars, so the facility's exposure is not the bills —
 * it is one USD/ILS gap, and USD/ILS at 8% annualised vol moves ~50bp in a
 * single day at one sigma.
 *
 * A 25bp haircut against a 50bp one-sigma gap is the issuer writing a free
 * option. The arithmetic below prices it honestly, and the consequence is a
 * design requirement rather than a wider spread:
 *
 *   While the FX market is open, the facility hedges what it buys within
 *   minutes, so the gap term is near zero and 10-20bp is a real price.
 *
 *   While the FX market is shut — Friday 22:00 UTC to Sunday 22:00 UTC, which
 *   is exactly when a 24/7 facility earns its name — nothing can be hedged
 *   after the fact. The only cheap answer is to hedge *before*: carry a short
 *   ILS position sized to the facility cap into every Friday close. The cap is
 *   5% of AUM, so the carry cost of pre-hedging it is trivial, and it collapses
 *   the weekend haircut from ~75bp to ~11bp.
 *
 * `preHedgedRatio` is therefore live operational state, not a parameter. If the
 * desk did not put the pre-hedge on, the facility must quote the wide number.
 * ---------------------------------------------------------------------------
 *
 * Everything here is rule-driven. Discretionary suspension is how an issuer
 * becomes the story, so suspension is a published formula with published
 * parameters and no override.
 */

import { Fixed, Rounding } from '../domain/fixed';
import { staleDays, fxIsOpen, hoursUntilFxOpen, FX_CLOSED_HOURS } from '../domain/calendar';
import { NavStrike } from '../nav/nav';

const BP_FACTOR = Fixed.parse('10000', 0);
/** Trading days per year, for scaling an annualised vol to a gap. */
const TRADING_DAYS = 252;

export interface FacilityParams {
  /** Pool size as a fraction of net assets. `PLAN.md` §11 sizes this at 5%. */
  readonly capRatio: Fixed;
  /** Floor haircut, always charged. Operational cost and adverse selection. */
  readonly baseHaircut: Fixed;
  /** Charge per stale day, covering bill accrual and rate drift in the stale NAV. */
  readonly stalenessChargePerDay: Fixed;
  /** Sigmas of USD/ILS gap the haircut is required to cover. */
  readonly volMultiple: Fixed;
  /** Hedge lag while the FX market is open, in trading days. Minutes, not days. */
  readonly hedgeLagTradingDays: Fixed;
  /** Trading-day-equivalents of variance a full weekend close carries. */
  readonly weekendVarianceDays: Fixed;
  /** Annualised USD/ILS volatility above which the facility suspends by rule. */
  readonly volSuspensionThreshold: Fixed;
  /** Staleness beyond which the facility suspends by rule. */
  readonly maxStaleDays: number;
  /** Hard ceiling on the haircut. Beyond this, suspend rather than quote wide. */
  readonly maxHaircut: Fixed;
}

/** Sane starting parameters. Every one of them is a term-sheet disclosure. */
export const DEFAULT_PARAMS: FacilityParams = {
  capRatio: Fixed.parse('0.05', 4),
  baseHaircut: Fixed.parse('0.0010', 6),
  stalenessChargePerDay: Fixed.parse('0.00005', 6),
  volMultiple: Fixed.parse('1.5', 2),
  hedgeLagTradingDays: Fixed.parse('0.02', 4),
  weekendVarianceDays: Fixed.parse('1.0', 2),
  volSuspensionThreshold: Fixed.parse('0.20', 4),
  maxStaleDays: 5,
  maxHaircut: Fixed.parse('0.0100', 6),
};

export interface FacilityState {
  /** USDC currently funding the pool. Refilled from the ladder's own maturities. */
  readonly availableUsdc: Fixed;
  /** Net assets at the last strike, ILS — the cap is a fraction of this. */
  readonly netAssetsIls: Fixed;
  /**
   * Fraction of the facility cap currently pre-hedged with a short ILS position.
   * 1 means the weekend gap is neutralised; 0 means the issuer is naked and the
   * quote must say so in its price.
   */
  readonly preHedgedRatio: Fixed;
}

export interface HaircutBreakdown {
  readonly base: Fixed;
  readonly staleness: Fixed;
  readonly fxGap: Fixed;
  readonly total: Fixed;
  readonly totalBp: Fixed;
  /** Trading-day-equivalents of USD/ILS variance the quote is exposed to. */
  readonly gapVarianceDays: Fixed;
  readonly fxMarketOpen: boolean;
}

export type FacilityQuote =
  | {
      readonly status: 'OPEN';
      readonly haircut: Fixed;
      readonly haircutBp: Fixed;
      readonly breakdown: HaircutBreakdown;
      /** Price per unit in USDC the facility will pay right now. */
      readonly bidUsdcPerUnit: Fixed;
      /** Units the facility can still absorb given cash and the cap. */
      readonly capacityUnits: Fixed;
      readonly staleDays: number;
    }
  | {
      readonly status: 'SUSPENDED';
      readonly rule: string;
      readonly staleDays: number;
      readonly breakdown?: HaircutBreakdown;
    };

/**
 * Variance the quote is exposed to, in trading-day equivalents.
 *
 * Open market: the hedge lag, which is minutes. Closed market: the remaining
 * closed fraction of the weekend, scaled by how much variance a full weekend
 * carries, plus the lag once it reopens.
 */
export function gapVarianceDays(asOf: Date, p: FacilityParams): Fixed {
  if (fxIsOpen(asOf)) return p.hedgeLagTradingDays;
  const closedFraction = hoursUntilFxOpen(asOf) / FX_CLOSED_HOURS;
  return p.weekendVarianceDays
    .mul(Fixed.fromNumber(closedFraction, 8))
    .rescale(8, Rounding.Ceil)
    .add(p.hedgeLagTradingDays);
}

export function haircutFor(
  asOf: Date,
  stale: number,
  annualVol: Fixed,
  preHedgedRatio: Fixed,
  p: FacilityParams,
): HaircutBreakdown {
  const varianceDays = gapVarianceDays(asOf, p);
  const sigmaGap = annualVol
    .mul(Fixed.fromNumber(Math.sqrt(varianceDays.toNumber() / TRADING_DAYS), 10))
    .rescale(10, Rounding.Ceil);
  const unhedged = Fixed.max(Fixed.parse('1', 0).sub(preHedgedRatio), Fixed.zero(4));
  const fxGap = p.volMultiple.mul(sigmaGap).mul(unhedged).rescale(6, Rounding.Ceil);
  const staleness = p.stalenessChargePerDay
    .mul(Fixed.parse(String(Math.max(stale, 0)), 0))
    .rescale(6, Rounding.Ceil);
  const total = p.baseHaircut.add(staleness).add(fxGap).rescale(6, Rounding.Ceil);
  return {
    base: p.baseHaircut,
    staleness,
    fxGap,
    total,
    totalBp: total.mul(BP_FACTOR).rescale(2),
    gapVarianceDays: varianceDays,
    fxMarketOpen: fxIsOpen(asOf),
  };
}

export function quote(
  last: NavStrike,
  asOf: Date,
  annualVol: Fixed,
  state: FacilityState,
  p: FacilityParams = DEFAULT_PARAMS,
): FacilityQuote {
  const stale = staleDays(asOf, last.asOf);

  if (annualVol.gt(p.volSuspensionThreshold)) {
    return {
      status: 'SUSPENDED',
      rule: `USD/ILS annualised volatility ${annualVol} exceeds the published ` +
        `${p.volSuspensionThreshold} threshold`,
      staleDays: stale,
    };
  }
  if (stale > p.maxStaleDays) {
    return {
      status: 'SUSPENDED',
      rule: `NAV is ${stale} days stale, beyond the published ${p.maxStaleDays}-day limit`,
      staleDays: stale,
    };
  }

  const breakdown = haircutFor(asOf, stale, annualVol, state.preHedgedRatio, p);
  if (breakdown.total.gt(p.maxHaircut)) {
    return {
      status: 'SUSPENDED',
      rule: `rule-derived haircut ${breakdown.total} exceeds the published ceiling ` +
        `${p.maxHaircut}` +
        (breakdown.fxMarketOpen ? '' : ' (FX market shut and the pre-hedge is short)'),
      staleDays: stale,
      breakdown,
    };
  }

  const bidUsdcPerUnit = last.navPerUnitUsdc
    .mul(Fixed.parse('1', 0).sub(breakdown.total))
    .rescale(6, Rounding.Floor);

  const capIls = state.netAssetsIls.mul(p.capRatio).rescale(2, Rounding.Floor);
  const capUsdc = capIls.div(last.strikeSpot.rate, 6, Rounding.Floor);
  const fundedUsdc = Fixed.min(state.availableUsdc, capUsdc);
  const capacityUnits = bidUsdcPerUnit.isZero()
    ? Fixed.zero(18)
    : fundedUsdc.div(bidUsdcPerUnit, 18, Rounding.Floor);

  return {
    status: 'OPEN',
    haircut: breakdown.total,
    haircutBp: breakdown.totalBp,
    breakdown,
    bidUsdcPerUnit,
    capacityUnits,
    staleDays: stale,
  };
}

/**
 * The number the market-maker negotiation turns on: no third-party bid below
 * this can expect a fill, because the issuer is already standing there.
 */
export function spreadCeilingBp(q: FacilityQuote): Fixed | null {
  return q.status === 'OPEN' ? q.haircutBp : null;
}

/**
 * The cost of the weekend pre-hedge, as a fraction of net assets, over `days`.
 *
 * A short ILS position over the cap costs the rate differential for the period.
 * At a 4.00% ILS rate against 3.87% USD on 5% of AUM for two days, this is
 * fractions of a basis point of NAV. Compare it against the ~65bp of haircut it
 * removes: the pre-hedge is not close to a marginal decision.
 */
export function preHedgeCarryCost(
  capRatio: Fixed,
  ilsRate: Fixed,
  usdRate: Fixed,
  days: number,
): Fixed {
  const diff = ilsRate.sub(usdRate);
  const yf = Fixed.parse(String(days), 0).div(Fixed.parse('365', 0), 12, Rounding.Ceil);
  return capRatio.mul(diff).mul(yf).rescale(10, Rounding.Ceil);
}

export interface FacilityFill {
  readonly unitsAccepted: Fixed;
  readonly unitsRefused: Fixed;
  readonly usdcPaid: Fixed;
  readonly remainingUsdc: Fixed;
}

/** Partial fills are the design. The cap is real and refusing the excess is correct. */
export function execute(q: FacilityQuote, unitsRequested: Fixed, state: FacilityState): FacilityFill {
  if (q.status !== 'OPEN') {
    return {
      unitsAccepted: Fixed.zero(18),
      unitsRefused: unitsRequested,
      usdcPaid: Fixed.zero(6),
      remainingUsdc: state.availableUsdc,
    };
  }
  const accepted = Fixed.min(unitsRequested, q.capacityUnits);
  const paid = accepted.mul(q.bidUsdcPerUnit).rescale(6, Rounding.Floor);
  return {
    unitsAccepted: accepted,
    unitsRefused: unitsRequested.sub(accepted),
    usdcPaid: paid,
    remainingUsdc: state.availableUsdc.sub(paid),
  };
}

/** Refill target: bring the pool back to the cap from maturing ladder proceeds. */
export function refillNeeded(
  state: FacilityState,
  spot: Fixed,
  p: FacilityParams = DEFAULT_PARAMS,
): Fixed {
  const capUsdc = state.netAssetsIls.mul(p.capRatio).div(spot, 6, Rounding.Floor);
  const gap = capUsdc.sub(state.availableUsdc);
  return gap.isNegative() ? Fixed.zero(6) : gap;
}
