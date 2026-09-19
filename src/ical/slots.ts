import ICAL from "ical.js";
import type { CalendarObject } from "./object.js";
import {
  compareSlotKeys,
  formOf,
  listEntries,
  listKeys,
  slotKeyOf,
  timeInForm,
  type IcalEnv,
  type SlotKey,
  type TimeForm,
  type ZoneRef,
} from "./values.js";

/**
 * Слоты серии: DTSTART ∪ позиции RRULE ∪ RDATE − EXDATE, множеством ключей
 * (О2 плана переделки, docs/superpowers/plans/2026-09-19-recurring-events-rework.md).
 *
 * Позиции правила берутся из `ICAL.Recur.iterator(истинный DTSTART)`
 * (node_modules/ical.js/lib/ical/recur.js, iterator), выдачи клонируются:
 * итератор отдаёт один и тот же объект `last` (recur_iterator.js, next).
 * DTSTART, не попавший на позицию правила, итератор не выдаёт и в
 * `occurrence_number` не считает (recur_iterator.js:386-467) — он добавляется
 * отдельно. `RecurExpansion` не используется: на дубле EXDATE и на «пустом»
 * EXDATE он пропускает исключение (recur_expansion.js:263-277, контракт —
 * tests/ical/icaljs-contract.test.ts).
 *
 * Пустота, конец серии, последний слот под UNTIL и число позиций считаются
 * полным проходом правила без горизонта, с пределом `SERIES_CAP` слотов
 * (Р1, Р3, О12д). Модуль читает основной компонент объекта заново при каждом
 * вызове, так что видит и правки дерева на месте (после `setRuleDict`,
 * values.ts).
 *
 * Два отступления от итератора ical.js 2.2.1, оба — к RFC 5545:
 * - предохранитель внутреннего цикла `next()`: у правила вроде
 *   `FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30` цикл `do … while
 *   (!check_contracting_rules() …)` (recur_iterator.js:451) не кончается
 *   никогда. Счётчик шагов ставится на экземпляр итератора поверх
 *   `check_contracting_rules` (recur_iterator.js:1417), который цикл зовёт на
 *   каждом шаге; больше `STALL_STEPS` шагов без позиции — `SlotScanError`
 *   "stalled" (в loadObject — аномалия no-positions, Р4);
 * - годовое правило без дневных частей с DTSTART 29–31 числа:
 *   `expand_year_days` (recur_iterator.js) берёт номер дня года от
 *   несуществующей даты, и 29.02 превращается в 01.03 невисокосного года.
 *   По RFC 5545 §3.3.10 такие даты не входят в набор и не считаются в COUNT.
 *   Здесь они отбрасываются, а COUNT считается по оставшимся позициям.
 */

/** Предел полного прохода серии (Р1, Р3, О12д): слотов или позиций. */
export const SERIES_CAP = 200_000;
/** Шагов внутреннего цикла итератора без позиции — правило без позиций (Р4). */
export const STALL_STEPS = 100_000;
/** Пределы сверки хвоста (sameTail): слотов, лет, лет у YEARLY. */
export const TAIL_SLOTS = 500;
export const TAIL_YEARS = 5;
export const TAIL_YEARS_YEARLY = 20;

/** Откуда слот: DTSTART, позиция RRULE, значение RDATE. */
export type SlotOrigin = "dtstart" | "rrule" | "rdate";

export interface Slot {
  key: SlotKey;
  /** Копия времени слота в форме и поясе DTSTART (у RDATE — приведённая к ним, О4). */
  time: ICAL.Time;
  /** Главный источник: dtstart, затем rrule, затем rdate. */
  origin: SlotOrigin;
  /** Все источники слота по тому же порядку. */
  sources: readonly SlotOrigin[];
  /** Номер позиции первого RRULE (как occurrence_number, с 1); EXDATE номера не сдвигает. */
  position?: number;
  /** Конец RDATE;VALUE=PERIOD. */
  periodEnd?: ICAL.Time;
  /** Слот закрыт EXDATE или EXRULE. */
  excluded: boolean;
}

