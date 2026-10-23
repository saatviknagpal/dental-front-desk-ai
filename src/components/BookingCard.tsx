// Confirmation card shown after a booking, with "add to calendar" options.
// Both work without any API: an .ics file (Apple/Outlook/most apps) and a
// Google Calendar template link.

export interface Booking {
  appointment_id: number;
  patient_name: string;
  label: string;
  start_time: string; // "YYYY-MM-DD HH:MM" in the practice's timezone
  display: string;
  provider_name: string;
  duration_minutes: number;
}

interface PracticeInfo {
  slug: string;
  name: string;
  address: string;
  phone: string;
  timezone: string;
}

/** "2026-10-27 09:30" + minutes → "20261027T100000" (wall-clock time, no UTC conversion). */
function stamp(ts: string, addMinutes = 0): string {
  const [d, t] = ts.split(" ");
  const [y, mo, day] = d.split("-").map(Number);
  const [h, mi] = t.split(":").map(Number);
  const x = new Date(Date.UTC(y, mo - 1, day, h, mi + addMinutes));
  const p = (n: number) => String(n).padStart(2, "0");
  return `${x.getUTCFullYear()}${p(x.getUTCMonth() + 1)}${p(x.getUTCDate())}T${p(x.getUTCHours())}${p(x.getUTCMinutes())}00`;
}

const icsEscape = (s: string) => s.replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\n/g, "\\n");

export function icsFile(b: Booking, p: PracticeInfo): string {
  const now = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Dental front desk//EN",
    "BEGIN:VEVENT",
    `UID:appt-${b.appointment_id}@${p.slug}`,
    `DTSTAMP:${now}`,
    `DTSTART;TZID=${p.timezone}:${stamp(b.start_time)}`,
    `DTEND;TZID=${p.timezone}:${stamp(b.start_time, b.duration_minutes)}`,
    `SUMMARY:${icsEscape(`${b.label} at ${p.name}`)}`,
    `LOCATION:${icsEscape(p.address)}`,
    `DESCRIPTION:${icsEscape(`${b.patient_name} with ${b.provider_name}. To change it, chat with us or call ${p.phone}.`)}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
}

export function googleCalendarUrl(b: Booking, p: PracticeInfo): string {
  const q = new URLSearchParams({
    action: "TEMPLATE",
    text: `${b.label} at ${p.name}`,
    dates: `${stamp(b.start_time)}/${stamp(b.start_time, b.duration_minutes)}`,
    ctz: p.timezone,
    location: p.address,
    details: `${b.patient_name} with ${b.provider_name}. To change it, chat with us or call ${p.phone}.`,
  });
  return `https://calendar.google.com/calendar/render?${q}`;
}

export default function BookingCard({ booking, practice }: { booking: Booking; practice: PracticeInfo }) {
  return (
    <div className="mt-2 rounded-xl border border-brand/30 bg-brand-soft px-4 py-3 text-sm" role="group" aria-label="Appointment confirmation">
      <div className="font-semibold text-brand-strong">✓ Booked: {booking.label}</div>
      <div className="mt-1">
        {booking.display} · {booking.duration_minutes} min
      </div>
      <div className="text-muted">
        {booking.patient_name} with {booking.provider_name}
      </div>
      <div className="text-muted">
        {practice.name}, {practice.address}
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        <a
          href={`data:text/calendar;charset=utf-8,${encodeURIComponent(icsFile(booking, practice))}`}
          download={`appointment-${booking.start_time.slice(0, 10)}.ics`}
          className="rounded-lg bg-brand px-3 py-1.5 font-medium text-white hover:bg-brand-strong"
        >
          Add to calendar (.ics)
        </a>
        <a href={googleCalendarUrl(booking, practice)} target="_blank" rel="noopener noreferrer" className="rounded-lg border border-brand/40 bg-surface px-3 py-1.5 font-medium text-brand-strong hover:bg-surface-2">
          Google Calendar
        </a>
      </div>
    </div>
  );
}
