import { Fixed } from '../src/domain/fixed';
import { Restriction, messageFor, isPermitted } from '../src/eligibility/codes';
import {
  Holder, InvestorTier, SleeveId, SLEEVE_506C_3C1, SLEEVE_506C_3C7, SLEEVE_REG_S,
  tierSatisfies, addressableNote,
} from '../src/eligibility/holder';
import {
  detectTransferRestriction, detectIssuanceRestriction, holderCapHeadroom,
  expiringAttestations, unlockedBalance, TransferContext,
} from '../src/eligibility/rules';

const d = (iso: string) => new Date(`${iso}Z`);
const ASOF = d('2026-09-10T12:00:00');
const units = (n: string) => Fixed.parse(n, 18);

const holder = (over: Partial<Holder> = {}): Holder => ({
  id: 'H1',
  wallet: '0xaaa',
  sleeve: SleeveId.RegD506c,
  usPerson: true,
  attestation: {
    issuer: 'Coinbase Verifications',
    tier: InvestorTier.QualifiedPurchaser,
    issuedAt: d('2026-08-20T00:00:00'),
    expiresAt: d('2027-08-20T00:00:00'),
  },
  sanctions: { screenedAt: d('2026-08-01T00:00:00'), clear: true, provider: 'Chainalysis' },
  balance: units('100000'),
  lockedUnits: Fixed.zero(18),
  frozen: false,
  firstAcquiredAt: d('2026-01-01T00:00:00'),
  ...over,
});

const ctx = (over: Partial<TransferContext> = {}): TransferContext => ({
  asOf: ASOF,
  sleeve: SLEEVE_506C_3C7,
  registry: { paused: false, holdersOfRecord: 40 },
  ...over,
});

describe('restriction codes', () => {
  it('reserves zero for success and gives every other code a message', () => {
    expect(isPermitted(Restriction.Success)).toBe(true);
    for (const v of Object.values(Restriction)) {
      if (typeof v === 'number') expect(messageFor(v).length).toBeGreaterThan(10);
    }
  });
});

describe('the 40 Act gate, which the research documents do not carry', () => {
  it('requires a qualified purchaser under 3(c)(7), not merely an accredited investor', () => {
    const accreditedOnly = holder({
      id: 'H2', wallet: '0xbbb', balance: units('0'),
      attestation: { issuer: 'CV', tier: InvestorTier.Accredited,
        issuedAt: d('2026-08-20T00:00:00'), expiresAt: d('2027-08-20T00:00:00') },
    });
    expect(detectIssuanceRestriction(accreditedOnly, units('50000'), ctx()))
      .toBe(Restriction.RecipientTierInsufficient);
    expect(detectIssuanceRestriction(holder({ balance: units('0') }), units('50000'), ctx()))
      .toBe(Restriction.Success);
  });

  it('accepts a merely accredited investor under 3(c)(1) but caps the sleeve at 100', () => {
    const accredited = holder({
      balance: units('0'),
      attestation: { issuer: 'CV', tier: InvestorTier.Accredited,
        issuedAt: d('2026-08-20T00:00:00'), expiresAt: d('2027-08-20T00:00:00') },
    });
    const c = ctx({ sleeve: SLEEVE_506C_3C1, registry: { paused: false, holdersOfRecord: 99 } });
    expect(detectIssuanceRestriction(accredited, units('50000'), c)).toBe(Restriction.Success);
    const full = ctx({ sleeve: SLEEVE_506C_3C1, registry: { paused: false, holdersOfRecord: 100 } });
    expect(detectIssuanceRestriction(accredited, units('50000'), full))
      .toBe(Restriction.HolderCapReached);
  });

  it('reports cap headroom so slot 101 is a decision, not a surprise', () => {
    expect(holderCapHeadroom(ctx({ sleeve: SLEEVE_506C_3C1 }))).toBe(60);
    expect(holderCapHeadroom(ctx({ sleeve: SLEEVE_506C_3C7 }))).toBe(1959);
    expect(holderCapHeadroom(ctx({ sleeve: SLEEVE_REG_S }))).toBeNull();
  });

  it('states what each exclusion costs in addressable market', () => {
    expect(addressableNote(SLEEVE_506C_3C1)).toMatch(/100 holders/);
    expect(addressableNote(SLEEVE_506C_3C7)).toMatch(/\$5m in investments/);
  });

  it('orders the tiers so a qualified purchaser satisfies an accredited gate', () => {
    expect(tierSatisfies(InvestorTier.QualifiedPurchaser, InvestorTier.Accredited)).toBe(true);
    expect(tierSatisfies(InvestorTier.Accredited, InvestorTier.QualifiedPurchaser)).toBe(false);
  });
});

