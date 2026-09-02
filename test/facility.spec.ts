/**
 * The facility is where PLAN.md §11's arithmetic breaks for this product, so
 * these tests are written to pin the correction rather than the original claim.
 */

import { Fixed } from '../src/domain/fixed';
import { FxRate, USD, ILS } from '../src/domain/money';
import { fxIsOpen, hoursUntilFxOpen } from '../src/domain/calendar';
import { NavStrike } from '../src/nav/nav';
import {
  quote, execute, refillNeeded, spreadCeilingBp, preHedgeCarryCost, DEFAULT_PARAMS, FacilityState,
} from '../src/facility/redemption';

const t = (iso: string) => new Date(`${iso}Z`);

const last: NavStrike = {
  asOf: t('2026-09-10T00:00:00'),          // Thursday strike
  grossAssetsIls: Fixed.parse('30200000.00', 2),
  liabilitiesIls: Fixed.parse('17410.96', 2),
  netAssetsIls: Fixed.parse('30182589.04', 2),
  navPerUnitIls: Fixed.parse('1.00608630', 8),
  navPerUnitUsdc: Fixed.parse('0.333142', 6),
  unitsOutstanding: Fixed.parse('30000000', 18),
  strikeSpot: FxRate.of(USD, ILS, '3.02'),
  staleDays: 1,
};

const hedged: FacilityState = {
  availableUsdc: Fixed.parse('500000.000000', 6),
  netAssetsIls: Fixed.parse('30182589.04', 2),
  preHedgedRatio: Fixed.parse('1', 0),
};
const naked: FacilityState = { ...hedged, preHedgedRatio: Fixed.zero(2) };

const vol = Fixed.parse('0.08', 4); // 8% annualised USD/ILS

const FRIDAY_OPEN = t('2026-09-11T12:00:00');   // FX open
const SATURDAY = t('2026-09-12T12:00:00');      // FX shut, 34h to the Sunday open
const MONDAY = t('2026-09-14T12:00:00');        // FX open, NAV 4 days stale

describe('the FX session, which is the facility risk clock', () => {
  it('is shut from Friday 22:00 UTC to Sunday 22:00 UTC', () => {
    expect(fxIsOpen(FRIDAY_OPEN)).toBe(true);
    expect(fxIsOpen(t('2026-09-11T22:30:00'))).toBe(false);
    expect(fxIsOpen(SATURDAY)).toBe(false);
    expect(fxIsOpen(t('2026-09-13T21:00:00'))).toBe(false);
    expect(fxIsOpen(t('2026-09-13T22:30:00'))).toBe(true);
    expect(fxIsOpen(MONDAY)).toBe(true);
  });

  it('counts the hours to the reopen', () => {
    expect(hoursUntilFxOpen(SATURDAY)).toBeCloseTo(34, 6);
    expect(hoursUntilFxOpen(FRIDAY_OPEN)).toBe(0);
  });
});

describe('the haircut, priced against what can actually be hedged', () => {
  it('is tight while the market is open, because the hedge lag is minutes', () => {
    const q = quote(last, FRIDAY_OPEN, vol, naked);
    if (q.status !== 'OPEN') throw new Error('expected open');
    expect(q.breakdown.fxMarketOpen).toBe(true);
    expect(q.haircutBp.toNumber()).toBeCloseTo(21.2, 0);
    expect(q.bidUsdcPerUnit.lt(last.navPerUnitUsdc)).toBe(true);
  });

  it('blows out over the weekend if the desk did not pre-hedge', () => {
    const q = quote(last, SATURDAY, vol, naked);
    if (q.status !== 'OPEN') throw new Error('expected open');
    expect(q.breakdown.fxMarketOpen).toBe(false);
    // ~65bp of unhedgeable USD/ILS gap. A 25bp facility here is a free option.
    expect(q.breakdown.fxGap.mul(Fixed.parse('10000', 0)).toNumber()).toBeGreaterThan(60);
    expect(q.haircutBp.toNumber()).toBeGreaterThan(70);
  });

  it('collapses back to a real price once the cap is pre-hedged', () => {
    const q = quote(last, SATURDAY, vol, hedged);
    if (q.status !== 'OPEN') throw new Error('expected open');
    expect(q.breakdown.fxGap.isZero()).toBe(true);
    expect(q.haircutBp.toNumber()).toBeCloseTo(11, 0);
  });

  it('makes the pre-hedge an obvious trade: fractions of a bp against 65 of them', () => {
    const cost = preHedgeCarryCost(
      DEFAULT_PARAMS.capRatio, Fixed.parse('0.04', 4), Fixed.parse('0.0387', 6), 2,
    );
    const costBp = cost.mul(Fixed.parse('10000', 0)).toNumber();
    expect(costBp).toBeLessThan(0.01);
  });

  it('charges for staleness separately from the FX gap', () => {
    const q = quote(last, MONDAY, vol, hedged);
    if (q.status !== 'OPEN') throw new Error('expected open');
    expect(q.staleDays).toBe(4);
    expect(q.breakdown.staleness.mul(Fixed.parse('10000', 0)).toNumber()).toBeCloseTo(2, 1);
  });

  it('sets the market-maker spread ceiling, which is the point of paying for it', () => {
    const q = quote(last, FRIDAY_OPEN, vol, hedged);
    expect(spreadCeilingBp(q)!.toNumber()).toBeCloseTo(10.5, 1);
  });
});

