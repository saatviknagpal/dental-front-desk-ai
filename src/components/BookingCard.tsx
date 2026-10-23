// Confirmation card shown after a booking, with "add to calendar" options.

import { googleCalendarUrl, icsFile, type Booking, type PracticeInfo } from "@/lib/calendar";

export type { Booking };

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
