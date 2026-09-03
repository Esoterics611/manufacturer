import { Fixed } from '../src/domain/fixed';
import { Restriction } from '../src/eligibility/codes';
import { Holder, InvestorTier, SleeveId, SLEEVE_506C_3C1, SLEEVE_506C_3C7 }
  from '../src/eligibility/holder';
import { MemoryRegister } from '../src/register/memory-register';
import { reconcile, ChainState, effectiveEligibilityExpiry } from '../src/register/reconcile';

const d = (iso: string) => new Date(`${iso}Z`);
const ASOF = d('2026-09-10T12:00:00');
const units = (n: string) => Fixed.parse(n, 18);

const holder = (id: string, wallet: string, over: Partial<Holder> = {}): Holder => ({
  id, wallet,
  sleeve: SleeveId.RegD506c,
  usPerson: true,
  attestation: { issuer: 'CV', tier: InvestorTier.QualifiedPurchaser,
    issuedAt: d('2026-08-20T00:00:00'), expiresAt: d('2027-08-20T00:00:00') },
  sanctions: { screenedAt: d('2026-08-01T00:00:00'), clear: true, provider: 'Chainalysis' },
  balance: Fixed.zero(18),
  lockedUnits: Fixed.zero(18),
  frozen: false,
  firstAcquiredAt: d('2026-01-01T00:00:00'),
  ...over,
});

function make(sleeve = SLEEVE_506C_3C7): MemoryRegister {
  const r = new MemoryRegister(sleeve);
  r.setClock(() => ASOF);
  r.upsertHolder(holder('H1', '0xaaa'));
  r.upsertHolder(holder('H2', '0xbbb'));
  return r;
}

describe('issuance and cancellation', () => {
  it('issues against a subscription and records the holder', async () => {
    const r = make();
    const res = await r.issue('sub-1', 'H1', units('1000000'));
    expect(res.applied).toBe(true);
    expect((await r.getHolder('H1'))!.balance.toString()).toBe(units('1000000').toString());
    expect(await r.holdersOfRecord(SleeveId.RegD506c)).toBe(1);
  });

  it('is idempotent on the reference, because the network delivers twice', async () => {
    const r = make();
    await r.issue('sub-1', 'H1', units('1000000'));
    const replay = await r.issue('sub-1', 'H1', units('1000000'));
    expect(replay.replayed).toBe(true);
    expect((await r.getHolder('H1'))!.balance.toString()).toBe(units('1000000').toString());
  });

  it('cancels on redemption and permits a full exit but never dust', async () => {
    const r = make();
    await r.issue('sub-1', 'H1', units('1000000'));
    expect((await r.cancel('red-1', 'H1', units('999500'))).restriction)
      .toBe(Restriction.BelowMinimumHolding);
    expect((await r.cancel('red-2', 'H1', units('1000000'))).applied).toBe(true);
    expect(await r.holdersOfRecord(SleeveId.RegD506c)).toBe(0);
  });

  it('refuses to cancel more than the holder has', async () => {
    const r = make();
    await r.issue('sub-1', 'H1', units('1000'));
    expect((await r.cancel('red-1', 'H1', units('5000'))).restriction)
      .toBe(Restriction.InsufficientBalance);
  });

  it('enforces the 3(c)(1) cap at the point of issuance', async () => {
    const r = new MemoryRegister(SLEEVE_506C_3C1);
    r.setClock(() => ASOF);
    for (let n = 0; n < 100; n++) {
      const h = holder(`H${n}`, `0x${n.toString(16)}`, { balance: units('1000') });
      r.upsertHolder(h);
    }
    r.upsertHolder(holder('HNEW', '0xnew'));
    expect((await r.issue('sub-x', 'HNEW', units('1000000'))).restriction)
      .toBe(Restriction.HolderCapReached);
  });
});

describe('transfers', () => {
  it('moves units between eligible holders', async () => {
    const r = make();
    await r.issue('sub-1', 'H1', units('1000000'));
    await r.issue('sub-2', 'H2', units('1000000'));
    expect((await r.transfer('t-1', 'H1', 'H2', units('250000'))).applied).toBe(true);
    expect((await r.getHolder('H1'))!.balance.toString()).toBe(units('750000').toString());
    expect((await r.getHolder('H2'))!.balance.toString()).toBe(units('1250000').toString());
  });

  it('refuses a transfer the eligibility rules refuse, and moves nothing', async () => {
    const r = make();
    await r.issue('sub-1', 'H1', units('1000000'));
    await r.setFrozen('f-1', 'H2', true);
    const res = await r.transfer('t-1', 'H1', 'H2', units('1000'));
    expect(res.restriction).toBe(Restriction.RecipientFrozen);
    expect((await r.getHolder('H1'))!.balance.toString()).toBe(units('1000000').toString());
  });

  it('honours a lock-up set by the transfer agent', async () => {
    const r = make();
    await r.issue('sub-1', 'H1', units('1000000'));
    await r.issue('sub-2', 'H2', units('1000000'));
    await r.setLockup('l-1', 'H1', units('900000'), d('2027-01-01T00:00:00'));
    expect((await r.transfer('t-1', 'H1', 'H2', units('500000'))).restriction)
      .toBe(Restriction.SenderLocked);
    expect((await r.transfer('t-2', 'H1', 'H2', units('50000'))).applied).toBe(true);
  });
});

