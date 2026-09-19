import { createHash } from "node:crypto";
import ICAL from "ical.js";
import type { EditScope } from "../types.js";
import {
  SERIES_CAP,
  SlotScanError,
  findSlot,
  isDtstartSynced,
  iterateSlots,
  probeRules,
  seriesExtent,
  seriesZoneOf,
  type Slot,
} from "./slots.js";
import { registerTimeZone, vtimezoneFor } from "./timezones.js";
import {
  compareSlotKeys,
  formOf,
  formatForModel,
  instantOf,
  listEntries,
  listKeys,
  slotKeyOf,
  timeInForm,
  type IcalEnv,
  type KeyContext,
  type SlotKey,
  type TimeForm,
  type ZoneRef,
} from "./values.js";

/**
 * Календарный объект как дерево ical.js: основная серия, переопределения,
 * EXDATE и RDATE (§1–§4 плана переделки,
 * docs/superpowers/plans/2026-09-19-recurring-events-rework.md).
 *
 * - Основной компонент — VEVENT без RECURRENCE-ID, где бы он ни стоял в
 *   файле; больше одного — аномалия (О1). Яндекс ставит основной первым (Ж2),
 *   но другие клиенты — не обязательно.
 * - Переопределения индексируются ключом RECURRENCE-ID в форме серии (О3) и
 *   получают одну из трёх ролей строго по порядку: slot, hidden, detached
 *   (Р5 в редакции поправки «без ремонта следов прежнего кода» от 19.09.2026).
 *   Эвристик «следов прежнего кода» нет: прежний код в календари
 *   пользователей не писал, а распознавание следов принимало законную
 *   перенесённую встречу за след и прятало её.
 * - Текст, который ical.js не разбирает (плохое RRULE роняет уже
 *   `ICAL.parse`: parse.js:288,310 → design.js:469 → recur.js:498-569), —
 *   `Unparsable` с UID, SUMMARY и DTSTART из построчного разбора (Р4).
 * - TZID, у которых нет VTIMEZONE в объекте, регистрируются из базы IANA до
 *   первого чтения значений: неизвестный пояс ical.js молча читает плавающим
 *   и кеширует (time.js, fromDateTimeString; property.js, _hydrateValue).
 *   VTIMEZONE из объекта предпочитается базе (time.js, fromDateTimeString →
 *   component.js:597, getTimeZoneByID) — это важно, потому что Яндекс кладёт
 *   полное историческое описание пояса (Ж10), а база @touch4it упрощённая.
 * - `semanticDigest` — дайджест по смыслу для сверки неизвестного исхода
 *   записи (Р8 и поправка по Ж5, Ж10, Ж12).
 *
 * Пояс процесса не участвует нигде: моменты — через values.ts.
 */

// ─────────────────────────────── типы ───────────────────────────────

export type ObjectKind = "single" | "series" | "detached";

/** Роль переопределения (Р5): ровно три, по порядку правил. */
export type OverrideRole = "slot" | "hidden" | "detached";

export type AnomalyCode =
  | "multiple-masters"
  | "mixed-uids"
  | "unknown-tzid"
  | "bad-rrule"
  | "no-positions"
  | "range-override"
  | "duplicate-override"
  | "exrule"
  | "multiple-rrules"
  | "unsynced-dtstart"
  | "rdate-boundary";

/** Отступление объекта от модели (О14, Р4, Р5). `message` — по-русски. */
export interface Anomaly {
  code: AnomalyCode;
  message: string;
  /** Ключ слота или RECURRENCE-ID, к которому относится аномалия. */
  key?: SlotKey;
  /** Компоненты, в которых она найдена. */
  components?: readonly ICAL.Component[];
  /** Для unknown-tzid — неизвестный пояс. */
  tzid?: string;
}

/** Переопределение: компонент с RECURRENCE-ID. */
export interface OverrideRef {
  component: ICAL.Component;
  /** Ключ RECURRENCE-ID в форме серии (О3). */
  key: SlotKey;
  /** Копия значения RECURRENCE-ID. */
  recurrenceId: ICAL.Time;
  /** RANGE=THISANDFUTURE (Р7): читается по RFC, запись — только delete all_series. */
  range?: "thisandfuture";
  /** STATUS:CANCELLED — встреча отменена и время не занимает (Р7). */
  cancelled: boolean;
}

