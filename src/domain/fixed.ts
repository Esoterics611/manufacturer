/**
 * Exact decimal arithmetic on scaled bigints.
 *
 * Everything that touches money, NAV, a unit count or a ratio that gets compared
 * to a regulatory threshold goes through this type. Doubles are permitted only
 * for reporting and for inputs quoted by a counterparty (a rate on a screen),
 * and they are converted at the boundary via `Fixed.fromNumber`.
 *
 * The rule: a number that can be argued about in a redemption dispute is a Fixed.
 */

export enum Rounding {
  /** Banker's rounding. The default for NAV, accruals and fees. */
  HalfEven = 'HALF_EVEN',
  /** Away from zero at the half. Used where a convention names it explicitly. */
  HalfUp = 'HALF_UP',
  /** Toward -inf. Used where the holder must not be over-credited. */
  Floor = 'FLOOR',
  /** Toward +inf. Used where the fund must not be under-charged. */
  Ceil = 'CEIL',
  /** Toward zero. */
  Trunc = 'TRUNC',
}

const TEN = 10n;

function pow10(n: number): bigint {
  if (n < 0) throw new RangeError(`negative scale ${n}`);
  let r = 1n;
  for (let i = 0; i < n; i++) r *= TEN;
  return r;
}

/** Divide num/den exactly under `rounding`. `den` must be positive. */
function divRound(num: bigint, den: bigint, rounding: Rounding): bigint {
  if (den <= 0n) throw new RangeError('denominator must be positive');
  const q = num / den;
  const r = num % den;
  if (r === 0n) return q;

  const neg = num < 0n;
  const twiceRem = (r < 0n ? -r : r) * 2n;

  switch (rounding) {
    case Rounding.Trunc:
      return q;
    case Rounding.Floor:
      return neg ? q - 1n : q;
    case Rounding.Ceil:
      return neg ? q : q + 1n;
    case Rounding.HalfUp:
      if (twiceRem >= den) return neg ? q - 1n : q + 1n;
      return q;
    case Rounding.HalfEven: {
      if (twiceRem > den) return neg ? q - 1n : q + 1n;
      if (twiceRem < den) return q;
      // exact half: round to even quotient
      return q % 2n === 0n ? q : neg ? q - 1n : q + 1n;
    }
  }
}

export class Fixed {
  private constructor(
    /** The scaled integer. `value = units / 10**scale`. */
    readonly units: bigint,
    readonly scale: number,
  ) {
    if (!Number.isInteger(scale) || scale < 0 || scale > 38) {
      throw new RangeError(`scale out of range: ${scale}`);
    }
  }

  // ---- construction -------------------------------------------------------

  static raw(units: bigint, scale: number): Fixed {
    return new Fixed(units, scale);
  }

  static zero(scale: number): Fixed {
    return new Fixed(0n, scale);
  }

  /**
   * Parse an exact decimal string. Rejects anything that would silently lose
   * precision at the requested scale — a subscription of 1.234567 ILS into a
   * 2dp field is a bug, not a rounding.
   */
  static parse(text: string, scale: number): Fixed {
    const m = /^([+-]?)(\d+)(?:\.(\d*))?$/.exec(text.trim());
    if (!m) throw new SyntaxError(`not a decimal: ${JSON.stringify(text)}`);
    const [, sign, intPart, fracPart = ''] = m as unknown as [string, string, string, string];
    if (fracPart.length > scale) {
      const tail = fracPart.slice(scale);
      if (/[^0]/.test(tail)) {
        throw new RangeError(`${text} does not fit scale ${scale} without loss`);
      }
    }
    const frac = (fracPart + '0'.repeat(scale)).slice(0, scale);
    const units = BigInt(intPart + frac);
    return new Fixed(sign === '-' ? -units : units, scale);
  }

