import type ICAL from "ical.js";
import { occurrencesOf, unreadableReason } from "./expand.js";
import { GuardError, type GuardCode, type GuardOptions, type GuardProblem } from "./guard.js";
import { parseAddress, type EventMeta } from "./instances.js";
import { isUnparsable, loadObject, serializeObject, type CalendarObject, type OverrideRef } from "./object.js";
import type { EventPatch, Expectation, PatchField, RecurrencePatch, WritePlan } from "./plan.js";
import { seriesExtent } from "./slots.js";
import { compareSlotKeys, instantOf, listKeys, parseModelTime, type IcalEnv, type SlotKey } from "./values.js";
import type { Attendee, CalendarEvent } from "../types.js";

/**
 * Разностный предохранитель записи: сравнение наборов встреч вместо перечня
 * разрешений (задача З11, второй заход).
 *
 * Прежний предохранитель (guard.ts) вторым независимым перечнем повторял
 * семантику планировщика: какое свойство какой правке разрешено менять, что
 * можно RRULE при таком-то патче, какой компонент чьё поле наследует. Два
 * перечня расходились при каждой правке, и закрытие одного случая открывало
 * зеркальный — вплоть до отказа законной записи первого правила у одиночного
 * события («конечная серия стала бесконечной»).
 *
 * Здесь предохранитель о полях и правилах не рассуждает вовсе. Он
 * разворачивает дерево ДО и дерево ПОСЛЕ и сравнивает НАБОРЫ ВСТРЕЧ — то,
 * что увидит пользователь. Всякое расхождение обязано быть оправдано планом
 * и патчем; неоправданное — отказ. Он не знает, КАК надо было записать: он
 * знает только, что необъявленного изменения быть не должно.
 *
 * Устройство:
 * - дерево ПОСЛЕ — текст, который план собирается записать (`put.ics`, обе
 *   стороны разреза); разбор тот же, что у прочитанного (object.ts), и
 *   прочитанное сравнивается со своей канонической записью, чтобы
 *   нормализация ical.js не выдавалась за правку плана;
 * - разворот — `occurrencesOf` (expand.ts), тот самый, которым список встреч
 *   показывается пользователю: второго разворота предохранитель не пишет;
 * - горизонт — от меньшего DTSTART обеих сторон до позднейшего из: конца
 *   конечной серии, позднейшего явного значения (RECURRENCE-ID, EXDATE,
 *   RDATE) и «сейчас + 2 года»; упор — {@link MEETINGS_CAP} встреч, дальше
 *   набор подрезается с обеих сторон разом. Бесконечность распознаётся
 *   ПРОБОЙ ЗА КОНЦОМ горизонта, а не чтением COUNT и UNTIL;
 * - в наборе, кроме видимых встреч, стоят скрытые переопределения (роль
 *   hidden): встречи у них нет, но это настоящие данные пользователя
 *   (get_event.exceptions), и молча выбрасывать их нельзя.
 *
 * Оправдания расхождения (и ничего сверх них):
 * - встреча исчезла — названа в ответе `plan.removed`, объявлена планом
 *   (`expect.removed`) или адресована целью удаления в этом scope;
 * - встреча появилась — следует из патча, меняющего повтор (тогда простые
 *   слоты задаёт новое правило и в сверке не участвуют вовсе), либо стоит
 *   на месте прежней;
 * - встреча изменилась — её компонент отмечен планом в `touched`, и само
 *   изменение лежит внутри названного патчем: время (начало, конец,
 *   всесуточность) свободно только при start, end, timeZone или allDay,
 *   текстовые поля — только названные патчем; STATUS патчем не называется
 *   никогда и меняться не может;
 * - всё прочее обязано совпасть.
 *
 * Сверх разности — только то, что встречами не выражается: UID объекта и
 * чужие UID среди компонентов, законность удаления объекта целиком, переход
 * «кончалась ↔ не кончается» и запись, тождественная прочитанному тексту.
 *
 * Чего предохранитель не делает: не сверяет, что записан именно тот текст,
 * который просили (граница задачи — это дело планировщика и его тестов), не
 * перечисляет разрешённые свойства покомпонентно и не заводит веток «если
 * патч такой, то можно то-то».
 *
 * Внешний договор — тот же, что у verifyPlan в guard.ts: те же GuardOptions,
 * тот же GuardError с теми же кодами, так что guard2 подставляется вместо
 * guard без правки вызывающих. Ошибка и коды берутся из guard.ts, а не
 * заводятся заново: `instanceof GuardError` обязан работать у обоих.
 *
 * Пояс процесса не участвует: моменты — через values.ts (`instantOf`,
 * `parseModelTime`), без Date от полей.
 */

export { GuardError };
export type { GuardCode, GuardProblem, GuardOptions };

