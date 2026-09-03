/**
 * Observed market data, dated and cited.
 *
 * Every number the engine prices against lives here, with its source and the day
 * it was read. Nothing in this file is a forecast and nothing is smoothed. Where
 * a figure is an estimate rather than an observation it is marked `estimated`,
 * because the difference between "the Bank of Israel published 3.25%" and "we
 * think the basis is about -18bp" is the difference between a NAV input and a
 * modelling assumption.
 *
 * ---------------------------------------------------------------------------
 * THE FINDING THAT INVALIDATES THE HEADLINE IN EVERY RESEARCH DOCUMENT.
 *
 * `BUILD-ROUTES.md`, `SIMPLE-VERSION.md` and `PLAN.md` are all written against
 * ILS 4.00% and USD/ILS 3.02. Both have moved, and one of them has crossed over:
 *
 *   Bank of Israel policy rate   4.00%  ->  3.25%   (cut 1 Sep 2026, third
 *                                                    consecutive: May, Jul, Sep)
 *   USD 3-month bill             3.87%  ->  3.78%
 *   USD/ILS spot                  3.02  ->  2.9977
 *
 * **The shekel rate is now 47bp BELOW the dollar rate.** The product no longer
 * pays more than a dollar bill fund; it pays about 53bp less before any drag and
 * about 130bp less after. `BUILD-ROUTES.md` §8 listed "Israel cuts rates" as
 * risk 5 and called it "the one most likely to embarrass you". It has happened,
 * faster than the Bank's own 12-month forecast of 3.00% implied.
 *
 * What survives, and it is not nothing: **BILS still pays zero by licence
 * condition.** The gap this product exists to close is 3.25% minus fee against
 * zero, not 4% against a dollar alternative. That argument is intact and it is
 * now the only argument. Any deck still leading with a yield comparison against
 * dollars is selling a negative number.
 *
 * The second thing that changed is a risk, not a rate. The shekel has
 * appreciated roughly 20% against the dollar in twelve months, is near a 33-year
 * peak, and the central bank is cutting explicitly to slow it because exporters
 * are being hurt. A dollar-based buyer taking shekel exposure here is buying a
 * currency after a 20% run, into a policy that is actively trying to weaken it.
 * That belongs in the first paragraph of the term sheet, not the risk factors.
 * ---------------------------------------------------------------------------
 */

import { Fixed } from '../domain/fixed';
import { FxRate, USD, ILS } from '../domain/money';

export interface Citation {
  readonly label: string;
  readonly url: string;
  readonly readOn: string;
}

export interface Observation {
  readonly value: Fixed;
  readonly asOf: string;
  readonly estimated: boolean;
  readonly note?: string;
}

const obs = (value: string, scale: number, asOf: string, note?: string): Observation =>
  note === undefined
    ? { value: Fixed.parse(value, scale), asOf, estimated: false }
    : { value: Fixed.parse(value, scale), asOf, estimated: false, note };

const est = (value: string, scale: number, asOf: string, note: string): Observation =>
  ({ value: Fixed.parse(value, scale), asOf, estimated: true, note });

export interface MarketSnapshot {
  readonly asOf: string;
  readonly spot: FxRate;
  readonly spotObservation: Observation;
  /** Bank of Israel policy rate. SHIR equals it by construction. */
  readonly ilsPolicyRate: Observation;
  readonly usdBill4w: Observation;
  readonly usdBill3m: Observation;
  readonly usdBill6m: Observation;
  readonly usdBill1y: Observation;
  readonly fedFundsEffective: Observation;
  readonly usdIlsAnnualVol: Observation;
  readonly crossCurrencyBasisBp: Observation;
  readonly shekelTwelveMonthMove: Observation;
  readonly maxDailyMove30d: Observation;
  /** Tokenized RWA excluding stablecoins, USD billions. */
  readonly rwaMarketBn: Observation;
  readonly tokenizedTreasuriesBn: Observation;
  readonly ousgAumM: Observation;
  readonly usdyAumBn: Observation;
  readonly citations: readonly Citation[];
}

/**
 * 2 September 2026. The last full set before this engine was written.
 * Replace wholesale rather than patching individual lines — a snapshot with
 * fields read on different days is worse than a stale one, because it prices a
 * carry trade against two different afternoons.
 */
