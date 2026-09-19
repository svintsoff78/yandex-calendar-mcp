import ICAL from "ical.js";
import { registerTimeZone } from "./timezones.js";

/**
 * Значения времени iCalendar: формы, ключи слотов, моменты, запись значений
 * в форме DTSTART и разбор времени, пришедшего от модели.
 *
 * Это единственный путь от значения к моменту. Пояс процесса не участвует
 * нигде: плавающее время и даты привязываются к поясу календаря
 * (`IcalEnv.floatingZone`), моменты считаются через `ICAL.Time.toUnixTime`,
 * который строит время через Date.UTC и смещение зоны
 * (node_modules/ical.js/lib/ical/time.js, toUnixTime). Конструктор Date от
 * полей, геттеры местного времени и перевод ICAL.Time в Date здесь не
 * используются: они зависят от пояса машины (контракт — в
 * tests/ical/icaljs-contract.test.ts).
 *
 * Семантика — план переделки docs/superpowers/plans/2026-09-19-recurring-events-rework.md:
 * О3 (ключ слота), О4 (форма записываемых значений), Р10 (формат выдачи и приёма).
 */

/** Форма значения времени: дата, момент в UTC, стенное время с TZID, плавающее стенное время. */
export type TimeForm = "date" | "utc" | "zoned" | "floating";

/**
 * Ключ слота (О3). `D:YYYY-MM-DD` — серия на весь день; `T:<секунды Unix>` —
 * серия с TZID или в UTC (момент); `F:YYYY-MM-DDTHH:MM:SS` — плавающая серия.
 * Внимание: в `T:` — секунды, а `instantOf` отдаёт миллисекунды.
 */
export type SlotKey = `D:${string}` | `T:${number}` | `F:${string}`;

/** Окружение разбора, из config: пояс календаря для плавающих значений и дат. */
export interface IcalEnv {
  floatingZone: string;
  ownerEmail?: string;
}

/** Чем определяется ключ значения: форма серии (DTSTART основного) и окружение. CalendarObject подходит структурно. */
export interface KeyContext {
  readonly form: TimeForm;
  readonly env: IcalEnv;
}

/**
 * Пояс: имя TZID (ищется в ICAL.TimezoneService, иначе в базе IANA) или
 * готовый объект. В контексте календарного объекта передавайте зону из его
 * дерева (`zone` значения DTSTART основного): Яндекс заменяет вложенный
 * VTIMEZONE полным историческим описанием (docs/yandex-caldav-capabilities.md,
 * Ж10), а по имени берётся описание из базы, где у многих поясов только
 * нынешнее правило.
 */
export type ZoneRef = string | ICAL.Timezone;

/** Свойства-списки дат, которыми управляет этот модуль. */
export type ListName = "exdate" | "rdate";

// ───────────────────────────── формы и моменты ─────────────────────────────

/**
 * Форма значения.
 *
 * Для свойства — по записи в jCal, без разбора значения: так форма видна и
 * до регистрации поясов, и у свойства с неизвестным TZID (его разобранное
 * значение ical.js молча делает плавающим — time.js, fromDateTimeString →
 * fromData, `TimezoneService.get(...) || localTimezone`). У RDATE;VALUE=PERIOD
 * форма — по началу периода.
 *
 * Для ICAL.Time — по зоне значения: `utcTimezone` — utc, `localTimezone`
 * (tzid "floating") — floating, прочие — zoned (timezone.js, геттеры
 * utcTimezone и localTimezone).
 */
export function formOf(value: ICAL.Property | ICAL.Time): TimeForm {
  if (value instanceof ICAL.Time) {
    if (value.isDate) return "date";
    if (value.zone === ICAL.Timezone.utcTimezone) return "utc";
    if (isFloatingZone(value.zone)) return "floating";
    return "zoned";
  }

  if (value.type === "date") return "date";
  let raw: unknown = value.jCal[3];
  if (Array.isArray(raw)) raw = raw[0];
  if (typeof raw !== "string") {
    throw new Error(`У свойства ${value.name.toUpperCase()} нет значения даты или времени.`);
  }
  if (raw.length === 10) return "date";
  if (raw.endsWith("Z")) return "utc";
  if (value.getParameter("tzid")) return "zoned";
  return "floating";
}

