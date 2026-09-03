/**
 * A realistic desk state at the September 2026 market, used by the admin CLI and
 * the dashboard generator. Positions and holders are illustrative; every market
 * input comes from `market/snapshot.ts` and is dated and cited there.
 */

import { Fixed, Rounding } from '../src/domain/fixed';
import { USD, ILS } from '../src/domain/money';
import { Center, holidaysFrom } from '../src/domain/calendar';
import { DayCount, yearFraction } from '../src/domain/daycount';
import { SEP_2026 } from '../src/market/snapshot';
import { forwardFromBasis } from '../src/pricing/cip';
import { ForwardBook } from '../src/hedge/book';
import { Side } from '../src/hedge/forward';
import { Bill, ValuationPolicy, ladderValue } from '../src/nav/bills';
import { strikeNav, accrueFee } from '../src/nav/nav';
import { DeskInput } from '../src/admin/desk';
import { SLEEVE_506C_3C7, Holder, InvestorTier, SleeveId } from '../src/eligibility/holder';
import { MemoryRegister } from '../src/register/memory-register';
import { reconcile, ChainState, effectiveEligibilityExpiry } from '../src/register/reconcile';

const d = (iso: string) => new Date(`${iso}Z`);
export const AS_OF = d('2026-09-10T16:00:00');   // Thursday, inside the fixing window
export const CALS = [holidaysFrom(Center.NewYork, []), holidaysFrom(Center.TelAviv, [])];

export const DRAG = {
  managementFee: Fixed.parse('0.0045', 6),
  basisCost: Fixed.parse('0.0018', 6),
  executionCost: Fixed.parse('0.0010', 6),
  operatingCost: Fixed.parse('0.0008', 6),
};

const START = d('2026-09-03T00:00:00');
const MATURITY = d('2026-12-03T00:00:00');

export interface DeskOverrides {
  /** Fraction of the facility cap pre-hedged into the FX close. */
  readonly preHedged: string;
  /** Drop the deliberately-lapsed holder, so reconciliation comes back clean. */
  readonly cleanRecon: boolean;
}