/**
 * Роль переопределения (Р5), правила проверяются строго по порядку:
 * 1. slot — RECURRENCE-ID на незакрытом слоте серии; `slot` — этот слот
 *    (равен ключу RECURRENCE-ID). Встреча слота показывается по его адресу;
 * 2. hidden — RECURRENCE-ID под EXDATE (в том числе мимо слотов) или вне
 *    протяжённости серии [первый слот, последний слот конечной серии]: в
 *    list_events и find_free_slots его нет, удаляется delete this по своему
 *    RECURRENCE-ID;
 * 3. detached — остальные: показывается отдельной встречей с
 *    `instanceStart` = RECURRENCE-ID, занимает время, правится и удаляется
 *    по своему RECURRENCE-ID. У объекта без основного компонента все
 *    переопределения — detached (Р6).
 * Совпадение RECURRENCE-ID одного переопределения с DTSTART другого ничего
 * не значит: так выглядят и законные переносы (цикл «понедельник ↔ среда»).
 */
export interface OverrideRoleInfo {
  role: OverrideRole;
  ref: OverrideRef;
  /** Только у роли slot. */
  slot?: SlotKey;
}

export interface CalendarObject extends KeyContext {
  readonly kind: ObjectKind;
  readonly root: ICAL.Component;
  /** UID основного компонента (без него — первого VEVENT). */
  readonly uid: string;
  readonly master: ICAL.Component | null;
  /** Форма DTSTART основного (без него — RECURRENCE-ID первого переопределения). */
  readonly form: TimeForm;
  /** TZID DTSTART при форме zoned. */
  readonly tzid?: string;
  /**
   * Пояс для записи значений в форме серии через `timeInForm` (О4): объект
   * пояса из дерева, имя для TZID-синонима UTC, пояс календаря для
   * неизвестного TZID. Только при форме zoned.
   */
  readonly zone?: ZoneRef;
  /** Переопределения по ключу RECURRENCE-ID, по возрастанию ключа; дубли — в одном списке по порядку файла. */
  readonly overrides: ReadonlyMap<SlotKey, readonly OverrideRef[]>;
  readonly roles: ReadonlyMap<ICAL.Component, OverrideRoleInfo>;
  readonly anomalies: readonly Anomaly[];
  readonly env: IcalEnv;
}

/**
 * Объект, который ical.js не разобрал (или в нём нет VEVENT, или у VEVENT нет
 * DTSTART). Поля — построчным разбором с развёрткой строк, у основного
 * компонента (без RECURRENCE-ID), иначе у первого VEVENT. `dtstartRaw` —
 * строка DTSTART целиком, с параметрами.
 */
export interface Unparsable {
  kind: "unparsable";
  uid?: string;
  summary?: string;
  dtstartRaw?: string;
  error: string;
}

// ─────────────────────────────── загрузка ───────────────────────────────

/** Разбирает текст объекта в модель (О1, О14, Р4, Р5). Не бросает: всё неразбираемое — `Unparsable`. */
export function loadObject(ics: string, env: IcalEnv): CalendarObject | Unparsable {
  let jcal: unknown;
  try {
    jcal = ICAL.parse(ics);
  } catch (error) {
    return unparsableOf(ics, `ical.js не разобрал текст объекта: ${messageOf(error)}`);
  }
  try {
    return build(jcal, ics, env);
  } catch (error) {
    return unparsableOf(ics, `Объект не прочитан: ${messageOf(error)}`);
  }
}

export function isUnparsable(object: CalendarObject | Unparsable): object is Unparsable {
  return object.kind === "unparsable";
}

