/**
 * The eligibility rules engine.
 *
 * This computes a transfer restriction the way the transfer agent would, in
 * TypeScript where it can be read, argued with and changed. The chain enforces a
 * *snapshot* of the result, not the rules themselves — see `register/reconcile.ts`
 * for the gap between the two and how it is made to fail closed.
 *
 * Two functions, because issuance and secondary transfer are different questions:
 * a subscription has no sender and must test the holder cap, a secondary transfer
 * has a sender and must test seasoning and lock-ups.
 */

import { Fixed } from '../domain/fixed';
import { Restriction } from './codes';
import { Holder, SleeveConfig, tierSatisfies, InvestorTier } from './holder';

const DAY_MS = 86_400_000;

function daysBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / DAY_MS;
}

export interface RegistryState {
  readonly paused: boolean;
  /** Holders of record with a non-zero balance in this sleeve. */
  readonly holdersOfRecord: number;
}

export interface TransferContext {
  readonly asOf: Date;
  readonly sleeve: SleeveConfig;
  readonly registry: RegistryState;
}

// ---------------------------------------------------------------------------

function recipientChecks(to: Holder, ctx: TransferContext): Restriction {
  if (to.frozen) return Restriction.RecipientFrozen;

  if (!to.sanctions.clear) return Restriction.RecipientSanctionsStale;
  if (daysBetween(to.sanctions.screenedAt, ctx.asOf) > ctx.sleeve.sanctionsValidityDays) {
    return Restriction.RecipientSanctionsStale;
  }

  if (to.sleeve !== ctx.sleeve.id) return Restriction.CrossSleeve;

  // The Reg S sleeve's whole basis is that no US person holds it.
  if (ctx.sleeve.requiredTier === InvestorTier.None && to.usPerson) {
    return Restriction.UsPersonInRegS;
  }

  if (ctx.sleeve.requiredTier > InvestorTier.None) {
    const att = to.attestation;
    if (!att || !tierSatisfies(att.tier, ctx.sleeve.requiredTier)) {
      return Restriction.RecipientTierInsufficient;
    }
    if (att.expiresAt.getTime() <= ctx.asOf.getTime()) return Restriction.AttestationExpired;
    if (daysBetween(att.issuedAt, ctx.asOf) > ctx.sleeve.attestationValidityDays) {
      return Restriction.AttestationExpired;
    }
  }

  return Restriction.Success;
}

/** Units the holder can actually move right now. */
export function unlockedBalance(h: Holder, asOf: Date): Fixed {
  const stillLocked = h.lockedUntil && h.lockedUntil.getTime() > asOf.getTime();
  return stillLocked ? h.balance.sub(h.lockedUnits) : h.balance;
}

/**
 * A secondary transfer between two holders.
 *
 * Returns the first blocking rule, evaluated identity-first so a holder who is
 * both unknown and over a cap is told they are unknown.
 */
export function detectTransferRestriction(
  from: Holder | undefined,
  to: Holder | undefined,
  amount: Fixed,
  ctx: TransferContext,
): Restriction {
  if (ctx.registry.paused) return Restriction.TransfersPaused;
  if (!from) return Restriction.SenderUnknown;
  if (!to) return Restriction.RecipientUnknown;
  if (from.frozen) return Restriction.SenderFrozen;

  const recipient = recipientChecks(to, ctx);
  if (recipient !== Restriction.Success) return recipient;

  // Regulation S: the units cannot leave the sleeve's seasoning window early.
  if (ctx.sleeve.distributionComplianceDays > 0) {
    const seasoned = daysBetween(from.firstAcquiredAt, ctx.asOf);
    if (seasoned < ctx.sleeve.distributionComplianceDays) {
      return Restriction.DistributionCompliancePeriod;
    }
  }

  const available = unlockedBalance(from, ctx.asOf);
  if (available.lt(amount)) {
    const locked = from.lockedUntil && from.lockedUntil.getTime() > ctx.asOf.getTime();
    return locked && from.balance.gte(amount)
      ? Restriction.SenderLocked
      : Restriction.InsufficientBalance;
  }

  // A new holder of record consumes a slot in the cap.
  if (to.balance.isZero() && ctx.sleeve.maxHolders !== null) {
    if (ctx.registry.holdersOfRecord >= ctx.sleeve.maxHolders) return Restriction.HolderCapReached;
  }

  // Neither side may be left holding dust: dust holders inflate the 12(g) count
  // and cost more to administer than the position is worth.
  const senderAfter = from.balance.sub(amount);
  if (!senderAfter.isZero() && senderAfter.lt(ctx.sleeve.minimumHolding)) {
    return Restriction.BelowMinimumHolding;
  }
  if (to.balance.add(amount).lt(ctx.sleeve.minimumHolding)) {
    return Restriction.BelowMinimumHolding;
  }

  return Restriction.Success;
}

/**
 * Issuance against a subscription. No sender, so no seasoning and no lock-up —
 * but the holder cap and the minimum both bite here, and this is the only place
 * the cap can be enforced before it is breached.
 */
export function detectIssuanceRestriction(
  to: Holder | undefined,
  amount: Fixed,
  ctx: TransferContext,
): Restriction {
  if (ctx.registry.paused) return Restriction.TransfersPaused;
  if (!to) return Restriction.RecipientUnknown;

  const recipient = recipientChecks(to, ctx);
  if (recipient !== Restriction.Success) return recipient;

  if (to.balance.isZero() && ctx.sleeve.maxHolders !== null) {
    if (ctx.registry.holdersOfRecord >= ctx.sleeve.maxHolders) return Restriction.HolderCapReached;
  }
  if (to.balance.add(amount).lt(ctx.sleeve.minimumHolding)) return Restriction.BelowMinimumHolding;

  return Restriction.Success;
}

/**
 * Headroom in the holder cap. Reported on the dashboard rather than discovered
 * at the moment a subscription is refused — under 3(c)(1) this is a number the
 * desk has to manage deliberately, because slot 101 does not exist at any price.
 */
export function holderCapHeadroom(ctx: TransferContext): number | null {
  if (ctx.sleeve.maxHolders === null) return null;
  return Math.max(ctx.sleeve.maxHolders - ctx.registry.holdersOfRecord, 0);
}

/**
 * Attestations expiring inside `withinDays`. A 90-day 506(c) attestation on a
 * holder who never trades still has to be refreshed, because the moment it lapses
 * the holder cannot receive units — including their own redemption reversal.
 */
export function expiringAttestations(
  holders: readonly Holder[],
  ctx: TransferContext,
  withinDays: number,
): readonly Holder[] {
  const horizon = new Date(ctx.asOf.getTime() + withinDays * DAY_MS);
  return holders.filter((h) => {
    if (!h.attestation) return false;
    const hardExpiry = h.attestation.expiresAt;
    const validityExpiry = new Date(
      h.attestation.issuedAt.getTime() + ctx.sleeve.attestationValidityDays * DAY_MS,
    );
    const effective = hardExpiry < validityExpiry ? hardExpiry : validityExpiry;
    return effective <= horizon;
  });
}
