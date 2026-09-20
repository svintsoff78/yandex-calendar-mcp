import ICAL from "ical.js";
import { readEvents } from "./events.js";
import { unreadableReason } from "../ical/expand.js";
import { instantOf, ModelTimeError, parseModelTime, wallDateOf, type IcalEnv } from "../ical/values.js";
import type { CalendarEvent, Context } from "../types.js";

/**
 * Поиск свободных окон (З09 плана переделки,
 * docs/superpowers/plans/2026-09-19-recurring-events-rework.md).
 *
 * Занятость — встречи из readEvents, то есть из той же выдачи, что у
 * list_events (src/ical/expand.ts): скрытые переопределения (после конца
 * серии, под EXDATE) там не появляются. Время не занимают и отменённые
 * встречи — STATUS:CANCELLED у переопределения или у события (Р7). Если
 * встречи какого-то объекта не прочитаны (неразбираемый текст, правило,
 * которое не перебрать, — expand.ts, unreadableReason), поиск отказывает и
 * называет UID (Р4): считать неизвестное время свободным нельзя.
 *
 * Рабочие часы, день недели и границы поиска без смещения — стенное время
 * пояса календаря из настроек (`config.defaultTimeZone`), а не пояса
 * процесса. Моменты — через values.ts (parseModelTime, instantOf,
 * wallDateOf); Date здесь только держит миллисекунды.
 */

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

/**
 * Отказ поиска: "unreadable" — встречи событий `events` не прочитаны, и
 * свободное время посчитать нельзя. В `events` — UID, календарь и причина.
 */
export class FreeSlotsError extends Error {
  readonly code = "unreadable";
  readonly events: ReadonlyArray<{ id: string; calendarId: string; reason: string }>;

