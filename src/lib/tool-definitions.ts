// JSON-schema tool definitions shown to the model.

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

const str = (description: string) => ({ type: "string", description });
const int = (description: string) => ({ type: "integer", description });
const TYPE_ENUM = { type: "string", enum: ["cleaning", "checkup", "emergency"] };
const SEARCH_PROPS = {
  date_from: str("First day to search, YYYY-MM-DD (use the calendar in the system prompt to resolve phrases like 'later next week')."),
  date_to: str("Last day to search, YYYY-MM-DD (inclusive)."),
  time_of_day: { type: "string", enum: ["morning", "afternoon", "late_afternoon", "any"], description: "morning = before 12, afternoon = 12-5pm, late_afternoon = 3pm or later." },
  after_time: str("Optional earliest start, HH:MM 24h (e.g. '15:30' for 'after 3:30')."),
  before_time: str("Optional: appointment must start before HH:MM 24h."),
  days_of_week: { type: "array", items: { type: "string", enum: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] }, description: "Optional: only these weekdays." },
};

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "verify_patient",
    description: "Look up an EXISTING patient by full name + date of birth. Required before viewing, rescheduling or cancelling appointments. Also returns their household members and upcoming appointments.",
    parameters: {
      type: "object",
      properties: { full_name: str("First and last name"), date_of_birth: str("YYYY-MM-DD"), phone: str("Optional, only if asked to disambiguate") },
      required: ["full_name", "date_of_birth"],
    },
  },
  {
    name: "register_patient",
    description: "Create a NEW patient record. Collect first name, last name, date of birth, phone, and insurance name (or none). For a child or spouse of a verified patient pass same_household_as_patient_id (phone then defaults to theirs).",
    parameters: {
      type: "object",
      properties: {
        first_name: str("First name"),
        last_name: str("Last name"),
        date_of_birth: str("YYYY-MM-DD"),
        phone: str("10-digit US phone"),
        insurance_name: str("Insurance company name, or 'none' if self-pay"),
        same_household_as_patient_id: int("Optional: link to a verified patient's household (family bookings)"),
      },
      required: ["first_name", "last_name", "date_of_birth"],
    },
  },
  {
    name: "list_appointments",
    description: "List a verified patient's upcoming appointments (with appointment_id needed for reschedule/cancel).",
    parameters: { type: "object", properties: { patient_id: int("Verified patient id") }, required: ["patient_id"] },
  },
  {
    name: "find_available_slots",
    description: "Search REAL open appointment times. Always call this before offering times; never invent times. Returns start_time + provider_id to pass to booking tools. If nothing matches, returns next_available alternatives.",
    parameters: {
      type: "object",
      properties: {
        appointment_type: TYPE_ENUM,
        ...SEARCH_PROPS,
        provider_id: int("Optional: only this provider"),
        limit: int("Max results, default 5"),
      },
      required: ["appointment_type", "date_from", "date_to"],
    },
  },
  {
    name: "book_appointment",
    description: "Book ONE appointment after the patient explicitly confirmed the exact time. For emergencies include emergency_summary; staff are notified automatically.",
    parameters: {
      type: "object",
      properties: {
        patient_id: int("Verified or newly registered patient id"),
        appointment_type: TYPE_ENUM,
        start_time: str("Exactly as returned by find_available_slots: 'YYYY-MM-DD HH:MM'"),
        provider_id: int("provider_id returned with that slot"),
        emergency_summary: str("Required for emergency: symptoms, onset, pain level, swelling/bleeding"),
        notes: str("Optional notes for the office (e.g. anxious patient, prefers Dr. Patel)"),
        confirm_additional: { type: "boolean", description: "Only true if the patient explicitly wants an additional appointment of a type they already have booked" },
      },
      required: ["patient_id", "appointment_type", "start_time", "provider_id"],
    },
  },
  {
    name: "reschedule_appointment",
    description: "Move an existing appointment to a new time (after the patient confirmed the new time). Atomic: if the new time is gone, the original stays.",
    parameters: {
      type: "object",
      properties: {
        patient_id: int("Verified patient id"),
        appointment_id: int("From verify_patient / list_appointments"),
        new_start_time: str("From find_available_slots: 'YYYY-MM-DD HH:MM'"),
        provider_id: int("provider_id returned with that slot"),
      },
      required: ["patient_id", "appointment_id", "new_start_time", "provider_id"],
    },
  },
  {
    name: "cancel_appointment",
    description: "Cancel an existing appointment after the patient confirmed. Offer to reschedule first.",
    parameters: {
      type: "object",
      properties: { patient_id: int("Verified patient id"), appointment_id: int("Appointment id"), reason: str("Optional reason") },
      required: ["patient_id", "appointment_id"],
    },
  },
  {
    name: "find_family_slots",
    description: "Find coordinated times for 2-6 family members (back-to-back by default, or same_time with different providers). Each member must be verified, registered, or a household member.",
    parameters: {
      type: "object",
      properties: {
        members: {
          type: "array",
          items: { type: "object", properties: { patient_id: { type: "integer" }, appointment_type: TYPE_ENUM }, required: ["patient_id", "appointment_type"] },
          description: "In the order they should be seen",
        },
        arrangement: { type: "string", enum: ["back_to_back", "same_time"] },
        ...SEARCH_PROPS,
        limit: int("Max options, default 3"),
      },
      required: ["members", "date_from", "date_to"],
    },
  },
  {
    name: "book_family_appointments",
    description: "Book several appointments at once, all-or-nothing (use an option from find_family_slots after the patient confirmed).",
    parameters: {
      type: "object",
      properties: {
        bookings: {
          type: "array",
          items: {
            type: "object",
            properties: { patient_id: { type: "integer" }, appointment_type: TYPE_ENUM, start_time: { type: "string" }, provider_id: { type: "integer" } },
            required: ["patient_id", "appointment_type", "start_time", "provider_id"],
          },
        },
      },
      required: ["bookings"],
    },
  },
  {
    name: "notify_staff",
    description: "Alert the front desk. Use for: urgent issues with no bookable emergency slot, a patient asking for a human, complaints/billing disputes, questions you can't answer, or callback requests.",
    parameters: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["emergency", "human_handoff", "callback"] },
        urgency: { type: "string", enum: ["high", "normal"] },
        summary: str("What staff need to know, 1-3 sentences"),
        patient_id: int("Optional verified patient id"),
        callback_phone: str("Optional phone to call back"),
      },
      required: ["type", "urgency", "summary"],
    },
  },
];

