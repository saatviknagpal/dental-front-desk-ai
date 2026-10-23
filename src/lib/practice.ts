// Static facts about the (fictional) practice. Single source of truth for the
// system prompt, the tools, and the UI.

export const PRACTICE = {
  name: "Bright Smile Dental",
  assistantName: "Ava",
  address: "450 Market Street, Suite 200, San Francisco, CA 94111",
  phone: "(415) 555-0142",
  hoursText: "Monday to Saturday, 8:00 AM to 6:00 PM. Closed Sundays.",
  parking: "Validated parking in the building garage (enter on Battery St). Two blocks from Montgomery BART.",
};

export const OPEN_WEEKDAYS = new Set([1, 2, 3, 4, 5, 6]); // Mon..Sat (0 = Sunday)
export const OPEN_HOUR = 8;
export const CLOSE_HOUR = 18;
export const SLOT_MINUTES = 30;
export const BOOKING_HORIZON_DAYS = 56;

export type AppointmentType = "cleaning" | "checkup" | "emergency";

export const APPOINTMENT_TYPES: Record<AppointmentType, { minutes: number; label: string }> = {
  cleaning: { minutes: 60, label: "Cleaning" },
  checkup: { minutes: 30, label: "General checkup" },
  emergency: { minutes: 30, label: "Emergency visit" },
};

export const INSURANCE_TEXT = `We accept all major dental insurance plans (for example Delta Dental, Cigna, Aetna, MetLife, Guardian, United Healthcare, Humana, BlueCross BlueShield). The front desk verifies benefits before the visit.
No insurance? Three options:
- Self-pay: cleaning $120, general checkup/exam $95, emergency exam $150 (X-rays included with exams). Paid at the visit.
- Bright Smile Membership: $29/month or $299/year. Covers 2 cleanings, 2 exams and routine X-rays per year, plus 15% off other treatment. No waiting period.
- Financing: CareCredit and Sunbit for larger treatment, with 0% plans for qualifying patients.`;
