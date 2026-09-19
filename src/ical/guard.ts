import ICAL from "ical.js";
import { parseAddress } from "./instances.js";
import {
  blockingAnomalies,
  isUnparsable,
  loadObject,
  serializeObject,
  type CalendarObject,
  type OverrideRef,
} from "./object.js";
import type { EventPatch, Expectation, PatchField, WritePlan } from "./plan.js";
import { SERIES_CAP, SlotScanError, findSlot, iterateSlots, type Slot } from "./slots.js";
import {
  compareSlotKeys,
  formOf,
  formatForModel,
  instantOf,
  listKeys,
  parseModelTime,
  slotKeyOf,
  timeInForm,
  wallDateOf,
  type IcalEnv,
  type SlotKey,
} from "./values.js";

/**
 * Независимый предохранитель записи (О12 а–д плана переделки,
 * docs/superpowers/plans/2026-09-19-recurring-events-rework.md, задача З11).
 *
 * Последняя линия перед необратимой записью: `verifyPlan` сверяет план с
 * объектом, который сервер отдал в этом же вызове, и бросает `GuardError`,
 * если запись испортит данные. Он написан независимо от планировщика
 * (edit.ts) и не повторяет его логику: заново разбирает прочитанный текст и
 * текст плана и проверяет результат через модель объекта (object.ts),
 * слоты (slots.ts) и ожидание плана (plan.ts). Если планировщик ошибётся,
 * предохранитель ловит это своими проверками:
 *
 * - (а) инварианты записываемого объекта: не больше одного основного
 *   компонента и один UID, нет новых дублей RECURRENCE-ID и EXDATE, на
 *   каждый TZID есть VTIMEZONE, RECURRENCE-ID, EXDATE, RDATE и UNTIL — в
 *   форме DTSTART (О4), DTEND позже DTSTART, нет DTEND вместе с DURATION
 *   (RFC 5545 §3.6.1), аномалий не больше, чем было. UNTIL раньше DTSTART
 *   отдельно не проверяется: такое правило не даёт ни одной позиции, и
 *   loadObject отмечает его новой аномалией no-positions (slots.ts,
 *   probeRules);
 * - (б) всё, что правка не тронула, — прежнее, до параметра и значения
 *   (сравнение по jCal). Изменённое должно быть и отмечено в
 *   `expect.touched`, и допустимо для операции и полей патча — отметки
 *   планировщика мало: правка заголовка не может менять EXDATE, а правка
 *   одной встречи — основной компонент. Чужие VALARM (не DISPLAY и EMAIL со
 *   сдвигом от начала, О9) не меняются никогда. Свойства VCALENDAR и
 *   прочитанные VTIMEZONE не меняются никогда — так ловится пересборка
 *   объекта из доменной модели. Внутри разрешённого свойства тоже не всё
 *   можно: правка без recurrence меняет в RRULE только конец (UNTIL,
 *   COUNT), у оставшихся участников — только PARTSTAT (О9). Поля
 *   переопределений — по О7: своё значение (не равное прежнему основному)
 *   остаётся, унаследованное следует за новым основным (у скрытого —
 *   только своё значение: встречи у него нет). Время клона и основного
 *   продолжения, когда патч времени не трогает, — по О6: начало на слоте
 *   (у продолжения — на B, и при смене повтора), длительность основного; у
 *   цели правки и у основного при `start` без `end` — прежняя
 *   длительность (О8);
 * - (в) видимые встречи после записи — прежние через `keyMap` минус
 *   `removed`: ни одна не пропала и не появилась, переопределение осталось
 *   переопределением, EXDATE не снят; без правки повтора даты встреч
 *   прежние (Р1: из `start` берётся только время суток — даже если план не
 *   поднял `datesFixed`); перенесённая встреча стоит, где стояла, а
 *   неперенесённая идёт за серией (О7). При смене повтора RDATE прежние, а
 *   новых EXDATE нет (таблица §3). Горизонт — от первого слота до
 *   max(сейчас, цель, последний явный ключ) + 400 дней и ещё 5 видимых
 *   слотов (О12в); явные ключи — RECURRENCE-ID, EXDATE и RDATE обеих
 *   сторон, поэтому все явные значения внутри горизонта. Сверяются все
 *   встречи от первого слота; перебор ограничен SERIES_CAP (200 000
 *   слотов), как у планировщика. «Окно от цели − 400 дней» из О12в здесь не
 *   нужно: итератор ical.js всё равно идёт от DTSTART, а сверка лёгких
 *   записей дешевле самого перебора — окно только ослабило бы проверку.
 *   Запасной путь для серий длиннее предела — правка, не трогающая
 *   DTSTART, RRULE, RDATE, EXDATE и EXRULE основного: слоты у неё те же по
 *   построению, и переопределения сверяются по ключу без прохода;
 * - `removed` ограничен операцией, а не словом планировщика: у update без
 *   recurrence и у update this — пусто; у delete this — цель и скрытые; у
 *   delete t&f — ключи от B; у смены повтора — переопределения; у усечения
 *   ещё оторванные встречи, которые оно прячет за конец серии. Встреча,
 *   снятая сверх названной цели (перенесённая раньше B, спрятанная
 *   усечением, переопределение без пары в новом правиле), обязана быть и в
 *   ответе `plan.removed` (О11);
 * - (г) `delete-object` при scope ≠ all_series — только если после
 *   удаления названных встреч в объекте не осталось ни одной живой: полным
 *   проходом, без горизонта (Р3). Встреча с RECURRENCE-ID от B, перенесённая
 *   раньше B, — встреча до границы: снять её можно, только назвав;
 * - (д) протяжённость конечной серии — полным проходом (без горизонта):
 *   без правки повтора число позиций и последняя встреча прежние (через
 *   `keyMap`), с правкой — равны `expect.tail`; усечение (t&f) даёт ровно
 *   слоты до границы; продолжение разреза — ровно прежний хвост. Длиннее
 *   предела прохода — отказ `series-too-long`.
 *
 * Видимость встречи — та же, что в instances.ts (visibleMap): незакрытый
 * слот (со своим переопределением или без) или оторванное переопределение;
 * она читается прямо из ролей object.ts и перебора slots.ts. visibleMap не
 * используется: он строит полную встречу (Instance) на каждый слот, а
 * предохранителю нужны только адрес, дата адреса и наличие своего
 * компонента. На DAILY из 20 000 позиций visibleMap стоит около 0,5 с,
 * перебор слотов — около 0,1 с. Из instances.ts берётся только разбор
 * адреса (`parseAddress`) — для строк ответа `plan.removed`.
 *
 * Пояс процесса не участвует: моменты — через values.ts (`instantOf`,
 * `slotKeyOf`), без Date от полей и без перевода ICAL.Time в Date.
 *
 * Известный дефект ключей повторного осеннего часа (values.ts: ical.js
 * читает неоднозначное стенное время как второе вхождение, RFC 5545 — как
 * первое) здесь не исправляется и не маскируется: ключи сравниваются как
 * есть.
 */

// ─────────────────────────────── ошибка ───────────────────────────────

/**
 * Код проблемы, которой предохранитель остановил запись:
 * - `plan-shape` — план не отвечает операции (правка удаляет объект, разрез
 *   у удаления, пустой план с убранными встречами, нет границы у t&f,
 *   «эта и следующие» одним put при встречах до границы, `keyMap` бросил на
 *   ключе слота, `removed` шире операции, потеря сверх цели не названа в
 *   `plan.removed`, поля у удаления или поля вне патча, удаление одиночного
 *   события записью);
 * - `unparsable` — прочитанный или записываемый текст не разобран;
 * - `blocked` — у объекта аномалия, запрещающая эту запись (О14);
 * - `invariant` — нарушен инвариант О12а;
 * - `untouched-changed` — изменено то, что правка не тронула или менять не
 *   может, снят или добавлен компонент без права на это (О12б);
 * - `alarm-lost` — снят или изменён чужой VALARM (О9);
 * - `meeting-lost` — видимая встреча пропала (или слилась с другой);
 * - `meeting-added` — появилась встреча, которой не было, или осталась та,
 *   что названа убранной;
 * - `exdate-lifted` — снят EXDATE: удалённая встреча воскресла;
 * - `override-lost` — потеряно переопределение: встреча вернулась к
 *   основному компоненту или компонент снят;
 * - `date-shifted` — дата встречи сдвинулась, когда даты должны остаться;
 * - `moved-shifted` — перенесённая встреча сдвинута, или неперенесённая
 *   отстала от серии (О7);
 * - `time-changed` — у клона основного или у основного продолжения начало
 *   не на слоте или длительность не та, хотя патч время не трогает (О6, О8);
 * - `override-field-lost` — своё значение поля переопределения (не равное
 *   прежнему основному) затёрто правкой серии (О7);
 * - `override-field-stale` — поле переопределения, равное прежнему
 *   основному, не последовало за новым (О7);
 * - `not-empty` — `delete-object` при живых встречах;
 * - `empty-left` — запись оставляет пустой объект вместо его удаления (Р3);
 * - `extent-mismatch` — протяжённость конечной серии не та (О12д);
 * - `truncation-mismatch` — усечённая серия не равна прежним слотам до границы;
 * - `series-too-long` — серия длиннее предела прохода, план не проверить.
 */
export type GuardCode =
  | "plan-shape"
  | "unparsable"
  | "blocked"
  | "invariant"
  | "untouched-changed"
  | "alarm-lost"
  | "meeting-lost"
  | "meeting-added"
  | "exdate-lifted"
  | "override-lost"
  | "date-shifted"
  | "moved-shifted"
  | "time-changed"
  | "override-field-lost"
  | "override-field-stale"
  | "not-empty"
  | "empty-left"
  | "extent-mismatch"
  | "truncation-mismatch"
  | "series-too-long";

export interface GuardProblem {
  readonly code: GuardCode;
  /** По-русски, с адресами встреч в формате Р10. */
  readonly message: string;
}

/**
 * Предохранитель остановил запись. `code` — код первой проблемы,
 * `problems` — все найденные. Это не отказ пользователю, а ошибка плана:
 * запись не выполняется, объект на сервере не тронут.
 */
export class GuardError extends Error {
  readonly code: GuardCode;
  readonly problems: readonly GuardProblem[];

  constructor(problems: readonly GuardProblem[]) {
    super(
      `Предохранитель остановил запись: план испортил бы событие. ${problems.map((p) => `[${p.code}] ${p.message}`).join(" ")}`,
    );
    this.name = "GuardError";
    this.code = problems[0].code;
    this.problems = problems;
  }
}

export interface GuardOptions {
  /** «Сейчас» для горизонта О12в, мс Unix или Date; по умолчанию — системные часы. */
  now?: number | Date;
  /**
   * Патч update_event, из которого построен план, — как его передала
   * оркестрация (З13), а не планировщик. С ним `expect.fields` сверяются с
   * патчем: план не может применять поле, которого в патче нет (лишнее поле
   * ослабило бы проверки — например, лишний recurrence разрешил бы трогать
   * RRULE). Без него предохранитель верит `expect.fields`, но и тогда
   * поля у удаления не учитываются, а RDATE, EXDATE и RRULE сверяются
   * независимо от полей.
   *
   * Контракт с оркестрацией (З13): у `op: "update"` патч передаётся всегда.
   * Без него заявленное планировщиком поле отключает проверку молча —
   * лишний `start` в `expect.fields` освобождает время клона и цели (О6,
   * О8), лишний `end` — их конец. Обязательным параметр здесь не сделан,
   * чтобы отказ предохранителя оставался отказом плана, а не вызова: с
   * `op: "delete"` патча нет вовсе.
   */
  patch?: EventPatch;
}

// ─────────────────────────────── пределы ───────────────────────────────

/** Горизонт О12в: дней после max(сейчас, цель, последний явный ключ). */
export const GUARD_HORIZON_DAYS = 400;
/** Видимых слотов сверх горизонта (О12в). */
export const GUARD_EXTRA_SLOTS = 5;

const DAY_MS = 86_400_000;
/** Сколько адресов перечислять в одном сообщении. */
const LIST_LIMIT = 8;

// ─────────────────────────────── вход ───────────────────────────────

/**
 * Проверяет план записи против прочитанного объекта `beforeIcs` (О12). Ничего
 * не возвращает; план, который испортит данные, — `GuardError`.
 *
 * Контракт с планировщиком (plan.ts, `Expectation`):
 * - `target` — ключ цели в форме прочитанного объекта; у t&f — граница B
 *   (у разреза без `target` — `boundary`);
 * - `keyMap` — прежний ключ → ключ после записи; обязан знать ключи слотов
 *   (в том числе закрытых EXDATE), у разреза — только ключи ≥ B. Для
 *   оторванных (detached) и скрытых переопределений и значений EXDATE мимо
 *   слотов сначала ищется пара по прежнему ключу; `keyMap` спрашивается,
 *   только если её нет, и его сбой на таком ключе — не ошибка плана;
 * - `removed` — прежние ключи (до `keyMap`) встреч, которые план убирает.
 *   Он ограничен операцией, шире — `plan-shape`: update без recurrence и
 *   update this — пусто; delete this — цель (она входит и без того) и
 *   скрытые переопределения; delete t&f — ключи ≥ B; смена повтора —
 *   ключи прежних переопределений (у разреза — ≥ B); у усечения (delete t&f
 *   и разрез) ещё оторванные встречи между последним слотом до B и B — их
 *   усечённая серия прячет (роль hidden); delete all_series — что угодно;
 * - `plan.removed` (ответ) — каждая встреча, снятая сверх названной цели,
 *   должна быть там строкой с адресом по Р10: у t&f — встреча с
 *   RECURRENCE-ID от B, перенесённая раньше B (у delete), и спрятанная
 *   усечением оторванная; у смены повтора — видимое переопределение без
 *   пары в новом правиле (О11: такие потери — только с confirm, и
 *   пользователь о них узнаёт). И наоборот: встречи, которую операция не
 *   убирает, там быть не должно — ответ не объявляет удалённым то, что
 *   останется в календаре;
 * - `touched.names` — по компоненту дерева после правки: имена изменённых
 *   свойств и подкомпонентов; `touched.components` — снятые и добавленные
 *   VEVENT. Компоненты сопоставляются по UID и RECURRENCE-ID как записаны;
 * - `tail` — протяжённость конечной серии после записи (у разреза — серии
 *   продолжения): число слотов с закрытыми EXDATE и дата последнего
 *   `YYYY-MM-DD` в поясе серии, как `seriesExtent` (slots.ts).
 */
