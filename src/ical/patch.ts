import ICAL from "ical.js";
import { ensureTimezones, type CalendarObject } from "./object.js";
import {
  EditRefusal,
  PATCH_FIELDS,
  type AttendeePatch,
  type FieldPatch,
  type PatchField,
  type RecurrencePatch,
  type Touched,
} from "./plan.js";
import { probeRules, seriesZoneOf, type Slot } from "./slots.js";
import { vtimezoneFor } from "./timezones.js";
import {
  formOf,
  instantOf,
  ModelTimeError,
  parseModelTime,
  ruleDict,
  setRuleDict,
  setTimeProperty,
  timeInForm,
  wallDateOf,
  type IcalEnv,
  type RuleDictInput,
  type RuleValue,
  type TimeForm,
  type ZoneRef,
} from "./values.js";
import type { RecurrenceFrequency, Reminder } from "../types.js";

/**
 * Точечная правка компонента на месте (О5–О10, Р4 плана переделки,
 * docs/superpowers/plans/2026-09-19-recurring-events-rework.md, задача З08).
 *
 * Главное свойство: каждое поле патча трогает только свои ICAL.Property и
 * подкомпоненты, всё прочее в объекте остаётся побайтово. Прежний код
 * пересобирал объект из доменной модели и терял EXDATE, RDATE, организатора,
 * параметры участников, чужие напоминания и части правила (R13-N3, AE1, AE6,
 * AD7). Здесь объект не собирается никогда: меняются значения и параметры
 * названных свойств, добавляются новые свойства и подкомпоненты, снимаются
 * лишние.
 *
 * Правка сначала проверяет весь патч и только потом пишет в дерево: отказ
 * `EditRefusal` оставляет компонент нетронутым. Всё, что правка изменила,
 * добавила или сняла, записывается в `Touched` — для предохранителя (О12б).
 *
 * Что модуль НЕ делает (это работа планировщика edit.ts, З10): выбор
 * компонентов по scope, сдвиг серии по Р1, разрез, SEQUENCE и DTSTAMP без
 * явного вызова `touchMetadata`, а также перевод значений серии в новую форму
 * DTSTART (О4). `applyFieldPatch` правит у основного только DTSTART, DTEND и
 * DURATION: при смене `timeZone` или `allDay` EXDATE, RDATE, RECURRENCE-ID
 * переопределений (и UNTIL, если форма сменилась между датой, плавающим и
 * временем с поясом или UTC) остаются в прежнем TZID или прежней форме —
 * перевести их обязан планировщик.
 *
 * Пояс процесса не участвует нигде: время от модели разбирает
 * `parseModelTime`, моменты считает values.ts через ical.js.
 */

// ─────────────────────────────── Touched ───────────────────────────────

/** Пустой учёт тронутого. */
export function newTouched(): Touched {
  return { properties: new Set(), components: new Set(), names: new Map() };
}

function markName(touched: Touched | undefined, c: ICAL.Component, name: string): void {
  if (!touched) return;
  let names = touched.names.get(c);
  if (!names) {
    names = new Set();
    touched.names.set(c, names);
  }
  names.add(name.toLowerCase());
}

function markProperty(touched: Touched | undefined, c: ICAL.Component, property: ICAL.Property): void {
  if (!touched) return;
  touched.properties.add(property);
  markName(touched, c, property.name);
}

function markComponent(touched: Touched | undefined, parent: ICAL.Component, sub: ICAL.Component): void {
  if (!touched) return;
  touched.components.add(sub);
  markName(touched, parent, sub.name);
}

/**
 * Глубокая копия компонента без родителя — например, снимок основного до
 * правки для `inheritFields`. jCal копируется целиком
 * (node_modules/ical.js/lib/ical/helpers.js, clone с aDeep).
 *
 * Внимание: у копии нет дерева, и значения с TZID она читает не по VTIMEZONE
 * объекта, а из глобального ICAL.TimezoneService (time.js,
 * fromDateTimeString: `prop.parent.getTimeZoneByID`, иначе `timezone: zoneId`
 * → time.js, fromData → TimezoneService.get; component.js, getTimeZoneByID
 * ищет только вверх по родителям). Пояс, описанный лишь в дереве, там не
 * зарегистрирован (object.ts, registerZones берёт из базы только TZID без
 * VTIMEZONE), и значение прочтётся плавающим, а другой описанный пояс — по
 * чужому описанию. Время, пояс и правило (`resolveTimes`, `patchRule`, UNTIL)
 * у такой копии не читать: сначала вставить её в VCALENDAR объекта или брать
 * значения у исходного компонента. Текст, участники и VALARM — можно.
 */
export function cloneComponent(c: ICAL.Component): ICAL.Component {
  return new ICAL.Component(ICAL.helpers.clone(c.jCal, true));
}

// ─────────────────────────────── поля (О5, О8, О9) ───────────────────────────────

export interface PatchContext {
  env: IcalEnv;
  touched?: Touched;
  /**
   * Пояс события, которое переходит с «весь день» на время без `timeZone` в
   * патче (из config). Без него — пояс календаря `env.floatingZone`.
   */
  defaultTimeZone?: string;
}

export interface FieldPatchResult {
  /** Поля, значения которых действительно изменились, в порядке PATCH_FIELDS. */
  changed: PatchField[];
  /** Менялись DTSTART, DTEND или DURATION — повод для SEQUENCE (О10). */
  significant: boolean;
}

const FIELD_KEYS: ReadonlySet<string> = new Set([
  "summary",
  "description",
  "location",
  "start",
  "end",
  "timeZone",
  "allDay",
  "reminders",
  "attendees",
]);

/**
 * Применяет поля патча к одному компоненту (VEVENT: основному, переопределению
 * или клону `overrideFromMaster`) на месте:
 * - summary, description, location — значение свойства на месте, прочие
 *   параметры (LANGUAGE) целы, ALTREP со старым текстом снимается; пустые
 *   description и location снимают свойство; пустой summary — отказ;
 * - start, end, timeZone, allDay — по О8 (см. `resolveTimes`); VTIMEZONE
 *   нового пояса добавляется в VCALENDAR компонента;
 * - attendees — по адресу (О9): PARTSTAT меняется только при `status`,
 *   прочие параметры целы, новые — NEEDS-ACTION, не названные снимаются;
 * - reminders — только VALARM DISPLAY и EMAIL с TRIGGER-длительностью от
 *   начала (О9): совпавшие остаются дословно, лишние снимаются, недостающие
 *   добавляются; AUDIO, TRIGGER от конца и абсолютные TRIGGER не трогаются.
 * Значение, равное прежнему, компонент не трогает (О13: пустой план ничего
 * не пишет). Повтор здесь не правится — правило правит `patchRule`.
 */
export function applyFieldPatch(c: ICAL.Component, p: FieldPatch, ctx: PatchContext): FieldPatchResult {
  const raw = p as FieldPatch & { recurrence?: unknown };
  if (raw.recurrence !== undefined) {
    throw new Error("applyFieldPatch не правит повтор: правило серии правит patchRule, решает планировщик.");
  }
  const unknown = Object.entries(p)
    .filter(([key, value]) => value !== undefined && key !== "recurrence" && !FIELD_KEYS.has(key))
    .map(([key]) => key);
  if (unknown.length > 0) {
    throw new EditRefusal("invalid-field", `Поля ${unknown.join(", ")} правка события не знает.`, {
      hint: "Изменяемые поля: summary, description, location, start, end, timeZone, allDay, reminders, attendees, recurrence.",
    });
  }

  // 1. Проверка всего патча — до первой правки дерева.
  const texts: Array<{ field: "summary" | "description" | "location"; value: string }> = [];
  for (const field of ["summary", "description", "location"] as const) {
    const value = p[field];
    if (value === undefined) continue;
    if (typeof value !== "string") throw new EditRefusal("invalid-field", `Поле ${field} — строка.`);
    if (field === "summary" && !value.trim()) {
      throw new EditRefusal("invalid-field", "Заголовок события (summary) не может быть пустым.");
    }
    texts.push({ field, value });
  }
  const times = resolveTimes(c, p, ctx);
  const attendees = p.attendees === undefined ? undefined : checkedAttendees(p.attendees);
  const reminders = p.reminders === undefined ? undefined : checkedReminders(p.reminders);

  // 2. Правка.
  const changed = new Set<PatchField>();
  for (const { field, value } of texts) {
    if (setText(c, field, value, ctx.touched)) changed.add(field);
  }
  let significant = false;
  if (times) {
    const fields = writeTimes(c, times, ctx);
    for (const field of fields) changed.add(field);
    significant = fields.length > 0;
  }
  if (attendees && applyAttendees(c, attendees, ctx.touched)) changed.add("attendees");
  if (reminders) {
    const description = textValue(c, "summary") ?? "Напоминание";
    const pending = reminders.map(({ action, seconds }) => ({
      key: alarmKey(action, seconds),
      make: () => newAlarm(action, seconds, description),
    }));
    if (syncAlarms(c, pending, ctx.touched)) changed.add("reminders");
  }
  return { changed: PATCH_FIELDS.filter((field) => changed.has(field)), significant };
}

