// Инварианты объекта календаря — независимая от src/ проверка того, что
// лежит на сервере и что клиент в него пишет (О12а плана переделки,
// docs/superpowers/plans/2026-09-19-recurring-events-rework.md):
//
// - не больше одного основного компонента (VEVENT без RECURRENCE-ID), один UID;
// - нет дублей RECURRENCE-ID и EXDATE;
// - у каждого TZID есть VTIMEZONE, у значения в UTC нет TZID;
// - RECURRENCE-ID, EXDATE, RDATE и UNTIL — в форме DTSTART (О4);
// - UNTIL не раньше DTSTART, DTEND позже DTSTART, DURATION положительна;
// - DTEND и DURATION не вместе (RFC 5545 §3.6.1);
// - аномалий (переопределений мимо слотов и под EXDATE) не больше, чем было.
//
// Что считается новым нарушением относительно прежних версий (newViolations,
// writeViolations):
// - два основных компонента, чужой UID, неразбираемый текст и календарь без
//   VEVENT (ABSOLUTE_KINDS) — в любой записи, какой бы ни была прежняя версия;
// - дубли RECURRENCE-ID и EXDATE — по ключам слотов: новый дубль — ключ, у
//   которого лишних компонентов (значений) больше, чем в любой прежней
//   версии; дубль на другом слоте вместо исчезнувшего прежнего — новый;
// - переопределения мимо слотов и под EXDATE — по числу (О12а: «аномалий не
//   больше, чем было»), а сирота на ключе, которого не было среди аномалий
//   ни одной прежней версии, — новая, даже если число не выросло;
// - прочее — по числу нарушений каждого вида.
//
// Проверка намеренно написана заново, а не через src/ical: стенд — оракул,
// и он не должен ошибаться заодно с проверяемым кодом. Из ical.js берутся
// только разбор текста и итератор правила; ключи слотов считаются здесь же,
// без Date в поясе процесса.
import ICAL from "ical.js";

/** Все виды нарушений: самопроверка стенда требует образец порчи на каждый. */
export const VIOLATION_KINDS = [
  "unparsable",
  "no-vevent",
  "missing-uid",
  "mixed-uids",
  "multiple-masters",
  "no-dtstart",
  "duplicate-rid",
  "duplicate-exdate",
  "missing-vtimezone",
  "tzid-on-utc",
  "form-mismatch",
  "until-before-dtstart",
  "end-not-after-start",
  "dtend-with-duration",
  "orphan-override",
  "excluded-override",
] as const;

export type ViolationKind = (typeof VIOLATION_KINDS)[number];

/**
 * Виды, недопустимые в любой записи клиента, какой бы ни была прежняя версия
 * объекта. Два основных компонента и чужой UID новый код не чинит и не
 * правит: такой объект только удаляется целиком (О14, Р12). Неразбираемый
 * текст и календарь без VEVENT записью не бывают вовсе (Р4: неразбираемый
 * объект правка отклоняет, удаление идёт без дерева).
 */
export const ABSOLUTE_KINDS = ["unparsable", "no-vevent", "multiple-masters", "mixed-uids"] as const satisfies readonly ViolationKind[];

export interface Violation {
  kind: ViolationKind;
  detail: string;
}

// Нарушение с ключом слота (О3), к которому оно относится: у дублей
// RECURRENCE-ID и EXDATE и у аномалий переопределений. По ключам
// newViolations отличает новый дубль или новую сироту от прежних. Наружу
// findViolations отдаёт нарушения без ключа.
interface Finding extends Violation {
  key?: string;
}

export class InvariantError extends Error {
  constructor(readonly violations: Violation[]) {
    super(
      `Объект нарушает инварианты (О12а):\n${violations.map((v) => `- ${v.kind}: ${v.detail}`).join("\n")}`,
    );
    this.name = "InvariantError";
  }
}

// ---------------------------------------------------------------------------
// Сырой текст: разбор без ical.js, чтобы видеть строки такими, какие они есть
// ---------------------------------------------------------------------------

/** Снимает переносы строк RFC 5545 §3.1 и приводит концы строк к "\n". */
export function unfold(ics: string): string {
  return ics.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "");
}

