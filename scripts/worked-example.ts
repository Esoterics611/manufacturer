/**
 * One day in the life of the fund, end to end, with real numbers.
 *
 *   npm run worked-example
 *
 * Every figure below comes from the same code the product would run. Nothing is
 * hard-coded except the market inputs and the parameters, which are labelled.
 */

import { Fixed, Rounding } from '../src/domain/fixed';
import { FxRate, USD, ILS } from '../src/domain/money';
import { DayCount, yearFraction } from '../src/domain/daycount';
import { Center, holidaysFrom } from '../src/domain/calendar';
import { cipForward, forwardFromBasis, basisBp, syntheticLeg } from '../src/pricing/cip';
import { ForwardBook } from '../src/hedge/book';
import { Side } from '../src/hedge/forward';
import { preTradeCheck, assessExemption, eligibleContractParticipant, fallbackPath }
  from '../src/compliance/cpo';
import { Bill, ValuationPolicy, ladderValue, weightedAverageMaturity } from '../src/nav/bills';
import { strikeNav, accrueFee, costReport, feeTest } from '../src/nav/nav';
import { quote, spreadCeilingBp, DEFAULT_PARAMS } from '../src/facility/redemption';
import { price, DealSide } from '../src/subscription/dealing';

const d = (iso: string) => new Date(`${iso}Z`);
const bp = (f: Fixed) => `${f.mul(Fixed.parse('10000', 0)).rescale(1, Rounding.HalfEven)}bp`;
const h = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);
const row = (k: string, v: string) => console.log(`  ${k.padEnd(46)} ${v.padStart(20)}`);

// --- market inputs, 3 September 2026 ---------------------------------------
const spot = FxRate.of(USD, ILS, '3.02');
const rUsd = Fixed.parse('0.0387', 6);
const rIls = Fixed.parse('0.0400', 6);   // Bank of Israel policy rate. NOT a promise.
const tradedBasis = Fixed.parse('-28', 4); // bp: median -17.7 plus crowded-side cost
const annualVol = Fixed.parse('0.08', 4);
const feeRate = Fixed.parse('0.0045', 6);

const start = d('2026-09-03T00:00:00');
const maturity = d('2026-12-03T00:00:00');
const yfUsd = yearFraction(start, maturity, DayCount.Act360);
const yfIls = yearFraction(start, maturity, DayCount.Act365F);

const cals = [holidaysFrom(Center.NewYork, []), holidaysFrom(Center.TelAviv, [])];

h('1. The hedge — covered interest parity, then what it actually costs');
const parity = cipForward({ spot, baseRate: rUsd, quoteRate: rIls, baseYf: yfUsd, quoteYf: yfIls });
const traded = forwardFromBasis(
  { spot, baseRate: rUsd, quoteRate: rIls, baseYf: yfUsd, quoteYf: yfIls }, tradedBasis,
);
row('USD/ILS spot', spot.rate.toString());
row('3m parity forward', parity.rate.toString());
row('3m traded forward', traded.rate.toString());
row('realised basis', bp(basisBp(traded, {
  spot, baseRate: rUsd, quoteRate: rIls, baseYf: yfUsd, quoteYf: yfIls,
}).div(Fixed.parse('10000', 0), 8)));

const leg = syntheticLeg(Fixed.parse('10000000.00', 2), spot, traded, rUsd, yfUsd, yfIls);
row('T-bills mature to, USD', leg.baseAtMaturity.toString());
row('delivered into the forward, ILS', leg.quoteAtMaturity.toString());
row('shekel return, annualised', `${leg.annualised.mul(Fixed.parse('100', 0)).rescale(3)}%`);

h('2. The dollar leg — a 91-day bill ladder');
const bills: Bill[] = [
  { cusip: 'BILL-DEC26', face: Fixed.parse('5000000.00', 2), purchaseDate: start,
    maturityDate: maturity, purchasePrice: Fixed.parse('0.9902', 10),
    policy: ValuationPolicy.AmortisedCost },
  { cusip: 'BILL-OCT26', face: Fixed.parse('5000000.00', 2), purchaseDate: start,
    maturityDate: d('2026-10-15T00:00:00'), purchasePrice: Fixed.parse('0.9955', 10),
    policy: ValuationPolicy.AmortisedCost },
];
const asOf = d('2026-09-10T00:00:00'); // Thursday: a joint good business day
row('ladder value, USD', ladderValue(bills, asOf).toString());
row('weighted-average days to maturity', weightedAverageMaturity(bills, asOf).toString());

h('3. The NAV strike');
const netAssetsPrior = Fixed.parse('30000000.00', 2);
const fee = accrueFee(netAssetsPrior, feeRate, d('2026-09-03T00:00:00'), asOf);
const nav = strikeNav({
  asOf,
  billsUsd: ladderValue(bills, asOf),
  cashUsd: Fixed.parse('120000.00', 2),
  cashIls: Fixed.zero(2),
  forwardMtmIls: Fixed.parse('-41000.00', 2),
  accruedFeeIls: fee,
  otherAccrualsIls: Fixed.parse('9000.00', 2),
  unitsOutstanding: Fixed.parse('30000000', 18),
  strikeSpot: spot,
  lastStrike: d('2026-09-09T00:00:00'),
}, cals);
row('gross assets, ILS', nav.grossAssetsIls.toString());
row('accrued fee (7 days at 45bp), ILS', fee.toString());
row('net assets, ILS', nav.netAssetsIls.toString());
row('NAV per unit, ILS', nav.navPerUnitIls.toString());
row('NAV per unit, USDC', nav.navPerUnitUsdc.toString());