// ─────────────────────────────── текст ───────────────────────────────

function textValue(c: ICAL.Component, name: string): string | undefined {
  const property = c.getFirstProperty(name);
  if (!property) return undefined;
  const value = property.getFirstValue();
  return value === null || value === undefined ? undefined : String(value);
}

// Значение текстового свойства на месте (property.js, setValue: у
// неразобранного типа text — jCal[3] = value). Пустая строка снимает все
// свойства с этим именем.
function setText(c: ICAL.Component, name: string, value: string, touched: Touched | undefined): boolean {
  const properties = c.getAllProperties(name);
  if (value === "") {
    for (const property of properties) {
      c.removeProperty(property);
      markProperty(touched, c, property);
    }
    return properties.length > 0;
  }
  const first = properties[0];
  if (!first) {
    markProperty(touched, c, c.addPropertyWithValue(name, value));
    return true;
  }
  if (textValue(c, name) === value) return false;
  first.setValue(value);
  // ALTREP (RFC 5545 §3.2.1) указывает на другое представление прежнего
  // текста — с новым текстом он лжёт.
  first.removeParameter("altrep");
  markProperty(touched, c, first);
  return true;
}

// ─────────────────────────────── участники ───────────────────────────────

const PARTSTAT: Record<string, string> = {
  accepted: "ACCEPTED",
  declined: "DECLINED",
  tentative: "TENTATIVE",
  "needs-action": "NEEDS-ACTION",
};

interface WantedAttendee {
  address: string;
  key: string;
  partstat?: string;
}

function addressKey(value: unknown): string {
  return String(value ?? "")
    .trim()
    .replace(/^mailto:/i, "")
    .trim()
    .toLowerCase();
}

function checkedAttendees(list: readonly AttendeePatch[]): WantedAttendee[] {
  if (!Array.isArray(list)) throw new EditRefusal("invalid-field", "attendees — список участников.");
  const seen = new Set<string>();
  return list.map((attendee: AttendeePatch) => {
    const email = typeof attendee?.email === "string" ? attendee.email : "";
    const address = email.trim().replace(/^mailto:/i, "").trim();
    if (!/^[^\s@]+@[^\s@]+$/.test(address)) {
      throw new EditRefusal("invalid-field", `Адрес участника ${JSON.stringify(attendee?.email)} не похож на почтовый.`);
    }
    const key = address.toLowerCase();
    if (seen.has(key)) throw new EditRefusal("invalid-field", `Участник ${address} указан в attendees дважды.`);
    seen.add(key);
    if (attendee.status === undefined) return { address, key };
    const partstat = Object.hasOwn(PARTSTAT, attendee.status) ? PARTSTAT[attendee.status] : undefined;
    if (!partstat) {
      throw new EditRefusal(
        "invalid-field",
        `Статус участника ${JSON.stringify(attendee.status)} неизвестен: допустимы accepted, declined, tentative, needs-action.`,
      );
    }
    return { address, key, partstat };
  });
}

function partstatOf(property: ICAL.Property): string {
  return String(property.getParameter("partstat") ?? "NEEDS-ACTION").toUpperCase();
}

// Участники по адресу (О9): имеющиеся свойства правятся на месте (CN, ROLE,
// RSVP и прочие параметры целы), новые добавляются в конец, не названные
// снимаются.
function applyAttendees(c: ICAL.Component, wanted: readonly WantedAttendee[], touched: Touched | undefined): boolean {
  const byKey = new Map(wanted.map((attendee) => [attendee.key, attendee]));
  const present = new Set<string>();
  let changed = false;
  for (const property of c.getAllProperties("attendee")) {
    const key = addressKey(property.getFirstValue());
    const want = byKey.get(key);
    if (!want) {
      c.removeProperty(property);
      markProperty(touched, c, property);
      changed = true;
      continue;
    }
    present.add(key);
    if (want.partstat && partstatOf(property) !== want.partstat) {
      property.setParameter("partstat", want.partstat);
      markProperty(touched, c, property);
      changed = true;
    }
  }
  for (const want of wanted) {
    if (present.has(want.key)) continue;
    const property = new ICAL.Property("attendee");
    property.setParameter("partstat", want.partstat ?? "NEEDS-ACTION");
    property.setValue(`mailto:${want.address}`);
    c.addProperty(property);
    markProperty(touched, c, property);
    changed = true;
  }
  return changed;
}

// ─────────────────────────────── напоминания ───────────────────────────────

type AlarmAction = "DISPLAY" | "EMAIL";

function checkedReminders(list: readonly Reminder[]): Array<{ action: AlarmAction; seconds: number }> {
  if (!Array.isArray(list)) throw new EditRefusal("invalid-field", "reminders — список напоминаний.");
  return list.map((reminder: Reminder) => {
    if (reminder?.method !== "display" && reminder?.method !== "email") {
      throw new EditRefusal("invalid-field", `Способ напоминания ${JSON.stringify(reminder?.method)} неизвестен: допустимы display и email.`);
    }
    if (!Number.isInteger(reminder.minutesBefore)) {
      throw new EditRefusal(
        "invalid-field",
        `Напоминание задаётся целым числом минут, получено minutesBefore = ${String(reminder.minutesBefore)}.`,
      );
    }
    // Положительное minutesBefore — раньше начала: TRIGGER отрицательный (types.ts, Reminder).
    return { action: reminder.method === "email" ? "EMAIL" : "DISPLAY", seconds: -reminder.minutesBefore * 60 };
  });
}

function alarmKey(action: string, seconds: number): string {
  return `${action}|${seconds === 0 ? 0 : seconds}`;
}

/**
 * Ключ напоминания, которым управляет модель: ACTION DISPLAY или EMAIL и
 * TRIGGER-длительность от начала (RELATED нет или START). Остальные VALARM
 * (AUDIO, PROCEDURE, от конца, абсолютные) модель не выражает — undefined.
 */
function managedAlarmKey(alarm: ICAL.Component): string | undefined {
  const action = String(alarm.getFirstPropertyValue("action") ?? "").toUpperCase();
  if (action !== "DISPLAY" && action !== "EMAIL") return undefined;
  const trigger = alarm.getFirstProperty("trigger");
  if (!trigger || trigger.type !== "duration") return undefined;
  if (String(trigger.getParameter("related") ?? "START").toUpperCase() !== "START") return undefined;
  const value = trigger.getFirstValue();
  if (!(value instanceof ICAL.Duration)) return undefined;
  return alarmKey(action, value.toSeconds());
}

function newAlarm(action: AlarmAction, seconds: number, description: string): ICAL.Component {
  // Как у сборки нового события (build.ts): ACTION, TRIGGER, DESCRIPTION.
  const alarm = new ICAL.Component("valarm");
  alarm.addPropertyWithValue("action", action);
  alarm.addPropertyWithValue("trigger", ICAL.Duration.fromSeconds(seconds));
  alarm.addPropertyWithValue("description", description);
  return alarm;
}

/**
 * Приводит управляемые напоминания компонента к списку `pending` (с
 * повторами): совпавшие по ключу остаются дословно, лишние снимаются,
 * недостающие добавляются в конец в порядке списка. Неуправляемые VALARM не
 * трогаются.
 */
function syncAlarms(
  c: ICAL.Component,
  pending: Array<{ key: string; make: () => ICAL.Component }>,
  touched: Touched | undefined,
): boolean {
  const rest = [...pending];
  let changed = false;
  for (const alarm of c.getAllSubcomponents("valarm")) {
    const key = managedAlarmKey(alarm);
    if (key === undefined) continue;
    const index = rest.findIndex((entry) => entry.key === key);
    if (index >= 0) {
      rest.splice(index, 1);
      continue;
    }
    c.removeSubcomponent(alarm);
    markComponent(touched, c, alarm);
    changed = true;
  }
  for (const entry of rest) {
    const alarm = entry.make();
    c.addSubcomponent(alarm);
    markComponent(touched, c, alarm);
    changed = true;
  }
  return changed;
}

// ─────────────────────────────── время (О8) ───────────────────────────────

/** Форма и пояс значений времени: у zoned — пояс и его TZID. */
interface Frame {
  form: TimeForm;
  zone?: ZoneRef;
  tzid?: string;
}

/**
 * Итог разбора времени патча — что писать в DTSTART и конец (О8). Поля конца
 * заданы, только если их надо записать.
 */
export interface TimePlan {
  /** Новое значение DTSTART в целевой форме (может совпасть с прежним). */
  start: ICAL.Time;
  /** Новое значение DTEND (у компонента с DTEND или без конца вовсе). */
  dtend?: ICAL.Time;
  /** Новая DURATION (у компонента с DURATION). */
  duration?: ICAL.Duration;
  /** Форма со временем сменила пояс или форму (timeZone). */
  zoneChanged: boolean;
  /** Форма сменилась между датой и временем (allDay). */
  formChanged: boolean;
  /** TZID целевой формы zoned (VTIMEZONE `writeTimes` добавляет по TZID записанных значений). */
  tzid?: string;
}

