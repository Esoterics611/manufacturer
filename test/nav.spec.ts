import { Fixed } from '../src/domain/fixed';
import { FxRate, USD, ILS } from '../src/domain/money';
import { Center, holidaysFrom, emptyHolidays } from '../src/domain/calendar';
import { strikeNav, accrueFee, costReport, feeTest, OffWindowStrikeError, NavInputs }
  from '../src/nav/nav';
import { Bill, ValuationPolicy, amortisedPrice, discountPrice, moneyMarketYield,
  ladderValue, maturingFace, weightedAverageMaturity } from '../src/nav/bills';

const US = holidaysFrom(Center.NewYork, []);
const IL = holidaysFrom(Center.TelAviv, []);
const cals = [US, IL];
const d = (iso: string) => new Date(`${iso}T00:00:00Z`);

const base: NavInputs = {
  asOf: d('2026-09-08'),                 // Tuesday: a joint good day
  billsUsd: Fixed.parse('9900000.00', 2),
  cashUsd: Fixed.parse('100000.00', 2),
  cashIls: Fixed.zero(2),
  forwardMtmIls: Fixed.zero(2),
  accruedFeeIls: Fixed.parse('12410.96', 2),
  otherAccrualsIls: Fixed.parse('5000.00', 2),
  unitsOutstanding: Fixed.parse('30000000', 18),
  strikeSpot: FxRate.of(USD, ILS, '3.02'),
  lastStrike: d('2026-09-07'),
};

describe('the NAV strike', () => {
  it('translates a dollar book into a shekel NAV at the published fixing', () => {
    const n = strikeNav(base, cals);
    expect(n.grossAssetsIls.toString()).toBe('30200000.00');
    expect(n.liabilitiesIls.toString()).toBe('17410.96');
    expect(n.netAssetsIls.toString()).toBe('30182589.04');
    expect(n.navPerUnitIls.toNumber()).toBeCloseTo(1.00608630, 8);
    expect(n.staleDays).toBe(1);
  });

  it('quotes the redemption reference back in USDC at the same fixing', () => {
    const n = strikeNav(base, cals);
    expect(n.navPerUnitUsdc.toNumber()).toBeCloseTo(1.00608630 / 3.02, 6);
  });

  it('puts forward P&L into NAV where the holder can see it', () => {
    const up = strikeNav({ ...base, forwardMtmIls: Fixed.parse('150000.00', 2) }, cals);
    const flat = strikeNav(base, cals);
    expect(up.netAssetsIls.sub(flat.netAssetsIls).toString()).toBe('150000.00');
  });

  it('rounds NAV per unit down — the fund never over-credits a holder', () => {
    const n = strikeNav({ ...base, unitsOutstanding: Fixed.parse('7', 18) }, cals);
    const implied = n.navPerUnitIls.mul(Fixed.parse('7', 0));
    expect(implied.lte(n.netAssetsIls)).toBe(true);
  });

  it('refuses to strike on a day only one centre is open', () => {
    expect(() => strikeNav({ ...base, asOf: d('2026-09-06') }, cals))  // Sunday
      .toThrow(OffWindowStrikeError);
    expect(() => strikeNav({ ...base, asOf: d('2026-09-04') }, cals))  // Friday
      .toThrow(OffWindowStrikeError);
  });

  it('refuses to strike against an unseeded holiday calendar', () => {
    expect(() => strikeNav(base, [US, emptyHolidays(Center.TelAviv)])).toThrow(/not seeded/);
  });

  it('reports a weekend strike as stale by four days, not one', () => {
    const monday = strikeNav({ ...base, asOf: d('2026-09-14'), lastStrike: d('2026-09-10') }, cals);
    expect(monday.staleDays).toBe(4);
  });
});

describe('fee accrual', () => {
  it("accrues daily on ACT/365F and rounds in the fund's favour", () => {
    const fee = accrueFee(
      Fixed.parse('30182589.04', 2), Fixed.parse('0.0045', 6), d('2026-09-07'), d('2026-09-08'),
    );
    // 30,182,589.04 * 0.45% / 365 = 372.114, rounded up: the fund does not under-charge
    expect(fee.toNumber()).toBeCloseTo(372.12, 2);
  });

  it('accrues across the weekend the fund does not strike on', () => {
    const three = accrueFee(
      Fixed.parse('30000000.00', 2), Fixed.parse('0.0045', 6), d('2026-09-10'), d('2026-09-14'),
    );
    const one = accrueFee(
      Fixed.parse('30000000.00', 2), Fixed.parse('0.0045', 6), d('2026-09-07'), d('2026-09-08'),
    );
    expect(three.toNumber()).toBeCloseTo(one.toNumber() * 4, 1);
  });
});