/**
 * Момент значения в миллисекундах Unix. Время с поясом и в UTC — как есть;
 * плавающее — то же стенное время в поясе календаря; дата — полночь в поясе
 * календаря. Переданное значение не меняется.
 */
export function instantOf(t: ICAL.Time, env: IcalEnv): number {
  return instantSeconds(t, env) * 1000;
}

/**
 * Стенная дата значения `YYYY-MM-DD`.
 *
 * Без `zone` — дата записи (у времени с поясом — в его поясе, у UTC — по UTC).
 * С `zone` — дата момента значения в этом поясе (плавающее сначала читается
 * в поясе календаря). У даты — всегда она сама: дата пояса не имеет.
 */
export function wallDateOf(t: ICAL.Time, env: IcalEnv, zone?: ZoneRef): string {
  if (t.isDate || zone === undefined) return dateOf(t);
  return dateOf(atInstant(instantSeconds(t, env), resolveZone(zone)));
}

/**
 * Ключ слота значения в серии формы `seriesForm` (О3):
 * - `date` — `D:` и буквальная дата записи (у унаследованного DATE-TIME,
 *   например `20261021T000000Z`, — его дата, без перевода поясов);
 * - `zoned`, `utc` — `T:` и момент в секундах: RID в чужом TZID или в UTC
 *   совпадает со слотом по моменту;
 * - `floating` — `F:` и стенное время; значение с поясом — его стенное время
 *   в поясе календаря.
 *
 * Согласован с `timeInForm`: ключ значения, переведённого в форму серии,
 * равен ключу исходного значения.
 */
export function slotKeyOf(t: ICAL.Time, seriesForm: TimeForm, env: IcalEnv): SlotKey {
  switch (seriesForm) {
    case "date":
      return `D:${dateOf(t)}`;
    case "utc":
    case "zoned":
      return `T:${instantSeconds(t, env)}`;
    case "floating":
      return `F:${wallString(timeInForm(t, "floating", undefined, env))}`;
  }
}

