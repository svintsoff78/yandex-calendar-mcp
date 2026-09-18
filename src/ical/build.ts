import { randomUUID } from "node:crypto";
import ICAL from "ical.js";
import { registerTimeZone } from "./timezones.js";
import type { CalendarEvent, Recurrence } from "../types.js";

// Домен без полей, которые появляются только после того, как событие
// побывало на сервере (id/etag/href) или относятся к развёрнутому
// экземпляру повторяющейся серии (instanceStart/seriesId). id остаётся,
// но необязательным — вызывающий код может задать свой UID заранее.
export type NewEvent = Omit<
  CalendarEvent,
  "id" | "etag" | "href" | "instanceStart" | "seriesId"
> & { id?: string };

// Переводит ISO-строку с явным смещением (например "2026-09-21T10:00:00+03:00")
// в ICAL.Time, выраженный в стенном времени указанного пояса.
//
// Отступление от брифа: там стояло `ICAL.Time.fromJSDate(date, false)`.
// Второй аргумент — это `useUTC`, а не «использовать локальное время из
// строки». При `false` ical.js берёт значения года/месяца/часа и т. д. из
// геттеров JS Date БЕЗ смещения (`getFullYear`, `getHours`, ...), то есть
// в часовом поясе ХОСТ-МАШИНЫ, и присваивает `zone = Timezone.localTimezone`.
// Хуже того, `Timezone.convert_time` (lib/ical/timezone.js) содержит частный
// случай: если `from_zone === Timezone.localTimezone`, реального пересчёта
// часов не происходит вообще — зона просто переклеивается на целевую. Из-за
// этого при часовом поясе хоста, отличном от `event.timeZone`, `convertToZone`
// не поменяла бы ни одного числа, и в DTSTART попало бы время хоста под
// чужим TZID. В этой машине локальный пояс случайно равен Europe/Moscow,
// поэтому баг не проявился бы на тестах брифа, но упал бы в проде на сервере
// с другим TZ (например, UTC). Здесь используется `useUTC=true`: JS Date уже
// содержит верный момент времени (учёл смещение из ISO-строки при парсинге),
// геттеры UTC дают этот момент как `zone = Timezone.utcTimezone`, а
// `convertToZone` для пары UTC → именованный пояс делает настоящий пересчёт
// через `utcOffset()`. Результат не зависит от часового пояса хост-машины.
function toIcalTime(iso: string, tzid: string, allDay: boolean): ICAL.Time {
  const zone = registerTimeZone(tzid);
  const date = new Date(iso);
  const time = ICAL.Time.fromJSDate(date, true).convertToZone(zone);
  if (allDay) {
    return ICAL.Time.fromData({
      year: time.year,
      month: time.month,
      day: time.day,
      isDate: true,
    });
  }
  return time;
}

// Правка по ревью (Important, круг 1): `zone.component` — это один и тот же
// объект `ICAL.Component`, закешированный внутри `ICAL.TimezoneService`
// (см. registerTimeZone в ./timezones.ts). `Component.addSubcomponent`
// (node_modules/ical.js/lib/ical/component.js) при добавлении отцепляет
// компонент от предыдущего родителя вызовом `parent.removeSubcomponent`.
// Если положить этот общий объект в VCALENDAR напрямую, второй вызов
// buildEvent с тем же часовым поясом молча вырвет VTIMEZONE из первого,
// ещё не сериализованного календаря. Сейчас это не проявляется — каждый
// вызов сериализуется в строку синхронно, до следующего, — но задача 12
// вводит пакетную сборку в цикле поверх этого же кода, и хрупкость лучше
// убрать заранее. `ICAL.helpers.clone(jCal, true)` — задокументированная
// часть публичного API (dist/types/helpers.d.ts), выполняет глубокое
// копирование jCal-массива, так что каждый календарь получает независимый
// компонент, а объект в сервисе не трогается.
function cloneComponent(component: ICAL.Component): ICAL.Component {
  return new ICAL.Component(ICAL.helpers.clone(component.jCal, true));
}

function toRrule(recurrence: Recurrence): ICAL.Recur {
  const parts = [`FREQ=${recurrence.frequency.toUpperCase()}`, `INTERVAL=${recurrence.interval}`];
  if (recurrence.byWeekday?.length) parts.push(`BYDAY=${recurrence.byWeekday.join(",")}`);
  if (recurrence.count) parts.push(`COUNT=${recurrence.count}`);
  if (recurrence.until) {
    parts.push(`UNTIL=${new Date(recurrence.until).toISOString().replace(/[-:]|\.\d{3}/g, "")}`);
  }
  return ICAL.Recur.fromString(parts.join(";"));
}

export function buildEvent(event: NewEvent): { ics: string; uid: string } {
  const uid = event.id ?? randomUUID();
  const calendar = new ICAL.Component(["vcalendar", [], []]);
  calendar.addPropertyWithValue("version", "2.0");
  calendar.addPropertyWithValue("prodid", "-//yandex-calendar-mcp//RU");

  if (!event.allDay) {
    calendar.addSubcomponent(cloneComponent(registerTimeZone(event.timeZone).component));
  }

  const vevent = new ICAL.Component("vevent");
  vevent.addPropertyWithValue("uid", uid);
  // Правка по ревью (Important, круг 1): ICAL.Time.now() внутри вызывает
  // Time.fromJSDate(new Date(), false) — тот же useUTC=false, что уже был
  // признан багом в toIcalTime выше, только здесь для «текущего момента».
  // DTSTAMP по RFC 5545 §3.8.7.2 обязан быть в UTC; с ICAL.Time.now() он
  // сериализуется как floating-время хост-машины без суффикса Z и без
  // TZID, то есть один и тот же момент даёт разные строки в зависимости от
  // TZ процесса. fromJSDate(date, true) даёт zone=UTC и корректный `Z`.
  vevent.addPropertyWithValue("dtstamp", ICAL.Time.fromJSDate(new Date(), true));
  vevent.addPropertyWithValue("summary", event.summary);
  if (event.description) vevent.addPropertyWithValue("description", event.description);
  if (event.location) vevent.addPropertyWithValue("location", event.location);

  const start = vevent.addPropertyWithValue(
    "dtstart",
    toIcalTime(event.start, event.timeZone, event.allDay),
  );
  const end = vevent.addPropertyWithValue(
    "dtend",
    toIcalTime(event.end, event.timeZone, event.allDay),
  );
  if (!event.allDay) {
    start.setParameter("tzid", event.timeZone);
    end.setParameter("tzid", event.timeZone);
  }

  if (event.recurrence) vevent.addPropertyWithValue("rrule", toRrule(event.recurrence));

  for (const reminder of event.reminders) {
    const alarm = new ICAL.Component("valarm");
    alarm.addPropertyWithValue("action", reminder.method === "email" ? "EMAIL" : "DISPLAY");
    alarm.addPropertyWithValue(
      "trigger",
      ICAL.Duration.fromSeconds(-reminder.minutesBefore * 60),
    );
    alarm.addPropertyWithValue("description", event.summary);
    vevent.addSubcomponent(alarm);
  }

  for (const attendee of event.attendees) {
    const property = vevent.addPropertyWithValue("attendee", `mailto:${attendee.email}`);
    property.setParameter("partstat", attendee.status.toUpperCase());
  }

  calendar.addSubcomponent(vevent);
  return { ics: calendar.toString(), uid };
}