describe('the published cost line', () => {
  it('adds up, and nets to what the holder actually receives', () => {
    const r = costReport({
      grossPolicyRate: Fixed.parse('0.0400', 6),
      managementFee: Fixed.parse('0.0045', 6),
      basisCost: Fixed.parse('0.0018', 6),
      executionCost: Fixed.parse('0.0012', 6),
      operatingCost: Fixed.parse('0.0008', 6),
    });
    expect(r.bp.totalDrag).toBe('83.0');
    expect(r.bp.netToHolder).toBe('317.0');
  });

  it("fails the fee test at the Bank of Israel's own 3% forecast, not at today's 4%", () => {
    const line = {
      managementFee: Fixed.parse('0.0045', 6),
      basisCost: Fixed.parse('0.0030', 6),
      executionCost: Fixed.parse('0.0010', 6),
      operatingCost: Fixed.parse('0.0008', 6),
    };
    const maxShare = Fixed.parse('0.20', 4);
    const atFour = feeTest(costReport({ ...line, grossPolicyRate: Fixed.parse('0.0400', 6) }), maxShare);
    const atThree = feeTest(costReport({ ...line, grossPolicyRate: Fixed.parse('0.0300', 6) }), maxShare);
    expect(atFour.share.toNumber()).toBeCloseTo(0.2325, 4);
    expect(atFour.pass).toBe(false);
    expect(atThree.share.toNumber()).toBeCloseTo(0.31, 2);
    expect(atThree.pass).toBe(false);
    // The design constraint: the fee has to be set off the forecast, not the screen.
  });
});

describe('the bill ladder', () => {
  const bill: Bill = {
    cusip: 'TEST0001',
    face: Fixed.parse('1000000.00', 2),
    purchaseDate: d('2026-09-03'),
    maturityDate: d('2026-12-03'),   // 91 days
    purchasePrice: Fixed.parse('0.9902', 10),
    policy: ValuationPolicy.AmortisedCost,
  };

  it('prices a bill off its quoted discount rate on ACT/360', () => {
    const p = discountPrice(Fixed.parse('0.0387', 6), d('2026-09-03'), d('2026-12-03'));
    expect(p.toNumber()).toBeCloseTo(1 - 0.0387 * (91 / 360), 9);
  });

  it('converts a purchase price to a money-market yield', () => {
    const y = moneyMarketYield(Fixed.parse('0.9902', 10), d('2026-09-03'), d('2026-12-03'));
    expect(y.toNumber()).toBeCloseTo((1 - 0.9902) / (0.9902 * (91 / 360)), 6);
  });

  it('accretes straight-line to par and does not overshoot past maturity', () => {
    expect(amortisedPrice(bill, d('2026-09-03')).toNumber()).toBeCloseTo(0.9902, 10);
    expect(amortisedPrice(bill, d('2026-10-19')).toNumber()).toBeCloseTo(0.9902 + 0.0098 * (46 / 91), 8);
    expect(amortisedPrice(bill, d('2026-12-03')).toNumber()).toBeCloseTo(1, 10);
    expect(amortisedPrice(bill, d('2027-01-15')).toNumber()).toBeCloseTo(1, 10);
  });

  it('values a ladder and reports what matures into the facility', () => {
    const b2: Bill = { ...bill, cusip: 'TEST0002', maturityDate: d('2027-03-03'),
      face: Fixed.parse('2000000.00', 2), purchasePrice: Fixed.parse('0.9805', 10) };
    const ladder = [bill, b2];
    expect(ladderValue(ladder, d('2026-09-03')).toNumber()).toBeCloseTo(990200 + 1961000, 2);
    expect(maturingFace(ladder, d('2026-12-31')).toString()).toBe('1000000.00');
    expect(weightedAverageMaturity(ladder, d('2026-09-03')).toNumber())
      .toBeCloseTo((1_000_000 * 91 + 2_000_000 * 181) / 3_000_000, 3);
  });
});
