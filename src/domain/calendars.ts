import type { Calendar } from "../types.js";

export interface CalendarSource {
  discover(): Promise<Calendar[]>;
}

const cache = new WeakMap<object, Calendar[]>();

export async function listCalendars(source: CalendarSource): Promise<Calendar[]> {
  const cached = cache.get(source as object);
  if (cached) return cached;
  const calendars = await source.discover();
  cache.set(source as object, calendars);
  return calendars;
}

export function resolveCalendarIn(calendars: Calendar[], idOrName?: string): Calendar {
  if (calendars.length === 0) throw new Error("В аккаунте не нашлось ни одного календаря.");
  if (!idOrName) return calendars[0];

  const found = calendars.find(
    (calendar) =>
      calendar.id === idOrName ||
      calendar.displayName.toLowerCase() === idOrName.toLowerCase(),
  );
  if (found) return found;

  const available = calendars.map((calendar) => `${calendar.id} (${calendar.displayName})`).join(", ");
  throw new Error(`Календарь «${idOrName}» не найден. Доступные: ${available}.`);
}
