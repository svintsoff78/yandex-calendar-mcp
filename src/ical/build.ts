import { randomUUID } from "node:crypto";
import ICAL from "ical.js";
import { vtimezoneFor } from "./timezones.js";
import {
  instantOf,
  ModelTimeError,
  parseModelTime,
  setRuleDict,
  setTimeProperty,
  timeInForm,
  type IcalEnv,
  type ModelTime,
  type RuleDictInput,
  type TimeForm,
} from "./values.js";
import type { Attendee, CalendarEvent, Recurrence, RecurrenceFrequency, Reminder } from "../types.js";

/**
 * Сборка текста iCalendar для нового события — только для создания.
 * Правка существующих объектов идёт по их дереву (план переделки,
 * docs/superpowers/plans/2026-09-19-recurring-events-rework.md, §1): из
 * `CalendarEvent` объект не пересобирается никогда.
 *
 * Пояс процесса не участвует нигде (З15): время от модели разбирает
 * `parseModelTime` регулярным выражением, моменты и стенное время считает
 * values.ts через ical.js, DTSTAMP — из секунд Unix через UTC-поля.
 * - ISO со смещением или Z — момент, пишется стенным временем пояса события;
 * - ISO без смещения — стенное время в поясе события, а не процесса;
 * - `YYYY-MM-DD` у события на весь день — эта дата буквально, без перевода
 *   поясов;
 * - UNTIL — в форме DTSTART (О4, RFC 5545 §3.3.10): у серии на весь день —
 *   дата, у серии со временем — момент в UTC.
 */

/** Повтор нового события: только то, что сборка пишет в RRULE. */
export interface NewRecurrence {
  frequency: RecurrenceFrequency;
  interval: number;
  /**
   * Дни недели BYDAY. Порядковый номер — только при monthly (±1…5) и yearly
   * (±1…9: ical.js читает у номера одну цифру, см. checkedByday).
   */
  byWeekday?: ReadonlyArray<NonNullable<Recurrence["byWeekday"]>[number]>;
  /**
   * Последняя встреча включительно. У серии на весь день — дата
   * `YYYY-MM-DD` (или полночь с любым смещением — берётся её дата). У серии
   * со временем: дата — весь этот день в поясе события; ISO без смещения —
   * стенное время пояса события; со смещением — момент.
   */
  until?: string;
  count?: number;
}

/**
 * Новое событие — ровно те поля, которые сборка пишет (замечание З04:
 * прежний `Omit<CalendarEvent, …>` молча пропускал поля чтения).
 *
 * Прочитанное событие структурно подходит и сюда, но его состояние серии,
 * которого сборка не пишет (`recurrenceRule`, `recurrence.unmodeled`,
 * `exceptions`, `anomalies`), отклоняется при выполнении: пересборка такого
 * события молча потеряла бы исключения и части правила. Прочие поля чтения
 * (`calendarId`, `etag`, `href`, `status`, `recurring`, …) сборке не нужны и в
 * текст не попадают.
 */
export interface NewEvent {
  /** UID; если не задан, выдаётся случайный. */
  id?: string;
  summary: string;
  description?: string;
  location?: string;
  /** Начало: ISO 8601 со смещением, без смещения (стенное время пояса события) или `YYYY-MM-DD` на весь день. */
  start: string;
  /** Конец, исключающий: как `start`; у события на весь день — дата после последнего дня. */
  end: string;
  /** IANA-пояс события. У события на весь день в текст не пишется, но проверяется. */
  timeZone: string;
  allDay: boolean;
  recurrence?: NewRecurrence;
  reminders: readonly Reminder[];
  attendees: readonly Attendee[];
}

export interface BuildOptions {
  /** Момент для DTSTAMP; по умолчанию — системные часы. */
  now?: Date;
  /**
   * Полный адрес владельца календаря (`Config.login`, name@yandex.ru) —
   * получатель напоминания письмом. Без него событие с таким напоминанием
   * не собирается: отправить письмо некому (RFC 5545 §3.6.6).
   */
  ownerEmail?: string;
}