export const SEP_2026: MarketSnapshot = {
  asOf: '2026-09-02',

  spot: FxRate.of(USD, ILS, '3.0420'),
  spotObservation: obs('3.0420', 4, '2026-09-02',
    'Bank of Israel representative rate, series RER_USD_ILS. This is the official ' +
    'daily fixing and it is what the fund should strike NAV against. Twelve-month ' +
    'range 2.8110 (2026-05-29) to 3.4190 (2025-08-21); 2026 average 3.0303. ' +
    'The shekel weakened 2.5% in the three sessions around the 1 September cut: ' +
    '2.968 on 28 Aug, 2.988, 3.012, 3.042'),

  ilsPolicyRate: obs('0.0325', 6, '2026-09-01',
    'cut from 3.50%; third consecutive cut after May and July'),

  usdBill4w: obs('0.0369', 6, '2026-09-01', 'H.15 secondary market'),
  usdBill3m: obs('0.0378', 6, '2026-09-01', 'H.15 secondary market'),
  usdBill6m: obs('0.0390', 6, '2026-09-01', 'H.15 secondary market'),
  usdBill1y: obs('0.0400', 6, '2026-09-01', 'H.15 secondary market'),
  fedFundsEffective: obs('0.0363', 6, '2026-09-01', 'H.15'),

  usdIlsAnnualVol: obs('0.0919', 6, '2026-09-02',
    'REALISED, computed from 1,143 Bank of Israel daily representative rates ' +
    '2022-01-03 to 2026-09-02 (npm run fetch:boi). One-year window; 30d is 8.88%, ' +
    '90d 10.05%, full sample 10.48%. This is realised, not implied — no USD/ILS ' +
    'option surface is accessible, since the CME contract is dead and OTC vols are ' +
    'not published, so a dealer quote is still worth having before the facility ' +
    'bids size. Realised is a defensible floor and a holder can recompute it'),

  crossCurrencyBasisBp: est('-17.7', 4, '2026-09-02',
    'median from ISRAEL-EVIDENCE.md. Budget 20-40bp on a real ticket for the ' +
    'crowded-side cost of joining the ~$90bn institutional hedge flow'),

  shekelTwelveMonthMove: obs('0.1131', 6, '2026-09-02',
    'COMPUTED from the BoI series: 3.3860 on 2025-09-02 to 3.0420 on 2026-09-02. ' +
    'Press reporting of "20%" is peak to trough (3.4190 on 2025-08-21 to 2.8110 on ' +
    '2026-05-29, 21.6%) — use the clean year-over-year number in a term sheet'),

  /** Largest single-day USD/ILS move in the last thirty sessions, as a fraction. */
  maxDailyMove30d: obs('0.0121', 6, '2026-09-02',
    '2.10 sigma against the one-year realised vol. The facility default covers ' +
    '1.5 sigma — see the FACILITY-COVER alert'),

  rwaMarketBn: obs('31.4', 2, '2026-05-15', 'excluding stablecoins; ~$6bn in early 2025'),
  tokenizedTreasuriesBn: obs('15', 0, '2026-05-01', 'largest single RWA category'),
  ousgAumM: obs('366.93', 2, '2026-08-21', 'down from ~$625m earlier in 2026'),
  usdyAumBn: obs('2.15', 2, '2026-08-01', 'more than doubled since the start of 2026'),

  citations: [
    { label: 'Bank of Israel cuts to 3.25%',
      url: 'https://www.bloomberg.com/news/articles/2026-09-01/israel-slashes-interest-rates-for-third-consecutive-meeting',
      readOn: '2026-09-03' },
    { label: 'Federal Reserve H.15, 2 September 2026',
      url: 'https://www.federalreserve.gov/releases/h15/', readOn: '2026-09-03' },
    { label: 'USD/ILS representative rate, BoI SDMX series RER_USD_ILS',
      url: 'https://edge.boi.org.il/FusionEdgeServer/sdmx/v2/data/dataflow/BOI.STATISTICS/EXR/1.0/RER_USD_ILS?format=csv',
      readOn: '2026-09-03' },
    { label: 'Government Debt Management Unit, Annual Debt Report 2025',
      url: 'https://www.gov.il/BlobFolder/dynamiccollectorresultitem/annual-debt-report-2025/en/files-eng_Annual-Debt-Reports_annual-debt-report-2025-accessible-version-en.pdf',
      readOn: '2026-09-03' },
    { label: 'Strong shekel, exporter pressure, third cut',
      url: 'https://allisraelnews.com/strong-shekel-strains-exporters-as-bank-of-israel-cuts-interest-rates-for-third-time-in-2026',
      readOn: '2026-09-03' },
    { label: 'Tokenized RWA $31.4bn',
      url: 'https://yellow.com/research/tokenized-rwas-31b-market-growth-real-race-starting', readOn: '2026-09-03' },
    { label: 'OUSG and USDY size',
      url: 'https://eco.com/support/en/articles/15254014-ousg-deep-dive-2026-ondo-s-short-treasury-fund', readOn: '2026-09-03' },
  ],
};

/** Every estimated field, so a report can mark them without hunting. */
export function estimatedFields(s: MarketSnapshot): readonly string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(s)) {
    if (v && typeof v === 'object' && 'estimated' in v && (v as Observation).estimated) out.push(k);
  }
  return out;
}