/** Порядок ключей: `T:` — по числу, `D:` и `F:` — строкой (формат фиксированной ширины). */
export function compareSlotKeys(a: SlotKey, b: SlotKey): number {
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1; // разные виды в одной серии не встречаются
  if (a[0] === "T") return Math.sign(Number(a.slice(2)) - Number(b.slice(2)));
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Значение `t` в форме серии (О4) — новый объект, исходный не меняется:
 * - `date` — буквальная дата записи `t`;
 * - `utc` — момент `t` в UTC;
 * - `zoned` — момент `t` стенным временем пояса `zone`; если `t` уже в поясе
 *   с тем же TZID — то же стенное время, но с переданным объектом пояса;
 * - `floating` — стенное время `t` в поясе календаря без пояса.
 *
 * Дата в формах со временем — полночь в поясе календаря (как в `instantOf`),
 * поэтому ключ слота при переводе сохраняется.
 */
export function timeInForm(t: ICAL.Time, form: TimeForm, zone: ZoneRef | undefined, env: IcalEnv): ICAL.Time {
  switch (form) {
    case "date":
      return ICAL.Time.fromData({ year: t.year, month: t.month, day: t.day, isDate: true });
    case "utc":
      return fromUnix(instantSeconds(t, env));
    case "zoned": {
      if (zone === undefined) throw new Error("Для формы zoned нужен пояс (TZID DTSTART серии).");
      const target = resolveZone(zone);
      if (isFloatingZone(target)) throw new Error("Пояс floating не годится для формы zoned.");
      if (!t.isDate && formOf(t) === "zoned" && t.zone.tzid === target.tzid) return withWall(t, target);
      return atInstant(instantSeconds(t, env), target);
    }
    case "floating": {
      if (t.isDate) return midnightOf(t, ICAL.Timezone.localTimezone);
      if (formOf(t) === "floating") return withWall(t, ICAL.Timezone.localTimezone);
      return withWall(atInstant(instantSeconds(t, env), resolveZone(env.floatingZone)), ICAL.Timezone.localTimezone);
    }
  }
}

/**
 * UNTIL для усечения серии перед границей `b` — jCal-строка в форме серии (О4,
 * RFC 5545 §3.3.10): `date` — дата накануне `b`; `zoned` и `utc` — момент на
 * секунду раньше `b` в UTC (`…Z`); `floating` — стенное время на секунду
 * раньше, без Z. Такую строку правильно выводит design.js, recur.toICAL
 * (выбор DATE или DATE-TIME — по `val.length > 10`).
 *
 * `b` — значение слота в форме серии; плавающая граница или дата в форме с
 * поясом — ошибка вызывающего кода (момент по ней не определён).
 */
export function untilBefore(b: ICAL.Time, form: TimeForm): string {
  switch (form) {
    case "date": {
      const day = ICAL.Time.fromData({ year: b.year, month: b.month, day: b.day, isDate: true });
      day.adjust(-1, 0, 0, 0); // time.js, adjust: календарная арифметика без Date
      return day.toString();
    }
    case "utc":
    case "zoned": {
      if (b.isDate || formOf(b) === "floating") {
        throw new Error(`Граница ${b.toString()} без пояса: UNTIL в форме ${form} по ней не вычислить.`);
      }
      return fromUnix(b.toUnixTime() - 1).toString();
    }
    case "floating": {
      if (b.isDate || formOf(b) !== "floating") {
        throw new Error(`Граница ${b.toString()} не плавающая: UNTIL плавающей серии по ней не вычислить.`);
      }
      const wall = withWall(b, ICAL.Timezone.localTimezone);
      wall.adjust(0, 0, 0, -1);
      return wall.toString();
    }
  }
}

// ─────────────────────────────── RRULE ────────────────────────────────

/** Значение части правила в jCal-словаре: строка, число или их список. */
export type RuleValue = string | number | ReadonlyArray<string | number>;
/** jCal-словарь RRULE: ключи в нижнем регистре, неизвестные части — строки как в тексте. */
export type RuleDict = Record<string, RuleValue>;
/** Словарь для setRuleDict: null и undefined снимают часть, UNTIL можно передать как ICAL.Time. */
export type RuleDictInput = Record<string, RuleValue | ICAL.Time | null | undefined>;

/**
 * Живой jCal-словарь правила — `prop.jCal[3]`, а не `ICAL.Recur`: разбор
 * хранит неизвестные части (RSCALE, SKIP, X-…) как есть, а `Recur.toJSON` и
 * `Recur.toString` их теряют (recur.js, _stringToData — «Don't swallow
 * unknown values»; toJSON — только freq, count, interval > 1, parts, until,
 * wkst). Сериализация идёт из этого словаря по порядку ключей (design.js,
 * recur.toICAL).
 *
 * После правки словаря на месте нужно вызвать `setRuleDict`: иначе
 * `getFirstValue()` продолжит отдавать закешированный `Recur` (property.js,
 * _hydrateValue кеширует `_values`).
 */
export function ruleDict(p: ICAL.Property): RuleDict {
  assertRecur(p);
  const dict: unknown = p.jCal[3];
  if (!dict || typeof dict !== "object" || Array.isArray(dict)) {
    throw new Error(`У свойства ${p.name.toUpperCase()} нет словаря правила повторения.`);
  }
  return dict as RuleDict;
}

/**
 * Записывает словарь правила в свойство и сбрасывает кеш разобранного
 * значения (property.js, removeAllValues: `_values.length = 0`,
 * `jCal.length = 3`). Порядок ключей сохраняется; части со значением `null`
 * или `undefined` снимаются; UNTIL приводится к jCal-строке. После вызова
 * живой словарь — новый: берите его заново через `ruleDict`.
 */
export function setRuleDict(p: ICAL.Property, d: RuleDictInput): void {
  assertRecur(p);
  // Словарь без прототипа — как у разборщика (recur.js, _stringToData: Object.create(null)).
  const clean = Object.create(null) as RuleDict;
  for (const [key, value] of Object.entries(d)) {
    if (value === null || value === undefined) continue;
    const name = key.toLowerCase();
    clean[name] = name === "until" ? untilString(value) : (value as RuleValue);
  }
  if (typeof clean.freq !== "string") throw new Error("В правиле повторения нет FREQ.");
  p.removeAllValues();
  p.jCal.push(clean);
}

// ───────────────────────── EXDATE и RDATE, RECURRENCE-ID ─────────────────────────

/** Одно значение EXDATE или RDATE: ключ, копия времени (у PERIOD — начало и конец), свойство и номер значения в нём. */
export interface ListEntry {
  key: SlotKey;
  time: ICAL.Time;
  periodEnd?: ICAL.Time;
  property: ICAL.Property;
  index: number;
}

/**
 * Все значения свойств `name` компонента по порядку, с дублями. Значения —
 * копии: `getValues()` отдаёт закешированные объекты свойства.
 * Пояса TZID должны быть зарегистрированы до вызова (иначе ical.js прочтёт
 * значение как плавающее и закеширует — см. контракт).
 */
export function listEntries(c: ICAL.Component, name: ListName, o: KeyContext): ListEntry[] {
  const entries: ListEntry[] = [];
  for (const property of c.getAllProperties(name)) {
    property.getValues().forEach((value: ICAL.Time | ICAL.Period, index: number) => {
      const time = startOf(value).clone();
      const periodEnd = value instanceof ICAL.Period ? value.getEnd().clone() : undefined;
      entries.push({ key: slotKeyOf(time, o.form, o.env), time, periodEnd, property, index });
    });
  }
  return entries;
}

/** Ключи всех значений свойств `name` по порядку, с дублями (дубли — признак порчи, их видно). */
export function listKeys(c: ICAL.Component, name: ListName, o: KeyContext): SlotKey[] {
  return listEntries(c, name, o).map((entry) => entry.key);
}

/**
 * Добавляет значение отдельным новым свойством `name` в форме самого
 * значения (DATE — `VALUE=DATE`, с поясом — `TZID`, UTC — `Z`, плавающее —
 * без пояса); имеющиеся свойства не трогаются. Значение сначала переводится
 * в форму серии (`timeInForm`), дубли проверяет вызывающий код по `listKeys`.
 * Новое свойство встаёт в конец списка свойств — при выводе всё равно до
 * подкомпонентов (stringify.js, stringify.component).
 */
export function addListValue(c: ICAL.Component, name: ListName, value: ICAL.Time | ICAL.Period): ICAL.Property {
  if (name === "exdate" && value instanceof ICAL.Period) throw new Error("EXDATE не принимает PERIOD.");
  const property = new ICAL.Property(name);
  writeTimeValue(property, value);
  c.addProperty(property);
  return property;
}

/**
 * Снимает значения свойств `name`, ключи которых попали в `drop`. Оставшиеся
 * значения свойства сохраняют исходные jCal-строки; свойство без значений
 * удаляется; свойства без совпадений не трогаются вовсе. Возвращает снятые
 * ключи по порядку, с дублями.
 */
export function removeListValues(
  c: ICAL.Component,
  name: ListName,
  drop: ReadonlySet<SlotKey> | ((key: SlotKey, time: ICAL.Time) => boolean),
  o: KeyContext,
): SlotKey[] {
  const matches = typeof drop === "function" ? drop : (key: SlotKey) => drop.has(key);
  const removed: SlotKey[] = [];

  for (const property of c.getAllProperties(name)) {
    const raw = property.jCal.slice(3);
    const values = property.getValues() as Array<ICAL.Time | ICAL.Period>;
    const kept: unknown[] = [];
    values.forEach((value, index) => {
      const time = startOf(value);
      const key = slotKeyOf(time, o.form, o.env);
      if (matches(key, time.clone())) removed.push(key);
      else kept.push(raw[index]);
    });

    if (kept.length === values.length) continue;
    if (kept.length === 0) {
      c.removeProperty(property);
      continue;
    }
    // property.js, removeAllValues сбрасывает кеш _values; оставшиеся
    // значения возвращаются в jCal как были записаны.
    property.removeAllValues();
    property.jCal.push(...kept);
  }
  return removed;
}

/**
 * Записывает одиночное значение даты или времени (DTSTART, DTEND,
 * RECURRENCE-ID) в форме значения. Имеющееся свойство правится на месте:
 * меняются значение, тип VALUE и TZID, прочие параметры остаются. Нет
 * свойства — добавляется новое. Значение копируется.
 */
export function setTimeProperty(c: ICAL.Component, name: string, value: ICAL.Time | ICAL.Period): ICAL.Property {
  const existing = c.getFirstProperty(name);
  const property = existing ?? new ICAL.Property(name);
  writeTimeValue(property, value);
  if (!existing) c.addProperty(property);
  return property;
}

// ──────────────────────────── ввод и вывод модели ────────────────────────────

/** Поля стенного времени строки, как записаны. */
export interface WallFields {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/**
 * Разобранное время от модели. `date` — литеральная дата строки
 * (`YYYY-MM-DD`), `wall` — её поля как записаны, `time` — значение ICAL.Time:
 * у даты — DATE; у стенного времени — в поясе события или плавающее; у
 * момента — в UTC.
 */
export type ModelTime =
  | { kind: "date"; date: string; wall: WallFields; time: ICAL.Time }
  | { kind: "wall"; date: string; wall: WallFields; time: ICAL.Time }
  | { kind: "instant"; date: string; wall: WallFields; offsetSeconds: number; ms: number; time: ICAL.Time };

/** Строка времени от модели не разобрана. */
export class ModelTimeError extends Error {
  readonly input: string;

  constructor(input: string, reason: string) {
    super(
      `Не удалось разобрать время ${JSON.stringify(input)}: ${reason}. ` +
        "Ожидается дата YYYY-MM-DD или ISO 8601 вида YYYY-MM-DDTHH:MM[:SS][Z|±HH:MM].",
    );
    this.name = "ModelTimeError";
    this.input = input;
  }
}

const ISO_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})(?:[Tt](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:([Zz])|([+-])(\d{2}):?(\d{2}))?)?$/;

