/**
 * In-memory transfer agent register.
 *
 * The mock behind `ITransferAgentRegister`. It exists so the whole issuance and
 * dealing path can be tested end to end without a vendor contract, and so the
 * eligibility rules are exercised by something that actually moves balances.
 *
 * It is not a transfer agent and must never be deployed as one. The real
 * implementation is a thin adapter over the rented TA's API.
 */

import { Fixed } from '../domain/fixed';
import { Holder, SleeveConfig, SleeveId } from '../eligibility/holder';
import { Restriction } from '../eligibility/codes';
import {
  detectIssuanceRestriction, detectTransferRestriction, RegistryState, TransferContext,
} from '../eligibility/rules';
import {
  ForcedTransferReason, ITransferAgentRegister, OperationResult, RegisterSnapshot,
} from './register';

const ZERO = Fixed.zero(18);

export interface ForcedTransferRecord {
  readonly ref: string;
  readonly at: Date;
  readonly fromId: string;
  readonly toId: string;
  readonly units: Fixed;
  readonly reason: ForcedTransferReason;
}

export class MemoryRegister implements ITransferAgentRegister {
  private readonly holders = new Map<string, Holder>();
  private readonly applied = new Map<string, OperationResult>();
  private readonly forced: ForcedTransferRecord[] = [];
  private paused = false;
  private clock: () => Date = () => new Date();

  constructor(private readonly sleeve: SleeveConfig) {}

  // -- test and operations seams -------------------------------------------

  setClock(fn: () => Date): void { this.clock = fn; }
  setPaused(paused: boolean): void { this.paused = paused; }
  upsertHolder(h: Holder): void { this.holders.set(h.id, h); }
  forcedTransfers(): readonly ForcedTransferRecord[] { return this.forced; }

  private ctx(): TransferContext {
    const registry: RegistryState = {
      paused: this.paused,
      holdersOfRecord: this.countHolders(),
    };
    return { asOf: this.clock(), sleeve: this.sleeve, registry };
  }

  private countHolders(): number {
    let n = 0;
    for (const h of this.holders.values()) if (!h.balance.isZero()) n++;
    return n;
  }

  private result(ref: string, restriction: Restriction): OperationResult {
    const r: OperationResult = {
      ref,
      applied: restriction === Restriction.Success,
      replayed: false,
      restriction,
      at: this.clock(),
    };
    if (r.applied) this.applied.set(ref, r);
    return r;
  }

  private replay(ref: string): OperationResult | undefined {
    const prior = this.applied.get(ref);
    return prior ? { ...prior, replayed: true } : undefined;
  }

  private credit(id: string, units: Fixed): void {
    const h = this.holders.get(id);
    if (!h) throw new RangeError(`unknown holder ${id}`);
    const wasZero = h.balance.isZero();
    this.holders.set(id, {
      ...h,
      balance: h.balance.add(units),
      firstAcquiredAt: wasZero ? this.clock() : h.firstAcquiredAt,
    });
  }

  private debit(id: string, units: Fixed): void {
    const h = this.holders.get(id);
    if (!h) throw new RangeError(`unknown holder ${id}`);
    this.holders.set(id, { ...h, balance: h.balance.sub(units) });
  }

  // -- reads ----------------------------------------------------------------

  async getHolder(holderId: string): Promise<Holder | undefined> {
    return this.holders.get(holderId);
  }

  async getHolderByWallet(wallet: string): Promise<Holder | undefined> {
    for (const h of this.holders.values()) {
      if (h.wallet.toLowerCase() === wallet.toLowerCase()) return h;
    }
    return undefined;
  }

  async listHolders(sleeve: SleeveId): Promise<readonly Holder[]> {
    return [...this.holders.values()].filter((h) => h.sleeve === sleeve);
  }

  async holdersOfRecord(_sleeve: SleeveId): Promise<number> {
    return this.countHolders();
  }

  // -- writes ---------------------------------------------------------------

  async issue(ref: string, holderId: string, units: Fixed): Promise<OperationResult> {
    const prior = this.replay(ref);
    if (prior) return prior;
    const ctx = this.ctx();
    const to = this.holders.get(holderId);
    const restriction = detectIssuanceRestriction(to, units, ctx);
    if (restriction === Restriction.Success) this.credit(holderId, units);
    return this.result(ref, restriction);
  }

