import { Fixed } from '../src/domain/fixed';
import { deskReport, openForBusiness, blockingAlerts } from '../src/admin/desk';
import { buildDeskInput } from '../scripts/desk-state';

describe('the desk report', () => {
  it('assembles market, NAV, hedge, compliance, facility and register in one pass', async () => {
    const r = deskReport(await buildDeskInput());
    expect(r.carry.bpTable['Bank of Israel policy rate']).toBe('325.0bp');
    expect(r.nav.netAssetsIls.isNegative()).toBe(false);
    expect(r.hedge.hedgeRatio.toNumber()).toBeGreaterThan(0.9);
    expect(r.compliance.exemption.available).toBe(true);
    expect(r.register.holdersOfRecord).toBe(41);
  });

  it('is open for business when nothing blocks', async () => {
    const r = deskReport(await buildDeskInput({ preHedged: '1', cleanRecon: true }));
    expect(openForBusiness(r)).toBe(true);
    expect(blockingAlerts(r)).toHaveLength(0);
  });

  it('closes the desk on eligibility drift, because the chain would transact past the register',
    async () => {
      const r = deskReport(await buildDeskInput({ preHedged: '1' }));
      expect(openForBusiness(r)).toBe(false);
      const recon = blockingAlerts(r).find((a) => a.code === 'RECON');
      expect(recon).toBeDefined();
      expect(recon!.message).toMatch(/eligibility drift/);
    });

  it('warns on a partial pre-hedge and quotes what the weekend would cost', async () => {
    const r = deskReport(await buildDeskInput({ preHedged: '0.40' }));
    const alert = r.alerts.find((a) => a.code === 'FACILITY-PREHEDGE');
    expect(alert?.severity).toBe('WARN');
    expect(alert?.message).toMatch(/before Friday/);
    expect(r.facility.weekendUnhedged.status).toBe('OPEN');
    if (r.facility.weekendUnhedged.status === 'OPEN') {
      expect(r.facility.weekendUnhedged.haircutBp.toNumber()).toBeGreaterThan(70);
    }
  });

  it('drops the pre-hedge warning once the cap is fully hedged', async () => {
    const r = deskReport(await buildDeskInput({ preHedged: '1', cleanRecon: true }));
    expect(r.alerts.find((a) => a.code === 'FACILITY-PREHEDGE')).toBeUndefined();
  });

  it('always carries the inverted-carry warning at these rates', async () => {
    const r = deskReport(await buildDeskInput());
    const a = r.alerts.find((x) => x.code === 'CARRY-INVERTED');
    expect(a).toBeDefined();
    expect(a!.message).toMatch(/134\.0bp less/);
  });

  it('blocks when the fund falls below the ECP threshold', async () => {
    const base = await buildDeskInput();
    const small = {
      ...base,
      pool: { ...base.pool, liquidationValue: Fixed.parse('4000000.00', 2) },
    };
    const r = deskReport(small);
    expect(openForBusiness(r)).toBe(false);
    expect(blockingAlerts(r).map((a) => a.code)).toContain('ECP');
  });

  it('blocks when 4.13(a)(3) relief is lost', async () => {
    const base = await buildDeskInput();
    const r = deskReport({
      ...base,
      pool: {
        liquidationValue: Fixed.parse('10000000.00', 2),
        aggregateInitialMargin: Fixed.parse('900000.00', 2),
        aggregateNetNotional: Fixed.parse('20000000.00', 2),
      },
    });
    expect(openForBusiness(r)).toBe(false);
    expect(blockingAlerts(r).map((a) => a.code)).toContain('CPO-4.13');
  });

  it('ranks blocking alerts above warnings', async () => {
    const base = await buildDeskInput();
    const r = deskReport({
      ...base,
      pool: { ...base.pool, liquidationValue: Fixed.parse('4000000.00', 2) },
    });
    expect(r.alerts[0]!.severity).toBe('BLOCK');
  });

  it('flags the basis as the last input still carried from a document', async () => {
    const r = deskReport(await buildDeskInput());
    const a = r.alerts.find((x) => x.code === 'DATA-ESTIMATED');
    expect(a!.message).toMatch(/crossCurrencyBasisBp/);
    expect(a!.message).not.toMatch(/usdIlsAnnualVol/);
  });

  it('warns that the facility cover is short of what the market printed', async () => {
    const r = deskReport(await buildDeskInput());
    const a = r.alerts.find((x) => x.code === 'FACILITY-COVER');
    expect(a).toBeDefined();
    expect(r.facility.observedSigmas.toNumber()).toBeCloseTo(2.10, 1);
    expect(r.facility.coverSigmas.toNumber()).toBe(1.5);
    expect(a!.message).toMatch(/pre-hedge as mandatory/);
  });
});