/**
 * Разбирает время от модели регулярным выражением, без Date:
 * - `YYYY-MM-DD` — дата;
 * - ISO со смещением или Z — момент;
 * - ISO без смещения — стенное время в поясе `zone` (пояс события или серии),
 *   а не процесса; без `zone` — плавающее.
 * Секунды необязательны, дробная часть секунд отбрасывается. Неверная строка
 * или несуществующая дата — `ModelTimeError`.
 */
export function parseModelTime(iso: string, zone?: ZoneRef): ModelTime {
  const match = ISO_PATTERN.exec(iso);
  if (!match) throw new ModelTimeError(iso, "неверный формат");

  const [, y, mo, d, h, mi, s, zulu, sign, offH, offM] = match;
  const wall: WallFields = {
    year: Number(y),
    month: Number(mo),
    day: Number(d),
    hour: h === undefined ? 0 : Number(h),
    minute: mi === undefined ? 0 : Number(mi),
    second: s === undefined ? 0 : Number(s),
  };
  if (wall.month < 1 || wall.month > 12) throw new ModelTimeError(iso, "месяц вне 01–12");
  if (wall.day < 1 || wall.day > ICAL.Time.daysInMonth(wall.month, wall.year)) {
    throw new ModelTimeError(iso, "такого дня в этом месяце нет");
  }
  if (wall.hour > 23 || wall.minute > 59 || wall.second > 59) throw new ModelTimeError(iso, "время суток вне диапазона");
  const date = `${y}-${mo}-${d}`;

  if (h === undefined) {
    return { kind: "date", date, wall, time: ICAL.Time.fromData({ year: wall.year, month: wall.month, day: wall.day, isDate: true }) };
  }

  if (zulu === undefined && sign === undefined) {
    const target = zone === undefined ? ICAL.Timezone.localTimezone : resolveZone(zone);
    return { kind: "wall", date, wall, time: ICAL.Time.fromData({ ...wall, isDate: false }, target) };
  }

  let offsetSeconds = 0;
  if (sign !== undefined) {
    const hours = Number(offH);
    const minutes = Number(offM);
    if (hours > 18 || minutes > 59) throw new ModelTimeError(iso, "смещение вне ±18:00");
    offsetSeconds = (sign === "-" ? -1 : 1) * (hours * 3600 + minutes * 60);
  }
  const time = ICAL.Time.fromData({ ...wall, isDate: false }, ICAL.Timezone.utcTimezone);
  time.adjust(0, 0, 0, -offsetSeconds); // time.js, adjust: переносы через границы суток и месяцев
  return { kind: "instant", date, wall, offsetSeconds, ms: time.toUnixTime() * 1000, time };
}

