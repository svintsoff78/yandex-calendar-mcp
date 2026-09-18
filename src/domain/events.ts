import { queryEventByUid, queryEvents } from "../caldav/objects.js";
import { expandOccurrences } from "../ical/expand.js";
import { parseEvent } from "../ical/parse.js";
import { resolveCalendarIn } from "./calendars.js";
import type { Calendar, CalendarEvent, Context } from "../types.js";

export interface ReadParams {
  from: string;
  to: string;
  calendarIds?: string[];
  query?: string;
  expandRecurring?: boolean;
}

export function matchesQuery(event: CalendarEvent, query?: string): boolean {
  if (!query) return true;
  const needle = query.toLowerCase();
  return [event.summary, event.description, event.location]
    .filter((value): value is string => Boolean(value))
    .some((value) => value.toLowerCase().includes(needle));
}

// Годится только для событий, которые создаём мы сами (задача 12): наш UID
// не содержит "@", поэтому encodeURIComponent даёт путь, совпадающий с тем,
// что кладёт на диск сервер Яндекса. Для чтения ЧУЖОГО события (заведённого
// в вебе или на телефоне) эта функция непригодна — см. предупреждение у
// readEvent ниже и docs/yandex-caldav-capabilities.md.
export function hrefFor(calendar: Calendar, eventId: string): string {
  return `${calendar.href.replace(/\/?$/, "/")}${encodeURIComponent(eventId)}.ics`;
}

type QueryFn = (calendar: Calendar, from: Date, to: Date) => Promise<
  Array<{ href: string; etag: string; ics: string }>
>;

function queryFor(context: Context): QueryFn {
  const injected = (context as unknown as { query?: QueryFn }).query;
  if (injected) return injected;
  return (calendar, from, to) => queryEvents(context.client, calendar.href, from, to);
}

export async function readEvents(context: Context, params: ReadParams): Promise<CalendarEvent[]> {
  const from = new Date(params.from);
  const to = new Date(params.to);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new Error("Параметры from и to должны быть датами в формате ISO 8601.");
  }
  if (from >= to) throw new Error("Начало окна должно быть раньше конца.");

  const all = await context.calendars();
  const selected = params.calendarIds?.length
    ? params.calendarIds.map((id) => resolveCalendarIn(all, id))
    : all;

  const expand = params.expandRecurring !== false;
  const query = queryFor(context);
  const collected: CalendarEvent[] = [];

  // Календари опрашиваются последовательно, в цикле: если их станет много
  // (например десять), время сложится из времени всех REPORT-запросов, а не
  // одного самого медленного. Для типичного личного аккаунта (единицы
  // календарей) это неощутимо; при явном требовании параллельности —
  // см. отчёт задачи, это осознанный компромисс, а не недосмотр.
  for (const calendar of selected) {
    const objects = await query(calendar, from, to);
    for (const object of objects) {
      const events = expand
        ? expandOccurrences(object.ics, calendar.id, from, to, object.etag)
        : [parseEvent(object.ics, calendar.id, object.etag)];
      for (const event of events) {
        if (matchesQuery(event, params.query)) collected.push({ ...event, href: object.href });
      }
    }
  }

  return collected.sort(
    (left, right) => new Date(left.start).getTime() - new Date(right.start).getTime(),
  );
}

export async function readEvent(
  context: Context,
  calendarId: string,
  eventId: string,
): Promise<CalendarEvent> {
  const calendar = await context.resolveCalendar(calendarId);

  // ОБЯЗАТЕЛЬНОЕ ОТСТУПЛЕНИЕ ОТ БРИФА: путь к объекту нельзя построить из
  // UID (hrefFor) — сервер Яндекса не выводит имя файла из UID
  // (docs/yandex-caldav-capabilities.md, задача 1): UID вида
  // "aaaabbbbccccdddd11@yandex.ru" хранится как объект
  // "aaaabbbbccccdddd11yandex.ru.ics" — собака выброшена, а не
  // закодирована. Это верно для ЛЮБОГО события, заведённого не нами
  // (веб-интерфейс, телефон), то есть почти для всех событий в реальном
  // аккаунте. Поэтому ищем объект REPORT'ом calendar-query по UID
  // (queryEventByUid, задача 9) и берём href и etag из ответа сервера.
  const object = await queryEventByUid(context.client, calendar.href, eventId);
  if (!object) {
    throw new Error(
      `Событие с идентификатором «${eventId}» не найдено в календаре «${calendar.displayName}».`,
    );
  }

  const event = parseEvent(object.ics, calendar.id, object.etag);
  return { ...event, href: object.href };
}