function build(jcal: unknown, ics: string, env: IcalEnv): CalendarObject | Unparsable {
  if (!Array.isArray(jcal) || typeof jcal[0] !== "string") {
    return unparsableOf(ics, "В тексте нет календаря или календарей несколько.");
  }
  const root = new ICAL.Component(jcal);
  if (root.name !== "vcalendar") return unparsableOf(ics, `Корень объекта — ${root.name.toUpperCase()}, а не VCALENDAR.`);
  const events = root.getAllSubcomponents("vevent");
  if (events.length === 0) return unparsableOf(ics, "В объекте нет VEVENT.");

  const anomalies: Anomaly[] = [];
  registerZones(root, events, anomalies); // до первого чтения значений
  if (events.some((event) => !event.hasProperty("dtstart"))) return unparsableOf(ics, "У VEVENT нет DTSTART.");

  const masters = events.filter((event) => !event.hasProperty("recurrence-id"));
  const master = masters[0] ?? null;
  const uidOf = (event: ICAL.Component) => String(event.getFirstPropertyValue("uid") ?? "");
  const uid = uidOf(master ?? events[0]);
  const uids = [...new Set(events.map(uidOf))];
  if (masters.length > 1) {
    anomalies.push({
      code: "multiple-masters",
      message: `в объекте ${masters.length} основных компонента (VEVENT без RECURRENCE-ID); основным считается первый`,
      components: masters,
    });
  }
  if (uids.length > 1) {
    anomalies.push({ code: "mixed-uids", message: `в объекте несколько UID: ${uids.join(", ")}`, components: events });
  }

  const formProperty = master ? master.getFirstProperty("dtstart")! : events[0].getFirstProperty("recurrence-id")!;
  const form = formOf(formProperty);
  const tzid = form === "zoned" ? String(formProperty.getParameter("tzid")) : undefined;
  const zone = seriesZoneOf(formProperty, env);
  if (master) ruleAnomalies(master, env, anomalies);

  const refs = events
    .filter((event) => event.hasProperty("recurrence-id"))
    .map((component): OverrideRef => {
      const property = component.getFirstProperty("recurrence-id")!;
      const recurrenceId = (property.getFirstValue() as ICAL.Time).clone();
      const range = String(property.getParameter("range") ?? "").toUpperCase() === "THISANDFUTURE" ? "thisandfuture" : undefined;
      const status = String(component.getFirstPropertyValue("status") ?? "").toUpperCase();
      return { component, key: slotKeyOf(recurrenceId, form, env), recurrenceId, range, cancelled: status === "CANCELLED" };
    });
  const grouped = new Map<SlotKey, OverrideRef[]>();
  for (const ref of refs) grouped.set(ref.key, [...(grouped.get(ref.key) ?? []), ref]);
  const overrides = new Map([...grouped.entries()].sort(([a], [b]) => compareSlotKeys(a, b)));

  const object: CalendarObject = {
    kind: master ? (master.hasProperty("rrule") || master.hasProperty("rdate") ? "series" : "single") : "detached",
    root,
    uid,
    master,
    form,
    tzid,
    zone,
    overrides,
    roles: new Map(),
    anomalies,
    env,
  };

  for (const [key, list] of overrides) {
    if (list.length > 1) {
      anomalies.push({
        code: "duplicate-override",
        message: `у встречи ${describeKey(list[0].recurrenceId, env)} ${list.length} компонента с одним RECURRENCE-ID`,
        key,
        components: list.map((ref) => ref.component),
      });
    }
  }
  for (const ref of refs) {
    if (ref.range) {
      anomalies.push({
        code: "range-override",
        message: `переопределение ${describeKey(ref.recurrenceId, env)} с RANGE=THISANDFUTURE меняет и все следующие встречи; правка не поддерживается`,
        key: ref.key,
        components: [ref.component],
      });
    }
  }
  assignRoles(object, object.roles as Map<ICAL.Component, OverrideRoleInfo>);
  return object;
}

// Регистрирует из базы IANA пояса, на которые ссылаются VEVENT и их
// подкомпоненты, но которых нет среди VTIMEZONE объекта. Неизвестные —
// аномалия unknown-tzid (значения ical.js прочтёт плавающими).
function registerZones(root: ICAL.Component, events: ICAL.Component[], anomalies: Anomaly[]): void {
  const defined = new Set(root.getAllSubcomponents("vtimezone").map((zone) => String(zone.getFirstPropertyValue("tzid") ?? "")));
  const unknown = new Map<string, ICAL.Component[]>();
  for (const event of events) {
    for (const tzid of tzidsIn(event)) {
      if (defined.has(tzid)) continue;
      try {
        registerTimeZone(tzid);
      } catch {
        const list = unknown.get(tzid) ?? [];
        if (!list.includes(event)) list.push(event);
        unknown.set(tzid, list);
      }
    }
  }
  for (const [tzid, components] of unknown) {
    anomalies.push({
      code: "unknown-tzid",
      message: `пояс ${tzid} неизвестен: его время читается как стенное время календаря`,
      tzid,
      components,
    });
  }
}

// TZID параметров свойств компонента и его подкомпонентов — по jCal, без
// разбора значений (параметры в jCal — в нижнем регистре).
function tzidsIn(component: ICAL.Component): Set<string> {
  const found = new Set<string>();
  const walk = (jcal: unknown[]) => {
    for (const property of jcal[1] as unknown[][]) {
      const tzid = (property[1] as Record<string, unknown>).tzid;
      if (typeof tzid === "string" && tzid) found.add(tzid);
    }
    for (const sub of jcal[2] as unknown[][]) walk(sub);
  };
  walk(component.jCal);
  return found;
}

