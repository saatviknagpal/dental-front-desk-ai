// Practices (tenants) and their static facts: single source of truth for the
// system prompt, the tools, and the UI. The current practice for a request is
// carried in AsyncLocalStorage, so code deep in the call stack (prompt, clock,
// queries) uses the right practice without passing it through every function.

import { AsyncLocalStorage } from "node:async_hooks";

export interface Practice {
  id: number;
  slug: string;
  name: string;
  assistantName: string;
  address: string;
  phone: string;
  hoursText: string;
  parking: string;
  timezone: string;
}

// shortcut: practices are defined in code; move them to a `practices` table with an admin UI to onboard practices without a deploy.
export const PRACTICES: Practice[] = [
  {
    id: 1,
    slug: "bright-smile",
    name: "Bright Smile Dental",
    assistantName: "Ava",
    address: "450 Market Street, Suite 200, San Francisco, CA 94111",
    phone: "(415) 555-0142",
    hoursText: "Monday to Saturday, 8:00 AM to 6:00 PM. Closed Sundays.",
    parking: "Validated parking in the building garage (enter on Battery St). Two blocks from Montgomery BART.",
    timezone: "America/Los_Angeles",
  },
  {
    id: 2,
    slug: "harbor-family",
    name: "Harbor Family Dental",
    assistantName: "Nora",
    address: "88 Atlantic Avenue, Suite 3, Boston, MA 02110",
    phone: "(617) 555-0190",
    hoursText: "Monday to Saturday, 8:00 AM to 6:00 PM (Eastern). Closed Sundays.",
    parking: "Metered street parking on Atlantic Ave. Two blocks from Aquarium station (Blue Line).",
    timezone: "America/New_York",
  },
];

const current = new AsyncLocalStorage<Practice>();

export const withPractice = <T>(p: Practice, fn: () => T): T => current.run(p, fn);
export const currentPractice = (): Practice => current.getStore() ?? PRACTICES[0];
export const practiceBySlug = (slug: unknown): Practice | undefined => PRACTICES.find((p) => p.slug === slug);

// shortcut: every practice shares this Mon-Sat 8-6 schedule; move these into Practice when one needs different hours.
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
- Membership plan: $29/month or $299/year. Covers 2 cleanings, 2 exams and routine X-rays per year, plus 15% off other treatment. No waiting period.
- Financing: CareCredit and Sunbit for larger treatment, with 0% plans for qualifying patients.`;
