import ICAL from "ical.js";
import type {
  Attendee,
  CalendarEvent,
  EventException,
  EventStatus,
  Recurrence,
  RecurrenceFrequency,
  Reminder,
} from "../types.js";
import {
  formatAnomaly,
  meetingAt,
  shownOverride,
  splitContentLine,
  type CalendarObject,
  type EditOp,
  type OverrideRef,
} from "./object.js";
import { SERIES_CAP, SlotScanError, findSlot, iterateSlots, type Slot } from "./slots.js";
import {
  ModelTimeError,
  compareSlotKeys,
  formOf,
  formatForModel,
  instantOf,
  listEntries,
  listKeys,
  parseModelTime,
  slotKeyOf,
  timeInForm,
  type IcalEnv,
  type ModelTime,
  type SlotKey,
  type ZoneRef,
} from "./values.js";

/**
 * Встречи календарного объекта и их адреса (Р5–Р7, Р10 плана переделки,
 * docs/superpowers/plans/2026-09-19-recurring-events-rework.md, задача З07).
 *
 * Встреча показывается ровно одним из трёх путей — прохода «по всем
 * исключениям» нет:
 * - незакрытый слот серии (object.ts, slots.ts): основной компонент, его
 *   переопределение с ролью slot (у дублей — `shownOverride`) или сдвиг
 *   переопределения RANGE=THISANDFUTURE;
 * - переопределение с ролью detached — отдельной встречей по своему
 *   RECURRENCE-ID;
 * - hidden не показывается: оно есть только в `hiddenOverrides` и в
 *   `exceptions` у get_event.
 * Роли — ровно три (поправка «без ремонта следов прежнего кода»): slot,
 * hidden, detached.
 *
 * Адрес встречи (`instanceStart`) — её слот: RECURRENCE-ID одинаков у
 * перенесённой и неперенесённой встречи. Окно выдачи и сортировка — по
 * фактическому времени: перенесённая внутрь окна встреча в выдаче есть, её
 * исходный слот — нет (Р10, Ж17).
 *
 * Пояс процесса не участвует: моменты — через values.ts (`instantOf`),
 * значения в форме серии — `timeInForm` (О4), вывод — `formatForModel`.
 *
 * Известный дефект ключей (values.ts), здесь не исправляется и не
 * маскируется: в повторный осенний час RECURRENCE-ID другого клиента,
 * записанный в UTC на первое вхождение часа, не совпадает с ключом слота
 * ical.js (второе вхождение). Такое переопределение — detached, и встреча
 * видна дважды: отдельно и обычным слотом. При чтении данные не теряются,
 * но адресация этой пары сломана. У detached и у слота один и тот же
 * `instanceStart`: адрес detached приводится к стенному времени серии
 * (Berlin, RID 20261025T003000Z → «2026-10-25T02:30:00+01:00»), а ical.js
 * читает это время как второе вхождение часа, то есть как слот. Поэтому:
 * - `resolveTarget` по этой строке всегда выбирает слот. Если detached
 *   начинается в своём RECURRENCE-ID, неоднозначность не находится (ключ его
 *   начала T:…00:30Z, ключ слота T:…01:30Z), и delete по адресу, показанному
 *   у detached, молча снимает слот (EXDATE), а detached остаётся;
 * - если detached перенесён на время слота, отказ ambiguous приходит с двумя
 *   одинаковыми адресами, и подсказка «передайте instanceStart
 *   перенесённой» ведёт снова к слоту;
 * - сам detached достижим только по моменту в UTC («2026-10-25T00:30:00Z»),
 *   а такой строки выдача не показывает.
 * Чинить — в ключах и формате адреса (values.ts, владелец дефекта), не здесь.
 */

// ─────────────────────────────── типы ───────────────────────────────

/**
 * Вид встречи:
 * - slot — слот серии без своего компонента (у одиночного события — оно само);
 * - override — слот с переопределением роли slot;
 * - detached — переопределение вне слотов, адрес — его RECURRENCE-ID (Р5, Р6);
 * - range — слот после переопределения RANGE=THISANDFUTURE, сдвинутый им (Р7).
 */
export type InstanceKind = "slot" | "override" | "detached" | "range";

export interface Instance {
  /** Адрес: ключ слота, у detached — ключ RECURRENCE-ID в форме серии (О3). */
  readonly key: SlotKey;
  /** Время адреса в форме серии (О4): слот или RECURRENCE-ID, приведённый к форме DTSTART. */
  readonly address: ICAL.Time;
  /** Адрес для модели (Р10): ISO со смещением пояса серии, у встречи на весь день — YYYY-MM-DD. */
  readonly instanceStart: string;
  readonly kind: InstanceKind;
  /**
   * Компонент, чьи поля показываются: основной; переопределение слота (у
   * дублей — `shownOverride`); detached; у range — переопределение RANGE.
   */
  readonly shown: ICAL.Component;
  /**
   * Собственные компоненты встречи — все переопределения с её
   * RECURRENCE-ID, по порядку файла (с дублями). У slot и range — пусто:
   * встреча задана основным компонентом или чужим переопределением.
   */
  readonly components: readonly ICAL.Component[];
  /** Фактическое начало и конец (копии). */
  readonly start: ICAL.Time;
  readonly end: ICAL.Time;
  /** Моменты начала и конца в миллисекундах Unix. */
  readonly startMs: number;
  readonly endMs: number;
  /** Фактическое начало не совпадает с адресом (Р10). */
  readonly moved: boolean;
  /** STATUS:CANCELLED у показываемого компонента: встреча время не занимает (Р7). */
  readonly cancelled: boolean;
}

/** Переопределение, которое не показывается (Р5, правило 2). */
export interface HiddenOverride {
  readonly key: SlotKey;
  /** RECURRENCE-ID в форме серии. */
  readonly address: ICAL.Time;
  readonly instanceStart: string;
  /** Компоненты с этим RECURRENCE-ID по порядку файла. */
  readonly refs: readonly OverrideRef[];
  /** excluded — RECURRENCE-ID под EXDATE (EXRULE); outside-series — вне протяжённости серии. */
  readonly reason: "excluded" | "outside-series";
}

