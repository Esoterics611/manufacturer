/**
 * Refresh the USD/ILS representative-rate series from the Bank of Israel.
 *
 *   npm run fetch:boi
 *
 * The Bank publishes every series through a public SDMX endpoint. This is the
 * fixing the fund should strike NAV against — it is the official rate, published
 * daily, by the same institution that sets the policy rate the product tracks.
 *
 *   https://edge.boi.org.il/FusionEdgeServer/sdmx/v2/data/dataflow/BOI.STATISTICS/EXR/1.0/RER_USD_ILS
 */

import { writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parseBoiCsv, volReport, stressSigmas } from '../src/market/realised-vol';

const SERIES = 'RER_USD_ILS';
const START = '2022-01-01';
const URL =
  `https://edge.boi.org.il/FusionEdgeServer/sdmx/v2/data/dataflow/BOI.STATISTICS/EXR/1.0/` +
  `${SERIES}?format=csv&startperiod=${START}`;
const OUT = join(__dirname, '..', 'data', 'usdils-boi-representative.csv');

async function main(): Promise<void> {
  let csv: string;
  const offline = process.argv.includes('--offline');
  if (offline && existsSync(OUT)) {
    csv = readFileSync(OUT, 'utf8');
    console.log(`offline: reading ${OUT}`);
  } else {
    console.log(`fetching ${URL}`);
    const res = await fetch(URL);
    if (!res.ok) throw new Error(`Bank of Israel returned ${res.status}`);
    csv = await res.text();
    writeFileSync(OUT, csv);
    console.log(`wrote ${OUT}`);
  }

  const px = parseBoiCsv(csv);
  const r = volReport(px, 'Bank of Israel representative rate, series RER_USD_ILS');

  console.log(`\n  ${r.source}`);
  console.log(`  ${r.observations} observations, ${r.firstDate} to ${r.lastDate}`);
  console.log(`  last rate ${r.lastRate}\n`);
  for (const w of r.windows) {
    const mark = w.label === r.headline.label ? ' <- headline' : '';
    console.log(`  realised vol ${w.label.padEnd(6)} ${pct(w.annualised.toNumber())}${mark}`);
  }
  console.log(`\n  largest daily move in 30 sessions  ${pct(r.maxDailyMove30d.toNumber())}`);
  console.log(`  that is ${stressSigmas(r)} sigma against the headline vol`);
  console.log(`\n  Paste the headline into src/market/snapshot.ts as an OBSERVED input.\n`);
}

function pct(n: number): string {
  return `${(n * 100).toFixed(2)}%`;
}

void main();