describe('suspension, by published rule and never by discretion', () => {
  it('suspends on volatility above the threshold', () => {
    const q = quote(last, FRIDAY_OPEN, Fixed.parse('0.25', 4), hedged);
    expect(q.status).toBe('SUSPENDED');
    if (q.status === 'SUSPENDED') expect(q.rule).toMatch(/volatility/);
  });

  it('suspends when the NAV it would bid against is too old to trust', () => {
    const q = quote(last, t('2026-09-20T12:00:00'), vol, hedged);
    expect(q.status).toBe('SUSPENDED');
    if (q.status === 'SUSPENDED') expect(q.rule).toMatch(/stale/);
  });

  it('suspends rather than quoting past the ceiling, and names the pre-hedge', () => {
    const q = quote(last, SATURDAY, Fixed.parse('0.19', 4), naked);
    expect(q.status).toBe('SUSPENDED');
    if (q.status === 'SUSPENDED') {
      expect(q.rule).toMatch(/ceiling/);
      expect(q.rule).toMatch(/pre-hedge/);
    }
  });
});

describe('capacity', () => {
  it('is bounded by cash and by the 5% cap, whichever binds first', () => {
    const q = quote(last, FRIDAY_OPEN, vol, hedged);
    if (q.status !== 'OPEN') throw new Error('expected open');
    // 5% of 30,182,589 ILS = 1,509,129 ILS = ~499,712 USDC; cash is 500,000.
    const capacityUsdc = q.capacityUnits.mul(q.bidUsdcPerUnit).toNumber();
    expect(capacityUsdc).toBeLessThan(500_000);
    expect(capacityUsdc).toBeGreaterThan(490_000);
  });

  it('fills partially and refuses the excess rather than breaking the cap', () => {
    const q = quote(last, FRIDAY_OPEN, vol, hedged);
    if (q.status !== 'OPEN') throw new Error('expected open');
    const request = q.capacityUnits.add(Fixed.parse('1000000', 18));
    const fill = execute(q, request, hedged);
    expect(fill.unitsAccepted.eq(q.capacityUnits)).toBe(true);
    expect(fill.unitsRefused.toNumber()).toBeCloseTo(1_000_000, 0);
    expect(fill.remainingUsdc.isNegative()).toBe(false);
  });

  it('pays nothing while suspended', () => {
    const q = quote(last, FRIDAY_OPEN, Fixed.parse('0.25', 4), hedged);
    const fill = execute(q, Fixed.parse('1000', 18), hedged);
    expect(fill.usdcPaid.isZero()).toBe(true);
    expect(fill.unitsRefused.toNumber()).toBe(1000);
  });

  it('computes the refill the maturing ladder has to fund', () => {
    const drained: FacilityState = { ...hedged, availableUsdc: Fixed.parse('100000.000000', 6) };
    expect(refillNeeded(drained, last.strikeSpot.rate).toNumber()).toBeCloseTo(399_712, 0);
    expect(refillNeeded(hedged, last.strikeSpot.rate).toNumber()).toBeLessThan(1);
  });
});