/**
 * Цель правки или удаления по адресу:
 * - single — одиночное событие, адрес — его DTSTART;
 * - slot — незакрытый слот серии (со своим переопределением или без);
 * - detached — переопределение вне слотов, по RECURRENCE-ID;
 * - hidden — скрытое переопределение, по RECURRENCE-ID; только для delete.
 */
export type Target =
  | { readonly kind: "single" | "slot"; readonly key: SlotKey; readonly slot: Slot; readonly instance: Instance }
  | { readonly kind: "detached"; readonly key: SlotKey; readonly refs: readonly OverrideRef[]; readonly instance: Instance }
  | { readonly kind: "hidden"; readonly key: SlotKey; readonly refs: readonly OverrideRef[]; readonly hidden: HiddenOverride };

export interface Resolved {
  readonly target: Target;
  /**
   * Другие, перенесённые встречи, чьё фактическое начало совпало с адресом
   * цели (Р10). Бывает только при `confirm`: без него это отказ ambiguous.
   */
  readonly ambiguousWith?: readonly Instance[];
}

export interface ResolveOptions {
  /**
   * Вызывающий подтвердил неоднозначный адрес (etag сверяет он сам, О11,
   * Р11): цель — слот или detached по адресу, перенесённые встречи — в
   * `ambiguousWith`. Для delete all_series, где адрес только проверяется,
   * неоднозначность ничего не меняет — передавайте true.
   */
  readonly confirm?: boolean;
}

/**
 * Код отказа по адресу (Р10):
 * - invalid — строка не разобрана или не той формы (у серии на весь день —
 *   не дата и не полночь; у серии со временем — дата без времени);
 * - not-found — встречи с таким адресом нет;
 * - excluded — слот закрыт EXDATE;
 * - actual-start — это фактическое начало перенесённой встречи, а не её
 *   адрес; адрес — в `alternatives`;
 * - ambiguous — адрес встречи совпал с фактическим началом другой,
 *   перенесённой; оба адреса — в `alternatives`, повтор — с confirm;
 * - mismatch — у одиночного события адрес не совпал с его началом.
 */
export type AddressErrorCode = "invalid" | "not-found" | "excluded" | "actual-start" | "ambiguous" | "mismatch";

export class AddressError extends Error {
  readonly code: AddressErrorCode;
  /** Что сделать, по-русски. */
  readonly hint?: string;
  /** Адреса-кандидаты в формате Р10: при ambiguous — сначала адрес цели, затем перенесённые. */
  readonly alternatives?: readonly string[];

  constructor(code: AddressErrorCode, message: string, options: { hint?: string; alternatives?: readonly string[] } = {}) {
    super(options.hint ? `${message} ${options.hint}` : message);
    this.name = "AddressError";
    this.code = code;
    this.hint = options.hint;
    this.alternatives = options.alternatives;
  }
}

/** Граница `visibleMap` (О12в): адреса до `until` включительно, но не меньше `minSlots` видимых слотов. */
export interface VisibleHorizon {
  readonly until: SlotKey;
  readonly minSlots?: number;
  /** Предел шагов перебора слотов; по умолчанию VISIBLE_CAP. */
  readonly cap?: number;
}

/** Предел шагов `visibleMap` (О12в: ≤ 100 000 шагов). */
export const VISIBLE_CAP = 100_000;

export interface EventMeta {
  readonly calendarId: string;
  readonly etag?: string;
  readonly href?: string;
}

// ─────────────────────────────── выдача ───────────────────────────────

/**
 * Встречи, пересекающие окно [fromMs, toMs), по возрастанию фактического
 * начала. Пересечение — как в RFC 4791 §9.9: у встречи с длительностью —
 * начало раньше конца окна и конец позже его начала; у встречи без
 * длительности — начало внутри окна.
 *
 * Переопределения (slot и detached) проверяются по своему времени все —
 * их конечное число, — так что встреча, перенесённая в окно с любого
 * слота, в выдаче есть. Слоты без своего компонента перебираются от начала
 * серии (итератор ical.js иначе не умеет, recur.js iterator) до конца окна
 * плюс сутки и наибольший сдвиг RANGE назад. Встреча строится только у
 * слота, который может дотянуться до окна (`latestEndMs`): у давней серии
 * слоты до окна лишь перебираются.
 *
 * Бросает `SlotScanError`: "too-long" — до конца окна больше SERIES_CAP
 * слотов; "stalled" и "rule-error" — итератор сбился посреди серии. Решать,
 * как показать такой объект, — вызывающему (чтение, З09).
 */
export function instancesBetween(o: CalendarObject, fromMs: number, toMs: number): Instance[] {
  const found: Instance[] = [];
  const keep = (instance: Instance) => {
    if (overlaps(instance, fromMs, toMs)) found.push(instance);
  };
  for (const [key, refs] of o.overrides) {
    const explicit = explicitInstance(o, key, refs);
    if (explicit) keep(explicit);
  }
  if (o.master) {
    const view = seriesView(o);
    const stopMs = toMs + view.lookaheadMs;
    for (const slot of boundedSlots(o, SERIES_CAP)) {
      const slotMs = instantOf(slot.time, o.env);
      if (slotMs >= stopMs) break;
      if (slot.excluded || hasSlotOverride(o, slot.key)) continue;
      if (latestEndMs(view, slot, slotMs) < fromMs) continue; // кончилась до окна — не строим
      keep(slotInstance(view, slot));
    }
  }
  return found.sort(byStart);
}

/**
 * Видимая встреча по адресу: слот (со своим переопределением или без) или
 * detached. Скрытое, закрытый слот и не-адрес — undefined.
 */
export function instanceAt(o: CalendarObject, key: SlotKey): Instance | undefined {
  const refs = o.overrides.get(key);
  if (refs) {
    const explicit = explicitInstance(o, key, refs);
    if (explicit) return explicit;
  }
  if (!o.master) return undefined;
  const slot = findSlot(o, key);
  if (!slot || slot.excluded) return undefined;
  return slotInstance(seriesView(o), slot);
}

/**
 * Видимые встречи по адресу — для предохранителя (О12в): все незакрытые
 * слоты с ключом до `until` (и дальше, пока их меньше `minSlots`) и detached
 * до той же границы. Перенесённая встреча лежит под ключом своего слота.
 * Больше `cap` шагов перебора — `SlotScanError` "too-long".
 */
