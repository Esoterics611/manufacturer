/**
 * The test that decides whether the fund launches in six weeks or twelve months.
 * BUILD-ROUTES.md §4, question 3.
 */

import { Fixed } from '../src/domain/fixed';
import {
  tradingTest, assessExemption, preTradeCheck, eligibleContractParticipant, fallbackPath,
  PoolState, OfferingConditions,
} from '../src/compliance/cpo';

const usd = (s: string) => Fixed.parse(s, 2);

const clean: OfferingConditions = {
  exemptFromSecuritiesRegistration: true,
  notMarketedAsCommodityVehicle: true,
  allParticipantsEligible: true,
};

/** The fund as designed: notional at ~100% of NAV, prime-broker margin at 3%. */
const asDesigned: PoolState = {
  liquidationValue: usd('10000000'),
  aggregateInitialMargin: usd('300000'),
  aggregateNetNotional: usd('10000000'),
};

describe('4.13(a)(3) trading test', () => {
  it('passes on the margin arm while sitting exactly on the notional boundary', () => {
    const r = tradingTest(asDesigned);
    expect(r.marginArm.ratio.toNumber()).toBeCloseTo(0.03, 8);
    expect(r.marginArm.pass).toBe(true);
    expect(r.notionalArm.ratio.toNumber()).toBeCloseTo(1.0, 8);
    expect(r.notionalArm.pass).toBe(true); // <= is the rule; exactly 100% still passes
    expect(r.reliedOn).toBe('BOTH');
  });

  it('loses the notional arm on one dollar of overhedge and survives on margin', () => {
    const r = tradingTest({ ...asDesigned, aggregateNetNotional: usd('10000000.01') });
    expect(r.notionalArm.pass).toBe(false);
    expect(r.marginArm.pass).toBe(true);
    expect(r.pass).toBe(true);
    expect(r.reliedOn).toBe('MARGIN');
  });

  it('fails both arms when a margin call lands on an overhedged book', () => {
    const r = tradingTest({
      liquidationValue: usd('10000000'),
      aggregateInitialMargin: usd('600000'),
      aggregateNetNotional: usd('11000000'),
    });
    expect(r.pass).toBe(false);
    expect(r.reliedOn).toBe('NEITHER');
  });

  it('shrinks the denominator when the book is marked against the fund', () => {
    // The rule says "after taking into account unrealised profits and losses".
    // A $500k loss moves margin from 3.00% to 3.16% with no new trade.
    const marked = tradingTest({ ...asDesigned, liquidationValue: usd('9500000') });
    expect(marked.marginArm.ratio.toNumber()).toBeGreaterThan(0.0315);
    expect(marked.notionalArm.pass).toBe(false);
    expect(marked.pass).toBe(true);
  });

  it('reports headroom in dollars, not just a ratio', () => {
    const r = tradingTest(asDesigned);
    expect(r.marginArm.headroom.toString()).toBe('200000.00');
    expect(r.notionalArm.headroom.toString()).toBe('0.00');
  });
});

describe('the other three conditions', () => {
  it('is unavailable if the fund markets itself as an FX vehicle, however clean the book', () => {
    const r = assessExemption(asDesigned, { ...clean, notMarketedAsCommodityVehicle: false });
    expect(r.trading.pass).toBe(true);
    expect(r.available).toBe(false);
    expect(r.failures).toEqual([expect.stringContaining('marketing')]);
  });

  it('names every failure rather than the first', () => {
    const r = assessExemption(
      { liquidationValue: usd('10000000'), aggregateInitialMargin: usd('900000'),
        aggregateNetNotional: usd('20000000') },
      { exemptFromSecuritiesRegistration: false, notMarketedAsCommodityVehicle: false,
        allParticipantsEligible: false },
    );
    expect(r.failures).toHaveLength(4);
  });

  it('routes to 4.7 when relief is unavailable but everyone is a QEP', () => {
    const r = assessExemption({ ...asDesigned, aggregateInitialMargin: usd('900000'),
      aggregateNetNotional: usd('20000000') }, clean);
    expect(fallbackPath(r, true)).toMatch(/^4\.7/);
    expect(fallbackPath(r, false)).toMatch(/full CPO registration/);
    expect(fallbackPath(assessExemption(asDesigned, clean), false)).toMatch(/no CPO registration/);
  });
});

describe('the pre-trade gate', () => {
  it('is evaluated as of the moment the ticket is written, not overnight', () => {
    const r = preTradeCheck(asDesigned, {
      additionalInitialMargin: usd('30000'),
      netNotionalDelta: usd('1000000'),
    });
    expect(r.allowed).toBe(true);
    expect(r.after.reliedOn).toBe('MARGIN');
    expect(r.after.marginArm.ratio.toNumber()).toBeCloseTo(0.033, 6);
  });

  it('refuses a ticket that would breach both arms', () => {
    const stressed: PoolState = {
      liquidationValue: usd('10000000'),
      aggregateInitialMargin: usd('490000'),
      aggregateNetNotional: usd('10000000'),
    };
    const r = preTradeCheck(stressed, {
      additionalInitialMargin: usd('20000'),
      netNotionalDelta: usd('500000'),
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/refused/);
  });

  it('always allows a ticket that reduces exposure', () => {
    const stressed: PoolState = {
      liquidationValue: usd('10000000'),
      aggregateInitialMargin: usd('600000'),
      aggregateNetNotional: usd('11000000'),
    };
    expect(tradingTest(stressed).pass).toBe(false);
    const r = preTradeCheck(stressed, {
      additionalInitialMargin: usd('-200000'),
      netNotionalDelta: usd('-1500000'),
    });
    expect(r.allowed).toBe(true);
  });
});

describe('eligible contract participant', () => {
  it('qualifies a commodity pool at $5m and a plain fund only at $10m', () => {
    expect(eligibleContractParticipant(usd('6000000'), true).qualifies).toBe(true);
    expect(eligibleContractParticipant(usd('6000000'), false).qualifies).toBe(false);
    expect(eligibleContractParticipant(usd('10000000.01'), false).qualifies).toBe(true);
  });

  it('does not qualify at exactly the threshold — the rule says "exceeding"', () => {
    expect(eligibleContractParticipant(usd('5000000'), true).qualifies).toBe(false);
  });

  it('says what a failure means, in the words the desk needs', () => {
    expect(eligibleContractParticipant(usd('2000000'), true).reason).toMatch(/RFED/);
  });
});
