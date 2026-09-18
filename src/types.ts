import type { CaldavClient } from "./caldav/request.js";
import type { Config } from "./config.js";

export interface Calendar {
  id: string;
  href: string;
  displayName: string;
  color?: string;
  timeZone?: string;
  readOnly: boolean;
}

export type RecurrenceFrequency = "daily" | "weekly" | "monthly" | "yearly";

export interface Recurrence {
  frequency: RecurrenceFrequency;
  interval: number;
  byWeekday?: Array<"MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU">;
  until?: string;
  count?: number;
}

export interface Reminder {
  minutesBefore: number;
  method: "display" | "email";
}

export interface Attendee {
  email: string;
  status: "accepted" | "declined" | "tentative" | "needs-action";
}

export interface CalendarEvent {
  id: string;
  calendarId: string;
  summary: string;
  description?: string;
  location?: string;
  start: string;
  end: string;
  timeZone: string;
  allDay: boolean;
  recurrence?: Recurrence;
  reminders: Reminder[];
  attendees: Attendee[];
  etag?: string;
  href?: string;
  instanceStart?: string;
  seriesId?: string;
}

export interface Context {
  client: CaldavClient;
  config: Config;
  discover(): Promise<Calendar[]>;
  calendars(): Promise<Calendar[]>;
  resolveCalendar(idOrName?: string): Promise<Calendar>;
}

export type EditScope = "this" | "this_and_following" | "all_series";