export function visibleMap(o: CalendarObject, horizon: VisibleHorizon): ReadonlyMap<SlotKey, Instance> {
  const found: Instance[] = [];
  const minSlots = horizon.minSlots ?? 0;
  let bound = horizon.until;
  if (o.master) {
    const view = seriesView(o);
    let visible = 0;
    for (const slot of boundedSlots(o, horizon.cap ?? VISIBLE_CAP)) {
      if (compareSlotKeys(slot.key, horizon.until) > 0 && visible >= minSlots) break;
      if (slot.excluded) continue;
      visible += 1;
      if (compareSlotKeys(slot.key, bound) > 0) bound = slot.key;
      if (!hasSlotOverride(o, slot.key)) found.push(slotInstance(view, slot));
    }
  }
  for (const [key, refs] of o.overrides) {
    if (compareSlotKeys(key, bound) > 0) continue;
    const explicit = explicitInstance(o, key, refs);
    if (explicit) found.push(explicit);
  }
  found.sort((a, b) => compareSlotKeys(a.key, b.key));
  return new Map(found.map((instance) => [instance.key, instance]));
}

/** Скрытые переопределения (роль hidden) по возрастанию RECURRENCE-ID. */
export function hiddenOverrides(o: CalendarObject): HiddenOverride[] {
  const hidden: HiddenOverride[] = [];
  for (const [key, refs] of o.overrides) {
    if (roleOf(o, refs) === "hidden") hidden.push(hiddenOf(o, key, refs));
  }
  return hidden;
}

// ─────────────────────────────── адрес (Р10) ───────────────────────────────

/**
 * Ключ адреса `instanceStart` (приём Р10):
 * - серия со временем: ISO со смещением или Z — момент; без смещения —
 *   стенное время пояса серии (у серии в UTC — UTC); дата — invalid;
 * - серия на весь день: `YYYY-MM-DD` или полночь `…T00:00[:00]` с любым
 *   смещением или без — буквальная дата (J-B6: момент не переводится в
 *   пояс); иное время — invalid;
 * - плавающая серия: момент — стенное время пояса календаря.
 */
export function parseAddress(o: CalendarObject, instanceStart: string): SlotKey {
  const zone: ZoneRef | undefined = o.form === "zoned" ? o.zone : o.form === "utc" ? ICAL.Timezone.utcTimezone : undefined;
  let parsed: ModelTime;
  try {
    parsed = parseModelTime(instanceStart, zone);
  } catch (error) {
    if (!(error instanceof ModelTimeError)) throw error;
    throw invalidAddress(o, instanceStart, error.message);
  }
  if (o.form === "date") {
    const { hour, minute, second } = parsed.wall;
    if (parsed.kind === "date" || (hour === 0 && minute === 0 && second === 0)) return `D:${parsed.date}`;
    throw invalidAddress(o, instanceStart, "у встречи на весь день адрес — дата, а не момент");
  }
  if (parsed.kind === "date") throw invalidAddress(o, instanceStart, "у встречи со временем адрес — момент, а не дата");
  return slotKeyOf(parsed.time, o.form, o.env);
}

/**
 * Цель правки или удаления по адресу (Р10). Порядок:
 * 1. незакрытый слот (single у одиночного события) или RECURRENCE-ID
 *    detached;
 * 2. только для delete — RECURRENCE-ID скрытого переопределения;
 * 3. иначе — фактическое начало перенесённой встречи: отказ actual-start с
 *    её адресом; иначе excluded, mismatch или not-found.
 * Если адрес цели совпал с фактическим началом другой, перенесённой встречи
 * (и в delete, и в update), без `confirm` — отказ ambiguous с обоими
 * адресами, с `confirm` — цель по адресу и `ambiguousWith`.
 *
 * Бросает `AddressError`; `SlotScanError` — если адрес дальше предела
 * прохода серии или итератор сбился.
 */
export function resolveTarget(o: CalendarObject, instanceStart: string, op: EditOp, options: ResolveOptions = {}): Resolved {
  const key = parseAddress(o, instanceStart);
  const target = addressed(o, key, op);
  const others = movedStartingAt(o, key);
  if (!target) {
    if (others.length > 0) {
      const addresses = others.map((instance) => instance.instanceStart);
      throw new AddressError("actual-start", `${instanceStart} — фактическое начало перенесённой встречи, а не её адрес.`, {
        hint: `Адрес этой встречи (instanceStart): ${addresses.join(", ")} — передайте его.`,
        alternatives: addresses,
      });
    }
    throw notAddressable(o, key, instanceStart, op);
  }
  if (others.length === 0) return { target };
  if (!options.confirm) {
    const own = target.kind === "hidden" ? target.hidden.instanceStart : target.instance.instanceStart;
    const addresses = others.map((instance) => instance.instanceStart);
    throw new AddressError(
      "ambiguous",
      `Адрес ${own} неоднозначен: это ${target.kind === "hidden" ? "скрытый компонент серии" : "встреча серии"} ` +
        `и одновременно фактическое начало перенесённой встречи ${addresses.join(", ")}.`,
      {
        hint:
          `Чтобы изменить или удалить перенесённую встречу, передайте её instanceStart ${addresses.join(", ")}. ` +
          `Чтобы изменить или удалить встречу по адресу ${own}, повторите вызов с confirm: true и etag из последнего чтения.`,
        alternatives: [own, ...addresses],
      },
    );
  }
  return { target, ambiguousWith: others };
}

// ─────────────────────────────── CalendarEvent ───────────────────────────────

/**
 * Встреча или объект целиком (get_event) в терминах модели, форматы Р10:
 * `start` и `end` — фактическое время ISO со смещением (у встречи на весь
 * день — полночь пояса календаря), `instanceStart` — адрес, `moved` и
 * `detached` — только когда верны. Поля — из показываемого компонента,
 * повтор — из основного (Р4: невыразимые части — `recurrence.unmodeled`;
 * HOURLY и прочие частоты, RDATE, несколько RRULE — ещё и `recurrenceRule`
 * дословно).
 *
 * "object": основной компонент с `exceptions` (Р5–Р7); у объекта без
 * основного (Р6) — его первая по адресу встреча.
 */
