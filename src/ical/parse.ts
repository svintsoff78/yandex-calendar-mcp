import ICAL from "ical.js";
import type { CalendarEvent, Recurrence, RecurrenceFrequency, Reminder } from "../types.js";
import { instanceAt, toCalendarEvent, type EventMeta } from "./instances.js";
import { isUnparsable, loadObject, splitContentLine, type CalendarObject, type Unparsable } from "./object.js";
import { registerTimeZone } from "./timezones.js";
import { formatForModel, type IcalEnv } from "./values.js";

/**
 * Разбор календарного объекта целиком — то, что показывает get_event (З09
 * плана переделки, docs/superpowers/plans/2026-09-19-recurring-events-rework.md).
 *
 * Объект читается через модель `loadObject` (object.ts), поля — через
 * `toCalendarEvent` (instances.ts): основной компонент — VEVENT без
 * RECURRENCE-ID, где бы он ни стоял (О1); у объекта без основного — первая
 * по адресу встреча (Р6); отступления серии — в `exceptions` (Р5–Р7),
 * аномалии — в `anomalies`. Свой разбор полей здесь не ведётся, кроме двух
 * вещей, которых instances.ts не делает:
 * - напоминания — только те, что модель умеет вернуть при правке
 *   (`modelReminders`, О9);
 * - заглушка для текста, который ical.js не разбирает (`unparsableEvent`, Р4).
 *
 * Пояс процесса не участвует: даты и плавающее время читаются в поясе
 * календаря из `IcalEnv.floatingZone`, моменты — через values.ts.
 */

/**
 * Окружение по умолчанию, когда вызывающий `env` не передал: даты и
 * плавающее время — в UTC. Так читал прежний `parseEvent`, и так читает
 * ещё не переделанный src/domain/events.ts; пояс календаря из настроек
 * передаёт З13.
 */
export const DEFAULT_READ_ENV: IcalEnv = Object.freeze({ floatingZone: "UTC" });

/**
 * Объект не прочитан (Р4): ical.js не разобрал текст, а для заглушки нет
 * даже начала встречи. `uid` — из построчного разбора, если нашёлся.
 */
export class UnparsableEventError extends Error {
  readonly code = "unparsable";
  readonly uid?: string;

  constructor(message: string, uid?: string) {
    super(message);
    this.name = "UnparsableEventError";
    this.uid = uid;
  }
}

/**
 * Объект целиком для get_event: основной компонент с `exceptions` и
 * `anomalies` (или первая встреча объекта без основного, Р6).
 *
 * Прежняя сигнатура сохранена; `env` необязателен (`DEFAULT_READ_ENV`).
 * Неразбираемый объект — `UnparsableEventError`, а не заглушка: на этой
 * функции ещё стоят правка и удаление прежнего src/domain/events.ts, и
 * заглушка без правила превратила бы там «удалить эту встречу» в удаление
 * всего объекта. Заглушку для показа даёт `eventOfObject`.
 */
export function parseEvent(ics: string, calendarId: string, etag?: string, env: IcalEnv = DEFAULT_READ_ENV): CalendarEvent {
  const object = loadObject(ics, env);
  if (isUnparsable(object)) {
    throw new UnparsableEventError(
      `Событие ${object.uid ?? "без UID"} не разобрано: ${object.error} ` +
        "Прочитать его можно только заглушкой, изменить — нельзя; удалить — только целиком (scope all_series).",
      object.uid,
    );
  }
  return eventOfObject(object, { calendarId, etag }, env);
}

/**
 * Объект целиком для get_event (Р4–Р7): у разобранного — как `parseEvent`,
 * у неразбираемого — заглушка `unparsableEvent`.
 */
export function eventOfObject(o: CalendarObject | Unparsable, meta: EventMeta, env: IcalEnv): CalendarEvent {
  if (isUnparsable(o)) return unparsableEvent(o, meta, env);
  const event = toCalendarEvent(o, "object", meta);
  event.reminders = modelReminders(objectShown(o));
  return event;
}

/**
 * Напоминания, которые модель умеет вернуть при правке (О9): VALARM с ACTION
 * DISPLAY или EMAIL и TRIGGER-длительностью от начала (RELATED нет или
 * START). Правка управляет ровно такими (src/ical/patch.ts, managedAlarmKey);
 * остальные — AUDIO, PROCEDURE, TRIGGER от конца (RELATED=END), абсолютный
 * TRIGGER — модель не выражает. Показанные, они вернулись бы при правке
 * напоминанием от начала и легли бы вторыми рядом с прежними, которые правка
 * не трогает. Поэтому их нет в выдаче; в объекте они целы.
 *
 * Отступ — минуты до начала со знаком: TRIGGER:-PT15M → 15, TRIGGER:PT10M →
 * −10 (types.ts, Reminder). TRIGGER — property.js, getFirstValue:
 * ICAL.Duration у длительности, ICAL.Time у VALUE=DATE-TIME (design.js:599,
 * trigger: тип по умолчанию — duration, допустим date-time); `toSeconds` —
 * duration.js.
 */