// ─────────────────────────────── пределы ───────────────────────────────

/** Сколько встреч с каждой стороны сверяется; дальше набор подрезается. */
export const MEETINGS_CAP = 400;
/** Горизонт: столько лет вперёд от «сейчас» или от начала серии. */
export const HORIZON_YEARS = 2;

const DAY_MS = 86_400_000;
const YEAR_MS = 365 * DAY_MS;
/** Проба за концом горизонта: ближняя (на год с лишним) и дальняя (на редкие серии). */
const PROBE_NEAR_MS = 400 * DAY_MS;
const PROBE_FAR_MS = 20 * YEAR_MS;
/** У края горизонта сдвиг времени переносит встречу через границу — там расхождение не в счёт. */
const EDGE_MS = 2 * DAY_MS;
/** Сколько адресов перечислять в одном сообщении. */
const LIST_LIMIT = 8;

const META: EventMeta = { calendarId: "" };
const TIME_FIELDS: readonly PatchField[] = ["start", "end", "timeZone", "allDay"];

/** Видимые поля встречи и поле патча, которое вправе их менять (у STATUS такого поля нет). */
const SNAPSHOT: readonly { name: string; label: string; field?: PatchField }[] = [
  { name: "summary", label: "название", field: "summary" },
  { name: "description", label: "описание", field: "description" },
  { name: "location", label: "место", field: "location" },
  { name: "attendees", label: "участники", field: "attendees" },
  { name: "status", label: "состояние (STATUS)" },
];

// ─────────────────────────────── вход ───────────────────────────────

/**
 * Проверяет план записи против прочитанного объекта `beforeIcs`. Ничего не
 * возвращает; план, который испортит данные, — `GuardError`.
 *
 * Из договора с планировщиком (plan.ts, `Expectation`) используются:
 * `op`, `scope` и `target` — чтобы знать, что операция вправе убрать;
 * `keyMap` — чем прежний адрес встречи стал после записи; `removed` и ответ
 * `plan.removed` — что план объявил убранным; `fields` вместе с
 * `GuardOptions.patch` — что просил пользователь; `touched` — какие
 * компоненты правка трогала.
 */
export function verifyPlan(beforeIcs: string, plan: WritePlan, env: IcalEnv, options: GuardOptions = {}): void {
  // Аннотация обязательна: без неё вывод типов не признаёт `findings.fail` невозвращающим.
  const findings: Findings = new Findings();
  const expect = plan.expect;

  if (plan.kind === "noop") {
    if (expect.removed.length > 0 || plan.removed.length > 0) {
      findings.add("plan-shape", "Пустой план ничего не пишет, а называет убранные встречи: ответ солгал бы о записи.");
    }
    findings.throwIfAny();
    return;
  }
  // О14: удаление всей серии не блокируется ничем, в том числе неразобранным текстом.
  if (plan.kind === "delete-object" && expect.op === "delete" && expect.scope === "all_series") return;
  if (plan.kind === "delete-object" && expect.op !== "delete") {
    findings.fail("plan-shape", `Правка (${expect.op} ${expect.scope}) не удаляет объект целиком.`);
  }
  if (plan.kind === "split" && (expect.op !== "update" || expect.scope !== "this_and_following")) {
    findings.fail("plan-shape", `Разрез серии бывает только у update this_and_following, а не у ${expect.op} ${expect.scope}.`);
  }

  const loaded = loadObject(beforeIcs, env);
  if (isUnparsable(loaded)) {
    findings.fail("unparsable", `Прочитанный объект не разобран (${loaded.error}): сверять план не с чем.`);
  }
  // Сравнение — с текстом, прошедшим тот же путь, что и план: разбор и вывод
  // ical.js. Нормализация библиотеки не выдаётся за правку планировщика.
  const canonical = loadObject(serializeObject(loaded), env);
  const before: CalendarObject = isUnparsable(canonical) ? loaded : canonical;

  const ctx = makeContext(before, plan, env, findings, options);
  const sides = writtenSides(ctx, plan);

  checkUids(ctx, sides);
  checkRewrite(ctx, plan, sides);

  const window = windowOf(ctx, [before, ...sides.map((side) => side.o)]);
  const beforeSet = recordsOf(ctx, before, window, "прочитанный объект", undefined);
  const afterSet = new Map<SlotKey, Rec>();
  for (const side of sides) {
    for (const [key, rec] of recordsOf(ctx, side.o, window, side.label, side)) {
      if (afterSet.has(key)) ctx.findings.add("meeting-added", `Две встречи с одним адресом ${rec.addr} после записи.`);
      else afterSet.set(key, rec);
    }
  }
  const cutoffMs = trim(beforeSet, afterSet);

  const continues = {
    before: continuesBeyond(before, window.toMs),
    after: sides.some((side) => continuesBeyond(side.o, window.toMs)),
  };
  // У края набора сдвиг времени переносит встречу за границу, и её пара
  // остаётся по ту сторону: там расхождение не в счёт. Край есть, только
  // если набор подрезан упором или обе серии уходят за горизонт.
  const cut = cutoffMs ?? window.toMs;
  const edge = cutoffMs !== undefined || (continues.before && continues.after) ? cut - EDGE_MS : Infinity;

  compare(ctx, beforeSet, afterSet, edge);
  checkTransition(ctx, before, plan, continues);
  checkEmptiness(ctx, plan, beforeSet, afterSet, continues);
  findings.throwIfAny();
}