/** Граница перебора: слоты не позже `until` (включительно) и не больше `limit` штук. */
export interface SlotBound {
  until?: SlotKey;
  limit?: number;
}

/**
 * Перебор не удался: "stalled" — итератор не находит следующей позиции за
 * `STALL_STEPS` шагов; "rule-error" — итератор ical.js бросил; "too-long" —
 * превышен предел прохода.
 */
export class SlotScanError extends Error {
  readonly code: "stalled" | "rule-error" | "too-long";

  constructor(code: "stalled" | "rule-error" | "too-long", message: string) {
    super(message);
    this.name = "SlotScanError";
    this.code = code;
  }
}

// ─────────────────────────────── перебор ───────────────────────────────

/**
 * Слоты объекта по возрастанию ключа, с флагом `excluded`. Слоты с одним
 * ключом из разных источников (DTSTART и первая позиция, позиция и RDATE)
 * сливаются в один. У объекта без основного компонента слотов нет. Если у
 * основного компонента аномалия bad-rrule или no-positions, правила не
 * читаются: слоты — DTSTART и RDATE (Р4).
 *
 * Без границы у бесконечной серии перебор бесконечен. Бросает
 * `SlotScanError`, если итератор ical.js застрял или упал посреди серии.
 */
export function* iterateSlots(o: CalendarObject, bound: SlotBound = {}): Generator<Slot> {
  const spec = specOf(o);
  if (!spec) return;

  const streams = [
    new Stream([{ key: spec.dtstartKey, time: spec.dtstart.clone(), source: "dtstart" } satisfies Candidate][Symbol.iterator]()),
    ...spec.rules.map((rule, index) => new Stream(ruleCandidates(rule, spec, index === 0))),
    new Stream(
      spec.rdates
        .map((entry): Candidate => ({ key: entry.key, time: entry.time.clone(), source: "rdate", periodEnd: entry.periodEnd?.clone() }))
        [Symbol.iterator](),
    ),
  ];
  const exclusions = spec.exrules.map((rule) => new Stream(ruleCandidates(rule, spec, false)));
  const excluded = (key: SlotKey): boolean => {
    let hit = spec.exdates.has(key);
    for (const stream of exclusions) {
      while (stream.head && compareSlotKeys(stream.head.key, key) < 0) stream.advance();
      if (stream.head && stream.head.key === key) hit = true;
    }
    return hit;
  };

  let emitted = 0;
  for (;;) {
    let min: SlotKey | undefined;
    for (const stream of streams) {
      if (stream.head && (min === undefined || compareSlotKeys(stream.head.key, min) < 0)) min = stream.head.key;
    }
    if (min === undefined) return;
    if (bound.until !== undefined && compareSlotKeys(min, bound.until) > 0) return;

    // Все кандидаты с этим ключом, в том числе повторы из одного источника:
    // у HOURLY стенное время из весеннего разрыва ical.js читает в тот же
    // момент, что и час до него (timezone.js:287-364, utcOffset).
    const found: Candidate[] = [];
    for (const stream of streams) {
      while (stream.head && stream.head.key === min) {
        found.push(stream.head);
        stream.advance();
      }
    }
    yield slotOf(min, found, excluded(min));
    emitted += 1;
    if (bound.limit !== undefined && emitted >= bound.limit) return;
  }
}

/** Слот с ключом `key` (закрытый EXDATE — тоже) или undefined. Проход не дальше `key`, не больше `cap` слотов. */
export function findSlot(o: CalendarObject, key: SlotKey, cap = SERIES_CAP): Slot | undefined {
  let seen = 0;
  for (const slot of iterateSlots(o, { until: key })) {
    if (slot.key === key) return slot;
    if (++seen > cap) throw new SlotScanError("too-long", `Слот ${key} дальше ${cap} слотов от начала серии.`);
  }
  return undefined;
}

