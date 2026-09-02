/**
 * A single deliverable FX forward.
 *
 * The fund is always the same way round: it holds dollars and buys shekels
 * forward. `Side.BuyQuote` is the only side the mandate permits; the enum exists
 * so that a mis-signed ticket fails a type check rather than a NAV strike.
 */

import { Fixed, Rounding } from '../domain/fixed';
import { FxRate, Currency } from '../domain/money';
import { RATE_SCALE } from '../pricing/cip';
import { simpleGrowth } from '../domain/daycount';

export enum Side {
  /** Sell base, buy quote. Sell USD, buy ILS. The fund's only permitted side. */
  BuyQuote = 'BUY_QUOTE',
  /** Buy base, sell quote. Present only so unwinds can be booked explicitly. */
  SellQuote = 'SELL_QUOTE',
}

export interface ForwardPosition {
  readonly id: string;
  readonly base: Currency;
  readonly quote: Currency;
  readonly side: Side;
  /** Notional in base currency (USD). Always positive; direction lives in `side`. */
  readonly baseNotional: Fixed;
  /** Contracted forward rate, quote per base. */
  readonly contractRate: Fixed;
  readonly tradeDate: Date;
  readonly valueDate: Date;
  /** Initial margin posted against this ticket, in base currency. */
  readonly initialMargin: Fixed;
}

export function signOf(side: Side): Fixed {
  return Fixed.parse(side === Side.BuyQuote ? '1' : '-1', 0);
}

/**
 * Mark to market, in quote currency, present-valued at the quote-currency rate.
 *
 *   PV = sign * N * (F_contract - F_market) / (1 + r_quote * T_remaining)
 *
 * Long the quote currency forward, the position gains when the market forward
 * falls — when shekels get more expensive to buy forward than we contracted.
 */
export function mtmQuote(
  p: ForwardPosition,
  marketForward: FxRate,
  quoteRate: Fixed,
  remainingYf: Fixed,
): Fixed {
  if (marketForward.base.code !== p.base.code || marketForward.quote.code !== p.quote.code) {
    throw new TypeError(`mark pair ${marketForward.pair()} does not match position`);
  }
  const diff = p.contractRate.sub(marketForward.rate);
  const undiscounted = p.baseNotional.mul(diff).mul(signOf(p.side));
  const df = simpleGrowth(quoteRate, remainingYf, RATE_SCALE);
  return undiscounted.div(df, p.quote.scale + 4, Rounding.HalfEven);
}

/** The quote-currency amount received at maturity if held to delivery. */
export function deliveryQuoteAmount(p: ForwardPosition): Fixed {
  return p.baseNotional.mul(p.contractRate).rescale(p.quote.scale, Rounding.HalfEven);
}

/** Signed base notional, for netting. */
export function signedBaseNotional(p: ForwardPosition): Fixed {
  return p.baseNotional.mul(signOf(p.side));
}
