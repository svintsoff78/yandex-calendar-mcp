import { readEvents } from "./events.js";
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
  const day = new Date(from);
  day.setHours(0, 0, 0, 0);

  while (day < to) {
    if (weekdays.includes(day.getDay())) {
      const windowStart = new Date(day);
      windowStart.setHours(open.hour, open.minute, 0, 0);
      const windowEnd = new Date(day);
      windowEnd.setHours(close.hour, close.minute, 0, 0);

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
    day.setDate(day.getDate() + 1);
  }

  return slots;
}

// Рабочие часы считаются в местном поясе процесса. Для личного использования
// на одной машине этого достаточно; если понадобится считать в поясе
// календаря, это отдельная задача (см. отчёт задачи 15 — там же зафиксирован
// факт зависимости результата от TZ процесса на трёх контрольных прогонах).