/** Первый слот набора (закрытый EXDATE — тоже): обычно DTSTART. */
export function firstSlot(o: CalendarObject): Slot | undefined {
  for (const slot of iterateSlots(o, { limit: 1 })) return slot;
  return undefined;
}

/**
 * DTSTART стоит на первой позиции первого RRULE (RFC 5545 §3.8.5.3: иначе
 * набор не определён). Без RRULE — да; у непригодного правила — нет.
 */
export function isDtstartSynced(o: CalendarObject): boolean {
  const spec = specOf(o);
  if (!spec || !o.master?.hasProperty("rrule")) return true;
  if (spec.rules.length === 0) return false;
  try {
    const first = positionsOf(spec.rules[0], spec).next();
    return !first.done && first.value.key === spec.dtstartKey;
  } catch (error) {
    if (error instanceof SlotScanError) return false;
    throw error;
  }
}

// ──────────────────────── конец, пустота, позиции ────────────────────────

/**
 * Протяжённость серии полным проходом (О12д, Р1):
 * - infinite — есть RRULE без COUNT и UNTIL;
 * - finite — `count` слотов набора (с закрытыми EXDATE), последний из них
 *   `last`; `live` и `lastLive` — то же без закрытых;
 * - too-long — больше `cap` слотов или итератор застрял посреди серии.
 * Объект без основного компонента — finite с нулём слотов.
 */
export type SeriesExtent =
  | { kind: "infinite" }
  | { kind: "finite"; count: number; last?: Slot; live: number; lastLive?: Slot }
  | { kind: "too-long" };

export function seriesExtent(o: CalendarObject, cap = SERIES_CAP): SeriesExtent {
  const spec = specOf(o);
  if (!spec) return { kind: "finite", count: 0, live: 0 };
  // recur.js, isFinite: !!(count || until).
  if (spec.rules.some((rule) => !rule.isFinite())) return { kind: "infinite" };

  let count = 0;
  let live = 0;
  let last: Slot | undefined;
  let lastLive: Slot | undefined;
  try {
    for (const slot of iterateSlots(o)) {
      if (++count > cap) return { kind: "too-long" };
      last = slot;
      if (!slot.excluded) {
        live += 1;
        lastLive = slot;
      }
    }
  } catch (error) {
    if (error instanceof SlotScanError) return { kind: "too-long" };
    throw error;
  }
  return { kind: "finite", count, last, live, lastLive };
}

/**
 * Объект пуст (Р3): нет живых оторванных встреч (роль detached и эхо
 * оторванной встречи) и ни одного незакрытого слота. Без горизонта:
 * бесконечное правило находит незакрытую позицию за число шагов не больше
 * числа EXDATE, конечная серия проходится целиком. Больше `cap` слотов или
 * сбой итератора — «не пуст»: ошибка в сторону сохранения данных.
 * Скрытые переопределения пустоте не мешают — это следы прошлых удалений.
 */
export function isEmpty(o: CalendarObject, cap = SERIES_CAP): boolean {
  for (const info of o.roles.values()) {
    if (info.role === "detached" || (info.role === "echo" && info.slot === undefined)) return false;
  }
  if (!o.master) return true;

  let seen = 0;
  try {
    for (const slot of iterateSlots(o)) {
      if (!slot.excluded) return false;
      if (++seen >= cap) return false;
    }
  } catch (error) {
    if (error instanceof SlotScanError) return false;
    throw error;
  }
  return true;
}

/** Итог lastSlotUpTo: слот, слотов до момента нет, или проход длиннее предела. */
export type LastSlot = { kind: "slot"; slot: Slot } | { kind: "none" } | { kind: "too-far" };

/**
 * Последний слот правила (DTSTART или позиция RRULE, закрытый EXDATE — тоже)
 * не позже `until` — значения UNTIL или ключа. Слоты только из RDATE не
 * считаются: UNTIL ограничивает правило, а не RDATE. Нужен для пересчёта
 * UNTIL в all_series (Р1): U' = новое время на дате этого слота. Проход без
 * горизонта; больше `cap` слотов — too-far (отказ until-too-far у вызывающего).
 */