  constructor(message: string, events: ReadonlyArray<{ id: string; calendarId: string; reason: string }>) {
    super(message);
    this.name = "FreeSlotsError";
    this.events = events;
  }
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

export async function findFreeSlots(
  context: Context,
  params: FreeSlotParams,
): Promise<Array<{ start: string; end: string }>> {
  if (!(params.durationMinutes > 0)) {
    throw new Error("durationMinutes должно быть положительным числом минут.");
  }

  // Пояс календаря: в нём читаются стенное время и даты (values.ts, instantOf).
  const env: IcalEnv = { floatingZone: context.config.defaultTimeZone, ownerEmail: context.config.login };
  const fromMs = boundaryMs(params.from, "from", env);
  const toMs = boundaryMs(params.to, "to", env);
  const hours = params.workingHours ?? { start: "10:00", end: "19:00" };
  const open = parseClock(hours.start);
  const close = parseClock(hours.end);
  const weekdays = params.weekdays ?? [1, 2, 3, 4, 5];

  // Границы уходят в readEvents моментами в UTC: так их прочтение не зависит
  // от того, как readEvents разбирает строку без смещения.
  const events = await readEvents(context, {
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
    calendarIds: params.calendarIds,
  });
  refuseUnreadable(events);
  const busy: Interval[] = events
    .filter((event) => event.status !== "cancelled")
    .map((event) => ({ start: new Date(eventMs(event, event.start)), end: new Date(eventMs(event, event.end)) }));

  const slots: Array<{ start: string; end: string }> = [];
  let date = wallDateOf(utcTime(fromMs), env, env.floatingZone);
  while (wallMs(date, { hour: 0, minute: 0 }, env) < toMs) {
    if (weekdays.includes(weekdayOf(date))) {
      const windowStart = wallMs(date, open, env);
      const windowEnd = wallMs(date, close, env);
      const bounded: Interval = {
        start: new Date(Math.max(windowStart, fromMs)),
        end: new Date(Math.min(windowEnd, toMs)),
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

// ─────────────────────────────── внутреннее ───────────────────────────────

interface Clock {
  hour: number;
  minute: number;
}

// ЧЧ:ММ рабочего дня; 24:00 — конец суток.
function parseClock(value: string): Clock {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  const hour = match ? Number(match[1]) : NaN;
  const minute = match ? Number(match[2]) : NaN;
  if (!match || hour > 24 || minute > 59 || (hour === 24 && minute > 0)) {
    throw new Error(`Время «${value}» должно быть в формате ЧЧ:ММ, например 10:00.`);
  }
  return { hour, minute };
}

// Граница поиска: ISO со смещением или Z — момент; без смещения — стенное
// время пояса календаря; дата — полночь пояса календаря. parseModelTime без
// пояса даёт плавающее время или дату, instantOf читает их в поясе
// календаря `env.floatingZone` (values.ts).
function boundaryMs(value: string, name: "from" | "to", env: IcalEnv): number {
  try {
    const parsed = parseModelTime(value);
    return parsed.kind === "instant" ? parsed.ms : instantOf(parsed.time, env);
  } catch (error) {
    if (!(error instanceof ModelTimeError)) throw error;
    throw new Error(`Параметр ${name}: ${error.message}`, { cause: error });
  }
}

// Момент начала или конца встречи из выдачи: ISO со смещением (values.ts,
// formatForModel "time").
function eventMs(event: CalendarEvent, value: string): number {
  const parsed = parseModelTime(value);
  if (parsed.kind !== "instant") {
    throw new Error(`У события ${event.id} время ${value} без смещения: занятость не посчитать.`);
  }
  return parsed.ms;
}

// Отказ, если встречи какого-то события не прочитаны (Р4).
function refuseUnreadable(events: readonly CalendarEvent[]): void {
  const unreadable = new Map<string, { id: string; calendarId: string; reason: string }>();
  for (const event of events) {
    const reason = unreadableReason(event);
    const key = `${event.calendarId}\n${event.id}`;
    if (reason !== undefined && !unreadable.has(key)) unreadable.set(key, { id: event.id, calendarId: event.calendarId, reason });
  }
  if (unreadable.size === 0) return;
  const list = [...unreadable.values()];
  throw new FreeSlotsError(
    "Свободное время не посчитать: встречи событий не прочитаны — " +
      list.map((item) => `${item.id || "без UID"} (календарь ${item.calendarId}): ${item.reason}`).join("; ") +
      ". Такие события видны в list_events с этой аномалией; исключите их календарь (calendarIds) " +
      "или удалите событие целиком (delete_event со scope all_series).",
    list,
  );
}

// Момент `ms` как время UTC (values.ts, parseModelTime: ISO с Z).
function utcTime(ms: number): ICAL.Time {
  return parseModelTime(new Date(ms).toISOString()).time;
}

// Момент стенного времени `clock` даты `date` (YYYY-MM-DD) в поясе
// календаря; 24:00 — полночь следующей даты. Плавающее время instantOf
// читает в поясе календаря (values.ts).
function wallMs(date: string, clock: Clock, env: IcalEnv): number {
  if (clock.hour === 24) return wallMs(nextDate(date), { hour: 0, minute: 0 }, env);
  const hh = String(clock.hour).padStart(2, "0");
  const mm = String(clock.minute).padStart(2, "0");
  return instantOf(parseModelTime(`${date}T${hh}:${mm}:00`).time, env);
}

// Календарная дата как ICAL.Time DATE — пояса и времени суток у неё нет.
function dateOf(date: string): ICAL.Time {
  return parseModelTime(date).time;
}

// День недели, 0 — воскресенье (как FreeSlotParams.weekdays): time.js,
// dayOfWeek — по алгоритму Целлера от полей даты, 1 — воскресенье.
function weekdayOf(date: string): number {
  return dateOf(date).dayOfWeek() - 1;
}

// Следующая календарная дата: time.js, adjust — стенной сдвиг полей на сутки.
function nextDate(date: string): string {
  const next = dateOf(date);
  next.adjust(1, 0, 0, 0);
  return `${String(next.year).padStart(4, "0")}-${String(next.month).padStart(2, "0")}-${String(next.day).padStart(2, "0")}`;
}