/**
 * Время компонента после патча по О8, без правки дерева:
 * - `start` без `end` сохраняет длительность: при DTEND — точную (моменты,
 *   RFC 5545 §3.8.5.3), у дат — в днях; DURATION не меняется вовсе;
 * - `end` пишется в имеющейся форме: DTEND, DURATION, а без конца — DTEND;
 *   конец не позже начала — отказ `invalid-time`;
 * - ISO без смещения — стенное время пояса события (после `timeZone` —
 *   нового пояса), а не процесса; стенное время из разрыва весеннего
 *   перевода — отказ, как у сборки (build.ts, timedValue);
 * - `timeZone` без `start` сохраняет моменты: DTSTART и DTEND переписываются
 *   стенным временем нового пояса; UTC, GMT и Z — форма UTC (как build.ts);
 *   у события в неизвестном поясе момент не определён — отказ
 *   `unknown-timezone` (как и у `start` и `end` в этом поясе);
 * - `allDay: true` без `start` — дата начала события; конец — день после
 *   последнего затронутого дня; со `start` без `end` — столько же затронутых
 *   дней от новой даты; `allDay: false` у события на весь день требует
 *   `start` и `end`, пояс — `timeZone` или `defaultTimeZone`.
 * Без полей времени в патче — undefined.
 */
export function resolveTimes(c: ICAL.Component, p: FieldPatch, ctx: PatchContext): TimePlan | undefined {
  if (p.start === undefined && p.end === undefined && p.timeZone === undefined && p.allDay === undefined) return undefined;
  const env = ctx.env;
  for (const field of ["start", "end", "timeZone"] as const) {
    if (p[field] !== undefined && typeof p[field] !== "string") {
      throw new EditRefusal(field === "timeZone" ? "unknown-timezone" : "invalid-time", `Поле ${field} — строка.`);
    }
  }
  if (p.allDay !== undefined && typeof p.allDay !== "boolean") throw new EditRefusal("invalid-field", "Поле allDay — true или false.");

  const startProperty = c.getFirstProperty("dtstart");
  if (!startProperty) throw new EditRefusal("invalid-time", "У события нет DTSTART: его время править нельзя.");
  const current = frameOfProperty(startProperty, env);
  const oldStart = (startProperty.getFirstValue() as ICAL.Time).clone();
  const dtendProperty = c.getFirstProperty("dtend");
  const durationProperty = c.getFirstProperty("duration");
  const oldEnd = endOf(oldStart, dtendProperty, durationProperty);

  // Целевая форма. Время в неизвестном поясе ical.js прочёл плавающим
  // (unknownZone): стенное время известно, момент — нет. Новое время в этом
  // поясе не записать, а смена пояса без start угадала бы момент по поясу
  // календаря — в обоих случаях отказ.
  const zoneUnknown = unknownZone(startProperty);
  const unknownTzid = String(startProperty.getParameter("tzid"));
  const allDay = p.allDay ?? current.form === "date";
  let target: Frame;
  if (allDay) {
    if (p.timeZone !== undefined) frameForZone(p.timeZone, c); // у дат пояса нет, но имя проверяется
    target = { form: "date" };
  } else if (p.timeZone !== undefined && !(current.form === "zoned" && current.tzid === p.timeZone)) {
    target = frameForZone(p.timeZone, c);
    if (zoneUnknown && p.start === undefined) {
      throw new EditRefusal(
        "unknown-timezone",
        `Пояс ${unknownTzid} события неизвестен: момент начала события не определён, и сменить пояс с сохранением времени нельзя.`,
        { hint: "Передайте вместе с timeZone новое время целиком: start и end, например 2026-10-21T10:00:00 и 2026-10-21T11:00:00." },
      );
    }
  } else if (current.form === "date") {
    target = frameForZone(ctx.defaultTimeZone ?? env.floatingZone, c);
  } else {
    if (zoneUnknown && (p.start !== undefined || p.end !== undefined)) {
      throw new EditRefusal("unknown-timezone", `Пояс ${unknownTzid} события неизвестен: новое время в нём не записать.`, {
        hint: "Передайте вместе со временем timeZone — пояс IANA, например Europe/Moscow.",
      });
    }
    target = current;
  }
  const sameFrame = target.form === current.form && target.tzid === current.tzid;
  const toDate = target.form === "date" && current.form !== "date";
  const fromDate = current.form === "date" && target.form !== "date";

  // Начало.
  let start: ICAL.Time;
  if (p.start !== undefined) start = parseIn(p.start, "start", target, env);
  else if (sameFrame) start = oldStart;
  else if (toDate) start = dateOfTimed(oldStart, current, env);
  else if (fromDate) throw needStartAndEnd();
  else start = timeInForm(oldStart, target.form, target.zone, env); // тот же момент

  // Конец: undefined — конца нет или он не меняется.
  let end: ICAL.Time | undefined;
  if (p.end !== undefined) end = parseIn(p.end, "end", target, env);
  else if (fromDate) throw needStartAndEnd();
  else if (oldEnd === undefined) end = undefined;
  else if (toDate) end = addDays(start, allDaySpan(oldStart, oldEnd, current, env));
  else end = keepDuration(oldStart, oldEnd, start, target, env);

  // Проверяется только сдвинутое время: патч, который ни начала, ни конца не
  // двигает, не отказывает и у объекта, испорченного раньше.
  const moved = p.start !== undefined || p.end !== undefined || !sameFrame;
  if (moved && end !== undefined && compareTimes(end, start, env) <= 0) {
    throw new EditRefusal(
      "invalid-time",
      `Конец события должен быть позже начала: начало ${start.toString()}, конец ${end.toString()}.`,
      { hint: p.end === undefined ? "Передайте end вместе со start." : undefined },
    );
  }

  const plan: TimePlan = { start, zoneChanged: !sameFrame && !toDate && !fromDate, formChanged: toDate || fromDate, tzid: target.tzid };
  if (durationProperty) {
    // DURATION сохраняет длительность сама; пересчёт — только при явном
    // end или смене «весь день» (длительность в днях или секундах).
    if (end !== undefined && (p.end !== undefined || toDate || fromDate)) plan.duration = durationBetween(start, end, env);
  } else if (dtendProperty) {
    if (end !== undefined) {
      const own = frameOfProperty(dtendProperty, env);
      const followsStart = !sameFrame || (own.form === current.form && own.tzid === current.tzid);
      plan.dtend = followsStart ? end : timeInForm(end, own.form, own.zone, env);
    }
  } else if (p.end !== undefined) {
    plan.dtend = end;
  }
  return plan;
}

/** Записывает время по плану `resolveTimes`; возвращает изменившиеся поля. */
export function writeTimes(c: ICAL.Component, plan: TimePlan, ctx: PatchContext): PatchField[] {
  const touched = ctx.touched;
  const changed = new Set<PatchField>();
  const written: ICAL.Property[] = [];
  const startProperty = c.getFirstProperty("dtstart");
  if (!startProperty || !sameTimeValue(startProperty, plan.start)) {
    const property = setTimeProperty(c, "dtstart", plan.start);
    markProperty(touched, c, property);
    written.push(property);
    changed.add("start");
  }
  if (plan.dtend) {
    const property = c.getFirstProperty("dtend");
    if (!property || !sameTimeValue(property, plan.dtend)) {
      const next = setTimeProperty(c, "dtend", plan.dtend);
      markProperty(touched, c, next);
      written.push(next);
      changed.add("end");
    }
  }
  if (plan.duration) {
    const property = c.getFirstProperty("duration");
    const current = property?.getFirstValue();
    if (!property || !(current instanceof ICAL.Duration) || current.toSeconds() !== plan.duration.toSeconds()) {
      if (property) property.setValue(plan.duration);
      markProperty(touched, c, property ?? c.addPropertyWithValue("duration", plan.duration));
      changed.add("end");
    }
    // DTEND вместе с DURATION недопустим (RFC 5545 §3.6.1).
    const dtend = c.getFirstProperty("dtend");
    if (dtend) {
      c.removeProperty(dtend);
      markProperty(touched, c, dtend);
      changed.add("end");
    }
  }
  if (changed.size > 0 && plan.zoneChanged) changed.add("timeZone");
  if (changed.size > 0 && plan.formChanged) changed.add("allDay");
  // VTIMEZONE на TZID каждого записанного значения (О12а), в том числе
  // прежнего TZID, если объект его не описывал; имеющиеся не трогаются (О5).
  addTimezones(c, written, touched);
  return PATCH_FIELDS.filter((field) => changed.has(field));
}

