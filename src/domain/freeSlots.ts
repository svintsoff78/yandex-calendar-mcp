import ICAL from "ical.js";
import { readEvents } from "./events.js";
import { registerTimeZone } from "../ical/timezones.js";
import type { Context } from "../types.js";

export interface Interval {
  start: Date;
  end: Date;
}

export interface FreeSlotParams {
  from: string;
  to: string;
  durationMinutes: number;
  workingHours?: { start: string; end: string };
  weekdays?: number[];
  calendarIds?: string[];
}

export function subtractBusy(window: Interval, busy: Interval[]): Interval[] {
  const relevant = busy
    .filter((item) => item.end > window.start && item.start < window.end)
    .sort((left, right) => left.start.getTime() - right.start.getTime());

  const free: Interval[] = [];
  let cursor = window.start;

  for (const item of relevant) {
    if (item.start > cursor) free.push({ start: cursor, end: item.start });
    if (item.end > cursor) cursor = item.end;
  }
  if (cursor < window.end) free.push({ start: cursor, end: window.end });

  return free.filter((slot) => slot.end > slot.start);
}

function parseClock(value: string): { hour: number; minute: number } {
  const [hour, minute] = value.split(":").map(Number);
  if (Number.isNaN(hour) || Number.isNaN(minute)) {
    throw new Error(`Время «${value}» должно быть в формате ЧЧ:ММ, например 10:00.`);
  }
  return { hour, minute };
}

interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

// Момент времени (абсолютный instant) по стенным часам ЧЧ:ММ заданной даты в
// указанном поясе. В отличие от Date#setHours, результат НЕ зависит от
// пояса процесса: ICAL.Time с зарегистрированной именованной зоной (не
// Timezone.localTimezone) считает instant через её собственный utcOffset()
// (node_modules/ical.js/lib/ical/time.js, toUnixTime/toJSDate) — тот же
// принцип, что уже применён в src/ical/build.ts (toIcalTime) и
// src/domain/events.ts (icalTimeOf) для той же категории бага.
function zonedInstant(date: CalendarDate, hour: number, minute: number, zone: ICAL.Timezone): Date {
  return ICAL.Time.fromData({ ...date, hour, minute, second: 0 }, zone).toJSDate();
}

// Календарная дата (год/месяц/день) заданного момента в указанном поясе.
// fromJSDate(instant, true) — тот же приём useUTC=true, что и в toIcalTime:
// JS Date уже содержит верный момент времени, поэтому геттеры UTC дают его
// без искажения, а настоящий пересчёт в нужный пояс делает convertToZone.
function zonedDateOf(instant: Date, zone: ICAL.Timezone): CalendarDate {
  const time = ICAL.Time.fromJSDate(instant, true).convertToZone(zone);
  return { year: time.year, month: time.month, day: time.day };
}

// День недели (0 — воскресенье, как и FreeSlotParams.weekdays) по календарной
// дате. Это чистая календарная арифметика (через Date.UTC), не зависящая ни
// от времени суток, ни от часового пояса процесса: воскресенье остаётся
// воскресеньем независимо от того, где физически выполняется код.
function weekdayOf(date: CalendarDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

// Следующая календарная дата — тоже чистая арифметика без ICAL.Time и без
// участия часового пояса: "плюс один день" в календаре всегда одно и то же,
// даже если из-за перевода стрелок реальная продолжительность суток в
// конкретном поясе не равна 24 часам.
function nextDate(date: CalendarDate): CalendarDate {
  const next = new Date(Date.UTC(date.year, date.month - 1, date.day + 1));
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
}

export async function findFreeSlots(
  context: Context,
  params: FreeSlotParams,
): Promise<Array<{ start: string; end: string }>> {
  if (params.durationMinutes <= 0) {
    throw new Error("durationMinutes должно быть положительным числом минут.");
  }

  const events = await readEvents(context, {
    from: params.from,
    to: params.to,
    calendarIds: params.calendarIds,
  });
  const busy: Interval[] = events.map((event) => ({
    start: new Date(event.start),
    end: new Date(event.end),
  }));

  const hours = params.workingHours ?? { start: "10:00", end: "19:00" };
  const open = parseClock(hours.start);
  const close = parseClock(hours.end);
  const weekdays = params.weekdays ?? [1, 2, 3, 4, 5];

  const from = new Date(params.from);
  const to = new Date(params.to);
  const slots: Array<{ start: string; end: string }> = [];

  // Правка по указанию контроллера (см. отчёт задачи 15, раздел «Правка по
  // указанию контроллера»): границы рабочего дня и день недели считаются в
  // ПОЯСЕ КАЛЕНДАРЯ (context.config.defaultTimeZone), а не в поясе процесса.
  // Раньше здесь стоял голый Date#setHours/getDay() — тот же класс бага, что
  // уже дважды находили и чинили в этом проекте для DTSTAMP и RECURRENCE-ID
  // (src/ical/build.ts, src/domain/events.ts): на машине, где локальный
  // пояс случайно совпадает с поясом календаря, всё работало, а на сервере
  // с другим TZ (например, UTC в типичном Docker-образе) день недели
  // мог определиться неверно и рабочий день — пропасть целиком либо
  // сдвинуться на несколько часов. Приём тот же, что и там: ICAL.Time с
  // именованной (не localTimezone) зоной, зарегистрированной через
  // registerTimeZone.
  const zone = registerTimeZone(context.config.defaultTimeZone);
  let date = zonedDateOf(from, zone);

  while (zonedInstant(date, 0, 0, zone) < to) {
    if (weekdays.includes(weekdayOf(date))) {
      const windowStart = zonedInstant(date, open.hour, open.minute, zone);
      const windowEnd = zonedInstant(date, close.hour, close.minute, zone);

      const bounded: Interval = {
        start: windowStart < from ? from : windowStart,
        end: windowEnd > to ? to : windowEnd,
      };

      if (bounded.end > bounded.start) {
        for (const slot of subtractBusy(bounded, busy)) {
          const minutes = (slot.end.getTime() - slot.start.getTime()) / 60000;
          if (minutes >= params.durationMinutes) {
            slots.push({ start: slot.start.toISOString(), end: slot.end.toISOString() });
          }
        }
      }
    }
    date = nextDate(date);
  }

  return slots;
}