function ruleAnomalies(master: ICAL.Component, env: IcalEnv, anomalies: Anomaly[]): void {
  const rules = master.getAllProperties("rrule").length;
  if (rules > 1) anomalies.push({ code: "multiple-rrules", message: `у серии ${rules} правила RRULE`, components: [master] });
  if (master.hasProperty("exrule")) {
    anomalies.push({ code: "exrule", message: "у серии есть EXRULE (устаревшее свойство RFC 2445)", components: [master] });
  }
  for (const probe of probeRules(master, env)) {
    const name = probe.name.toUpperCase();
    if (probe.outcome === "bad-rrule" || (probe.name === "exrule" && probe.outcome === "no-positions")) {
      anomalies.push({ code: "bad-rrule", message: `${name} не перебирается: ${probe.message}`, components: [master] });
    } else if (probe.outcome === "no-positions") {
      anomalies.push({ code: "no-positions", message: `${name} не даёт встреч: ${probe.message}`, components: [master] });
    } else if (probe.name === "rrule" && probe.index === 0 && probe.synced === false) {
      anomalies.push({
        code: "unsynced-dtstart",
        message: "DTSTART не совпадает с первой позицией правила (RFC 5545 §3.8.5.3): он — отдельная встреча вне правила",
        components: [master],
      });
    }
  }
}

// ─────────────────────────────── роли (Р5) ───────────────────────────────

// Роли по правилам slot → hidden → detached (см. OverrideRoleInfo). Один
// проход слотов до последнего RECURRENCE-ID: он даёт слоты с ключами
// RECURRENCE-ID, первый слот (его запоминаем, даже если он дальше последнего
// RECURRENCE-ID) и, если серия кончилась раньше, её последний слот. Если
// проход оборван пределом SERIES_CAP или сбоем итератора, конец серии
// неизвестен: RECURRENCE-ID дальше пройденного получает detached —
// встреча показывается, данные не теряются.
function assignRoles(o: CalendarObject, roles: Map<ICAL.Component, OverrideRoleInfo>): void {
  if (o.overrides.size === 0) return;
  const keys = [...o.overrides.keys()]; // по возрастанию ключа
  const infos = new Map<SlotKey, Omit<OverrideRoleInfo, "ref">>();

  if (!o.master) {
    for (const key of keys) infos.set(key, { role: "detached" }); // Р6
  } else {
    const wanted = new Set(keys);
    const bound = keys[keys.length - 1];
    const onKeys = new Map<SlotKey, Slot>(); // слоты с ключом какого-либо RECURRENCE-ID
    let first: Slot | undefined;
    let last: Slot | undefined; // последний пройденный слот
    let ended = true; // серия кончилась, не дойдя дальше последнего RECURRENCE-ID
    let seen = 0;
    try {
      for (const slot of iterateSlots(o)) {
        first ??= slot;
        if (compareSlotKeys(slot.key, bound) > 0 || ++seen > SERIES_CAP) {
          ended = false;
          break;
        }
        if (wanted.has(slot.key)) onKeys.set(slot.key, slot);
        last = slot;
      }
    } catch (error) {
      if (!(error instanceof SlotScanError)) throw error;
      ended = false;
    }
    const exdates = new Set(listKeys(o.master, "exdate", o));

    for (const key of keys) {
      const slot = onKeys.get(key);
      // 1. slot
      if (slot && !slot.excluded) infos.set(key, { role: "slot", slot: key });
      // 2. hidden: под EXDATE (EXRULE — тоже) или вне протяжённости серии
      else if (slot?.excluded || exdates.has(key)) infos.set(key, { role: "hidden" });
      else if (first && compareSlotKeys(key, first.key) < 0) infos.set(key, { role: "hidden" });
      else if (ended && last && compareSlotKeys(key, last.key) > 0) infos.set(key, { role: "hidden" });
      // 3. detached
      else infos.set(key, { role: "detached" });
    }
  }

  for (const [key, info] of infos) {
    for (const ref of o.overrides.get(key) ?? []) roles.set(ref.component, { ...info, ref });
  }
}

function describeKey(t: ICAL.Time, env: IcalEnv): string {
  return formatForModel(t, env, "instance");
}

/**
 * Какой из компонентов с одним RECURRENCE-ID показывать (Р5): больший
 * SEQUENCE, затем более поздний DTSTAMP, затем последний в файле.
 */
export function shownOverride(refs: readonly OverrideRef[]): OverrideRef {
  if (refs.length === 0) throw new Error("Нет переопределений для выбора.");
  const sequence = (ref: OverrideRef) => Number(ref.component.getFirstPropertyValue("sequence") ?? 0) || 0;
  const stamp = (ref: OverrideRef) => {
    const value = ref.component.getFirstPropertyValue("dtstamp");
    return value instanceof ICAL.Time ? value.toUnixTime() : Number.NEGATIVE_INFINITY;
  };
  let best = refs[0];
  for (const ref of refs.slice(1)) {
    const bySequence = sequence(ref) - sequence(best);
    if (bySequence > 0 || (bySequence === 0 && stamp(ref) >= stamp(best))) best = ref;
  }
  return best;
}

