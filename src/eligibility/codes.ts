/**
 * Transfer restriction codes, ERC-1404 shape.
 *
 * ERC-1404 is the recognised standard for a restricted security token: the
 * contract exposes `detectTransferRestriction(from, to, value) -> uint8` and
 * `messageForTransferRestriction(uint8) -> string`, so a wallet or a venue can
 * ask why a transfer will fail *before* sending it and show the holder a reason
 * rather than a revert.
 *
 * Zero is success. Every other code is a rule someone can be pointed at.
 *
 * The ordering below is the order the rules are evaluated in, and it is
 * deliberate: identity before eligibility, eligibility before seasoning,
 * seasoning before arithmetic. A holder who is both unknown and over a cap
 * should be told they are unknown.
 */

export enum Restriction {
  Success = 0,
  TransfersPaused = 1,
  SenderUnknown = 2,
  RecipientUnknown = 3,
  SenderFrozen = 4,
  RecipientFrozen = 5,
  RecipientSanctionsStale = 6,
  CrossSleeve = 7,
  UsPersonInRegS = 8,
  RecipientTierInsufficient = 9,
  AttestationExpired = 10,
  DistributionCompliancePeriod = 11,
  SenderLocked = 12,
  HolderCapReached = 13,
  BelowMinimumHolding = 14,
  InsufficientBalance = 15,
}

/**
 * The strings a holder actually sees. Written to be read by someone who has just
 * had a transfer rejected and wants to know what to do about it.
 */
export const RESTRICTION_MESSAGES: Readonly<Record<Restriction, string>> = {
  [Restriction.Success]: 'Transfer permitted',
  [Restriction.TransfersPaused]: 'Transfers are paused by the transfer agent',
  [Restriction.SenderUnknown]: 'Sender is not on the register',
  [Restriction.RecipientUnknown]: 'Recipient is not on the register: onboard before transferring',
  [Restriction.SenderFrozen]: 'Sender position is frozen',
  [Restriction.RecipientFrozen]: 'Recipient position is frozen',
  [Restriction.RecipientSanctionsStale]: 'Recipient sanctions screening is out of date',
  [Restriction.CrossSleeve]: 'Transfers between the Reg S and Rule 506(c) sleeves are not permitted',
  [Restriction.UsPersonInRegS]: 'A US person may not hold the Regulation S class',
  [Restriction.RecipientTierInsufficient]: 'Recipient does not meet the investor qualification this class requires',
  [Restriction.AttestationExpired]: 'Recipient accreditation attestation has expired: re-verify',
  [Restriction.DistributionCompliancePeriod]: 'Regulation S distribution compliance period has not elapsed',
  [Restriction.SenderLocked]: 'Sender units are within a lock-up',
  [Restriction.HolderCapReached]: 'The class has reached its holder-of-record cap',
  [Restriction.BelowMinimumHolding]: 'Transfer would leave a position below the minimum holding',
  [Restriction.InsufficientBalance]: 'Insufficient unlocked balance',
};

export function messageFor(code: Restriction): string {
  return RESTRICTION_MESSAGES[code] ?? 'Unknown restriction';
}

export function isPermitted(code: Restriction): boolean {
  return code === Restriction.Success;
}