export function verifyPlan(beforeIcs: string, plan: WritePlan, env: IcalEnv, options: GuardOptions = {}): void {
  const findings: Findings = new Findings();
  const expect = plan.expect;
  checkShape(plan, findings);
  findings.throwIfAny();
  if (plan.kind === "noop") return; // О13: пустой план ничего не пишет
  const fields = checkedFields(expect, options.patch, findings);

  const loaded = loadObject(beforeIcs, env);
  if (plan.kind === "delete-object" && expect.op === "delete" && expect.scope === "all_series") {
    return; // О14: delete all_series не блокируется ничем, в том числе неразобранным текстом (Р4)
  }
  if (isUnparsable(loaded)) {
    findings.fail("unparsable", `Прочитанный объект не разобран (${loaded.error}): записать можно только удаление всей серии.`);
  }
  // Сравнение — с текстом, прошедшим тот же путь, что и план: разбор и вывод
  // ical.js (object.ts, serializeObject). Нормализация библиотеки не выдаётся
  // за правку планировщика.
  const canonical = loadObject(serializeObject(loaded), env);
  const before = isUnparsable(canonical) ? loaded : canonical;
  const ctx = makeContext(before, plan, env, findings, nowOf(options), fields);

  checkBlocking(ctx, plan.kind === "split");
  // Блокирующая аномалия — дальше сверять нечего. Лишнее в removed
  // (makeContext) — не повод остановиться: сверка без него покажет, какие
  // встречи план убрал под его прикрытием.
  if (findings.list.some((problem) => problem.code === "blocked")) findings.throwIfAny();
  checkLossesReported(ctx, plan);
  checkReportedRemovals(ctx, plan);

  switch (plan.kind) {
    case "delete-object":
      checkDeleteObject(ctx);
      break;
    case "put":
      checkPut(ctx, plan.ics);
      break;
    case "split":
      checkSplit(ctx, plan);
      break;
  }
  findings.throwIfAny();
}

// ─────────────────────────────── контекст ───────────────────────────────

class Findings {
  readonly list: GuardProblem[] = [];

  add(code: GuardCode, message: string): void {
    this.list.push({ code, message });
  }

  /** Проблема, после которой проверять дальше нечего. */
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
  /** Поля патча; у удаления — пусто, что бы план ни заявил. */
  fields: ReadonlySet<PatchField>;
  /** Патч меняет время: start, end, timeZone, allDay. */
  time: boolean;
  /** Патч меняет повтор. */
  recurrence: boolean;
  /**
   * Даты встреч обязаны остаться: план так заявил (`datesFixed`), или это
   * удаление, или правка без повтора (Р1: из start берётся только время
   * суток; у t&f дата продолжения — дата B).
   */
  datesMustStay: boolean;
  /** `removed` плана, ограниченный операцией (лишнее — plan-shape и не учитывается). */
  removed: ReadonlySet<SlotKey>;
  /** Операция вправе убрать встречу с этим ключом (та же граница, что у `removed`). */
  removalAllowed(key: SlotKey): boolean;
  /** Чем операция ограничена — для сообщений; пусто у delete all_series. */
  removalRule: string;
  /** Цель (у t&f — граница B), в ключах прочитанного объекта. */
  target?: SlotKey;
  /** Разрез: граница B; ключи раньше неё остаются в исходной серии как есть. */
  boundary?: SlotKey;
  touchedNames: Map<string, Set<string>>;
  touchedComponents: Set<string>;
  /**
   * Прежний ключ слота → ключ после записи по `expect.keyMap` (без него —
   * тот же). У разреза ключи раньше границы не отображаются: они остаются в
   * исходной серии как были. Сбой `keyMap` — plan-shape.
   */
  mapKey(key: SlotKey): SlotKey;
  /**
   * То же для ключа, который может и не быть слотом (detached, hidden,
   * EXDATE мимо слотов): сбой `keyMap` — не ошибка, а «образа нет»
   * (undefined).
   */
  softMapKey(key: SlotKey): SlotKey | undefined;
}

const TIME_FIELDS: readonly PatchField[] = ["start", "end", "timeZone", "allDay"];

function makeContext(
  before: CalendarObject,
  plan: WritePlan,
  env: IcalEnv,
  findings: Findings,
  nowMs: number,
  fields: ReadonlySet<PatchField>,
): Ctx {
  const expect = plan.expect;
  const boundary = plan.kind === "split" ? expect.target ?? plan.boundary : undefined;
  const time = TIME_FIELDS.some((field) => fields.has(field));
  const recurrence = fields.has("recurrence");
  const touchedNames = new Map<string, Set<string>>();
  for (const [component, names] of expect.touched.names) {
    const id = identityOf(component);
    const set = touchedNames.get(id) ?? new Set<string>();
    for (const name of names) set.add(name.toLowerCase());
    touchedNames.set(id, set);
  }
  const touchedComponents = new Set([...expect.touched.components].map(identityOf));

  const mapped = new Map<SlotKey, SlotKey>();
  const failed = new Map<SlotKey, string>();
  let reported = false;
  const tryMap = (key: SlotKey): SlotKey | undefined => {
    if (!expect.keyMap) return key;
    if (boundary !== undefined && sameKind(key, boundary) && compareSlotKeys(key, boundary) < 0) return key;
    const known = mapped.get(key);
    if (known !== undefined) return known;
    if (failed.has(key)) return undefined;
    try {
      const value: unknown = expect.keyMap(key);
      if (typeof value !== "string" || !/^[DTF]:/.test(value)) throw new Error(`вернул ${JSON.stringify(value)}`);
      mapped.set(key, value as SlotKey);
      return value as SlotKey;
    } catch (error) {
      failed.set(key, messageOf(error));
      return undefined;
    }
  };
  const mapKey = (key: SlotKey): SlotKey => {
    const result = tryMap(key);
    if (result !== undefined) return result;
    if (!reported) {
      findings.add("plan-shape", `keyMap плана не отобразил ключ ${key}: ${failed.get(key)}. План нельзя сверить с прочитанным объектом.`);
      reported = true;
    }
    return key;
  };

  const target = expect.target ?? boundary;
  const removal = boundRemoved(before, expect, { recurrence, target, split: plan.kind === "split" }, findings);

  return {
    env,
    expect,
    before,
    findings,
    nowMs,
    fields,
    time,
    recurrence,
    datesMustStay: expect.datesFixed || expect.op === "delete" || !recurrence,
    removed: removal.kept,
    removalAllowed: removal.allowed,
    removalRule: removal.rule,
    target,
    boundary,
    touchedNames,
    touchedComponents,
    mapKey,
    softMapKey: tryMap,
  };
}

/**
 * `removed` плана, ограниченный операцией (таблица §3) — независимо от
 * того, что планировщик счёл убранным:
 * - update без recurrence и update this — ничего: правка встреч не убирает;
 * - смена повтора (all_series, t&f) — только прежние переопределения (без
 *   пары в новом правиле; что пара есть — ловит сверка видимых встреч), у
 *   разреза — с ключом ≥ B; простые слоты задаёт новое правило;
 * - delete this — цель и скрытые переопределения (следы прошлых удалений,
 *   Р3); цель входит и без того;
 * - delete t&f — ключи ≥ B;
 * - delete all_series — что угодно.
 * У усечения (delete t&f и разрез) сверх того — оторванные встречи в
 * промежутке между последним слотом до B и B: усечённая серия кончается
 * раньше их RECURRENCE-ID, и они становятся скрытыми (роль hidden в
 * object.ts: вне протяжённости серии) — потеря сверх цели, только с
 * confirm. Лишние ключи — plan-shape, и дальше проверки идут без них:
 * встреча, которую план убрал под их прикрытием, найдётся как пропавшая.
 *
 * Та же граница нужна и ответу (`plan.removed`, checkReportedRemovals),
 * поэтому возвращается не только отобранное множество, но и сам предикат.
 */
interface Removal {
  /** Ключи `expect.removed`, которые операция вправе убрать. */
  kept: Set<SlotKey>;
  /** Операция вправе убрать встречу с этим ключом. */
  allowed(key: SlotKey): boolean;
  /** Чем операция ограничена — для сообщений; пусто у delete all_series. */
  rule: string;
}

function boundRemoved(
  before: CalendarObject,
  expect: Expectation,
  known: { recurrence: boolean; target?: SlotKey; split: boolean },
  findings: Findings,
): Removal {
  const { op, scope } = expect;
  const { target } = known;
  const atOrAfter = (key: SlotKey) => target !== undefined && sameKind(key, target) && compareSlotKeys(key, target) >= 0;
  const truncating = scope === "this_and_following" && (op === "delete" || known.split);
  let lastBefore: SlotKey | null | undefined; // undefined — не искали, null — слота до B нет
  const orphaned = (key: SlotKey): boolean => {
    if (!truncating || target === undefined || !sameKind(key, target) || compareSlotKeys(key, target) >= 0) return false;
    if (roleOf(before, before.overrides.get(key) ?? []) !== "detached") return false;
    if (lastBefore === undefined) lastBefore = lastSlotBefore(before, target);
    return lastBefore !== null && compareSlotKeys(key, lastBefore) > 0;
  };
  let allowed: (key: SlotKey) => boolean;
  let rule: string;
  if (op === "delete") {
    if (scope === "all_series") {
      allowed = () => true;
      rule = "";
    } else if (scope === "this") {
      allowed = (key) => key === target || roleOf(before, before.overrides.get(key) ?? []) === "hidden";
      rule = "delete this убирает только цель (и скрытые переопределения)";
    } else {
      allowed = (key) => atOrAfter(key) || orphaned(key);
      rule = "delete this_and_following убирает только встречи от границы B (и оторванные, оставшиеся за концом усечённой серии)";
    }
  } else if (scope === "this" || (!known.recurrence && !truncating)) {
    allowed = () => false;
    rule = `${op} ${scope} без смены повтора встреч не убирает`;
  } else if (!known.recurrence) {
    allowed = orphaned;
    rule = "разрез без смены повтора убирает только оторванные встречи, оставшиеся за концом усечённой серии";
  } else {
    allowed = (key) => (before.overrides.has(key) && (!known.split || atOrAfter(key))) || orphaned(key);
    rule = "смена повтора убирает только переопределения без пары в новом правиле";
  }

  const kept = new Set<SlotKey>();
  const extra: string[] = [];
  for (const key of expect.removed) {
    if (allowed(key)) kept.add(key);
    else extra.push(describeKey(before, key));
  }
  if (op === "delete" && scope === "this" && target !== undefined) kept.add(target);
  if (extra.length > 0) {
    findings.add("plan-shape", `План называет убранными встречи ${listed(extra)}, а ${rule}: лишнее в removed не учитывается.`);
  }
  return { kept, allowed, rule };
}

// Последний слот (закрытый — тоже) раньше `b`; null — таких нет или проход не удался.
function lastSlotBefore(o: CalendarObject, b: SlotKey): SlotKey | null {
  let last: SlotKey | null = null;
  let steps = 0;
  try {
    for (const slot of iterateSlots(o, { until: b })) {
      if (compareSlotKeys(slot.key, b) >= 0) break;
      if (++steps > SERIES_CAP) return null;
      last = slot.key;
    }
  } catch (error) {
    if (!(error instanceof SlotScanError)) throw error;
    return null;
  }
  return last;
}

/**
 * О11: встреча, которую план снимает сверх названной цели, — только с
 * confirm, и ответ (`plan.removed`) обязан её назвать. Сверх цели:
 * - у t&f — встреча с RECURRENCE-ID от B, перенесённая раньше B (для
 *   пользователя она «до границы»), и оторванная встреча до B, которую
 *   усечение прячет за конец серии;
 * - у смены повтора — видимое переопределение без пары.
 * Строки ответа узнаются по адресу (Р10, `parseAddress`).
 */
function checkLossesReported(ctx: Ctx, plan: WritePlan): void {
  const { before, expect } = ctx;
  const b = expect.scope === "this_and_following" ? ctx.target : undefined;
  const ruleChange = expect.op === "update" && ctx.recurrence;
  if (b === undefined && !ruleChange) return;
  const reported = new Set<SlotKey>();
  for (const loss of plan.removed) {
    try {
      reported.add(parseAddress(before, loss.instanceStart));
    } catch {
      // Строка без разбираемого адреса ничего не называет.
    }
  }
  const silent: string[] = [];
  for (const key of ctx.removed) {
    const refs = before.overrides.get(key) ?? [];
    const role = roleOf(before, refs);
    if (role !== "slot" && role !== "detached") continue;
    const beforeBoundary = b !== undefined && sameKind(key, b) && compareSlotKeys(key, b) < 0;
    const beyond = ruleChange || beforeBoundary || (expect.op === "delete" && b !== undefined && startsBefore(ctx, refs, b));
    if (beyond && !reported.has(key)) silent.push(describeKey(before, key));
  }
  if (silent.length > 0) {
    ctx.findings.add(
      "plan-shape",
      `План снимает сверх названной цели встречи ${listed(silent)}, а в ответе (plan.removed) их нет: пользователь не узнал бы о потере (О11).`,
    );
  }
}

/**
 * О11 в обратную сторону: ответ (`plan.removed`) не называет убранной
 * встречу, которую операция не убирает. Иначе пользователь прочёл бы
 * «удалена», а встреча осталась бы в календаре — ошибка не менее вредная,
 * чем молчание о настоящей потере.
 *
 * Сверяется по той же границе операции, что и `expect.removed`
 * (`removalAllowed`), а не по слову планировщика: у delete all_series
 * убирается всё, у delete t&f — встречи от B, у delete this — цель и
 * скрытые, у смены повтора — прежние переопределения. Строка без
 * разбираемого адреса (Р10) ничего не называет и пропускается; адрес, под
 * которым до записи не было видимой встречи, — тоже: у Loss бывают строки
 * не про встречи этого объекта.
 */
function checkReportedRemovals(ctx: Ctx, plan: WritePlan): void {
  const { before } = ctx;
  const extra: string[] = [];
  const seen = new Set<SlotKey>();
  for (const loss of plan.removed) {
    let key: SlotKey;
    try {
      key = parseAddress(before, loss.instanceStart);
    } catch {
      continue;
    }
    if (seen.has(key) || ctx.removed.has(key) || key === ctx.target || ctx.removalAllowed(key)) continue;
    if (!visibleBefore(ctx, key)) continue;
    seen.add(key);
    extra.push(describeKey(before, key));
  }
  if (extra.length > 0) {
    ctx.findings.add(
      "plan-shape",
      `Ответ (plan.removed) называет убранными встречи ${listed(extra)}, а ${ctx.removalRule || `${ctx.expect.op} ${ctx.expect.scope} их не убирает`}: ` +
        `они остаются в календаре, а пользователь прочёл бы, что их удалили (О11).`,
    );
  }
}