/**
 * Встреча слота `slot`: переопределения с ролью slot и этим RECURRENCE-ID
 * по порядку файла и то, чьё время и поля показывать (у дублей —
 * `shownOverride`). Встреча одна, сколько бы компонентов ни было (Р5).
 * Слот без переопределений — undefined: показывается основной компонент.
 * Скрытые (hidden) не показываются, оторванные (detached) показываются
 * отдельно по своему RECURRENCE-ID — ни те ни другие к слоту не относятся.
 */
export function meetingAt(o: CalendarObject, slot: SlotKey): { shown: ICAL.Component; components: ICAL.Component[] } | undefined {
  const refs = (o.overrides.get(slot) ?? []).filter((ref) => o.roles.get(ref.component)?.role === "slot");
  if (refs.length === 0) return undefined;
  return { shown: shownOverride(refs).component, components: refs.map((ref) => ref.component) };
}

// ─────────────────────────── блокировки записи (О14) ───────────────────────────

export type EditOp = "update" | "delete";

/**
 * Цель записи для `blockingAnomalies`:
 * - `key` — слот цели или RECURRENCE-ID её компонента;
 * - `split` — запись разрезает серию (t&f, у которого до границы есть видимые
 *   встречи; иначе t&f равен all_series, Р2).
 */
export interface BlockTarget {
  key?: SlotKey;
  split?: boolean;
}

/**
 * Аномалии, которые запрещают эту запись (О14). delete all_series не
 * блокируется ничем. Прочее:
 * - bad-rrule, no-positions, multiple-masters, mixed-uids, range-override —
 *   любая запись;
 * - unknown-tzid — если запись трогает значения в этом поясе: scope this —
 *   основной компонент или компоненты цели, иначе всегда;
 * - duplicate-override — в слоте цели, кроме delete this;
 * - при разрезе — EXRULE, несколько RRULE, DTSTART вне правила при COUNT,
 *   граница из RDATE при наличии RRULE (rdate-boundary).
 * Unparsable сюда не попадает: у него нет дерева, решает вызывающий код.
 */
export function blockingAnomalies(o: CalendarObject, op: EditOp, scope: EditScope, target: BlockTarget = {}): Anomaly[] {
  if (op === "delete" && scope === "all_series") return [];
  const blocking = o.anomalies.filter((anomaly) => blocks(o, anomaly, op, scope, target));

  if (target.split && target.key !== undefined && o.master?.hasProperty("rrule")) {
    let slot: Slot | undefined;
    try {
      slot = findSlot(o, target.key);
    } catch (error) {
      if (!(error instanceof SlotScanError)) throw error;
    }
    if (slot && !slot.sources.includes("rrule") && !slot.sources.includes("dtstart")) {
      blocking.push({
        code: "rdate-boundary",
        message: `встреча ${formatForModel(slot.time, o.env, "instance")} задана RDATE, а не правилом: разрезать серию на ней нельзя`,
        key: target.key,
      });
    }
  }
  return blocking;
}

function blocks(o: CalendarObject, anomaly: Anomaly, op: EditOp, scope: EditScope, target: BlockTarget): boolean {
  switch (anomaly.code) {
    case "bad-rrule":
    case "no-positions":
    case "multiple-masters":
    case "mixed-uids":
    case "range-override":
      return true;
    case "unknown-tzid":
      return scope !== "this" || touchesTarget(o, anomaly, target.key);
    case "duplicate-override":
      return target.key !== undefined && anomaly.key === target.key && !(op === "delete" && scope === "this");
    case "exrule":
    case "multiple-rrules":
      return Boolean(target.split);
    case "unsynced-dtstart":
      return Boolean(target.split) && Boolean((o.master?.getFirstPropertyValue("rrule") as ICAL.Recur | null)?.count);
    case "rdate-boundary":
      return false;
  }
}

function touchesTarget(o: CalendarObject, anomaly: Anomaly, key: SlotKey | undefined): boolean {
  const components = new Set(anomaly.components ?? []);
  if (o.master && components.has(o.master)) return true;
  if (key === undefined) return false;
  for (const ref of o.overrides.get(key) ?? []) if (components.has(ref.component)) return true;
  return false;
}

/** Аномалия для CalendarEvent.anomalies: «код: пояснение». */
export function formatAnomaly(anomaly: Anomaly): string {
  return `${anomaly.code}: ${anomaly.message}`;
}

// ─────────────────────────────── запись ───────────────────────────────

/** Текст объекта; строки через CRLF, в конце — CRLF (RFC 5545 §3.1). */
export function serializeObject(o: CalendarObject): string {
  return `${o.root.toString()}\r\n`;
}