export function toCalendarEvent(o: CalendarObject, what: Instance | "object", meta: EventMeta): CalendarEvent {
  const whole = what === "object";
  const instance = whole ? objectInstance(o) : what;
  const shown = instance.shown;
  const env = o.env;
  const recurring = o.kind !== "single" || shown.hasProperty("recurrence-id");
  const addressed = recurring && (!whole || instance.kind === "detached");

  const event: CalendarEvent = {
    id: o.uid,
    calendarId: meta.calendarId,
    summary: textOf(shown, "summary") ?? "",
    start: formatForModel(instance.start, env, "time"),
    end: formatForModel(instance.end, env, "time"),
    timeZone: zoneNameOf(instance.start, env),
    allDay: instance.start.isDate,
    reminders: remindersOf(shown, instance.start, env),
    attendees: attendeesOf(shown),
  };
  const description = textOf(shown, "description");
  if (description) event.description = description;
  const location = textOf(shown, "location");
  if (location) event.location = location;
  const { recurrence, recurrenceRule } = recurrenceOf(o);
  if (recurrence) event.recurrence = recurrence;
  if (meta.etag !== undefined) event.etag = meta.etag;
  if (meta.href !== undefined) event.href = meta.href;
  if (addressed) {
    event.instanceStart = instance.instanceStart;
    event.seriesId = o.uid;
  }
  event.recurring = recurring;
  if (recurrenceRule) event.recurrenceRule = recurrenceRule;
  const status = statusOf(shown);
  if (status) event.status = status;
  if (addressed && instance.moved) event.moved = true;
  if (instance.kind === "detached") event.detached = true;
  if (whole) event.exceptions = exceptionsOf(o);
  if (o.anomalies.length > 0) event.anomalies = o.anomalies.map(formatAnomaly);
  return event;
}

// ─────────────────────────── встречи: внутреннее ───────────────────────────

const DAY_MS = 86_400_000;
const DAY_SECONDS = 86_400;

/**
 * Длительность компонента: номинальные сутки (стенные, RFC 5545 §3.3.6) и
 * точные секунды. DTEND задаёт точную длительность — она и повторяется
 * (RFC 5545 §3.8.5.3: «the same exact duration will apply to all the
 * members»); у DATE с DTEND-датой — целые сутки. DURATION: дни и недели —
 * номинальные, часы, минуты и секунды — точные. Без DTEND и DURATION: у
 * DATE — сутки, у DATE-TIME — ноль (RFC 5545 §3.6.1).
 */
interface Length {
  days: number;
  seconds: number;
}

function lengthOf(c: ICAL.Component, env: IcalEnv): Length {
  const start = c.getFirstPropertyValue("dtstart") as ICAL.Time;
  const dtend = c.getFirstPropertyValue("dtend");
  if (dtend instanceof ICAL.Time) {
    // time.js:1055, subtractDate — разница стенных полей; у дат смещение ноль.
    if (start.isDate && dtend.isDate) return { days: Math.round(dtend.subtractDate(start).toSeconds() / DAY_SECONDS), seconds: 0 };
    return { days: 0, seconds: (instantOf(dtend, env) - instantOf(start, env)) / 1000 };
  }
  const duration = c.getFirstPropertyValue("duration");
  if (duration instanceof ICAL.Duration) {
    const sign = duration.isNegative ? -1 : 1;
    return {
      days: sign * (duration.days + 7 * duration.weeks),
      seconds: sign * (duration.hours * 3600 + duration.minutes * 60 + duration.seconds),
    };
  }
  return start.isDate ? { days: 1, seconds: 0 } : { days: 0, seconds: 0 };
}

// Конец по началу и длительности. Сутки — стенным сдвигом (time.js:1221,
// adjust), точные секунды — через момент, в форме и поясе начала: стенное
// прибавление у весеннего перевода дало бы время из разрыва, которое ical.js
// читает со смещением после разрыва (values.ts, atInstant), и встреча
// 01:30–02:30 в ночь перевода стала бы нулевой.
function endAfter(start: ICAL.Time, length: Length, env: IcalEnv): ICAL.Time {
  const end = start.clone();
  if (length.days) end.adjust(length.days, 0, 0, 0);
  if (!length.seconds) return end;
  if (end.isDate) {
    const days = Math.trunc(length.seconds / DAY_SECONDS);
    if (days) end.adjust(days, 0, 0, 0);
    return end;
  }
  return atMoment(instantOf(end, env) / 1000 + length.seconds, end, env);
}

// Момент `seconds` в форме и поясе значения `like` (values.ts, timeInForm).
function atMoment(seconds: number, like: ICAL.Time, env: IcalEnv): ICAL.Time {
  // time.js:1313, fromUnixTime — поля через getUTC*, от пояса процесса не зависят.
  const utc = ICAL.Time.fromData(
    { year: 1970, month: 1, day: 1, hour: 0, minute: 0, second: 0, isDate: false },
    ICAL.Timezone.utcTimezone,
  );
  utc.fromUnixTime(seconds);
  const form = formOf(like);
  return timeInForm(utc, form, form === "zoned" ? like.zone : undefined, env);
}

// Значение в форме серии (О4); если пояс серии для перевода не годится —
// как есть: ключ у него тот же (values.ts, timeInForm).
function inSeriesForm(o: CalendarObject, t: ICAL.Time): ICAL.Time {
  try {
    return timeInForm(t, o.form, o.zone, o.env);
  } catch {
    return t.clone();
  }
}

// Стенной сдвиг на `seconds`: у даты — целыми сутками (time.js:1221, adjust).
function shiftWall(t: ICAL.Time, seconds: number): ICAL.Time {
  const shifted = t.clone();
  if (shifted.isDate) shifted.adjust(Math.trunc(seconds / DAY_SECONDS), 0, 0, 0);
  else shifted.adjust(0, 0, 0, seconds);
  return shifted;
}

interface InstanceFields {
  key: SlotKey;
  address: ICAL.Time;
  kind: InstanceKind;
  shown: ICAL.Component;
  components: readonly ICAL.Component[];
  start: ICAL.Time;
  end: ICAL.Time;
}