describe('the three powers that make it a register', () => {
  it('forces a transfer past a freeze and a lock-up, and records why', async () => {
    const r = make();
    await r.issue('sub-1', 'H1', units('1000000'));
    await r.issue('sub-2', 'H2', units('1000000'));
    await r.setFrozen('f-1', 'H1', true);
    await r.setLockup('l-1', 'H1', units('1000000'), d('2027-01-01T00:00:00'));

    const res = await r.forceTransfer('force-1', 'H1', 'H2', units('1000000'), {
      kind: 'LOST_KEY', reference: 'TA-2026-0042', authorisedBy: 'transfer agent',
    });
    expect(res.applied).toBe(true);
    expect((await r.getHolder('H2'))!.balance.toString()).toBe(units('2000000').toString());
    expect(r.forcedTransfers()).toHaveLength(1);
    expect(r.forcedTransfers()[0]!.reason.kind).toBe('LOST_KEY');
  });

  it('will not force units to an ineligible recipient — a court cannot make one eligible', async () => {
    const r = make();
    await r.issue('sub-1', 'H1', units('1000000'));
    r.upsertHolder(holder('H3', '0xccc', {
      attestation: { issuer: 'CV', tier: InvestorTier.Accredited,
        issuedAt: d('2026-08-20T00:00:00'), expiresAt: d('2027-08-20T00:00:00') },
    }));
    const res = await r.forceTransfer('force-1', 'H1', 'H3', units('1000000'), {
      kind: 'COURT_ORDER', reference: 'CV-2026-1', authorisedBy: 'court',
    });
    expect(res.restriction).toBe(Restriction.RecipientTierInsufficient);
    expect(r.forcedTransfers()).toHaveLength(0);
  });

  it('pauses every transfer at once', async () => {
    const r = make();
    await r.issue('sub-1', 'H1', units('1000000'));
    r.setPaused(true);
    expect((await r.transfer('t-1', 'H1', 'H2', units('1000'))).restriction)
      .toBe(Restriction.TransfersPaused);
  });
});

describe('reconciliation against the chain', () => {
  async function setup() {
    const r = make();
    await r.issue('sub-1', 'H1', units('1000000'));
    await r.issue('sub-2', 'H2', units('500000'));
    const snap = await r.snapshot(SleeveId.RegD506c, ASOF);
    const holders = await r.listHolders(SleeveId.RegD506c);
    return { r, snap, holders };
  }

  const chainOf = (snap: Awaited<ReturnType<MemoryRegister['snapshot']>>,
                   allowUntil = d('2026-10-01T00:00:00')): ChainState => ({
    asOf: ASOF,
    balances: new Map(snap.balances),
    totalSupply: snap.totalUnits,
    allowlist: new Map([...snap.balances.keys()].map((w) => [w, allowUntil])),
  });

  it('is clean when the copy matches', async () => {
    const { snap, holders } = await setup();
    const rec = reconcile(snap, chainOf(snap), holders, SLEEVE_506C_3C7, ASOF);
    expect(rec.clean).toBe(true);
  });

  it('catches a balance break', async () => {
    const { snap, holders } = await setup();
    const chain = chainOf(snap);
    (chain.balances as Map<string, Fixed>).set('0xaaa', units('999999'));
    const rec = reconcile(snap, chain, holders, SLEEVE_506C_3C7, ASOF);
    expect(rec.breaks.map((b) => b.kind)).toContain('BALANCE_MISMATCH');
  });

  it('catches a wallet that holds on chain and is not on the register', async () => {
    const { snap, holders } = await setup();
    const chain = chainOf(snap);
    (chain.balances as Map<string, Fixed>).set('0xrogue', units('1'));
    const rec = reconcile(snap, chain, holders, SLEEVE_506C_3C7, ASOF);
    expect(rec.breaks.find((b) => b.kind === 'ON_CHAIN_ONLY')?.wallet).toBe('0xrogue');
  });

  it('catches eligibility drift on the validity window, which is the one that happens', async () => {
    const { r, snap } = await setup();
    // Attestation issued 95 days ago: dead at 90 even though the certificate runs a year.
    r.upsertHolder(holder('H1', '0xaaa', {
      balance: units('1000000'),
      attestation: { issuer: 'CV', tier: InvestorTier.QualifiedPurchaser,
        issuedAt: new Date(ASOF.getTime() - 95 * 86_400_000),
        expiresAt: d('2027-06-01T00:00:00') },
    }));
    const holders = await r.listHolders(SleeveId.RegD506c);
    const rec = reconcile(snap, chainOf(snap), holders, SLEEVE_506C_3C7, ASOF);
    const drift = rec.breaks.find((b) => b.kind === 'ELIGIBILITY_DRIFT');
    expect(drift).toBeDefined();
    expect(drift!.detail).toMatch(/ALREADY LAPSED/);
  });

  it('takes the earlier of the certificate date and the validity window', () => {
    const long = holder('X', '0x1', { attestation: { issuer: 'CV',
      tier: InvestorTier.QualifiedPurchaser, issuedAt: d('2026-09-01T00:00:00'),
      expiresAt: d('2027-09-01T00:00:00') } });
    expect(effectiveEligibilityExpiry(long, SLEEVE_506C_3C7)!.toISOString().slice(0, 10))
      .toBe('2026-11-30');
    const short = holder('Y', '0x2', { attestation: { issuer: 'CV',
      tier: InvestorTier.QualifiedPurchaser, issuedAt: d('2026-09-01T00:00:00'),
      expiresAt: d('2026-09-20T00:00:00') } });
    expect(effectiveEligibilityExpiry(short, SLEEVE_506C_3C7)!.toISOString().slice(0, 10))
      .toBe('2026-09-20');
  });

  it('catches a supply mismatch', async () => {
    const { snap, holders } = await setup();
    const chain = { ...chainOf(snap), totalSupply: units('9999') };
    const rec = reconcile(snap, chain, holders, SLEEVE_506C_3C7, ASOF);
    expect(rec.breaks.map((b) => b.kind)).toContain('SUPPLY_MISMATCH');
  });
});
