/**
 * Business-day calendars, and the one structural fact about this product:
 * the two relevant weeks do not line up.
 *
 *   Israel trades Sunday–Thursday. Friday and Saturday are its weekend.
 *   The USD leg trades Monday–Friday.
 *
 * So there are two one-sided days every week — Sunday (Israel open, USD closed)
 * and Friday (USD open, Israel closed) — plus a genuine joint holiday on Saturday.
 * The token transfers on all seven.
 *
 * `PLAN.md` §11's policy is enforced here: the fund never strikes NAV, accepts a
 * creation or accepts a redemption outside a joint good business day. The stale
 * NAV is published as stale. The standing redemption facility is the only thing
 * that runs off-window, and it prices the gap explicitly (see facility/).
 */

export enum Center {
  /** USD: New York. Mon–Fri. */
  NewYork = 'US',
  /** ILS: Tel Aviv. Sun–Thu. */
  TelAviv = 'IL',
}

export interface HolidaySet {
  readonly center: Center;
  /** ISO `YYYY-MM-DD` dates on which the centre is closed. */
  readonly dates: ReadonlySet<string>;
  /** True once seeded from a published source. Blocks NAV publication while false. */
  readonly seeded: boolean;
}

/**
 * Deliberately empty. Holiday dates are not invented here — SIFMA publishes the
 * US bond-market calendar and TASE publishes the Israeli one, and both must be
 * loaded before a NAV is struck for value. `assertSeeded` is the gate.
 */
export function emptyHolidays(center: Center): HolidaySet {
  return { center, dates: new Set<string>(), seeded: false };
}

export function holidaysFrom(center: Center, isoDates: readonly string[]): HolidaySet {
  return { center, dates: new Set(isoDates), seeded: true };
}

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Weekend by centre. This is the asymmetry the whole document is about. */
export function isWeekend(d: Date, center: Center): boolean {
  const dow = d.getUTCDay(); // 0 Sun .. 6 Sat
  return center === Center.NewYork ? dow === 0 || dow === 6 : dow === 5 || dow === 6;
}

export function isBusinessDay(d: Date, cal: HolidaySet): boolean {
  return !isWeekend(d, cal.center) && !cal.dates.has(isoDate(d));
}

/** A day on which both centres settle. Creations, redemptions and NAV strikes need this. */
export function isJointBusinessDay(d: Date, cals: readonly HolidaySet[]): boolean {
  return cals.every((c) => isBusinessDay(d, c));
}

export function addDays(d: Date, n: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + n));
}

/** Following convention. Rolls forward to the next joint good day. */
export function nextJointBusinessDay(d: Date, cals: readonly HolidaySet[]): Date {
  let cur = addDays(d, 1);
  for (let i = 0; i < 30; i++) {
    if (isJointBusinessDay(cur, cals)) return cur;
    cur = addDays(cur, 1);
  }
  throw new RangeError(`no joint business day within 30 days of ${isoDate(d)}`);
}

export function addJointBusinessDays(d: Date, n: number, cals: readonly HolidaySet[]): Date {
  let cur = d;
  for (let i = 0; i < n; i++) cur = nextJointBusinessDay(cur, cals);
  return cur;
}

/** USD/ILS spot is T+2 on both centres. Forward value dates roll from spot. */
export const SPOT_LAG_DAYS = 2;

export function spotValueDate(tradeDate: Date, cals: readonly HolidaySet[]): Date {
  return addJointBusinessDays(tradeDate, SPOT_LAG_DAYS, cals);
}

export class UnseededCalendarError extends Error {
  constructor(center: Center) {
    super(
      `${center} holiday calendar is not seeded. Load the published calendar ` +
        `(SIFMA for US, TASE for IL) before striking a NAV for value.`,
    );
    this.name = 'UnseededCalendarError';
  }
}

/** Call before any NAV strike that will be published or settled against. */
export function assertSeeded(cals: readonly HolidaySet[]): void {
  for (const c of cals) if (!c.seeded) throw new UnseededCalendarError(c.center);
}

/**
 * The stale window: from the last joint business day's fixing to the next one.
 * Reported alongside every NAV so a holder can see how old the mark is.
 */
export function staleDays(asOf: Date, lastStrike: Date): number {
  const ms = Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate()) -
    Date.UTC(lastStrike.getUTCFullYear(), lastStrike.getUTCMonth(), lastStrike.getUTCDate());
  return Math.round(ms / 86_400_000);
}

// ---------------------------------------------------------------------------
// The FX session, which is a different clock from the settlement calendar.
//
// The interbank FX market runs continuously from Sunday 22:00 UTC to Friday
// 22:00 UTC. For roughly 48 hours a week there is no hedge available at any
// price. The token, meanwhile, transfers all 168 of them.
//
// That gap is the standing facility's entire risk, and it is why the facility on
// a shekel-denominated NAV is not the same instrument as the facility on a
// dollar bill fund that `PLAN.md` §11 sized.

const FX_OPEN_HOUR_UTC = 22; // Sunday
const FX_CLOSE_HOUR_UTC = 22; // Friday
/** Hours the market is shut each week: Friday 22:00 UTC to Sunday 22:00 UTC. */
export const FX_CLOSED_HOURS = 48;

export function fxIsOpen(d: Date): boolean {
  const day = d.getUTCDay();
  const hour = d.getUTCHours();
  if (day === 6) return false;                          // Saturday
  if (day === 0) return hour >= FX_OPEN_HOUR_UTC;       // Sunday, from the open
  if (day === 5) return hour < FX_CLOSE_HOUR_UTC;       // Friday, until the close
  return true;                                          // Mon-Thu
}

/** Zero when the market is open; otherwise hours until the Sunday open. */
export function hoursUntilFxOpen(d: Date): number {
  if (fxIsOpen(d)) return 0;
  const day = d.getUTCDay();
  const daysToSunday = day === 0 ? 0 : 7 - day;
  const open = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + daysToSunday, FX_OPEN_HOUR_UTC),
  );
  return Math.max((open.getTime() - d.getTime()) / 3_600_000, 0);
}
