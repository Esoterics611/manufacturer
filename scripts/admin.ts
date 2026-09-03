/**
 * The administrator console.
 *
 *   npm run admin
 *
 * Read-only by design: it reports, it never moves a unit. Mutating operations go
 * through the rented transfer agent register and hedge tickets go through the
 * pre-trade gate.
 */

import { Fixed, Rounding } from '../src/domain/fixed';
import { deskReport, openForBusiness, DeskReport } from '../src/admin/desk';
import { buildDeskInput } from './desk-state';
import { estimatedFields } from '../src/market/snapshot';

const B = (s: string) => `\x1b[1m${s}\x1b[0m`;
const DIM = (s: string) => `\x1b[2m${s}\x1b[0m`;
const RED = (s: string) => `\x1b[31m${s}\x1b[0m`;
const YEL = (s: string) => `\x1b[33m${s}\x1b[0m`;
const GRN = (s: string) => `\x1b[32m${s}\x1b[0m`;

const h = (s: string) => console.log(`\n${B(s)}`);
const row = (k: string, v: string) => console.log(`  ${k.padEnd(42)} ${v.padStart(24)}`);
const pct = (f: Fixed) => `${f.mul(Fixed.parse('100', 0)).rescale(2, Rounding.HalfEven)}%`;

function render(r: DeskReport): void {
  console.log(B(`\n  DESK REPORT  ${r.asOf.toISOString().slice(0, 16).replace('T', ' ')} UTC`));
  console.log(DIM(`  market data as of ${r.carry.asOf}`));

  const open = openForBusiness(r);
  console.log(`  ${open ? GRN('OPEN FOR BUSINESS') : RED('CLOSED — blocking alerts below')}`);

  h('MARKET');
  for (const [k, v] of Object.entries(r.carry.bpTable)) row(k, v);
  row('forward direction', r.carry.forwardDirection.replace(/_/g, ' ').toLowerCase());

  h('NAV');
  row('net assets, ILS', r.nav.netAssetsIls.toString());
  row('NAV per unit, ILS', r.nav.navPerUnitIls.toString());
  row('NAV per unit, USDC', r.nav.navPerUnitUsdc.toString());
  row('units outstanding', r.nav.unitsOutstanding.rescale(0).toString());
  row('stale', `${r.nav.staleDays} day(s)`);

  h('HEDGE');
  row('net notional, USD', r.hedge.netNotional.toString());
  row('gross notional, USD', r.hedge.grossNotional.toString());
  row('initial margin, USD', r.hedge.initialMargin.toString());
  row('hedge ratio (mandate 1.00)', r.hedge.hedgeRatio.toString());
  row('forwards maturing within 10 days', String(r.hedge.rollQueue));

  h('CFTC 4.13(a)(3)');
  row('margin arm (limit 5%)', `${r.compliance.marginArmPct}%`);
  row('margin headroom, USD', r.compliance.marginHeadroom.toString());
  row('notional arm (limit 100%)', `${r.compliance.notionalArmPct}%`);
  row('notional headroom, USD', r.compliance.notionalHeadroom.toString());
  row('relief carried by', r.compliance.exemption.trading.reliedOn);
  row('eligible contract participant', r.compliance.ecp ? 'yes' : RED('NO'));
  row('path', r.compliance.path);

  h('STANDING FACILITY');
  row('pre-hedged share of cap', pct(r.facility.preHedgedRatio));
  const q = r.facility.now;
  row('now', q.status === 'OPEN'
    ? `${q.haircutBp}bp haircut, bid ${q.bidUsdcPerUnit}`
    : RED(`SUSPENDED — ${q.rule}`));
  const w = r.facility.weekendUnhedged;
  row('coming weekend, unhedged', w.status === 'OPEN'
    ? YEL(`${w.haircutBp}bp haircut`)
    : YEL(`SUSPENDED — ${w.rule.slice(0, 40)}...`));
  if (q.status === 'OPEN') row('market-maker spread ceiling', `${q.haircutBp}bp`);

  h('REGISTER');
  row('holders of record', String(r.register.holdersOfRecord));
  row('ICA exclusion', r.register.exclusion);
  row('holder cap headroom', r.register.capHeadroom === null ? 'none' : String(r.register.capHeadroom));
  row('attestations expiring in 30 days', String(r.register.attestationsExpiring30d));
  row('reconciliation', r.register.reconciliation.clean
    ? GRN('clean')
    : YEL(`${r.register.reconciliation.breaks.length} break(s)`));
  for (const b of r.register.reconciliation.breaks.slice(0, 5)) {
    console.log(DIM(`    ${b.kind.padEnd(20)} ${b.wallet.slice(0, 10)}…  ${b.detail}`));
  }
  console.log(DIM(`  ${r.register.addressable}`));

  h(`ALERTS (${r.alerts.length})`);
  for (const a of r.alerts) {
    const tag = a.severity === 'BLOCK' ? RED('BLOCK') : a.severity === 'WARN' ? YEL(' WARN') : DIM(' INFO');
    console.log(`  ${tag}  ${B(a.code.padEnd(18))} ${a.message}`);
  }
  console.log('');
}

async function main(): Promise<void> {
  const input = await buildDeskInput();
  render(deskReport(input));
  const est = estimatedFields(input.market);
  console.log(DIM(`  estimated inputs: ${est.join(', ') || 'none'}\n`));
}

void main();