function makeInstance(o: CalendarObject, fields: InstanceFields): Instance {
  const { key, address, start } = fields;
  return {
    ...fields,
    instanceStart: formatForModel(address, o.env, "instance"),
    startMs: instantOf(start, o.env),
    endMs: instantOf(fields.end, o.env),
    moved: slotKeyOf(start, o.form, o.env) !== key || start.isDate !== address.isDate,
    cancelled: statusOf(fields.shown) === "cancelled",
  };
}

// Встреча с собственным компонентом: его DTSTART, его DTEND или длительность.
function componentInstance(
  o: CalendarObject,
  key: SlotKey,
  address: ICAL.Time,
  kind: InstanceKind,
  shown: ICAL.Component,
  components: readonly ICAL.Component[],
): Instance {
  const { start, end } = timesOf(shown, o.env);
  return makeInstance(o, { key, address, kind, shown, components, start, end });
}

function timesOf(c: ICAL.Component, env: IcalEnv): { start: ICAL.Time; end: ICAL.Time } {
  const start = (c.getFirstPropertyValue("dtstart") as ICAL.Time).clone();
  const dtend = c.getFirstPropertyValue("dtend");
  const end = dtend instanceof ICAL.Time ? dtend.clone() : endAfter(start, lengthOf(c, env), env);
  return { start, end };
}

function roleOf(o: CalendarObject, refs: readonly OverrideRef[]) {
  return refs.length > 0 ? o.roles.get(refs[0].component)?.role : undefined;
}

function hasSlotOverride(o: CalendarObject, key: SlotKey): boolean {
  return roleOf(o, o.overrides.get(key) ?? []) === "slot";
}

// Встреча переопределений одного RECURRENCE-ID: slot — встреча слота
// (object.ts, meetingAt), detached — отдельная встреча (у дублей —
// shownOverride). hidden — undefined.
function explicitInstance(o: CalendarObject, key: SlotKey, refs: readonly OverrideRef[]): Instance | undefined {
  const role = roleOf(o, refs);
  if (role === "slot") {
    const meeting = meetingAt(o, key);
    if (!meeting) return undefined;
    return componentInstance(o, key, inSeriesForm(o, refs[0].recurrenceId), "override", meeting.shown, meeting.components);
  }
  if (role === "detached") {
    const shown = shownOverride(refs);
    return componentInstance(o, key, inSeriesForm(o, shown.recurrenceId), "detached", shown.component,
      refs.map((ref) => ref.component));
  }
  return undefined;
}

/** Сдвиг переопределения RANGE=THISANDFUTURE для следующих слотов (Р7). */
interface RangeShift {
  key: SlotKey;
  ref: OverrideRef;
  /** Стенная разница начала переопределения и его RECURRENCE-ID в форме серии, секунды. */
  seconds: number;
  length: Length;
}

/** Основной компонент, прочитанный один раз на проход слотов. */
interface SeriesView {
  o: CalendarObject;
  master: ICAL.Component;
  length: Length;
  dtend?: ICAL.Time;
  ranges: RangeShift[];
  /** Насколько дальше конца окна перебирать слоты: сутки и наибольший сдвиг RANGE назад. */
  lookaheadMs: number;
  /**
   * Насколько конец встречи слота может быть позже момента слота (верхняя
   * граница): наибольший сдвиг RANGE вперёд, наибольшая длительность —
   * основного и переопределений RANGE — и запас на переводы часов. Конец
   * RDATE;VALUE=PERIOD — свой, его учитывает `latestEndMs`.
   */
  reachMs: number;
}

/**
 * Запас границ на переводы часов: стенной сдвиг (RANGE, номинальные сутки
 * DURATION) расходится с точным на величину переводов внутри него. Двое
 * суток покрывают и обычный час, и переход через линию перемены дат (Самоа,
 * 30.12.2011, — сутки).
 */
const DRIFT_MS = 2 * DAY_MS;

function seriesView(o: CalendarObject): SeriesView {
  const master = o.master!;
  const dtend = master.getFirstPropertyValue("dtend");
  const ranges = rangeShifts(o);
  const length = lengthOf(master, o.env);
  const back = Math.max(0, ...ranges.map((range) => -range.seconds * 1000));
  const forward = Math.max(0, ...ranges.map((range) => range.seconds * 1000));
  const longest = Math.max(lengthBoundMs(length), ...ranges.map((range) => lengthBoundMs(range.length)));
  return {
    o,
    master,
    length,
    dtend: dtend instanceof ICAL.Time ? dtend : undefined,
    ranges,
    lookaheadMs: back + DAY_MS,
    reachMs: forward + longest + DRIFT_MS,
  };
}

// Верхняя граница длительности в миллисекундах: номинальные сутки — не
// длиннее суток, расхождение с точными покрывает DRIFT_MS; отрицательные
// части — ноль (конец тогда раньше начала, а начало граница и так покрывает).
function lengthBoundMs(length: Length): number {
  return Math.max(0, length.days) * DAY_MS + Math.max(0, length.seconds) * 1000;
}

// Позже какого момента встреча слота кончиться не может (`slotMs` — момент
// слота): момент слота плюс `reachMs`, у RDATE;VALUE=PERIOD без сдвига RANGE
// — конец периода (slotInstance). Нужна, чтобы не строить встречи слотов,
// которые кончились до окна (instancesBetween): у DAILY с 1990 года это
// тысячи встреч на каждый вызов. Отсечение верно и для встречи без
// длительности или с концом раньше начала: её начало не позже этой границы.
function latestEndMs(view: SeriesView, slot: Slot, slotMs: number): number {
  const bound = slotMs + view.reachMs;
  if (!slot.periodEnd) return bound;
  return Math.max(bound, instantOf(slot.periodEnd, view.o.env) + DRIFT_MS);
}

