// Confirmation card shown after a booking, with "add to calendar" options.

import { googleCalendarUrl, icsFile, type Booking, type PracticeInfo } from "@/lib/calendar";
import Icon from "./Icon";

export type { Booking };

export default function BookingCard({ booking, practice }: { booking: Booking; practice: PracticeInfo }) {
  return (
    <div className="mt-3 overflow-hidden rounded-xl border border-border bg-surface text-sm" role="group" aria-label="Appointment confirmation">
      <div className="flex items-center gap-2 border-b border-border bg-success-soft px-4 py-2.5 font-bold text-success">
        <Icon name="checkCircle" className="size-4.5" />
        {booking.previous_time ? "Moved" : "Booked"}: {booking.label}
      </div>
      <dl className="space-y-2 px-4 py-3">
        <div className="flex gap-2.5">
          <dt className="sr-only">When</dt>
          <Icon name="calendar" className="mt-0.5 size-4 text-muted" />
          <dd className="font-bold">
            {booking.display} · {booking.duration_minutes} min
            {booking.previous_time && <span className="block text-xs font-normal text-muted">Was {booking.previous_time}</span>}
          </dd>
        </div>
        <div className="flex gap-2.5">
          <dt className="sr-only">Who</dt>
          <Icon name="user" className="mt-0.5 size-4 text-muted" />
          <dd>
            {booking.patient_name} with {booking.provider_name}
          </dd>
        </div>
        <div className="flex gap-2.5">
          <dt className="sr-only">Where</dt>
          <Icon name="mapPin" className="mt-0.5 size-4 text-muted" />
          <dd className="text-muted">
            {practice.name}, {practice.address}
          </dd>
        </div>
      </dl>
      <div className="flex flex-wrap gap-2 px-4 pb-4">
        <a
          href={`data:text/calendar;charset=utf-8,${encodeURIComponent(icsFile(booking, practice))}`}
          download={`appointment-${booking.start_time.slice(0, 10)}.ics`}
          className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-brand px-3 font-bold text-on-brand hover:bg-brand-strong"
        >
          <Icon name="download" className="size-4" />
          Add to calendar
        </a>
        <a
          href={googleCalendarUrl(booking, practice)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-border px-3 font-bold text-brand-strong hover:bg-surface-2"
        >
          <Icon name="external" className="size-4" />
          Google Calendar
        </a>
      </div>
    </div>
  );
}