/**
 * Время для ответа модели (Р10). Время с поясом — ISO со смещением его пояса
 * на этот момент; UTC — `+00:00`; плавающее — со смещением пояса календаря.
 * Дата: `instance` — `YYYY-MM-DD`; `time` (start, end) — полночь пояса
 * календаря со смещением.
 */
export function formatForModel(t: ICAL.Time, env: IcalEnv, as: "time" | "instance"): string {
  if (t.isDate) {
    if (as === "instance") return dateOf(t);
    return isoWithOffset(midnightOf(t, resolveZone(env.floatingZone)));
  }
  // timezone.js:59-66, convert_time: из localTimezone пояс переклеивается без пересчёта часов.
  if (formOf(t) === "floating") return isoWithOffset(t.convertToZone(resolveZone(env.floatingZone)));
  return isoWithOffset(t);
}

// ─────────────────────────────── внутреннее ───────────────────────────────

function resolveZone(zone: ZoneRef): ICAL.Timezone {
  return typeof zone === "string" ? registerTimeZone(zone) : zone;
}

function isFloatingZone(zone: ICAL.Timezone | null | undefined): boolean {
  return !zone || zone === ICAL.Timezone.localTimezone || zone.tzid === "floating";
}

// Момент в секундах. Плавающее время переклеивается на пояс календаря без
// пересчёта часов (timezone.js:59-66, convert_time: from_zone ==
// localTimezone → tt.zone = to_zone), дата — полночь в поясе календаря.
function instantSeconds(t: ICAL.Time, env: IcalEnv): number {
  if (t.isDate) return midnightOf(t, resolveZone(env.floatingZone)).toUnixTime();
  if (formOf(t) === "floating") return t.convertToZone(resolveZone(env.floatingZone)).toUnixTime();
  return t.toUnixTime();
}

