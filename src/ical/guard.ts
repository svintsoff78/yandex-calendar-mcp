import ICAL from "ical.js";
import {
  blockingAnomalies,
  isUnparsable,
  loadObject,
  serializeObject,
  type CalendarObject,
  type OverrideRef,
} from "./object.js";
import type { Expectation, PatchField, WritePlan } from "./plan.js";
import { SERIES_CAP, SlotScanError, iterateSlots, type Slot } from "./slots.js";
import {
  compareSlotKeys,
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
 *   объекта из доменной модели;
 * - (в) видимые встречи после записи — прежние через `keyMap` минус
 *   `removed`: ни одна не пропала и не появилась, переопределение осталось
 *   переопределением, EXDATE не снят; без правки повтора даты встреч
 *   прежние (Р1: из `start` берётся только время суток — даже если план не
 *   поднял `datesFixed`); перенесённая встреча стоит, где стояла, а
 *   неперенесённая идёт за серией (О7). Горизонт — от первого слота до
 *   max(сейчас, цель, последний явный ключ) + 400 дней и ещё 5 видимых
 *   слотов (О12в); явные ключи — RECURRENCE-ID, EXDATE и RDATE обеих
 *   сторон, поэтому все явные значения внутри горизонта. Сверяются все
 *   встречи от первого слота; перебор ограничен SERIES_CAP (200 000
 *   слотов), как у планировщика. «Окно от цели − 400 дней» из О12в здесь не
 *   нужно: итератор ical.js всё равно идёт от DTSTART, а сверка лёгких
 *   записей дешевле самого перебора — окно только ослабило бы проверку;
 * - (г) `delete-object` при scope ≠ all_series — только если после
 *   удаления названных встреч в объекте не осталось ни одной живой: полным
 *   проходом, без горизонта (Р3);
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
 * перебор слотов — около 0,1 с.
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
 *   «эта и следующие» одним put при встречах до границы, `keyMap` бросил);
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
 * - `keyMap` — прежний ключ → ключ после записи; вызывается для ключей
 *   слотов (в том числе закрытых EXDATE), переопределений и значений
 *   EXDATE, у разреза — только для ключей ≥ B; у оторванных (detached) и
 *   скрытых переопределений допустим и прежний ключ;
 * - `removed` — прежние ключи (до `keyMap`) видимых встреч, которые план
 *   убирает; у delete this цель входит туда и без того; у delete-object —
 *   все живые встречи, кроме отрезанных границей t&f;
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
  const ctx = makeContext(before, plan, env, findings, nowOf(options));

  checkBlocking(ctx, plan.kind === "split");
  findings.throwIfAny();

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
  removed: ReadonlySet<SlotKey>;
  /** Цель (у t&f — граница B), в ключах прочитанного объекта. */
  target?: SlotKey;
  /** Разрез: граница B; ключи раньше неё остаются в исходной серии как есть. */
  boundary?: SlotKey;
  touchedNames: Map<string, Set<string>>;
  touchedComponents: Set<string>;
  /**
   * Прежний ключ → ключ после записи по `expect.keyMap` (без него — тот же).
   * У разреза ключи раньше границы не отображаются: они остаются в исходной
   * серии как были.
   */
  mapKey(key: SlotKey): SlotKey;
}

const TIME_FIELDS: readonly PatchField[] = ["start", "end", "timeZone", "allDay"];