export function lastSlotUpTo(o: CalendarObject, until: ICAL.Time | SlotKey, cap = SERIES_CAP): LastSlot {
  const spec = specOf(o);
  if (!spec) return { kind: "none" };
  const untilKey = typeof until === "string" ? until : slotKeyOf(until, spec.form, spec.env);

  let found: Slot | undefined;
  let seen = 0;
  try {
    for (const slot of iterateSlots(o, { until: untilKey })) {
      if (++seen > cap) return { kind: "too-far" };
      if (slot.sources.includes("dtstart") || slot.sources.includes("rrule")) found = slot;
    }
  } catch (error) {
    if (error instanceof SlotScanError) return { kind: "too-far" };
    throw error;
  }
  return found ? { kind: "slot", slot: found } : { kind: "none" };
}

/**
 * Число позиций первого RRULE строго раньше ключа `key` — COUNT исходной
 * серии при разрезе на границе `key` (таблица §3, t&f). EXDATE позиций не
 * сдвигает (итератор его не знает), RDATE и DTSTART вне правила — не позиции.
 * Без RRULE — 0. Больше `cap` позиций — `SlotScanError` "too-long".
 */
export function positionsBefore(o: CalendarObject, key: SlotKey, cap = SERIES_CAP): number {
  const spec = specOf(o);
  if (!spec || spec.rules.length === 0) return 0;
  let count = 0;
  for (const position of positionsOf(spec.rules[0], spec)) {
    if (compareSlotKeys(position.key, key) >= 0) return count;
    if (++count > cap) throw new SlotScanError("too-long", `До ${key} больше ${cap} позиций правила.`);
  }
  return count;
}

// ─────────────────────────────── хвост ───────────────────────────────

/** Пределы сверки хвоста: слотов и лет от первого слота хвоста. */
export interface TailLimit {
  slots?: number;
  years?: number;
}

export type SameTail =
  | { same: true; compared: number }
  | { same: false; reason: string; expected?: SlotKey; actual?: SlotKey };

/**
 * Хвост серии `a` от ключа `from` (включительно) совпадает с набором слотов
 * `b` через отображение ключей `map` (ключ `a` → ключ `b`): те же ключи, тот
 * же порядок, те же закрытые EXDATE, и у `b` нет слотов раньше хвоста.
 * Сравнивается min(конец серии `a`, 500 слотов, 5 лет), у YEARLY — 20 лет
 * (задача З06). Если хвост `a` кончился раньше пределов, у `b` не должно
 * быть слотов и после него. Так разрез проверяет, что продолжение повторяет
 * расписание, а причуды итератора не превращаются в тихую порчу (Р9).
 */