// ─────────────────────────────── контекст ───────────────────────────────

class Findings {
  readonly list: GuardProblem[] = [];

  add(code: GuardCode, message: string): void {
    this.list.push({ code, message });
  }

  /** Проблема, после которой сверять нечего. */
  fail(code: GuardCode, message: string): never {
    this.add(code, message);
    throw new GuardError(this.list);
  }

  throwIfAny(): void {
    if (this.list.length > 0) throw new GuardError(this.list);
  }
}

interface Ctx {
  env: IcalEnv;
  expect: Expectation;
  before: CalendarObject;
  findings: Findings;
  nowMs: number;
  patch?: EventPatch;
  /** Поля патча, которые план вправе применять; у удаления — ни одного. */
  fields: ReadonlySet<PatchField>;
  /** Патч называет время: start, end, timeZone или allDay. */
  time: boolean;
  /** Патч называет повтор: слоты задаёт новое правило, и простые слоты не сверяются. */
  recurrence: boolean;
  /** План удаляет объект целиком: всё, что в нём осталось, — это «не пуст», а не «пропало». */
  deleting: boolean;
  /** Ключи, объявленные убранными: `expect.removed` и адреса ответа `plan.removed`. */
  named: ReadonlySet<SlotKey>;
  /** Ключ адресован целью удаления в этом scope. */
  targeted(key: SlotKey): boolean;
  /** Прежний ключ → ключ после записи (`expect.keyMap`); сбой — прежний ключ. */
  mapKey(key: SlotKey): SlotKey;
  /** Компоненты, отмеченные планом в `touched`, по опознанию. */
  touched: ReadonlySet<string>;
}

function makeContext(before: CalendarObject, plan: WritePlan, env: IcalEnv, findings: Findings, options: GuardOptions): Ctx {
  const expect = plan.expect;
  const patch = expect.op === "delete" ? undefined : options.patch;
  const fields = allowedFields(expect, patch);
  const boundary = plan.kind === "split" ? expect.target ?? plan.boundary : undefined;

  const named = new Set<SlotKey>(expect.removed);
  for (const loss of plan.removed) {
    try {
      named.add(parseAddress(before, loss.instanceStart));
    } catch {
      // Строка без разбираемого адреса ничего не называет.
    }
  }

  const target = expect.target;
  const targeted = (key: SlotKey): boolean => {
    if (expect.op !== "delete") return false;
    if (expect.scope === "all_series") return true;
    if (target === undefined) return false;
    if (expect.scope === "this") return key === target;
    return key[0] === target[0] && compareSlotKeys(key, target) >= 0;
  };

  const touched = new Set<string>();
  for (const [component, names] of expect.touched.names) {
    if (names.size > 0) touched.add(identityOf(component));
  }
  for (const component of expect.touched.components) touched.add(identityOf(component));

  const mapped = new Map<SlotKey, SlotKey>();
  const mapKey = (key: SlotKey): SlotKey => {
    if (!expect.keyMap) return key;
    // У разреза ключи раньше границы остаются в исходной серии как были.
    if (boundary !== undefined && key[0] === boundary[0] && compareSlotKeys(key, boundary) < 0) return key;
    const known = mapped.get(key);
    if (known !== undefined) return known;
    let image = key;
    try {
      const value: unknown = expect.keyMap(key);
      if (typeof value === "string" && /^[DTF]:/.test(value)) image = value as SlotKey;
    } catch {
      // Ключ, которого keyMap не знает, ищется под прежним адресом.
    }
    mapped.set(key, image);
    return image;
  };

  return {
    env,
    expect,
    before,
    findings,
    nowMs: nowOf(options),
    patch,
    fields,
    time: TIME_FIELDS.some((field) => fields.has(field)),
    recurrence: fields.has("recurrence"),
    deleting: plan.kind === "delete-object",
    named,
    targeted,
    mapKey,
    touched,
  };
}