export interface RawComponent {
  /** Имя компонента в верхнем регистре: VCALENDAR, VEVENT, VALARM… */
  name: string;
  /** Собственные строки свойств без переносов, в исходном порядке. */
  lines: string[];
  children: RawComponent[];
}

/** Дерево компонентов по тексту: строки свойств — дословно, без переносов. */
export function parseRawComponents(ics: string): RawComponent[] {
  const roots: RawComponent[] = [];
  const stack: RawComponent[] = [];
  for (const line of unfold(ics).split("\n")) {
    if (line === "") continue;
    const upper = line.toUpperCase();
    if (upper.startsWith("BEGIN:")) {
      const component: RawComponent = { name: upper.slice(6).trim(), lines: [], children: [] };
      (stack.at(-1)?.children ?? roots).push(component);
      stack.push(component);
    } else if (upper.startsWith("END:")) {
      stack.pop();
    } else {
      stack.at(-1)?.lines.push(line);
    }
  }
  return roots;
}

/** Имя свойства строки в верхнем регистре (до первой ";" или ":"). */
export function lineName(line: string): string {
  const match = /^[^;:]*/.exec(line);
  return (match?.[0] ?? "").toUpperCase();
}

// ---------------------------------------------------------------------------
// jCal: то, что возвращает ICAL.parse (node_modules/ical.js/lib/ical/parse.js)
// ---------------------------------------------------------------------------

type JProp = [string, Record<string, unknown>, string, ...unknown[]];
type JComp = [string, JProp[], JComp[]];

function propsOf(component: JComp, name: string): JProp[] {
  return component[1].filter((prop) => prop[0] === name);
}

function paramOf(prop: JProp, name: string): string | undefined {
  const value = prop[1][name];
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
}

function valuesOf(prop: JProp): unknown[] {
  return prop.slice(3);
}

// Значение времени как строка jCal: "2026-10-19", "2026-10-19T10:00:00" или
// "2026-10-19T07:00:00Z". У PERIOD — его начало.
function timeString(prop: JProp, value: unknown): string | undefined {
  const raw = prop[2] === "period" && Array.isArray(value) ? value[0] : value;
  return typeof raw === "string" ? raw : undefined;
}

/** Форма значения времени (О4): дата, UTC, пояс или плавающее. */
export type Form = "date" | "utc" | "floating" | `tz:${string}`;

function formOf(prop: JProp, value: unknown): Form | undefined {
  const raw = timeString(prop, value);
  if (raw === undefined) return undefined;
  if (prop[2] === "date" || /^\d{4}-\d{2}-\d{2}$/.test(raw)) return "date";
  if (raw.endsWith("Z")) return "utc";
  const tzid = paramOf(prop, "tzid");
  return tzid ? `tz:${tzid}` : "floating";
}

function formLabel(form: Form | undefined): string {
  if (form === undefined) return "не время";
  if (form === "date") return "DATE";
  if (form === "utc") return "UTC";
  if (form === "floating") return "плавающее";
  return `TZID=${form.slice(3)}`;
}

// ---------------------------------------------------------------------------
// Моменты без пояса процесса
// ---------------------------------------------------------------------------

export interface Wall {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function wallOf(raw: string): Wall | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2}))?/.exec(raw);
  if (!match) return undefined;
  const [, y, mo, d, h = "0", mi = "0", s = "0"] = match;
  return { year: +y, month: +mo, day: +d, hour: +h, minute: +mi, second: +s };
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

export function dateString(wall: Wall): string {
  return `${pad(wall.year, 4)}-${pad(wall.month)}-${pad(wall.day)}`;
}

export function wallString(wall: Wall): string {
  return `${dateString(wall)}T${pad(wall.hour)}:${pad(wall.minute)}:${pad(wall.second)}`;
}

/** Стенное время как если бы оно было в UTC: Date.UTC не зависит от пояса процесса. */
export function utcMsOf(wall: Wall): number {
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
}

const formatters = new Map<string, Intl.DateTimeFormat | null>();

