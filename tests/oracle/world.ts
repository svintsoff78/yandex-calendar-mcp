// Мир оракула: как выглядит календарь до и после записи и какие у затравки
// бывают адреса. Всё здесь — только чтение (src/ical/instances.ts,
// src/ical/values.ts): планировщик и предохранитель тут не участвуют, чтобы
// ожидание считалось независимо от них.
import ICAL from "ical.js";
import { hiddenOverrides, instancesBetween, parseAddress, type Instance } from "../../src/ical/instances.js";
import { isUnparsable, loadObject, type CalendarObject } from "../../src/ical/object.js";
import { compareSlotKeys, formOf, formatForModel, instantOf, listKeys, type IcalEnv, type SlotKey } from "../../src/ical/values.js";

/** Пояс календаря и владелец — как у стенда (tests/support/context.ts). */
export const ENV: IcalEnv = { floatingZone: "Europe/Moscow", ownerEmail: "user@yandex.ru" };

/** Неподвижные часы оракула: до начала всех затравок (STAND_NOW стенда). */
export const NOW = Date.parse("2026-10-01T09:00:00Z");

/**
 * Горизонт разворота. Нижняя граница — раньше любого DTSTART корпуса,
 * верхняя — дальше, чем «сейчас» плюс два года; упор — 400 встреч.
 * Проба «за концом» — PROBE: серия считается конечной, если последняя её
 * встреча раньше пробы и упор не сработал.
 */
export const HORIZON_FROM = Date.parse("2026-01-01T00:00:00Z");
export const HORIZON_TO = Date.parse("2029-01-01T00:00:00Z");
export const HORIZON_CAP = 400;
export const PROBE = Date.parse("2028-06-01T00:00:00Z");

export function load(ics: string): CalendarObject {
  const object = loadObject(ics, ENV);
  if (isUnparsable(object)) throw new Error(`объект не разобран: ${object.error}`);
  return object;
}

/** Снимок одной видимой встречи: всё, что видит пользователь. */
export interface Snap {
  /** Адрес встречи (Р10), как его отдаёт чтение. */
  address: string;
  key: SlotKey;
  startMs: number;
  endMs: number;
  allDay: boolean;
  summary: string;
  description: string;
  location: string;
  status: string;
  attendees: string;
  /** Фактическое начало не совпадает с адресом. */
  moved: boolean;
  /** Встреча задана только основным компонентом: её ожидание считается точно. */
  plain: boolean;
  kind: Instance["kind"];
  /** Копии начала и конца в форме и поясе объекта — для расчёта ожидаемого времени. */
  startTime: ICAL.Time;
  endTime: ICAL.Time;
  /** Напоминания того компонента, который показан пользователю. */
  alarms: Alarms;
}

/** Напоминания одного компонента: в выдачу встречи они не попадают, но записью правятся. */
export interface Alarms {
  /** Устойчивая подпись всех VALARM: действие, триггер и адресаты, по одному на строку. */
  signature: string;
  /** Напоминаний письмом без единого ATTENDEE: RFC 5545 §3.6.6 требует адресата. */
  emailWithoutRecipient: number;
}

/** Развёрнутый календарь: встречи всех объектов и признак «серия кончилась». */
export interface World {
  snaps: Snap[];
  /** Ни одной встречи после пробы и упор не сработал. */
  ends: boolean;
  /** Упор в 400 встреч сработал. */
  capped: boolean;
  /** Объектов на сервере после записи. */
  objects: number;
}

function textOf(component: ICAL.Component, name: string): string {
  const value = component.getFirstPropertyValue(name);
  return value === null || value === undefined ? "" : String(value);
}

function attendeesOf(component: ICAL.Component): string {
  return component
    .getAllProperties("attendee")
    .map((p) => {
      const value = String(p.getFirstValue() ?? "").toLowerCase();
      const partstat = String(p.getParameter("partstat") ?? "").toUpperCase();
      return `${value}/${partstat}`;
    })
    .sort()
    .join(",");
}

/** Напоминания компонента: подпись для сравнения и счёт писем без адресата. */
function alarmsOf(component: ICAL.Component): Alarms {
  const lines: string[] = [];
  let emailWithoutRecipient = 0;
  for (const alarm of component.getAllSubcomponents("valarm")) {
    const action = String(alarm.getFirstPropertyValue("action") ?? "").toUpperCase();
    const trigger = alarm.getFirstProperty("trigger");
    const related = trigger ? String(trigger.getParameter("related") ?? "START").toUpperCase() : "";
    const when = trigger ? String(trigger.getFirstValue() ?? "") : "";
    const to = alarm
      .getAllProperties("attendee")
      .map((p) => String(p.getFirstValue() ?? "").toLowerCase())
      .sort()
      .join(",");
    if (action === "EMAIL" && to === "") emailWithoutRecipient += 1;
    lines.push(`${action}|${when}|${related}|${to}`);
  }
  lines.sort();
  return { signature: lines.join(";"), emailWithoutRecipient };
}

function snapOf(instance: Instance): Snap {
  return {
    address: instance.instanceStart,
    key: instance.key,
    startMs: instance.startMs,
    endMs: instance.endMs,
    allDay: formOf(instance.start) === "date",
    summary: textOf(instance.shown, "summary"),
    description: textOf(instance.shown, "description"),
    location: textOf(instance.shown, "location"),
    status: textOf(instance.shown, "status").toUpperCase(),
    attendees: attendeesOf(instance.shown),
    moved: instance.moved,
    plain: instance.kind === "slot" && !instance.moved,
    kind: instance.kind,
    startTime: instance.start.clone(),
    endTime: instance.end.clone(),
    alarms: alarmsOf(instance.shown),
  };
}