export function sameTail(
  a: CalendarObject,
  from: SlotKey,
  b: CalendarObject,
  map: (key: SlotKey) => SlotKey,
  limit: TailLimit = {},
): SameTail {
  const spec = specOf(a);
  if (!spec) return { same: false, reason: "у исходного объекта нет основного компонента" };
  const maxSlots = limit.slots ?? TAIL_SLOTS;
  const years = limit.years ?? (spec.rules[0]?.freq === "YEARLY" ? TAIL_YEARS_YEARLY : TAIL_YEARS);

  const expected: Array<{ key: SlotKey; excluded: boolean }> = [];
  let tailEnded = true;
  let windowEnd: SlotKey | undefined;
  let seen = 0;
  try {
    for (const slot of iterateSlots(a)) {
      if (++seen > SERIES_CAP) return { same: false, reason: `исходная серия длиннее ${SERIES_CAP} слотов` };
      if (compareSlotKeys(slot.key, from) < 0) continue;
      windowEnd ??= slotKeyOf(yearsLater(slot.time, years), spec.form, spec.env);
      if (expected.length >= maxSlots || compareSlotKeys(slot.key, windowEnd) > 0) {
        tailEnded = false;
        break;
      }
      expected.push({ key: map(slot.key), excluded: slot.excluded });
    }
  } catch (error) {
    if (error instanceof SlotScanError) return { same: false, reason: `исходная серия: ${error.message}` };
    throw error;
  }

  let index = 0;
  try {
    for (const slot of iterateSlots(b)) {
      if (index === expected.length) {
        if (tailEnded) {
          return { same: false, reason: "у продолжения есть встречи после конца исходной серии", actual: slot.key };
        }
        break;
      }
      const want = expected[index];
      if (slot.key !== want.key) {
        return { same: false, reason: "встреча продолжения не совпадает с хвостом исходной серии", expected: want.key, actual: slot.key };
      }
      if (slot.excluded !== want.excluded) {
        return {
          same: false,
          reason: want.excluded ? "в продолжении не закрыта встреча, удалённая в исходной серии" : "в продолжении закрыта лишняя встреча",
          expected: want.key,
          actual: slot.key,
        };
      }
      index += 1;
    }
  } catch (error) {
    if (error instanceof SlotScanError) return { same: false, reason: `продолжение: ${error.message}` };
    throw error;
  }
  if (index < expected.length) {
    return { same: false, reason: "продолжение кончается раньше исходной серии", expected: expected[index].key };
  }
  return { same: true, compared: expected.length };
}

// ─────────────────────── для loadObject (object.ts) ───────────────────────

/**
 * Пояс значений серии для `timeInForm` (values.ts), по свойству времени
 * (DTSTART основного или RECURRENCE-ID):
 * - форма не zoned — undefined;
 * - TZID-синоним UTC (UTC, GMT, Z) — имя из TZID: ical.js отдаёт на них общий
 *   `utcTimezone` без имени (timezone_service.js, reset), а форме zoned нужен
 *   тот же TZID (values.ts, zonedTarget);
 * - TZID неизвестен (ical.js прочёл время плавающим, time.js,
 *   fromDateTimeString) — пояс календаря, как и у момента в `instantOf`;
 * - иначе — пояс значения из дерева объекта (Ж10: не по имени из базы).
 */
export function seriesZoneOf(property: ICAL.Property, env: IcalEnv): ZoneRef | undefined {
  if (formOf(property) !== "zoned") return undefined;
  const time = property.getFirstValue() as ICAL.Time;
  if (time.zone === ICAL.Timezone.utcTimezone) return String(property.getParameter("tzid"));
  if (formOf(time) === "floating" || !time.zone) return env.floatingZone;
  return time.zone;
}

/** Проба правила при загрузке: пригодно ли оно, и стоит ли DTSTART на первой позиции. */
export interface RuleProbe {
  name: "rrule" | "exrule";
  index: number;
  outcome: "ok" | "no-positions" | "bad-rrule";
  message?: string;
  /** Для RRULE: первая позиция правила совпала с DTSTART. */
  synced?: boolean;
}

/**
 * Пробует каждое RRULE и EXRULE основного компонента (Р4): ошибка итератора
 * — bad-rrule; ни одной позиции или застревание на поиске первой или второй
 * позиции — no-positions (правило вроде DAILY;BYMONTH=2;BYMONTHDAY=30
 * отдаёт init-позицию, а следующую не находит никогда). EXRULE без позиций
 * безвредно и не отмечается.
 */
export function probeRules(master: ICAL.Component, env: IcalEnv): RuleProbe[] {
  const spec = specFromMaster(master, env, true);
  if (!spec) return [];
  const probes: RuleProbe[] = [];
  const probe = (name: "rrule" | "exrule", rule: ICAL.Recur, index: number) => {
    try {
      const positions = positionsOf(rule, spec);
      const first = positions.next();
      if (first.done) {
        if (name === "rrule") probes.push({ name, index, outcome: "no-positions", message: "у правила нет ни одной позиции" });
        return;
      }
      positions.next(); // вторая позиция: застревание на ней — тоже правило без позиций
      probes.push({ name, index, outcome: "ok", synced: name === "rrule" ? first.value.key === spec.dtstartKey : undefined });
    } catch (error) {
      if (!(error instanceof SlotScanError)) throw error;
      const outcome = error.code === "stalled" ? "no-positions" : "bad-rrule";
      probes.push({ name, index, outcome, message: error.message });
    }
  };
  spec.rules.forEach((rule, index) => probe("rrule", rule, index));
  spec.exrules.forEach((rule, index) => probe("exrule", rule, index));
  return probes;
}