/**
 * Поля, которые план вправе применять: у удаления — ни одного; с патчем из
 * оркестрации — только те, что в патче есть (лишнее поле в `expect.fields`
 * ослабило бы сверку — лишний `recurrence` освободил бы все слоты); без
 * патча — слово плана.
 */
function allowedFields(expect: Expectation, patch: EventPatch | undefined): ReadonlySet<PatchField> {
  if (expect.op === "delete") return new Set();
  if (patch === undefined) return expect.fields;
  return new Set([...expect.fields].filter((field) => Object.hasOwn(patch, field) && patch[field] !== undefined));
}

function nowOf(options: GuardOptions): number {
  const now = options.now;
  if (now === undefined) return Date.now();
  return typeof now === "number" ? now : now.getTime();
}

// ─────────────────────────────── дерево ПОСЛЕ ───────────────────────────────

/** Объект после записи: что план собирается положить на сервер. */
interface Side {
  o: CalendarObject;
  label: string;
  /** UID, который у него обязан быть. */
  uid: string;
  /**
   * План отмечает компоненты этого объекта в `touched`. У продолжения
   * разреза все компоненты новые и в `touched` их нет: сверяются только поля.
   */
  tracked: boolean;
}

function writtenSides(ctx: Ctx, plan: WritePlan): Side[] {
  switch (plan.kind) {
    case "delete-object":
      return [];
    case "put":
      return [{ o: written(ctx, plan.ics, "записываемый объект"), label: "после записи", uid: ctx.before.uid, tracked: true }];
    case "split": {
      if (plan.continuation.uid === ctx.before.uid) {
        ctx.findings.add("invariant", "UID продолжения совпадает с UID исходной серии: две серии с одним UID.");
      }
      return [
        { o: written(ctx, plan.truncated.ics, "усечённый исходный объект"), label: "в усечённой серии", uid: ctx.before.uid, tracked: true },
        { o: written(ctx, plan.continuation.ics, "продолжение"), label: "в продолжении", uid: plan.continuation.uid, tracked: false },
      ];
    }
    default:
      return [];
  }
}

function written(ctx: Ctx, ics: string, label: string): CalendarObject {
  const loaded = loadObject(ics, ctx.env);
  if (isUnparsable(loaded)) ctx.findings.fail("unparsable", `${capital(label)} не разбирается: ${loaded.error}`);
  return loaded;
}

/** UID объекта не менялся, компонентов с чужим UID не появилось. */
function checkUids(ctx: Ctx, sides: readonly Side[]): void {
  for (const side of sides) {
    const uids = [...new Set(side.o.root.getAllSubcomponents("vevent").map((event) => String(event.getFirstPropertyValue("uid") ?? "")))];
    if (uids.length !== 1 || uids[0] !== side.uid) {
      ctx.findings.add("invariant", `${capital(side.label)}: UID ${uids.join(", ") || "—"} вместо ${side.uid}.`);
    }
  }
}

/** Запись, тождественная прочитанному тексту: план объявил правку, а не меняется ничего. */
function checkRewrite(ctx: Ctx, plan: WritePlan, sides: readonly Side[]): void {
  if (plan.kind !== "put" || sides.length !== 1) return;
  if (serializeObject(sides[0].o) !== serializeObject(ctx.before)) return;
  ctx.findings.add(
    "plan-shape",
    `План записывает объект слово в слово тем же, каким прочитал (${ctx.expect.op} ${ctx.expect.scope}): ` +
      "ответ объявил бы правку, которой не было. Ничего не менять — это пустой план.",
  );
}

// ─────────────────────────────── горизонт ───────────────────────────────

interface Window {
  fromMs: number;
  toMs: number;
}

/**
 * Окно разворота: от меньшего DTSTART обеих сторон (и раньше, если явный
 * адрес раньше него) до позднейшего из конца конечной серии, позднейшего
 * явного значения и «сейчас + 2 года».
 */
function windowOf(ctx: Ctx, objects: readonly CalendarObject[]): Window {
  let fromMs = Infinity;
  let toMs = -Infinity;
  for (const o of objects) {
    for (const event of o.root.getAllSubcomponents("vevent")) {
      const dtstart = event.getFirstPropertyValue("dtstart") as ICAL.Time | null;
      if (dtstart) fromMs = Math.min(fromMs, instantOf(dtstart, ctx.env));
    }
    for (const key of explicitKeys(o)) {
      const ms = keyMs(key, ctx.env);
      fromMs = Math.min(fromMs, ms);
      toMs = Math.max(toMs, ms + DAY_MS);
    }
    // Конец конечной серии — только пока она короче упора: длинную всё равно
    // подрежет набор, а разворачивать её до конца незачем.
    const extent = seriesExtent(o, MEETINGS_CAP);
    if (extent.kind === "finite" && extent.last) toMs = Math.max(toMs, instantOf(extent.last.time, ctx.env) + DAY_MS);
  }
  if (!Number.isFinite(fromMs)) fromMs = ctx.nowMs;
  toMs = Math.max(toMs, Math.max(ctx.nowMs, fromMs) + HORIZON_YEARS * YEAR_MS);
  return { fromMs, toMs };
}