function zoneFormatter(tzid: string): Intl.DateTimeFormat | null {
  if (!formatters.has(tzid)) {
    try {
      formatters.set(
        tzid,
        new Intl.DateTimeFormat("en-US", {
          timeZone: tzid,
          hourCycle: "h23",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        }),
      );
    } catch {
      formatters.set(tzid, null);
    }
  }
  return formatters.get(tzid) ?? null;
}

/** Стенное время момента ms в поясе IANA (через Intl, без пояса процесса). */
export function wallInZone(ms: number, tzid: string): Wall | undefined {
  const formatter = zoneFormatter(tzid);
  if (!formatter) return undefined;
  const parts = Object.fromEntries(formatter.formatToParts(new Date(ms)).map((part) => [part.type, part.value]));
  return {
    year: +parts.year,
    month: +parts.month,
    day: +parts.day,
    hour: +parts.hour,
    minute: +parts.minute,
    second: +parts.second,
  };
}

function intlInstant(wall: Wall, tzid: string): number | undefined {
  const local = utcMsOf(wall);
  const offsetAt = (ms: number) => {
    const seen = wallInZone(ms, tzid);
    return seen === undefined ? undefined : utcMsOf(seen) - ms;
  };
  const first = offsetAt(local);
  if (first === undefined) return undefined;
  const second = offsetAt(local - first);
  return local - (second ?? first);
}

/**
 * Момент (мс) стенного времени в поясе tzid. Пояс берётся из VTIMEZONE самого
 * объекта, если он там есть (так объект прочтёт любой клиент;
 * node_modules/ical.js/lib/ical/component.js, getTimeZoneByID), иначе из базы
 * IANA через Intl. Неизвестный пояс — undefined: значение считается
 * плавающим, как это делает ical.js (lib/ical/time.js, fromDateTimeString).
 */
export function instantOfWall(wall: Wall, tzid: string, root?: ICAL.Component): number | undefined {
  const zone = root?.getTimeZoneByID(tzid);
  if (zone) {
    // lib/ical/time.js: конструктор (data, zone); toUnixTime считает смещение
    // через zone.utcOffset(this), без пояса процесса.
    return new ICAL.Time({ ...wall, isDate: false }, zone).toUnixTime() * 1000;
  }
  return intlInstant(wall, tzid);
}

// ---------------------------------------------------------------------------
// Ключи слотов (О3): D:дата, T:момент, F:стенное
// ---------------------------------------------------------------------------

type Key = string;

function keyOfWall(wall: Wall, form: Form, seriesIsDate: boolean, root: ICAL.Component): Key {
  // О3: у серии на весь день ключ — буквальная дата, даже у DATE-TIME.
  if (seriesIsDate || form === "date") return `D:${dateString(wall)}`;
  if (form === "utc") return `T:${utcMsOf(wall)}`;
  if (form === "floating") return `F:${wallString(wall)}`;
  const ms = instantOfWall(wall, form.slice(3), root);
  return ms === undefined ? `F:${wallString(wall)}` : `T:${ms}`;
}

function keyOf(prop: JProp, value: unknown, seriesIsDate: boolean, root: ICAL.Component): Key | undefined {
  const raw = timeString(prop, value);
  const form = formOf(prop, value);
  const wall = raw === undefined ? undefined : wallOf(raw);
  if (!wall || !form) return undefined;
  return keyOfWall(wall, form, seriesIsDate, root);
}

function compareKeys(a: Key, b: Key): number | undefined {
  if (a[0] !== b[0]) return undefined;
  if (a[0] === "T") return Number(a.slice(2)) - Number(b.slice(2));
  return a.slice(2) < b.slice(2) ? -1 : a.slice(2) > b.slice(2) ? 1 : 0;
}

const ITERATION_CAP = 100_000;