// ─────────────────────────────── внутреннее ───────────────────────────────

interface SeriesSpec {
  form: TimeForm;
  env: IcalEnv;
  zone: ZoneRef | undefined;
  dtstart: ICAL.Time;
  dtstartKey: SlotKey;
  rules: ICAL.Recur[];
  exrules: ICAL.Recur[];
  rdates: Array<{ key: SlotKey; time: ICAL.Time; periodEnd?: ICAL.Time }>;
  exdates: ReadonlySet<SlotKey>;
}

interface Candidate {
  key: SlotKey;
  time: ICAL.Time;
  source: SlotOrigin;
  position?: number;
  periodEnd?: ICAL.Time;
}

interface Position {
  time: ICAL.Time;
  key: SlotKey;
  position: number;
}

class Stream {
  head: Candidate | undefined;

  constructor(private readonly source: Iterator<Candidate>) {
    this.advance();
  }

  advance(): void {
    const next = this.source.next();
    this.head = next.done ? undefined : next.value;
  }
}

class RuleStall extends Error {}

function specOf(o: CalendarObject): SeriesSpec | undefined {
  if (!o.master) return undefined;
  const usable = !o.anomalies.some((anomaly) => anomaly.code === "bad-rrule" || anomaly.code === "no-positions");
  return specFromMaster(o.master, o.env, usable);
}

function specFromMaster(master: ICAL.Component, env: IcalEnv, rulesUsable: boolean): SeriesSpec | undefined {
  const property = master.getFirstProperty("dtstart");
  if (!property) return undefined;
  const form = formOf(property);
  const dtstart = (property.getFirstValue() as ICAL.Time).clone();
  const zone = seriesZoneOf(property, env);
  const context = { form, env };
  const recurs = (name: "rrule" | "exrule") =>
    rulesUsable ? master.getAllProperties(name).map((p) => p.getFirstValue() as ICAL.Recur) : [];

  const rdates = listEntries(master, "rdate", context)
    .map((entry) => ({ key: entry.key, time: inSeriesForm(entry.time, form, zone, env), periodEnd: entry.periodEnd }))
    .sort((x, y) => compareSlotKeys(x.key, y.key));

  return {
    form,
    env,
    zone,
    dtstart,
    dtstartKey: slotKeyOf(dtstart, form, env),
    rules: recurs("rrule"),
    exrules: recurs("exrule"),
    rdates,
    exdates: new Set(listKeys(master, "exdate", context)),
  };
}

// Значение RDATE в форме и поясе DTSTART (О4); ключ при этом сохраняется
// (values.ts, timeInForm). Если пояс серии не годится для перевода —
// исходное значение: ключ у него тот же.
function inSeriesForm(time: ICAL.Time, form: TimeForm, zone: ZoneRef | undefined, env: IcalEnv): ICAL.Time {
  try {
    return timeInForm(time, form, zone, env);
  } catch {
    return time.clone();
  }
}

function* ruleCandidates(rule: ICAL.Recur, spec: SeriesSpec, numbered: boolean): Generator<Candidate> {
  for (const position of positionsOf(rule, spec)) {
    yield { key: position.key, time: position.time, source: "rrule", position: numbered ? position.position : undefined };
  }
}

/**
 * Позиции правила по порядку, с номерами с 1. Годовое правило без дневных
 * частей с DTSTART 29–31 числа: позиции с другим днём месяца — следы
 * нормализации несуществующей даты в ical.js, они отбрасываются и в COUNT не
 * считаются (RFC 5545 §3.3.10); COUNT такого правила применяется здесь, к
 * итератору без COUNT.
 */