/**
 * Добавляет в VCALENDAR компонента VTIMEZONE для TZID записанных значений,
 * которых в объекте нет (object.ts, ensureTimezones: копия из базы IANA).
 * Пояс, которого нет и в базе (например, TZID=Z — синоним UTC у ical.js),
 * описать нечем: он остаётся как был, без VTIMEZONE. У компонента без
 * родителя VCALENDAR нет — ничего не добавляется.
 */
function addTimezones(c: ICAL.Component, properties: readonly ICAL.Property[], touched: Touched | undefined): void {
  const root = rootOf(c);
  if (!root) return;
  const tzids = new Set(properties.filter((property) => formOf(property) === "zoned").map((property) => String(property.getParameter("tzid"))));
  for (const tzid of tzids) {
    let added: string[];
    try {
      added = ensureTimezones(root, [tzid]);
    } catch {
      continue;
    }
    if (added.length === 0) continue;
    const zone = root.getAllSubcomponents("vtimezone").find((sub) => String(sub.getFirstPropertyValue("tzid")) === tzid);
    if (zone) markComponent(touched, root, zone);
  }
}

function needStartAndEnd(): EditRefusal {
  return new EditRefusal(
    "invalid-time",
    "Событие на весь день становится событием со временем: нужны start и end со временем.",
    { hint: "Передайте allDay: false вместе со start и end, например 2026-10-21T10:00:00 и 2026-10-21T11:00:00." },
  );
}

// Верхний компонент дерева (VCALENDAR); у компонента без родителя — undefined.
function rootOf(c: ICAL.Component): ICAL.Component | undefined {
  let node = c.parent;
  if (!node) return undefined;
  while (node.parent) node = node.parent;
  return node;
}

// Форма и пояс свойства времени (seriesZoneOf: пояс из дерева, имя для
// TZID-синонима UTC, пояс календаря для неизвестного TZID).
function frameOfProperty(property: ICAL.Property, env: IcalEnv): Frame {
  const form = formOf(property);
  if (form !== "zoned") return { form };
  return { form, zone: seriesZoneOf(property, env), tzid: String(property.getParameter("tzid")) };
}

// TZID записан, но ical.js прочёл время плавающим: пояс неизвестен
// (time.js, fromDateTimeString; object.ts, аномалия unknown-tzid).
function unknownZone(property: ICAL.Property): boolean {
  if (formOf(property) !== "zoned") return false;
  const value = property.getFirstValue() as ICAL.Time;
  return value.zone !== ICAL.Timezone.utcTimezone && formOf(value) === "floating";
}

/**
 * Форма и пояс для имени из патча. UTC, GMT и Z — форма utc (ical.js держит
 * их за общим utcTimezone, timezone_service.js, reset; так же решает
 * build.ts). Пояс из дерева объекта предпочитается базе IANA (Ж10: Яндекс
 * кладёт полное историческое описание), иначе — база (timezones.ts,
 * vtimezoneFor); неизвестное имя — отказ `unknown-timezone`.
 */
function frameForZone(tzid: string, c: ICAL.Component): Frame {
  if (!tzid.trim()) throw unknownTimezone(tzid);
  if (ICAL.TimezoneService.get(tzid) === ICAL.Timezone.utcTimezone) return { form: "utc" };
  const own = rootOf(c)
    ?.getAllSubcomponents("vtimezone")
    .find((zone) => String(zone.getFirstPropertyValue("tzid")) === tzid);
  let component: ICAL.Component;
  if (own) {
    component = own;
  } else {
    try {
      component = vtimezoneFor(tzid);
    } catch {
      throw unknownTimezone(tzid);
    }
  }
  // tzid в данных важнее TZID компонента (timezone.js, fromData).
  return { form: "zoned", zone: new ICAL.Timezone({ component, tzid }), tzid };
}

function unknownTimezone(tzid: string): EditRefusal {
  return new EditRefusal(
    "unknown-timezone",
    `Неизвестный часовой пояс ${JSON.stringify(tzid)}: нужен пояс IANA, например Europe/Moscow.`,
  );
}

function parseField(iso: string, field: string, zone: ZoneRef | undefined) {
  try {
    return parseModelTime(iso, zone);
  } catch (error) {
    if (error instanceof ModelTimeError) throw new EditRefusal("invalid-time", `${field}: ${error.message}`);
    throw error;
  }
}

/**
 * Дата у события на весь день — буквально из строки: `YYYY-MM-DD` или
 * полночь с любым смещением (Р10; как build.ts, literalDate). Время кроме
 * полуночи дату однозначно не задаёт — отказ.
 */
function literalDate(iso: string, field: string): ICAL.Time {
  const parsed = parseField(iso, field, undefined);
  const { year, month, day, hour, minute, second } = parsed.wall;
  if (parsed.kind !== "date" && (hour !== 0 || minute !== 0 || second !== 0)) {
    throw new EditRefusal(
      "invalid-time",
      `${field}: у события на весь день ожидается дата YYYY-MM-DD, получено ${iso}. Время кроме полуночи не определяет дату однозначно.`,
    );
  }
  return ICAL.Time.fromData({ year, month, day, isDate: true });
}

/** Время от модели в форме `frame` (О8, Р10). */
function parseIn(iso: string, field: string, frame: Frame, env: IcalEnv): ICAL.Time {
  if (frame.form === "date") return literalDate(iso, field);
  const zone = frame.form === "zoned" ? frame.zone : frame.form === "utc" ? ICAL.Timezone.utcTimezone : undefined;
  const parsed = parseField(iso, field, zone);
  if (parsed.kind === "date") {
    throw new EditRefusal(
      "invalid-time",
      `${field}: у события со временем нужно время, а не только дата ${iso}. Передайте ISO 8601 со временем или allDay: true.`,
    );
  }
  const value = timeInForm(parsed.time, frame.form, frame.zone, env);
  if (parsed.kind === "wall" && frame.form === "zoned") {
    // Стенное время из разрыва весеннего перевода RFC 5545 и ical.js читают
    // по-разному (values.ts, atInstant) — отказ, как у build.ts, timedValue.
    const actual = timeInForm(timeInForm(value, "utc", undefined, env), "zoned", frame.zone, env);
    const fields = ["year", "month", "day", "hour", "minute", "second"] as const;
    if (fields.some((name) => actual[name] !== parsed.wall[name])) {
      throw new EditRefusal(
        "invalid-time",
        `${field}: времени ${iso.slice(0, 16)} в поясе ${frame.tzid} нет — часы в этот день переводятся. Выберите другое время или передайте момент со смещением.`,
      );
    }
  }
  return value;
}

// Конец компонента: DTEND; иначе DTSTART + DURATION (ical.js, event.js,
// endDate); без того и другого — undefined (у даты конец — следующий день по
// RFC 5545 §3.6.1, но свойства конца нет, и писать его не нужно).
function endOf(start: ICAL.Time, dtend: ICAL.Property | null, duration: ICAL.Property | null): ICAL.Time | undefined {
  if (dtend) return (dtend.getFirstValue() as ICAL.Time).clone();
  const value = duration?.getFirstValue();
  if (!(value instanceof ICAL.Duration)) return undefined;
  const end = start.clone();
  end.addDuration(value); // time.js, addDuration: по полям, с нормализацией при чтении
  return end;
}

// Порядок двух значений: у дат — по дню, у времени — по моменту.
function compareTimes(a: ICAL.Time, b: ICAL.Time, env: IcalEnv): number {
  if (a.isDate && b.isDate) return Math.sign(dayNumber(a) - dayNumber(b));
  return Math.sign(instantOf(a, env) - instantOf(b, env));
}

// Номер дня по календарной дате, без пояса процесса (time.js, toUnixTime через Date.UTC).
function dayNumber(t: ICAL.Time): number {
  const midnight = ICAL.Time.fromData(
    { year: t.year, month: t.month, day: t.day, hour: 0, minute: 0, second: 0, isDate: false },
    ICAL.Timezone.utcTimezone,
  );
  return Math.round(midnight.toUnixTime() / 86_400);
}

function addDays(date: ICAL.Time, days: number): ICAL.Time {
  const next = ICAL.Time.fromData({ year: date.year, month: date.month, day: date.day, isDate: true });
  next.adjust(days, 0, 0, 0); // time.js, adjust: календарная арифметика
  return next;
}

// Время по секундам Unix в форме `frame` (time.js:1313, fromUnixTime — через
// UTC-поля, от пояса процесса не зависит).
function atSeconds(seconds: number, frame: Frame, env: IcalEnv): ICAL.Time {
  const utc = ICAL.Time.fromData(
    { year: 1970, month: 1, day: 1, hour: 0, minute: 0, second: 0, isDate: false },
    ICAL.Timezone.utcTimezone,
  );
  utc.fromUnixTime(seconds);
  return timeInForm(utc, frame.form, frame.zone, env);
}

/**
 * Конец, сдвинутый вместе с началом: у дат — на столько же дней, у времени —
 * на ту же точную длительность (RFC 5545 §3.8.5.3: при DTEND длительность
 * точная). Результат — в форме `frame`.
 */