export function modelReminders(c: ICAL.Component): Reminder[] {
  const reminders: Reminder[] = [];
  for (const alarm of c.getAllSubcomponents("valarm")) {
    const action = String(alarm.getFirstPropertyValue("action") ?? "").toUpperCase();
    if (action !== "DISPLAY" && action !== "EMAIL") continue;
    const trigger = alarm.getFirstProperty("trigger");
    if (!trigger) continue;
    if (String(trigger.getParameter("related") ?? "START").toUpperCase() !== "START") continue;
    const value = trigger.getFirstValue();
    if (!(value instanceof ICAL.Duration)) continue; // абсолютный TRIGGER — ICAL.Time
    reminders.push({ minutesBefore: Math.round(-value.toSeconds() / 60) || 0, method: action === "EMAIL" ? "email" : "display" });
  }
  return reminders;
}

/**
 * Заглушка неразбираемого объекта (Р4): UID, SUMMARY и начало из
 * построчного разбора (object.ts, Unparsable), `anomalies` —
 * «unparsable: причина». Встреч серии не перебрать, поэтому заглушка одна на
 * объект и адреса (`instanceStart`) у неё нет: изменить такой объект нельзя,
 * удалить — только целиком.
 *
 * Начало — DTSTART: дата — полночь пояса календаря, конец — через сутки
 * (RFC 5545 §3.6.1, DATE без DTEND); время с Z — UTC; с TZID из базы IANA —
 * в этом поясе; с неизвестным TZID и плавающее — стенное время календаря
 * (как у разобранных объектов, object.ts, registerZones), у неизвестного
 * TZID — ещё и аномалия unknown-tzid. Конец времени неизвестен — он равен
 * началу. Нечитаемое начало — `UnparsableEventError` с UID: выдумывать
 * встрече время нельзя.
 */
export function unparsableEvent(u: Unparsable, meta: EventMeta, env: IcalEnv): CalendarEvent {
  const start = stubStart(u, meta);
  const anomalies = [`unparsable: ${u.error}`];
  let time: ICAL.Time;
  let timeZone: string;
  if (start.kind === "date") {
    time = ICAL.Time.fromData({ ...start.fields, isDate: true });
    timeZone = env.floatingZone;
  } else if (start.kind === "utc") {
    time = ICAL.Time.fromData({ ...start.fields, isDate: false }, ICAL.Timezone.utcTimezone);
    timeZone = "UTC";
  } else {
    let zone: ICAL.Timezone | undefined;
    if (start.tzid !== undefined) {
      try {
        zone = registerTimeZone(start.tzid);
      } catch {
        anomalies.push(`unknown-tzid: пояс ${start.tzid} неизвестен: его время читается как стенное время календаря`);
      }
    }
    // Без пояса — плавающее время (localTimezone): formatForModel читает его в поясе календаря.
    time = ICAL.Time.fromData({ ...start.fields, isDate: false }, zone ?? ICAL.Timezone.localTimezone);
    timeZone = zone ? start.tzid! : env.floatingZone;
  }
  const end = time.clone();
  if (time.isDate) end.adjust(1, 0, 0, 0); // time.js, adjust: стенной сдвиг на сутки

  const event: CalendarEvent = {
    id: u.uid ?? "",
    calendarId: meta.calendarId,
    summary: u.summary ?? "",
    start: formatForModel(time, env, "time"),
    end: formatForModel(end, env, "time"),
    timeZone,
    allDay: time.isDate,
    reminders: [],
    attendees: [],
  };
  if (meta.etag !== undefined) event.etag = meta.etag;
  if (meta.href !== undefined) event.href = meta.href;
  event.anomalies = anomalies;
  return event;
}

// ─────────────────────────────── внутреннее ───────────────────────────────

// Компонент, чьи поля показывает toCalendarEvent(o, "object"): основной, а
// без него — первая по адресу встреча (instances.ts, objectInstance: обход
// o.overrides по возрастанию ключа до первой показываемой).
function objectShown(o: CalendarObject): ICAL.Component {
  if (o.master) return o.master;
  for (const key of o.overrides.keys()) {
    const instance = instanceAt(o, key);
    if (instance) return instance.shown;
  }
  throw new Error(`В объекте ${o.uid} нет ни основного компонента, ни показываемых встреч.`);
}