// Время UTC по секундам Unix (time.js:1313, fromUnixTime — через UTC-поля, от пояса процесса не зависит).
function fromUnix(seconds: number): ICAL.Time {
  const time = ICAL.Time.fromData(
    { year: 1970, month: 1, day: 1, hour: 0, minute: 0, second: 0, isDate: false },
    ICAL.Timezone.utcTimezone,
  );
  time.fromUnixTime(seconds);
  return time;
}

/**
 * Момент стенным временем пояса `zone`.
 *
 * `convertToZone` из UTC ошибается у перехода часов: смещение он берёт по
 * UTC-полям, прочитанным как стенное время (timezone.js, convert_time:
 * `to_zone.utcOffset(tt)` до сдвига). Проба: 2026-03-29T01:00Z в
 * Europe/Berlin даёт 02:00 (несуществующее время, обратно — 00:00Z) вместо
 * 03:00. Поэтому стенное время подбирается так, чтобы ical.js сам прочёл его
 * обратно в тот же момент (`toUnixTime` при `utcOffset` зоны). Если такого
 * стенного времени нет (первое вхождение повторного часа осенью: ical.js
 * читает неоднозначное время как второе), остаётся результат convertToZone.
 */
function atInstant(seconds: number, zone: ICAL.Timezone): ICAL.Time {
  const utc = fromUnix(seconds);
  if (zone === ICAL.Timezone.utcTimezone) return utc;

  let guess = withWall(utc, zone);
  for (let attempt = 0; attempt < 4; attempt++) {
    const candidate = withWall(fromUnix(seconds + guess.utcOffset()), zone);
    if (candidate.toUnixTime() === seconds) return candidate;
    guess = candidate;
  }
  return utc.convertToZone(zone);
}