/** Порядок снимков: по началу, затем по адресу — чтобы списки сравнивались устойчиво. */
function order(a: Snap, b: Snap): number {
  return a.startMs - b.startMs || (a.address < b.address ? -1 : a.address > b.address ? 1 : 0);
}

/** Развернуть несколько объектов (после разреза их два) в один мир. */
export function worldOf(icsList: readonly string[]): World {
  const snaps: Snap[] = [];
  let capped = false;
  for (const ics of icsList) {
    const o = load(ics);
    const instances = instancesBetween(o, HORIZON_FROM, HORIZON_TO);
    if (instances.length >= HORIZON_CAP) capped = true;
    for (const instance of instances.slice(0, HORIZON_CAP)) snaps.push(snapOf(instance));
  }
  snaps.sort(order);
  const last = snaps.length === 0 ? undefined : snaps[snaps.length - 1];
  return { snaps, capped, ends: !capped && (last === undefined || last.startMs < PROBE), objects: icsList.length };
}

/** Строка снимка целиком — для сравнения множеств. */
export const SEP = "\u0001";

export function sigOf(s: Snap): string {
  return [s.address, s.startMs, s.endMs, s.allDay ? "D" : "T", s.summary, s.description, s.location, s.status, s.attendees].join(SEP);
}

/** Только время и адрес: этим патч поля двигать не вправе. */
export function timeSigOf(s: Snap): string {
  return [s.address, s.startMs, s.endMs, s.allDay ? "D" : "T"].join(SEP);
}

/** Только видимые поля: этим патч времени менять не вправе. */
export function fieldSigOf(s: Snap): string {
  return [s.summary, s.description, s.location, s.status, s.attendees].join(SEP);
}

/** Читаемая строка встречи для findings.json. */
export function showSnap(s: Snap): string {
  return `${s.address} → ${new Date(s.startMs).toISOString()}–${new Date(s.endMs).toISOString()} ${s.allDay ? "[весь день] " : ""}${s.summary}`;
}

// ---------------------------------------------------------------------------
// Адреса
// ---------------------------------------------------------------------------

/** Ключ адреса в форме объекта; undefined — адрес объекту не подходит. */
export function keyOfAddress(o: CalendarObject, address: string): SlotKey | undefined {
  try {
    return parseAddress(o, address);
  } catch {
    return undefined;
  }
}

export function keyAtLeast(key: SlotKey, boundary: SlotKey): boolean {
  return compareSlotKeys(key, boundary) >= 0;
}

/**
 * Адрес «за концом серии»: последняя видимая встреча плюс семь суток, в
 * форме адреса объекта. Арифметика — средствами ical.js (Time.adjust), без
 * Date и без пояса процесса.
 */
function pastEndAddress(o: CalendarObject, last: Instance | undefined): string | undefined {
  if (!last) return undefined;
  const time = last.address.clone();
  time.adjust(7, 0, 0, 0);
  return formatForModel(time, o.env, "instance");
}

/** Адреса затравки по ролям (пункт 3 задания). */
export function addressesOf(o: CalendarObject): Map<string, string | undefined> {
  const instances = instancesBetween(o, HORIZON_FROM, HORIZON_TO).slice(0, HORIZON_CAP);
  const map = new Map<string, string | undefined>();
  map.set("none", undefined);
  // У бесконечной серии (упор сработал) последней встречи нет, а «средняя»
  // берётся из первых тридцати: адрес у самого упора сравнивать не с чем —
  // миры «до» и «после» у края упора кончаются в разных местах.
  const capped = instances.length >= HORIZON_CAP;
  const usable = capped ? instances.slice(0, 30) : instances;
  if (instances.length > 0) {
    map.set("first", instances[0].instanceStart);
    map.set("middle", usable[Math.floor(usable.length / 2)].instanceStart);
    if (!capped) map.set("last", instances[instances.length - 1].instanceStart);
  }
  const slotOverride = instances.find((i) => i.kind === "override" && !i.moved);
  if (slotOverride) map.set("slot-override", slotOverride.instanceStart);
  const moved = instances.find((i) => i.moved && i.kind !== "detached");
  if (moved) map.set("moved-override", moved.instanceStart);
  const detached = instances.find((i) => i.kind === "detached");
  if (detached) map.set("detached", detached.instanceStart);

  // Слот под EXDATE: ключ значения EXDATE, которого нет среди видимых.
  const master = o.master;
  if (master) {
    for (const property of master.getAllProperties("exdate")) {
      const values = property.getValues() as Array<ICAL.Time | ICAL.Period>;
      const value = values[0];
      if (!value) continue;
      const time = value instanceof ICAL.Period ? value.start : value;
      map.set("excluded", formatForModel(time.clone(), o.env, "instance"));
      break;
    }
  }
  const hidden = hiddenOverrides(o)[0];
  if (hidden) map.set("hidden", hidden.instanceStart);
  // Адрес «за концом серии» есть только у серии, которая в горизонте
  // кончается: у бесконечной любой поздний адрес — обычный слот.
  const last = instances[instances.length - 1];
  if (!capped && last && last.startMs < PROBE) {
    map.set("past-end", pastEndAddress(o, last));
  }
  return map;
}

/** Ключи значений RDATE основного компонента: их слоты живут по своим правилам (Р1). */
export function rdateKeysOf(o: CalendarObject): Set<SlotKey> {
  return new Set(o.master ? listKeys(o.master, "rdate", o) : []);
}

/** Момент ICAL.Time в миллисекундах Unix — через values.ts, без пояса процесса. */
export function msOf(time: ICAL.Time, env: IcalEnv = ENV): number {
  return instantOf(time, env);
}