  /**
   * Boundary conversion from a double. Only for values that arrive as doubles —
   * a quoted rate, a market-data tick. Rounds, and says so.
   */
  static fromNumber(n: number, scale: number, rounding: Rounding = Rounding.HalfEven): Fixed {
    if (!Number.isFinite(n)) throw new RangeError(`not finite: ${n}`);
    // Route through the shortest round-trip string so 0.1 is 0.1, not 0.1000000000000000055.
    const s = n.toFixed(Math.min(20, Math.max(scale, 17)));
    const wide = Fixed.parse(s, Math.min(20, Math.max(scale, 17)));
    return wide.rescale(scale, rounding);
  }

  // ---- shape --------------------------------------------------------------

  rescale(scale: number, rounding: Rounding = Rounding.HalfEven): Fixed {
    if (scale === this.scale) return this;
    if (scale > this.scale) return new Fixed(this.units * pow10(scale - this.scale), scale);
    return new Fixed(divRound(this.units, pow10(this.scale - scale), rounding), scale);
  }

  private static align(a: Fixed, b: Fixed): [bigint, bigint, number] {
    const s = Math.max(a.scale, b.scale);
    return [a.units * pow10(s - a.scale), b.units * pow10(s - b.scale), s];
  }

  // ---- arithmetic ---------------------------------------------------------

  add(other: Fixed): Fixed {
    const [x, y, s] = Fixed.align(this, other);
    return new Fixed(x + y, s);
  }

  sub(other: Fixed): Fixed {
    const [x, y, s] = Fixed.align(this, other);
    return new Fixed(x - y, s);
  }

  /** Exact product. Scale is the sum of the operand scales — rescale deliberately. */
  mul(other: Fixed): Fixed {
    return new Fixed(this.units * other.units, this.scale + other.scale);
  }

  /** Division always names its result scale and rounding. There is no default quotient. */
  div(other: Fixed, scale: number, rounding: Rounding = Rounding.HalfEven): Fixed {
    if (other.units === 0n) throw new RangeError('division by zero');
    // (a/10^sa) / (b/10^sb) = a * 10^(sb - sa + scale) / b, then place at `scale`
    const shift = scale + other.scale - this.scale;
    const num = shift >= 0 ? this.units * pow10(shift) : this.units;
    const den = shift >= 0 ? other.units : other.units * pow10(-shift);
    const negDen = den < 0n;
    return new Fixed(divRound(negDen ? -num : num, negDen ? -den : den, rounding), scale);
  }

  neg(): Fixed {
    return new Fixed(-this.units, this.scale);
  }

  abs(): Fixed {
    return this.units < 0n ? this.neg() : this;
  }

  // ---- comparison ---------------------------------------------------------

  cmp(other: Fixed): -1 | 0 | 1 {
    const [x, y] = Fixed.align(this, other);
    return x < y ? -1 : x > y ? 1 : 0;
  }

  eq(other: Fixed): boolean { return this.cmp(other) === 0; }
  lt(other: Fixed): boolean { return this.cmp(other) < 0; }
  lte(other: Fixed): boolean { return this.cmp(other) <= 0; }
  gt(other: Fixed): boolean { return this.cmp(other) > 0; }
  gte(other: Fixed): boolean { return this.cmp(other) >= 0; }
  isZero(): boolean { return this.units === 0n; }
  isNegative(): boolean { return this.units < 0n; }

  static min(a: Fixed, b: Fixed): Fixed { return a.lte(b) ? a : b; }
  static max(a: Fixed, b: Fixed): Fixed { return a.gte(b) ? a : b; }

  // ---- output -------------------------------------------------------------

  toString(): string {
    const neg = this.units < 0n;
    const digits = (neg ? -this.units : this.units).toString().padStart(this.scale + 1, '0');
    const int = digits.slice(0, digits.length - this.scale);
    const frac = this.scale === 0 ? '' : '.' + digits.slice(digits.length - this.scale);
    return (neg ? '-' : '') + int + frac;
  }

  /** Lossy. For logs, charts and percentage displays only. */
  toNumber(): number {
    return Number(this.toString());
  }

  toJSON(): string {
    return this.toString();
  }
}

/** Shorthand for a literal at a known scale. */
export const fx = (text: string, scale: number): Fixed => Fixed.parse(text, scale);