// Новое время с теми же стенными полями в поясе zone.
function withWall(t: ICAL.Time, zone: ICAL.Timezone): ICAL.Time {
  return ICAL.Time.fromData(
    { year: t.year, month: t.month, day: t.day, hour: t.hour, minute: t.minute, second: t.second, isDate: false },
    zone,
  );
}

function midnightOf(t: ICAL.Time, zone: ICAL.Timezone): ICAL.Time {
  return ICAL.Time.fromData({ year: t.year, month: t.month, day: t.day, hour: 0, minute: 0, second: 0, isDate: false }, zone);
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

function dateOf(t: ICAL.Time): string {
  return `${pad(t.year, 4)}-${pad(t.month)}-${pad(t.day)}`;
}

function wallString(t: ICAL.Time): string {
  return `${dateOf(t)}T${pad(t.hour)}:${pad(t.minute)}:${pad(t.second)}`;
}

// ISO со смещением пояса значения. Смещение с секундами (исторические LMT)
// в ISO не записать — тогда время выводится в UTC, момент остаётся точным.
function isoWithOffset(t: ICAL.Time): string {
  const offset = t.utcOffset();
  if (offset % 60 !== 0) return `${wallString(fromUnix(t.toUnixTime()))}+00:00`;
  const sign = offset < 0 ? "-" : "+";
  const abs = Math.abs(offset);
  return `${wallString(t)}${sign}${pad(Math.floor(abs / 3600))}:${pad(Math.floor((abs % 3600) / 60))}`;
}

function startOf(value: ICAL.Time | ICAL.Period): ICAL.Time {
  return value instanceof ICAL.Period ? value.start : value;
}

// Запись значения в свойство: property.js, setValue — resetType(icaltype)
// ставит VALUE (date, date-time, period) и сбрасывает значения, затем
// _setDecoratedValue кладёт в jCal строку значения (undecorate → toString или
// у PERIOD toJSON) и кеширует сам объект — поэтому пишется копия.
function writeTimeValue(property: ICAL.Property, value: ICAL.Time | ICAL.Period): void {
  const copy = value.clone();
  property.removeParameter("tzid");
  property.setValue(copy);
  const start = startOf(copy);
  if (formOf(start) === "zoned") property.setParameter("tzid", start.zone.tzid);
}

function assertRecur(p: ICAL.Property): void {
  if (p.type !== "recur") {
    throw new Error(`Свойство ${p.name.toUpperCase()} не является правилом повторения (тип ${p.type}).`);
  }
}

const UNTIL_PATTERN = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}Z?)?$/;

function untilString(value: RuleValue | ICAL.Time): string {
  if (value instanceof ICAL.Time) return value.toString();
  if (typeof value === "string" && UNTIL_PATTERN.test(value)) return value;
  throw new Error(
    `UNTIL должен быть jCal-строкой YYYY-MM-DD или YYYY-MM-DDTHH:MM:SS[Z], получено ${JSON.stringify(value)}.`,
  );
}
