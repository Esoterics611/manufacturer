import { Fixed } from '../src/domain/fixed';
import { FxRate, USD, ILS } from '../src/domain/money';
import { ForwardBook, Mark } from '../src/hedge/book';
import { ForwardPosition, Side, mtmQuote, deliveryQuoteAmount } from '../src/hedge/forward';

const d = (iso: string) => new Date(`${iso}T00:00:00Z`);

const pos = (id: string, notional: string, rate: string, valueDate: string, side = Side.BuyQuote,
             im = '30000.00'): ForwardPosition => ({
  id, base: USD, quote: ILS, side,
  baseNotional: Fixed.parse(notional, 2),
  contractRate: Fixed.parse(rate, 8),
  tradeDate: d('2026-09-03'),
  valueDate: d(valueDate),
  initialMargin: Fixed.parse(im, 2),
});

describe('a single forward', () => {
  const p = pos('F1', '10000000.00', '3.02097210', '2026-12-03');

  it('gains when the market forward falls below the contracted rate', () => {
    const mtm = mtmQuote(p, FxRate.of(USD, ILS, '3.01000000'), Fixed.parse('0.04', 4),
      Fixed.parse('0.25', 12));
    expect(mtm.isNegative()).toBe(false);
    // ~10m * 0.0109721 ILS, discounted a quarter at 4%
    expect(mtm.toNumber()).toBeCloseTo(109_721 / 1.01, 0);
  });

  it('loses when it rises', () => {
    const mtm = mtmQuote(p, FxRate.of(USD, ILS, '3.03000000'), Fixed.parse('0.04', 4),
      Fixed.parse('0.25', 12));
    expect(mtm.isNegative()).toBe(true);
  });

  it('is worth nothing when the market has not moved', () => {
    const mtm = mtmQuote(p, FxRate.of(USD, ILS, '3.02097210'), Fixed.parse('0.04', 4),
      Fixed.parse('0.25', 12));
    expect(mtm.toNumber()).toBeCloseTo(0, 6);
  });

  it('knows what it delivers at maturity', () => {
    expect(deliveryQuoteAmount(p).toNumber()).toBeCloseTo(30_209_721, 0);
  });

  it('refuses a mark from the wrong pair', () => {
    expect(() => mtmQuote(p, FxRate.of(ILS, USD, '0.33'), Fixed.parse('0.04', 4),
      Fixed.parse('0.25', 12))).toThrow(/does not match/);
  });
});

describe('the book', () => {
  const book = new ForwardBook()
    .with(pos('F1', '6000000.00', '3.02097210', '2026-12-03', Side.BuyQuote, '18000.00'))
    .with(pos('F2', '4000000.00', '3.02150000', '2026-12-03', Side.BuyQuote, '12000.00'))
    .with(pos('F3', '1000000.00', '3.02900000', '2027-03-03', Side.SellQuote, '3000.00'));

  it('reports gross and net notional differently, and says which is which', () => {
    expect(book.grossNotional().toNumber()).toBe(11_000_000);
    // Dec bucket nets to +10m; Mar bucket is -1m; absolute sum is 11m.
    expect(book.netNotional().toNumber()).toBe(11_000_000);
  });

  it('nets offsetting tickets inside the same value date', () => {
    const hedged = book.with(pos('F4', '2000000.00', '3.02200000', '2026-12-03', Side.SellQuote));
    expect(hedged.grossNotional().toNumber()).toBe(13_000_000);
    expect(hedged.netNotional().toNumber()).toBe(9_000_000);
  });

  it('aggregates initial margin — the numerator of the 5% arm', () => {
    expect(book.initialMargin().toNumber()).toBe(33_000);
  });

  it('computes the hedge ratio the mandate targets at 1.00', () => {
    const dec = new ForwardBook()
      .with(pos('F1', '10000000.00', '3.02097210', '2026-12-03'));
    expect(dec.hedgeRatio(Fixed.parse('10000000.00', 2)).toNumber()).toBe(1);
    expect(dec.hedgeRatio(Fixed.parse('12500000.00', 2)).toNumber()).toBe(0.8);
  });

  it('lists the roll queue and drops matured tickets', () => {
    expect(book.maturingBy(d('2026-12-31')).map((p) => p.id)).toEqual(['F1', 'F2']);
    expect(book.open(d('2026-12-31')).all().map((p) => p.id)).toEqual(['F3']);
  });

  it('sums unrealised P&L across the book', () => {
    const mark: Mark = {
      forward: FxRate.of(USD, ILS, '3.01000000'),
      quoteRate: Fixed.parse('0.04', 4),
      remainingYf: Fixed.parse('0.25', 12),
    };
    const marks = new Map([['F1', mark], ['F2', mark], ['F3', mark]]);
    const pnl = book.unrealisedQuote(marks);
    expect(pnl.isNegative()).toBe(false);
  });

  it('refuses to value a book with a missing mark', () => {
    expect(() => book.unrealisedQuote(new Map())).toThrow(/no mark for position/);
  });
});
