# manufacturer

The issuer engine for the first product: **a shekel-denominated bill fund, tokenized on Base,
subscribed and redeemed in USDC, whose NAV accrues at roughly the Bank of Israel rate less a fee.**

Route C of `research/BUILD-ROUTES.md` — the synthetic. The fund holds US Treasury bills and buys
shekels forward. Covered interest parity delivers the shekel rate; the dollar rate cancels exactly.
It touches no Israeli custodian, no TASE membership and no Israeli tax question, which is why it
launches in weeks rather than a year.

**Why it exists:** BILS, Israel's regulated shekel stablecoin, is prohibited from paying yield as a
condition of its licence. At a 4.00% policy rate, holding BILS costs its holder 4% a year.
`USDC : USDY :: BILS : this`.

---

## What is in here

Pure financial engineering, fully tested, no database and no chain calls. The arithmetic has to be
right before anything is wired to it.

| Module | What it computes |
|---|---|
| `domain/fixed.ts` | Exact decimal arithmetic on scaled bigints. Every number that could be argued about in a redemption dispute. |
| `domain/money.ts` | Currencies, `Money`, `FxRate`. No bare amounts — adding a shekel to a dollar is a type error. |
| `domain/daycount.ts` | ACT/360 and ACT/365F. The two legs use different conventions and the gap is worth basis points. |
| `domain/calendar.ts` | Two business weeks that do not line up (Israel Sun–Thu, New York Mon–Fri), plus the FX session clock. |
| `pricing/cip.ts` | Covered interest parity, forward points, implied rate, **the cross-currency basis as a measured cost**. |
| `hedge/forward.ts` `hedge/book.ts` | The forward book: MTM, gross and net notional, initial margin, roll queue, hedge ratio. |
| `compliance/cpo.ts` | **CFTC Rule 4.13(a)(3), both arms, as a pre-trade gate.** Plus the ECP test and the 4.7 fallback. |
| `nav/bills.ts` | The dollar leg: discount pricing, amortised-cost accretion, WAM, maturing face. |
| `nav/nav.ts` | The NAV strike, fee accrual, and the published cost line. |
| `facility/redemption.ts` | The standing redemption facility, rule-priced and rule-suspended. |
| `subscription/dealing.ts` | Swing-priced creations and redemptions at the $1m creation unit. |

```
npm install
npm test              # 90 tests
npm run worked-example  # one day in the life of the fund, with real numbers
```

`test/cip.spec.ts` reproduces `research/BUILD-ROUTES.md` §3.1 line by line. If it goes red, either
the engine is wrong or the document is, and both are findings.

---

## Three things the engine found that the documents do not say

**1. The standing facility is mispriced for this product.** `PLAN.md` §11 justifies a ~25bp haircut
on the ground that "bills do not gap". True of a dollar bill fund; false here. This fund's NAV is in
shekels and the facility pays dollars, so its exposure is one USD/ILS gap — about **50bp at one
sigma on an 8% vol**. Worse, the facility's whole selling point is that it runs when nothing else
does, and the FX market is shut for 48 hours a week.

The fix is cheap and it is a *pre*-hedge, not a wider spread: carry a short ILS position sized to the
5% cap into every Friday close. `preHedgeCarryCost` puts that at **under 0.01bp of NAV**, against the
**65bp of haircut it removes**. `preHedgedRatio` is therefore live operational state, and a facility
quoting on a Saturday with no pre-hedge on must quote 75bp or suspend.

**2. The two 4.13(a)(3) arms fail together, not independently.** The rule measures both ratios
against liquidation value *after unrealised P&L*. A forward book marked against the fund shrinks the
denominator on both arms at exactly the moment a margin call is raising the numerator on one of them.
The worked example sits at 2.96% on the margin arm and 98.62% on the notional arm — relief is real,
but it is carried by the margin arm alone the instant the hedge ratio drifts above 1.00.

**3. The fee does not fit at the forecast rate.** At 45bp of fee plus 36bp of basis, execution and
operating cost, total drag is 81bp. That is 20.2% of gross at today's 4.00% and **27.0% at the Bank
of Israel's own 12-month forecast of 3.00%**. `PLAN.md` §8's own fee test is 16% of gross. The fee
has to be set off the forecast, not off the screen.

---

## What this deliberately does not do

- **No transfer agent.** Rented — Securitize, Tokensoft, or the venue's own. `PLAN.md` is absolute
  and nothing here changes it.
- **No NAV of our own record.** A fund administrator strikes NAV independently. This engine computes
  it so the two can be reconciled; it is not the book of record.
- **No ATS, no venue, no custody.**
- **No chain code yet.** The whitelist token on Base comes after the arithmetic is settled.

## Open, and gating

- **The CPO memo** — `research/BUILD-ROUTES.md` §4, six questions, $20–30k. Everything in
  `compliance/cpo.ts` is our reading, encoded in one place so counsel's answer changes one file.
- **The ILS money-market day-count basis** — assumed ACT/365F. Unsourced. `[VERIFY]`
- **Holiday calendars** — `assertSeeded` refuses to strike a NAV against an unseeded calendar. SIFMA
  and TASE both publish; neither is loaded.