/** До записи по этому адресу видна встреча: незакрытый слот или своё переопределение (slot, detached). */
function visibleBefore(ctx: Ctx, key: SlotKey): boolean {
  const refs = ctx.before.overrides.get(key);
  if (refs && refs.length > 0) {
    const role = roleOf(ctx.before, refs);
    return role === "slot" || role === "detached";
  }
  if (!ctx.before.master) return false;
  try {
    const slot = findSlot(ctx.before, key);
    return slot !== undefined && !slot.excluded;
  } catch (error) {
    if (!(error instanceof SlotScanError)) throw error;
    return false; // Дальше предела прохода — не нам судить.
  }
}

// Встреча переопределения начинается раньше ключа `b` (фактическое начало, а не RECURRENCE-ID).
function startsBefore(ctx: Ctx, refs: readonly OverrideRef[], b: SlotKey): boolean {
  const bMs = keyMs(b, ctx.env);
  return refs.some((ref) => instantOf(ref.component.getFirstPropertyValue("dtstart") as ICAL.Time, ctx.env) < bMs);
}

/**
 * Поля, по которым идут проверки. У удаления полей нет: заявленные поля
 * включили бы поблажки правки (сверку только явных встреч при recurrence).
 * С патчем из оркестрации — только поля, заданные в патче. Лишнее —
 * plan-shape, и дальше проверки идут без него.
 */
function checkedFields(expect: Expectation, patch: EventPatch | undefined, findings: Findings): ReadonlySet<PatchField> {
  const where = `${expect.op} ${expect.scope}`;
  if (expect.op === "delete") {
    if (expect.fields.size > 0) {
      findings.add("plan-shape", `Удаление (${where}) не применяет полей патча, а план заявил [${[...expect.fields].join(", ")}]: они не учитываются.`);
    }
    return new Set();
  }
  if (patch === undefined) return expect.fields;
  const inPatch = (field: PatchField) => Object.hasOwn(patch, field) && patch[field] !== undefined;
  const extra = [...expect.fields].filter((field) => !inPatch(field));
  if (extra.length === 0) return expect.fields;
  findings.add("plan-shape", `План применяет поля [${extra.join(", ")}], которых нет в патче: лишнее поле ослабило бы проверку и не учитывается.`);
  return new Set([...expect.fields].filter(inPatch));
}

function nowOf(options: GuardOptions): number {
  const now = options.now;
  if (now === undefined) return Date.now();
  return typeof now === "number" ? now : now.getTime();
}

// ─────────────────────────────── форма плана ───────────────────────────────

function checkShape(plan: WritePlan, findings: Findings): void {
  const { op, scope, target } = plan.expect;
  const where = `${op} ${scope}`;
  switch (plan.kind) {
    case "noop":
      if (plan.expect.removed.length > 0 || plan.removed.length > 0) {
        findings.add("plan-shape", "Пустой план ничего не пишет, а называет убранные встречи: ответ солгал бы о записи.");
      }
      return;
    case "delete-object":
      if (op !== "delete") findings.add("plan-shape", `Правка (${where}) не удаляет объект целиком.`);
      break;
    case "split":
      if (op !== "update" || scope !== "this_and_following") {
        findings.add("plan-shape", `Разрез серии бывает только у update this_and_following, а не у ${where}.`);
      }
      break;
    case "put":
      if (op === "delete" && scope === "all_series") {
        findings.add("plan-shape", "Удаление всей серии — это удаление объекта, а не запись.");
      }
      break;
  }
  if (scope === "this_and_following" && target === undefined && plan.kind !== "split") {
    findings.add("plan-shape", `У ${where} нет границы B (expect.target).`);
  }
}

// О14: блокирующие аномалии — независимо от того, проверил ли их планировщик.
function checkBlocking(ctx: Ctx, split: boolean): void {
  const { op, scope } = ctx.expect;
  if (op === "delete" && scope === "all_series") return;
  for (const anomaly of blockingAnomalies(ctx.before, op, scope, { key: ctx.target, split })) {
    ctx.findings.add("blocked", `Объект нельзя так записать: ${anomaly.code} — ${anomaly.message}.`);
  }
}

// ─────────────────────────────── delete-object (г) ───────────────────────────────

/**
 * (г): после удаления названных встреч (`removed`, у t&f — ещё всех от B)
 * в объекте нет ни одной живой встречи — ни незакрытого слота, ни
 * оторванного переопределения. Полным проходом, без горизонта: бесконечное
 * правило пустым не бывает, редкая серия (YEARLY;INTERVAL=2, 29.02)
 * проверяется до следующей встречи, а не до горизонта.
 */
function checkDeleteObject(ctx: Ctx): void {
  const { before, removed, env } = ctx;
  const boundary = ctx.expect.scope === "this_and_following" ? ctx.target : undefined;
  const cut = (key: SlotKey) => boundary !== undefined && sameKind(key, boundary) && compareSlotKeys(key, boundary) >= 0;
  const alive: string[] = [];

  for (const [key, refs] of before.overrides) {
    const role = roleOf(before, refs);
    if ((role !== "detached" && role !== "slot") || removed.has(key)) continue;
    if (cut(key)) {
      // RECURRENCE-ID от B, а сама встреча раньше B: для пользователя она до
      // границы, и t&f снимает её только названной (таблица §3, confirm).
      if (startsBefore(ctx, refs, boundary!)) alive.push(`${describeKey(before, key)} (перенесена раньше границы ${describeKey(before, boundary!)})`);
      continue;
    }
    // Переопределение слота до B живо вместе со слотом — его находит проход ниже.
    if (role === "detached") alive.push(`${describeKey(before, key)} (отдельная встреча)`);
  }
  if (before.master) {
    let steps = 0;
    try {
      for (const slot of iterateSlots(before)) {
        if (++steps > SERIES_CAP) {
          alive.push(`серия длиннее ${SERIES_CAP} слотов — пустоту не доказать`);
          break;
        }
        if (slot.excluded || removed.has(slot.key)) continue;
        if (cut(slot.key)) break;
        alive.push(formatForModel(slot.time, env, "instance"));
        break;
      }
    } catch (error) {
      if (!(error instanceof SlotScanError)) throw error;
      alive.push(`перебор серии сбился (${error.message}) — пустоту не доказать`);
    }
  }
  if (alive.length > 0) {
    ctx.findings.add(
      "not-empty",
      `План удаляет объект целиком, а в нём остаются встречи: ${listed(alive)}. Удалять можно только опустевший объект (Р3).`,
    );
  }
}

// ─────────────────────────────── put ───────────────────────────────

function checkPut(ctx: Ctx, ics: string): void {
  const { before, expect } = ctx;
  if (expect.op === "delete" && before.kind === "single") {
    // Иначе ответ сказал бы «удалено», а событие осталось бы (таблица §3: одиночное — DELETE).
    ctx.findings.add("plan-shape", `Удаление одиночного события (${expect.op} ${expect.scope}) — это удаление объекта, а не запись.`);
    return;
  }
  const after = loadWritten(ctx, ics, "записываемый объект");
  const truncation = expect.op === "delete" && expect.scope === "this_and_following";
  const degenerateSplit = expect.op === "update" && expect.scope === "this_and_following";
  if (degenerateSplit) checkNothingBeforeBoundary(ctx);

  checkInvariants(ctx, after, "записываемый объект", before.uid);
  compareTrees(ctx, after);
  if (before.master && after.master) {
    checkRuleParts(ctx, before.master, after.master, "основного компонента");
    if (ctx.recurrence) checkDateLists(ctx, before, after, () => true, "после записи");
  }

  const horizon = horizonMs(ctx, [before, after]);
  const needExtent = expect.op === "update" && (ctx.time || ctx.recurrence || expect.ruleChanged || expect.tail !== undefined);
  // Запасной путь (О12в при нехватке шагов): правка, не трогающая ни
  // DTSTART, ни правила, ни списков дат, слотов не меняет — у серии длиннее
  // предела прохода её переопределения уже сверены по ключу (compareTrees).
  const sameSlots = expect.op === "update" && !ctx.time && !ctx.recurrence && sameSlotDefinition(before, after);
  const beforeScan = scan(ctx, before, keyAtMs(before, horizon), needExtent || truncation, sameSlots);

  if (truncation) {
    const b = ctx.target!;
    checkTruncation(ctx, after, b, "записываемый объект");
    checkMovedBeforeCut(ctx, b);
    const afterScan = scan(ctx, after, keyAtMs(after, horizon), true);
    compareVisible(ctx, beforeScan, afterScan, {
      where: "после записи",
      participates: (key) => compareSlotKeys(key, b) < 0,
      options: (key) => [key],
    });
    checkTail(ctx, afterScan.extent, "после записи");
  } else if (before.kind === "single" && after.kind === "single") {
    // У одиночного события одна встреча — оно само; её ключ меняется вместе
    // с началом, сверять нечего, кроме того, что она на месте.
    if (!after.master) ctx.findings.add("meeting-lost", "У одиночного события пропал основной компонент.");
  } else if (beforeScan.tooLong) {
    // Слоты те же по построению; протяжённость не пройти — tail не сверить.
    if (expect.tail !== undefined) checkTail(ctx, { kind: "unknown" }, "после записи");
  } else {
    const explicitOnly = ctx.recurrence;
    const cutoffKey = beforeScan.bound === undefined ? undefined : ctx.mapKey(beforeScan.bound);
    let afterUntil = keyAtMs(after, horizon);
    if (cutoffKey !== undefined && sameKind(cutoffKey, afterUntil) && compareSlotKeys(cutoffKey, afterUntil) > 0) afterUntil = cutoffKey;
    const afterScan = scan(ctx, after, afterUntil, needExtent);
    compareVisible(ctx, beforeScan, afterScan, {
      where: "после записи",
      participates: () => true,
      options: (key, detached) => optionsFor(ctx, key, detached, afterScan),
      explicitOnly,
      cutoff: beforeScan.ended ? undefined : cutoffKey,
    });
    if (expect.op === "update" && before.master) checkExtent(ctx, beforeScan, afterScan, "после записи");
  }
  checkNotEmptied(ctx, after, "Запись");
}

/**
 * Таблица §3, delete t&f: встреча с RECURRENCE-ID от B, перенесённая раньше
 * B, для пользователя стоит до границы — усечение снимает её только
 * названной в removed (с confirm). Иначе она пропала бы молча: её
 * переопределение уходит вместе с хвостом.
 */
function checkMovedBeforeCut(ctx: Ctx, b: SlotKey): void {
  const { before, env } = ctx;
  const lost: string[] = [];
  for (const [key, refs] of before.overrides) {
    const role = roleOf(before, refs);
    if (role !== "slot" && role !== "detached") continue;
    if (!sameKind(key, b) || compareSlotKeys(key, b) < 0 || ctx.removed.has(key) || !startsBefore(ctx, refs, b)) continue;
    const start = refs[0].component.getFirstPropertyValue("dtstart") as ICAL.Time;
    lost.push(`${describeKey(before, key)} (перенесена на ${formatForModel(start, env, "instance")})`);
  }
  if (lost.length > 0) {
    ctx.findings.add(
      "meeting-lost",
      `Усечение с ${describeKey(before, b)} снимает встречи ${listed(lost)}, перенесённые раньше границы, а план их не назвал в removed (таблица §3: только с confirm).`,
    );
  }
}

// Слоты объекта заданы теми же значениями: DTSTART, RRULE, RDATE, EXDATE и
// EXRULE основного как записаны (VTIMEZONE сверяет compareRoot).
function sameSlotDefinition(before: CalendarObject, after: CalendarObject): boolean {
  if (!before.master || !after.master) return false;
  const was = groupsOf(before.master);
  const now = groupsOf(after.master);
  return ["dtstart", ...SERIES_ONLY].every((name) => JSON.stringify(was.get(name) ?? []) === JSON.stringify(now.get(name) ?? []));
}

/**
 * Р1, Р4: правка без recurrence меняет в RRULE только конец — UNTIL
 * (пересчёт при сдвиге времени) и COUNT (усечение, продолжение). Прочие
 * части — FREQ, INTERVAL, BYxxx, WKST и неизвестные части (X-…, RSCALE) — и
 * параметры свойства прежние. Сверка — по jCal-словарю: разбор хранит
 * неизвестные части как есть (recur.js, _stringToData; values.ts,
 * ruleDict), порядок частей не важен. Протяжённость после смены конца
 * сверяет (д). `always` — сверять и при смене повтора: усечённая исходная
 * серия при разрезе меняет только конец, повтор патча — дело продолжения.
 */
function checkRuleParts(ctx: Ctx, beforeMaster: ICAL.Component, afterMaster: ICAL.Component, label: string, always = false): void {
  if (ctx.recurrence && !always) return;
  const strip = (property: ICAL.Property): string => {
    const [name, params, type, value, ...rest] = property.jCal as unknown[];
    let core: unknown = value;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      core = Object.entries(value as Record<string, unknown>)
        .filter(([part]) => part !== "until" && part !== "count")
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    }
    return JSON.stringify([name, params, type, core, rest]);
  };
  const was = beforeMaster.getAllProperties("rrule").map(strip);
  const now = afterMaster.getAllProperties("rrule").map(strip);
  if (JSON.stringify(was) !== JSON.stringify(now)) {
    ctx.findings.add(
      "untouched-changed",
      `У ${label} изменены части RRULE сверх конца правила (UNTIL, COUNT): ${ctx.expect.op} ${ctx.expect.scope} без recurrence их не меняет (Р1, Р4).`,
    );
  }
}

/**
 * Таблица §3, смена повтора: RDATE остаются (при правке времени — со сдвигом
 * по keyMap), EXDATE только снимаются — у кого нет слота в новом правиле.
 * Новый EXDATE закрыл бы встречу молча, снятый RDATE — убрал бы. Что снятый
 * EXDATE не открыл слот нового правила, проверяет сверка видимых встреч
 * (exdate-lifted). `participates` — какие прежние значения переходят в
 * записываемый объект (у продолжения разреза — от B).
 */
function checkDateLists(
  ctx: Ctx,
  before: CalendarObject,
  after: CalendarObject,
  participates: (key: SlotKey) => boolean,
  where: string,
): void {
  if (!before.master || !after.master) return;
  const images = (key: SlotKey): SlotKey[] => {
    const image = ctx.softMapKey(key);
    return image === undefined || image === key ? [key] : [key, image];
  };
  const beforeRdates = listKeys(before.master, "rdate", before).filter(participates);
  const afterRdates = listKeys(after.master, "rdate", after);
  const afterRdateSet = new Set(afterRdates);
  const lost = beforeRdates.filter((key) => !images(key).some((image) => afterRdateSet.has(image)));
  const allowedRdates = new Set(beforeRdates.flatMap(images));
  const added = afterRdates.filter((key) => !allowedRdates.has(key));
  const allowedExdates = new Set(listKeys(before.master, "exdate", before).filter(participates).flatMap(images));
  const closed = listKeys(after.master, "exdate", after).filter((key) => !allowedExdates.has(key));

  const { findings } = ctx;
  if (lost.length > 0) {
    findings.add("meeting-lost", `Сняты RDATE ${listed(lost.map((key) => describeKey(before, key)))}: встречи ${where} пропали, а смена повтора RDATE не трогает (таблица §3).`);
  }
  if (added.length > 0) {
    findings.add("meeting-added", `Новые RDATE ${listed(added.map((key) => describeKey(after, key)))} ${where}: смена повтора RDATE не добавляет (таблица §3).`);
  }
  if (closed.length > 0) {
    findings.add("meeting-lost", `Новые EXDATE ${listed(closed.map((key) => describeKey(after, key)))} ${where} закрыли встречи: при смене повтора EXDATE только снимаются (таблица §3).`);
  }
}