/**
 * Код отказа сборки:
 * - `invalid-field` — пустой заголовок или UID, напоминание не целым числом
 *   минут, напоминание письмом без известного получателя;
 * - `invalid-time` — время не разобрано, не той формы, не существует в поясе
 *   события или конец не позже начала;
 * - `unknown-timezone` — пояса нет ни в базе IANA, ни среди зарегистрированных
 *   (у события на весь день тоже);
 * - `invalid-rule` — правило повтора нарушает RFC 5545 или модель;
 * - `unsupported-rule` — части правила вне модели, в том числе BYSETPOS и
 *   WKST, которые Яндекс искажает (docs/yandex-caldav-capabilities.md, Ж6);
 * - `read-only-field` — на вход пришло прочитанное событие с состоянием
 *   серии, которого сборка не пишет.
 */
export type BuildErrorCode =
  | "invalid-field"
  | "invalid-time"
  | "unknown-timezone"
  | "invalid-rule"
  | "unsupported-rule"
  | "read-only-field";

export class BuildError extends Error {
  readonly code: BuildErrorCode;

  constructor(code: BuildErrorCode, message: string) {
    super(message);
    this.name = "BuildError";
    this.code = code;
  }
}

export function buildEvent(event: NewEvent, options: BuildOptions = {}): { ics: string; uid: string } {
  assertNewEvent(event);
  const frame = frameOf(event, options);

  const start = eventTime(event.start, "start", frame);
  const end = eventTime(event.end, "end", frame);
  if (compareTimes(end, start, frame) <= 0) {
    throw new BuildError(
      "invalid-time",
      `Конец события (end = ${event.end}) должен быть позже начала (start = ${event.start}).`,
    );
  }
  const rrule = event.recurrence ? ruleProperty(event.recurrence, start, frame) : undefined;

  const uid = event.id ?? randomUUID();
  const calendar = new ICAL.Component(["vcalendar", [], []]);
  calendar.addPropertyWithValue("version", "2.0");
  calendar.addPropertyWithValue("prodid", "-//yandex-calendar-mcp//RU");
  if (frame.vtimezone) calendar.addSubcomponent(frame.vtimezone);

  const vevent = new ICAL.Component("vevent");
  vevent.addPropertyWithValue("uid", uid);
  // DTSTAMP по RFC 5545 §3.8.7.2 — в UTC. ICAL.Time.now() не годится: он
  // берёт местные поля Date и плавающую зону (time.js, now → fromJSDate(…, false)).
  vevent.addPropertyWithValue("dtstamp", utcStamp(options.now));
  vevent.addPropertyWithValue("summary", event.summary);
  if (event.description) vevent.addPropertyWithValue("description", event.description);
  if (event.location) vevent.addPropertyWithValue("location", event.location);
  setTimeProperty(vevent, "dtstart", start);
  setTimeProperty(vevent, "dtend", end);
  if (rrule) vevent.addProperty(rrule);

  for (const reminder of event.reminders) {
    vevent.addSubcomponent(newAlarm(reminder, event.summary, frame.env));
  }

  for (const attendee of event.attendees) {
    const property = vevent.addPropertyWithValue("attendee", `mailto:${attendee.email}`);
    property.setParameter("partstat", attendee.status.toUpperCase());
  }

  calendar.addSubcomponent(vevent);
  return { ics: calendar.toString(), uid };
}

// ───────────────────────────── напоминания ─────────────────────────────

/**
 * Напоминание события. У показа — ACTION, TRIGGER, DESCRIPTION. У письма
 * RFC 5545 §3.6.6 требует сверх того тему (SUMMARY) и хотя бы одного
 * получателя (ATTENDEE): письмо без адресата отправить некуда, и строгий
 * сервер вправе такую запись отвергнуть.
 *
 * Получатель — владелец календаря (`env.ownerEmail` из `Config.login`), как
 * и в правке события (patch.ts, alarmRecipients). Гости встречи источником
 * не служат: напоминание заводится пользователем себе, а не им.
 */
function newAlarm(reminder: Reminder, summary: string, env: IcalEnv): ICAL.Component {
  const alarm = new ICAL.Component("valarm");
  const action = reminder.method === "email" ? "EMAIL" : "DISPLAY";
  alarm.addPropertyWithValue("action", action);
  alarm.addPropertyWithValue("trigger", ICAL.Duration.fromSeconds(-reminder.minutesBefore * 60));
  alarm.addPropertyWithValue("description", summary);
  if (action !== "EMAIL") return alarm;

  const owner = (env.ownerEmail ?? "").trim();
  if (!owner) {
    throw new BuildError(
      "invalid-field",
      "Напоминание письмом отправить некому: получатель неизвестен. " +
        "Адрес владельца календаря в настройках не задан — задайте его " +
        "или оставьте напоминание показом (method: display).",
    );
  }
  alarm.addPropertyWithValue("summary", summary);
  alarm.addPropertyWithValue("attendee", `mailto:${owner}`);
  return alarm;
}

