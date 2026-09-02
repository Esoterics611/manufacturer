/**
 * Currencies, money, and FX rates.
 *
 * A `Money` carries its currency. There is no bare amount anywhere in the engine,
 * because the one arithmetic error this product cannot survive is adding a shekel
 * to a dollar in a NAV strike.
 */

import { Fixed, Rounding } from './fixed';

export interface Currency {
  readonly code: string;
  /** Decimal places in which balances of this currency are held exactly. */
  readonly scale: number;
}

export const USD: Currency = { code: 'USD', scale: 2 };
export const ILS: Currency = { code: 'ILS', scale: 2 };
/** USDC is 6-decimal on Base. Balances are exact at 6dp; never store 18dp wei here. */
export const USDC: Currency = { code: 'USDC', scale: 6 };
/** The fund token. ERC-20 default on Base. */
export const UNIT: Currency = { code: 'UNIT', scale: 18 };

export class Money {
  private constructor(readonly currency: Currency, readonly amount: Fixed) {}

  static of(currency: Currency, text: string): Money {
    return new Money(currency, Fixed.parse(text, currency.scale));
  }

  static from(currency: Currency, amount: Fixed, rounding: Rounding = Rounding.HalfEven): Money {
    return new Money(currency, amount.rescale(currency.scale, rounding));
  }

  static zero(currency: Currency): Money {
    return new Money(currency, Fixed.zero(currency.scale));
  }

  private assertSame(other: Money): void {
    if (this.currency.code !== other.currency.code) {
      throw new TypeError(`currency mismatch: ${this.currency.code} vs ${other.currency.code}`);
    }
  }

  add(other: Money): Money {
    this.assertSame(other);
    return new Money(this.currency, this.amount.add(other.amount));
  }

  sub(other: Money): Money {
    this.assertSame(other);
    return new Money(this.currency, this.amount.sub(other.amount));
  }

  /** Scale by a dimensionless factor — a fee rate, a participation, a haircut. */
  scaleBy(factor: Fixed, rounding: Rounding = Rounding.HalfEven): Money {
    return Money.from(this.currency, this.amount.mul(factor), rounding);
  }

  /** Ratio of two amounts in the same currency, at a named scale. */
  ratioTo(other: Money, scale: number, rounding: Rounding = Rounding.HalfEven): Fixed {
    this.assertSame(other);
    return this.amount.div(other.amount, scale, rounding);
  }

  neg(): Money { return new Money(this.currency, this.amount.neg()); }
  abs(): Money { return new Money(this.currency, this.amount.abs()); }
  isZero(): boolean { return this.amount.isZero(); }
  isNegative(): boolean { return this.amount.isNegative(); }
  cmp(other: Money): -1 | 0 | 1 { this.assertSame(other); return this.amount.cmp(other.amount); }
  gt(other: Money): boolean { return this.cmp(other) > 0; }
  gte(other: Money): boolean { return this.cmp(other) >= 0; }
  lt(other: Money): boolean { return this.cmp(other) < 0; }
  lte(other: Money): boolean { return this.cmp(other) <= 0; }

  static sum(currency: Currency, items: readonly Money[]): Money {
    return items.reduce((a, b) => a.add(b), Money.zero(currency));
  }

  static min(a: Money, b: Money): Money { return a.lte(b) ? a : b; }
  static max(a: Money, b: Money): Money { return a.gte(b) ? a : b; }

  toString(): string { return `${this.amount.toString()} ${this.currency.code}`; }
  toJSON(): { currency: string; amount: string } {
    return { currency: this.currency.code, amount: this.amount.toString() };
  }
}

/** Scale at which FX rates and forward prices are held. Eight places covers ILS pips. */
export const FX_SCALE = 8;

/**
 * A rate quoted as: one unit of `base` buys `rate` units of `quote`.
 * USD/ILS 3.02 is `{ base: USD, quote: ILS, rate: 3.02000000 }`.
 */
export class FxRate {
  private constructor(readonly base: Currency, readonly quote: Currency, readonly rate: Fixed) {
    if (rate.isNegative() || rate.isZero()) throw new RangeError(`non-positive FX rate ${rate}`);
  }

  static of(base: Currency, quote: Currency, text: string): FxRate {
    return new FxRate(base, quote, Fixed.parse(text, FX_SCALE));
  }

  static from(base: Currency, quote: Currency, rate: Fixed): FxRate {
    return new FxRate(base, quote, rate.rescale(FX_SCALE));
  }

  invert(): FxRate {
    return new FxRate(this.quote, this.base, Fixed.parse('1', 0).div(this.rate, FX_SCALE));
  }

  /** Convert, rounding into the target currency's own scale. */
  convert(money: Money, rounding: Rounding = Rounding.HalfEven): Money {
    if (money.currency.code === this.base.code) {
      return Money.from(this.quote, money.amount.mul(this.rate), rounding);
    }
    if (money.currency.code === this.quote.code) {
      return Money.from(this.base, money.amount.div(this.rate, this.base.scale + 4), rounding);
    }
    throw new TypeError(`${money.currency.code} is not a leg of ${this.pair()}`);
  }

  pair(): string { return `${this.base.code}/${this.quote.code}`; }
  toString(): string { return `${this.pair()} ${this.rate.toString()}`; }
}

/**
 * USDC and USD are treated as one unit of account at par inside the engine.
 *
 * This is a modelling decision, not a fact: USDC depegs. It is safe here only
 * because the fund's dollar leg is held in T-bills, not in USDC, and USDC touches
 * the fund only in the subscription and redemption windows. If the standing
 * facility ever holds USDC across a weekend, this assumption becomes a position
 * and belongs in the risk report.
 */
export const USDC_PAR: FxRate = FxRate.of(USDC, USD, '1');