// Слоты серии: DTSTART ∪ позиции RRULE ∪ RDATE (О2). Позиции перебираются
// только до самого позднего проверяемого ключа. undefined — перебор не
// удался (ошибка итератора или предел шагов): тогда аномалии не ищутся,
// чтобы не было ложных срабатываний.
function slotsOf(
  masterJ: JComp,
  master: ICAL.Component,
  dtstart: JProp,
  seriesIsDate: boolean,
  root: ICAL.Component,
  targets: Key[],
): Set<Key> | undefined {
  const slots = new Set<Key>();
  const startKey = keyOf(dtstart, dtstart[3], seriesIsDate, root);
  const startForm = formOf(dtstart, dtstart[3]);
  if (startKey === undefined || startForm === undefined) return undefined;
  // DTSTART — всегда слот: итератор ical.js не выдаёт DTSTART, который не
  // на позиции правила (lib/ical/recur_iterator.js, next: первая выдача —
  // this.last, а он уже выровнен по правилу).
  slots.add(startKey);
  for (const prop of propsOf(masterJ, "rdate")) {
    for (const value of valuesOf(prop)) {
      const key = keyOf(prop, value, seriesIsDate, root);
      if (key) slots.add(key);
    }
  }
  const rules = master.getAllProperties("rrule");
  const relevant = targets.filter((key) => compareKeys(key, startKey) !== undefined);
  if (rules.length === 0 || relevant.length === 0) return slots;
  const latest = relevant.reduce((a, b) => ((compareKeys(a, b) ?? 0) >= 0 ? a : b));

  const start = master.getFirstPropertyValue("dtstart") as ICAL.Time;
  for (const rule of rules) {
    try {
      // lib/ical/recur.js:280 iterator(aStart); next() отдаёт один и тот же
      // изменяемый объект, поэтому ключ считается сразу.
      const iterator = (rule.getFirstValue() as ICAL.Recur).iterator(start);
      let steps = 0;
      for (;;) {
        const next = iterator.next();
        if (!next) break;
        const key = keyOfWall(
          { year: next.year, month: next.month, day: next.day, hour: next.hour, minute: next.minute, second: next.second },
          startForm,
          seriesIsDate,
          root,
        );
        slots.add(key);
        if ((compareKeys(key, latest) ?? 0) > 0) break;
        steps += 1;
        if (steps >= ITERATION_CAP) return undefined;
      }
    } catch {
      return undefined;
    }
  }
  return slots;
}

// ---------------------------------------------------------------------------
// Проверка
// ---------------------------------------------------------------------------

function parseRoot(ics: string): { jcal: JComp } | { error: string } {
  let parsed: unknown;
  try {
    parsed = ICAL.parse(ics);
  } catch (error) {
    return { error: (error as Error).message };
  }
  if (!Array.isArray(parsed) || typeof parsed[0] !== "string") {
    return { error: "в тексте не один компонент верхнего уровня" };
  }
  if (parsed[0] !== "vcalendar") return { error: `компонент верхнего уровня ${String(parsed[0])}, а не VCALENDAR` };
  return { jcal: parsed as JComp };
}

function eventLabel(event: JComp): string {
  const rid = propsOf(event, "recurrence-id")[0];
  const summary = propsOf(event, "summary")[0]?.[3];
  const who = rid ? `переопределение ${String(timeString(rid, rid[3]))}` : "основной компонент";
  return summary === undefined ? who : `${who} «${String(summary)}»`;
}

function comparableInstant(prop: JProp, value: unknown, root: ICAL.Component): { kind: "date" | "instant" | "wall"; n: number | string } | undefined {
  const raw = timeString(prop, value);
  const form = formOf(prop, value);
  const wall = raw === undefined ? undefined : wallOf(raw);
  if (!wall || !form || raw === undefined) return undefined;
  if (form === "date") return { kind: "date", n: raw.slice(0, 10) };
  if (form === "utc") return { kind: "instant", n: utcMsOf(wall) };
  if (form === "floating") return { kind: "wall", n: utcMsOf(wall) };
  const ms = instantOfWall(wall, form.slice(3), root);
  return ms === undefined ? { kind: "wall", n: utcMsOf(wall) } : { kind: "instant", n: ms };
}

function compareTimes(
  a: ReturnType<typeof comparableInstant>,
  b: ReturnType<typeof comparableInstant>,
): number | undefined {
  if (!a || !b || a.kind !== b.kind) return undefined;
  if (typeof a.n === "number" && typeof b.n === "number") return a.n - b.n;
  return a.n < b.n ? -1 : a.n > b.n ? 1 : 0;
}

