/**
 * The desk report — everything an operator has to look at once a day, in one
 * object, with the things that need a decision ranked at the top.
 *
 * This is the administrator toolset's whole surface. It reads; it never writes.
 * Every mutating operation goes through the transfer agent register, which is
 * rented, and every hedge ticket goes through the pre-trade gate. An admin tool
 * that can move units is a transfer agent, and we do not build one of those.
 */

import { Fixed, Rounding } from '../domain/fixed';
import { MarketSnapshot, estimatedFields } from '../market/snapshot';
import { CarryReport, DragAssumptions, carryReport, shekelBreakevenMove } from '../market/carry';
import { NavStrike } from '../nav/nav';
import { ForwardBook } from '../hedge/book';
import {
  PoolState, OfferingConditions, ExemptionReport, assessExemption, eligibleContractParticipant,
  fallbackPath,
} from '../compliance/cpo';
import { FacilityState, FacilityQuote, quote, DEFAULT_PARAMS, FacilityParams } from '../facility/redemption';
import { Holder, SleeveConfig, addressableNote } from '../eligibility/holder';
import { RegistryState, holderCapHeadroom, expiringAttestations } from '../eligibility/rules';
import { Reconciliation } from '../register/reconcile';

const BP = Fixed.parse('10000', 0);
const bp = (f: Fixed): Fixed => f.mul(BP).rescale(1, Rounding.HalfEven);

export type Severity = 'BLOCK' | 'WARN' | 'INFO';

export interface Alert {
  readonly severity: Severity;
  readonly code: string;
  readonly message: string;
}

export interface DeskInput {
  readonly asOf: Date;
  readonly market: MarketSnapshot;
  readonly drag: DragAssumptions;
  readonly nav: NavStrike;
  readonly book: ForwardBook;
  readonly pool: PoolState;
  readonly offering: OfferingConditions;
  readonly facilityState: FacilityState;
  readonly facilityParams?: FacilityParams;
  readonly sleeve: SleeveConfig;
  readonly holders: readonly Holder[];
  readonly registry: RegistryState;
  readonly reconciliation: Reconciliation;
}

export interface DeskReport {
  readonly asOf: Date;
  readonly carry: CarryReport;
  readonly nav: NavStrike;
  readonly hedge: {
    readonly netNotional: Fixed;
    readonly grossNotional: Fixed;
    readonly initialMargin: Fixed;
    readonly hedgeRatio: Fixed;
    readonly rollQueue: number;
  };
  readonly compliance: {
    readonly exemption: ExemptionReport;
    readonly marginArmPct: Fixed;
    readonly notionalArmPct: Fixed;
    readonly marginHeadroom: Fixed;
    readonly notionalHeadroom: Fixed;
    readonly ecp: boolean;
    readonly path: string;
  };
  readonly facility: {
    readonly now: FacilityQuote;
    readonly weekendUnhedged: FacilityQuote;
    readonly preHedgedRatio: Fixed;
    /** Sigmas of cover the haircut buys, against sigmas the market printed. */
    readonly coverSigmas: Fixed;
    readonly observedSigmas: Fixed;
  };
  readonly register: {
    readonly holdersOfRecord: number;
    readonly capHeadroom: number | null;
    readonly exclusion: string;
    readonly addressable: string;
    readonly attestationsExpiring30d: number;
    readonly reconciliation: Reconciliation;
  };
  readonly alerts: readonly Alert[];
}

const SEVERITY_ORDER: Record<Severity, number> = { BLOCK: 0, WARN: 1, INFO: 2 };