function explicitKeys(o: CalendarObject): SlotKey[] {
  const keys: SlotKey[] = [...o.overrides.keys()];
  if (o.master) keys.push(...listKeys(o.master, "exdate", o), ...listKeys(o.master, "rdate", o));
  return keys;
}

/** Момент ключа: T — секунды; D и F — стенное время в поясе календаря. */
function keyMs(key: SlotKey, env: IcalEnv): number {
  if (key.startsWith("T:")) return Number(key.slice(2)) * 1000;
  try {
    return instantOf(parseModelTime(key.slice(2)).time, env);
  } catch {
    return Number.NaN;
  }
}

/**
 * Проба за концом горизонта: есть ли у серии встречи дальше него. Так
 * бесконечность распознаётся разворотом, а не чтением COUNT и UNTIL.
 * Ближняя проба ловит обычные частоты, дальняя — редкие (YEARLY;INTERVAL=5).
 * Оторванные встречи не в счёт: их адреса горизонт и так покрывает, а серию
 * они не продолжают.
 */
function continuesBeyond(o: CalendarObject, toMs: number): boolean {
  const near = toMs + PROBE_NEAR_MS;
  return probe(o, toMs, near) || probe(o, near, toMs + PROBE_FAR_MS);
}

function probe(o: CalendarObject, fromMs: number, toMs: number): boolean {
  try {
    return occurrencesOf(o, fromMs, toMs, META, o.env).some((event) => event.detached !== true);
  } catch {
    return true; // серию не перебрать — считаем, что она продолжается
  }
}

// ─────────────────────────────── набор встреч ───────────────────────────────

/** Запись набора: видимая встреча или скрытое переопределение. */
interface Rec {
  key: SlotKey;
  /** Адрес для сообщений (формат Р10). */
  addr: string;
  /** Момент адреса — для подрезки набора и края горизонта. */
  ms: number;
  /** Встречи нет: переопределение под EXDATE или вне протяжённости серии. */
  hidden: boolean;
  /** У встречи свой компонент (переопределение или оторванная). */
  own: boolean;
  detached: boolean;
  /** Подпись времени: начало, конец и всесуточность (у скрытой — её собственные значения). */
  time: string;
  /** Видимые поля. */
  fields: Readonly<Record<string, string>>;
  /** Откуда запись взялась после записи; у прочитанного объекта — undefined. */
  side?: Side;
}

function recordsOf(ctx: Ctx, o: CalendarObject, window: Window, label: string, side: Side | undefined): Map<SlotKey, Rec> {
  const records = new Map<SlotKey, Rec>();
  let events: CalendarEvent[];
  try {
    events = occurrencesOf(o, window.fromMs, window.toMs, META, o.env);
  } catch (error) {
    ctx.findings.fail("series-too-long", `${capital(label)}: встречи не развернуть (${messageOf(error)}) — план не сверить.`);
  }
  for (const event of events) {
    const reason = unreadableReason(event);
    if (reason) ctx.findings.fail("series-too-long", `${capital(label)}: встречи не прочитаны целиком (${reason}) — план не сверить.`);
    const rec = visibleRecord(ctx, o, event, side);
    if (records.has(rec.key)) ctx.findings.add("meeting-added", `${capital(label)}: две встречи с одним адресом ${rec.addr}.`);
    else records.set(rec.key, rec);
  }
  for (const [key, refs] of o.overrides) {
    if (o.roles.get(refs[0].component)?.role !== "hidden" || records.has(key)) continue;
    records.set(key, hiddenRecord(ctx, o, key, refs, side));
  }
  return records;
}

function visibleRecord(ctx: Ctx, o: CalendarObject, event: CalendarEvent, side: Side | undefined): Rec {
  const addr = event.instanceStart ?? event.start;
  const key = keyOfAddress(o, addr);
  return {
    key,
    addr,
    ms: instantMs(event.start, ctx.env),
    hidden: false,
    own: o.overrides.has(key),
    detached: event.detached === true,
    time: `${event.start}—${event.end}${event.allDay ? " (весь день)" : ""}`,
    fields: {
      summary: event.summary,
      description: event.description ?? "",
      location: event.location ?? "",
      attendees: attendeesKey(event.attendees),
      status: event.status ?? "",
    },
    side,
  };
}