/** Все нарушения инвариантов в тексте объекта. Пустой список — объект чист. */
export function findViolations(ics: string): Violation[] {
  return analyze(ics).map(({ kind, detail }) => ({ kind, detail }));
}

// Нарушения вместе с ключами слотов, к которым они относятся.
function analyze(ics: string): Finding[] {
  const parsed = parseRoot(ics);
  if ("error" in parsed) return [{ kind: "unparsable", detail: parsed.error }];
  const jcal = parsed.jcal;
  const root = new ICAL.Component(jcal);
  const out: Finding[] = [];
  const add = (kind: ViolationKind, detail: string, key?: Key) => out.push(key === undefined ? { kind, detail } : { kind, detail, key });

  const events = jcal[2].filter((component) => component[0] === "vevent");
  if (events.length === 0) return [{ kind: "no-vevent", detail: "в объекте нет ни одного VEVENT" }];
  const hydrated = root.getAllSubcomponents("vevent");

  // UID
  const uids = new Set<string>();
  for (const event of events) {
    const uid = propsOf(event, "uid")[0]?.[3];
    if (typeof uid !== "string" || uid === "") add("missing-uid", `${eventLabel(event)} без UID`);
    else uids.add(uid);
  }
  if (uids.size > 1) add("mixed-uids", `в одном объекте несколько UID: ${[...uids].join(", ")}`);

  // Основной компонент
  const masterIndexes = events.map((event, i) => (propsOf(event, "recurrence-id").length === 0 ? i : -1)).filter((i) => i >= 0);
  for (const extra of masterIndexes.slice(1)) {
    add("multiple-masters", `лишний основной компонент: ${eventLabel(events[extra])}`);
  }
  const masterJ = masterIndexes.length ? events[masterIndexes[0]] : undefined;
  const master = masterIndexes.length ? hydrated[masterIndexes[0]] : undefined;
  const dtstart = masterJ ? propsOf(masterJ, "dtstart")[0] : undefined;
  if (masterJ && !dtstart) add("no-dtstart", "у основного компонента нет DTSTART");
  const refForm = dtstart ? formOf(dtstart, dtstart[3]) : undefined;
  const seriesIsDate = refForm === "date";

  // VTIMEZONE на каждый TZID; TZID у значения в UTC
  const zones = new Set(
    jcal[2]
      .filter((component) => component[0] === "vtimezone")
      .map((component) => propsOf(component, "tzid")[0]?.[3])
      .filter((tzid): tzid is string => typeof tzid === "string"),
  );
  const used = new Set<string>();
  const walk = (component: JComp) => {
    if (component[0] === "vtimezone") return;
    for (const prop of component[1]) {
      const tzid = paramOf(prop, "tzid");
      if (tzid === undefined) continue;
      used.add(tzid);
      for (const value of valuesOf(prop)) {
        const raw = timeString(prop, value);
        if (raw?.endsWith("Z")) add("tzid-on-utc", `${prop[0].toUpperCase()};TZID=${tzid} со значением в UTC ${raw}`);
      }
    }
    component[2].forEach(walk);
  };
  walk(jcal);
  for (const tzid of used) {
    if (!zones.has(tzid)) add("missing-vtimezone", `TZID=${tzid} без VTIMEZONE`);
  }

  // Формы значений по О4
  if (masterJ && dtstart && refForm) {
    const check = (label: string, form: Form | undefined) => {
      if (form !== refForm) add("form-mismatch", `${label} в форме ${formLabel(form)}, а DTSTART — ${formLabel(refForm)}`);
    };
    for (const event of events) {
      const rid = propsOf(event, "recurrence-id")[0];
      if (rid) check(`RECURRENCE-ID ${String(timeString(rid, rid[3]))}`, formOf(rid, rid[3]));
    }
    for (const name of ["exdate", "rdate"]) {
      for (const prop of propsOf(masterJ, name)) {
        for (const value of valuesOf(prop)) check(`${name.toUpperCase()} ${String(timeString(prop, value))}`, formOf(prop, value));
      }
    }
    for (const rule of propsOf(masterJ, "rrule")) {
      const until = (rule[3] as { until?: unknown }).until;
      if (typeof until !== "string") continue;
      const untilForm: Form = /^\d{4}-\d{2}-\d{2}$/.test(until) ? "date" : until.endsWith("Z") ? "utc" : "floating";
      const expected: Form = refForm === "date" ? "date" : refForm === "floating" ? "floating" : "utc";
      if (untilForm !== expected) {
        add("form-mismatch", `UNTIL ${until} в форме ${formLabel(untilForm)}, а при DTSTART ${formLabel(refForm)} нужна ${formLabel(expected)}`);
        continue;
      }
      const startAt = comparableInstant(dtstart, dtstart[3], root);
      const untilAt =
        untilForm === "date"
          ? { kind: "date" as const, n: until }
          : { kind: untilForm === "utc" ? ("instant" as const) : ("wall" as const), n: utcMsOf(wallOf(until)!) };
      const order = compareTimes(untilAt, startAt);
      if (order !== undefined && order < 0) add("until-before-dtstart", `UNTIL ${until} раньше DTSTART ${String(dtstart[3])}`);
    }
  }

  // Конец события
  for (const event of events) {
    const start = propsOf(event, "dtstart")[0];
    const end = propsOf(event, "dtend")[0];
    const duration = propsOf(event, "duration")[0];
    if (end && duration) add("dtend-with-duration", `${eventLabel(event)}: DTEND вместе с DURATION`);
    if (start && end) {
      const startForm = formOf(start, start[3]);
      const endForm = formOf(end, end[3]);
      if ((startForm === "date") !== (endForm === "date")) {
        add("form-mismatch", `${eventLabel(event)}: DTEND в форме ${formLabel(endForm)}, DTSTART — ${formLabel(startForm)}`);
      } else {
        const order = compareTimes(comparableInstant(end, end[3], root), comparableInstant(start, start[3], root));
        if (order !== undefined && order <= 0) {
          add("end-not-after-start", `${eventLabel(event)}: DTEND ${String(end[3])} не позже DTSTART ${String(start[3])}`);
        }
      }
    }
    if (duration && typeof duration[3] === "string") {
      try {
        // lib/ical/duration.js:45 fromString, :172 toSeconds.
        if (ICAL.Duration.fromString(duration[3]).toSeconds() <= 0) {
          add("end-not-after-start", `${eventLabel(event)}: DURATION ${duration[3]} не положительна`);
        }
      } catch {
        add("end-not-after-start", `${eventLabel(event)}: DURATION ${duration[3]} не разбирается`);
      }
    }
  }

  // Дубли RECURRENCE-ID и EXDATE
  const ridKeys: Array<{ key: Key; event: JComp }> = [];
  for (const event of events) {
    const rid = propsOf(event, "recurrence-id")[0];
    const key = rid ? keyOf(rid, rid[3], seriesIsDate, root) : undefined;
    if (key) ridKeys.push({ key, event });
  }
  const seenRid = new Set<Key>();
  for (const { key, event } of ridKeys) {
    if (seenRid.has(key)) add("duplicate-rid", `второй компонент того же слота: ${eventLabel(event)}`, key);
    seenRid.add(key);
  }
  const exdateKeys = new Set<Key>();
  if (masterJ) {
    for (const prop of propsOf(masterJ, "exdate")) {
      for (const value of valuesOf(prop)) {
        const key = keyOf(prop, value, seriesIsDate, root);
        if (!key) continue;
        if (exdateKeys.has(key)) add("duplicate-exdate", `EXDATE ${String(timeString(prop, value))} повторяется`, key);
        exdateKeys.add(key);
      }
    }
  }

  // Аномалии: переопределения мимо слотов и под EXDATE. Объект без
  // основного компонента (Р6) аномалией не считается.
  if (masterJ && master && dtstart && ridKeys.length > 0) {
    const slots = slotsOf(masterJ, master, dtstart, seriesIsDate, root, ridKeys.map((entry) => entry.key));
    if (slots) {
      for (const { key, event } of ridKeys) {
        if (!slots.has(key)) add("orphan-override", `${eventLabel(event)}: RECURRENCE-ID не совпадает ни с одним слотом серии`, key);
        else if (exdateKeys.has(key)) add("excluded-override", `${eventLabel(event)}: слот закрыт EXDATE`, key);
      }
    }
  }

  return out;
}