function* positionsOf(rule: ICAL.Recur, spec: SeriesSpec): Generator<Position> {
  const dayFilter = needsDayFilter(rule, spec.dtstart);
  const count = dayFilter ? rule.count : null;
  const next = guardedIterator(dayFilter && count ? withoutCount(rule) : rule, spec.dtstart);

  let position = 0;
  let skipped = 0;
  for (;;) {
    const time = next();
    if (!time) return;
    if (dayFilter && time.day !== spec.dtstart.day) {
      if (++skipped > STALL_STEPS) throw new SlotScanError("stalled", "Правило не находит существующей даты.");
      continue;
    }
    skipped = 0;
    position += 1;
    yield { time, key: slotKeyOf(time, spec.form, spec.env), position };
    if (count && position >= count) return;
  }
}

function needsDayFilter(rule: ICAL.Recur, dtstart: ICAL.Time): boolean {
  if (rule.freq !== "YEARLY" || dtstart.day < 29) return false;
  return !["BYMONTHDAY", "BYYEARDAY", "BYWEEKNO", "BYDAY"].some((part) => part in rule.parts);
}

// recur.js, clone: new Recur(this.toJSON()) — неизвестные части теряются, для перебора они не нужны.
function withoutCount(rule: ICAL.Recur): ICAL.Recur {
  const copy = rule.clone();
  copy.count = null;
  return copy;
}

/**
 * Итератор правила с предохранителем. Сбой конструктора (init,
 * recur_iterator.js:211-380) и `next` — `SlotScanError` "rule-error";
 * больше `STALL_STEPS` проверок `check_contracting_rules` за один вызов
 * `next` — "stalled". InvalidRecurrenceRuleError при init ical.js сам
 * превращает в пустой итератор (recur_iterator.js, fromData).
 */
function guardedIterator(rule: ICAL.Recur, dtstart: ICAL.Time): () => ICAL.Time | null {
  let iterator: ICAL.RecurIterator;
  try {
    iterator = rule.iterator(dtstart.clone());
  } catch (error) {
    throw new SlotScanError("rule-error", `Итератор правила не создан: ${messageOf(error)}`);
  }

  let steps = 0;
  const check = iterator.check_contracting_rules.bind(iterator);
  iterator.check_contracting_rules = () => {
    if (++steps > STALL_STEPS) throw new RuleStall();
    return check();
  };

  return () => {
    steps = 0;
    try {
      const time = iterator.next();
      return time ? time.clone() : null;
    } catch (error) {
      if (error instanceof RuleStall) {
        throw new SlotScanError("stalled", `Правило не находит следующей позиции за ${STALL_STEPS} шагов.`);
      }
      throw new SlotScanError("rule-error", `Итератор правила упал: ${messageOf(error)}`);
    }
  };
}

function slotOf(key: SlotKey, found: Candidate[], excluded: boolean): Slot {
  const order: SlotOrigin[] = ["dtstart", "rrule", "rdate"];
  const sources = order.filter((origin) => found.some((candidate) => candidate.source === origin));
  const origin = sources[0];
  const primary = found.find((candidate) => candidate.source === origin)!;
  return {
    key,
    time: primary.time,
    origin,
    sources,
    position: found.find((candidate) => candidate.position !== undefined)?.position,
    periodEnd: found.find((candidate) => candidate.periodEnd !== undefined)?.periodEnd,
    excluded,
  };
}

// То же время через `years` лет; 29.02 в невисокосном году — 28.02.
function yearsLater(t: ICAL.Time, years: number): ICAL.Time {
  const year = t.year + years;
  const day = Math.min(t.day, ICAL.Time.daysInMonth(t.month, year));
  return ICAL.Time.fromData(
    { year, month: t.month, day, hour: t.hour, minute: t.minute, second: t.second, isDate: t.isDate },
    t.zone ?? undefined,
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