function makeContext(before: CalendarObject, plan: WritePlan, env: IcalEnv, findings: Findings, nowMs: number): Ctx {
  const expect = plan.expect;
  const boundary = plan.kind === "split" ? expect.target ?? plan.boundary : undefined;
  const fields = expect.fields;
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
  let reported = false;
  const mapKey = (key: SlotKey): SlotKey => {
    if (!expect.keyMap) return key;
    if (boundary !== undefined && sameKind(key, boundary) && compareSlotKeys(key, boundary) < 0) return key;
    const known = mapped.get(key);
    if (known !== undefined) return known;
    let result: SlotKey = key;
    try {
      const value: unknown = expect.keyMap(key);
      if (typeof value === "string" && /^[DTF]:/.test(value)) result = value as SlotKey;
      else throw new Error(`вернул ${JSON.stringify(value)}`);
    } catch (error) {
      if (!reported) {
        findings.add("plan-shape", `keyMap плана не отобразил ключ ${key}: ${messageOf(error)}. План нельзя сверить с прочитанным объектом.`);
        reported = true;
      }
    }
    mapped.set(key, result);
    return result;
  };

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
    // Цель delete this убирается по определению операции; не убрал — «названа
    // убранной, а осталась».
    removed: new Set(expect.op === "delete" && expect.scope === "this" && expect.target !== undefined
      ? [...expect.removed, expect.target]
      : expect.removed),
    target: expect.target ?? boundary,
    boundary,
    touchedNames,
    touchedComponents,
    mapKey,
  };
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
  const cut = (key: SlotKey) => boundary !== undefined && compareSlotKeys(key, boundary) >= 0;
  const alive: string[] = [];

  for (const [key, refs] of before.overrides) {
    if (roleOf(before, refs) !== "detached" || removed.has(key) || cut(key)) continue;
    alive.push(`${describeKey(before, key)} (отдельная встреча)`);
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
  const after = loadWritten(ctx, ics, "записываемый объект");
  const truncation = expect.op === "delete" && expect.scope === "this_and_following";
  const degenerateSplit = expect.op === "update" && expect.scope === "this_and_following";
  if (degenerateSplit) checkNothingBeforeBoundary(ctx);

  checkInvariants(ctx, after, "записываемый объект", before.uid);
  compareTrees(ctx, after);

  const horizon = horizonMs(ctx, [before, after]);
  const needExtent = expect.op === "update" && (ctx.time || ctx.recurrence || expect.ruleChanged || expect.tail !== undefined);
  const beforeScan = scan(ctx, before, keyAtMs(before, horizon), needExtent || truncation);

  if (truncation) {
    const b = ctx.target!;
    checkTruncation(ctx, after, b, "записываемый объект");
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
  } else {
    const explicitOnly = ctx.recurrence;
    const cutoffKey = beforeScan.bound === undefined ? undefined : ctx.mapKey(beforeScan.bound);
    let afterUntil = keyAtMs(after, horizon);
    if (cutoffKey !== undefined && sameKind(cutoffKey, afterUntil) && compareSlotKeys(cutoffKey, afterUntil) > 0) afterUntil = cutoffKey;
    const afterScan = scan(ctx, after, afterUntil, needExtent);
    compareVisible(ctx, beforeScan, afterScan, {
      where: "после записи",
      participates: () => true,
      options: (key, detached) => optionsFor(ctx, key, detached),
      explicitOnly,
      cutoff: beforeScan.ended ? undefined : cutoffKey,
    });
    if (expect.op === "update" && before.master) checkExtent(ctx, beforeScan, afterScan, "после записи");
  }
  checkNotEmptied(ctx, after, "Запись");
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
    options: (key, detached) => optionsFor(ctx, key, detached),
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
  for (const [key, refs] of before.overrides) {
    for (const k of new Set([key, ctx.mapKey(key)])) beforeOverrideCounts.set(k, Math.max(beforeOverrideCounts.get(k) ?? 0, refs.length));
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
        for (const k of new Set([key, ctx.mapKey(key)])) beforeExdates.set(k, Math.max(beforeExdates.get(k) ?? 0, count));
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
 * Что операция может менять в компоненте (О5–О10, таблица §3) — независимо
 * от отметок планировщика:
 * - update this — только компонент цели (у одиночного события — основной):
 *   метаданные и поля патча;
 * - update all_series (и t&f, равная all_series по Р2) — основной: поля
 *   патча, при правке времени или повтора — ещё RRULE, EXDATE, RDATE (сдвиг
 *   по Р1, пересчёт UNTIL); переопределения: поля по О7 и при правке
 *   времени или повтора — время и RECURRENCE-ID (сдвиг по позиции);
 * - delete this — основной: EXDATE и RDATE;
 * - delete t&f и усечение при разрезе — основной: RRULE (конец), EXDATE,
 *   RDATE; переопределения до B не меняются.
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
    const isTarget = place.kind === "override" ? place.target : ctx.before.kind === "single";
    if (!isTarget) return new Set();
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
 * touched.components.
 */
function compareTrees(ctx: Ctx, after: CalendarObject, options: TreeOptions = {}): void {
  const { before, findings, expect } = ctx;
  const splitting = options.boundary !== undefined;
  compareRoot(ctx, before.root, after.root);

  if (before.master) {
    if (!after.master) findings.add("untouched-changed", "Снят основной компонент серии.");
    else compareComponent(ctx, before.master, after.master, permitted(ctx, { kind: "master" }, splitting), true, "основной компонент");
  } else if (after.master) {
    findings.add("untouched-changed", "У объекта из одних переопределений появился основной компонент.");
  }

  const used = new Set<ICAL.Component>();
  for (const [key, refs] of before.overrides) {
    const role = roleOf(before, refs);
    const target = ctx.target !== undefined && key === ctx.target;
    const label = `переопределение ${describeKey(before, key)}`;
    if (options.boundary !== undefined && compareSlotKeys(key, options.boundary) >= 0) {
      // Уходит в продолжение: в усечённом объекте его быть не должно.
      for (const ref of refs) requireTouchedRemoval(ctx, ref.component, label);
      continue;
    }
    const candidates = overrideOptions(ctx, key, role);
    const place: Place = { kind: "override", key, target };
    const afterRefs = candidates.map((k) => after.overrides.get(k)).find((list) => list && list.some((ref) => !used.has(ref.component)));
    for (const ref of refs) {
      const pair = afterRefs?.find((r) => !used.has(r.component));
      if (pair) {
        used.add(pair.component);
        compareComponent(ctx, ref.component, pair.component, permitted(ctx, place, splitting), true, label);
        checkMovedStays(ctx, before, ref, after, pair, target, label);
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
      if (before.master) compareClone(ctx, before.master, ref.component, label);
    }
  }
}

// Где искать пару прежнего переопределения после записи: у слота — его
// образ по keyMap; у detached и hidden — прежний ключ или образ (сдвиг по
// позиции у них не определён).
function overrideOptions(ctx: Ctx, key: SlotKey, role: string | undefined): SlotKey[] {
  if (role === "slot") return [ctx.mapKey(key)];
  return [...new Set([key, ctx.mapKey(key)])];
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
 * `requireTouched` — отмечено в touched.names. Чужие VALARM — всегда прежние.
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
  checkForeignAlarms(ctx, before, after, label);
}

/** Клон основного (О6): всё, кроме RRULE, RDATE, EXDATE, EXRULE, времени, RID, метаданных и полей патча, — как у основного. */
function compareClone(ctx: Ctx, master: ICAL.Component, clone: ICAL.Component, label: string): void {
  const own = [...ctx.fields].filter((field) => field !== "recurrence");
  const allowed = new Set([...META, ...TIME, "recurrence-id", ...SERIES_ONLY, ...namesOf(own)]);
  compareComponent(ctx, master, clone, allowed, false, label);
  for (const name of SERIES_ONLY) {
    if (clone.hasProperty(name)) ctx.findings.add("invariant", `У ${label} есть ${name.toUpperCase()}: переопределение не несёт правила (О6).`);
  }
}

/**
 * Продолжение разреза против прочитанного: основной — клон прежнего
 * основного (новый UID, начало на B, конец правила, списки дат ≥ B, поля
 * патча; SEQUENCE и CREATED сняты); переопределения ≥ B — прежние с новым
 * UID и сдвинутым по позиции RID, поля по О7; до B — их нет.
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

  const used = new Set<ICAL.Component>();
  for (const [key, refs] of before.overrides) {
    if (compareSlotKeys(key, b) < 0) continue;
    const role = roleOf(before, refs);
    const target = key === b;
    const label = `переопределение ${describeKey(before, key)}`;
    const candidates = overrideOptions(ctx, key, role);
    const afterRefs = candidates.map((k) => cont.overrides.get(k)).find((list) => list && list.some((ref) => !used.has(ref.component)));
    const allowed = new Set([...META, "uid", "created", "recurrence-id", ...namesOf(own.filter((f) => INHERITED.includes(f)))]);
    if (ctx.time || ctx.recurrence) for (const name of TIME) allowed.add(name);
    if (target) for (const name of namesOf(own)) allowed.add(name);
    for (const ref of refs) {
      const pair = afterRefs?.find((r) => !used.has(r.component));
      if (pair) {
        used.add(pair.component);
        compareComponent(ctx, ref.component, pair.component, allowed, false, `${label} в продолжении`);
        checkMovedStays(ctx, before, ref, cont, pair, target, label);
      } else if (!ctx.removed.has(key) && roleOf(before, refs) !== "hidden") {
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
 * update this и граница t&f («B получает патч») — исключение.
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
}

/**
 * Проход слотов объекта: видимые встречи до `until` и ещё
 * GUARD_EXTRA_SLOTS видимых слотов; при `full` у конечной серии — дальше до
 * конца, для протяжённости (О12д) за тот же проход. Больше SERIES_CAP
 * слотов или сбой итератора — `series-too-long`.
 */
function scan(ctx: Ctx, o: CalendarObject, until: SlotKey, full: boolean): Scan {
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
  for (const key of removed) for (const option of [key, ctx.mapKey(key)]) removedNow.add(option);
  const orderedAfter = [...a.entries.values()].sort((x, y) => compareSlotKeys(x.key, y.key));
  for (const entry of orderedAfter) {
    if (consumed.has(entry.key) || liftedKeys.has(entry.key)) continue;
    if (rule.explicitOnly && !entry.own) continue;
    if (!entry.detached && rule.cutoff !== undefined && sameKind(entry.key, rule.cutoff) && compareSlotKeys(entry.key, rule.cutoff) > 0) continue;
    if (removedNow.has(entry.key)) kept.push(describeEntry(a.o, entry));
    else added.push(describeEntry(a.o, entry));
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
// образ по keyMap; у detached — прежний ключ или образ (сдвиг по позиции у
// него не определён).
function optionsFor(ctx: Ctx, key: SlotKey, detached: boolean): SlotKey[] {
  if (detached) return [...new Set([key, ctx.mapKey(key)])];
  return [ctx.mapKey(key)];
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