/**
 * Добавляет VTIMEZONE для поясов из `tzids`, которых в объекте нет (О5:
 * VTIMEZONE только добавляются, имеющиеся не трогаются). Копия — из базы
 * IANA (timezones.ts, vtimezoneFor), в конец подкомпонентов
 * (component.js, addSubcomponent). Возвращает добавленные TZID.
 */
export function ensureTimezones(root: ICAL.Component, tzids: Iterable<string>): string[] {
  const present = new Set(root.getAllSubcomponents("vtimezone").map((zone) => String(zone.getFirstPropertyValue("tzid") ?? "")));
  const added: string[] = [];
  for (const tzid of tzids) {
    if (present.has(tzid)) continue;
    root.addSubcomponent(vtimezoneFor(tzid));
    present.add(tzid);
    added.push(tzid);
  }
  return added;
}

// ─────────────────────────────── дайджест (Р8) ───────────────────────────────

/** Сколько первых незакрытых слотов серии входит в дайджест. */
const DIGEST_SLOTS = 500;

/**
 * Дайджест объекта по смыслу — для сверки неизвестного исхода записи (Р8):
 * совпал с ожидаемым — запись применена. Яндекс переписывает текст правила
 * (Ж5: порядок частей, INTERVAL=1, BYDAY из DTSTART, COUNT → UNTIL), заменяет
 * VTIMEZONE историческим (Ж10), вырезает X-свойства (Ж7), перезаписывает
 * CATEGORIES (Ж8), добавляет ORGANIZER, CREATED, CLASS, URL (Ж9) и меняет ETag
 * при любой записи (Ж12), поэтому в дайджест входит только то, что пишет
 * модель:
 * - UID; SUMMARY, DESCRIPTION, LOCATION, STATUS каждого VEVENT;
 * - DTSTART и DTEND как «стенное значение@TZID|форма» — смена пояса при тех
 *   же моментах ({timeZone}) дайджест меняет, а замена описания пояса — нет;
 *   DURATION — секундами;
 * - участники — адрес и PARTSTAT (без него — NEEDS-ACTION); напоминания —
 *   ACTION и TRIGGER;
 * - серия — раскрытыми слотами: первые 500 незакрытых слотов стенным
 *   временем и протяжённость (бесконечна; или число незакрытых и последний);
 *   кроме того, независимо от этого окна, — все слоты, закрытые EXDATE, и все
 *   слоты из RDATE (`listsPayload`): иначе EXDATE за 500-м слотом бесконечной
 *   серии дайджест не меняло бы;
 * - переопределения — по RECURRENCE-ID, приведённому к форме серии, с RANGE.
 * Не входят: DTSTAMP, LAST-MODIFIED, CREATED, SEQUENCE, X-*, CATEGORIES,
 * ORGANIZER, CLASS, URL, TRANSP, VTIMEZONE, текст RRULE, EXDATE мимо слотов.
 * Неразбираемый текст — по строкам без служебных.
 */