// ─────────────────────────────── разрез ───────────────────────────────

function checkSplit(ctx: Ctx, plan: Extract<WritePlan, { kind: "split" }>): void {
  const { before } = ctx;
  const b = ctx.boundary!;
  const truncated = loadWritten(ctx, plan.truncated.ics, "усечённый исходный объект");
  const continuation = loadWritten(ctx, plan.continuation.ics, "продолжение");
  if (!before.master) ctx.findings.fail("plan-shape", "У объекта без основного компонента разрезать нечего (Р6).");
  const mapped = ctx.mapKey(b);
  if (plan.boundary !== b && plan.boundary !== mapped) {
    ctx.findings.add("plan-shape", `Граница разреза ${plan.boundary} не совпадает ни с целью ${b}, ни с её ключом после записи ${mapped}.`);
  }
  if (plan.continuation.uid === before.uid) {
    ctx.findings.add("invariant", "UID продолжения совпадает с UID исходной серии: две серии с одним UID.");
  }

  checkInvariants(ctx, truncated, "усечённый исходный объект", before.uid);
  checkInvariants(ctx, continuation, "продолжение", plan.continuation.uid);
  compareTrees(ctx, truncated, { boundary: b });
  compareContinuation(ctx, continuation, b);
  if (truncated.master) checkRuleParts(ctx, before.master, truncated.master, "основного компонента усечённой серии", true);
  if (continuation.master) {
    checkRuleParts(ctx, before.master, continuation.master, "основного компонента продолжения");
    if (ctx.recurrence) checkDateLists(ctx, before, continuation, (key) => !sameKind(key, b) || compareSlotKeys(key, b) >= 0, "в продолжении");
  }
  checkTruncation(ctx, truncated, b, "усечённый исходный объект");
  checkNotEmptied(ctx, truncated, "Усечение");

  const horizon = horizonMs(ctx, [before, truncated, continuation]);
  const beforeScan = scan(ctx, before, keyAtMs(before, horizon), true);
  const truncatedScan = scan(ctx, truncated, keyAtMs(truncated, horizon), true);
  compareVisible(ctx, beforeScan, truncatedScan, {
    where: "в усечённой серии",
    participates: (key) => compareSlotKeys(key, b) < 0,
    options: (key) => [key],
  });

  const cutoffKey = beforeScan.bound === undefined ? undefined : ctx.mapKey(beforeScan.bound);
  let contUntil = keyAtMs(continuation, horizon);
  if (cutoffKey !== undefined && sameKind(cutoffKey, contUntil) && compareSlotKeys(cutoffKey, contUntil) > 0) contUntil = cutoffKey;
  // Продолжение, начатое не с B, этой сверкой и ловится: B пропала, а
  // лишние встречи до неё не взялись ни из одной прежней.
  const contScan = scan(ctx, continuation, contUntil, true);
  compareVisible(ctx, beforeScan, contScan, {
    where: "в продолжении",
    participates: (key) => compareSlotKeys(key, b) >= 0,
    options: (key, detached) => optionsFor(ctx, key, detached, contScan),
    explicitOnly: ctx.recurrence,
    cutoff: beforeScan.ended ? undefined : cutoffKey,
  });
  checkExtent(ctx, beforeScan, contScan, "в продолжении", b);
}

// ─────────────────────────────── разбор записываемого ───────────────────────────────

function loadWritten(ctx: Ctx, ics: string, label: string): CalendarObject {
  const loaded = loadObject(ics, ctx.env);
  if (isUnparsable(loaded)) ctx.findings.fail("unparsable", `${capital(label)} не разбирается: ${loaded.error}`);
  return loaded;
}

// ─────────────────────────────── (а) инварианты ───────────────────────────────

/**
 * Инварианты О12а записываемого объекта `x`. Нарушения, которые уже были в
 * прочитанном объекте и которых план не касался, терпятся («аномалий не
 * больше, чем было»): формы значений сравниваются по самим значениям,
 * DTEND, DURATION и их порядок — только у изменённых и новых компонентов.
 */
function checkInvariants(ctx: Ctx, x: CalendarObject, label: string, uid: string): void {
  const { before, findings } = ctx;
  const add = (message: string) => findings.add("invariant", `${capital(label)}: ${message}`);
  const events = x.root.getAllSubcomponents("vevent");

  const uids = [...new Set(events.map((event) => String(event.getFirstPropertyValue("uid") ?? "")))];
  if (uids.length !== 1 || uids[0] !== uid) add(`UID ${uids.join(", ")} вместо ${uid}.`);
  const masters = events.filter((event) => !event.hasProperty("recurrence-id")).length;
  if (masters > 1) add(`${masters} основных компонента (VEVENT без RECURRENCE-ID).`);

  const beforeAnomalies = countBy(before.anomalies.map((anomaly) => anomaly.code));
  for (const [code, count] of countBy(x.anomalies.map((anomaly) => anomaly.code))) {
    if (count > (beforeAnomalies.get(code) ?? 0)) {
      const sample = x.anomalies.find((anomaly) => anomaly.code === code)!;
      add(`новая аномалия ${code}: ${sample.message}.`);
    }
  }

  // Дубли RECURRENCE-ID и EXDATE: не больше, чем у прежнего ключа (или его образа).
  const beforeOverrideCounts = new Map<SlotKey, number>();
  // Образ — мягко: переопределение может и не быть слотом (detached, hidden).
  const images = (key: SlotKey) => new Set([key, ctx.softMapKey(key) ?? key]);
  for (const [key, refs] of before.overrides) {
    for (const k of images(key)) beforeOverrideCounts.set(k, Math.max(beforeOverrideCounts.get(k) ?? 0, refs.length));
  }
  for (const [key, refs] of x.overrides) {
    if (refs.length > 1 && refs.length > (beforeOverrideCounts.get(key) ?? 1)) {
      add(`новый дубль RECURRENCE-ID ${describeKey(x, key)}: ${refs.length} компонента.`);
    }
  }
  if (x.master) {
    const beforeExdates = new Map<SlotKey, number>();
    if (before.master) {
      for (const [key, count] of countBy(listKeys(before.master, "exdate", before))) {
        for (const k of images(key)) beforeExdates.set(k, Math.max(beforeExdates.get(k) ?? 0, count));
      }
    }
    for (const [key, count] of countBy(listKeys(x.master, "exdate", x))) {
      if (count > 1 && count > (beforeExdates.get(key) ?? 1)) add(`новый дубль EXDATE ${describeKey(x, key)}.`);
    }
  }

  const beforeMissing = zonesMissing(before.root);
  for (const tzid of zonesMissing(x.root)) {
    if (!beforeMissing.has(tzid)) add(`TZID ${tzid} без VTIMEZONE.`);
  }

  const beforeForms = formViolations(before);
  for (const violation of formViolations(x)) {
    if (!beforeForms.has(violation)) add(`значение не в форме DTSTART (О4): ${violation}.`);
  }

  // Время компонента — по подписи значений: прежнее нарушение чужого
  // клиента, которого план не касался, терпится, а в новом или изменённом
  // компоненте — нет.
  const beforeTimes = new Set(before.root.getAllSubcomponents("vevent").map(timeSignature));
  for (const event of events) {
    if (beforeTimes.has(timeSignature(event))) continue;
    const name = componentLabel(x, event);
    const start = event.getFirstPropertyValue("dtstart") as ICAL.Time;
    const dtend = event.getFirstPropertyValue("dtend");
    const duration = event.getFirstPropertyValue("duration");
    if (dtend !== null && duration !== null) add(`у ${name} DTEND вместе с DURATION (RFC 5545 §3.6.1).`);
    if (dtend instanceof ICAL.Time && instantOf(dtend, ctx.env) <= instantOf(start, ctx.env)) {
      add(`у ${name} DTEND ${dtend.toString()} не позже DTSTART ${start.toString()}.`);
    }
    if (duration instanceof ICAL.Duration && (duration.isNegative || duration.toSeconds() <= 0)) {
      add(`у ${name} DURATION ${duration.toString()} не положительна.`);
    }
  }
}

// Подпись времени компонента: DTSTART, DTEND и DURATION как записаны.
function timeSignature(event: ICAL.Component): string {
  return JSON.stringify(["dtstart", "dtend", "duration"].map((name) => event.getAllProperties(name).map((p) => p.jCal)));
}

// TZID, на которые ссылаются VEVENT и их подкомпоненты, без VTIMEZONE в объекте.
function zonesMissing(root: ICAL.Component): Set<string> {
  const defined = new Set(root.getAllSubcomponents("vtimezone").map((zone) => String(zone.getFirstPropertyValue("tzid") ?? "")));
  const missing = new Set<string>();
  const walk = (jcal: unknown[]) => {
    for (const property of jcal[1] as unknown[][]) {
      const tzid = (property[1] as Record<string, unknown>).tzid;
      if (typeof tzid === "string" && tzid && !defined.has(tzid)) missing.add(tzid);
    }
    for (const sub of jcal[2] as unknown[][]) walk(sub);
  };
  for (const event of root.getAllSubcomponents("vevent")) walk(event.jCal);
  return missing;
}

/**
 * Значения RECURRENCE-ID, EXDATE, RDATE и UNTIL не в форме DTSTART основного
 * (О4): у даты — дата; у UTC — `…Z`; у TZID — тот же TZID, а UNTIL — в UTC;
 * у плавающего — без Z и без TZID. Подпись — имя, TZID и значение как
 * записано: прежнее нарушение, которого план не касался, узнаётся.
 */
function formViolations(o: CalendarObject): Set<string> {
  const found = new Set<string>();
  if (!o.master) return found;
  const wanted = o.form;
  const tzid = o.tzid;
  const formOfRaw = (raw: string, valueTzid: unknown): string => {
    if (raw.length === 10) return "date";
    if (raw.endsWith("Z")) return "utc";
    return valueTzid ? "zoned" : "floating";
  };
  const check = (name: string, raw: unknown, valueTzid: unknown) => {
    const text = String(Array.isArray(raw) ? raw[0] : raw);
    const form = formOfRaw(text, valueTzid);
    const ok = form === wanted && (form !== "zoned" || valueTzid === tzid);
    if (!ok) found.add(`${name.toUpperCase()}${valueTzid ? `;TZID=${String(valueTzid)}` : ""}:${text}`);
  };
  for (const event of o.root.getAllSubcomponents("vevent")) {
    const rid = event.getFirstProperty("recurrence-id");
    if (rid) check("recurrence-id", rid.jCal[3], rid.getParameter("tzid"));
  }
  for (const name of ["exdate", "rdate"]) {
    for (const property of o.master.getAllProperties(name)) {
      for (const raw of property.jCal.slice(3)) check(name, raw, property.getParameter("tzid"));
    }
  }
  for (const rule of o.master.getAllProperties("rrule")) {
    const dict = rule.jCal[3] as Record<string, unknown> | undefined;
    const until = dict && typeof dict === "object" ? dict.until : undefined;
    if (typeof until !== "string") continue;
    const form = until.length === 10 ? "date" : until.endsWith("Z") ? "utc" : "floating";
    const expected = wanted === "zoned" ? "utc" : wanted;
    if (form !== expected) found.add(`UNTIL=${until} при DTSTART в форме ${wanted}`);
  }
  return found;
}

// ─────────────────────────────── (б) дерево ───────────────────────────────

const META = ["dtstamp", "last-modified", "sequence"];
const TIME = ["dtstart", "dtend", "duration"];
const SERIES_ONLY = ["rrule", "rdate", "exdate", "exrule"];
const INHERITED: readonly PatchField[] = ["summary", "description", "location", "attendees", "reminders"];

const FIELD_NAMES: Readonly<Record<PatchField, readonly string[]>> = {
  summary: ["summary"],
  description: ["description"],
  location: ["location"],
  start: TIME,
  end: TIME,
  timeZone: TIME,
  allDay: TIME,
  attendees: ["attendee"],
  reminders: ["valarm"],
  recurrence: ["rrule"],
};

function namesOf(fields: Iterable<PatchField>): string[] {
  return [...fields].flatMap((field) => FIELD_NAMES[field] ?? []);
}

/** Где компонент стоит в плане. */
type Place =
  | { kind: "master" }
  | { kind: "override"; key: SlotKey; target: boolean };

/**
 * Прежний ключ — цель правки: у update this — цель, у t&f — граница B («B
 * получает патч»), в том числе у t&f одним put по Р2. У all_series особой
 * цели нет (таблица §3): ключ, который планировщик вправе задать по
 * instanceStart, поблажек не даёт — ни полей патча сверх О7, ни сдвига
 * перенесённой встречи.
 */
function isTarget(ctx: Ctx, key: SlotKey): boolean {
  return ctx.expect.scope !== "all_series" && ctx.target !== undefined && key === ctx.target;
}

/**
 * Что операция может менять в компоненте (О5–О10, таблица §3) — независимо
 * от отметок планировщика:
 * - update this — только компонент цели (у одиночного события — основной):
 *   метаданные и поля патча;
 * - update all_series (и t&f, равная all_series по Р2) — основной: поля
 *   патча, при правке времени или повтора — ещё RRULE, EXDATE, RDATE (сдвиг
 *   по Р1, пересчёт UNTIL); переопределения: поля патча (значения сверяет
 *   О7, checkInheritedFields) и при правке времени или повтора — время и
 *   RECURRENCE-ID (сдвиг по позиции);
 * - delete this — основной: EXDATE и RDATE;
 * - delete t&f и усечение при разрезе — основной: RRULE (конец), EXDATE,
 *   RDATE; переопределения до B не меняются.
 * Что внутри разрешённого свойства меняется только часть, сверяют отдельно:
 * RRULE — checkRuleParts, участники — checkAttendeeParams.
 */