// ─────────────────────────────── вход ───────────────────────────────

function assertNewEvent(event: NewEvent): void {
  // Поля чтения типом NewEvent не объявлены, но прочитанное событие
  // структурно сюда подходит — смотрим на них явно.
  const read = event as NewEvent & Partial<Pick<CalendarEvent, "recurrenceRule" | "exceptions" | "anomalies">>;
  if (read.recurrenceRule !== undefined) {
    throw new BuildError(
      "unsupported-rule",
      "Поле recurrenceRule — дословное правило прочитанной серии, которое модель повтора не выражает; " +
        "сборка нового события его не пишет. Задайте повтор через recurrence.",
    );
  }
  for (const field of ["exceptions", "anomalies"] as const) {
    if (read[field]?.length) {
      throw new BuildError(
        "read-only-field",
        `Поле ${field} описывает прочитанную серию; сборка нового события его не пишет, ` +
          "и пересборка такой серии молча потеряла бы её исключения. Существующее событие правится на месте.",
      );
    }
  }

  if (!event.summary?.trim()) {
    throw new BuildError("invalid-field", "Заголовок события (summary) не может быть пустым.");
  }
  if (event.id !== undefined && !event.id.trim()) {
    throw new BuildError("invalid-field", "UID события (id) не может быть пустым.");
  }
  for (const reminder of event.reminders) {
    if (!Number.isInteger(reminder.minutesBefore)) {
      throw new BuildError(
        "invalid-field",
        `Напоминание задаётся целым числом минут, получено minutesBefore = ${reminder.minutesBefore}.`,
      );
    }
  }
}

// ──────────────────────────── форма времени ────────────────────────────

/**
 * Форма времени события (О4): дата у события на весь день; время с поясом
 * (TZID и вложенный VTIMEZONE); момент в UTC для пояса UTC.
 */
interface Frame {
  form: Extract<TimeForm, "date" | "zoned" | "utc">;
  /** Пояс значений; у формы date — undefined. */
  zone?: ICAL.Timezone;
  /** VTIMEZONE для вложения в VCALENDAR; только у формы zoned. */
  vtimezone?: ICAL.Component;
  env: IcalEnv;
}

function frameOf(event: NewEvent, options: BuildOptions): Frame {
  const env: IcalEnv = { floatingZone: event.timeZone, ownerEmail: options.ownerEmail };

  // Имена UTC, GMT и Z ical.js держит за общим utcTimezone
  // (timezone_service.js, reset). Время в нём пишется с Z и без TZID —
  // форма utc; `TZID=UTC` вместе с Z RFC 5545 §3.3.5 не допускает.
  if (ICAL.TimezoneService.get(event.timeZone) === ICAL.Timezone.utcTimezone) {
    return event.allDay ? { form: "date", env } : { form: "utc", zone: ICAL.Timezone.utcTimezone, env };
  }

  // Время считается по тому же описанию пояса, что вкладывается в текст, — из
  // базы IANA (vtimezoneFor), а не из ICAL.TimezoneService: туда мог попасть
  // чужой VTIMEZONE при чтении других объектов, и от порядка чтения текст
  // нового события зависеть не должен. Объект пояса не регистрируется;
  // tzid в данных важнее TZID компонента (timezone.js, fromData).
  const vtimezone = knownVtimezone(event.timeZone);
  // У события на весь день пояс в текст не пишется: у дат пояса нет. Но
  // проверяется он так же, как у события со временем, — иначе неверное имя
  // ушло бы без отказа в ответ createEvent.
  if (event.allDay) return { form: "date", env };

  const zone = new ICAL.Timezone({ component: vtimezone, tzid: event.timeZone });
  return { form: "zoned", zone, vtimezone, env };
}

function knownVtimezone(timeZone: string): ICAL.Component {
  try {
    return vtimezoneFor(timeZone);
  } catch {
    throw new BuildError(
      "unknown-timezone",
      `Неизвестный часовой пояс ${JSON.stringify(timeZone)}: нужен пояс IANA, например Europe/Moscow.`,
    );
  }
}

