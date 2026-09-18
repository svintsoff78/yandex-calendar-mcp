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

// Оборачивает одиночный компонент (VEVENT или VTIMEZONE) в минимальный
// VCALENDAR, пригодный для ICAL.parse()/parseEvent(). Используется и для
// вложенных VTIMEZONE, и для того, чтобы прогнать через parseEvent основной
// компонент серии и каждое переопределение экземпляра по отдельности — не
// трогая parse.ts, но переиспользуя его разбор summary/description/location/
// reminders/attendees вместо повторной реализации этой логики здесь.
function wrapComponent(component: ICAL.Component): string {
  return `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${component.toString()}\r\nEND:VCALENDAR`;
}

// Строит выдаваемый экземпляр из переопределения: заголовок/описание/место/
// напоминания/участники берутся из переопределения (через parseEvent —
// переиспользуем его разбор, а не дублируем здесь), остальное — из базовой
// серии. `recurrenceIdTime` форматируется в instanceStart отдельным
// параметром: в основном цикле это позиция курсора (next), в дополнительном
// проходе — overrideEvent.recurrenceId; сам overrideEvent.startDate/endDate
// одинаковы в обоих случаях (getOccurrenceDetails берёт их оттуда же).
function buildOverrideOccurrence(
  base: CalendarEvent,
  overrideEvent: ICAL.Event,
  recurrenceIdTime: ICAL.Time,
  calendarId: string,
  etag: string | undefined,
): CalendarEvent {
  const overrideData = parseEvent(wrapComponent(overrideEvent.component), calendarId, etag);
  return {
    ...base,
    summary: overrideData.summary,
    description: overrideData.description,
    location: overrideData.location,
    reminders: overrideData.reminders,
    attendees: overrideData.attendees,
    instanceStart: formatTime(recurrenceIdTime),
    start: formatTime(overrideEvent.startDate),
    end: formatTime(overrideEvent.endDate),
    seriesId: base.id,
  };
}

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
 *
 * Переопределения экземпляров (правка задачи 8, Critical, найдено ревью
 * задачи 13). Правка одного экземпляра серии ("this", задача 13) добавляет
 * в тот же VCALENDAR второй VEVENT с тем же UID и свойством RECURRENCE-ID —
 * RFC 5545 §3.8.4.4. `RECURRENCE-ID` называет, какой экземпляр ОСНОВНОЙ
 * серии заменяется; собственный `DTSTART` переопределения — когда он теперь
 * фактически происходит (они могут отличаться — это и есть перенесённая
 * встреча). Сопоставление сделано через встроенный в ical.js механизм
 * исключений: конструктор `new ICAL.Event(master)` сам находит все
 * VEVENT-соседи с RECURRENCE-ID через `master.parent` и связывает их (см.
 * node_modules/ical.js/lib/ical/event.js, конструктор), а
 * `event.getOccurrenceDetails(next)` для каждой позиции курсора отдаёт
 * либо саму позицию (нет переопределения), либо startDate/endDate/summary и
 * т. д. переопределения — так что вручную парсить и сопоставлять
 * RECURRENCE-ID не нужно.
 *
 * `instanceStart` у переопределённого экземпляра остаётся равен ИСХОДНОМУ
 * RECURRENCE-ID (позиции в паттерне), а не новому DTSTART: по нему задачи 13
 * и 14 адресуют экземпляр при повторной правке/удалении (см.
 * src/domain/events.ts, `icalTimeOf(params.instanceStart, ...)` и
 * `updateEvent`, где возвращаемый объект явно хранит
 * `instanceStart: params.instanceStart` — тот же исходный слот, а не новое
 * время). Смещаются только видимые в выдаче title/description/location/
 * start/end/reminders/attendees.
 *
 * Основной цикл ниже прерывается, как только ОРИГИНАЛЬНАЯ (не смещённая)
 * позиция курсора достигает `to` — это остаётся верным независимо от
 * переопределений, потому что курсор всегда идёт по местам ОСНОВНОЙ серии.
 * Но переопределение может сдвигать экземпляр так далеко, что основной цикл
 * никогда не доходит до его исходной позиции (она лежит после `to`, значит
 * цикл прерывается раньше) или уже прошёл её (она значилась раньше самого
 * первого рассмотренного места — на практике не бывает, RECURRENCE-ID не
 * может быть раньше DTSTART серии, но защититься от порядка обхода всё равно
 * стоит). Поэтому после основного цикла есть отдельный проход по ВСЕМ
 * известным переопределениям (`event.exceptions`), которые основной цикл не
 * рассмотрел, — он ловит экземпляр, перенесённый ИЗ-ЗА ПРЕДЕЛОВ окна
 * ВНУТРЬ него. В конце результат сортируется по фактическому (видимому)
 * времени начала, потому что перенос экземпляра может нарушить естественный
 * хронологический порядок обхода курсора.
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
    if (tzid) registerTimeZone(tzid, wrapComponent(vtimezone));
  }

  // Основной компонент серии — единственный VEVENT БЕЗ RECURRENCE-ID.
  // Опознаём его так, а не как "первый VEVENT в файле": порядок компонентов
  // в календарном объекте не гарантирован RFC 5545, а наш собственный
  // updateEvent (задача 13) дописывает переопределение ПОСЛЕ основного
  // компонента через addSubcomponent, но полагаться на это для чужих ICS
  // (например, напрямую с сервера) не стоит.
  const vevents = root.getAllSubcomponents("vevent");
  const master = vevents.find((component) => !component.hasProperty("recurrence-id"));
  if (!master) return [];

  // parseEvent зовём на ICS, содержащем ТОЛЬКО основной компонент — иначе
  // при обратном порядке компонентов он получил бы через свой собственный
  // getFirstSubcomponent("vevent") переопределение вместо серии.
  const base = parseEvent(wrapComponent(master), calendarId, etag);

  // new ICAL.Event(master) сам находит и связывает переопределения — см.
  // комментарий к функции выше.
  const event = new ICAL.Event(master);
  if (!event.isRecurring()) {
    const startsBefore = new Date(base.start) < to;
    const endsAfter = new Date(base.end) > from;
    return startsBefore && endsAfter ? [base] : [];
  }

  const iterator = event.iterator();
  const occurrences: CalendarEvent[] = [];
  // Какие переопределения уже рассмотрены основным циклом (независимо от
  // того, попали они в выдачу или были отброшены как вне окна) — чтобы не
  // разбирать их повторно в дополнительном проходе ниже.
  const handledOverrides = new Set<ICAL.Event>();

  for (let i = 0; i < MAX_ITERATIONS && occurrences.length < MAX_OCCURRENCES; i += 1) {
    const next = iterator.next();
    if (!next) break;

    // Условие прерывания — по ОРИГИНАЛЬНОЙ позиции курсора, не по
    // фактическому (возможно, смещённому переопределением) времени: курсор
    // всегда идёт по местам основной серии в порядке возрастания, так что
    // дальнейшие места заведомо ещё позже. Экземпляры, перенесённые с мест
    // ЗА пределами этой точки, добирает отдельный проход после цикла.
    if (next.toJSDate() >= to) break;

    const details = event.getOccurrenceDetails(next);
    const overridden = details.item !== event;
    if (overridden) handledOverrides.add(details.item);

    const startDate = details.startDate.toJSDate();
    const endDate = details.endDate.toJSDate();
    // Окно проверяем по ФАКТИЧЕСКОМУ (для переопределения — новому) времени:
    // экземпляр, перенесённый из окна наружу, не должен попасть в выдачу,
    // даже если его исходное место было внутри окна, и наоборот.
    if (endDate <= from || startDate >= to) continue;

    if (overridden) {
      occurrences.push(buildOverrideOccurrence(base, details.item, next, calendarId, etag));
    } else {
      occurrences.push({
        ...base,
        instanceStart: formatTime(next),
        start: formatTime(details.startDate),
        end: formatTime(details.endDate),
        seriesId: base.id,
      });
    }
  }

  // Переопределения, чья исходная позиция (RECURRENCE-ID) лежит за
  // пределами того, что рассмотрел основной цикл, — прежде всего те, что
  // после точки `to` (см. комментарий у break выше). Раз они физически
  // присутствуют в объекте как отдельные VEVENT, а не порождаются RRULE,
  // проверить их не в пример дешевле, чем расширять диапазон основного
  // цикла: событий с RECURRENCE-ID обычно единицы.
  for (const overrideEvent of Object.values(event.exceptions)) {
    if (handledOverrides.has(overrideEvent)) continue;
    if (occurrences.length >= MAX_OCCURRENCES) break;

    const startDate = overrideEvent.startDate.toJSDate();
    const endDate = overrideEvent.endDate.toJSDate();
    if (endDate <= from || startDate >= to) continue;

    occurrences.push(
      buildOverrideOccurrence(base, overrideEvent, overrideEvent.recurrenceId, calendarId, etag),
    );
  }

  // Перенос экземпляра может нарушить хронологический порядок обхода
  // курсора (экземпляр, сдвинутый раньше по времени, курсор всё равно
  // выдаёт на своём исходном, более позднем месте в последовательности) —
  // выдачу приводим к порядку по фактическому времени начала.
  occurrences.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());

  return occurrences;
}