export function semanticDigest(ics: string, env: IcalEnv): string {
  const object = loadObject(ics, env);
  const payload = object.kind === "unparsable" ? unparsablePayload(ics) : objectPayload(object);
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function objectPayload(o: CalendarObject): unknown {
  const events = o.root.getAllSubcomponents("vevent");
  const masters = events.filter((event) => !event.hasProperty("recurrence-id"));
  return {
    v: 1,
    kind: o.kind,
    uids: [...new Set(events.map((event) => String(event.getFirstPropertyValue("uid") ?? "")))].sort(),
    master: o.master ? { fields: fieldsOf(o.master), series: seriesPayload(o) } : null,
    extraMasters: masters.slice(1).map((event) => JSON.stringify(fieldsOf(event))).sort(),
    overrides: events
      .filter((event) => event.hasProperty("recurrence-id"))
      .map((event) => {
        const property = event.getFirstProperty("recurrence-id")!;
        const range = property.getParameter("range");
        return JSON.stringify({ rid: ridIdentity(property, o), range: range ? String(range).toUpperCase() : null, fields: fieldsOf(event) });
      })
      .sort(),
  };
}

function fieldsOf(c: ICAL.Component): unknown {
  const text = (name: string) => {
    const value = c.getFirstPropertyValue(name);
    return value === null || value === undefined ? null : String(value);
  };
  const dtend = c.getFirstProperty("dtend");
  const duration = c.getFirstPropertyValue("duration");
  return {
    summary: text("summary"),
    description: text("description"),
    location: text("location"),
    status: text("status")?.toUpperCase() ?? null,
    start: timeRepr(c.getFirstProperty("dtstart")),
    end: dtend ? timeRepr(dtend) : duration instanceof ICAL.Duration ? `P:${duration.toSeconds()}` : null,
    attendees: c
      .getAllProperties("attendee")
      .map((p) => `${String(p.getFirstValue()).toLowerCase().replace(/^mailto:/, "")}|${String(p.getParameter("partstat") ?? "NEEDS-ACTION").toUpperCase()}`)
      .sort(),
    alarms: c
      .getAllSubcomponents("valarm")
      .map((alarm) => `${String(alarm.getFirstPropertyValue("action") ?? "").toUpperCase()}|${triggerRepr(alarm.getFirstProperty("trigger"))}`)
      .sort(),
  };
}

// «стенное значение@TZID|форма»: jCal-строка значения как записана, её TZID и форма (О3, О4).
function timeRepr(property: ICAL.Property | null): string | null {
  if (!property) return null;
  let raw: unknown = property.jCal[3];
  if (Array.isArray(raw)) raw = raw[0];
  const form = formOf(property);
  return form === "zoned" ? `${String(raw)}@${String(property.getParameter("tzid"))}|zoned` : `${String(raw)}|${form}`;
}

function triggerRepr(property: ICAL.Property | null): string {
  if (!property) return "-";
  if (property.type === "duration") {
    const related = String(property.getParameter("related") ?? "START").toUpperCase();
    return `${(property.getFirstValue() as ICAL.Duration).toSeconds()}|${related}`;
  }
  return timeRepr(property) ?? "-";
}

// RECURRENCE-ID, приведённый к форме серии: в том же TZID — как записан,
// иначе — стенным временем серии (Яндекс может переписать форму RID).
function ridIdentity(property: ICAL.Property, o: CalendarObject): string {
  let raw: unknown = property.jCal[3];
  if (Array.isArray(raw)) raw = raw[0];
  if (!o.master) return timeRepr(property) ?? "-";
  const form = formOf(property);
  if (form === o.form && (form !== "zoned" || property.getParameter("tzid") === o.tzid)) return String(raw);
  try {
    return timeInForm(property.getFirstValue() as ICAL.Time, o.form, o.zone, o.env).toString();
  } catch {
    return timeRepr(property) ?? "-";
  }
}

function seriesPayload(o: CalendarObject): unknown {
  const rulesText = () =>
    ["rrule", "exrule"].flatMap((name) => o.master!.getAllProperties(name).map((p) => p.toICALString()));
  const unusable = o.anomalies.some((anomaly) => anomaly.code === "bad-rrule" || anomaly.code === "no-positions");
  const lists = listsPayload(o);
  try {
    const extent = seriesExtent(o);
    const slots: string[] = [];
    let seen = 0;
    for (const slot of iterateSlots(o)) {
      if (++seen > SERIES_CAP) break;
      if (slot.excluded) continue;
      slots.push(slot.time.toString());
      if (slots.length >= DIGEST_SLOTS) break;
    }
    return {
      extent: extent.kind === "finite" ? `finite:${extent.live}:${extent.lastLive?.time.toString() ?? "-"}` : extent.kind,
      slots,
      ...lists,
      rules: unusable ? rulesText() : undefined,
      synced: isDtstartSynced(o),
    };
  } catch (error) {
    if (!(error instanceof SlotScanError)) throw error;
    return { error: error.code, ...lists, rules: rulesText() };
  }
}

/**
 * EXDATE и RDATE серии — независимо от окна первых DIGEST_SLOTS слотов. У
 * бесконечной серии протяжённость — просто infinite, и без этого удаление
 * сегодняшней встречи давней ежедневной серии (EXDATE далеко за 500-м слотом)
 * дайджест не меняло бы: по Р8 «применено» не распознавалось бы никогда.
 *
 * - `closed` — слоты, закрытые EXDATE, стенным временем в форме серии, как в
 *   `slots` (устойчиво к замене VTIMEZONE, Ж10, и к форме записи EXDATE: в UTC
 *   или в TZID серии — один слот). EXDATE мимо слотов ничего не закрывает и
 *   смысла не несёт — не входит;
 * - `added` — слоты из RDATE (у PERIOD — с длительностью в секундах);
 * - `unscanned` — значения дальше предела прохода SERIES_CAP или после сбоя
 *   перебора: их слоты не проверить, они входят как есть, приведёнными к
 *   форме серии (О4).
 */
function listsPayload(o: CalendarObject): { closed: string[]; added: string[]; unscanned?: string[] } {
  const master = o.master!;
  const exdates = listEntries(master, "exdate", o);
  const rdates = listEntries(master, "rdate", o);
  const all = [...exdates, ...rdates];
  if (all.length === 0) return { closed: [], added: [] };

  const exdateKeys = new Set(exdates.map((entry) => entry.key));
  const until = all.map((entry) => entry.key).reduce((a, b) => (compareSlotKeys(a, b) >= 0 ? a : b));
  const closed = new Set<string>();
  const added = new Set<string>();
  let reached: SlotKey | undefined; // последний проверенный ключ
  let complete = true;
  try {
    let seen = 0;
    for (const slot of iterateSlots(o, { until })) {
      if (++seen > SERIES_CAP) {
        complete = false;
        break;
      }
      reached = slot.key;
      if (slot.excluded && exdateKeys.has(slot.key)) closed.add(slot.time.toString());
      if (slot.sources.includes("rdate")) added.add(rdateRepr(slot, o));
    }
  } catch (error) {
    if (!(error instanceof SlotScanError)) throw error;
    complete = false;
  }
  const payload: { closed: string[]; added: string[]; unscanned?: string[] } = {
    closed: [...closed].sort(),
    added: [...added].sort(),
  };
  if (!complete) {
    const rest = all.filter((entry) => reached === undefined || compareSlotKeys(entry.key, reached) > 0);
    const exdateSet = new Set(exdates);
    payload.unscanned = [...new Set(rest.map((entry) => `${exdateSet.has(entry) ? "EX" : "R"}:${seriesWall(entry.time, o)}`))].sort();
  }
  return payload;
}

// Слот RDATE: стенное время в форме серии; у PERIOD — ещё длительность.
function rdateRepr(slot: Slot, o: CalendarObject): string {
  if (!slot.periodEnd) return slot.time.toString();
  const seconds = (instantOf(slot.periodEnd, o.env) - instantOf(slot.time, o.env)) / 1000;
  return `${slot.time.toString()}/${seconds}`;
}

// Значение в форме серии (О4) стенной строкой; не переводится — как записано.
function seriesWall(t: ICAL.Time, o: CalendarObject): string {
  try {
    return timeInForm(t, o.form, o.zone, o.env).toString();
  } catch {
    return t.toString();
  }
}

function unparsablePayload(ics: string): unknown {
  const volatile = /^(DTSTAMP|LAST-MODIFIED|CREATED|SEQUENCE|X-[^;:]*)[;:]/i;
  return { v: 1, unparsable: unfold(ics).filter((line) => line && !volatile.test(line)) };
}

// ─────────────────────────── построчный разбор (Р4) ───────────────────────────

function unparsableOf(ics: string, error: string): Unparsable {
  interface Found {
    uid?: string;
    summary?: string;
    dtstartRaw?: string;
    override: boolean;
  }
  const events: Found[] = [];
  const stack: string[] = [];
  let current: Found | undefined;
  for (const line of unfold(ics)) {
    const upper = line.toUpperCase();
    if (upper.startsWith("BEGIN:")) {
      stack.push(upper.slice(6).trim());
      if (stack.at(-1) === "VEVENT") {
        current = { override: false };
        events.push(current);
      }
      continue;
    }
    if (upper.startsWith("END:")) {
      if (stack.pop() === "VEVENT") current = undefined;
      continue;
    }
    if (!current || stack.at(-1) !== "VEVENT") continue;
    const parsed = splitContentLine(line);
    if (!parsed) continue;
    switch (parsed.name) {
      case "UID":
        current.uid ??= parsed.value;
        break;
      case "SUMMARY":
        current.summary ??= unescapeText(parsed.value);
        break;
      case "DTSTART":
        current.dtstartRaw ??= line;
        break;
      case "RECURRENCE-ID":
        current.override = true;
        break;
    }
  }
  const chosen = events.find((event) => !event.override) ?? events[0];
  return { kind: "unparsable", uid: chosen?.uid, summary: chosen?.summary, dtstartRaw: chosen?.dtstartRaw, error };
}

// Развёртка строк (RFC 5545 §3.1): перевод строки и один пробел или таб.
function unfold(ics: string): string[] {
  return ics.replace(/\r\n|\r/g, "\n").replace(/\n[ \t]/g, "").split("\n");
}

/** Имя (в верхнем регистре) и значение строки содержимого; двоеточие внутри кавычек параметров не считается. */
export function splitContentLine(line: string): { name: string; value: string } | undefined {
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') quoted = !quoted;
    else if (char === ":" && !quoted) {
      const head = line.slice(0, i);
      const name = head.split(";")[0].trim().toUpperCase();
      return name ? { name, value: line.slice(i + 1) } : undefined;
    }
  }
  return undefined;
}

// RFC 5545 §3.3.11: \\ \; \, \n \N.
function unescapeText(value: string): string {
  return value.replace(/\\([\\;,nN])/g, (_match, char: string) => (char === "n" || char === "N" ? "\n" : char));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