function parseField(iso: string, field: string, zone: ICAL.Timezone | undefined): ModelTime {
  try {
    return parseModelTime(iso, zone);
  } catch (error) {
    if (error instanceof ModelTimeError) throw new BuildError("invalid-time", `${field}: ${error.message}`);
    throw error;
  }
}

/** Значение start или end в форме события. */
function eventTime(iso: string, field: string, frame: Frame): ICAL.Time {
  if (frame.form === "date") return literalDate(iso, field);

  const parsed = parseField(iso, field, frame.zone);
  if (parsed.kind === "date") {
    throw new BuildError(
      "invalid-time",
      `${field}: у события не на весь день нужно время, а не только дата ${iso}. ` +
        "Передайте ISO 8601 со временем или allDay: true.",
    );
  }
  return timedValue(parsed, iso, field, frame);
}

/**
 * Дата у события на весь день — буквально из строки: `YYYY-MM-DD` или
 * полночь с любым смещением (Р10, как у адреса экземпляра). Время кроме
 * полуночи неоднозначно — `2026-09-22T21:00:00Z` это 23.09 в Москве и 22.09
 * в UTC, — поэтому отклоняется, а не переводится в какой-либо пояс.
 */
function literalDate(iso: string, field: string): ICAL.Time {
  const parsed = parseField(iso, field, undefined);
  const { year, month, day, hour, minute, second } = parsed.wall;
  if (parsed.kind !== "date" && (hour !== 0 || minute !== 0 || second !== 0)) {
    throw new BuildError(
      "invalid-time",
      `${field}: у события на весь день ожидается дата YYYY-MM-DD, получено ${iso}. ` +
        "Время кроме полуночи не определяет дату однозначно.",
    );
  }
  return ICAL.Time.fromData({ year, month, day, isDate: true });
}

/**
 * Время в форме события (zoned или utc). Момент — стенным временем пояса
 * события на этот момент (values.ts, timeInForm → atInstant: верно и у
 * перехода часов). Стенное время — как записано, но только если оно в поясе
 * существует: время из разрыва весеннего перевода RFC 5545 и ical.js читают
 * по-разному (values.ts, atInstant), поэтому такое время отклоняется.
 */
function timedValue(parsed: ModelTime, iso: string, field: string, frame: Frame): ICAL.Time {
  const value = timeInForm(parsed.time, frame.form, frame.zone, frame.env);
  if (parsed.kind === "wall" && frame.form === "zoned") {
    // Стенное время момента, которым ical.js прочтёт записанное значение.
    const actual = timeInForm(timeInForm(value, "utc", undefined, frame.env), "zoned", frame.zone, frame.env);
    const fields = ["year", "month", "day", "hour", "minute", "second"] as const;
    if (fields.some((name) => actual[name] !== parsed.wall[name])) {
      throw new BuildError(
        "invalid-time",
        `${field}: времени ${iso.slice(0, 16)} в поясе ${frame.zone?.tzid} нет — часы в этот день переводятся. ` +
          "Выберите другое время или передайте момент со смещением.",
      );
    }
  }
  return value;
}

// Порядок значений одной формы: у дат — по дате, у времени — по моменту.
function compareTimes(a: ICAL.Time, b: ICAL.Time, frame: Frame): number {
  if (frame.form === "date") return a.compare(b);
  return Math.sign(instantOf(a, frame.env) - instantOf(b, frame.env));
}

// ─────────────────────────────── RRULE ────────────────────────────────

const FREQUENCIES: Record<RecurrenceFrequency, string> = {
  daily: "DAILY",
  weekly: "WEEKLY",
  monthly: "MONTHLY",
  yearly: "YEARLY",
};

// BYDAY: день с необязательным порядковым номером со знаком (RFC 5545 §3.3.10).
// Номер берётся любой длины, чтобы отказ назвал причину (предел, ведущий ноль),
// а не только «не день недели».
const BYDAY_PATTERN = /^([+-]?)(\d+)?(MO|TU|WE|TH|FR|SA|SU)$/;

// Как номер BYDAY читает итератор ical.js 2.2.1: одна цифра, поиск без привязки
// к началу строки (node_modules/ical.js/lib/ical/recur_iterator.js,
// ruleDayOfWeek). Только для текста отказа: «20MO» → «0MO», «-12FR» → «2FR».
const ICALJS_BYDAY_READING = /([+-]?[0-9])?(MO|TU|WE|TH|FR|SA|SU)/;