function keepDuration(oldStart: ICAL.Time, oldEnd: ICAL.Time, start: ICAL.Time, frame: Frame, env: IcalEnv): ICAL.Time {
  if (start.isDate && oldStart.isDate && oldEnd.isDate) return addDays(start, dayNumber(oldEnd) - dayNumber(oldStart));
  const seconds = (instantOf(oldEnd, env) - instantOf(oldStart, env)) / 1000;
  return atSeconds(instantOf(start, env) / 1000 + seconds, frame, env);
}

// Пояс, в котором у события со временем читается его дата: свой у zoned,
// календаря у UTC и плавающего.
function dateZone(frame: Frame, env: IcalEnv): ZoneRef {
  return frame.form === "zoned" && frame.zone !== undefined ? frame.zone : env.floatingZone;
}

// Дата события со временем — стенная дата его начала (у UTC — в поясе календаря).
function dateOfTimed(t: ICAL.Time, frame: Frame, env: IcalEnv): ICAL.Time {
  const date = frame.form === "floating" ? wallDateOf(t, env) : wallDateOf(t, env, dateZone(frame, env));
  const [year, month, day] = date.split("-").map(Number);
  return ICAL.Time.fromData({ year, month, day, isDate: true });
}

// Сколько дней затрагивает событие со временем при переходе на «весь день»:
// от даты начала до дня после последнего затронутого (конец в полночь дня не
// затрагивает), не меньше одного. Даты — в поясе события (у UTC и
// плавающего — календаря), как у `dateOfTimed`. Новый конец — новое начало
// плюс столько же дней (О8: start без end сохраняет длительность).
function allDaySpan(oldStart: ICAL.Time, oldEnd: ICAL.Time, frame: Frame, env: IcalEnv): number {
  const first = dateOfTimed(oldStart, frame, env);
  const wall =
    frame.form === "floating" ? timeInForm(oldEnd, "floating", undefined, env) : timeInForm(oldEnd, "zoned", dateZone(frame, env), env);
  let end = ICAL.Time.fromData({ year: wall.year, month: wall.month, day: wall.day, isDate: true });
  if (wall.hour !== 0 || wall.minute !== 0 || wall.second !== 0) end = addDays(end, 1);
  return Math.max(1, dayNumber(end) - dayNumber(first));
}

// DURATION между началом и концом: у дат — днями (P7D, а не P1W), у времени —
// точными секундами (duration.js, fromSeconds).
function durationBetween(start: ICAL.Time, end: ICAL.Time, env: IcalEnv): ICAL.Duration {
  if (start.isDate && end.isDate) return ICAL.Duration.fromData({ days: dayNumber(end) - dayNumber(start) });
  return ICAL.Duration.fromSeconds((instantOf(end, env) - instantOf(start, env)) / 1000);
}

// Значение свойства совпадает с `time` в записи: форма, jCal-строка и TZID.
function sameTimeValue(property: ICAL.Property, time: ICAL.Time): boolean {
  let raw: unknown = property.jCal[3];
  if (Array.isArray(raw)) raw = raw[0];
  const form = formOf(property);
  if (form !== formOf(time) || String(raw) !== time.toString()) return false;
  return form !== "zoned" || String(property.getParameter("tzid")) === time.zone.tzid;
}

// ─────────────────────────────── клон основного (О6) ───────────────────────────────

/** Свойства серии, которых у переопределения не бывает. */
const SERIES_ONLY = ["rrule", "rdate", "exdate", "exrule"] as const;

/**
 * Переопределение слота из основного компонента (О6): копия всего, кроме
 * RRULE, RDATE, EXDATE, EXRULE; DTSTART = RECURRENCE-ID = время слота в форме
 * серии (О4). Конец — в форме основного:
 * - при DURATION — только DURATION (у слота из RDATE;VALUE=PERIOD —
 *   длительность периода), DTEND снимается, если был;
 * - при DTEND — DTEND = слот + точная длительность основного (у PERIOD — его
 *   конец), в форме и поясе DTEND основного;
 * - без конца — без конца (у PERIOD — DURATION периода).
 * Всё прочее — участники, VALARM, X-свойства, SEQUENCE, CREATED — копируется
 * как есть; метаданные обновляет `touchMetadata` по решению планировщика.
 * Клон добавляется в VCALENDAR объекта и возвращается; VTIMEZONE для TZID
 * его значений добавляется, если объект их не описывал (О12а).
 */
export function overrideFromMaster(o: CalendarObject, slot: Slot, touched?: Touched): ICAL.Component {
  const master = o.master;
  if (!master) throw new Error("У объекта нет основного компонента: переопределение слота не из чего сделать.");
  const env = o.env;
  const clone = cloneComponent(master);
  for (const name of SERIES_ONLY) {
    for (const property of clone.getAllProperties(name)) clone.removeProperty(property);
  }

  const start = slot.time.clone();
  const written = [setTimeProperty(clone, "dtstart", start), setTimeProperty(clone, "recurrence-id", start)];

  // Значения времени читаются у основного, а не у клона: клон ещё вне
  // дерева, и его TZID ical.js искал бы не в VTIMEZONE объекта, а в
  // глобальном TimezoneService (см. cloneComponent).
  const masterStart = master.getFirstPropertyValue("dtstart") as ICAL.Time;
  const masterEnd = master.getFirstProperty("dtend");
  const duration = clone.getFirstProperty("duration");
  const dtend = clone.getFirstProperty("dtend");
  if (duration) {
    if (dtend) clone.removeProperty(dtend);
    if (slot.periodEnd) duration.setValue(durationBetween(start, slot.periodEnd, env));
  } else if (dtend && masterEnd) {
    const frame = frameOfProperty(masterEnd, env);
    const end = slot.periodEnd
      ? timeInForm(slot.periodEnd, frame.form, frame.zone, env)
      : keepDuration(masterStart, masterEnd.getFirstValue() as ICAL.Time, start, frame, env);
    written.push(setTimeProperty(clone, "dtend", end));
  } else if (slot.periodEnd) {
    clone.addPropertyWithValue("duration", durationBetween(start, slot.periodEnd, env));
  }

  o.root.addSubcomponent(clone);
  markComponent(touched, o.root, clone);
  addTimezones(clone, written, touched);
  return clone;
}

// ─────────────────────────────── наследование (О7) ───────────────────────────────

/**
 * Переносит правку основного на переопределение (О7): поле переопределения
 * меняется, только если совпадало со значением старого основного `oldMaster`
 * (снимок до правки, `cloneComponent`), и получает значение нового `newMaster`.
 * - summary, description, location — по тексту;
 * - attendees — по множеству «адрес и PARTSTAT»: совпало — не названные
 *   новым основным снимаются, у остальных PARTSTAT становится как у него,
 *   недостающие копируются из него; параметры имеющихся (CN, ROLE) целы;
 * - reminders — по управляемым VALARM (DISPLAY и EMAIL от начала): совпали —
 *   приводятся к новому основному, чужие VALARM целы.
 * Время и правило здесь не наследуются: неперенесённые встречи сдвигает
 * планировщик (Р1). Возвращает изменившиеся поля в порядке PATCH_FIELDS.
 */
export function inheritFields(
  ovr: ICAL.Component,
  oldMaster: ICAL.Component,
  newMaster: ICAL.Component,
  fields: Iterable<PatchField>,
  touched?: Touched,
): PatchField[] {
  const wanted = new Set(fields);
  const changed = new Set<PatchField>();

  for (const field of ["summary", "description", "location"] as const) {
    if (!wanted.has(field)) continue;
    const own = textValue(ovr, field);
    if (own !== textValue(oldMaster, field)) continue;
    const next = textValue(newMaster, field) ?? "";
    if (next === (own ?? "")) continue;
    if (setText(ovr, field, next, touched)) changed.add(field);
  }

  if (wanted.has("attendees") && sameList(attendeeKeys(ovr), attendeeKeys(oldMaster))) {
    if (syncAttendees(ovr, newMaster, touched)) changed.add("attendees");
  }

  if (wanted.has("reminders") && sameList(alarmKeys(ovr), alarmKeys(oldMaster))) {
    const pending = newMaster
      .getAllSubcomponents("valarm")
      .flatMap((alarm) => {
        const key = managedAlarmKey(alarm);
        return key === undefined ? [] : [{ key, make: () => cloneComponent(alarm) }];
      });
    if (syncAlarms(ovr, pending, touched)) changed.add("reminders");
  }

  return PATCH_FIELDS.filter((field) => changed.has(field));
}

// Равенство списков как мультимножеств.
function sameList(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((value, index) => value === right[index]);
}

function attendeeKeys(c: ICAL.Component): string[] {
  return c.getAllProperties("attendee").map((property) => `${addressKey(property.getFirstValue())}|${partstatOf(property)}`);
}

function alarmKeys(c: ICAL.Component): string[] {
  return c.getAllSubcomponents("valarm").flatMap((alarm) => {
    const key = managedAlarmKey(alarm);
    return key === undefined ? [] : [key];
  });
}

