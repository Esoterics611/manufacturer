import { Fixed, Rounding } from '../src/domain/fixed';

describe('Fixed', () => {
  it('parses and prints exactly', () => {
    expect(Fixed.parse('3.02', 8).toString()).toBe('3.02000000');
    expect(Fixed.parse('-0.0001', 6).toString()).toBe('-0.000100');
    expect(Fixed.parse('0', 2).toString()).toBe('0.00');
  });

  it('refuses silent precision loss on parse', () => {
    expect(() => Fixed.parse('1.234567', 2)).toThrow(/does not fit scale/);
    expect(Fixed.parse('1.2300', 2).toString()).toBe('1.23');
  });

  it('adds without float error', () => {
    const a = Fixed.parse('0.1', 2);
    const b = Fixed.parse('0.2', 2);
    expect(a.add(b).toString()).toBe('0.30');
    expect(0.1 + 0.2).not.toBe(0.3); // the reason this class exists
  });

  it('multiplies exactly, summing scales', () => {
    const r = Fixed.parse('1.05', 2).mul(Fixed.parse('2.5', 1));
    expect(r.scale).toBe(3);
    expect(r.toString()).toBe('2.625');
  });

  it('rounds half-even by default and away from zero on HalfUp', () => {
    expect(Fixed.parse('0.125', 3).rescale(2).toString()).toBe('0.12');
    expect(Fixed.parse('0.135', 3).rescale(2).toString()).toBe('0.14');
    expect(Fixed.parse('0.125', 3).rescale(2, Rounding.HalfUp).toString()).toBe('0.13');
    expect(Fixed.parse('-0.125', 3).rescale(2, Rounding.HalfUp).toString()).toBe('-0.13');
  });

  it('floors toward negative infinity, ceils toward positive', () => {
    expect(Fixed.parse('-0.121', 3).rescale(2, Rounding.Floor).toString()).toBe('-0.13');
    expect(Fixed.parse('0.121', 3).rescale(2, Rounding.Ceil).toString()).toBe('0.13');
    expect(Fixed.parse('-0.121', 3).rescale(2, Rounding.Trunc).toString()).toBe('-0.12');
  });

  it('divides at a named scale with a named rounding', () => {
    const third = Fixed.parse('1', 0).div(Fixed.parse('3', 0), 6);
    expect(third.toString()).toBe('0.333333');
    const up = Fixed.parse('2', 0).div(Fixed.parse('3', 0), 6, Rounding.Ceil);
    expect(up.toString()).toBe('0.666667');
  });

  it('divides by a negative denominator with the right sign', () => {
    expect(Fixed.parse('1', 0).div(Fixed.parse('-4', 0), 4).toString()).toBe('-0.2500');
  });

  it('rejects division by zero', () => {
    expect(() => Fixed.parse('1', 0).div(Fixed.zero(2), 4)).toThrow(/division by zero/);
  });

  it('round-trips a double at the boundary without float noise', () => {
    expect(Fixed.fromNumber(0.1, 8).toString()).toBe('0.10000000');
    expect(Fixed.fromNumber(3.02, 8).toString()).toBe('3.02000000');
  });

  it('compares across different scales', () => {
    expect(Fixed.parse('1.5', 1).eq(Fixed.parse('1.500000', 6))).toBe(true);
    expect(Fixed.parse('1.5', 1).lt(Fixed.parse('1.500001', 6))).toBe(true);
  });
});