// RFC 5545 §3.8.4.4: у RANGE=THISANDFUTURE время и поля переопределения
// действуют на его встречу и все следующие. Сдвиг — как в ical.js,
// event.js:240-263 (getOccurrenceDetails): стенная разница начала и
// RECURRENCE-ID (time.js:1055, subtractDate), прибавленная к слоту;
// длительность — переопределения. Скрытые переопределения ничего не сдвигают.
function rangeShifts(o: CalendarObject): RangeShift[] {
  const shifts: RangeShift[] = [];
  for (const [key, refs] of o.overrides) {
    const role = roleOf(o, refs);
    if (role !== "slot" && role !== "detached") continue;
    const ref = shownOverride(refs);
    if (ref.range !== "thisandfuture") continue;
    const rid = inSeriesForm(o, ref.recurrenceId);
    const start = inSeriesForm(o, ref.component.getFirstPropertyValue("dtstart") as ICAL.Time);
    shifts.push({ key, ref, seconds: start.subtractDate(rid).toSeconds(), length: lengthOf(ref.component, o.env) });
  }
  return shifts; // o.overrides — по возрастанию ключа
}

// Встреча незакрытого слота без своего переопределения.
function slotInstance(view: SeriesView, slot: Slot): Instance {
  const { o, master } = view;
  let range: RangeShift | undefined;
  for (const candidate of view.ranges) {
    if (compareSlotKeys(candidate.key, slot.key) < 0) range = candidate;
  }
  if (range) {
    const start = shiftWall(slot.time, range.seconds);
    const end = endAfter(start, range.length, o.env);
    return makeInstance(o, { key: slot.key, address: slot.time, kind: "range", shown: range.ref.component, components: [], start, end });
  }
  const start = slot.time.clone();
  let end: ICAL.Time;
  if (slot.periodEnd) end = inSeriesForm(o, slot.periodEnd); // RDATE;VALUE=PERIOD — свой конец
  else if (view.dtend && slot.sources.includes("dtstart")) end = view.dtend.clone();
  else end = endAfter(start, view.length, o.env);
  return makeInstance(o, { key: slot.key, address: slot.time, kind: "slot", shown: master, components: [], start, end });
}

// Слоты по порядку с пределом шагов: больше `cap` — SlotScanError "too-long".
function* boundedSlots(o: CalendarObject, cap: number): Generator<Slot> {
  let seen = 0;
  for (const slot of iterateSlots(o)) {
    if (++seen > cap) {
      throw new SlotScanError("too-long", `Серия ${o.uid} длиннее ${cap} встреч до нужной даты: встречи не перебрать.`);
    }
    yield slot;
  }
}

// RFC 4791 §9.9: с длительностью — [start, end) пересекает окно; без —
// начало в окне.
function overlaps(instance: Instance, fromMs: number, toMs: number): boolean {
  if (instance.endMs > instance.startMs) return instance.startMs < toMs && instance.endMs > fromMs;
  return instance.startMs >= fromMs && instance.startMs < toMs;
}

function byStart(a: Instance, b: Instance): number {
  return a.startMs - b.startMs || a.endMs - b.endMs || compareSlotKeys(a.key, b.key);
}

function hiddenOf(o: CalendarObject, key: SlotKey, refs: readonly OverrideRef[]): HiddenOverride {
  const address = inSeriesForm(o, refs[0].recurrenceId);
  let excluded = o.master ? listKeys(o.master, "exdate", o).includes(key) : false;
  if (!excluded && o.master?.hasProperty("exrule")) {
    try {
      excluded = findSlot(o, key)?.excluded === true;
    } catch (error) {
      if (!(error instanceof SlotScanError)) throw error;
    }
  }
  return {
    key,
    address,
    instanceStart: formatForModel(address, o.env, "instance"),
    refs,
    reason: excluded ? "excluded" : "outside-series",
  };
}

// ─────────────────────────── адрес: внутреннее ───────────────────────────

function addressed(o: CalendarObject, key: SlotKey, op: EditOp): Target | undefined {
  const refs = o.overrides.get(key) ?? [];
  const role = roleOf(o, refs);
  if (role === "detached") {
    const instance = explicitInstance(o, key, refs);
    if (instance) return { kind: "detached", key, refs, instance };
  }
  if (o.master && role !== "hidden") {
    const slot = findSlot(o, key);
    if (slot && !slot.excluded) {
      const instance = role === "slot" ? explicitInstance(o, key, refs) : slotInstance(seriesView(o), slot);
      if (instance) return { kind: o.kind === "single" ? "single" : "slot", key, slot, instance };
    }
  }
  if (role === "hidden" && op === "delete") return { kind: "hidden", key, refs, hidden: hiddenOf(o, key, refs) };
  return undefined;
}

// Видимые встречи, чьё фактическое начало имеет ключ `key`, а адрес — другой.
function movedStartingAt(o: CalendarObject, key: SlotKey): Instance[] {
  const ms = keyInstantMs(o, key);
  return instancesBetween(o, ms - 2 * DAY_MS, ms + 2 * DAY_MS).filter(
    (instance) => instance.key !== key && slotKeyOf(instance.start, o.form, o.env) === key,
  );
}

// Момент ключа: T — секунды; D — полночь даты, F — стенное время, оба в
// поясе календаря (values.ts, instantOf).
function keyInstantMs(o: CalendarObject, key: SlotKey): number {
  if (key.startsWith("T:")) return Number(key.slice(2)) * 1000;
  return instantOf(parseModelTime(key.slice(2)).time, o.env);
}

function notAddressable(o: CalendarObject, key: SlotKey, input: string, op: EditOp): AddressError {
  const refs = o.overrides.get(key) ?? [];
  const hidden = roleOf(o, refs) === "hidden" ? hiddenOf(o, key, refs) : undefined;
  const onlyDelete = hidden && op !== "delete"
    ? "По этому адресу остался скрытый компонент без встречи — его можно только удалить (delete_event со scope this)."
    : undefined;
  let slot: Slot | undefined;
  if (o.master) {
    try {
      slot = findSlot(o, key);
    } catch (error) {
      if (!(error instanceof SlotScanError)) throw error;
    }
  }
  if (slot?.excluded || hidden?.reason === "excluded") {
    return new AddressError("excluded", `Встреча ${formatForModel(slot?.time ?? hidden!.address, o.env, "instance")} удалена из серии (EXDATE).`, {
      hint: onlyDelete,
    });
  }
  if (o.kind === "single" && o.master) {
    const only = formatForModel(o.master.getFirstPropertyValue("dtstart") as ICAL.Time, o.env, "instance");
    return new AddressError("mismatch", `У одиночного события одна встреча — ${only}; адрес ${input} ей не соответствует.`, {
      hint: `Передайте instanceStart ${only} или не передавайте instanceStart.`,
      alternatives: [only],
    });
  }
  return new AddressError("not-found", `Встречи с адресом ${input} нет.`, {
    hint: onlyDelete ?? "Адрес (instanceStart) берите из list_events: у перенесённой встречи это её исходный слот.",
  });
}