export async function buildDeskInput(overrides: Partial<DeskOverrides> = {}): Promise<DeskInput> {
  const spot = SEP_2026.spot;
  const rUsd = SEP_2026.usdBill3m.value;
  const rIls = SEP_2026.ilsPolicyRate.value;
  const yfUsd = yearFraction(START, MATURITY, DayCount.Act360);
  const yfIls = yearFraction(START, MATURITY, DayCount.Act365F);

  const traded = forwardFromBasis(
    { spot, baseRate: rUsd, quoteRate: rIls, baseYf: yfUsd, quoteYf: yfIls },
    Fixed.parse('-28', 4),
  );

  const bills: Bill[] = [
    { cusip: 'BILL-OCT26', face: Fixed.parse('4000000.00', 2), purchaseDate: START,
      maturityDate: d('2026-10-15T00:00:00'), purchasePrice: Fixed.parse('0.9956', 10),
      policy: ValuationPolicy.AmortisedCost },
    { cusip: 'BILL-NOV26', face: Fixed.parse('3000000.00', 2), purchaseDate: START,
      maturityDate: d('2026-11-12T00:00:00'), purchasePrice: Fixed.parse('0.9927', 10),
      policy: ValuationPolicy.AmortisedCost },
    { cusip: 'BILL-DEC26', face: Fixed.parse('3200000.00', 2), purchaseDate: START,
      maturityDate: MATURITY, purchasePrice: Fixed.parse('0.9904', 10),
      policy: ValuationPolicy.AmortisedCost },
  ];

  const book = new ForwardBook().with({
    id: 'FWD-DEC26', base: USD, quote: ILS, side: Side.BuyQuote,
    baseNotional: Fixed.parse('10050000.00', 2), contractRate: traded.rate,
    tradeDate: START, valueDate: MATURITY, initialMargin: Fixed.parse('301500.00', 2),
  });

  const priorNet = Fixed.parse('30150000.00', 2);
  const fee = accrueFee(priorNet, DRAG.managementFee, START, AS_OF);
  const nav = strikeNav({
    asOf: AS_OF,
    billsUsd: ladderValue(bills, AS_OF),
    cashUsd: Fixed.parse('140000.00', 2),
    cashIls: Fixed.zero(2),
    forwardMtmIls: Fixed.parse('-52000.00', 2),
    accruedFeeIls: fee,
    otherAccrualsIls: Fixed.parse('11000.00', 2),
    unitsOutstanding: Fixed.parse('30000000', 18),
    strikeSpot: spot,
    lastStrike: d('2026-09-09T00:00:00'),
  }, CALS);

  // --- the register -------------------------------------------------------
  const sleeve = SLEEVE_506C_3C7;
  const register = new MemoryRegister(sleeve);
  register.setClock(() => AS_OF);

  const holders: Holder[] = [];
  for (let n = 1; n <= 41; n++) {
    const wallet = `0x${n.toString(16).padStart(40, '0')}`;
    // Three attestations land inside the 30-day window; one has already lapsed.
    const lapsed = n === 4 && !overrides.cleanRecon;
    const issuedDaysAgo = n <= 3 ? 68 : lapsed ? 95 : 20 + (n % 40);
    const h: Holder = {
      id: `H${String(n).padStart(3, '0')}`,
      wallet,
      sleeve: SleeveId.RegD506c,
      usPerson: true,
      attestation: {
        issuer: 'Coinbase Verifications',
        tier: InvestorTier.QualifiedPurchaser,
        issuedAt: new Date(AS_OF.getTime() - issuedDaysAgo * 86_400_000),
        expiresAt: new Date(AS_OF.getTime() + (365 - issuedDaysAgo) * 86_400_000),
      },
      sanctions: { screenedAt: new Date(AS_OF.getTime() - 30 * 86_400_000), clear: true,
        provider: 'Chainalysis' },
      balance: Fixed.parse(String(600_000 + n * 10_000), 18),
      lockedUnits: Fixed.zero(18),
      frozen: false,
      firstAcquiredAt: new Date(AS_OF.getTime() - (120 + n) * 86_400_000),
    };
    holders.push(h);
    register.upsertHolder(h);
  }

  const snapshot = await register.snapshot(SleeveId.RegD506c, AS_OF);

  // The chain copy. A correctly-operated allowlist mirrors the register's own
  // effective expiry — the earlier of the certificate date and the 90-day
  // re-verification window — so the chain expires a holder without being told.
  //
  // Holder 4 is the mistake this check exists to catch: their entry was written
  // for a full year at onboarding, against a register rule of ninety days. The
  // attestation lapsed five days ago and the chain would still transact.
  const chainBalances = new Map(snapshot.balances);
  const allowlist = new Map<string, Date>();
  for (const h of holders) {
    const correct = effectiveEligibilityExpiry(h, sleeve);
    const written = h.id === 'H004' && !overrides.cleanRecon
      ? new Date(h.attestation!.issuedAt.getTime() + 365 * 86_400_000)
      : correct;
    if (written) allowlist.set(h.wallet.toLowerCase(), written);
  }
  const chain: ChainState = {
    asOf: AS_OF,
    balances: chainBalances,
    totalSupply: snapshot.totalUnits,
    allowlist,
  };

  const liquidationValue = nav.netAssetsIls.div(spot.rate, 2, Rounding.Floor);

  return {
    asOf: AS_OF,
    market: SEP_2026,
    drag: DRAG,
    nav,
    book,
    pool: {
      liquidationValue,
      aggregateInitialMargin: book.initialMargin(),
      aggregateNetNotional: book.netNotional(),
    },
    offering: {
      exemptFromSecuritiesRegistration: true,
      notMarketedAsCommodityVehicle: true,
      allParticipantsEligible: true,
    },
    facilityState: {
      availableUsdc: Fixed.parse('480000.000000', 6),
      netAssetsIls: nav.netAssetsIls,
      preHedgedRatio: Fixed.parse(overrides.preHedged ?? '0.40', 4),
    },
    sleeve,
    holders,
    registry: { paused: false, holdersOfRecord: snapshot.holdersOfRecord },
    reconciliation: reconcile(snapshot, chain, holders, sleeve, AS_OF),
  };
}