function permitted(ctx: Ctx, place: Place, splitting: boolean): Set<string> {
  const { op, scope } = ctx.expect;
  const all = new Set<string>(META);
  const addAll = (names: Iterable<string>) => {
    for (const name of names) all.add(name);
  };
  const ownFields = [...ctx.fields].filter((field) => field !== "recurrence");
  const series = ctx.time || ctx.recurrence;

  if (op === "delete") {
    if (place.kind === "master") addAll(scope === "this" ? ["exdate", "rdate"] : ["rrule", "exdate", "rdate"]);
    else return new Set();
    return all;
  }
  if (scope === "this") {
    const isTargetComponent = place.kind === "override" ? place.target : ctx.before.kind === "single";
    if (!isTargetComponent) return new Set();
    addAll(namesOf(place.kind === "master" ? ctx.fields : ownFields));
    return all;
  }
  if (scope === "this_and_following" && splitting) {
    // Усечённый исходный объект: только конец правила и списки дат.
    if (place.kind === "master") addAll(["rrule", "exdate", "rdate"]);
    else return new Set();
    return all;
  }
  // all_series и t&f без встреч до B (Р2)
  if (place.kind === "master") {
    addAll(namesOf(ctx.fields));
    if (series) addAll(["rrule", "exdate", "rdate"]);
    return all;
  }
  addAll(namesOf(ownFields.filter((field) => INHERITED.includes(field))));
  if (series) addAll(["recurrence-id", ...TIME]);
  if (place.target) addAll(namesOf(ownFields));
  return all;
}

interface TreeOptions {
  /** Разрез: переопределения с ключом ≥ boundary уходят в продолжение. */
  boundary?: SlotKey;
}

/**
 * (б): сравнение дерева после записи с прочитанным. Корень — свойства
 * VCALENDAR и прочитанные VTIMEZONE неизменны; основной — с основным;
 * переопределения — по ключу (через keyMap у сдвинутых); снятые и
 * добавленные VEVENT — только с правом на это и с отметкой в
 * touched.components. У правки всей серии поля переопределений — по О7.
 */
function compareTrees(ctx: Ctx, after: CalendarObject, options: TreeOptions = {}): void {
  const { before, findings, expect } = ctx;
  const splitting = options.boundary !== undefined;
  compareRoot(ctx, before.root, after.root);

  if (before.master) {
    if (!after.master) findings.add("untouched-changed", "Снят основной компонент серии.");
    else {
      compareComponent(ctx, before.master, after.master, permitted(ctx, { kind: "master" }, splitting), true, "основной компонент");
      // Патч полей ложится на основной у правки всей серии (и t&f одним put
      // по Р2), а у одиночного события — и при scope this.
      if (!splitting && (expect.scope !== "this" || before.kind === "single")) {
        checkKeptSpan(ctx, before.master, after.master, "основного компонента");
      }
    }
  } else if (after.master) {
    findings.add("untouched-changed", "У объекта из одних переопределений появился основной компонент.");
  }
  // О7 для полей: правка всей серии (и t&f одним put по Р2) — от прежнего
  // основного к новому.
  const inherit = expect.op === "update" && expect.scope !== "this" && !splitting && before.master && after.master
    ? { from: before.master, to: after.master }
    : undefined;

  const used = new Set<ICAL.Component>();
  for (const [key, refs] of before.overrides) {
    const role = roleOf(before, refs);
    const target = isTarget(ctx, key);
    const label = `переопределение ${describeKey(before, key)}`;
    if (options.boundary !== undefined && compareSlotKeys(key, options.boundary) >= 0) {
      // Уходит в продолжение: в усечённом объекте его быть не должно.
      for (const ref of refs) requireTouchedRemoval(ctx, ref.component, label);
      continue;
    }
    const place: Place = { kind: "override", key, target };
    const afterRefs = pairsFor(ctx, key, role, after, used);
    for (const ref of refs) {
      const pair = afterRefs?.find((r) => !used.has(r.component));
      if (pair) {
        used.add(pair.component);
        compareComponent(ctx, ref.component, pair.component, permitted(ctx, place, splitting), true, label);
        checkMovedStays(ctx, before, ref, after, pair, target, label);
        if (target) checkKeptSpan(ctx, ref.component, pair.component, label);
        if (inherit && !target) checkInheritedFields(ctx, inherit.from, inherit.to, ref.component, pair.component, label, role);
      } else if (mayRemove(ctx, key, role)) {
        requireTouchedRemoval(ctx, ref.component, label);
      } else {
        findings.add("override-lost", `${capital(label)} снято, а операция ${expect.op} ${expect.scope} его снимать не может.`);
      }
    }
  }

  for (const [key, refs] of after.overrides) {
    for (const ref of refs) {
      if (used.has(ref.component)) continue;
      const label = `переопределение ${describeKey(after, key)}`;
      if (!mayAddClone(ctx, key, after, ref)) {
        findings.add("untouched-changed", `Лишний компонент: ${label} появилось, а операция ${expect.op} ${expect.scope} его не создаёт.`);
        continue;
      }
      if (!ctx.touchedComponents.has(identityOf(ref.component))) {
        findings.add("untouched-changed", `${capital(label)} добавлено без отметки в touched.components.`);
      }
      if (before.master) compareClone(ctx, before.master, ref.component, key, label);
    }
  }
}

/**
 * Компоненты, среди которых ищется пара прежнего переопределения после
 * записи: у слота — по образу keyMap; у detached и hidden — сначала по
 * прежнему ключу, образ спрашивается, только если там пары нет (сдвиг по
 * позиции у них не определён, и keyMap их знать не обязан: его сбой здесь —
 * «образа нет»).
 */
function pairsFor(
  ctx: Ctx,
  key: SlotKey,
  role: string | undefined,
  after: CalendarObject,
  used: ReadonlySet<ICAL.Component>,
): readonly OverrideRef[] | undefined {
  const free = (list: readonly OverrideRef[] | undefined) => (list && list.some((ref) => !used.has(ref.component)) ? list : undefined);
  if (role === "slot") return free(after.overrides.get(ctx.mapKey(key)));
  const own = free(after.overrides.get(key));
  if (own) return own;
  const image = ctx.softMapKey(key);
  return image === undefined ? undefined : free(after.overrides.get(image));
}

function mayRemove(ctx: Ctx, key: SlotKey, role: string | undefined): boolean {
  const { op, scope } = ctx.expect;
  if (op === "delete") {
    if (scope === "this") return key === ctx.target;
    if (scope === "this_and_following") return (ctx.target !== undefined && compareSlotKeys(key, ctx.target) >= 0) || ctx.removed.has(key);
    return true;
  }
  // Правка: смена повтора «по ключу» (Р1) снимает переопределения без пары — только названные в removed; скрытые — следы.
  if (ctx.recurrence && scope !== "this") return ctx.removed.has(key) || role === "hidden";
  return false;
}

// Новый VEVENT: только клон основного на слоте цели у update this (О6).
function mayAddClone(ctx: Ctx, key: SlotKey, after: CalendarObject, ref: OverrideRef): boolean {
  const { op, scope } = ctx.expect;
  if (op !== "update" || scope !== "this" || ctx.target === undefined || key !== ctx.target) return false;
  if ((ctx.before.overrides.get(key) ?? []).length > 0) return false;
  return after.roles.get(ref.component)?.role === "slot";
}

function requireTouchedRemoval(ctx: Ctx, component: ICAL.Component, label: string): void {
  if (!ctx.touchedComponents.has(identityOf(component))) {
    ctx.findings.add("untouched-changed", `${capital(label)} снято без отметки в touched.components.`);
  }
}

function compareRoot(ctx: Ctx, before: ICAL.Component, after: ICAL.Component): void {
  const { findings } = ctx;
  const beforeProps = JSON.stringify(before.jCal[1]);
  if (beforeProps !== JSON.stringify(after.jCal[1])) {
    findings.add("untouched-changed", `Изменены свойства VCALENDAR (${diffNames(groupsOf(before), groupsOf(after)).join(", ")}): запись не пересобирает календарь.`);
  }
  const zones = new Map(after.getAllSubcomponents("vtimezone").map((zone) => [String(zone.getFirstPropertyValue("tzid")), JSON.stringify(zone.jCal)]));
  for (const zone of before.getAllSubcomponents("vtimezone")) {
    const tzid = String(zone.getFirstPropertyValue("tzid"));
    const now = zones.get(tzid);
    if (now === undefined) findings.add("untouched-changed", `Снят VTIMEZONE ${tzid} (О5: VTIMEZONE только добавляются).`);
    else if (now !== JSON.stringify(zone.jCal)) findings.add("untouched-changed", `Изменён VTIMEZONE ${tzid} (О5).`);
  }
  const others = (c: ICAL.Component) =>
    c.getAllSubcomponents().filter((sub) => sub.name !== "vevent" && sub.name !== "vtimezone").map((sub) => JSON.stringify(sub.jCal)).sort();
  if (JSON.stringify(others(before)) !== JSON.stringify(others(after))) {
    findings.add("untouched-changed", "Изменены прочие компоненты календаря (не VEVENT и не VTIMEZONE).");
  }
}

/**
 * Компонент после записи против прежнего: каждое различающееся имя
 * (свойство или подкомпонент) должно быть допустимо для операции и — если
 * `requireTouched` — отмечено в touched.names. Чужие VALARM — всегда
 * прежние; у оставшихся участников меняется только PARTSTAT.
 */
function compareComponent(
  ctx: Ctx,
  before: ICAL.Component,
  after: ICAL.Component,
  allowed: ReadonlySet<string>,
  requireTouched: boolean,
  label: string,
): void {
  const names = diffNames(groupsOf(before), groupsOf(after));
  const touched = ctx.touchedNames.get(identityOf(after)) ?? new Set<string>();
  const { op, scope } = ctx.expect;
  for (const name of names) {
    if (!allowed.has(name)) {
      ctx.findings.add("untouched-changed", `У ${label} изменено ${name.toUpperCase()}, а ${op} ${scope} с полями [${[...ctx.fields].join(", ")}] его менять не может.`);
    } else if (requireTouched && !touched.has(name)) {
      ctx.findings.add("untouched-changed", `У ${label} изменено ${name.toUpperCase()} без отметки в touched.`);
    }
  }
  if (names.includes("attendee")) checkAttendeeParams(ctx, before, after, label);
  checkForeignAlarms(ctx, before, after, label);
}

/**
 * О9: участники — по адресу; у имеющегося участника, оставшегося после
 * правки, меняется только PARTSTAT. CN, ROLE, RSVP и прочие параметры, как и
 * само значение, — прежние (patch.ts обещает то же, но проверка своя).
 */
function checkAttendeeParams(ctx: Ctx, before: ICAL.Component, after: ICAL.Component, label: string): void {
  const index = (c: ICAL.Component) => {
    const found = new Map<string, string>();
    for (const property of c.getAllProperties("attendee")) {
      const address = addressOf(property);
      if (!found.has(address)) found.set(address, attendeeWithoutPartstat(property));
    }
    return found;
  };
  const now = index(after);
  const changed: string[] = [];
  for (const [address, was] of index(before)) {
    const is = now.get(address);
    if (is !== undefined && is !== was) changed.push(address);
  }
  if (changed.length > 0) {
    ctx.findings.add(
      "untouched-changed",
      `У ${label} у участников ${listed(changed)} изменены параметры или значение, а правка участников меняет у имеющихся только PARTSTAT (О9).`,
    );
  }
}

// ATTENDEE без PARTSTAT: имя, прочие параметры по имени, тип и значение.
function attendeeWithoutPartstat(property: ICAL.Property): string {
  const [name, params, type, ...values] = property.jCal as unknown[];
  const rest = Object.entries(params as Record<string, unknown>)
    .filter(([param]) => param.toLowerCase() !== "partstat")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify([name, rest, type, values]);
}

// Адрес участника: без mailto:, без пробелов по краям, в нижнем регистре (как сравнивает О9).
function addressOf(property: ICAL.Property): string {
  return String(property.getFirstValue() ?? "").trim().replace(/^mailto:/i, "").trim().toLowerCase();
}

function partstatOf(property: ICAL.Property): string {
  return String(property.getParameter("partstat") ?? "NEEDS-ACTION").toUpperCase();
}

/**
 * Клон основного (О6): всё, кроме RRULE, RDATE, EXDATE, EXRULE, времени, RID,
 * метаданных и полей патча, — как у основного; время — по О6 и О8
 * (checkCloneTime).
 */
function compareClone(ctx: Ctx, master: ICAL.Component, clone: ICAL.Component, key: SlotKey, label: string): void {
  const own = [...ctx.fields].filter((field) => field !== "recurrence");
  const allowed = new Set([...META, ...TIME, "recurrence-id", ...SERIES_ONLY, ...namesOf(own)]);
  compareComponent(ctx, master, clone, allowed, false, label);
  for (const name of SERIES_ONLY) {
    if (clone.hasProperty(name)) ctx.findings.add("invariant", `У ${label} есть ${name.toUpperCase()}: переопределение не несёт правила (О6).`);
  }
  checkCloneTime(ctx, master, clone, key, label);
}

/**
 * Время клона основного (О6, О8), когда поля патча его не задают:
 * - без start — начало на слоте: без timeZone — то же значение, что
 *   RECURRENCE-ID (форма и пояс серии), с timeZone — тот же момент;
 * - без end — длительность основного в его форме конца (DTEND или
 *   DURATION), у слота из RDATE;VALUE=PERIOD — длительность периода; без
 *   полей времени вовсе DTEND ещё и в форме DTEND основного.
 * С allDay время свободно. DTEND вместе с DURATION здесь не разбирается —
 * это нарушение ловит (а).
 */
function checkCloneTime(ctx: Ctx, master: ICAL.Component, clone: ICAL.Component, key: SlotKey, label: string): void {
  const fields = ctx.fields;
  if (fields.has("allDay")) return;
  const rid = clone.getFirstProperty("recurrence-id");
  const start = clone.getFirstProperty("dtstart");
  if (!rid || !start) return;
  const problems: string[] = [];
  if (!fields.has("start")) {
    if (!fields.has("timeZone")) {
      if (!sameTimeValue(start, rid)) problems.push(`начало ${rawTime(start)} не на слоте ${rawTime(rid)}`);
    } else if (instantOf(start.getFirstValue() as ICAL.Time, ctx.env) !== instantOf(rid.getFirstValue() as ICAL.Time, ctx.env)) {
      problems.push(`начало ${rawTime(start)} — не тот момент, что слот ${rawTime(rid)}`);
    }
  }
  if (!fields.has("end")) {
    const span = spanProblem(ctx, master, clone, periodOf(ctx, key), !ctx.time);
    if (span) problems.push(span);
  }
  if (problems.length > 0) {
    ctx.findings.add(
      "time-changed",
      `У ${label} ${problems.join("; ")}, а поля патча [${[...fields].join(", ")}] этого не меняют (О6: начало клона — слот, конец — слот плюс длительность основного; О8).`,
    );
  }
}

