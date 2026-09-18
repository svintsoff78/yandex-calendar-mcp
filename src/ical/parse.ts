import ICAL from "ical.js";
import type {
  Attendee,
  CalendarEvent,
  Recurrence,
  RecurrenceFrequency,
  Reminder,
} from "../types.js";
import { registerTimeZone } from "./timezones.js";

const FREQUENCIES: Record<string, RecurrenceFrequency> = {
  DAILY: "daily",
  WEEKLY: "weekly",
  MONTHLY: "monthly",
  YEARLY: "yearly",
};

function offsetString(time: ICAL.Time): string {
  const seconds = time.utcOffset();
  const sign = seconds < 0 ? "-" : "+";
  const abs = Math.abs(seconds);
  const hh = String(Math.floor(abs / 3600)).padStart(2, "0");
  const mm = String(Math.floor((abs % 3600) / 60)).padStart(2, "0");
  return `${sign}${hh}:${mm}`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

// Используется задачей 8 при раскрытии повторов.
export function formatTime(time: ICAL.Time): string {
  const date = `${time.year}-${pad(time.month)}-${pad(time.day)}`;
  if (time.isDate) return `${date}T00:00:00${offsetString(time)}`;
  const clock = `${pad(time.hour)}:${pad(time.minute)}:${pad(time.second)}`;
  return `${date}T${clock}${offsetString(time)}`;
}

export function parseRecurrence(vevent: ICAL.Component): Recurrence | undefined {
  const rule = vevent.getFirstPropertyValue("rrule") as ICAL.Recur | null;
  if (!rule) return undefined;

  const frequency = FREQUENCIES[String(rule.freq)];
  if (!frequency) return undefined;

  const byday = rule.getComponent("BYDAY") as string[] | undefined;
  const recurrence: Recurrence = { frequency, interval: rule.interval || 1 };
  if (byday && byday.length > 0) {
    recurrence.byWeekday = byday.map((day) => day.replace(/^[-+]?\d+/, "")) as Recurrence["byWeekday"];
  }
  if (rule.count) recurrence.count = rule.count;
  if (rule.until) recurrence.until = formatTime(rule.until);
  return recurrence;
}

function parseReminders(vevent: ICAL.Component): Reminder[] {
  return vevent.getAllSubcomponents("valarm").map((alarm) => {
    const trigger = alarm.getFirstPropertyValue("trigger") as ICAL.Duration | null;
    const action = String(alarm.getFirstPropertyValue("action") ?? "DISPLAY").toLowerCase();
    const seconds = trigger ? Math.abs(trigger.toSeconds()) : 0;
    return {
      minutesBefore: Math.round(seconds / 60),
      method: action === "email" ? "email" : "display",
    };
  });
}

function parseAttendees(vevent: ICAL.Component): Attendee[] {
  return vevent.getAllProperties("attendee").map((property) => {
    const value = String(property.getFirstValue() ?? "").replace(/^mailto:/i, "");
    const partstat = String(property.getParameter("partstat") ?? "NEEDS-ACTION").toLowerCase();
    const status =
      partstat === "accepted" || partstat === "declined" || partstat === "tentative"
        ? partstat
        : "needs-action";
    return { email: value, status } as Attendee;
  });
}

// Регистрирует TZID из DTSTART/DTEND в ICAL.TimezoneService, если он там ещё
// не известен. Без этого ical.js трактует незнакомый пояс как UTC и
// смещение в выводе окажется нулевым.
function ensureTimeZoneKnown(vevent: ICAL.Component): void {
  for (const name of ["dtstart", "dtend"]) {
    const property = vevent.getFirstProperty(name);
    const tzid = property?.getParameter("tzid") as string | undefined;
    if (tzid) registerTimeZone(tzid);
  }
}

export function parseEvent(ics: string, calendarId: string, etag?: string): CalendarEvent {
  const root = new ICAL.Component(ICAL.parse(ics));
  const vevent = root.getFirstSubcomponent("vevent");
  if (!vevent) throw new Error("В календарной записи нет компонента VEVENT.");

  ensureTimeZoneKnown(vevent);

  const event = new ICAL.Event(vevent);
  const start = event.startDate;
  const end = event.endDate;

  return {
    id: event.uid,
    calendarId,
    summary: event.summary ?? "",
    description: event.description || undefined,
    location: event.location || undefined,
    start: formatTime(start),
    end: formatTime(end),
    timeZone: start.zone?.tzid ?? "UTC",
    allDay: start.isDate,
    recurrence: parseRecurrence(vevent),
    reminders: parseReminders(vevent),
    attendees: parseAttendees(vevent),
    etag,
  };
}