/**
 * Скрытое переопределение: встречи у него нет, поэтому время — его
 * собственные значения как записаны, а поля — свои (унаследованного у него
 * не бывает: встречи нет). Сравнивается оно только со скрытым: при смене
 * роли содержимое не сверяется, сверяется сама смена.
 */
function hiddenRecord(ctx: Ctx, o: CalendarObject, key: SlotKey, refs: readonly OverrideRef[], side: Side | undefined): Rec {
  const c = refs[0].component;
  return {
    key,
    addr: refs[0].recurrenceId.toString(),
    ms: keyMs(key, ctx.env),
    hidden: true,
    own: true,
    detached: false,
    time: JSON.stringify(["dtstart", "dtend", "duration"].map((name) => c.getAllProperties(name).map((property) => property.jCal))),
    fields: componentFields(c),
    side,
  };
}

function componentFields(c: ICAL.Component): Readonly<Record<string, string>> {
  const attendees = c.getAllProperties("attendee").map((property) => {
    const address = String(property.getFirstValue() ?? "").replace(/^mailto:/i, "").toLowerCase();
    return `${address}=${String(property.getParameter("partstat") ?? "").toLowerCase()}`;
  });
  return {
    summary: String(c.getFirstPropertyValue("summary") ?? ""),
    description: String(c.getFirstPropertyValue("description") ?? ""),
    location: String(c.getFirstPropertyValue("location") ?? ""),
    attendees: [...attendees].sort().join(", "),
    status: String(c.getFirstPropertyValue("status") ?? "").toLowerCase(),
  };
}

function attendeesKey(attendees: readonly Attendee[]): string {
  return attendees.map((attendee) => `${attendee.email.toLowerCase()}=${attendee.status}`).sort().join(", ");
}

/**
 * Ключ опознания адреса в форме своего объекта (О3): у серии на весь день —
 * дата, как бы ни было записано значение (Ж4: `VALUE=DATE` и DATE-TIME дают
 * один ключ), у серии со временем — момент. Неразбираемый адрес остаётся
 * собой: такая встреча просто не найдёт пары.
 */
function keyOfAddress(o: CalendarObject, addr: string): SlotKey {
  try {
    return parseAddress(o, addr);
  } catch {
    return `F:${addr}` as SlotKey;
  }
}

function instantMs(iso: string, env: IcalEnv): number {
  try {
    const parsed = parseModelTime(iso);
    return instantOf(parsed.time, env);
  } catch {
    return Number.NaN;
  }
}

/**
 * Упор набора: если с какой-то стороны встреч больше {@link MEETINGS_CAP},
 * обе стороны подрезаются по одному и тому же моменту — иначе хвост одной
 * стороны выглядел бы пропажей или лишними встречами. Возвращает этот
 * момент или undefined, если подрезать не пришлось.
 */
function trim(before: Map<SlotKey, Rec>, after: Map<SlotKey, Rec>): number | undefined {
  if (before.size <= MEETINGS_CAP && after.size <= MEETINGS_CAP) return undefined;
  const cut = (records: Map<SlotKey, Rec>): number => {
    const times = [...records.values()].map((rec) => rec.ms).filter(Number.isFinite).sort((a, b) => a - b);
    return times.length > MEETINGS_CAP ? times[MEETINGS_CAP - 1] : Infinity;
  };
  const cutoff = Math.min(cut(before), cut(after));
  for (const records of [before, after]) {
    for (const [key, rec] of records) {
      if (rec.ms > cutoff) records.delete(key);
    }
  }
  return cutoff;
}

// ─────────────────────────────── разность ───────────────────────────────

/**
 * Разность наборов. Каждая прежняя встреча ищет себя после записи по своему
 * ключу (через `keyMap`); что не нашлось — исчезло, что не досталось никому —
 * появилось, что нашлось — сверяется полями.
 *
 * При смене повтора простые слоты (без своего компонента) не участвуют вовсе:
 * их задаёт новое правило, и спорить об их составе — значит повторять
 * планировщик. Встречи со своим компонентом сверяются и тогда.
 */
