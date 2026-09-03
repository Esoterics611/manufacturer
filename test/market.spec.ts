/**
 * The market snapshot is dated data, so these tests pin what it implies rather
 * than the numbers themselves — except where a number is the finding.
 */

import { Fixed } from '../src/domain/fixed';
import { SEP_2026, estimatedFields } from '../src/market/snapshot';
import { carryReport, shekelBreakevenMove } from '../src/market/carry';
import { parseBoiCsv, volReport, stressSigmas } from '../src/market/realised-vol';
import { readFileSync } from 'fs';
import { join } from 'path';

const DRAG = {
  managementFee: Fixed.parse('0.0045', 6),
  basisCost: Fixed.parse('0.0018', 6),
  executionCost: Fixed.parse('0.0010', 6),
  operatingCost: Fixed.parse('0.0008', 6),
};

describe('September 2026', () => {
  const r = carryReport(SEP_2026, DRAG);

  it('records the Bank of Israel at 3.25%, not the 4.00% every document assumes', () => {
    expect(SEP_2026.ilsPolicyRate.value.toNumber()).toBeCloseTo(0.0325, 6);
    expect(SEP_2026.ilsPolicyRate.estimated).toBe(false);
  });

  it('has the shekel rate below the dollar rate — the inversion that kills the pitch', () => {
    expect(r.rateDifferential.isNegative()).toBe(true);
    expect(r.bpTable['rate differential (ILS - USD)']).toBe('-53.0bp');
    expect(r.forwardDirection).toBe('SHEKEL_AT_FORWARD_PREMIUM');
  });

  it('pays 134bp less than a dollar bill fund after drag', () => {
    expect(r.bpTable['versus a dollar bill fund']).toBe('-134.0bp');
    expect(r.verdict).toMatch(/Do not sell yield/);
  });

  it('still pays 244bp against BILS, which pays zero by licence condition', () => {
    expect(r.bpTable['versus BILS (pays zero by licence)']).toBe('244.0bp');
    expect(r.vsBils.gt(Fixed.zero(6))).toBe(true);
  });

  it('requires the shekel to appreciate for a dollar holder to break even', () => {
    const move = shekelBreakevenMove(r, Fixed.parse('1', 0));
    expect(move.isNegative()).toBe(true);
    expect(move.toNumber()).toBeCloseTo(-0.0134, 5);
  });

  it('now computes volatility from the Bank of Israel series instead of guessing', () => {
    expect(estimatedFields(SEP_2026)).toEqual(['crossCurrencyBasisBp']);
    expect(SEP_2026.usdIlsAnnualVol.estimated).toBe(false);
    expect(SEP_2026.usdIlsAnnualVol.value.toNumber()).toBeCloseTo(0.0919, 6);
    expect(SEP_2026.usdIlsAnnualVol.note).toMatch(/1,143 Bank of Israel daily/);
  });

  it('uses the Bank of Israel representative rate as spot, not a web quote', () => {
    expect(SEP_2026.spot.rate.toNumber()).toBeCloseTo(3.0420, 6);
    expect(SEP_2026.spotObservation.note).toMatch(/RER_USD_ILS/);
  });

  it('reports the clean year-over-year shekel move, not the peak-to-trough headline', () => {
    expect(SEP_2026.shekelTwelveMonthMove.value.toNumber()).toBeCloseTo(0.1131, 6);
    expect(SEP_2026.shekelTwelveMonthMove.note).toMatch(/peak to trough/);
  });

  it('carries a citation for every observed figure', () => {
    expect(SEP_2026.citations.length).toBeGreaterThanOrEqual(6);
    for (const c of SEP_2026.citations) expect(c.url).toMatch(/^https:\/\//);
  });
});

describe('the report flips when the rates flip back', () => {
  it('reports a positive advantage if the Bank of Israel goes back above the dollar', () => {
    const hiked = { ...SEP_2026, ilsPolicyRate: { ...SEP_2026.ilsPolicyRate,
      value: Fixed.parse('0.0550', 6) } };
    const r = carryReport(hiked, DRAG);
    expect(r.rateDifferential.isNegative()).toBe(false);
    expect(r.forwardDirection).toBe('SHEKEL_AT_FORWARD_DISCOUNT');
    expect(r.vsDollarBillFund.isNegative()).toBe(false);
    expect(r.verdict).toMatch(/more than a dollar bill fund/);
  });
});

describe('realised volatility from the Bank of Israel series', () => {
  const csv = readFileSync(
    join(__dirname, '..', 'data', 'usdils-boi-representative.csv'), 'utf8',
  );
  const px = parseBoiCsv(csv);

  it('parses the SDMX csv export', () => {
    expect(px.length).toBeGreaterThan(1100);
    expect(px[0]!.date).toBe('2022-01-03');
    expect(px[px.length - 1]!.rate).toBeCloseTo(3.042, 4);
  });

  it('computes the one-year window the snapshot publishes', () => {
    const r = volReport(px, 'BOI');
    expect(r.headline.label).toBe('1y');
    expect(r.headline.annualised.toNumber()).toBeCloseTo(0.0919, 4);
    expect(r.lastRate.toNumber()).toBeCloseTo(3.042, 4);
  });

  it('shortens over 30 days and lengthens over the war period', () => {
    const r = volReport(px, 'BOI');
    const by = Object.fromEntries(r.windows.map((w) => [w.label, w.annualised.toNumber()]));
    expect(by['30d']!).toBeCloseTo(0.0888, 4);
    expect(by['full']!).toBeCloseTo(0.1048, 4);
    expect(by['full']!).toBeGreaterThan(by['1y']!);
  });

  it('finds a 2.1 sigma day inside the last thirty sessions', () => {
    const r = volReport(px, 'BOI');
    expect(r.maxDailyMove30d.toNumber()).toBeCloseTo(0.0121, 4);
    expect(stressSigmas(r).toNumber()).toBeCloseTo(2.10, 1);
    // The facility default covers 1.5 sigma. The market printed 2.1 last month.
    expect(stressSigmas(r).toNumber()).toBeGreaterThan(1.5);
  });

  it('rejects a series that is not a BOI export', () => {
    expect(() => parseBoiCsv('a,b\n1,2')).toThrow(/not a BOI SDMX csv/);
  });
});