// Участники переопределения — как у нового основного, по адресу: параметры
// имеющихся целы, PARTSTAT — как у основного, недостающие — копии его свойств.
function syncAttendees(ovr: ICAL.Component, master: ICAL.Component, touched: Touched | undefined): boolean {
  const target = new Map(master.getAllProperties("attendee").map((property) => [addressKey(property.getFirstValue()), property]));
  const present = new Set<string>();
  let changed = false;
  for (const property of ovr.getAllProperties("attendee")) {
    const key = addressKey(property.getFirstValue());
    const source = target.get(key);
    if (!source) {
      ovr.removeProperty(property);
      markProperty(touched, ovr, property);
      changed = true;
      continue;
    }
    present.add(key);
    if (partstatOf(property) !== partstatOf(source)) {
      property.setParameter("partstat", partstatOf(source));
      markProperty(touched, ovr, property);
      changed = true;
    }
  }
  for (const [key, source] of target) {
    if (present.has(key)) continue;
    const copy = new ICAL.Property(ICAL.helpers.clone(source.jCal, true));
    ovr.addProperty(copy);
    markProperty(touched, ovr, copy);
    changed = true;
  }
  return changed;
}

// ─────────────────────────────── метаданные (О10) ───────────────────────────────

/**
 * Метаданные изменённого компонента (О10):
 * - DTSTAMP — `now` в UTC (свойство обязательно по RFC 5545 §3.6.1; нет —
 *   добавляется);
 * - LAST-MODIFIED — `now` в UTC, только если свойство уже есть;
 * - SEQUENCE +1, только если оно уже есть, правка значимая (менялись
 *   DTSTART, DTEND, DURATION, RRULE, RDATE или EXDATE — решает вызывающий
 *   код) и ORGANIZER нет или он равен владельцу `env.ownerEmail` (Ж9:
 *   Яндекс сам ставит ORGANIZER владельца своим событиям; Ж11: SEQUENCE
 *   увеличивает клиент). Отсутствующий SEQUENCE не добавляется: у чужой
 *   встречи номер версии ведёт её организатор.
 */
export function touchMetadata(
  c: ICAL.Component,
  now: Date | number,
  significant: boolean,
  env: IcalEnv,
  touched?: Touched,
): void {
  const stamp = utcStamp(now);
  markProperty(touched, c, setTimeProperty(c, "dtstamp", stamp));
  if (c.getFirstProperty("last-modified")) markProperty(touched, c, setTimeProperty(c, "last-modified", stamp));

  if (!significant || !ownOrganizer(c, env)) return;
  const sequence = c.getFirstProperty("sequence");
  if (!sequence) return;
  const value = Number(sequence.getFirstValue());
  if (!Number.isInteger(value) || value < 0) return;
  sequence.setValue(value + 1);
  markProperty(touched, c, sequence);
}

// Свой ORGANIZER — адрес владельца `env.ownerEmail` без учёта регистра и
// mailto:. Сравнивается полный адрес: env собирает оркестрация (З13), и
// ownerEmail обязан быть логином с доменом (name@yandex.ru). Логин без домена
// здесь не совпадёт ни с одним ORGANIZER, и SEQUENCE своей встречи не вырастет.
function ownOrganizer(c: ICAL.Component, env: IcalEnv): boolean {
  const organizers = c.getAllProperties("organizer");
  if (organizers.length === 0) return true;
  if (!env.ownerEmail) return false;
  const owner = addressKey(env.ownerEmail);
  return organizers.some((property) => addressKey(property.getFirstValue()) === owner);
}

// Момент в UTC из секунд Unix (time.js, fromUnixTime — UTC-поля Date, от
// пояса процесса не зависит); ICAL.Time.now() берёт местные поля.
function utcStamp(now: Date | number): ICAL.Time {
  const ms = typeof now === "number" ? now : now.getTime();
  if (!Number.isFinite(ms)) throw new Error("Часы для DTSTAMP вернули недопустимый момент.");
  const stamp = ICAL.Time.fromData(
    { year: 1970, month: 1, day: 1, hour: 0, minute: 0, second: 0, isDate: false },
    ICAL.Timezone.utcTimezone,
  );
  stamp.fromUnixTime(Math.floor(ms / 1000));
  return stamp;
}

// ─────────────────────────────── правило (Р4) ───────────────────────────────

const FREQUENCIES: Record<RecurrenceFrequency, string> = {
  daily: "DAILY",
  weekly: "WEEKLY",
  monthly: "MONTHLY",
  yearly: "YEARLY",
};

/** Части, которые Яндекс молча искажает (docs/yandex-caldav-capabilities.md, Ж6). */
const DISTORTED_PARTS: Record<string, string> = {
  bysetpos: "BYSETPOS Яндекс молча заменяет другим правилом (например, «последний рабочий день месяца» — «последним четвергом»)",
  wkst: "WKST Яндекс выбрасывает, и у правил с шагом больше недели меняются даты",
};

const RULE_PATCH_KEYS: ReadonlySet<string> = new Set(["frequency", "interval", "byWeekday", "until", "count", "replace"]);

/**
 * Части правила, которые Яндекс искажает (Ж6), в порядке правила: "BYSETPOS",
 * "WKST". Планировщик решает по ним, можно ли писать объект с таким правилом.
 */
export function distortedParts(p: ICAL.Property): string[] {
  return Object.keys(ruleDict(p))
    .filter((key) => Object.hasOwn(DISTORTED_PARTS, key))
    .map((key) => key.toUpperCase());
}

export interface RuleContext {
  env: IcalEnv;
  touched?: Touched;
  /** Форма, пояс и начало серии для UNTIL (О4). По умолчанию — из DTSTART компонента правила. */
  form?: TimeForm;
  zone?: ZoneRef;
  dtstart?: ICAL.Time;
}

export interface RulePatchResult {
  /** Правило изменилось. */
  changed: boolean;
  /** Части прежнего правила, которых нет после `replace`, дословно ("BYSETPOS=-1"), по порядку. */
  lostParts: string[];
}

/**
 * Правит RRULE на месте по патчу повтора (Р4): меняются только переданные
 * FREQ, INTERVAL, BYDAY, COUNT, UNTIL, прочие части — в том числе неизвестные
 * модели (BYMONTHDAY, BYMONTH, RSCALE, X-…) — остаются дословно и на своих
 * местах; словарь правится через `ruleDict` и `setRuleDict` (values.ts), а не
 * через ICAL.Recur, который неизвестные части теряет.
 * - `null` снимает часть; COUNT и UNTIL заменяют друг друга на том же месте;
 * - UNTIL — в форме DTSTART (О4): дата, момент в UTC или плавающее время;
 *   раньше DTSTART — отказ `invalid-rule`;
 * - BYDAY проверяется по RFC 5545 и по тому, как его читает ical.js (как в
 *   build.ts), когда патч задаёт BYDAY или частоту;
 * - `replace` собирает правило только из патча; потерянные части — в
 *   `lostParts` (подтверждение confirm требует планировщик);
 * - BYSETPOS и WKST (Ж6): ввести их патчем нельзя, а правка правила, в
 *   котором они уже есть, записала бы то, что Яндекс исказит, — отказ
 *   `unsupported-rule` с подсказкой про replace;
 * - изменённое правило обязано остаться правилом RFC 5545 §3.3.10, которое
 *   раскрывает ical.js: части, недопустимые при новой частоте (BYMONTHDAY
 *   при weekly, BYYEARDAY при daily, weekly и monthly, BYWEEKNO не при
 *   yearly, BYDAY с номером при BYWEEKNO), — отказ `invalid-rule` с
 *   подсказкой про replace; затем пробный проход итератора, как у loadObject
 *   (slots.ts, probeRules): ошибка итератора или ни одной позиции — тоже
 *   `invalid-rule`, иначе объект после записи блокировался бы аномалией
 *   bad-rrule или no-positions (О14).
 * Правило, которое патч не меняет, не проверяется и не трогается. Отказ
 * оставляет свойство нетронутым.
 */