/**
 * Разрез (О6, таблица §3): основной компонент продолжения — клон прежнего
 * основного с началом на B. Без start начало — слот B, и при смене повтора
 * тоже: по таблице §3 продолжение начинается с B («DTSTART = дата B + время
 * патча»), а дату переносит только start в патче — новое правило
 * раскрывается от B, а не от собственной первой позиции. Без timeZone — в
 * форме и поясе серии, с timeZone — тот же момент. Без end — прежняя
 * длительность в прежней форме конца. С allDay время свободно.
 *
 * Без этой сверки при смене повтора начало продолжения не проверял бы
 * никто: видимые встречи при recurrence сверяются только по своим
 * компонентам (explicitOnly), а протяжённость — по `expect.tail` того же
 * планировщика, и сдвиг всей серии продолжения прошёл бы молча.
 */
function checkContinuationTime(ctx: Ctx, was: ICAL.Component, cont: ICAL.Component, b: SlotKey): void {
  const fields = ctx.fields;
  if (fields.has("allDay")) return;
  const start = cont.getFirstProperty("dtstart");
  const wasStart = was.getFirstProperty("dtstart");
  if (!start || !wasStart) return;
  const problems: string[] = [];
  if (!fields.has("start")) {
    const value = start.getFirstValue() as ICAL.Time;
    if (!fields.has("timeZone")) {
      const sameForm = formOf(start) === formOf(wasStart) && String(start.getParameter("tzid") ?? "") === String(wasStart.getParameter("tzid") ?? "");
      if (!sameForm || slotKeyOf(value, ctx.before.form, ctx.env) !== b) {
        problems.push(`начало ${rawTime(start)} не на слоте ${describeKey(ctx.before, b)}`);
      }
    } else if (b.startsWith("T:") && instantOf(value, ctx.env) !== keyMs(b, ctx.env)) {
      problems.push(`начало ${rawTime(start)} — не тот момент, что слот ${describeKey(ctx.before, b)}`);
    }
  }
  if (!fields.has("end")) {
    const span = spanProblem(ctx, was, cont, undefined, !ctx.time);
    if (span) problems.push(span);
  }
  if (problems.length > 0) {
    ctx.findings.add(
      "time-changed",
      `У основного компонента продолжения ${problems.join("; ")}, а поля патча [${[...fields].join(", ")}] этого не меняют (О6, таблица §3).`,
    );
  }
}

/**
 * О8 у компонента, который был и остался: `start` без `end` сохраняет
 * длительность. У нового клона это сверяет checkCloneTime, у основного
 * компонента продолжения — checkContinuationTime; здесь — цель update this
 * (у одиночного события — основной), основной при правке всей серии и цель
 * B в продолжении разреза. Без этого правка времени оставляла бы конец
 * свободным: поля патча разрешают трогать DTSTART, DTEND и DURATION, а на
 * что их меняют, не смотрел бы никто.
 *
 * Форма конца сверяется как есть (sameForm = false): вместе с timeZone
 * патча меняется и пояс DTEND. Правка одного timeZone (без start) здесь не
 * проверяется: по О8 она сохраняет моменты, а DURATION одиночной встречи
 * или переопределения при этом пересчитывается, чтобы конец остался тем же
 * (patch.ts, resolveTimes), — «прежняя длительность» там не инвариант.
 * Длительность переопределений, которые не цель, стоит на О7
 * (checkMovedStays: перенесённые остаются, где стояли).
 */
function checkKeptSpan(ctx: Ctx, was: ICAL.Component, now: ICAL.Component, label: string): void {
  const fields = ctx.fields;
  if (ctx.expect.op !== "update") return;
  if (!fields.has("start") || fields.has("end") || fields.has("allDay")) return;
  const problem = spanProblem(ctx, was, now, undefined, false);
  if (problem !== undefined) {
    ctx.findings.add(
      "time-changed",
      `У ${label} ${problem}, а поля патча [${[...fields].join(", ")}] конца не задают (О8: start без end сохраняет длительность).`,
    );
  }
}

type EndKind = "dtend" | "duration" | "none" | "both";

function endKind(c: ICAL.Component): EndKind {
  const dtend = c.hasProperty("dtend");
  const duration = c.hasProperty("duration");
  return dtend && duration ? "both" : dtend ? "dtend" : duration ? "duration" : "none";
}

const END_NAMES: Readonly<Record<EndKind, string>> = { dtend: "DTEND", duration: "DURATION", none: "без конца", both: "DTEND и DURATION" };

/**
 * Длительность `c` против образца `ref` (О6, О8): та же форма конца, у
 * DURATION — то же значение, у DTEND — та же точная длительность (у дат — то
 * же число дней), а при `sameForm` DTEND ещё и в форме и поясе DTEND
 * образца. `period` — слот из RDATE;VALUE=PERIOD: длительность — его, а
 * конец — DURATION, если у образца конца нет. Возвращает описание расхождения.
 */
function spanProblem(
  ctx: Ctx,
  ref: ICAL.Component,
  c: ICAL.Component,
  period: { start: ICAL.Time; end: ICAL.Time } | undefined,
  sameForm: boolean,
): string | undefined {
  const refKind = endKind(ref);
  const kind = endKind(c);
  if (kind === "both" || refKind === "both") return undefined;
  const wanted: EndKind = period && refKind === "none" ? "duration" : refKind;
  if (kind !== wanted) return `конец записан как ${END_NAMES[kind]}, а должен — как ${END_NAMES[wanted]}`;
  if (kind === "none") return undefined;
  const env = ctx.env;
  const start = c.getFirstPropertyValue("dtstart") as ICAL.Time;
  if (period) {
    const want = instantOf(period.end, env) - instantOf(period.start, env);
    const got = endMs(c, env) - instantOf(start, env);
    return got === want ? undefined : `длительность ${got / 1000} с вместо ${want / 1000} с периода RDATE`;
  }
  if (kind === "duration") {
    const was = JSON.stringify(ref.getFirstProperty("duration")!.jCal.slice(3));
    const now = JSON.stringify(c.getFirstProperty("duration")!.jCal.slice(3));
    return was === now ? undefined : `DURATION ${rawTime(c.getFirstProperty("duration")!)} вместо ${rawTime(ref.getFirstProperty("duration")!)}`;
  }
  const refStart = ref.getFirstPropertyValue("dtstart") as ICAL.Time;
  const refEnd = ref.getFirstPropertyValue("dtend") as ICAL.Time;
  const end = c.getFirstPropertyValue("dtend") as ICAL.Time;
  if (refStart.isDate && refEnd.isDate) {
    const want = daysBetween(refStart, refEnd);
    const got = end.isDate && start.isDate ? daysBetween(start, end) : Number.NaN;
    if (got !== want) return `длительность ${Number.isNaN(got) ? "не в днях" : `${got} дн.`} вместо ${want} дн.`;
  } else {
    const want = instantOf(refEnd, env) - instantOf(refStart, env);
    const got = instantOf(end, env) - instantOf(start, env);
    if (got !== want) return `длительность ${got / 1000} с вместо ${want / 1000} с`;
  }
  if (sameForm) {
    const refProperty = ref.getFirstProperty("dtend")!;
    const property = c.getFirstProperty("dtend")!;
    if (formOf(property) !== formOf(refProperty) || String(property.getParameter("tzid") ?? "") !== String(refProperty.getParameter("tzid") ?? "")) {
      return `DTEND ${rawTime(property)} не в форме DTEND основного ${rawTime(refProperty)}`;
    }
  }
  return undefined;
}

// Конец компонента, мс: DTEND или DTSTART плюс DURATION, как складывает
// ical.js (time.js:1021, addDuration).
function endMs(c: ICAL.Component, env: IcalEnv): number {
  const dtend = c.getFirstPropertyValue("dtend");
  if (dtend instanceof ICAL.Time) return instantOf(dtend, env);
  const end = (c.getFirstPropertyValue("dtstart") as ICAL.Time).clone();
  const duration = c.getFirstPropertyValue("duration");
  if (duration instanceof ICAL.Duration) end.addDuration(duration);
  return instantOf(end, env);
}

// Дней между датами: по стенным полям, без поясов (time.js:1055, subtractDate
// складывает с utcOffset, то есть вычитает стенное время).
function daysBetween(start: ICAL.Time, end: ICAL.Time): number {
  return Math.round(end.subtractDate(start).toSeconds() / 86_400);
}

// Слот из RDATE;VALUE=PERIOD с ключом `key` — его начало и конец; иначе undefined.
function periodOf(ctx: Ctx, key: SlotKey): { start: ICAL.Time; end: ICAL.Time } | undefined {
  const master = ctx.before.master;
  if (!master || !master.getAllProperties("rdate").some((property) => property.type === "period")) return undefined;
  let slot: Slot | undefined;
  try {
    slot = findSlot(ctx.before, key);
  } catch (error) {
    if (!(error instanceof SlotScanError)) throw error;
  }
  return slot?.periodEnd ? { start: slot.time, end: slot.periodEnd } : undefined;
}

// Значение времени совпадает дословно: тип, jCal-строка и TZID.
function sameTimeValue(a: ICAL.Property, b: ICAL.Property): boolean {
  return a.type === b.type &&
    JSON.stringify(a.jCal.slice(3)) === JSON.stringify(b.jCal.slice(3)) &&
    String(a.getParameter("tzid") ?? "") === String(b.getParameter("tzid") ?? "");
}

// Значение свойства времени для сообщения: как записано, с TZID.
function rawTime(property: ICAL.Property): string {
  const tzid = property.getParameter("tzid");
  return `${tzid ? `${String(tzid)}:` : ""}${property.jCal.slice(3).map(String).join(",")}`;
}

/**
 * О7 для полей: у переопределения (не цели) поле из патча меняется, только
 * если совпадало с прежним основным, и тогда становится как у нового; своё
 * значение остаётся дословно. Совпадение — как у inheritFields (patch.ts),
 * но своё: текст — по первому значению; участники — по множеству
 * «адрес|PARTSTAT»; напоминания — по управляемым VALARM (DISPLAY и EMAIL со
 * сдвигом от начала).
 *
 * У скрытого переопределения (`hidden` — след прошлого удаления: RID под
 * EXDATE или вне протяжённости серии) требуется только первое: своё
 * значение цело. Встречи у него нет, показывать его наследование некому, и
 * следование за новым основным — дело планировщика, а не инвариант
 * объекта: О7 говорит о встречах. Требовать наследования у скрытых значило
 * бы отказывать верным планам на любой серии со следом удаления — а это те
 * самые объекты, ради которых идёт переделка.
 */
function checkInheritedFields(
  ctx: Ctx,
  oldMaster: ICAL.Component,
  newMaster: ICAL.Component,
  was: ICAL.Component,
  now: ICAL.Component,
  label: string,
  role: string | undefined,
): void {
  const lost: string[] = [];
  const stale: string[] = [];
  for (const field of INHERITED) {
    if (!ctx.fields.has(field)) continue;
    if (inheritedValue(was, field) !== inheritedValue(oldMaster, field)) {
      if (ownValue(was, field) !== ownValue(now, field)) lost.push(field);
    } else if (role !== "hidden" && !sameInherited(now, newMaster, field)) {
      stale.push(field);
    }
  }
  if (lost.length > 0) {
    ctx.findings.add(
      "override-field-lost",
      `У ${label} затёрто своё значение [${lost.join(", ")}]: правка серии меняет поле переопределения, только если оно совпадало с прежним основным (О7).`,
    );
  }
  if (stale.length > 0) {
    ctx.findings.add(
      "override-field-stale",
      `У ${label} [${stale.join(", ")}] совпадало с прежним основным, а за новым не последовало (О7).`,
    );
  }
}

// Значение поля для сравнения по О7; у текста отсутствие и пустая строка различаются, как в inheritFields.
function inheritedValue(c: ICAL.Component, field: PatchField): string {
  switch (field) {
    case "attendees":
      return JSON.stringify(c.getAllProperties("attendee").map((property) => `${addressOf(property)}|${partstatOf(property)}`).sort());
    case "reminders":
      return JSON.stringify(c.getAllSubcomponents("valarm").filter(managedAlarm).map(managedAlarmKey).sort());
    default: {
      const value = c.getFirstPropertyValue(field);
      return JSON.stringify(value === null || value === undefined ? null : String(value));
    }
  }
}

// Поле переопределения последовало за новым основным: у текста снятое и пустое — одно.
function sameInherited(c: ICAL.Component, master: ICAL.Component, field: PatchField): boolean {
  if (field === "attendees" || field === "reminders") return inheritedValue(c, field) === inheritedValue(master, field);
  const text = (x: ICAL.Component) => {
    const value = x.getFirstPropertyValue(field);
    return value === null || value === undefined ? "" : String(value);
  };
  return text(c) === text(master);
}

// Своё значение поля дословно: свойства по имени или управляемые VALARM целиком.
function ownValue(c: ICAL.Component, field: PatchField): string {
  if (field === "reminders") {
    return JSON.stringify(c.getAllSubcomponents("valarm").filter(managedAlarm).map((alarm) => JSON.stringify(alarm.jCal)).sort());
  }
  return JSON.stringify(groupsOf(c).get(FIELD_NAMES[field][0]) ?? []);
}

// Ключ управляемого VALARM: действие и сдвиг от начала в секундах.
function managedAlarmKey(alarm: ICAL.Component): string {
  const action = String(alarm.getFirstPropertyValue("action") ?? "").toUpperCase();
  const trigger = alarm.getFirstPropertyValue("trigger");
  return `${action}|${trigger instanceof ICAL.Duration ? trigger.toSeconds() : String(trigger)}`;
}

/**
 * Продолжение разреза против прочитанного: основной — клон прежнего
 * основного (новый UID, начало на B, конец правила, списки дат ≥ B, поля
 * патча; SEQUENCE и CREATED сняты; время — checkContinuationTime);
 * переопределения ≥ B — прежние с новым UID и сдвинутым по позиции RID,
 * поля по О7; до B — их нет.
 */
