/**
 * What the market data means for the product, computed rather than asserted.
 *
 * One function, three comparisons, and the three of them are the whole
 * commercial case:
 *
 *   against a dollar bill fund  — was the pitch, is now negative
 *   against BILS                — was a side argument, is now the only argument
 *   against Israeli cash        — the honest domestic benchmark
 */

import { Fixed, Rounding } from '../domain/fixed';
import { MarketSnapshot } from './snapshot';

const BP = Fixed.parse('10000', 0);
const bp = (f: Fixed): Fixed => f.mul(BP).rescale(1, Rounding.HalfEven);

export interface DragAssumptions {
  readonly managementFee: Fixed;
  readonly basisCost: Fixed;
  readonly executionCost: Fixed;
  readonly operatingCost: Fixed;
}

export interface CarryReport {
  readonly asOf: string;
  readonly ilsPolicyRate: Fixed;
  readonly usdBill3m: Fixed;
  /** ILS minus USD. Negative means the shekel leg pays less than the dollar leg. */
  readonly rateDifferential: Fixed;
  readonly totalDrag: Fixed;
  readonly netToHolderIls: Fixed;

  /** Net shekel yield minus the dollar bill yield. The old headline. */
  readonly vsDollarBillFund: Fixed;
  /** Net shekel yield minus zero. The BILS gap, which is the product. */
  readonly vsBils: Fixed;

  readonly forwardDirection: 'SHEKEL_AT_FORWARD_DISCOUNT' | 'SHEKEL_AT_FORWARD_PREMIUM';
  readonly bpTable: Readonly<Record<string, string>>;
  readonly verdict: string;
}

export function carryReport(s: MarketSnapshot, d: DragAssumptions): CarryReport {
  const ils = s.ilsPolicyRate.value;
  const usd = s.usdBill3m.value;
  const rateDifferential = ils.sub(usd);
  const totalDrag = d.managementFee.add(d.basisCost).add(d.executionCost).add(d.operatingCost);
  const netToHolderIls = ils.sub(totalDrag);
  const vsDollarBillFund = netToHolderIls.sub(usd);

  // r_ILS < r_USD makes the forward rate (ILS per USD) lower than spot: fewer
  // shekels per dollar forward, which is the shekel trading at a premium.
  const forwardDirection = rateDifferential.isNegative()
    ? 'SHEKEL_AT_FORWARD_PREMIUM' as const
    : 'SHEKEL_AT_FORWARD_DISCOUNT' as const;

  const verdict = vsDollarBillFund.isNegative()
    ? `The shekel leg pays ${bp(vsDollarBillFund.neg())}bp less than a dollar bill fund after ` +
      `drag. Sell shekel denomination and the BILS gap of ${bp(netToHolderIls)}bp. Do not sell yield.`
    : `The shekel leg pays ${bp(vsDollarBillFund)}bp more than a dollar bill fund after drag.`;

  return {
    asOf: s.asOf,
    ilsPolicyRate: ils,
    usdBill3m: usd,
    rateDifferential,
    totalDrag,
    netToHolderIls,
    vsDollarBillFund,
    vsBils: netToHolderIls,
    forwardDirection,
    bpTable: {
      'Bank of Israel policy rate': `${bp(ils)}bp`,
      'US 3-month bill': `${bp(usd)}bp`,
      'rate differential (ILS - USD)': `${bp(rateDifferential)}bp`,
      'total drag': `${bp(totalDrag)}bp`,
      'net to holder, in shekels': `${bp(netToHolderIls)}bp`,
      'versus a dollar bill fund': `${bp(vsDollarBillFund)}bp`,
      'versus BILS (pays zero by licence)': `${bp(netToHolderIls)}bp`,
    },
    verdict,
  };
}

/**
 * Break-even: how far the shekel may weaken over the holding period before a
 * dollar-based holder is worse off than they would have been in dollar bills.
 *
 * This is the number the term sheet owes a US buyer, and at today's levels it is
 * *negative* — the shekel has to APPRECIATE for the trade to work against
 * dollars, on top of a currency already up 20% in a year.
 */
export function shekelBreakevenMove(r: CarryReport, holdingYears: Fixed): Fixed {
  return r.vsDollarBillFund.mul(holdingYears).rescale(8, Rounding.HalfEven);
}