h('4. The 4.13(a)(3) gate — checked before the ticket, not overnight');
const book = new ForwardBook().with({
  id: 'FWD-DEC26', base: USD, quote: ILS, side: Side.BuyQuote,
  baseNotional: Fixed.parse('9900000.00', 2), contractRate: traded.rate,
  tradeDate: start, valueDate: maturity, initialMargin: Fixed.parse('297000.00', 2),
});
const liquidationValue = nav.netAssetsIls.div(spot.rate, 2, Rounding.Floor);
const poolState = {
  liquidationValue,
  aggregateInitialMargin: book.initialMargin(),
  aggregateNetNotional: book.netNotional(),
};
row('liquidation value, USD', liquidationValue.toString());
row('aggregate initial margin, USD', poolState.aggregateInitialMargin.toString());
row('aggregate net notional, USD', poolState.aggregateNetNotional.toString());

const exemption = assessExemption(poolState, {
  exemptFromSecuritiesRegistration: true,
  notMarketedAsCommodityVehicle: true,
  allParticipantsEligible: true,
});
row('margin arm (limit 5%)', `${exemption.trading.marginArm.ratio.mul(Fixed.parse('100', 0)).rescale(2)}%`);
row('notional arm (limit 100%)', `${exemption.trading.notionalArm.ratio.mul(Fixed.parse('100', 0)).rescale(2)}%`);
row('relief available', String(exemption.available));
row('carried by', exemption.trading.reliedOn);
row('path', fallbackPath(exemption, true));
row('ECP', eligibleContractParticipant(liquidationValue, true).qualifies ? 'yes' : 'NO — RFED live');

h('5. A $1m creation, swing-priced');
const deal = price(nav, {
  side: DealSide.Create,
  amount: Fixed.parse('1000000.000000', 6),
  realisedExecutionCost: Fixed.parse('0.0028', 6), // what the hedge actually cost
});
row('swing charged', bp(deal.swing));
row('deal price, USDC/unit', deal.dealPriceUsdc.toString());
row('units issued', deal.units.rescale(6).toString());
row('retained for existing holders, USDC', deal.swingRetainedUsdc.toString());

const gate = preTradeCheck(poolState, {
  additionalInitialMargin: Fixed.parse('30000.00', 2),
  netNotionalDelta: Fixed.parse('1000000.00', 2),
});
row('hedge ticket', gate.allowed ? `allowed — ${gate.reason}` : gate.reason);

h('6. The standing facility, Friday afternoon and Saturday night');
const state = {
  availableUsdc: Fixed.parse('480000.000000', 6),
  netAssetsIls: nav.netAssetsIls,
  preHedgedRatio: Fixed.parse('1', 0),
};
for (const [label, when, st] of [
  ['Friday 12:00 UTC, FX open', d('2026-09-11T12:00:00'), state],
  ['Saturday 12:00 UTC, pre-hedged', d('2026-09-12T12:00:00'), state],
  ['Saturday 12:00 UTC, NOT pre-hedged', d('2026-09-12T12:00:00'),
    { ...state, preHedgedRatio: Fixed.zero(2) }],
] as const) {
  const q = quote(nav, when, annualVol, st, DEFAULT_PARAMS);
  if (q.status === 'OPEN') {
    row(label, `${q.haircutBp} haircut, bid ${q.bidUsdcPerUnit}`);
  } else {
    row(label, `SUSPENDED — ${q.rule}`);
  }
}
const fri = quote(nav, d('2026-09-11T12:00:00'), annualVol, state);
row('market-maker spread ceiling', `${spreadCeilingBp(fri)}bp`);

h('7. The cost line, published — and the fee test at the forecast rate');
for (const [label, gross] of [['at today 4.00%', '0.0400'], ['at the BoI 12m forecast 3.00%', '0.0300']] as const) {
  const report = costReport({
    grossPolicyRate: Fixed.parse(gross, 6),
    managementFee: feeRate,
    basisCost: Fixed.parse('0.0018', 6),
    executionCost: Fixed.parse('0.0010', 6),
    operatingCost: Fixed.parse('0.0008', 6),
  });
  const test = feeTest(report, Fixed.parse('0.20', 4));
  row(label, `net ${report.bp.netToHolder}bp, drag ${report.bp.totalDrag}bp ` +
    `(${test.share.mul(Fixed.parse('100', 0)).rescale(1)}% of gross, ${test.pass ? 'pass' : 'FAIL'})`);
}
console.log('\n  The product is "the shekel policy rate", not "4%". Never put the number in the name.\n');
