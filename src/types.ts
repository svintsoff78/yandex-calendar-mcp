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

type Weekday = "MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU";

export interface Recurrence {
  frequency: RecurrenceFrequency;
  interval: number;
  /**
   * Дни недели BYDAY (RFC 5545 §3.3.10). Помимо дня без префикса ("MO")
   * значение может нести порядковый префикс: "2MO" — второй понедельник
   * месяца, "-1FR" — последняя пятница месяца. Префикс — часть значения
   * BYDAY, а не мусор: срезать его при разборе значит молча превратить
   * "второй понедельник" в "каждый понедельник". Парсер и сборщик правила
   * сохраняют строку как есть.
   */
  byWeekday?: Array<Weekday | `${number}${Weekday}`>;
  until?: string;
  count?: number;
}

export interface Reminder {
  /**
   * Отступ напоминания от начала события в минутах.
   * Положительное значение — раньше начала (обычный случай: TRIGGER:-PT15M
   * даёт 15). Отрицательное — позже начала (TRIGGER:PT15M без минуса —
   * валидный по RFC 5545 триггер "после", даёт -15). Имя поля сохранено
   * ради совместимости, но ноль — не единственная граница: смысл несёт знак.
   */
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
