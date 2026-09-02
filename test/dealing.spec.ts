import { Fixed } from '../src/domain/fixed';
import { FxRate, USD, ILS } from '../src/domain/money';
import { NavStrike } from '../src/nav/nav';
import { price, hedgeDelta, DealSide, BelowMinimumError, DEFAULT_DEALING }
  from '../src/subscription/dealing';

const d = (iso: string) => new Date(`${iso}T00:00:00Z`);

const nav: NavStrike = {
  asOf: d('2026-09-08'),
  grossAssetsIls: Fixed.parse('30200000.00', 2),
  liabilitiesIls: Fixed.parse('17410.96', 2),
  netAssetsIls: Fixed.parse('30182589.04', 2),
  navPerUnitIls: Fixed.parse('1.00608630', 8),
  navPerUnitUsdc: Fixed.parse('0.333142', 6),
  unitsOutstanding: Fixed.parse('30000000', 18),
  strikeSpot: FxRate.of(USD, ILS, '3.02'),
  staleDays: 1,
};

const execCost = Fixed.parse('0.0025', 6); // 25bp actually paid on the hedge

describe('swing pricing', () => {
  it('makes the arriving holder pay the cost their own order caused', () => {
    const r = price(nav, { side: DealSide.Create, amount: Fixed.parse('1000000.000000', 6),
      realisedExecutionCost: execCost });
    expect(r.swingBp.toNumber()).toBeCloseTo(30, 1); // 5bp fixed + 25bp realised
    expect(r.dealPriceUsdc.gt(nav.navPerUnitUsdc)).toBe(true);
    expect(r.swingRetainedUsdc.isNegative()).toBe(false);
  });

  it('makes the departing holder pay theirs, in the other direction', () => {
    const r = price(nav, { side: DealSide.Redeem, amount: Fixed.parse('1000000', 18),
      realisedExecutionCost: execCost });
    expect(r.dealPriceUsdc.lt(nav.navPerUnitUsdc)).toBe(true);
    expect(r.swingRetainedUsdc.isNegative()).toBe(false);
  });

  it('holds existing holders harmless in both directions', () => {
    const create = price(nav, { side: DealSide.Create, amount: Fixed.parse('5000000.000000', 6),
      realisedExecutionCost: execCost });
    const redeem = price(nav, { side: DealSide.Redeem, amount: Fixed.parse('15000000', 18),
      realisedExecutionCost: execCost });
    expect(create.swingRetainedUsdc.toNumber()).toBeGreaterThan(0);
    expect(redeem.swingRetainedUsdc.toNumber()).toBeGreaterThan(0);
  });

  it('passes on the actual execution cost, not an estimate', () => {
    const cheap = price(nav, { side: DealSide.Create, amount: Fixed.parse('1000000.000000', 6),
      realisedExecutionCost: Fixed.parse('0.0005', 6) });
    const dear = price(nav, { side: DealSide.Create, amount: Fixed.parse('1000000.000000', 6),
      realisedExecutionCost: Fixed.parse('0.0060', 6) });
    expect(cheap.swingBp.toNumber()).toBeCloseTo(10, 1);
    expect(dear.swingBp.toNumber()).toBeCloseTo(65, 1);
  });

  it('enforces the $1m creation unit', () => {
    expect(() => price(nav, { side: DealSide.Create, amount: Fixed.parse('999999.000000', 6),
      realisedExecutionCost: execCost })).toThrow(BelowMinimumError);
    expect(DEFAULT_DEALING.minimumCreationUsdc.toNumber()).toBe(1_000_000);
  });

  it('never issues more units than the cash bought', () => {
    const r = price(nav, { side: DealSide.Create, amount: Fixed.parse('1000000.000000', 6),
      realisedExecutionCost: execCost });
    expect(r.units.mul(r.dealPriceUsdc).toNumber()).toBeLessThanOrEqual(1_000_000.000001);
  });
});

describe('the hedge the deal forces', () => {
  it('is positive on a creation and negative on a redemption, at 1.00 hedge ratio', () => {
    const create = price(nav, { side: DealSide.Create, amount: Fixed.parse('1000000.000000', 6),
      realisedExecutionCost: execCost });
    const redeem = price(nav, { side: DealSide.Redeem, amount: Fixed.parse('1000000', 18),
      realisedExecutionCost: execCost });
    expect(hedgeDelta(create).isNegative()).toBe(false);
    expect(hedgeDelta(redeem).isNegative()).toBe(true);
  });
});
