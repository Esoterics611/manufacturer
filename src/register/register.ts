/**
 * The transfer agent register — as an interface we consume, never as one we build.
 *
 * `PLAN.md` is absolute and `SIMPLE-VERSION.md` §5 repeats it: never build a
 * transfer agent. A security needs holder-level eligibility, lock-ups, sanctions,
 * forced transfer and lost-key recovery, and all of that is a regulated function
 * someone else already performs. We rent it — Securitize, Tokensoft, or the
 * venue's own — and this interface is the seam.
 *
 * It is written the way the sibling repos write every external integration: one
 * interface, a real implementation and a mock, selected by config. The mock in
 * `memory-register.ts` is what the tests run against; the real one is an adapter
 * over the chosen TA's API and contains no business logic of its own.
 *
 * Every mutating call carries an idempotency `ref`. Replaying a ref returns the
 * original result rather than performing the operation twice — the same
 * discipline `strait` applies to webhooks, for the same reason: the network will
 * deliver the instruction twice and the register is the book of record.
 */

import { Fixed } from '../domain/fixed';
import { Holder, SleeveId } from '../eligibility/holder';
import { Restriction } from '../eligibility/codes';

export interface RegisterEntry {
  readonly holder: Holder;
  readonly updatedAt: Date;
}

export interface OperationResult {
  readonly ref: string;
  readonly applied: boolean;
  /** True when this ref had already been applied and the result is a replay. */
  readonly replayed: boolean;
  readonly restriction: Restriction;
  readonly at: Date;
}

/** A point-in-time view of the register, for reconciliation against the chain. */
export interface RegisterSnapshot {
  readonly asOf: Date;
  readonly sleeve: SleeveId;
  readonly balances: ReadonlyMap<string, Fixed>;
  readonly totalUnits: Fixed;
  readonly holdersOfRecord: number;
}

export interface ForcedTransferReason {
  /** Court order, lost-key recovery, or a regulator instruction. Recorded, always. */
  readonly kind: 'COURT_ORDER' | 'LOST_KEY' | 'REGULATOR' | 'ERROR_CORRECTION';
  readonly reference: string;
  readonly authorisedBy: string;
}

export interface ITransferAgentRegister {
  getHolder(holderId: string): Promise<Holder | undefined>;
  getHolderByWallet(wallet: string): Promise<Holder | undefined>;
  listHolders(sleeve: SleeveId): Promise<readonly Holder[]>;
  holdersOfRecord(sleeve: SleeveId): Promise<number>;

  /** Subscription. Mints units against a settled creation. */
  issue(ref: string, holderId: string, units: Fixed): Promise<OperationResult>;
  /** Redemption. Cancels units against a settled redemption. */
  cancel(ref: string, holderId: string, units: Fixed): Promise<OperationResult>;
  /** Secondary transfer, subject to the same rules the chain enforces. */
  transfer(ref: string, fromId: string, toId: string, units: Fixed): Promise<OperationResult>;

  /**
   * The three powers that make this a register rather than a ledger. A token
   * contract without them is not a security's book of record, however many
   * whitelists it has.
   */
  forceTransfer(
    ref: string, fromId: string, toId: string, units: Fixed, reason: ForcedTransferReason,
  ): Promise<OperationResult>;
  setFrozen(ref: string, holderId: string, frozen: boolean): Promise<OperationResult>;
  setLockup(ref: string, holderId: string, units: Fixed, until: Date): Promise<OperationResult>;

  snapshot(sleeve: SleeveId, asOf: Date): Promise<RegisterSnapshot>;
}