function compare(ctx: Ctx, before: Map<SlotKey, Rec>, after: Map<SlotKey, Rec>, edgeMs: number): void {
  const lost: string[] = [];
  const ownLost: string[] = [];
  const hiddenLost: string[] = [];
  const kept: string[] = [];
  const added: string[] = [];
  const consumed = new Set<SlotKey>();

  const ordered = (records: Map<SlotKey, Rec>) => [...records.values()].sort((a, b) => compareSlotKeys(a.key, b.key));

  for (const rec of ordered(before)) {
    if (ctx.recurrence && !rec.own) continue;
    const options = rec.detached || rec.hidden ? [rec.key, ctx.mapKey(rec.key)] : [ctx.mapKey(rec.key)];
    const found = options.find((option) => after.has(option) && !consumed.has(option));
    const removalNamed = ctx.named.has(rec.key) || ctx.targeted(rec.key);
    if (found === undefined) {
      if (removalNamed || rec.ms >= edgeMs) continue;
      if (rec.hidden) hiddenLost.push(rec.addr);
      else if (rec.own) ownLost.push(rec.addr);
      else lost.push(rec.addr);
      continue;
    }
    consumed.add(found);
    const now = after.get(found)!;
    if (removalNamed && !now.hidden) {
      kept.push(rec.addr);
      continue;
    }
    compareRecord(ctx, rec, now);
  }

  for (const rec of ordered(after)) {
    if (consumed.has(rec.key) || (ctx.recurrence && !rec.own) || rec.hidden) continue;
    if (rec.ms >= edgeMs) continue;
    // Встреча на ключе, объявленном убранным, — воскрешение: её убирали, а
    // она стоит. Такое не оправдывает и смена повтора.
    if (ctx.named.has(rec.key) || ctx.targeted(rec.key)) {
      kept.push(rec.addr);
      continue;
    }
    // Патч, меняющий повтор, вправе назначить новые встречи: какие именно —
    // дело правила, а не предохранителя.
    if (ctx.recurrence) continue;
    added.push(rec.addr);
  }

  const { findings } = ctx;
  if (ctx.deleting) {
    // Удаление объекта целиком: всё, что осталось живого, — довод против
    // удаления, а не пропажа (Р3: удаляется опустевший объект).
    const alive = [...lost, ...ownLost, ...hiddenLost];
    if (alive.length) {
      findings.add("not-empty", `План удаляет объект целиком, а в нём остаются ${listed(alive)}: удалять можно только опустевший объект (Р3).`);
    }
  } else {
    if (lost.length) findings.add("meeting-lost", `Пропали встречи ${listed(lost)}: после записи их нет, а план их не убирал.`);
    if (ownLost.length) findings.add("override-lost", `Пропали встречи со своим компонентом ${listed(ownLost)}: план их не убирал.`);
    if (hiddenLost.length) {
      findings.add("override-lost", `Молча выброшены скрытые переопределения ${listed(hiddenLost)}: это данные пользователя, снять их можно только назвав (О11).`);
    }
  }
  if (kept.length) findings.add("meeting-added", `Встречи ${listed(kept)} названы убранными, а после записи остались.`);
  if (added.length) findings.add("meeting-added", `Лишние встречи после записи: ${listed(added)} — их не было, и патч их не просил.`);
}

/** Пара нашлась: расхождение обязано лежать внутри названного патчем. */
function compareRecord(ctx: Ctx, was: Rec, now: Rec): void {
  const { findings } = ctx;
  if (was.hidden !== now.hidden) {
    // Смену роли оправдывает только новое правило: скрытое получило слот или
    // слот ушёл за конец серии. Содержимое при этом не сверяется — у встречи
    // и у следа удаления оно разное по природе.
    if (!ctx.recurrence) {
      if (was.hidden) findings.add("meeting-added", `Скрытое переопределение ${was.addr} после записи стало встречей, а патч повтора не менял.`);
      else findings.add("meeting-lost", `Встреча ${was.addr} после записи спрятана (её компонент вне серии), а план её не убирал.`);
    }
    return;
  }
  if (was.own && !now.own) {
    findings.add("override-lost", `Встреча ${was.addr} потеряла свой компонент: её время и поля вернулись к основному.`);
  }
  const changes: string[] = [];
  if (was.time !== now.time) {
    changes.push("время");
    // Время свободно ровно тогда, когда патч называет start, end, timeZone
    // или allDay: какое именно время получилось — дело планировщика.
    if (!ctx.time) findings.add("time-changed", `Время встречи ${was.addr} изменено (${was.time} → ${now.time}), а патч времени не называл.`);
  }
  for (const field of SNAPSHOT) {
    if (was.fields[field.name] === now.fields[field.name]) continue;
    changes.push(field.label);
    if (field.field !== undefined && ctx.fields.has(field.field)) continue;
    findings.add(
      "untouched-changed",
      `У встречи ${was.addr} изменено поле «${field.label}» (${quoted(was.fields[field.name])} → ${quoted(now.fields[field.name])}), ` +
        "а патч его не называл.",
    );
  }
  if (changes.length > 0 && !touchedAt(ctx, now)) {
    findings.add(
      "untouched-changed",
      `У встречи ${was.addr} изменено (${changes.join(", ")}), а план её компонент в touched не отметил: правка, которой план не заявлял.`,
    );
  }
}

/**
 * План отметил в `touched` компонент, который отвечает за эту встречу, — её
 * переопределение или основной компонент (от него встреча берёт поля и
 * время слота). У продолжения разреза компоненты новые и в `touched` их нет:
 * там сверяются только поля.
 */