function invalidAddress(o: CalendarObject, input: string, reason: string): AddressError {
  const example = o.form === "date"
    ? "У встречи на весь день адрес — дата YYYY-MM-DD, например 2026-10-21."
    : "Адрес — ISO 8601 со смещением, например 2026-10-21T10:00:00+03:00.";
  return new AddressError("invalid", `Адрес встречи ${JSON.stringify(input)} не принят: ${reason}.`, {
    hint: `${example} Берите instanceStart из list_events.`,
  });
}

// ─────────────────────────── CalendarEvent: внутреннее ───────────────────────────

// Основной компонент как встреча (get_event); у объекта без основного —
// первая по адресу detached (Р6).
function objectInstance(o: CalendarObject): Instance {
  if (o.master) {
    const { start, end } = timesOf(o.master, o.env);
    return makeInstance(o, {
      key: slotKeyOf(start, o.form, o.env),
      address: inSeriesForm(o, start),
      kind: "slot",
      shown: o.master,
      components: [],
      start,
      end,
    });
  }
  for (const [key, refs] of o.overrides) {
    const explicit = explicitInstance(o, key, refs);
    if (explicit) return explicit;
  }
  throw new Error(`В объекте ${o.uid} нет ни основного компонента, ни показываемых встреч.`);
}

function textOf(c: ICAL.Component, name: string): string | undefined {
  const value = c.getFirstPropertyValue(name);
  return value === null || value === undefined ? undefined : String(value);
}

const STATUSES: ReadonlySet<string> = new Set(["tentative", "confirmed", "cancelled"]);

function statusOf(c: ICAL.Component): EventStatus | undefined {
  const status = textOf(c, "status")?.toLowerCase();
  return status && STATUSES.has(status) ? (status as EventStatus) : undefined;
}

// Имя пояса начала: TZID; UTC; у плавающего времени и даты — пояс календаря,
// в котором они читаются (values.ts, instantOf).
function zoneNameOf(t: ICAL.Time, env: IcalEnv): string {
  if (t.isDate) return env.floatingZone;
  const form = formOf(t);
  if (form === "utc") return "UTC";
  if (form === "floating") return env.floatingZone;
  return t.zone.tzid;
}

// Напоминания — как в прежнем parse.ts: относительный TRIGGER — минуты до
// начала со знаком, абсолютный — разница моментов; DISPLAY, AUDIO и прочие —
// display, EMAIL — email.
function remindersOf(c: ICAL.Component, start: ICAL.Time, env: IcalEnv): Reminder[] {
  return c.getAllSubcomponents("valarm").map((alarm) => {
    const action = String(alarm.getFirstPropertyValue("action") ?? "DISPLAY").toLowerCase();
    const trigger = alarm.getFirstPropertyValue("trigger");
    let minutes = 0;
    if (trigger instanceof ICAL.Time) minutes = Math.round((instantOf(start, env) - instantOf(trigger, env)) / 60_000);
    else if (trigger instanceof ICAL.Duration) minutes = Math.round(-trigger.toSeconds() / 60);
    return { minutesBefore: minutes || 0, method: action === "email" ? "email" : "display" };
  });
}

function attendeesOf(c: ICAL.Component): Attendee[] {
  return c.getAllProperties("attendee").map((property) => {
    const email = String(property.getFirstValue() ?? "").replace(/^mailto:/i, "");
    const partstat = String(property.getParameter("partstat") ?? "NEEDS-ACTION").toLowerCase();
    const status: Attendee["status"] =
      partstat === "accepted" || partstat === "declined" || partstat === "tentative" ? partstat : "needs-action";
    return { email, status };
  });
}

const FREQUENCIES: Readonly<Record<string, RecurrenceFrequency>> = {
  DAILY: "daily",
  WEEKLY: "weekly",
  MONTHLY: "monthly",
  YEARLY: "yearly",
};
const MODELED_PARTS: ReadonlySet<string> = new Set(["FREQ", "INTERVAL", "BYDAY", "COUNT", "UNTIL"]);

/**
 * Повтор для модели (Р4). Части берутся из текста правила
 * (property.js:433, toICALString — design.js, recur.toICAL пишет части по
 * порядку живого jCal-словаря, неизвестные — как в тексте, WKST — именем
 * дня), а не из `Recur.toJSON`, который неизвестные части теряет. UNTIL — в
 * поясе серии (у серии на весь день — датой).
 */
function recurrenceOf(o: CalendarObject): { recurrence?: Recurrence; recurrenceRule?: string } {
  const master = o.master;
  if (!master) return {};
  const rules = master.getAllProperties("rrule");
  const verbatim = [...rules, ...master.getAllProperties("exrule"), ...master.getAllProperties("rdate")]
    .map((property) => property.toICALString());
  const recurrence = rules.length > 0 ? modelRule(o, rules[0]) : undefined;
  const needsRule = recurrence === undefined || rules.length > 1 || verbatim.length > rules.length;
  return {
    recurrence,
    recurrenceRule: needsRule && verbatim.length > 0 ? verbatim.join("\n") : undefined,
  };
}

function modelRule(o: CalendarObject, property: ICAL.Property): Recurrence | undefined {
  const line = splitContentLine(property.toICALString());
  if (!line) return undefined;
  const parts = line.value.split(";").map((part) => {
    const at = part.indexOf("=");
    return at < 0 ? { name: part.toUpperCase(), value: "" } : { name: part.slice(0, at).toUpperCase(), value: part.slice(at + 1) };
  });
  const value = (name: string) => parts.find((part) => part.name === name)?.value;
  const frequency = FREQUENCIES[(value("FREQ") ?? "").toUpperCase()];
  if (!frequency) return undefined;

  const recurrence: Recurrence = { frequency, interval: Number(value("INTERVAL") ?? 1) || 1 };
  const byday = value("BYDAY");
  if (byday) recurrence.byWeekday = byday.split(",") as Recurrence["byWeekday"];
  const count = value("COUNT");
  if (count !== undefined) recurrence.count = Number(count);
  const until = (property.getFirstValue() as ICAL.Recur).until;
  if (until) recurrence.until = formatForModel(until.isDate ? until : inSeriesForm(o, until), o.env, "instance");
  const unmodeled = parts.filter((part) => !MODELED_PARTS.has(part.name)).map((part) => `${part.name}=${part.value}`);
  if (unmodeled.length > 0) recurrence.unmodeled = unmodeled.join(";");
  return recurrence;
}