const ABSOLUTE = new Set<ViolationKind>(ABSOLUTE_KINDS);
const DUPLICATES = new Set<ViolationKind>(["duplicate-rid", "duplicate-exdate"]);

// Сирота и скрытое переопределение — одна группа аномалий: сдвиг серии может
// превратить одно в другое, не добавив аномалий («аномалий не больше, чем было»).
function isAnomaly(kind: ViolationKind): boolean {
  return kind === "orphan-override" || kind === "excluded-override";
}

function baselinesOf(before: string | readonly string[] | null | undefined): readonly string[] {
  return before === undefined || before === null ? [] : typeof before === "string" ? [before] : before;
}

// Нарушения `after`, новые относительно прежних версий (правила — в шапке
// файла). verbatimExempt: текст, дословно совпавший с прежней версией, —
// это не запись клиента, а сама прежняя версия, и в нём нового нет.
function freshViolations(after: string, baselines: readonly string[], verbatimExempt: boolean): Violation[] {
  if (verbatimExempt && baselines.includes(after)) return [];
  const previous = baselines.map(analyze);
  const current = analyze(after);
  // Наибольшее значение счётчика по всем прежним версиям (0, если их нет).
  const mostBefore = (count: (findings: Finding[]) => number) => Math.max(0, ...previous.map(count));

  const fresh = current.filter((finding) => {
    const { kind, key } = finding;
    if (ABSOLUTE.has(kind)) return true;
    if (DUPLICATES.has(kind)) {
      // Лишних компонентов (значений) у этого ключа больше, чем было: дубль
      // на другом слоте вместо исчезнувшего прежнего и третий компонент
      // прежнего дубля — новые.
      const extraAtKey = (findings: Finding[]) => findings.filter((f) => f.kind === kind && f.key === key).length;
      return extraAtKey(current) > mostBefore(extraAtKey);
    }
    if (isAnomaly(kind)) {
      const anomalies = (findings: Finding[]) => findings.filter((f) => isAnomaly(f.kind)).length;
      if (anomalies(current) > mostBefore(anomalies)) return true;
      // Сирота на ключе, которого не было среди аномалий ни одной прежней
      // версии, — новая, даже если сирот не больше: так выглядит ремонт,
      // поставивший RECURRENCE-ID мимо слота (C55, C56). Скрытое под EXDATE
      // на новом ключе — след сдвига серии вместе с EXDATE, оно по числу.
      return kind === "orphan-override" && !previous.some((findings) => findings.some((f) => isAnomaly(f.kind) && f.key === key));
    }
    const ofKind = (findings: Finding[]) => findings.filter((f) => f.kind === kind).length;
    return ofKind(current) > mostBefore(ofKind);
  });
  return fresh.map(({ kind, detail }) => ({ kind, detail }));
}

/**
 * Нарушения `after`, новые относительно всех прежних версий `before` (правила
 * — в шапке файла). Прежние нарушения чужого объекта правка вправе сохранить,
 * новых добавлять — нет. Без `before` любое нарушение новое. Виды
 * ABSOLUTE_KINDS прощаются, только если `after` дословно совпадает с одной из
 * прежних версий: так assertStoredInvariants терпит нетронутую затравку.
 */
export function newViolations(after: string, before?: string | readonly string[] | null): Violation[] {
  return freshViolations(after, baselinesOf(before), true);
}

/**
 * Нарушения, из-за которых строгий стенд отклоняет PUT с телом `body` поверх
 * прежней версии `before`: как newViolations, но виды ABSOLUTE_KINDS
 * запрещены в любой записи, даже дословно повторяющей прежнюю версию.
 */
export function writeViolations(body: string, before?: string | readonly string[] | null): Violation[] {
  return freshViolations(body, baselinesOf(before), false);
}

/** Бросает InvariantError, если в `after` есть нарушения сверх `before`. */
export function assertInvariants(after: string, before?: string | readonly string[] | null): void {
  const violations = newViolations(after, before);
  if (violations.length > 0) throw new InvariantError(violations);
}