export function patchRule(p: ICAL.Property, rp: RecurrencePatch, ctx: RuleContext): RulePatchResult {
  checkRuleKeys(rp);
  const old = Object.entries(ruleDict(p));
  const had = new Map(old);

  if (rp.frequency !== undefined && !Object.hasOwn(FREQUENCIES, rp.frequency)) {
    throw invalidRule(`частота ${JSON.stringify(rp.frequency)} не поддерживается: допустимы daily, weekly, monthly, yearly.`);
  }
  if (rp.interval !== undefined && rp.interval !== null && (!Number.isInteger(rp.interval) || rp.interval < 1)) {
    throw invalidRule(`interval — целое число от 1, получено ${String(rp.interval)}.`);
  }
  if (rp.count !== undefined && rp.count !== null && (!Number.isInteger(rp.count) || rp.count < 1)) {
    throw invalidRule(`count — целое число от 1, получено ${String(rp.count)}.`);
  }
  if (rp.count !== undefined && rp.count !== null && rp.until !== undefined && rp.until !== null) {
    throw invalidRule("count и until вместе недопустимы (RFC 5545 §3.3.10): задайте что-то одно.");
  }
  if (rp.byWeekday !== undefined && rp.byWeekday !== null && !Array.isArray(rp.byWeekday)) {
    throw invalidRule("byWeekday — список дней недели.");
  }
  const byday = rp.byWeekday === undefined ? undefined : rp.byWeekday === null || rp.byWeekday.length === 0 ? null : rp.byWeekday;
  // DTSTART серии читается, только когда нужен (UNTIL, проба изменённого
  // правила): патч, который правила не меняет, ничего не читает и не кеширует.
  let series: SeriesTime | undefined | null = null;
  const seriesTime = () => (series === null ? (series = seriesOf(p, ctx)) : series);
  const until = rp.until === undefined || rp.until === null ? rp.until : untilFor(rp.until, requireSeries(seriesTime()), ctx.env);
  const freq = rp.frequency === undefined ? undefined : FREQUENCIES[rp.frequency];

  let next: Array<[string, RuleValue]>;
  if (rp.replace) {
    next = [["freq", freq ?? String(had.get("freq"))]];
    if (typeof rp.interval === "number") next.push(["interval", rp.interval]);
    if (byday) next.push(["byday", bydayValue(byday)]);
    if (typeof rp.count === "number") next.push(["count", rp.count]);
    if (typeof until === "string") next.push(["until", until]);
  } else {
    next = [...old];
    const set = (key: string, value: RuleValue | null) => {
      const index = next.findIndex(([name]) => name === key);
      if (value === null) {
        if (index >= 0) next.splice(index, 1);
      } else if (index >= 0) next[index] = [key, value];
      else next.push([key, value]);
    };
    if (freq !== undefined) set("freq", freq);
    if (rp.interval === null) set("interval", null);
    else if (rp.interval !== undefined && !(rp.interval === 1 && !had.has("interval"))) set("interval", rp.interval);
    if (byday === null) set("byday", null);
    else if (byday !== undefined && !sameDays(had.get("byday"), byday)) set("byday", bydayValue(byday));
    const end = (key: "count" | "until", value: RuleValue | null) => {
      const other = key === "count" ? "until" : "count";
      const index = next.findIndex(([name]) => name === other);
      if (value !== null && index >= 0) next[index] = [key, value];
      else set(key, value);
    };
    if (rp.count !== undefined) end("count", rp.count);
    if (until !== undefined) end("until", until);
  }

  if (byday !== undefined || freq !== undefined) {
    const dict = new Map(next);
    const days = dict.get("byday");
    const frequency = String(dict.get("freq"));
    for (const day of days === undefined ? [] : Array.isArray(days) ? days : [days]) checkedByday(String(day), frequency);
  }

  if (sameEntries(old, next)) return { changed: false, lostParts: [] };

  const lostParts = rp.replace ? old.filter(([key]) => !next.some(([name]) => name === key)).map(([key, value]) => partText(key, value)) : [];
  if (!rp.replace) {
    const distorted = next.map(([key]) => key).filter((key) => Object.hasOwn(DISTORTED_PARTS, key));
    if (distorted.length > 0) {
      const names = distorted.map((key) => key.toUpperCase());
      throw new EditRefusal(
        "unsupported-rule",
        `Правило серии содержит ${names.join(" и ")}: ${distorted.map((key) => DISTORTED_PARTS[key]).join("; ")}. ` +
          "Правка такого правила не записывается: Яндекс молча исказил бы расписание. " +
          "Правило можно только задать заново целиком (recurrence с replace: true).",
        {
          hint:
            "Задайте правило заново: recurrence с replace: true и нужными frequency, interval, byWeekday, count или until; " +
            `части ${names.join(" и ")} будут потеряны, это требует confirm.`,
        },
      );
    }
  }
  checkRuleParts(next);
  const probeSeries = seriesTime();
  if (probeSeries) probeRule(next, probeSeries, ctx.env);

  setRuleDict(p, Object.fromEntries(next) as RuleDictInput);
  const parent = p.parent;
  if (parent) markProperty(ctx.touched, parent, p);
  return { changed: true, lostParts };
}

const REPLACE_HINT =
  "Задайте правило заново: recurrence с replace: true и нужными frequency, interval, byWeekday, count или until; " +
  "части прежнего правила, которых нет в патче, будут потеряны, это требует confirm.";

// Частота правила для текста отказа: как в модели (weekly), прочие — как в правиле.
function frequencyName(freq: string): string {
  const entry = Object.entries(FREQUENCIES).find(([, value]) => value === freq);
  return entry ? entry[0] : freq;
}

/**
 * Совместимость частей правила с частотой по RFC 5545 §3.3.10 (те же запреты
 * проверяет init итератора ical.js, recur_iterator.js:221-252, кроме номера
 * BYDAY при BYWEEKNO, который ical.js молча раскрывает по-своему):
 * - BYWEEKNO — только при YEARLY;
 * - BYYEARDAY — не при DAILY, WEEKLY и MONTHLY;
 * - BYMONTHDAY — не при WEEKLY;
 * - BYDAY с номером — не при YEARLY вместе с BYWEEKNO.
 * Патч меняет лишь FREQ, INTERVAL, BYDAY и конец, так что нарушение — это
 * смена частоты или BYDAY при части, которую модель не показывает.
 */
function checkRuleParts(next: ReadonlyArray<[string, RuleValue]>): void {
  const dict = new Map(next);
  const freq = String(dict.get("freq")).toUpperCase();
  const refuse = (key: string, reason: string): never => {
    throw new EditRefusal(
      "invalid-rule",
      `Правило повтора: ${reason} (RFC 5545 §3.3.10), а в правиле серии есть ${partText(key, dict.get(key)!)}. ` +
        "Правка оставляет прочие части правила как есть, поэтому такое правило не записывается.",
      { hint: REPLACE_HINT },
    );
  };
  const name = frequencyName(freq);
  if (dict.has("byweekno") && freq !== "YEARLY") refuse("byweekno", `при частоте ${name} часть BYWEEKNO недопустима, она бывает только при yearly`);
  if (dict.has("byyearday") && ["DAILY", "WEEKLY", "MONTHLY"].includes(freq)) {
    refuse("byyearday", `при частоте ${name} часть BYYEARDAY недопустима`);
  }
  if (dict.has("bymonthday") && freq === "WEEKLY") refuse("bymonthday", "при частоте weekly часть BYMONTHDAY (числа месяца) недопустима");
  if (dict.has("byweekno") && freq === "YEARLY") {
    const days = dict.get("byday");
    const list = days === undefined ? [] : Array.isArray(days) ? days : [days];
    if (list.some((day) => /\d/.test(String(day)))) refuse("byweekno", "день недели с номером (например, 1MO) недопустим вместе с BYWEEKNO");
  }
}

/**
 * Пробный проход итератора по изменённому правилу — тот же, что у
 * loadObject (slots.ts, probeRules): на отдельном VEVENT с DTSTART серии и
 * этим правилом. DTSTART записывается значением с уже известным поясом
 * (values.ts, setTimeProperty кеширует объект значения), так что компонент
 * без дерева пояс по TZID не ищет. Ошибка итератора или правило без позиций —
 * отказ `invalid-rule`.
 */
function probeRule(next: ReadonlyArray<[string, RuleValue]>, series: SeriesTime, env: IcalEnv): void {
  const probe = new ICAL.Component("vevent");
  setTimeProperty(probe, "dtstart", series.dtstart);
  const rule = new ICAL.Property("rrule");
  setRuleDict(rule, Object.fromEntries(next) as RuleDictInput);
  probe.addProperty(rule);
  const [result] = probeRules(probe, env);
  if (!result || result.outcome === "ok") return;
  const text = rule.toICALString().replace(/^RRULE:/, "");
  if (result.outcome === "no-positions") {
    throw new EditRefusal(
      "invalid-rule",
      `Правило повтора после правки (${text}) не даёт ни одной даты, серия свелась бы к одному началу: ${result.message ?? "позиций нет"}.`,
      { hint: "Проверьте until, byWeekday и частоту: серия должна продолжаться хотя бы одной встречей по правилу." },
    );
  }
  throw new EditRefusal("invalid-rule", `Правило повтора после правки (${text}) не раскрывается: ${result.message ?? "ошибка итератора"}.`, {
    hint: REPLACE_HINT,
  });
}

/**
 * Ставит конец правила — COUNT или UNTIL — на место прежнего конца (или в
 * конец частей, если правило было бесконечным); прочие части целы. UNTIL —
 * jCal-строка (например, из `untilBefore`, values.ts) или ICAL.Time: время с
 * поясом переводится в UTC (setRuleDict). Возвращает, изменилось ли правило.
 */