// Части, которые Яндекс молча искажает (docs/yandex-caldav-capabilities.md, Ж6).
const DISTORTED_PARTS: Record<string, string> = {
  BYSETPOS: "BYSETPOS Яндекс молча заменяет другим правилом (например, «последний рабочий день месяца» — «последним четвергом»)",
  WKST: "WKST Яндекс выбрасывает",
};

/**
 * RRULE из модели. Правило собирается словарём частей (values.ts,
 * setRuleDict), а не склейкой строки: значение одной части не может
 * протащить в правило другую.
 */
function ruleProperty(recurrence: NewRecurrence, start: ICAL.Time, frame: Frame): ICAL.Property {
  const unmodeled = (recurrence as NewRecurrence & Pick<Recurrence, "unmodeled">).unmodeled;
  if (unmodeled) rejectUnmodeled(unmodeled);

  const freq = Object.hasOwn(FREQUENCIES, recurrence.frequency) ? FREQUENCIES[recurrence.frequency] : undefined;
  if (!freq) {
    throw invalidRule(
      `частота ${JSON.stringify(recurrence.frequency)} не поддерживается: допустимы daily, weekly, monthly, yearly.`,
    );
  }
  if (!Number.isInteger(recurrence.interval) || recurrence.interval < 1) {
    throw invalidRule(`interval — целое число от 1, получено ${recurrence.interval}.`);
  }
  if (recurrence.count !== undefined && recurrence.until !== undefined) {
    throw invalidRule("count и until вместе недопустимы (RFC 5545 §3.3.10): задайте что-то одно.");
  }
  if (recurrence.count !== undefined && (!Number.isInteger(recurrence.count) || recurrence.count < 1)) {
    throw invalidRule(`count — целое число от 1, получено ${recurrence.count}.`);
  }

  const dict: RuleDictInput = { freq, interval: recurrence.interval };
  const byday = (recurrence.byWeekday ?? []).map((value) => checkedByday(value, freq));
  // Как у разборщика: одно значение — строкой, несколько — списком (recur.js, _stringToData).
  if (byday.length > 0) dict.byday = byday.length === 1 ? byday[0] : byday;
  if (recurrence.count !== undefined) dict.count = recurrence.count;
  if (recurrence.until !== undefined) dict.until = untilValue(recurrence.until, start, frame);

  const property = new ICAL.Property("rrule");
  setRuleDict(property, dict);
  return property;
}

function rejectUnmodeled(unmodeled: string): never {
  const names = unmodeled.split(";").map((part) => part.split("=")[0].trim().toUpperCase());
  const distorted = [...new Set(names.filter((name) => Object.hasOwn(DISTORTED_PARTS, name)))];
  if (distorted.length > 0) {
    throw new BuildError(
      "unsupported-rule",
      `Правило с ${distorted.join(" и ")} не записывается: ${distorted.map((name) => DISTORTED_PARTS[name]).join("; ")}. ` +
        "Выразите повтор без этих частей или создайте несколько событий.",
    );
  }
  throw new BuildError(
    "unsupported-rule",
    `Части правила повтора вне модели (${unmodeled}) сборка нового события не пишет: ` +
      "используйте только frequency, interval, byWeekday, until и count.",
  );
}

/**
 * Значение BYDAY, которое и RFC 5545, и ical.js читают одинаково.
 *
 * Порядковый номер RFC 5545 §3.3.10 допускает только при MONTHLY и YEARLY; при
 * DAILY и WEEKLY он запрещён. Пределы:
 * - MONTHLY — ±1…5: в месяце не больше пяти одинаковых дней недели, на большем
 *   номере итератор ical.js бросает «Malformed values in BYDAY part»
 *   (node_modules/ical.js/lib/ical/recur_iterator.js, init);
 * - YEARLY — ±1…9, хотя RFC допускает до 53: итератор ical.js 2.2.1 читает у
 *   номера только одну цифру (recur_iterator.js, ruleDayOfWeek — регулярное
 *   выражение `/([+-]?[0-9])?(MO|…)/` без привязки к началу строки). «20MO» он
 *   раскрывает как «0MO», то есть каждый понедельник, «-12FR» — как «2FR».
 *   Серию с таким правилом этот же проект раскрыл бы неверно — в чтении, в
 *   слотах и в предохранителе, — и правка по слоту попала бы в несуществующие
 *   встречи. Однозначные номера итератор читает верно
 *   (recur_iterator.js, expand_by_day).
 * Ведущий ноль («05MO») грамматика RFC не допускает, и ICAL.parse такой текст
 * не читает (recur.js, VALID_BYDAY_PART).
 */