function compareContinuation(ctx: Ctx, cont: CalendarObject, b: SlotKey): void {
  const { before, findings } = ctx;
  // Продолжение — новый объект: свойства его VCALENDAR планировщик вправе
  // собрать заново, но описание пояса, общего с исходным, — прежнее (Ж10:
  // Яндекс хранит полную историю пояса, база — упрощённую).
  const zones = new Map(before.root.getAllSubcomponents("vtimezone").map((zone) => [String(zone.getFirstPropertyValue("tzid")), JSON.stringify(zone.jCal)]));
  for (const zone of cont.root.getAllSubcomponents("vtimezone")) {
    const tzid = String(zone.getFirstPropertyValue("tzid"));
    const was = zones.get(tzid);
    if (was !== undefined && was !== JSON.stringify(zone.jCal)) {
      findings.add("untouched-changed", `VTIMEZONE ${tzid} продолжения не тот, что в исходном объекте (Ж10).`);
    }
  }
  if (!before.master || !cont.master) {
    findings.add("meeting-lost", "У продолжения нет основного компонента.");
    return;
  }
  const own = [...ctx.fields].filter((field) => field !== "recurrence");
  const masterAllowed = new Set([...META, "uid", "created", ...TIME, "rrule", "exdate", "rdate", ...namesOf(ctx.fields)]);
  compareComponent(ctx, before.master, cont.master, masterAllowed, false, "основной компонент продолжения");
  checkContinuationTime(ctx, before.master, cont.master, b);

  const used = new Set<ICAL.Component>();
  for (const [key, refs] of before.overrides) {
    if (compareSlotKeys(key, b) < 0) continue;
    const role = roleOf(before, refs);
    const target = key === b;
    const label = `переопределение ${describeKey(before, key)}`;
    const afterRefs = pairsFor(ctx, key, role, cont, used);
    const allowed = new Set([...META, "uid", "created", "recurrence-id", ...namesOf(own.filter((f) => INHERITED.includes(f)))]);
    if (ctx.time || ctx.recurrence) for (const name of TIME) allowed.add(name);
    if (target) for (const name of namesOf(own)) allowed.add(name);
    for (const ref of refs) {
      const pair = afterRefs?.find((r) => !used.has(r.component));
      if (pair) {
        used.add(pair.component);
        compareComponent(ctx, ref.component, pair.component, allowed, false, `${label} в продолжении`);
        checkMovedStays(ctx, before, ref, cont, pair, target, label);
        if (target) checkKeptSpan(ctx, ref.component, pair.component, `${label} в продолжении`);
        if (!target) checkInheritedFields(ctx, before.master, cont.master, ref.component, pair.component, `${label} в продолжении`, role);
      } else if (!ctx.removed.has(key) && role !== "hidden") {
        findings.add("override-lost", `${capital(label)} не перенесено в продолжение (таблица §3: RID ≥ B — в продолжение).`);
      }
    }
  }
  for (const [key, refs] of cont.overrides) {
    for (const ref of refs) {
      if (!used.has(ref.component)) {
        findings.add("untouched-changed", `Лишний компонент в продолжении: переопределение ${describeKey(cont, key)}.`);
      }
    }
  }
}

/**
 * О7: перенесённая встреча стоит, где стояла (те же моменты начала и
 * конца), неперенесённая остаётся неперенесённой — идёт за серией. Цель
 * update this и граница t&f («B получает патч») — исключение; у all_series
 * исключения нет (isTarget).
 */
function checkMovedStays(
  ctx: Ctx,
  before: CalendarObject,
  ref: OverrideRef,
  after: CalendarObject,
  pair: OverrideRef,
  target: boolean,
  label: string,
): void {
  if (ctx.expect.op !== "update" || target) return;
  const wasMoved = isMoved(before, ref);
  const nowMoved = isMoved(after, pair);
  const env = ctx.env;
  if (wasMoved) {
    const same = (name: string) => {
      const a = ref.component.getFirstPropertyValue(name);
      const b = pair.component.getFirstPropertyValue(name);
      if (a instanceof ICAL.Time && b instanceof ICAL.Time) return a.isDate === b.isDate && instantOf(a, env) === instantOf(b, env);
      return JSON.stringify(ref.component.getFirstProperty(name)?.jCal.slice(3) ?? null) ===
        JSON.stringify(pair.component.getFirstProperty(name)?.jCal.slice(3) ?? null);
    };
    if (!same("dtstart") || !same("dtend") || !same("duration")) {
      ctx.findings.add("moved-shifted", `Перенесённая встреча (${label}) сдвинута: перенесённые остаются, где стоят (О7).`);
    }
  } else if (nowMoved) {
    ctx.findings.add("moved-shifted", `Неперенесённая встреча (${label}) отстала от серии: её начало не совпадает с новым адресом (О7).`);
  }
}

function isMoved(o: CalendarObject, ref: OverrideRef): boolean {
  const start = ref.component.getFirstPropertyValue("dtstart") as ICAL.Time;
  return start.isDate !== (o.form === "date") || slotKeyOf(start, o.form, o.env) !== ref.key;
}

/**
 * Чужие VALARM (О9): всё, кроме DISPLAY и EMAIL с TRIGGER-длительностью от
 * начала, — AUDIO, PROCEDURE, от конца, абсолютные. Их набор у компонента
 * после записи тот же, до значения.
 */
function checkForeignAlarms(ctx: Ctx, before: ICAL.Component, after: ICAL.Component, label: string): void {
  const foreign = (c: ICAL.Component) =>
    c.getAllSubcomponents("valarm").filter((alarm) => !managedAlarm(alarm)).map((alarm) => JSON.stringify(alarm.jCal)).sort();
  const was = foreign(before);
  const now = foreign(after);
  if (JSON.stringify(was) === JSON.stringify(now)) return;
  const actions = before.getAllSubcomponents("valarm").filter((alarm) => !managedAlarm(alarm))
    .map((alarm) => String(alarm.getFirstPropertyValue("action") ?? "?").toUpperCase());
  ctx.findings.add("alarm-lost", `У ${label} снят или изменён чужой VALARM (${actions.join(", ") || "новый"}): правка трогает только DISPLAY и EMAIL со сдвигом от начала (О9).`);
}

function managedAlarm(alarm: ICAL.Component): boolean {
  const action = String(alarm.getFirstPropertyValue("action") ?? "").toUpperCase();
  if (action !== "DISPLAY" && action !== "EMAIL") return false;
  const trigger = alarm.getFirstProperty("trigger");
  if (!trigger || trigger.type !== "duration") return false;
  return String(trigger.getParameter("related") ?? "START").toUpperCase() === "START";
}

// Свойства и подкомпоненты по имени: списки jCal-строк в порядке файла.
function groupsOf(c: ICAL.Component): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  const push = (name: string, value: unknown) => {
    const list = groups.get(name) ?? [];
    list.push(JSON.stringify(value));
    groups.set(name, list);
  };
  for (const property of c.jCal[1] as unknown[][]) push(String(property[0]), property);
  for (const sub of c.jCal[2] as unknown[][]) push(String(sub[0]), sub);
  return groups;
}

function diffNames(a: Map<string, string[]>, b: Map<string, string[]>): string[] {
  const names = new Set([...a.keys(), ...b.keys()]);
  return [...names].filter((name) => JSON.stringify(a.get(name) ?? []) !== JSON.stringify(b.get(name) ?? []));
}

/** Опознание компонента между деревом планировщика и разобранным текстом: имя, UID, RECURRENCE-ID как записан. */
function identityOf(c: ICAL.Component): string {
  if (c.name === "vcalendar") return "vcalendar";
  if (c.name === "vtimezone") return `vtimezone|${String(c.getFirstPropertyValue("tzid") ?? "")}`;
  const uid = String(c.getFirstPropertyValue("uid") ?? "");
  const rid = c.getFirstProperty("recurrence-id");
  if (!rid) return `${c.name}|${uid}|master`;
  return `${c.name}|${uid}|${JSON.stringify(rid.jCal[3])}|${String(rid.getParameter("tzid") ?? "")}`;
}

// ─────────────────────────────── (в) видимые встречи ───────────────────────────────

/** Видимая встреча по адресу: незакрытый слот или оторванное переопределение. */
interface Entry {
  key: SlotKey;
  /** Время адреса в форме серии (слот или RECURRENCE-ID). */
  time: ICAL.Time;
  /** У встречи свой компонент: переопределение слота или detached. */
  own: boolean;
  detached: boolean;
}

type Extent = { kind: "infinite" } | { kind: "finite"; count: number; last?: Slot } | { kind: "unknown" };

interface Scan {
  o: CalendarObject;
  /** Видимые встречи до границы прохода; detached — все. */
  entries: Map<SlotKey, Entry>;
  /** Слоты, закрытые EXDATE (EXRULE), до границы прохода. */
  closed: Set<SlotKey>;
  /** Последний слот, вошедший в проход. */
  bound?: SlotKey;
  /** Слоты серии кончились в пределах прохода. */
  ended: boolean;
  /** Протяжённость: у конечной серии — полным проходом, если его просили. */
  extent: Extent;
  /** Серия длиннее SERIES_CAP, а проход был мягким: встречи не собраны. */
  tooLong?: boolean;
}

/**
 * Проход слотов объекта: видимые встречи до `until` и ещё
 * GUARD_EXTRA_SLOTS видимых слотов; при `full` у конечной серии — дальше до
 * конца, для протяжённости (О12д) за тот же проход. Больше SERIES_CAP
 * слотов или сбой итератора — `series-too-long`; при `lenient` предел
 * прохода — не ошибка, а пометка `tooLong` (запасной путь правки, не
 * меняющей слотов).
 */
function scan(ctx: Ctx, o: CalendarObject, until: SlotKey, full: boolean, lenient = false): Scan {
  const entries = new Map<SlotKey, Entry>();
  const closed = new Set<SlotKey>();
  const finite = isFiniteSeries(o);
  let bound: SlotKey | undefined;
  let storing = true;
  let beyond = 0;
  let count = 0;
  let last: Slot | undefined;
  let broke = false;

  if (o.master) {
    try {
      for (const slot of iterateSlots(o)) {
        if (++count > SERIES_CAP) {
          if (lenient) return { o, entries: new Map(), closed: new Set(), ended: false, extent: { kind: "unknown" }, tooLong: true };
          ctx.findings.fail("series-too-long", `Серия ${o.uid} длиннее ${SERIES_CAP} встреч до горизонта проверки: план не проверить.`);
        }
        if (storing && compareSlotKeys(slot.key, until) > 0 && !slot.excluded && ++beyond > GUARD_EXTRA_SLOTS) storing = false;
        if (storing) {
          last = slot;
          bound = slot.key;
          if (slot.excluded) closed.add(slot.key);
          else entries.set(slot.key, { key: slot.key, time: slot.time, own: hasSlotOverride(o, slot.key), detached: false });
          continue;
        }
        last = slot;
        if (!(full && finite)) {
          broke = true;
          break;
        }
      }
    } catch (error) {
      if (!(error instanceof SlotScanError)) throw error;
      ctx.findings.fail("series-too-long", `Перебор серии ${o.uid} сбился (${error.message}): план не проверить.`);
    }
  }
  for (const [key, refs] of o.overrides) {
    if (roleOf(o, refs) !== "detached") continue;
    entries.set(key, { key, time: inSeriesForm(o, refs[0].recurrenceId), own: true, detached: true });
  }
  let extent: Extent;
  if (!finite) extent = { kind: "infinite" };
  else if (broke) extent = { kind: "unknown" };
  else extent = { kind: "finite", count, last };
  return { o, entries, closed, bound, ended: storing && !broke, extent };
}

interface VisibleRule {
  /** Где сверяются встречи — для сообщений. */
  where: string;
  /** Какие прежние ключи участвуют. */
  participates(key: SlotKey): boolean;
  /** Ключи, под которыми прежняя встреча (или закрытый слот) может стоять после записи. */
  options(key: SlotKey, detached: boolean): SlotKey[];
  /** Смена повтора: сверяются только встречи со своими компонентами, слоты — по новому правилу. */
  explicitOnly?: boolean;
  /** Новые слоты после `cutoff` не проверяются (дальше прохода прежней серии); undefined — все. */
  cutoff?: SlotKey;
}

/**
 * (в): каждая прежняя видимая встреча (кроме `removed`) есть после записи
 * под одним из своих ключей и не слилась с другой; переопределение осталось
 * переопределением; без правки повтора дата прежняя; новых встреч нет;
 * слот, закрытый EXDATE, не ожил.
 */
function compareVisible(ctx: Ctx, b: Scan, a: Scan, rule: VisibleRule): void {
  const { findings, removed } = ctx;
  const lost: string[] = [];
  const merged: string[] = [];
  const ownLost: string[] = [];
  const shifted: string[] = [];
  const added: string[] = [];
  const kept: string[] = [];
  const lifted: string[] = [];
  const consumed = new Set<SlotKey>();
  const liftedKeys = new Set<SlotKey>();

  // Слоты, закрытые EXDATE, не оживают — и при смене повтора.
  for (const key of b.closed) {
    if (!rule.participates(key)) continue;
    for (const option of rule.options(key, false)) {
      const now = a.entries.get(option);
      if (now && !now.detached) {
        liftedKeys.add(option);
        lifted.push(describeKey(b.o, key));
        break;
      }
    }
  }

  const ordered = [...b.entries.values()].sort((x, y) => compareSlotKeys(x.key, y.key));
  for (const entry of ordered) {
    if (!rule.participates(entry.key) || removed.has(entry.key)) continue;
    if (rule.explicitOnly && !entry.own) continue;
    const options = rule.options(entry.key, entry.detached);
    const found = options.find((option) => a.entries.has(option) && !consumed.has(option));
    if (found === undefined) {
      if (options.some((option) => consumed.has(option))) merged.push(describeEntry(b.o, entry));
      else if (entry.own) ownLost.push(describeEntry(b.o, entry));
      else lost.push(describeEntry(b.o, entry));
      continue;
    }
    consumed.add(found);
    const now = a.entries.get(found)!;
    if (entry.own && !now.own) ownLost.push(describeEntry(b.o, entry));
    if (ctx.datesMustStay && found !== entry.key && dateOfEntry(ctx, entry) !== dateOfEntry(ctx, now)) {
      shifted.push(`${describeEntry(b.o, entry)} → ${describeEntry(a.o, now)}`);
    }
  }

  const removedNow = new Set<SlotKey>();
  for (const key of removed) {
    if (!rule.participates(key)) continue;
    for (const option of [key, ctx.softMapKey(key) ?? key]) removedNow.add(option);
  }
  const orderedAfter = [...a.entries.values()].sort((x, y) => compareSlotKeys(x.key, y.key));
  for (const entry of orderedAfter) {
    if (consumed.has(entry.key) || liftedKeys.has(entry.key)) continue;
    // Названная убранной — и при смене повтора: переопределение, у которого
    // в новом правиле есть пара, снимать нельзя (Р1, «по ключу»).
    if (removedNow.has(entry.key)) {
      kept.push(describeEntry(a.o, entry));
      continue;
    }
    if (rule.explicitOnly && !entry.own) continue;
    if (!entry.detached && rule.cutoff !== undefined && sameKind(entry.key, rule.cutoff) && compareSlotKeys(entry.key, rule.cutoff) > 0) continue;
    added.push(describeEntry(a.o, entry));
  }

  const where = rule.where;
  if (lifted.length) findings.add("exdate-lifted", `Снят EXDATE: удалённые встречи ${listed(lifted)} ${where} снова видны.`);
  if (lost.length) findings.add("meeting-lost", `Пропали встречи ${listed(lost)}: их нет ${where}, а план их не убирал.`);
  if (merged.length) findings.add("meeting-lost", `Встречи ${listed(merged)} ${where} слились с другими: keyMap отдал им занятый ключ.`);
  if (ownLost.length) findings.add("override-lost", `Потеряны переопределения ${listed(ownLost)}: ${where} на их месте нет своей встречи.`);
  if (shifted.length) findings.add("date-shifted", `Сдвинулись даты встреч ${listed(shifted)}, а даты должны остаться (Р1).`);
  if (added.length) findings.add("meeting-added", `Лишние встречи ${where}: ${listed(added)} — их не было.`);
  if (kept.length) findings.add("meeting-added", `Встречи ${listed(kept)} названы убранными, а ${where} остались.`);
}

