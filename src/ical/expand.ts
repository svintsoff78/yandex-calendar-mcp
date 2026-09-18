import ICAL from "ical.js";
import { formatTime, parseEvent } from "./parse.js";
import { registerTimeZone } from "./timezones.js";
import type { CalendarEvent } from "../types.js";

// Два разных предела с разным назначением — их нельзя схлопывать в один
// счётчик (правка по ревью задачи 8, Important).
//
// MAX_OCCURRENCES — потолок числа ВОЗВРАЩАЕННЫХ экземпляров. Защищает
// вызывающий код от неоправданно большого результата (например, слишком
// широкое окно на мелкой серии), а не от зависания.
//
// MAX_ITERATIONS — потолок общего числа шагов курсора ical.js, включая те,
// что отброшены как лежащие до `from`. У серии, начавшейся задолго до окна
// (обычная старая еженедельная встреча без UNTIL/COUNT — рядовой случай),
// путь от DTSTART до `from` тоже проходит через курсор: это не лишняя
// работа, а единственный безопасный способ его продвинуть. Раньше здесь был
// один счётчик, и он совмещал обе роли: у серии с DTSTART сильно раньше окна
// весь бюджет уходил на прокрутку мимо прошлого, и до окна цикл не доходил —
// функция молча возвращала [] на событии, которое реально повторяется
// внутри окна (воспроизведено ревью: DAILY-серия с DTSTART=1990-01-01 и
// окном "сегодня плюс месяц" отдавала 0 экземпляров вместо ~30).
//
// Почему это не решается через `event.iterator(from - duration)` (сидирование
// курсора рядом с окном вместо прокрутки от DTSTART): я проверил это по
// исходникам ical.js (node_modules/ical.js/lib/ical/recur_iterator.js,
// метод init(), строки ~254–283) и воспроизвёл на INTERVAL=2 WEEKLY. Второй
// аргумент RecurExpansion/RecurIterator называется `dtstart` не для вида —
// `init()` берёт из него ЧАС/МИНУТУ/СЕКУНДУ и ФАЗУ интервала напрямую
// (`this.last = this.dtstart.clone()`, `setup_defaults(..., this.dtstart.day)`
// и т.д.), то есть трактует переданное время как настоящий DTSTART серии, а
// не как точку, откуда продолжить существующий паттерн. У Recur.iterator
// в исходниках так и написано открытым текстом: "The passed start date must
// be the start date of the event, not the start of the range to search in."
// Итог проверки: для WEEKLY;INTERVAL=2 сидирование произвольной датой сдвигает
// ФАЗУ интервала — получается другая серия с другими датами (не подмножество
// исходной, а вообще другой набор дней), а не тот же паттерн, начатый позже.
// Для MONTHLY/YEARLY без явных BYMONTHDAY/BYMONTH то же самое сломало бы
// день/месяц, унаследованные по умолчанию от DTSTART. Так что сидирование —
// это риск тихо ПОДМЕНИТЬ результат неверным (хуже, чем текущий баг с пустым
// результатом), а не просто медленнее. Поэтому курсор всегда стартует от
// истинного DTSTART (`event.iterator()` без аргумента), а защититься от
// прокрутки решает второй, отдельный и намного больший предел.
//
// MAX_ITERATIONS = 100000 — это ежедневная серия почти на 274 года и
// еженедельная почти на два тысячелетия. В замере (see check-perf.mts,
// в отчёте задачи 8) 200000 шагов простого перебора занимают ~1 секунду,
// то есть 100000 — это доля секунды в наихудшем (вырожденном) случае и
// доли миллисекунды на реалистичном сценарии из ревью (~13000 шагов на
// прокрутку с 1990 года).
const MAX_OCCURRENCES = 10000;
const MAX_ITERATIONS = 100000;

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

  for (let i = 0; i < MAX_ITERATIONS && occurrences.length < MAX_OCCURRENCES; i += 1) {
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