function checkedByday(value: string, freq: string): string {
  const match = BYDAY_PATTERN.exec(value);
  if (!match) {
    throw invalidRule(`byWeekday: ${JSON.stringify(value)} — не день недели (MO…SU) с необязательным номером вроде 2MO или -1FR.`);
  }
  const [, sign, ordinal] = match;
  if (ordinal === undefined) {
    if (sign) throw invalidRule(`byWeekday: ${JSON.stringify(value)} — знак без номера.`);
    return value;
  }
  if (freq !== "MONTHLY" && freq !== "YEARLY") {
    throw invalidRule(`byWeekday: номер дня (${value}) допустим только при monthly и yearly.`);
  }
  const number = Number(ordinal);
  if (number < 1 || ordinal.startsWith("0")) {
    throw invalidRule(`byWeekday: номер дня в ${value} — целое число от 1 без ведущих нулей, например 2MO или -1FR.`);
  }
  if (freq === "MONTHLY" && number > 5) {
    throw invalidRule(
      `byWeekday: номер дня в ${value} при monthly должен быть от 1 до 5 (со знаком или без): ` +
        "в месяце не больше пяти одинаковых дней недели.",
    );
  }
  if (freq === "YEARLY" && number > 9) {
    const misread = ICALJS_BYDAY_READING.exec(value)?.[0] ?? value;
    throw invalidRule(
      `byWeekday: номер дня в ${value} при yearly должен быть от 1 до 9 (со знаком или без). ` +
        "RFC 5545 допускает до 53, но ical.js, которой сервер раскрывает серии, читает у номера BYDAY " +
        `только одну цифру (recur_iterator.js, ruleDayOfWeek): ${value} она прочла бы как ${misread}, ` +
        "и встречи легли бы не в те дни. Выразите повтор иначе или создайте несколько событий.",
    );
  }
  return value;
}

/**
 * UNTIL в форме DTSTART (О4, RFC 5545 §3.3.10): дата у серии на весь день,
 * момент в UTC у серии со временем. Дата у серии со временем — весь этот
 * день в поясе события: последняя секунда даты стенным временем пояса.
 * UNTIL раньше начала отклоняется: серия из одного DTSTART — не то, что
 * просили (Р2).
 */
function untilValue(iso: string, start: ICAL.Time, frame: Frame): ICAL.Time {
  const field = "recurrence.until";
  let until: ICAL.Time;
  if (frame.form === "date") {
    until = literalDate(iso, field);
  } else {
    const parsed = parseField(iso, field, frame.zone);
    if (parsed.kind === "date") {
      const { year, month, day } = parsed.wall;
      const endOfDay = ICAL.Time.fromData({ year, month, day, hour: 23, minute: 59, second: 59, isDate: false }, frame.zone);
      until = timeInForm(endOfDay, "utc", undefined, frame.env);
    } else {
      until = timeInForm(timedValue(parsed, iso, field, frame), "utc", undefined, frame.env);
    }
  }
  if (compareTimes(until, start, frame) < 0) {
    throw invalidRule(`until (${iso}) раньше начала события: в серии не было бы ни одной встречи после первой.`);
  }
  return until;
}

function invalidRule(detail: string): BuildError {
  return new BuildError("invalid-rule", `Правило повтора: ${detail}`);
}

// ─────────────────────────────── DTSTAMP ───────────────────────────────

// Момент в UTC из секунд Unix: time.js, fromUnixTime берёт UTC-поля Date и
// зону utcTimezone, от пояса процесса не зависит.
function utcStamp(now: Date | undefined): ICAL.Time {
  const ms = now === undefined ? Date.now() : now.getTime();
  if (!Number.isFinite(ms)) throw new BuildError("invalid-field", "Часы для DTSTAMP вернули недопустимый момент.");
  const stamp = ICAL.Time.fromData(
    { year: 1970, month: 1, day: 1, hour: 0, minute: 0, second: 0, isDate: false },
    ICAL.Timezone.utcTimezone,
  );
  stamp.fromUnixTime(Math.floor(ms / 1000));
  return stamp;
}