// Ключи, под которыми прежняя встреча может стоять после записи: у слота —
// образ по keyMap; у detached — прежний ключ, а если там встречи нет, образ
// (сдвиг по позиции у него не определён, и keyMap его знать не обязан).
function optionsFor(ctx: Ctx, key: SlotKey, detached: boolean, a: Scan): SlotKey[] {
  if (!detached) return [ctx.mapKey(key)];
  if (a.entries.has(key)) return [key];
  const image = ctx.softMapKey(key);
  return image === undefined ? [key] : [image];
}

function dateOfEntry(ctx: Ctx, entry: Entry): string {
  return wallDateOf(entry.time, ctx.env);
}

/**
 * Р2: «эта и следующие» одним put (как all_series) — только если до
 * границы нет видимых встреч, в том числе перенесённых туда с поздних
 * слотов. Иначе такая запись переписала бы и встречи до B.
 */
function checkNothingBeforeBoundary(ctx: Ctx): void {
  const { before, env } = ctx;
  const b = ctx.target;
  if (b === undefined) return;
  const bMs = keyMs(b, env);
  const early: string[] = [];
  for (const [key, refs] of before.overrides) {
    const role = roleOf(before, refs);
    if (role === "hidden") continue;
    const start = refs[0].component.getFirstPropertyValue("dtstart") as ICAL.Time;
    if (compareSlotKeys(key, b) < 0 || instantOf(start, env) < bMs) early.push(describeKey(before, key));
  }
  if (before.master) {
    try {
      let steps = 0;
      for (const slot of iterateSlots(before, { until: b })) {
        if (++steps > SERIES_CAP) break;
        if (slot.key === b) break;
        if (!slot.excluded) {
          early.push(formatForModel(slot.time, env, "instance"));
          break;
        }
      }
    } catch (error) {
      if (!(error instanceof SlotScanError)) throw error;
    }
  }
  if (early.length > 0) {
    ctx.findings.add(
      "plan-shape",
      `«Эта и следующие» записана как правка всей серии, а до границы ${describeKey(before, b)} есть встречи: ${listed(early)}. Нужен разрез (Р2, Р9).`,
    );
  }
}

// ─────────────────────────────── (д) протяжённость ───────────────────────────────

/**
 * (д) у правки. Без правки повтора даты — прежние (Р1), значит у конечной
 * серии прежние число слотов и последняя встреча (через keyMap), у
 * бесконечной — бесконечность; у продолжения разреза — прежний хвост от B.
 * С правкой повтора сверять не с чем, кроме `expect.tail`, и он обязателен
 * у конечной серии. `tail`, если задан, сверяется всегда.
 */
function checkExtent(ctx: Ctx, b: Scan, a: Scan, where: string, boundary?: SlotKey): void {
  const { findings } = ctx;
  if (!ctx.recurrence) {
    if (b.extent.kind === "infinite") {
      if (a.extent.kind !== "infinite") findings.add("extent-mismatch", `Серия была бесконечной, а ${where} конечна — правка без повтора так не меняет.`);
    } else if (b.extent.kind === "finite") {
      const beforeCount = boundary === undefined ? b.extent.count : tailCount(ctx, boundary);
      const lastKey = b.extent.last ? ctx.mapKey(b.extent.last.key) : undefined;
      if (a.extent.kind !== "finite") {
        findings.add("extent-mismatch", `Конечная серия ${where} стала ${a.extent.kind === "infinite" ? "бесконечной" : "непроверяемой"}.`);
      } else if (a.extent.count !== beforeCount || a.extent.last?.key !== lastKey) {
        findings.add(
          "extent-mismatch",
          `Протяжённость ${where}: ${a.extent.count} встреч до ${describeLast(a)}, а должно остаться ${beforeCount} до ` +
            `${lastKey === undefined ? "—" : describeKey(a.o, lastKey)} — последняя встреча потеряна или добавлена (UNTIL, COUNT).`,
        );
      }
    }
  }
  const finite = a.extent.kind === "finite";
  if (ctx.expect.tail === undefined) {
    if (finite && ctx.recurrence) {
      findings.add("extent-mismatch", `План меняет правило, а протяжённость конечной серии ${where} (expect.tail) не назвал: сверить не с чем (О12д).`);
    }
    return;
  }
  checkTail(ctx, a.extent, where);
}

function checkTail(ctx: Ctx, extent: Extent, where: string): void {
  const tail = ctx.expect.tail;
  if (tail === undefined) return;
  if (extent.kind !== "finite") {
    ctx.findings.add("extent-mismatch", `План ждёт конечную серию (${tail.count} встреч), а ${where} она ${extent.kind === "infinite" ? "бесконечна" : "не пройдена"}.`);
    return;
  }
  const lastDate = extent.last ? wallDateOf(extent.last.time, ctx.env) : undefined;
  if (extent.count !== tail.count || (tail.lastDate !== undefined && lastDate !== tail.lastDate)) {
    ctx.findings.add(
      "extent-mismatch",
      `Протяжённость ${where} — ${extent.count} встреч до ${lastDate ?? "—"}, а план ждёт ${tail.count} до ${tail.lastDate ?? "—"} (О12д).`,
    );
  }
}

// Число слотов прочитанной серии от B до конца (полным проходом).
function tailCount(ctx: Ctx, boundary: SlotKey): number {
  let count = 0;
  let steps = 0;
  try {
    for (const slot of iterateSlots(ctx.before)) {
      if (++steps > SERIES_CAP) ctx.findings.fail("series-too-long", `Серия ${ctx.before.uid} длиннее ${SERIES_CAP} встреч: хвост не проверить.`);
      if (compareSlotKeys(slot.key, boundary) >= 0) count += 1;
    }
  } catch (error) {
    if (!(error instanceof SlotScanError)) throw error;
    ctx.findings.fail("series-too-long", `Перебор серии ${ctx.before.uid} сбился (${error.message}).`);
  }
  return count;
}

/**
 * Усечение (t&f): слоты усечённой серии — ровно слоты прочитанной до B, с
 * теми же закрытыми EXDATE; серия конечна; переопределений с ключом ≥ B в
 * ней нет (иначе остались бы скрытые следы).
 */
function checkTruncation(ctx: Ctx, t: CalendarObject, b: SlotKey, label: string): void {
  const { before, findings } = ctx;
  const add = (message: string) => findings.add("truncation-mismatch", `${capital(label)}: ${message}`);
  for (const [key] of t.overrides) {
    if (compareSlotKeys(key, b) >= 0) add(`переопределение ${describeKey(t, key)} за границей ${describeKey(before, b)} осталось.`);
  }
  if (!before.master) return;
  if (!t.master) {
    add("снят основной компонент.");
    return;
  }
  if (!isFiniteSeries(t)) add("серия осталась бесконечной.");
  const expected: Array<{ key: SlotKey; excluded: boolean }> = [];
  try {
    let steps = 0;
    for (const slot of iterateSlots(before, { until: b })) {
      if (++steps > SERIES_CAP) findings.fail("series-too-long", `Серия ${before.uid} длиннее ${SERIES_CAP} встреч до границы.`);
      if (compareSlotKeys(slot.key, b) >= 0) break;
      expected.push({ key: slot.key, excluded: slot.excluded });
    }
    let index = 0;
    let steps2 = 0;
    for (const slot of iterateSlots(t)) {
      if (++steps2 > SERIES_CAP || index >= expected.length) {
        add(`лишняя встреча ${formatForModel(slot.time, ctx.env, "instance")}: после усечения встреч до ${describeKey(before, b)} должно быть ${expected.length}.`);
        return;
      }
      const want = expected[index];
      if (slot.key !== want.key || slot.excluded !== want.excluded) {
        add(`встреча ${formatForModel(slot.time, ctx.env, "instance")}${slot.excluded ? " (закрыта)" : ""} вместо ${describeKey(before, want.key)}${want.excluded ? " (закрыта)" : ""}.`);
        return;
      }
      index += 1;
    }
    if (index < expected.length) add(`пропала встреча ${describeKey(before, expected[index].key)} до границы.`);
  } catch (error) {
    if (!(error instanceof SlotScanError)) throw error;
    findings.fail("series-too-long", `Перебор серии сбился (${error.message}).`);
  }
}

/** Р3: запись, после которой в объекте нет живых встреч, — это удаление объекта, а не put зомби. */
function checkNotEmptied(ctx: Ctx, after: CalendarObject, what: string): void {
  if (!objectIsEmpty(after)) return;
  if (objectIsEmpty(ctx.before)) return;
  ctx.findings.add("empty-left", `${what} оставляет объект без живых встреч: такой объект удаляется целиком (Р3), а не записывается.`);
}

// Пусто: нет detached и ни одного незакрытого слота; полным проходом до
// первого незакрытого (как isEmpty в slots.ts: сбой и предел — «не пусто»).
function objectIsEmpty(o: CalendarObject): boolean {
  for (const refs of o.overrides.values()) if (roleOf(o, refs) === "detached") return false;
  if (!o.master) return true;
  let steps = 0;
  try {
    for (const slot of iterateSlots(o)) {
      if (!slot.excluded) return false;
      if (++steps >= SERIES_CAP) return false;
    }
  } catch (error) {
    if (error instanceof SlotScanError) return false;
    throw error;
  }
  return true;
}

// ─────────────────────────────── ключи и горизонт ───────────────────────────────

/** Горизонт О12в: max(сейчас, цель, явные ключи всех объектов) + 400 дней, мс Unix. */
function horizonMs(ctx: Ctx, objects: readonly CalendarObject[]): number {
  let max = ctx.nowMs;
  if (ctx.target !== undefined) max = Math.max(max, keyMs(ctx.target, ctx.env));
  for (const o of objects) {
    const keys: SlotKey[] = [...o.overrides.keys()];
    if (o.master) keys.push(...listKeys(o.master, "exdate", o), ...listKeys(o.master, "rdate", o));
    for (const key of keys) max = Math.max(max, keyMs(key, ctx.env));
  }
  return max + GUARD_HORIZON_DAYS * DAY_MS;
}

/** Момент ключа: T — секунды; D — полночь даты, F — стенное время, оба в поясе календаря (values.ts, instantOf). */
function keyMs(key: SlotKey, env: IcalEnv): number {
  if (key.startsWith("T:")) return Number(key.slice(2)) * 1000;
  return instantOf(parseModelTime(key.slice(2)).time, env);
}

/** Ключ момента `ms` в форме объекта: дата и плавающее — стенное время пояса календаря. */
function keyAtMs(o: CalendarObject, ms: number): SlotKey {
  const seconds = Math.floor(ms / 1000);
  if (o.form === "utc" || o.form === "zoned") return `T:${seconds}`;
  // time.js:1313, fromUnixTime — поля через UTC, от пояса процесса не зависят.
  const utc = ICAL.Time.fromData({ year: 1970, month: 1, day: 1, hour: 0, minute: 0, second: 0, isDate: false }, ICAL.Timezone.utcTimezone);
  utc.fromUnixTime(seconds);
  return slotKeyOf(timeInForm(utc, "floating", undefined, o.env), o.form, o.env);
}

function sameKind(a: SlotKey, b: SlotKey): boolean {
  return a[0] === b[0];
}

// ─────────────────────────────── мелочи ───────────────────────────────

// recur.js:301, isFinite — COUNT или UNTIL. У непригодного правила слоты
// правил не читают (slots.ts, specOf) — такая серия конечна.
function isFiniteSeries(o: CalendarObject): boolean {
  if (!o.master) return true;
  if (o.anomalies.some((anomaly) => anomaly.code === "bad-rrule" || anomaly.code === "no-positions")) return true;
  return o.master.getAllProperties("rrule").every((property) => (property.getFirstValue() as ICAL.Recur).isFinite());
}

function roleOf(o: CalendarObject, refs: readonly OverrideRef[]): string | undefined {
  return refs.length > 0 ? o.roles.get(refs[0].component)?.role : undefined;
}

function hasSlotOverride(o: CalendarObject, key: SlotKey): boolean {
  return roleOf(o, o.overrides.get(key) ?? []) === "slot";
}

function inSeriesForm(o: CalendarObject, t: ICAL.Time): ICAL.Time {
  try {
    return timeInForm(t, o.form, o.zone, o.env);
  } catch {
    return t.clone();
  }
}

/** Адрес ключа для сообщения (формат Р10). */
function describeKey(o: CalendarObject, key: SlotKey): string {
  try {
    if (key.startsWith("D:")) return key.slice(2);
    if (key.startsWith("F:")) return formatForModel(parseModelTime(key.slice(2)).time, o.env, "instance");
    const utc = ICAL.Time.fromData({ year: 1970, month: 1, day: 1, hour: 0, minute: 0, second: 0, isDate: false }, ICAL.Timezone.utcTimezone);
    utc.fromUnixTime(Number(key.slice(2)));
    return formatForModel(o.form === "zoned" ? inSeriesForm(o, utc) : utc, o.env, "instance");
  } catch {
    return key;
  }
}

function describeEntry(o: CalendarObject, entry: Entry): string {
  return describeKey(o, entry.key);
}

function describeLast(s: Scan): string {
  return s.extent.kind === "finite" && s.extent.last ? formatForModel(s.extent.last.time, s.o.env, "instance") : "—";
}

function componentLabel(o: CalendarObject, c: ICAL.Component): string {
  const rid = c.getFirstProperty("recurrence-id");
  if (!rid) return "основного компонента";
  return `переопределения ${describeKey(o, slotKeyOf(rid.getFirstValue() as ICAL.Time, o.form, o.env))}`;
}

function countBy<T>(values: readonly T[]): Map<T, number> {
  const counts = new Map<T, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function listed(items: readonly string[]): string {
  if (items.length <= LIST_LIMIT) return items.join(", ");
  return `${items.slice(0, LIST_LIMIT).join(", ")} и ещё ${items.length - LIST_LIMIT}`;
}

function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
