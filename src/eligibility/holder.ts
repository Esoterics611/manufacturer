/**
 * Who may hold the token, and under which statute.
 *
 * ---------------------------------------------------------------------------
 * A row that is missing from `research/PLAN.md` and `research/SIMPLE-VERSION.md`.
 *
 * Both documents frame the US gate as a Securities Act question: Reg S, Rule
 * 506(c) at $200k income / $1m net worth, or Reg A+. That is the '33 Act, and it
 * governs how the interests are *offered*.
 *
 * A pooled vehicle whose assets are US Treasury bills is also an investment
 * company under Investment Company Act section 3(a)(1)(A), because bills are
 * securities and the vehicle is in the business of investing in them. It
 * therefore needs a '40 Act exclusion as well, and the exclusions are much
 * tighter than accreditation:
 *
 *   3(c)(1) — no more than 100 beneficial owners. Any accredited investor.
 *   3(c)(7) — unlimited owners, but every one a QUALIFIED PURCHASER:
 *             $5m in investments for a natural person, $25m for most entities.
 *   register as an investment company — the ETF path. `PLAN.md` §4 has already
 *             ruled this out ("IRC 852(b)(6) needs a RIC; we are not one").
 *
 * So the real US gate is either **100 holders** or **$5m in investments each**,
 * not $200k of income. That is a materially smaller addressable set than
 * `SIMPLE-VERSION.md` §5's corridor-upsell thesis assumes, and it sharpens its
 * own risk 3 ("the corridor's customer is mostly not accredited") into
 * something closer to "the corridor's customer is almost certainly not a
 * qualified purchaser".
 *
 * The offshore Reg S sleeve has a different analysis — section 7(d) reaches a
 * foreign investment company making a US public offering, which a Reg S sleeve
 * sold only to non-US persons offshore is not — and that is a further reason for
 * `PLAN.md` §14's two-sleeve structure with separate registers.
 *
 * [VERIFY — this belongs in the same memo as the CPO question, and it may be the
 * more expensive of the two. It is stated here as a question with both answers
 * modelled, not as advice. Nothing in this file is legal advice.]
 * ---------------------------------------------------------------------------
 */

import { Fixed } from '../domain/fixed';

export enum SleeveId {
  /** US persons, Rule 506(c), on-chain accreditation attestation. */
  RegD506c = 'REG_D_506C',
  /** Non-US persons, Regulation S, offshore. */
  RegS = 'REG_S',
}

/** The '40 Act exclusion the sleeve relies on. Drives the holder cap and the tier. */
export enum IcaExclusion {
  ThreeCOne = '3(c)(1)',
  ThreeCSeven = '3(c)(7)',
  /** Offshore sleeve sold only to non-US persons. */
  Offshore7d = 'OFFSHORE_7D',
}

/** Investor qualification, ordered. Higher ordinal satisfies lower. */
export enum InvestorTier {
  None = 0,
  /** Rule 501(a): $200k income or $1m net worth. */
  Accredited = 1,
  /** ICA 2(a)(51): $5m in investments for a natural person. */
  QualifiedPurchaser = 2,
}

export function tierSatisfies(held: InvestorTier, required: InvestorTier): boolean {
  return held >= required;
}

export interface Attestation {
  /** Who verified. For 506(c) this is the Coinbase Verifications issuer or a BD/IA/CPA/attorney. */
  readonly issuer: string;
  readonly tier: InvestorTier;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
}

export interface SanctionsScreen {
  readonly screenedAt: Date;
  readonly clear: boolean;
  readonly provider: string;
}

export interface Holder {
  readonly id: string;
  /** Base address. One wallet per holder per sleeve; the register is the record. */
  readonly wallet: string;
  readonly sleeve: SleeveId;
  readonly usPerson: boolean;
  readonly attestation?: Attestation;
  readonly sanctions: SanctionsScreen;
  /** Units held, 18dp. The register's number, which the chain must match. */
  readonly balance: Fixed;
  /** Units within a lock-up and not transferable until `lockedUntil`. */
  readonly lockedUnits: Fixed;
  readonly lockedUntil?: Date;
  /** Set by the transfer agent: a court order, a dispute, a lost-key recovery. */
  readonly frozen: boolean;
  /** When this holder first acquired units. Starts the Reg S compliance period. */
  readonly firstAcquiredAt: Date;
}

export interface SleeveConfig {
  readonly id: SleeveId;
  readonly exclusion: IcaExclusion;
  /**
   * Beneficial-owner cap. 100 under 3(c)(1). Under 3(c)(7) the '40 Act imposes
   * none, but Exchange Act 12(g) forces registration at 2,000 holders of record
   * once assets exceed $10m, so the practical cap is 1,999.
   */
  readonly maxHolders: number | null;
  readonly requiredTier: InvestorTier;
  /**
   * Regulation S distribution compliance period, in days. Forty days for debt of
   * a reporting issuer; one year for equity of a domestic issuer. A Delaware
   * statutory trust unit is not obviously either. [VERIFY]
   */
  readonly distributionComplianceDays: number;
  /** Days an accreditation attestation stays good before re-verification. */
  readonly attestationValidityDays: number;
  /** Days a sanctions screen stays good. */
  readonly sanctionsValidityDays: number;
  /** Smallest position the register will carry. Dust holders inflate the 12(g) count. */
  readonly minimumHolding: Fixed;
}

/** The 3(c)(1) shape: any accredited investor, hard-capped at 100 owners. */
export const SLEEVE_506C_3C1: SleeveConfig = {
  id: SleeveId.RegD506c,
  exclusion: IcaExclusion.ThreeCOne,
  maxHolders: 100,
  requiredTier: InvestorTier.Accredited,
  distributionComplianceDays: 0,
  attestationValidityDays: 90,
  sanctionsValidityDays: 365,
  minimumHolding: Fixed.parse('1000', 18),
};

/** The 3(c)(7) shape: unlimited owners to 12(g), but every one a qualified purchaser. */
export const SLEEVE_506C_3C7: SleeveConfig = {
  id: SleeveId.RegD506c,
  exclusion: IcaExclusion.ThreeCSeven,
  maxHolders: 1999,
  requiredTier: InvestorTier.QualifiedPurchaser,
  distributionComplianceDays: 0,
  attestationValidityDays: 90,
  sanctionsValidityDays: 365,
  minimumHolding: Fixed.parse('1000', 18),
};

/** The offshore sleeve. Non-US persons only; the compliance period is the live constraint. */
export const SLEEVE_REG_S: SleeveConfig = {
  id: SleeveId.RegS,
  exclusion: IcaExclusion.Offshore7d,
  maxHolders: null,
  requiredTier: InvestorTier.None,
  distributionComplianceDays: 40,
  attestationValidityDays: 365,
  sanctionsValidityDays: 365,
  minimumHolding: Fixed.parse('1000', 18),
};

/**
 * What each exclusion costs in addressable market, stated so the choice is made
 * on the number rather than on which memo arrived first.
 */
export function addressableNote(c: SleeveConfig): string {
  switch (c.exclusion) {
    case IcaExclusion.ThreeCOne:
      return `at most ${c.maxHolders} holders ever; at a $1m creation unit that caps the sleeve ` +
        `near $100m and every new holder is a decision`;
    case IcaExclusion.ThreeCSeven:
      return `no holder cap until 12(g) at ${c.maxHolders}, but every holder needs $5m in ` +
        `investments — a far smaller set than accredited`;
    case IcaExclusion.Offshore7d:
      return 'non-US persons offshore; the binding questions are local, not federal';
  }
}