export function deskReport(i: DeskInput): DeskReport {
  const params = i.facilityParams ?? DEFAULT_PARAMS;
  const carry = carryReport(i.market, i.drag);
  const exemption = assessExemption(i.pool, i.offering);
  const ecp = eligibleContractParticipant(i.pool.liquidationValue, true);

  const navInBase = i.nav.netAssetsIls.div(i.market.spot.rate, 2, Rounding.Floor);
  const hedgeRatio = i.book.hedgeRatio(navInBase);

  // Saturday noon UTC of the coming weekend, with the pre-hedge off — the
  // scenario the desk has to have decided about before Friday's close.
  const weekend = nextSaturdayNoon(i.asOf);
  const facilityNow = quote(i.nav, i.asOf, i.market.usdIlsAnnualVol.value, i.facilityState, params);
  const facilityWeekend = quote(
    i.nav, weekend, i.market.usdIlsAnnualVol.value,
    { ...i.facilityState, preHedgedRatio: Fixed.zero(2) }, params,
  );

  const capHeadroom = holderCapHeadroom({
    asOf: i.asOf, sleeve: i.sleeve, registry: i.registry,
  });
  const expiring = expiringAttestations(
    i.holders, { asOf: i.asOf, sleeve: i.sleeve, registry: i.registry }, 30,
  );

  const alerts: Alert[] = [];

  // --- compliance, which blocks rather than warns ---------------------------
  if (!exemption.available) {
    alerts.push({ severity: 'BLOCK', code: 'CPO-4.13',
      message: `4.13(a)(3) relief unavailable: ${exemption.failures.join('; ')}. ` +
        `Fallback: ${fallbackPath(exemption, true)}` });
  } else if (exemption.trading.reliedOn === 'MARGIN') {
    alerts.push({ severity: 'WARN', code: 'CPO-ONE-ARM',
      message: `Relief carried by the margin arm alone. Net notional is ` +
        `${pct(exemption.trading.notionalArm.ratio)} of liquidation value. A margin call now ` +
        `breaches both arms.` });
  }
  if (!ecp.qualifies) {
    alerts.push({ severity: 'BLOCK', code: 'ECP', message: ecp.reason });
  }

  // --- hedge ---------------------------------------------------------------
  if (hedgeRatio.gt(Fixed.parse('1.02', 4))) {
    alerts.push({ severity: 'WARN', code: 'HEDGE-OVER',
      message: `Hedge ratio ${hedgeRatio} is above the 1.00 mandate and above the 4.13(a)(3) ` +
        `notional arm. Reduce before the next ticket.` });
  } else if (hedgeRatio.lt(Fixed.parse('0.98', 4))) {
    alerts.push({ severity: 'WARN', code: 'HEDGE-UNDER',
      message: `Hedge ratio ${hedgeRatio} leaves unhedged shekel NAV. The fund does not take a ` +
        `currency view.` });
  }
  const rolls = i.book.maturingBy(addDays(i.asOf, 10)).length;
  if (rolls > 0) {
    alerts.push({ severity: 'INFO', code: 'ROLL',
      message: `${rolls} forward(s) mature within ten days. Each roll pays the basis again.` });
  }

  // --- facility ------------------------------------------------------------
  if (i.facilityState.preHedgedRatio.lt(Fixed.parse('1', 0))) {
    const wide = facilityWeekend.status === 'OPEN'
      ? `${facilityWeekend.haircutBp}bp` : 'suspension';
    alerts.push({ severity: 'WARN', code: 'FACILITY-PREHEDGE',
      message: `Pre-hedge is ${pct(i.facilityState.preHedgedRatio)} of the cap. Unhedged into a ` +
        `weekend the facility must quote ${wide}. Put the pre-hedge on before Friday's close.` });
  }
  if (facilityNow.status === 'SUSPENDED') {
    alerts.push({ severity: 'WARN', code: 'FACILITY-SUSPENDED',
      message: `Facility suspended by rule: ${facilityNow.rule}` });
  }

  // --- register ------------------------------------------------------------
  if (capHeadroom !== null && capHeadroom <= 10) {
    alerts.push({ severity: capHeadroom === 0 ? 'BLOCK' : 'WARN', code: 'HOLDER-CAP',
      message: `${capHeadroom} holder slot(s) left under ${i.sleeve.exclusion}. ` +
        `${addressableNote(i.sleeve)}` });
  }
  if (expiring.length > 0) {
    alerts.push({ severity: 'WARN', code: 'ATTESTATION',
      message: `${expiring.length} attestation(s) expire within 30 days. A lapsed holder cannot ` +
        `receive units, including their own redemption reversal.` });
  }
  if (!i.reconciliation.clean) {
    const drift = i.reconciliation.breaks.filter((b) => b.kind === 'ELIGIBILITY_DRIFT').length;
    alerts.push({ severity: drift > 0 ? 'BLOCK' : 'WARN', code: 'RECON',
      message: `${i.reconciliation.breaks.length} break(s) against the chain` +
        (drift > 0 ? `, ${drift} of them eligibility drift: the chain would permit a transfer ` +
          `the register refuses` : '') });
  }

  // --- is the facility's cover actually cover? ------------------------------
  const dailySigma = i.market.usdIlsAnnualVol.value
    .div(Fixed.fromNumber(Math.sqrt(252), 8), 8, Rounding.HalfEven);
  const observedSigmas = dailySigma.isZero()
    ? Fixed.zero(2)
    : i.market.maxDailyMove30d.value.div(dailySigma, 2, Rounding.Ceil);
  if (observedSigmas.gt(params.volMultiple)) {
    alerts.push({ severity: 'WARN', code: 'FACILITY-COVER',
      message: `The largest daily USD/ILS move in the last thirty sessions was ` +
        `${pct(i.market.maxDailyMove30d.value)}, or ${observedSigmas} sigma. The facility ` +
        `haircut covers ${params.volMultiple} sigma. On an unhedged weekend that cover is ` +
        `short — raise volMultiple, or treat the pre-hedge as mandatory rather than a target.` });
  }

  // --- the market, which is the reason to read the rest ---------------------
  if (carry.vsDollarBillFund.isNegative()) {
    alerts.push({ severity: 'WARN', code: 'CARRY-INVERTED',
      message: `${carry.verdict} Shekel must appreciate ` +
        `${pct(shekelBreakevenMove(carry, Fixed.parse('1', 0)).neg())} over a year for a ` +
        `dollar-based holder to break even against dollar bills.` });
  }
  const estimated = estimatedFields(i.market);
  if (estimated.length > 0) {
    alerts.push({ severity: 'INFO', code: 'DATA-ESTIMATED',
      message: `Estimated, not observed: ${estimated.join(', ')}. Every other input is read ` +
        `from a primary source and dated. The basis is the last one still carried from a ` +
        `research document — it needs a dealer quote or a run of executed rolls.` });
  }

  alerts.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

  return {
    asOf: i.asOf,
    carry,
    nav: i.nav,
    hedge: {
      netNotional: i.book.netNotional(),
      grossNotional: i.book.grossNotional(),
      initialMargin: i.book.initialMargin(),
      hedgeRatio,
      rollQueue: rolls,
    },
    compliance: {
      exemption,
      marginArmPct: exemption.trading.marginArm.ratio.mul(Fixed.parse('100', 0)).rescale(2),
      notionalArmPct: exemption.trading.notionalArm.ratio.mul(Fixed.parse('100', 0)).rescale(2),
      marginHeadroom: exemption.trading.marginArm.headroom,
      notionalHeadroom: exemption.trading.notionalArm.headroom,
      ecp: ecp.qualifies,
      path: fallbackPath(exemption, true),
    },
    facility: {
      now: facilityNow,
      weekendUnhedged: facilityWeekend,
      preHedgedRatio: i.facilityState.preHedgedRatio,
      coverSigmas: params.volMultiple,
      observedSigmas,
    },
    register: {
      holdersOfRecord: i.registry.holdersOfRecord,
      capHeadroom,
      exclusion: i.sleeve.exclusion,
      addressable: addressableNote(i.sleeve),
      attestationsExpiring30d: expiring.length,
      reconciliation: i.reconciliation,
    },
    alerts,
  };
}

export function blockingAlerts(r: DeskReport): readonly Alert[] {
  return r.alerts.filter((a) => a.severity === 'BLOCK');
}

/** True when the desk may accept a subscription today. */
export function openForBusiness(r: DeskReport): boolean {
  return blockingAlerts(r).length === 0;
}

function pct(f: Fixed): string {
  return `${f.mul(Fixed.parse('100', 0)).rescale(1, Rounding.HalfEven)}%`;
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86_400_000);
}

function nextSaturdayNoon(d: Date): Date {
  const day = d.getUTCDay();
  const delta = ((6 - day) + 7) % 7 || 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + delta, 12));
}
