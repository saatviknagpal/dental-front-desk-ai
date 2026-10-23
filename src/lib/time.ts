// All scheduling happens in the practice's local wall-clock time. We store
// timestamps as "YYYY-MM-DD HH:MM" strings (they sort correctly as text) and do
// date math on Date objects whose UTC fields hold that wall-clock time, so DST
// and the server's own timezone never shift a booking.

import { practiceTimezone } from "./config";

const pad = (n: number) => String(n).padStart(2, "0");

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Parse "YYYY-MM-DD", "YYYY-MM-DD HH:MM" or "YYYY-MM-DDTHH:MM[:SS]". Returns null if invalid. */
export function parseTs(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::\d{2})?)?$/.exec(String(value).trim());
  if (!m) return null;
  const [, y, mo, d, h = "0", mi = "0"] = m;
  const date = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi));
  // Reject overflow like 2026-02-31
  if (date.getUTCMonth() !== +mo - 1 || date.getUTCDate() !== +d) return null;
  return date;
}

export function fmtTs(d: Date): string {
  return `${fmtDate(d)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

export function fmtDate(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function addMinutes(d: Date, minutes: number): Date {
  return new Date(d.getTime() + minutes * 60_000);
}

export function addDays(d: Date, days: number): Date {
  return addMinutes(d, days * 24 * 60);
}

export function startOfDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** 0 = Sunday ... 6 = Saturday */
export function weekday(d: Date): number {
  return d.getUTCDay();
}

/** "Tue, Oct 27 at 9:30 AM" */
export function humanTs(d: Date): string {
  return `${DAYS[d.getUTCDay()].slice(0, 3)}, ${MONTHS[d.getUTCMonth()].slice(0, 3)} ${d.getUTCDate()} at ${humanTime(d)}`;
}

/** "9:30 AM" */
export function humanTime(d: Date): string {
  const h = d.getUTCHours();
  const m = d.getUTCMinutes();
  return `${h % 12 === 0 ? 12 : h % 12}:${pad(m)} ${h < 12 ? "AM" : "PM"}`;
}

/** "Tuesday, October 27, 2026" */
export function humanDate(d: Date): string {
  return `${DAYS[d.getUTCDay()]}, ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

export function dayName(d: Date): string {
  return DAYS[d.getUTCDay()];
}

/** Current wall-clock time at the practice. NOW_OVERRIDE="2026-10-23 10:00" pins it for tests/evals. */
export function practiceNow(): Date {
  const override = process.env.NOW_OVERRIDE;
  if (override) {
    const d = parseTs(override);
    if (d) return d;
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: practiceTimezone(),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return new Date(Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute")));
}
