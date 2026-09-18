import ICAL from "ical.js";
import { formatTime, parseEvent } from "./parse.js";
import { registerTimeZone } from "./timezones.js";
import type { CalendarEvent } from "../types.js";

// Основное условие остановки — временное (`startDate >= to`): оно корректно
// прерывает раскрытие для любой серии, включая бесконечную (без COUNT/UNTIL),
// как только курсор проходит правый край окна. MAX_OCCURRENCES — это
// дополнительная защита на случай сбоя в самом RRULE или в итераторе ical.js
// (тогда курсор мог бы не продвигаться по времени вовсе). Значение взято с
// большим запасом, чтобы не срезать законные длинные серии на широких, но
// реалистичных окнах: 10000 — это ежедневное событие почти на 27 лет вперёд
// или еженедельное почти на два века. Самопроверка задачи 8: с прежним
// значением 1000 ежедневная серия на трёхлетнем окне обрывалась молча на
// 1000-м экземпляре, не дойдя до конца окна (см. тест ниже).
const MAX_OCCURRENCES = 10000;

/**
 * Раскрывает повторяющееся событие в отдельные экземпляры внутри окна
 * [from, to). Раскрытие всегда локальное: сервер Яндекса игнорирует
 * `<C:expand>` и возвращает исходный VEVENT с нетронутым RRULE (см.
 * docs/yandex-caldav-capabilities.md), поэтому единственный способ получить
 * отдельные экземпляры — развернуть RRULE самостоятельно средствами ical.js.
 *
 * Порядок операций важен и отличается от «естественного». VTIMEZONE у
 * Яндекса приходит вложенным прямо в calendar-data события — это единственное
 * описание нестандартного пояса, которое у нас есть. `parseEvent` внутри себя
 * зовёт `registerTimeZone(tzid)` БЕЗ второго аргумента (запасного ICS с
 * VTIMEZONE), а `registerTimeZone` бросает исключение, если пояса нет в базе
 * IANA. Поэтому сначала нужно пройти по всем вложенным VTIMEZONE и
 * зарегистрировать их через `registerTimeZone(tzid, vtimezoneIcs)`, и только
 * потом звать `parseEvent` — иначе разбор события с нестандартным TZID
 * упадёт раньше, чем запасной путь успеет сработать.
 */
export function expandOccurrences(
  ics: string,
  calendarId: string,
  from: Date,
  to: Date,
  etag?: string,
): CalendarEvent[] {
  const root = new ICAL.Component(ICAL.parse(ics));

  for (const vtimezone of root.getAllSubcomponents("vtimezone")) {
    const tzid = String(vtimezone.getFirstPropertyValue("tzid") ?? "");
    if (tzid) registerTimeZone(tzid, `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${vtimezone.toString()}\r\nEND:VCALENDAR`);
  }

  const base = parseEvent(ics, calendarId, etag);

  const vevent = root.getFirstSubcomponent("vevent");
  if (!vevent) return [];

  const event = new ICAL.Event(vevent);
  if (!event.isRecurring()) {
    const startsBefore = new Date(base.start) < to;
    const endsAfter = new Date(base.end) > from;
    return startsBefore && endsAfter ? [base] : [];
  }

  const durationSeconds = event.endDate.subtractDate(event.startDate).toSeconds();
  const iterator = event.iterator();
  const occurrences: CalendarEvent[] = [];

  for (let i = 0; i < MAX_OCCURRENCES; i += 1) {
    const next = iterator.next();
    if (!next) break;

    const startDate = next.toJSDate();
    if (startDate >= to) break;

    const endTime = next.clone();
    endTime.addDuration(ICAL.Duration.fromSeconds(durationSeconds));
    if (endTime.toJSDate() <= from) continue;

    occurrences.push({
      ...base,
      instanceStart: formatTime(next),
      start: formatTime(next),
      end: formatTime(endTime),
      seriesId: base.id,
    });
  }

  return occurrences;
}
