import {
  Center, holidaysFrom, emptyHolidays, isWeekend, isBusinessDay, isJointBusinessDay,
  nextJointBusinessDay, spotValueDate, assertSeeded, UnseededCalendarError, staleDays, isoDate,
} from '../src/domain/calendar';

const US = holidaysFrom(Center.NewYork, []);
const IL = holidaysFrom(Center.TelAviv, []);
const both = [US, IL];

const d = (iso: string) => new Date(`${iso}T00:00:00Z`);

describe('the two weeks do not line up', () => {
  it('has a Sunday Israel trades and New York does not', () => {
    const sunday = d('2026-09-06');
    expect(isWeekend(sunday, Center.NewYork)).toBe(true);
    expect(isWeekend(sunday, Center.TelAviv)).toBe(false);
    expect(isJointBusinessDay(sunday, both)).toBe(false);
  });

  it('has a Friday New York trades and Tel Aviv does not', () => {
    const friday = d('2026-09-04');
    expect(isWeekend(friday, Center.NewYork)).toBe(false);
    expect(isWeekend(friday, Center.TelAviv)).toBe(true);
    expect(isJointBusinessDay(friday, both)).toBe(false);
  });

  it('leaves exactly four joint dealing days a clean week', () => {
    const week = ['2026-09-06', '2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10',
                  '2026-09-11', '2026-09-12'];
    const joint = week.filter((x) => isJointBusinessDay(d(x), both));
    expect(joint).toEqual(['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10']);
  });

  it('rolls Thursday to the following Monday', () => {
    expect(isoDate(nextJointBusinessDay(d('2026-09-10'), both))).toBe('2026-09-14');
  });

  it('makes the weekend stale window three days, not one', () => {
    expect(staleDays(d('2026-09-14'), d('2026-09-10'))).toBe(4);
  });
});

describe('holidays', () => {
  it('closes a centre on its own holiday', () => {
    const ilWithHoliday = holidaysFrom(Center.TelAviv, ['2026-09-08']);
    expect(isBusinessDay(d('2026-09-08'), ilWithHoliday)).toBe(false);
    expect(isJointBusinessDay(d('2026-09-08'), [US, ilWithHoliday])).toBe(false);
  });

  it('refuses to strike against an unseeded calendar', () => {
    expect(() => assertSeeded([US, emptyHolidays(Center.TelAviv)])).toThrow(UnseededCalendarError);
    expect(() => assertSeeded(both)).not.toThrow();
  });
});

describe('settlement', () => {
  it('settles spot T+2 on joint good days', () => {
    expect(isoDate(spotValueDate(d('2026-09-07'), both))).toBe('2026-09-09');
    // Wednesday trade skips Fri/Sat/Sun and lands Tuesday.
    expect(isoDate(spotValueDate(d('2026-09-09'), both))).toBe('2026-09-14');
  });
});