export function setRuleEnd(p: ICAL.Property, end: { count: number } | { until: string | ICAL.Time }, touched?: Touched): boolean {
  let entry: [string, RuleValue | ICAL.Time];
  if ("count" in end) {
    if (!Number.isInteger(end.count) || end.count < 1) throw new Error(`COUNT — целое число от 1, получено ${String(end.count)}.`);
    entry = ["count", end.count];
  } else {
    entry = ["until", end.until];
  }
  const next: Array<[string, RuleValue | ICAL.Time]> = [];
  let placed = false;
  for (const [key, value] of Object.entries(ruleDict(p))) {
    if (key === "count" || key === "until") {
      if (!placed) next.push(entry);
      placed = true;
      continue;
    }
    next.push([key, value]);
  }
  if (!placed) next.push(entry);

  // Сравнение после нормализации UNTIL (setRuleDict) — на копии свойства.
  const probe = new ICAL.Property(ICAL.helpers.clone(p.jCal, true));
  setRuleDict(probe, Object.fromEntries(next) as RuleDictInput);
  if (JSON.stringify(probe.jCal[3]) === JSON.stringify(p.jCal[3])) return false;
  setRuleDict(p, Object.fromEntries(next) as RuleDictInput);
  const parent = p.parent;
  if (parent) markProperty(touched, parent, p);
  return true;
}

function checkRuleKeys(rp: RecurrencePatch): void {
  const raw = rp as RecurrencePatch & { unmodeled?: unknown };
  if (typeof raw.unmodeled === "string" && raw.unmodeled) {
    const names = raw.unmodeled.split(";").map((part) => part.split("=")[0].trim().toLowerCase());
    const distorted = [...new Set(names.filter((name) => Object.hasOwn(DISTORTED_PARTS, name)))];
    if (distorted.length > 0) {
      throw new EditRefusal(
        "unsupported-rule",
        `Правило с ${distorted.map((name) => name.toUpperCase()).join(" и ")} не записывается: ` +
          `${distorted.map((name) => DISTORTED_PARTS[name]).join("; ")}.`,
        { hint: "Выразите повтор без этих частей или создайте несколько событий." },
      );
    }
    throw new EditRefusal(
      "unsupported-rule",
      `Части правила вне модели (${raw.unmodeled}) правка не вводит: используйте frequency, interval, byWeekday, until и count.`,
    );
  }
  const unknown = Object.entries(rp)
    .filter(([key, value]) => value !== undefined && key !== "unmodeled" && !RULE_PATCH_KEYS.has(key))
    .map(([key]) => key);
  if (unknown.length > 0) {
    throw new EditRefusal(
      "unsupported-rule",
      `Части повтора ${unknown.join(", ")} правка не знает: допустимы frequency, interval, byWeekday, until, count и replace.`,
    );
  }
}

function invalidRule(detail: string): EditRefusal {
  return new EditRefusal("invalid-rule", `Правило повтора: ${detail}`);
}

// Как у разборщика: одно значение — строкой, несколько — списком (recur.js, _stringToData).
function bydayValue(days: readonly string[]): RuleValue {
  return days.length === 1 ? days[0] : [...days];
}

function sameDays(current: RuleValue | undefined, days: readonly string[]): boolean {
  if (current === undefined) return false;
  const list = (Array.isArray(current) ? current : [current]).map(String);
  return sameList(list, [...days]);
}

function sameEntries(a: ReadonlyArray<[string, RuleValue]>, b: ReadonlyArray<[string, RuleValue]>): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// Часть правила текстом, как в RRULE (design.js, recur.toICAL: WKST числом —
// днём недели, списки через запятую, UNTIL — DATE или DATE-TIME).
function partText(key: string, value: RuleValue): string {
  return new ICAL.Property(["rrule", {}, "recur", { [key]: value }]).toICALString().replace(/^RRULE:/, "");
}

// BYDAY: день с необязательным порядковым номером со знаком (RFC 5545 §3.3.10).
const BYDAY_PATTERN = /^([+-]?)(\d+)?(MO|TU|WE|TH|FR|SA|SU)$/;

/**
 * Значение BYDAY, которое и RFC 5545, и ical.js читают одинаково — те же
 * правила, что у сборки нового события (build.ts, checkedByday): номер —
 * только при MONTHLY (±1…5) и YEARLY (±1…9: итератор ical.js 2.2.1 читает у
 * номера одну цифру, recur_iterator.js, ruleDayOfWeek), без ведущих нулей.
 */
function checkedByday(value: string, freq: string): void {
  const match = BYDAY_PATTERN.exec(value);
  if (!match) {
    throw invalidRule(`byWeekday: ${JSON.stringify(value)} — не день недели (MO…SU) с необязательным номером вроде 2MO или -1FR.`);
  }
  const [, sign, ordinal] = match;
  if (ordinal === undefined) {
    if (sign) throw invalidRule(`byWeekday: ${JSON.stringify(value)} — знак без номера.`);
    return;
  }
  if (freq !== "MONTHLY" && freq !== "YEARLY") {
    throw invalidRule(`byWeekday: номер дня (${value}) допустим только при monthly и yearly.`);
  }
  const number = Number(ordinal);
  if (number < 1 || ordinal.startsWith("0")) {
    throw invalidRule(`byWeekday: номер дня в ${value} — целое число от 1 без ведущих нулей, например 2MO или -1FR.`);
  }
  if (freq === "MONTHLY" && number > 5) {
    throw invalidRule(`byWeekday: номер дня в ${value} при monthly должен быть от 1 до 5: в месяце не больше пяти одинаковых дней недели.`);
  }
  if (freq === "YEARLY" && number > 9) {
    throw invalidRule(
      `byWeekday: номер дня в ${value} при yearly должен быть от 1 до 9: ical.js, которой сервер раскрывает серии, ` +
        "читает у номера BYDAY только одну цифру (recur_iterator.js, ruleDayOfWeek).",
    );
  }
}

interface SeriesTime {
  form: TimeForm;
  zone?: ZoneRef;
  dtstart: ICAL.Time;
}

/**
 * Форма, пояс и начало серии: из контекста или из DTSTART компонента правила;
 * без того и другого — undefined. Компонент правила должен стоять в дереве
 * объекта (см. cloneComponent): иначе значение DTSTART с TZID ical.js прочтёт
 * не по VTIMEZONE объекта; для такой копии передавайте form, zone и dtstart.
 */
function seriesOf(p: ICAL.Property, ctx: RuleContext): SeriesTime | undefined {
  const dtstart = p.parent?.getFirstProperty("dtstart");
  if ((!ctx.form || !ctx.dtstart) && !dtstart) return undefined;
  const form = ctx.form ?? formOf(dtstart!);
  return {
    form,
    zone: ctx.zone ?? (dtstart ? seriesZoneOf(dtstart, ctx.env) : undefined),
    dtstart: ctx.dtstart ?? (dtstart!.getFirstValue() as ICAL.Time),
  };
}

function requireSeries(series: SeriesTime | undefined): SeriesTime {
  if (!series) throw new Error("Для UNTIL нужна форма DTSTART серии: у правила нет компонента с DTSTART, передайте form и dtstart.");
  return series;
}

/**
 * UNTIL из патча — jCal-строка в форме DTSTART (О4, RFC 5545 §3.3.10), как
 * у сборки нового события (build.ts, untilValue): у серии на весь день —
 * дата; у серии со временем дата — весь этот день в поясе серии, стенное
 * время — в поясе серии, момент — как есть; с поясом и в UTC — момент в UTC
 * (`…Z`), у плавающей серии — плавающее стенное время. Раньше DTSTART —
 * отказ: серия из одного DTSTART — не то, что просили (Р2).
 */
function untilFor(iso: string, series: SeriesTime, env: IcalEnv): string {
  const field = "recurrence.until";
  if (typeof iso !== "string") throw new EditRefusal("invalid-time", `${field} — строка с датой или временем.`);
  let until: ICAL.Time;
  if (series.form === "date") {
    until = literalDate(iso, field);
  } else {
    const frame: Frame = { form: series.form, zone: series.zone, tzid: series.form === "zoned" ? zoneName(series.zone) : undefined };
    const parsed = parseField(iso, field, series.form === "zoned" ? series.zone : series.form === "utc" ? ICAL.Timezone.utcTimezone : undefined);
    const local =
      parsed.kind === "date"
        ? parseIn(`${parsed.date}T23:59:59`, field, frame, env)
        : parseIn(iso, field, frame, env);
    until = series.form === "floating" ? local : timeInForm(local, "utc", undefined, env);
  }
  if (compareTimes(until, series.dtstart, env) < 0) {
    throw invalidRule(`until (${iso}) раньше начала серии: в ней не было бы ни одной встречи после первой.`);
  }
  return until.toString();
}

function zoneName(zone: ZoneRef | undefined): string | undefined {
  if (zone === undefined) return undefined;
  return typeof zone === "string" ? zone : zone.tzid;
}