interface StubFields {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

type StubStart =
  | { kind: "date"; fields: StubFields }
  | { kind: "utc"; fields: StubFields }
  | { kind: "wall"; fields: StubFields; tzid?: string };

const DATE_VALUE = /^(\d{4})(\d{2})(\d{2})$/;
const DATE_TIME_VALUE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/;

// Начало заглушки из строки DTSTART (RFC 5545 §3.3.4, §3.3.5): дата или
// дата-время, TZID — параметр строки. Регулярным выражением, без ical.js:
// текст объекта ical.js уже не разобрал.
function stubStart(u: Unparsable, meta: EventMeta): StubStart {
  const raw = u.dtstartRaw;
  const line = raw === undefined ? undefined : splitContentLine(raw);
  const refuse = (why: string) =>
    new UnparsableEventError(
      `Событие ${u.uid ?? `без UID${meta.href ? ` (${meta.href})` : ""}`} не разобрано (${u.error}), ` +
        `и его начало не прочитать: ${why}. Показать его нельзя; удалить — только целиком (scope all_series).`,
      u.uid,
    );
  if (!raw || !line) throw refuse("строки DTSTART нет");

  const value = line.value.trim();
  const params = raw.slice(0, raw.length - line.value.length - 1);
  const date = DATE_VALUE.exec(value);
  const dateTime = DATE_TIME_VALUE.exec(value);
  const parts = date ?? dateTime;
  if (!parts) throw refuse(`значение ${JSON.stringify(value)} — не дата и не время`);

  const fields: StubFields = {
    year: Number(parts[1]),
    month: Number(parts[2]),
    day: Number(parts[3]),
    hour: dateTime ? Number(dateTime[4]) : 0,
    minute: dateTime ? Number(dateTime[5]) : 0,
    second: dateTime ? Number(dateTime[6]) : 0,
  };
  // Секунда 60 — високосная (RFC 5545 §3.3.12); ICAL.Time её не держит.
  const valid = fields.month >= 1 && fields.month <= 12 && fields.day >= 1 &&
    fields.day <= ICAL.Time.daysInMonth(fields.month, fields.year) &&
    fields.hour <= 23 && fields.minute <= 59 && fields.second <= 60;
  if (!valid) throw refuse(`значение ${JSON.stringify(value)} — несуществующие дата или время`);
  fields.second = Math.min(fields.second, 59);

  if (date) return { kind: "date", fields };
  if (dateTime![7] === "Z") return { kind: "utc", fields };
  return { kind: "wall", fields, tzid: tzidOf(params) };
}

// TZID из параметров строки: ;TZID=имя или ;TZID="имя" (RFC 5545 §3.2, §3.2.19).
function tzidOf(params: string): string | undefined {
  const match = /;TZID=(?:"([^"]*)"|([^;:]*))/i.exec(params);
  const tzid = match ? (match[1] ?? match[2]) : undefined;
  return tzid ? tzid : undefined;
}

// ─────────────────────── прежние экспорты (без изменений) ───────────────────────

const FREQUENCIES: Record<string, RecurrenceFrequency> = {
  DAILY: "daily",
  WEEKLY: "weekly",
  MONTHLY: "monthly",
  YEARLY: "yearly",
};

function offsetString(time: ICAL.Time): string {
  const seconds = time.utcOffset();
  const sign = seconds < 0 ? "-" : "+";
  const abs = Math.abs(seconds);
  const hh = String(Math.floor(abs / 3600)).padStart(2, "0");
  const mm = String(Math.floor((abs % 3600) / 60)).padStart(2, "0");
  return `${sign}${hh}:${mm}`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * @deprecated Прежний формат времени: дата — полночь со смещением её зоны
 * (у DATE — «+00:00»), плавающее время — «+00:00». Чтение им больше не
 * пользуется: формат выдачи — values.ts, formatForModel (Р10).
 */
export function formatTime(time: ICAL.Time): string {
  const date = `${time.year}-${pad(time.month)}-${pad(time.day)}`;
  if (time.isDate) return `${date}T00:00:00${offsetString(time)}`;
  const clock = `${pad(time.hour)}:${pad(time.minute)}:${pad(time.second)}`;
  return `${date}T${clock}${offsetString(time)}`;
}

/**
 * @deprecated Прежний разбор RRULE через `ICAL.Recur`: неизвестные части
 * правила теряет. Чтение им больше не пользуется: повтор для модели —
 * instances.ts, toCalendarEvent (Р4, `recurrence.unmodeled`).
 */
export function parseRecurrence(vevent: ICAL.Component): Recurrence | undefined {
  const rule = vevent.getFirstPropertyValue("rrule") as ICAL.Recur | null;
  if (!rule) return undefined;

  const frequency = FREQUENCIES[String(rule.freq)];
  if (!frequency) return undefined;

  const byday = rule.getComponent("BYDAY") as string[] | undefined;
  const recurrence: Recurrence = { frequency, interval: rule.interval || 1 };
  if (byday && byday.length > 0) {
    recurrence.byWeekday = byday as Recurrence["byWeekday"];
  }
  if (rule.count) recurrence.count = rule.count;
  if (rule.until) recurrence.until = formatTime(rule.until);
  return recurrence;
}