describe('the Reg S sleeve', () => {
  const regS = ctx({ sleeve: SLEEVE_REG_S });

  it('refuses a US person, which is the sleeve entire basis', () => {
    const us = holder({ sleeve: SleeveId.RegS, usPerson: true, balance: units('0') });
    expect(detectIssuanceRestriction(us, units('50000'), regS)).toBe(Restriction.UsPersonInRegS);
  });

  it('admits a non-US person with no accreditation attestation at all', () => {
    const nonUs = holder({ sleeve: SleeveId.RegS, usPerson: false, balance: units('0') });
    const { attestation, ...rest } = nonUs;
    expect(detectIssuanceRestriction(rest as Holder, units('50000'), regS)).toBe(Restriction.Success);
  });

  it('holds units inside the 40-day distribution compliance period', () => {
    const fresh = holder({ sleeve: SleeveId.RegS, usPerson: false,
      firstAcquiredAt: d('2026-09-01T00:00:00') });
    const to = holder({ id: 'H2', wallet: '0xbbb', sleeve: SleeveId.RegS, usPerson: false,
      balance: units('50000') });
    expect(detectTransferRestriction(fresh, to, units('1000'), regS))
      .toBe(Restriction.DistributionCompliancePeriod);
    const seasoned = holder({ sleeve: SleeveId.RegS, usPerson: false,
      firstAcquiredAt: d('2026-07-01T00:00:00') });
    expect(detectTransferRestriction(seasoned, to, units('1000'), regS)).toBe(Restriction.Success);
  });
});

describe('secondary transfer', () => {
  const from = holder();
  const to = holder({ id: 'H2', wallet: '0xbbb', balance: units('50000') });

  it('permits an ordinary transfer between two good holders', () => {
    expect(detectTransferRestriction(from, to, units('1000'), ctx())).toBe(Restriction.Success);
  });

  it('blocks transfers between the two sleeves', () => {
    const regSHolder = holder({ id: 'H3', wallet: '0xccc', sleeve: SleeveId.RegS,
      usPerson: false, balance: units('50000') });
    expect(detectTransferRestriction(from, regSHolder, units('1000'), ctx()))
      .toBe(Restriction.CrossSleeve);
  });

  it('expires a 506(c) attestation at 90 days even when its certificate says a year', () => {
    const stale = holder({ id: 'H2', wallet: '0xbbb', balance: units('50000'),
      attestation: { issuer: 'CV', tier: InvestorTier.QualifiedPurchaser,
        issuedAt: d('2026-05-01T00:00:00'), expiresAt: d('2027-05-01T00:00:00') } });
    expect(detectTransferRestriction(from, stale, units('1000'), ctx()))
      .toBe(Restriction.AttestationExpired);
  });

  it('expires a sanctions screen on its own clock', () => {
    const old = holder({ id: 'H2', wallet: '0xbbb', balance: units('50000'),
      sanctions: { screenedAt: d('2025-01-01T00:00:00'), clear: true, provider: 'X' } });
    expect(detectTransferRestriction(from, old, units('1000'), ctx()))
      .toBe(Restriction.RecipientSanctionsStale);
  });

  it('reports identity before eligibility', () => {
    expect(detectTransferRestriction(undefined, to, units('1'), ctx())).toBe(Restriction.SenderUnknown);
    expect(detectTransferRestriction(from, undefined, units('1'), ctx())).toBe(Restriction.RecipientUnknown);
    expect(detectTransferRestriction(holder({ frozen: true }), to, units('1'), ctx()))
      .toBe(Restriction.SenderFrozen);
  });

  it('distinguishes a lock-up from an empty account', () => {
    const locked = holder({ lockedUnits: units('99000'), lockedUntil: d('2027-01-01T00:00:00') });
    expect(unlockedBalance(locked, ASOF).toString()).toBe(units('1000').toString());
    expect(detectTransferRestriction(locked, to, units('5000'), ctx())).toBe(Restriction.SenderLocked);
    expect(detectTransferRestriction(holder({ balance: units('10') }), to, units('5000'), ctx()))
      .toBe(Restriction.InsufficientBalance);
  });

  it('releases a lock-up once its date passes', () => {
    const released = holder({ lockedUnits: units('99000'), lockedUntil: d('2026-09-01T00:00:00') });
    expect(detectTransferRestriction(released, to, units('5000'), ctx())).toBe(Restriction.Success);
  });

  it('refuses to leave either side holding dust', () => {
    // Minimum holding is 1,000 units.
    expect(detectTransferRestriction(from, to, units('99500'), ctx()))
      .toBe(Restriction.BelowMinimumHolding);
    const newHolder = holder({ id: 'H4', wallet: '0xddd', balance: units('0') });
    expect(detectTransferRestriction(from, newHolder, units('10'), ctx()))
      .toBe(Restriction.BelowMinimumHolding);
  });

  it('permits a full exit, which is not dust', () => {
    expect(detectTransferRestriction(from, to, units('100000'), ctx())).toBe(Restriction.Success);
  });

  it('stops everything when the transfer agent pauses', () => {
    const paused = ctx({ registry: { paused: true, holdersOfRecord: 40 } });
    expect(detectTransferRestriction(from, to, units('1000'), paused)).toBe(Restriction.TransfersPaused);
    expect(detectIssuanceRestriction(to, units('1000'), paused)).toBe(Restriction.TransfersPaused);
  });
});

describe('attestation surveillance', () => {
  it('finds the ones about to lapse on the validity window, not the certificate date', () => {
    const holders = [
      holder({ id: 'A', attestation: { issuer: 'CV', tier: InvestorTier.QualifiedPurchaser,
        issuedAt: d('2026-06-25T00:00:00'), expiresAt: d('2027-06-25T00:00:00') } }), // 77 days
      holder({ id: 'B', attestation: { issuer: 'CV', tier: InvestorTier.QualifiedPurchaser,
        issuedAt: d('2026-09-01T00:00:00'), expiresAt: d('2027-09-01T00:00:00') } }), // 9 days
    ];
    const expiring = expiringAttestations(holders, ctx(), 30);
    expect(expiring.map((h) => h.id)).toEqual(['A']);
  });
});
