/**
 * Register against chain.
 *
 * The register is the book of record and the chain is a copy of it. When they
 * disagree the register wins, and the only question is how the copy drifted.
 *
 * The drift that matters is not a balance break — a restricted token makes those
 * rare. It is **eligibility drift**: a holder whose accreditation attestation
 * lapsed on Tuesday but whose on-chain allowlist entry still says yes because
 * nobody sent the revocation transaction. The fix is structural rather than
 * operational: every on-chain entry carries its own `validUntil`, so the chain
 * expires the holder without being told. A system that needs a transaction to
 * become compliant is a system that is non-compliant whenever the relayer is
 * down.
 */

import { Fixed } from '../domain/fixed';
import { Holder, SleeveConfig } from '../eligibility/holder';
import { RegisterSnapshot } from './register';

const DAY_MS = 86_400_000;

/**
 * When the register stops honouring an attestation.
 *
 * Not the attestation's own expiry date — the earlier of that and the sleeve's
 * re-verification window. A 506(c) attestation issued 95 days ago is dead at 90
 * even though its certificate says it runs a year, and that is precisely the
 * case the chain will happily transact through.
 */
export function effectiveEligibilityExpiry(h: Holder, sleeve: SleeveConfig): Date | undefined {
  if (!h.attestation) return undefined;
  const hard = h.attestation.expiresAt;
  const window = new Date(h.attestation.issuedAt.getTime() + sleeve.attestationValidityDays * DAY_MS);
  return hard < window ? hard : window;
}

export type BreakKind =
  | 'BALANCE_MISMATCH'
  | 'ON_CHAIN_ONLY'
  | 'REGISTER_ONLY'
  | 'ELIGIBILITY_DRIFT'
  | 'SUPPLY_MISMATCH';

export interface Break {
  readonly kind: BreakKind;
  readonly wallet: string;
  readonly registerUnits?: Fixed;
  readonly chainUnits?: Fixed;
  readonly detail: string;
}

export interface ChainState {
  readonly asOf: Date;
  readonly balances: ReadonlyMap<string, Fixed>;
  readonly totalSupply: Fixed;
  /** Allowlist entries the contract will honour, with their on-chain expiry. */
  readonly allowlist: ReadonlyMap<string, Date>;
}

export interface Reconciliation {
  readonly asOf: Date;
  readonly clean: boolean;
  readonly breaks: readonly Break[];
  readonly registerTotal: Fixed;
  readonly chainTotal: Fixed;
}

export function reconcile(
  register: RegisterSnapshot,
  chain: ChainState,
  holders: readonly Holder[],
  sleeve: SleeveConfig,
  asOf: Date,
): Reconciliation {
  const breaks: Break[] = [];
  const seen = new Set<string>();

  for (const [wallet, units] of register.balances) {
    seen.add(wallet);
    const onChain = chain.balances.get(wallet) ?? Fixed.zero(18);
    if (!onChain.eq(units)) {
      breaks.push({
        kind: units.isZero() ? 'ON_CHAIN_ONLY' : 'BALANCE_MISMATCH',
        wallet,
        registerUnits: units,
        chainUnits: onChain,
        detail: `register ${units} against chain ${onChain}`,
      });
    }
  }

  for (const [wallet, units] of chain.balances) {
    if (seen.has(wallet) || units.isZero()) continue;
    breaks.push({
      kind: 'ON_CHAIN_ONLY',
      wallet,
      chainUnits: units,
      detail: 'holds units on chain but is not on the register',
    });
  }

  // The one that actually happens.
  for (const h of holders) {
    const wallet = h.wallet.toLowerCase();
    const chainExpiry = chain.allowlist.get(wallet);
    if (!chainExpiry) continue;
    const registerExpiry = effectiveEligibilityExpiry(h, sleeve);
    if (registerExpiry && chainExpiry.getTime() > registerExpiry.getTime()) {
      const lapsed = registerExpiry.getTime() <= asOf.getTime();
      breaks.push({
        kind: 'ELIGIBILITY_DRIFT',
        wallet,
        detail:
          `chain allowlist good to ${chainExpiry.toISOString().slice(0, 10)} but the register ` +
          `stops honouring the attestation ${registerExpiry.toISOString().slice(0, 10)}` +
          (lapsed ? ' — ALREADY LAPSED' : '') +
          ': the chain would permit a transfer the register refuses',
      });
    }
  }

  if (!register.totalUnits.eq(chain.totalSupply)) {
    breaks.push({
      kind: 'SUPPLY_MISMATCH',
      wallet: '-',
      registerUnits: register.totalUnits,
      chainUnits: chain.totalSupply,
      detail: `register total ${register.totalUnits} against supply ${chain.totalSupply}`,
    });
  }

  return {
    asOf,
    clean: breaks.length === 0,
    breaks,
    registerTotal: register.totalUnits,
    chainTotal: chain.totalSupply,
  };
}
