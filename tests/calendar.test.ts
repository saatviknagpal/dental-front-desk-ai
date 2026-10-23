import { describe, expect, it } from "vitest";
import { googleCalendarUrl, icsFile } from "@/components/BookingCard";

const booking = {
  appointment_id: 7,
  patient_name: "Ana Lopez",
  label: "Cleaning",
  start_time: "2026-10-31 23:30",
  display: "Sat, Oct 31 at 11:30 PM",
  provider_name: "Kim Nguyen",
  duration_minutes: 60,
};
const practice = { slug: "harbor-family", name: "Harbor Family Dental", address: "88 Atlantic Avenue, Suite 3, Boston, MA 02110", phone: "(617) 555-0190", timezone: "America/New_York" };

describe("calendar export", () => {
  it("writes local start/end in the practice's timezone, rolling past midnight", () => {
    const ics = icsFile(booking, practice);
    expect(ics).toContain("DTSTART;TZID=America/New_York:20261031T233000");
    expect(ics).toContain("DTEND;TZID=America/New_York:20261101T003000");
    expect(ics).toContain("LOCATION:88 Atlantic Avenue\\, Suite 3\\, Boston\\, MA 02110");
  });

  it("builds a Google Calendar link with the same times and timezone", () => {
    const url = new URL(googleCalendarUrl(booking, practice));
    expect(url.searchParams.get("dates")).toBe("20261031T233000/20261101T003000");
    expect(url.searchParams.get("ctz")).toBe("America/New_York");
  });
});
