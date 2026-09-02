# CLAUDE.md — manufacturer

## 1. What this is

The issuer engine for the first product in `/home/nexus/code/research`: a shekel-denominated bill
fund, tokenized on Base, subscribed and redeemed in USDC. Route C — the synthetic — of
`research/BUILD-ROUTES.md`. Read that document and `research/SIMPLE-VERSION.md` before changing
anything here; the arithmetic in this repo is downstream of decisions taken there.

**Sibling repos.** `strait` is the distribution and the KYC attestation. `meridian-markets` is the
market-making book. `research` is the product and the evidence base. This repo is the manufacturing
arithmetic. Do not reach into a sibling repo; copy a type if you need one.

## 2. Tech stack

- Node 20, TypeScript strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), CommonJS.
- Jest via ts-jest. No database, no framework, no network. Deliberately.
- When persistence arrives it is NestJS 10 + PostgreSQL 16 + TypeORM raw SQL migrations, matching
  `strait` and `meridian-markets` — one repo, one DB, one ordered migration history, append-only
  tables, `SERIALIZABLE`. No microservices, no polyrepo.

## 3. Binding rules

- **Money is `Fixed`, never `number`.** Doubles are permitted at the boundary (a quoted rate arriving
  as a double, a `toNumber()` for a log or a chart) and nowhere else. Every division names its result
  scale and its rounding; there is no default quotient.
- **Rounding has a direction and the direction is a decision.** NAV per unit floors — the fund never
  over-credits. Fee accrual ceils — the fund never under-charges. Haircuts ceil. If a new rounding
  call does not have a stated reason, it is wrong.
- **`Money` carries its currency.** The one arithmetic error this product cannot survive is adding a
  shekel to a dollar in a NAV strike.
- **Compliance thresholds live in `compliance/cpo.ts` and nowhere else.** When the CPO memo comes
  back, exactly one file changes.
- **The document's arithmetic is a test.** `test/cip.spec.ts` reproduces `BUILD-ROUTES.md` §3.1. Keep
  it that way: when a document number changes, the test changes with it and the diff shows both.
- **Never build a transfer agent.** Rent one. Same for the ATS, the venue and custody.

## 4. What must never be silently defaulted

| Thing | Why |
|---|---|
| Holiday calendars | `assertSeeded` throws rather than strike a NAV against an empty calendar. Do not seed with invented dates. |
| ILS day-count basis | Assumed ACT/365F, unsourced. Tagged `[VERIFY]`. |
| `preHedgedRatio` | Live operational state. Defaulting it to 1 hides a 65bp weekend exposure. |
| Realised execution cost | Swing pricing passes on the *actual* cost. An estimate is a subsidy in one direction and a hidden fee in the other. |

## 5. House style

Inherited from `research/CLAUDE.md`. Short. Lead with the mechanism, then one worked example with
real numbers, then what breaks it. Every claim carries a number or is cut. Uncertainty is tagged
`[VERIFY]`, not smoothed over. Comments explain *why the number is that number* — the arithmetic is
already visible in the code.

## 6. Git

Work on `master`. End every session with the work committed, one coherent commit, `Co-Authored-By`
trailer. `.claude/` is git-ignored.