  async cancel(ref: string, holderId: string, units: Fixed): Promise<OperationResult> {
    const prior = this.replay(ref);
    if (prior) return prior;
    const h = this.holders.get(holderId);
    if (!h) return this.result(ref, Restriction.SenderUnknown);
    if (h.frozen) return this.result(ref, Restriction.SenderFrozen);
    if (h.balance.lt(units)) return this.result(ref, Restriction.InsufficientBalance);
    // A redemption may leave zero, but never dust.
    const after = h.balance.sub(units);
    if (!after.isZero() && after.lt(this.sleeve.minimumHolding)) {
      return this.result(ref, Restriction.BelowMinimumHolding);
    }
    this.debit(holderId, units);
    return this.result(ref, Restriction.Success);
  }

  async transfer(ref: string, fromId: string, toId: string, units: Fixed): Promise<OperationResult> {
    const prior = this.replay(ref);
    if (prior) return prior;
    const ctx = this.ctx();
    const restriction = detectTransferRestriction(
      this.holders.get(fromId), this.holders.get(toId), units, ctx,
    );
    if (restriction === Restriction.Success) {
      this.debit(fromId, units);
      this.credit(toId, units);
    }
    return this.result(ref, restriction);
  }

  /**
   * Forced transfer bypasses the sender's consent — that is the point — but not
   * the recipient's eligibility. A court can order units moved; it cannot make
   * the recipient an eligible holder, and moving units to an ineligible one
   * breaks the exemption for every other holder in the sleeve.
   */
  async forceTransfer(
    ref: string, fromId: string, toId: string, units: Fixed, reason: ForcedTransferReason,
  ): Promise<OperationResult> {
    const prior = this.replay(ref);
    if (prior) return prior;
    const from = this.holders.get(fromId);
    const to = this.holders.get(toId);
    if (!from) return this.result(ref, Restriction.SenderUnknown);
    if (!to) return this.result(ref, Restriction.RecipientUnknown);
    if (from.balance.lt(units)) return this.result(ref, Restriction.InsufficientBalance);

    const ctx = this.ctx();
    const unfrozenSender: Holder = { ...from, frozen: false, lockedUnits: ZERO };
    const restriction = detectTransferRestriction(unfrozenSender, to, units, {
      ...ctx,
      // Seasoning does not survive a court order either; the recipient checks do.
      sleeve: { ...ctx.sleeve, distributionComplianceDays: 0 },
    });
    if (restriction !== Restriction.Success) return this.result(ref, restriction);

    this.debit(fromId, units);
    this.credit(toId, units);
    this.forced.push({ ref, at: this.clock(), fromId, toId, units, reason });
    return this.result(ref, Restriction.Success);
  }

  async setFrozen(ref: string, holderId: string, frozen: boolean): Promise<OperationResult> {
    const prior = this.replay(ref);
    if (prior) return prior;
    const h = this.holders.get(holderId);
    if (!h) return this.result(ref, Restriction.SenderUnknown);
    this.holders.set(holderId, { ...h, frozen });
    return this.result(ref, Restriction.Success);
  }

  async setLockup(ref: string, holderId: string, units: Fixed, until: Date): Promise<OperationResult> {
    const prior = this.replay(ref);
    if (prior) return prior;
    const h = this.holders.get(holderId);
    if (!h) return this.result(ref, Restriction.SenderUnknown);
    this.holders.set(holderId, { ...h, lockedUnits: units, lockedUntil: until });
    return this.result(ref, Restriction.Success);
  }

  async snapshot(sleeve: SleeveId, asOf: Date): Promise<RegisterSnapshot> {
    const balances = new Map<string, Fixed>();
    let total = ZERO;
    let count = 0;
    for (const h of this.holders.values()) {
      if (h.sleeve !== sleeve) continue;
      balances.set(h.wallet.toLowerCase(), h.balance);
      total = total.add(h.balance);
      if (!h.balance.isZero()) count++;
    }
    return { asOf, sleeve, balances, totalUnits: total, holdersOfRecord: count };
  }
}