/** Слот, закрытый EXDATE: ключ и время в форме серии. */
interface ExcludedSlot {
  key: SlotKey;
  address: ICAL.Time;
}

// Слоты, закрытые EXDATE, — проход до последнего EXDATE с пределом
// SERIES_CAP. EXDATE мимо слотов ничего не закрывает и не выдаётся. Если
// проход оборван пределом или сбоем итератора, непроверенные EXDATE
// выдаются как есть: скорее закрытый слот, чем пропавшее исключение.
function excludedSlots(o: CalendarObject): ExcludedSlot[] {
  if (!o.master) return [];
  const entries = listEntries(o.master, "exdate", o);
  if (entries.length === 0) return [];
  const wanted = new Set(entries.map((entry) => entry.key));
  const last = [...wanted].reduce((a, b) => (compareSlotKeys(a, b) >= 0 ? a : b));
  const found = new Map<SlotKey, ICAL.Time>();
  let reached: SlotKey | undefined;
  let complete = true;
  try {
    let seen = 0;
    for (const slot of iterateSlots(o, { until: last })) {
      if (++seen > SERIES_CAP) {
        complete = false;
        break;
      }
      reached = slot.key;
      if (slot.excluded && wanted.has(slot.key)) found.set(slot.key, slot.time);
    }
  } catch (error) {
    if (!(error instanceof SlotScanError)) throw error;
    complete = false;
  }
  if (!complete) {
    for (const entry of entries) {
      if (found.has(entry.key) || (reached !== undefined && compareSlotKeys(entry.key, reached) <= 0)) continue;
      found.set(entry.key, inSeriesForm(o, entry.time));
    }
  }
  return [...found].map(([key, address]) => ({ key, address })).sort((a, b) => compareSlotKeys(a.key, b.key));
}

// Отступления серии от правила для get_event (Р5–Р7): закрытые слоты,
// переопределения по ролям, дубли. Порядок — по адресу; при одном адресе —
// сначала закрытый слот, затем показываемый компонент, затем дубли.
function exceptionsOf(o: CalendarObject): EventException[] {
  const rows: Array<{ key: SlotKey; order: number; entry: EventException }> = [];
  const times = (c: ICAL.Component) => {
    const { start, end } = timesOf(c, o.env);
    return { start: formatForModel(start, o.env, "time"), end: formatForModel(end, o.env, "time") };
  };
  const summary = (c: ICAL.Component) => textOf(c, "summary");
  const withSummary = (entry: EventException, c: ICAL.Component): EventException => {
    const text = summary(c);
    return text === undefined ? entry : { ...entry, summary: text };
  };

  for (const { key, address } of excludedSlots(o)) {
    rows.push({
      key,
      order: 0,
      entry: { instanceStart: formatForModel(address, o.env, "instance"), state: "excluded", reason: "встреча удалена из серии (EXDATE)" },
    });
  }

  for (const [key, refs] of o.overrides) {
    const role = roleOf(o, refs);
    if (role === "hidden") {
      const hidden = hiddenOf(o, key, refs);
      const why = hidden.reason === "excluded"
        ? "RECURRENCE-ID закрыт EXDATE: встречи нет, а компонент остался"
        : "RECURRENCE-ID вне серии — раньше первой или позже последней встречи";
      for (const ref of refs) {
        rows.push({
          key,
          order: 1,
          entry: withSummary({
            instanceStart: hidden.instanceStart,
            state: "hidden",
            ...times(ref.component),
            reason: `${why}; в выдаче его нет, его можно только удалить (delete_event со scope this по этому адресу)`,
          }, ref.component),
        });
      }
      continue;
    }
    const instance = explicitInstance(o, key, refs);
    if (!instance) continue;
    const range = refs.find((ref) => ref.component === instance.shown)?.range === "thisandfuture"
      ? "; RANGE=THISANDFUTURE — сдвиг и поля действуют и на все следующие встречи"
      : "";
    const cancelled = instance.cancelled ? "; встреча отменена (STATUS:CANCELLED) и время не занимает" : "";
    let state: EventException["state"];
    let reason: string;
    if (role === "detached") {
      state = "detached";
      reason = `RECURRENCE-ID не совпадает ни с одной встречей серии: показывается отдельной встречей по этому адресу${cancelled}`;
    } else if (instance.cancelled) {
      state = "cancelled";
      reason = `встреча отменена (STATUS:CANCELLED) и время не занимает${range}`;
    } else if (instance.moved) {
      state = "moved";
      reason = `встреча перенесена: адрес прежний, фактическое начало — start${range}`;
    } else {
      state = "changed";
      reason = `у встречи изменены поля, время прежнее${range}`;
    }
    rows.push({
      key,
      order: 1,
      entry: withSummary({
        instanceStart: instance.instanceStart,
        state,
        start: formatForModel(instance.start, o.env, "time"),
        end: formatForModel(instance.end, o.env, "time"),
        reason,
      }, instance.shown),
    });
    for (const ref of refs) {
      if (ref.component === instance.shown) continue;
      rows.push({
        key,
        order: 2,
        entry: withSummary({
          instanceStart: instance.instanceStart,
          state: "duplicate",
          ...times(ref.component),
          reason: "лишний компонент с тем же RECURRENCE-ID: показывается другой (больший SEQUENCE, затем поздний DTSTAMP, затем последний в файле)",
        }, ref.component),
      });
    }
  }
  return rows
    .sort((a, b) => compareSlotKeys(a.key, b.key) || a.order - b.order)
    .map((row) => row.entry);
}