function touchedAt(ctx: Ctx, rec: Rec): boolean {
  const side = rec.side;
  if (!side || !side.tracked) return true;
  const candidates: ICAL.Component[] = [];
  for (const ref of side.o.overrides.get(rec.key) ?? []) candidates.push(ref.component);
  if (side.o.master) candidates.push(side.o.master);
  return candidates.some((component) => ctx.touched.has(identityOf(component)));
}

/** Опознание компонента в дереве: имя, UID и RECURRENCE-ID как записаны (как их отмечает план). */
function identityOf(c: ICAL.Component): string {
  const uid = String(c.getFirstPropertyValue("uid") ?? "");
  const rid = c.getFirstProperty("recurrence-id");
  if (!rid) return `${c.name}|${uid}|`;
  return `${c.name}|${uid}|${JSON.stringify(rid.jCal[3])}|${String(rid.getParameter("tzid") ?? "")}`;
}

// ─────────────────────────────── сверх разности ───────────────────────────────

/**
 * Переход «серия кончалась ↔ серия не кончается». Встречами он не
 * выражается: конец лежит за горизонтом. Законен он, только если патч назвал
 * `count`, `until` или `replace`, либо (в сторону бесконечности) если до
 * записи правила не было вовсе: одиночное событие и серия из одних RDATE
 * получают первое правило законно. Усечение (delete this_and_following) и
 * удаление кончают серию по самой просьбе.
 */
function checkTransition(ctx: Ctx, before: CalendarObject, plan: WritePlan, continues: { before: boolean; after: boolean }): void {
  if (plan.kind === "delete-object" || continues.before === continues.after) return;
  const rp = ctx.patch?.recurrence;
  const asked = rp !== undefined && (named(rp, "count") || named(rp, "until") || rp.replace === true);
  if (asked) return;
  // Без патча из оркестрации у правки судить не о чем: что просил
  // пользователь, предохранителю неизвестно (GuardOptions.patch).
  if (ctx.expect.op === "update" && ctx.patch === undefined) return;
  if (!continues.before) {
    if (!hasRule(before)) return; // первое правило: до записи правила не было вовсе
    ctx.findings.add(
      "extent-mismatch",
      "Серия кончалась, а после записи не кончается: конец правила снимается только по просьбе (count, until, replace).",
    );
    return;
  }
  if (ctx.expect.op === "delete") return; // усечение и удаление кончают серию по просьбе
  ctx.findings.add("extent-mismatch", "Серия не кончалась, а после записи кончается: конец правила ставится только по просьбе (count, until, replace).");
}

function named(rp: RecurrencePatch, field: "count" | "until"): boolean {
  return Object.hasOwn(rp, field) && rp[field] !== undefined;
}

function hasRule(o: CalendarObject): boolean {
  return o.master !== null && o.master.getAllProperties("rrule").length > 0;
}

/**
 * Пустота объекта: удалять целиком можно всю серию или объект, в котором
 * после названных удалений встреч не осталось; и наоборот — запись, после
 * которой живых встреч нет, это удаление объекта, а не put зомби (Р3).
 */
function checkEmptiness(
  ctx: Ctx,
  plan: WritePlan,
  before: Map<SlotKey, Rec>,
  after: Map<SlotKey, Rec>,
  continues: { before: boolean; after: boolean },
): void {
  const live = (records: Map<SlotKey, Rec>) => [...records.values()].filter((rec) => !rec.hidden).length;
  if (plan.kind === "delete-object") {
    const { scope, target } = ctx.expect;
    // Что осталось живого, разность уже назвала (набор ПОСЛЕ пуст). Сверх
    // того: за горизонтом встречи тоже есть, если серия туда уходит и цель
    // удаления её там не покрывает.
    if (continues.before && !(scope === "this_and_following" && target !== undefined)) {
      ctx.findings.add(
        "not-empty",
        `План удаляет объект целиком (${ctx.expect.op} ${scope}), а серия продолжается за горизонтом проверки: там остаются встречи.`,
      );
    }
    return;
  }
  if (live(after) === 0 && !continues.after && live(before) > 0) {
    ctx.findings.add("empty-left", "Запись оставляет объект без живых встреч: такой объект удаляется целиком (Р3), а не записывается.");
  }
}

// ─────────────────────────────── мелочи ───────────────────────────────

function listed(items: readonly string[]): string {
  if (items.length <= LIST_LIMIT) return items.join(", ");
  return `${items.slice(0, LIST_LIMIT).join(", ")} и ещё ${items.length - LIST_LIMIT}`;
}

function quoted(value: string): string {
  return value === "" ? "пусто" : `«${value}»`;
}

function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
