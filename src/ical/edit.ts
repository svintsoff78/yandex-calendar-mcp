import { createHash } from "node:crypto";
import ICAL from "ical.js";
import type { EditScope } from "../types.js";
import {
  AddressError,
  hiddenOverrides,
  instanceAt,
  resolveTarget,
  type HiddenOverride,
  type Instance,
  type Resolved,
  type Target,
} from "./instances.js";
import {
  blockingAnomalies,
  ensureTimezones,
  formatAnomaly,
  isUnparsable,
  loadObject,
  serializeObject,
  shownOverride,
  type Anomaly,
  type AnomalyCode,
  type CalendarObject,
  type EditOp,
  type OverrideRole,
  type Unparsable,
} from "./object.js";
import {
  applyFieldPatch,
  cloneComponent,
  distortedParts,
  inheritFields,
  newTouched,
  overrideFromMaster,
  patchRule,
  setRuleEnd,
  touchMetadata,
  type FieldPatchResult,
  type PatchContext,
} from "./patch.js";
import {
  EditRefusal,
  PATCH_FIELDS,
  type EventPatch,
  type Expectation,
  type FieldPatch,
  type Loss,
  type PatchField,
  type RecurrencePatch,
  type Touched,
  type WritePlan,
} from "./plan.js";
import {
  SERIES_CAP,
  SlotScanError,
  findSlot,
  isDtstartSynced,
  isEmpty,
  iterateSlots,
  lastSlotUpTo,
  positionsBefore,
  sameTail,
  seriesExtent,
  seriesZoneOf,
  type Slot,
} from "./slots.js";
import { registerTimeZone } from "./timezones.js";
import {
  ModelTimeError,
  addListValue,
  compareSlotKeys,
  formOf,
  formatForModel,
  instantOf,
  listKeys,
  parseModelTime,
  removeListValues,
  ruleDict,
  setRuleDict,
  setTimeProperty,
  slotKeyOf,
  timeInForm,
  untilBefore,
  wallDateOf,
  type IcalEnv,
  type KeyContext,
  type ListName,
  type ModelTime,
  type SlotKey,
  type TimeForm,
  type ZoneRef,
} from "./values.js";

/**
 * Планировщики правки и удаления (таблица §3, Р1–Р7, Р9 без сети, О11, О13,
 * О14 плана переделки, docs/superpowers/plans/2026-09-19-recurring-events-rework.md,
 * задача З10; роли переопределений — slot, hidden, detached по поправке «без
 * ремонта следов прежнего кода»).
 *
 * Планировщик получает объект, прочитанный в этом же вызове, и возвращает
 * план записи (plan.ts, WritePlan) — сеть он не трогает. Правка ложится на
 * копию дерева ical.js: меняются только нужные узлы, объект не пересобирается
 * из модели никогда. Главное правило: ни одна ветка не удаляет и не теряет
 * больше, чем просили.
 * - Весь объект удаляется только по явному all_series или когда после плана
 *   в нём не осталось ни одной видимой встречи (`isEmpty`, без горизонта).
 *   Нераспознанный повтор — не одиночное событие: объект с RRULE, которое не
 *   перебирается, — серия с блокирующей аномалией (О14), а не «одна встреча».
 * - Потеря сверх названной цели (переопределение без пары в новом правиле,
 *   встреча со слотом после границы, перенесённая раньше неё, части правила
 *   при replace, встреча, которая после усечения стала бы невидимой) — отказ
 *   `EditRefusal` с needsConfirm и перечнем потерь (О11). confirm принимается
 *   только с etag прочитанного состояния.
 * - Разрез серии (t&f) строит продолжение с детерминированным UID
 *   (`continuationUid`) и усечённый исходный объект; расписание продолжения
 *   сверяется с хвостом исходной серии (`sameTail`, иначе split-mismatch).
 *   Существует ли продолжение на сервере, выясняет доставка чтением (Ж13,
 *   src/domain/writes.ts), а не планировщик.
 *
 * - Объект, уже испорченный другим клиентом (дубль RECURRENCE-ID, несколько
 *   RRULE у основного компонента), не правится вовсе: `refuseCorrupted` (О14
 *   с поправкой З10). Писать в него — угадывать, какое из двух противоречащих
 *   описаний встречи или серии настоящее; целиком удалить его можно.
 *
 * Порядок решения: порча другим клиентом → блокирующие аномалии объекта →
 * адрес (`resolveTarget`: неоднозначный адрес без подтверждения — отказ
 * ambiguous) → ветка по виду объекта и scope → ожидание для предохранителя
 * (`Expectation`: `touched` — из patch.ts, `tail` — из `seriesExtent`).
 *
 * Время (Р1): у всей серии и у хвоста из start и end берутся только время
 * суток, длительность и пояс — дата начала серии (или границы) прежняя, если
 * не передано правило повтора. Встречи сопоставляются по позиции правила:
 * позиция n переходит в позицию n, DTSTART — в DTSTART, значения RDATE
 * сдвигаются на ту же стенную разницу (при смене одного пояса — сохраняют
 * момент). Так EXDATE, RECURRENCE-ID и UNTIL идут за своими встречами, а
 * перенесённые встречи остаются на своём времени (О7). Смена правила —
 * сопоставление по ключу (Р1).
 *
 * BYSETPOS и WKST Яндекс молча искажает при записи правила (Ж6): план,
 * который меняет такое правило (конец при усечении и разрезе, UNTIL при
 * сдвиге), — отказ unsupported-rule; правило, которое план не трогает,
 * пишется дословно.
 *
 * Известный дефект ключей повторного осеннего часа (values.ts, instances.ts)
 * здесь не исправляется и не маскируется.
 *
 * Пояс процесса не участвует: время от модели разбирает `parseModelTime`,
 * моменты — values.ts через ical.js.
 */

// ─────────────────────────────── запросы ───────────────────────────────

/**
 * Запрос правки (update_event). Без scope — "this".
 * - `instanceStart` — адрес встречи (Р10); у серии обязателен при this и
 *   this_and_following, у одиночного события и all_series — проверяется,
 *   если передан;
 * - `confirm` — подтверждение потерь (О11); принимается только вместе с
 *   `etag`, равным `currentEtag` — etag состояния, из которого построен
 *   объект (его передаёт оркестрация, З13);
 * - `now` — момент для DTSTAMP и LAST-MODIFIED;
 * - `defaultTimeZone` — пояс события, которое перестаёт быть событием на
 *   весь день без timeZone в патче.
 */
export interface UpdateRequest {
  scope?: EditScope;
  instanceStart?: string;
  patch: EventPatch;
  confirm?: boolean;
  etag?: string;
  currentEtag?: string;
  now: Date | number;
  defaultTimeZone?: string;
}

/** Запрос удаления (delete_event). Без scope — "this". Поля — как у UpdateRequest. */
export interface DeleteRequest {
  scope?: EditScope;
  instanceStart?: string;
  confirm?: boolean;
  etag?: string;
  currentEtag?: string;
  now: Date | number;
}

/**
 * UID продолжения разреза (Р9): "ycm-" и первые 32 знака sha256 от UID
 * исходной серии и ключа границы. Повтор того же разреза даёт тот же UID —
 * по нему доставка находит уже созданное продолжение.
 */
export function continuationUid(uid: string, boundary: SlotKey): string {
  return `ycm-${createHash("sha256").update(`${uid}\n${boundary}`).digest("hex").slice(0, 32)}`;
}

// ─────────────────────────────── входы ───────────────────────────────

/** План правки: таблица §3, Р1, Р2, Р4, Р6, Р7, Р9. Бросает EditRefusal или AddressError. */
export function planUpdate(input: CalendarObject | Unparsable, request: UpdateRequest): WritePlan {
  const scope = scopeOf(request.scope);
  if (isUnparsable(input)) {
    throw new EditRefusal("unparsable", `Объект${input.uid ? ` ${input.uid}` : ""} не разобран: ${input.error} Править его нельзя.`, {
      hint: UNPARSABLE_HINT,
    });
  }
  const patch: unknown = request.patch;
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new EditRefusal("invalid-field", "patch — объект с изменяемыми полями события.");
  }
  return decide(request, (confirmed) => updatePlan(runOf(input, request.now, confirmed, request.defaultTimeZone), scope, request));
}

/** План удаления: таблица §3, Р2, Р3, Р5–Р7. Бросает EditRefusal или AddressError. */
export function planDelete(input: CalendarObject | Unparsable, request: DeleteRequest): WritePlan {
  const scope = scopeOf(request.scope);
  if (isUnparsable(input)) return unparsableDelete(input, scope, request);
  return decide(request, (confirmed) => deletePlan(runOf(input, request.now, confirmed), scope, request.instanceStart));
}

// ─────────────────────────────── общее ───────────────────────────────

/** Состояние одного планирования: исходный объект не меняется, правка — на копиях. */
interface Run {
  readonly o: CalendarObject;
  readonly env: IcalEnv;
  readonly now: Date | number;
  readonly confirmed: boolean;
  readonly defaultTimeZone?: string;
  readonly notices: string[];
}

function runOf(o: CalendarObject, now: Date | number, confirmed: boolean, defaultTimeZone?: string): Run {
  return { o, env: o.env, now, confirmed, defaultTimeZone, notices: [] };
}

const SCOPES: ReadonlySet<string> = new Set(["this", "this_and_following", "all_series"]);

function scopeOf(scope: EditScope | undefined): EditScope {
  if (scope === undefined) return "this";
  if (!SCOPES.has(scope)) {
    throw new EditRefusal("invalid-field", `scope ${JSON.stringify(scope)} неизвестен: допустимы this, this_and_following, all_series.`);
  }
  return scope;
}

const UNPARSABLE_HINT =
  "Такой объект можно только удалить целиком: delete_event со scope all_series без instanceStart. Исправить его можно в веб-интерфейсе Яндекс Календаря.";
const CONFIRM_HINT =
  "Проверьте перечень потерь и повторите вызов с confirm: true и etag из последнего чтения события (get_event или list_events).";

/**
 * confirm и etag (О11, Р11): confirm действует, только если etag вызова
 * совпал с etag прочитанного состояния. Иначе — отказ confirm-required с
 * потерями, которые план дал бы без подтверждения: их и надо подтвердить
 * заново. Перебор длиннее предела — отказ series-too-long.
 */
function decide(
  request: { confirm?: boolean; etag?: string; currentEtag?: string },
  plan: (confirmed: boolean) => WritePlan,
): WritePlan {
  if (request.confirm !== true) return guarded(() => plan(false));
  const problem = etagProblem(request);
  if (problem === undefined) return guarded(() => plan(true));
  let losses: readonly Loss[] = [];
  try {
    guarded(() => plan(false));
  } catch (error) {
    if (error instanceof EditRefusal && error.needsConfirm) losses = error.losses;
  }
  throw new EditRefusal("confirm-required", problem, { needsConfirm: true, losses, hint: CONFIRM_HINT });
}

function etagProblem(request: { etag?: string; currentEtag?: string }): string | undefined {
  if (typeof request.etag !== "string" || request.etag === "") {
    return "confirm принимается только вместе с etag последнего чтения события: по нему видно, что подтверждаются те самые потери.";
  }
  if (typeof request.currentEtag !== "string" || request.currentEtag === "") {
    return "Не известен etag прочитанного состояния события: подтверждение не с чем сверить.";
  }
  if (request.etag !== request.currentEtag) {
    return `Подтверждение дано для etag ${request.etag}, а событие уже изменилось (текущий etag ${request.currentEtag}): перечень потерь мог стать другим.`;
  }
  return undefined;
}

function guarded(plan: () => WritePlan): WritePlan {
  try {
    return plan();
  } catch (error) {
    if (error instanceof SlotScanError) {
      throw new EditRefusal("series-too-long", `Серию не удалось перебрать: ${error.message}`, {
        hint: "Такую серию можно изменить целиком в веб-интерфейсе или удалить (delete_event со scope all_series).",
      });
    }
    throw error;
  }
}

function refuseBlocking(anomalies: readonly Anomaly[]): void {
  if (anomalies.length === 0) return;
  const splitOnly = anomalies.every((anomaly) =>
    ["exrule", "multiple-rrules", "unsynced-dtstart", "rdate-boundary"].includes(anomaly.code));
  throw new EditRefusal(anomalies[0].code, `Запись заблокирована: ${anomalies.map(formatAnomaly).join("; ")}.`, {
    hint: splitOnly
      ? "Разрезать такую серию нельзя: измените всю серию (scope all_series) или отдельные встречи (scope this)."
      : "Такой объект можно только удалить целиком: delete_event со scope all_series.",
  });
}

/**
 * Объект, испорченный другим клиентом (О14 с поправкой задачи З10): в нём
 * два противоречащих друг другу описания одной и той же встречи или серии, и
 * любая наша запись — угадывание, какое из них «настоящее». Отказ честен и
 * ничего не теряет, поэтому такие аномалии блокируют правку любого scope и
 * удаление встречи или хвоста; целиком объект удалить по-прежнему можно
 * (delete all_series ничем не блокируется).
 * - `duplicate-override` — у одной встречи несколько компонентов с одним
 *   RECURRENCE-ID. Показывается один из них (`shownOverride` — по SEQUENCE,
 *   DTSTAMP, порядку в файле), а правка всей серии трогает метаданные другого
 *   и молча меняет выбор: перенесённая встреча пользователя пропадала бы из
 *   виду, а на её месте оказывалась бы старая копия с другим временем.
 * - `multiple-rrules` — у основного компонента несколько RRULE. Правка ложится
 *   только на первое правило (`prepareRule`, `setRuleEnd`), остальные
 *   продолжают давать встречи: серия, которую просили закончить, шла бы
 *   дальше, и ни `removed`, ни notices об этом не сказали бы.
 * Более узкие блокировки О14 (duplicate-override в целевом слоте, несколько
 * RRULE при разрезе) остаются в `blockingAnomalies` — здесь отказ наступает
 * раньше и одинаково для всех scope.
 *
 * Исключение поправки: удаление, план которого — удаление объекта целиком,
 * ничего не пишет и ничего не угадывает, поэтому не блокируется. Это
 * одиночное событие при любом scope и `this_and_following` по первой видимой
 * встрече. Поэтому вызовы стоят не в начале планирования, а там, где уже
 * видно, что план — запись: `deletePlan` (скрытый компонент одиночного
 * события и scope this), `deleteDetachedFollowing`, `deleteFollowing` (путь
 * усечения) и `updatePlan`.
 */
const CORRUPTED: ReadonlyMap<AnomalyCode, string> = new Map([
  ["duplicate-override", "какая из копий встречи настоящая, по объекту не определить"],
  ["multiple-rrules", "правка легла бы только на первое правило, остальные остались бы прежними"],
]);

// Что веб-интерфейс Яндекса делает с испорченным объектом, живой сверкой не
// проверялось (docs/yandex-caldav-capabilities.md: среди Ж1–Ж18 такого факта
// нет), поэтому подсказка не обещает механизма — только совет и выход, который
// работает наверняка.
const CORRUPTED_HINT =
  "Исправить событие можно в веб-интерфейсе Яндекс Календаря. " +
  "Удалить событие целиком можно и сейчас: delete_event со scope all_series.";

function refuseCorrupted(o: CalendarObject, op: EditOp, scope: EditScope): void {
  if (op === "delete" && scope === "all_series") return;
  const found = o.anomalies.filter((anomaly) => CORRUPTED.has(anomaly.code));
  if (found.length === 0) return;
  const list = found.map((anomaly) => `${formatAnomaly(anomaly)} — ${CORRUPTED.get(anomaly.code)!}`).join("; ");
  throw new EditRefusal(
    found[0].code,
    `Объект испорчен другим клиентом: ${list}. Писать в него — угадывать, какая из записей верна, поэтому ` +
      `${op === "update" ? "правка отклонена" : "удаление отклонено"}.`,
    { hint: CORRUPTED_HINT },
  );
}

function needConfirm(losses: readonly Loss[], message: string): EditRefusal {
  const list = losses.length > 0
    ? ` Будут потеряны: ${losses.map((loss) => `${loss.instanceStart} «${loss.summary}» (начало ${loss.start}) — ${loss.reason}`).join("; ")}.`
    : "";
  return new EditRefusal("confirm-required", `${message}${list}`, { needsConfirm: true, losses, hint: CONFIRM_HINT });
}

/**
 * Ж6: BYSETPOS и WKST Яндекс молча искажает при записи правила. План,
 * который меняет RRULE с такими частями (конец при усечении — и значит при
 * любом разрезе, UNTIL при сдвиге), — отказ unsupported-rule. Правило,
 * которое план не трогает, пишется дословно.
 */
function refuseDistorted(master: ICAL.Component, what: string): void {
  const parts = [...new Set(master.getAllProperties("rrule").flatMap((property) => distortedParts(property)))];
  if (parts.length === 0) return;
  throw new EditRefusal(
    "unsupported-rule",
    `Правило серии содержит ${parts.join(" и ")}: Яндекс молча исказил бы его при записи (Ж6), поэтому ${what} нельзя.`,
    {
      hint:
        "Измените отдельные встречи (scope this) или всю серию без смены времени и правила; правило можно задать заново — " +
        "recurrence с replace: true (потеря этих частей требует confirm).",
    },
  );
}

function missingAddress(op: EditOp, what: string): AddressError {
  const action = op === "update" ? "изменить" : "удалить";
  return new AddressError("invalid", `Чтобы ${action} ${what} повторяющегося события, нужен instanceStart — адрес встречи из list_events.`, {
    hint: `Чтобы ${action} всю серию, передайте scope: "all_series".`,
  });
}

function copyOf(o: CalendarObject): CalendarObject {
  return reparse(serializeObject(o), o.env);
}

function hasEvents(o: CalendarObject): boolean {
  return o.root.getAllSubcomponents("vevent").length > 0;
}

function reparse(ics: string, env: IcalEnv): CalendarObject {
  const object = loadObject(ics, env);
  if (isUnparsable(object)) throw new Error(`Текст после правки не разбирается: ${object.error}`);
  return object;
}

function textOf(root: ICAL.Component): string {
  return `${root.toString()}\r\n`;
}

function summaryOf(c: ICAL.Component): string {
  const value = c.getFirstPropertyValue("summary");
  return value === null || value === undefined ? "" : String(value);
}

function lossOf(env: IcalEnv, instance: Instance, reason: string): Loss {
  return { instanceStart: instance.instanceStart, start: formatForModel(instance.start, env, "time"), summary: summaryOf(instance.shown), reason };
}

function slotLoss(o: CalendarObject, slot: Slot, reason: string): Loss {
  return {
    instanceStart: formatForModel(slot.time, o.env, "instance"),
    start: formatForModel(slot.time, o.env, "time"),
    summary: summaryOf(o.master!),
    reason,
  };
}

function hiddenLosses(env: IcalEnv, hidden: HiddenOverride, reason: string): Loss[] {
  return hidden.refs.map((ref) => ({
    instanceStart: hidden.instanceStart,
    start: formatForModel(ref.component.getFirstPropertyValue("dtstart") as ICAL.Time, env, "time"),
    summary: summaryOf(ref.component),
    reason,
  }));
}

function expectation(op: EditOp, scope: EditScope, fields: Iterable<PatchField>, extra: Partial<Expectation> = {}): Expectation {
  return { op, scope, fields: new Set(fields), removed: [], ruleChanged: false, datesFixed: false, touched: newTouched(), ...extra };
}

function requestedFields(patch: EventPatch): PatchField[] {
  return PATCH_FIELDS.filter((field) => patch[field] !== undefined);
}

function fieldsOf(patch: EventPatch): FieldPatch {
  const { recurrence: _recurrence, ...fields } = patch;
  return fields;
}

function hasTimeFields(fields: FieldPatch): boolean {
  return fields.start !== undefined || fields.end !== undefined || fields.timeZone !== undefined || fields.allDay !== undefined;
}

function patchContext(run: Run, touched: Touched): PatchContext {
  return { env: run.env, touched, defaultTimeZone: run.defaultTimeZone };
}

function noteAmbiguity(run: Run, resolved: Resolved, action: string): void {
  const others = resolved.ambiguousWith;
  if (!others || others.length === 0) return;
  const target = resolved.target;
  const own = target.kind === "hidden" ? target.hidden.instanceStart : target.instance.instanceStart;
  run.notices.push(
    `Адрес ${own} совпадает с фактическим началом перенесённой встречи ${others.map((i) => i.instanceStart).join(", ")}: ` +
      `по подтверждению ${action} встреча по адресу ${own}, перенесённая не тронута.`,
  );
}

// ─────────────────────────────── Touched ───────────────────────────────

function namesOf(touched: Touched, c: ICAL.Component): Set<string> {
  let names = touched.names.get(c);
  if (!names) {
    names = new Set();
    touched.names.set(c, names);
  }
  return names;
}

function markProperty(touched: Touched, c: ICAL.Component, property: ICAL.Property): void {
  touched.properties.add(property);
  namesOf(touched, c).add(property.name.toLowerCase());
}

function markComponent(touched: Touched, parent: ICAL.Component, sub: ICAL.Component): void {
  touched.components.add(sub);
  namesOf(touched, parent).add(sub.name.toLowerCase());
}

function removeComponent(root: ICAL.Component, c: ICAL.Component, touched: Touched): void {
  if (root.removeSubcomponent(c)) markComponent(touched, root, c);
}

/** Свойства, правка которых — повод для SEQUENCE (О10). */
const SIGNIFICANT: ReadonlySet<string> = new Set(["dtstart", "dtend", "duration", "rrule", "rdate", "exdate"]);

/** Метаданные тронутых VEVENT (О10): DTSTAMP, LAST-MODIFIED, SEQUENCE по тому, что в них менялось. */
function stampTouched(run: Run, components: Iterable<ICAL.Component>, touched: Touched): void {
  for (const c of components) {
    if (!c.parent) continue;
    const names = touched.names.get(c);
    if (!names || names.size === 0) continue;
    const significant = [...names].some((name) => SIGNIFICANT.has(name));
    touchMetadata(c, run.now, significant, run.env, touched);
  }
}

function touchedEvents(touched: Touched): boolean {
  for (const [c, names] of touched.names) if (c.name === "vevent" && names.size > 0) return true;
  return false;
}

// ─────────────────────────────── удаление ───────────────────────────────

function unparsableDelete(input: Unparsable, scope: EditScope, request: DeleteRequest): WritePlan {
  if (scope !== "all_series") {
    throw new EditRefusal("unparsable", `Объект${input.uid ? ` ${input.uid}` : ""} не разобран: ${input.error} Отдельные встречи в нём не адресуются.`, {
      hint: UNPARSABLE_HINT,
    });
  }
  if (request.instanceStart !== undefined) {
    throw new EditRefusal("unparsable", `Объект${input.uid ? ` ${input.uid}` : ""} не разобран: адрес встречи ${request.instanceStart} в нём не проверить.`, {
      hint: UNPARSABLE_HINT,
    });
  }
  return {
    kind: "delete-object",
    expect: expectation("delete", "all_series", []),
    removed: [],
    notices: ["Объект не разобран и удалён целиком без чтения встреч."],
  };
}

function deletePlan(run: Run, scope: EditScope, instanceStart: string | undefined): WritePlan {
  const { o } = run;
  if (scope === "all_series") {
    if (instanceStart !== undefined) resolveTarget(o, instanceStart, "delete", { confirm: true });
    const notices = o.kind === "detached"
      ? ["В объекте только ваши копии отдельных встреч чужой серии: удалены они, серия организатора не затронута."]
      : [];
    const removed = o.kind === "single" ? [lossOf(run.env, singleInstance(o), "событие удалено")] : [];
    return { kind: "delete-object", expect: expectation("delete", "all_series", []), removed, notices };
  }

  if (o.kind === "single") {
    // Событие удаляется целиком при любом scope; неизвестный пояс удалению не мешает.
    refuseBlocking(blockingAnomalies(o, "delete", scope).filter((anomaly) => anomaly.code !== "unknown-tzid"));
    const resolved = instanceStart !== undefined ? resolveTarget(o, instanceStart, "delete", { confirm: run.confirmed }) : undefined;
    // Скрытый компонент одиночного события (RECURRENCE-ID мимо его начала) адресуется своим
    // RECURRENCE-ID и снимается сам, как в серии (Р5): само событие остаётся. Это запись,
    // поэтому испорченный объект здесь блокируется, а удаление события целиком — нет.
    if (resolved?.target.kind === "hidden") {
      refuseCorrupted(o, "delete", scope);
      return deleteThis(run, resolved.target);
    }
    const instance = resolved ? addressedInstance(resolved) : singleInstance(o);
    return {
      kind: "delete-object",
      expect: expectation("delete", scope, [], { target: instance.key, removed: [instance.key] }),
      removed: [lossOf(run.env, instance, "событие удалено")],
      notices: run.notices,
    };
  }

  refuseBlocking(blockingAnomalies(o, "delete", scope));
  if (instanceStart === undefined) throw missingAddress("delete", scope === "this" ? "одну встречу" : "хвост");
  const resolved = resolveTarget(o, instanceStart, "delete", { confirm: run.confirmed });
  noteAmbiguity(run, resolved, "удалена");
  const target = resolved.target;
  if (scope === "this") {
    refuseCorrupted(o, "delete", scope);
    refuseBlocking(blockingAnomalies(o, "delete", "this", { key: target.key }));
    return deleteThis(run, target);
  }
  return deleteFollowing(run, target);
}

function addressedInstance(resolved: Resolved): Instance {
  const target = resolved.target;
  if (target.kind === "hidden") throw new Error("У одиночного события нет скрытых компонентов.");
  return target.instance;
}

function singleInstance(o: CalendarObject): Instance {
  const start = o.master!.getFirstPropertyValue("dtstart") as ICAL.Time;
  const instance = instanceAt(o, slotKeyOf(start, o.form, o.env));
  if (!instance) throw new Error(`У одиночного события ${o.uid} нет встречи в его DTSTART.`);
  return instance;
}

/**
 * delete this (таблица §3, Р5–Р7): снимаются все компоненты встречи (с
 * дублями); слот правила или DTSTART закрывается EXDATE в форме DTSTART, слот
 * только из RDATE — снятием значения RDATE. detached и hidden — только
 * компонент. Если после этого видимых встреч нет (`isEmpty`) — удаление
 * объекта, скрытые компоненты уходят с ним и перечислены в removed (Р3).
 */
function deleteThis(run: Run, target: Target): WritePlan {
  const { o, env } = run;
  const work = copyOf(o);
  const touched = newTouched();
  const removed: Loss[] = [];
  for (const ref of work.overrides.get(target.key) ?? []) removeComponent(work.root, ref.component, touched);

  if (target.kind === "hidden") {
    removed.push(...hiddenLosses(env, target.hidden, "скрытый компонент снят"));
  } else if (target.kind === "detached") {
    removed.push(lossOf(env, target.instance, "встреча удалена"));
  } else {
    removed.push(lossOf(env, target.instance, "встреча удалена"));
    const master = work.master!;
    if (target.slot.sources.includes("dtstart") || target.slot.sources.includes("rrule")) {
      if (!listKeys(master, "exdate", work).includes(target.key)) {
        markProperty(touched, master, addListValue(master, "exdate", timeInForm(target.slot.time, work.form, work.zone, env)));
      }
    } else {
      dropListValues(master, "rdate", work, (key) => key === target.key, touched);
    }
    stampTouched(run, [master], touched);
  }

  const visibleTarget = target.kind !== "hidden";
  const expect = expectation("delete", "this", [], { target: target.key, removed: visibleTarget ? [target.key] : [], touched });
  const next = hasEvents(work) ? copyOf(work) : undefined;
  if (visibleTarget && (!next || isEmpty(next))) {
    const traces = (next ? hiddenOverrides(next) : []).flatMap((hidden) =>
      hiddenLosses(env, hidden, "скрытый компонент (след прошлых удалений) удалён вместе с объектом"));
    return {
      kind: "delete-object",
      expect,
      removed: [...removed, ...traces],
      notices: [...run.notices, "После удаления в серии не осталось ни одной встречи: объект удалён целиком."],
    };
  }
  return { kind: "put", ics: serializeObject(work), expect, removed, notices: run.notices };
}

/**
 * delete this_and_following (таблица §3, Р2): встречи с адресом не раньше
 * границы B удаляются. Встреча со слотом ≥ B, перенесённая раньше B, — потеря
 * сверх цели (confirm). До B видимых встреч нет — удаление объекта; иначе
 * усечение: конец правила перед B (COUNT по позициям или UNTIL), EXDATE,
 * RDATE и переопределения ≥ B снимаются, всё до B цело.
 */
function deleteFollowing(run: Run, target: Target): WritePlan {
  const { o, env } = run;
  if (target.kind === "hidden") {
    throw new EditRefusal("invalid-field", `${target.hidden.instanceStart} — скрытый компонент без встречи: он удаляется только сам (scope this).`, {
      hint: "Передайте scope: \"this\" или адрес видимой встречи.",
    });
  }
  const boundary = target.key;
  const boundaryTime = target.kind === "slot" ? target.slot.time : target.instance.address;
  const boundaryMs = instantOf(boundaryTime, env);

  // Встречи хвоста (адрес после B), перенесённые раньше B: для пользователя они до границы —
  // потеря сверх цели (C50). Сама B — названная цель, куда бы её ни перенесли.
  const early = movedBefore(o, boundary)
    .map((instance) => lossOf(env, instance, `её адрес позже ${target.instance.instanceStart}, а перенесена она раньше — удаляется вместе с хвостом`));
  const earlyMessage = early.length > 0
    ? `Встречи ${early.map((loss) => loss.instanceStart).join(", ")} из удаляемого хвоста перенесены раньше ${target.instance.instanceStart} и тоже будут удалены.`
    : "";

  if (!o.master) return deleteDetachedFollowing(run, boundary, early, earlyMessage);

  const tail = meetingsFrom(o, boundary, run.now, "удалена вместе со следующими");
  if (!hasVisibleBefore(o, boundary)) {
    // Здесь план — удаление объекта целиком: записи нет, испорченный объект не блокируется.
    refuseBlocking(blockingAnomalies(o, "delete", "this_and_following", { key: boundary }));
    if (early.length > 0 && !run.confirmed) throw needConfirm(early, earlyMessage);
    return {
      kind: "delete-object",
      expect: expectation("delete", "this_and_following", [], { target: boundary, removed: tail.keys }),
      removed: tail.losses,
      notices: [...run.notices, `До ${target.instance.instanceStart} встреч нет: удалена вся серия.`, ...tail.notices],
    };
  }

  refuseCorrupted(o, "delete", "this_and_following");
  refuseBlocking(blockingAnomalies(o, "delete", "this_and_following", { key: boundary, split: true }));
  refuseUncuttable(o, boundary, "delete");
  const work = copyOf(o);
  const touched = newTouched();
  truncate(run, work, boundary, boundaryTime, touched);
  const next = copyOf(work);
  const hidden = hiddenAfterCut(o, next, boundary, "delete");
  const losses = [...early, ...hidden.map((entry) => entry.loss)];
  if (losses.length > 0 && !run.confirmed) {
    throw needConfirm(losses, [earlyMessage, hidden.length > 0 ? HIDDEN_MESSAGE : ""].filter(Boolean).join(" "));
  }
  run.notices.push(...hiddenNotice(hidden));
  run.notices.push(...movedPastBoundary(o, boundary, boundaryMs, "остаются в серии: их адрес раньше границы"));
  const expect = expectation("delete", "this_and_following", [], {
    target: boundary,
    removed: [...tail.keys, ...hidden.map((entry) => entry.key)],
    ruleChanged: true,
    datesFixed: true,
    tail: tailOf(next),
    touched,
  });
  const removed = [...tail.losses.filter((loss) => !early.some((e) => e.instanceStart === loss.instanceStart)), ...early, ...hidden.map((e) => e.loss)];
  // Пустым усечённый объект не бывает: видимая встреча до B — незакрытый слот (он остаётся)
  // или оторванная, которая либо видна и дальше, либо без неё объект пуст — отказ выше.
  return { kind: "put", ics: serializeObject(work), expect, removed, notices: [...run.notices, ...tail.notices] };
}

/** Р6: объект из одних переопределений — снимаются компоненты с RECURRENCE-ID не раньше границы. */
function deleteDetachedFollowing(run: Run, boundary: SlotKey, early: Loss[], earlyMessage: string): WritePlan {
  const { o, env } = run;
  refuseCorrupted(o, "delete", "this_and_following");
  if (early.length > 0 && !run.confirmed) throw needConfirm(early, earlyMessage);
  const work = copyOf(o);
  const touched = newTouched();
  const removed: Loss[] = [];
  const keys: SlotKey[] = [];
  for (const [key, refs] of work.overrides) {
    if (compareSlotKeys(key, boundary) < 0) continue;
    const instance = instanceAt(o, key);
    if (instance) {
      removed.push(lossOf(env, instance, "удалена вместе со следующими"));
      keys.push(key);
    }
    for (const ref of refs) removeComponent(work.root, ref.component, touched);
  }
  const expect = expectation("delete", "this_and_following", [], { target: boundary, removed: keys, touched });
  if (!hasEvents(work) || isEmpty(copyOf(work))) return { kind: "delete-object", expect, removed, notices: run.notices };
  return { kind: "put", ics: serializeObject(work), expect, removed, notices: run.notices };
}

/**
 * Усечение серии перед границей (таблица §3, t&f): COUNT — число позиций
 * правила до границы (форма ограничения сохраняется), иначе UNTIL по О4 на
 * секунду (у дат — на день) раньше границы, но не позже прежнего UNTIL;
 * EXDATE, RDATE и переопределения не раньше границы снимаются. Всё до
 * границы и свойства вне модели не трогаются.
 */
function truncate(run: Run, work: CalendarObject, boundary: SlotKey, boundaryTime: ICAL.Time, touched: Touched): void {
  const { o } = run;
  const master = work.master!;
  const rule = master.getFirstProperty("rrule");
  if (rule) {
    refuseDistorted(master, "усечь серию (сменить конец правила)");
    const count = ruleDict(rule).count;
    const kept = count === undefined ? 0 : positionsBefore(o, boundary);
    if (count !== undefined && kept >= 1) setRuleEnd(rule, { count: kept }, touched);
    else endRuleBefore(rule, boundaryTime, work, touched);
  }
  const atOrAfter = (key: SlotKey) => compareSlotKeys(key, boundary) >= 0;
  dropListValues(master, "exdate", work, atOrAfter, touched);
  dropListValues(master, "rdate", work, atOrAfter, touched);
  for (const [key, refs] of work.overrides) {
    if (!atOrAfter(key)) continue;
    for (const ref of refs) removeComponent(work.root, ref.component, touched);
  }
  stampTouched(run, [master], touched);
}

// UNTIL перед границей (values.ts, untilBefore); прежний, более ранний конец не продлевается.
// Сравнение — по toUnixTime, как сравнивает итератор ical.js (recur_iterator.js:390, 462).
function endRuleBefore(rule: ICAL.Property, boundaryTime: ICAL.Time, work: CalendarObject, touched: Touched): void {
  const until = untilBefore(timeInForm(boundaryTime, work.form, work.zone, work.env), work.form);
  const current = (rule.getFirstValue() as ICAL.Recur).until;
  if (current && current.toUnixTime() <= ICAL.Time.fromString(until, null).toUnixTime()) return;
  setRuleEnd(rule, { until }, touched);
}

/** Снимает значения списка по условию и отмечает тронутые свойства (values.ts, removeListValues). */
function dropListValues(c: ICAL.Component, name: ListName, ctx: KeyContext, drop: (key: SlotKey) => boolean, touched: Touched): SlotKey[] {
  const before = c.getAllProperties(name).map((property) => ({ property, json: JSON.stringify(property.jCal) }));
  const removed = removeListValues(c, name, (key) => drop(key), ctx);
  const present = new Set(c.getAllProperties(name));
  for (const { property, json } of before) {
    if (!present.has(property) || JSON.stringify(property.jCal) !== json) markProperty(touched, c, property);
  }
  return removed;
}

/**
 * Есть ли видимая встреча до границы `boundary` (Р2): незакрытый слот или
 * detached с адресом раньше неё, а при `moved` — ещё и встреча с адресом не
 * раньше границы, но перенесённая раньше неё («включая перенесённые» в Р2).
 *
 * `moved` включается у правки: встреча хвоста, перенесённая раньше B,
 * остаётся в объекте, и правка всей серии одним put переписала бы её — это и
 * проверяет предохранитель (guard.ts, `checkNothingBeforeBoundary`). У
 * удаления такая встреча сама входит в удаляемый хвост, названа в потерях
 * (`early`) и требует confirm: после удаления до границы не остаётся ничего,
 * и удаление объекта целиком верно — поэтому `moved` там выключен.
 */
function hasVisibleBefore(o: CalendarObject, boundary: SlotKey, moved = false): boolean {
  let seen = 0;
  for (const slot of iterateSlots(o, { until: boundary })) {
    if (compareSlotKeys(slot.key, boundary) >= 0) break;
    if (!slot.excluded) return true;
    if (++seen > SERIES_CAP) return true;
  }
  for (const [key, refs] of o.overrides) {
    if (compareSlotKeys(key, boundary) < 0 && o.roles.get(refs[0].component)?.role === "detached") return true;
  }
  return moved && movedBefore(o, boundary).length > 0;
}

/**
 * Встречи со своим компонентом, чей адрес не раньше границы, а начало —
 * раньше: для пользователя они стоят до границы (Р2, C50). Сама граница —
 * названная цель, куда бы её ни перенесли.
 */
function movedBefore(o: CalendarObject, boundary: SlotKey): Instance[] {
  const boundaryMs = instantOf(timeOfKey(boundary), o.env);
  return ownMeetingsFrom(o, boundary).filter((instance) => instance.key !== boundary && instance.startMs < boundaryMs);
}

/** «адрес (перенесена на начало)» — перечнем для сообщений об отказе. */
function movedLabels(o: CalendarObject, moved: readonly Instance[]): string {
  return moved.map((instance) => `${instance.instanceStart} (перенесена на ${formatForModel(instance.start, o.env, "time")})`).join(", ");
}

function roleOfKey(o: CalendarObject, key: SlotKey): OverrideRole | undefined {
  const refs = o.overrides.get(key);
  return refs && refs.length > 0 ? o.roles.get(refs[0].component)?.role : undefined;
}

/** Видимые встречи со своими компонентами (переопределения слотов и detached) с адресом не раньше `from`. */
function ownMeetingsFrom(o: CalendarObject, from: SlotKey): Instance[] {
  const found: Instance[] = [];
  for (const [key, refs] of o.overrides) {
    if (compareSlotKeys(key, from) < 0) continue;
    const role = o.roles.get(refs[0].component)?.role;
    if (role !== "slot" && role !== "detached") continue;
    const instance = instanceAt(o, key);
    if (instance) found.push(instance);
  }
  return found;
}

/**
 * Встречи с адресом до границы, которые после усечения стали бы невидимыми
 * (detached за последним оставшимся слотом): потеря сверх цели. С confirm
 * их компоненты не снимаются — остаются скрытыми (их можно удалить delete
 * this по адресу): так теряется только видимость, а не данные.
 */
function becameHidden(o: CalendarObject, next: CalendarObject, boundary: SlotKey): Array<{ key: SlotKey; loss: Loss }> {
  const lost: Array<{ key: SlotKey; loss: Loss }> = [];
  for (const [key, refs] of o.overrides) {
    if (compareSlotKeys(key, boundary) >= 0) continue;
    const role = o.roles.get(refs[0].component)?.role;
    if (role === "hidden") continue;
    const now = roleOfKey(next, key);
    if (now === "slot" || now === "detached") continue;
    const instance = instanceAt(o, key);
    if (instance) lost.push({ key, loss: lossOf(o.env, instance, "после усечения оказывается за концом серии и становится невидимой") });
  }
  return lost;
}

const HIDDEN_MESSAGE = "Встречи до границы остались бы за концом усечённой серии и стали бы невидимы (их компоненты сохранятся скрытыми).";

/**
 * Оторванные встречи до границы, которые усечение сделало бы невидимыми
 * (`becameHidden`): с confirm — потеря видимости, данные остаются. Но если
 * после усечения в объекте не осталось бы ни одной видимой встречи, отказ:
 * пустой объект не записывается (Р3), а удалить его целиком — значит
 * удалить и встречи до границы, которых удалять не просили. Пусто бывает и
 * без таких встреч: когда до границы видна только встреча хвоста,
 * перенесённая раньше неё, — она уходит в продолжение (у правки; у удаления
 * этот путь не встречается, там до границы есть встреча по адресу).
 */
function hiddenAfterCut(o: CalendarObject, next: CalendarObject, boundary: SlotKey, op: EditOp): Array<{ key: SlotKey; loss: Loss }> {
  const hidden = becameHidden(o, next, boundary);
  if (!isEmpty(next)) return hidden;
  if (hidden.length > 0) {
    throw cutRefusal(
      o,
      boundary,
      op,
      `до неё видны только отдельные встречи ${hidden.map((entry) => entry.loss.instanceStart).join(", ")}, а после усечения они оказались бы ` +
        "за концом серии: в объекте не осталось бы ни одной видимой встречи",
    );
  }
  // До границы видны только встречи хвоста, перенесённые раньше неё (Р2 «включая
  // перенесённые»): их адрес в хвосте, они уходят в продолжение, и усечённая серия
  // остаётся без единой видимой встречи — пустой объект не записывается (Р3).
  const moved = movedBefore(o, boundary);
  throw cutRefusal(
    o,
    boundary,
    op,
    moved.length > 0
      ? `до неё видны только встречи ${movedLabels(o, moved)}, чей адрес лежит в хвосте: они уходят в продолжение, ` +
        "и в усечённой серии не осталось бы ни одной видимой встречи"
      : "после усечения в объекте не осталось бы ни одной видимой встречи",
  );
}

/**
 * Можно ли усечь серию перед границей B, не оставив в ней слотов от B и не
 * испортив правило (таблица §3, t&f):
 * - B позже DTSTART: DTSTART не снять ни UNTIL, ни COUNT, а EXDATE оставил бы
 *   в усечённой серии закрытый слот от B (так бывает, когда раньше DTSTART
 *   стоят значения RDATE, и когда до B видна только встреча хвоста,
 *   перенесённая раньше неё, — тогда отказ называет именно её);
 * - у правила есть позиции раньше B: иначе UNTIL перед B дал бы правило без
 *   позиций (аномалия no-positions), а снять RRULE целиком правка без
 *   recurrence не вправе (О12б; так бывает при DTSTART вне правила).
 */
function refuseUncuttable(o: CalendarObject, boundary: SlotKey, op: EditOp): void {
  const master = o.master!;
  const startKey = slotKeyOf(master.getFirstPropertyValue("dtstart") as ICAL.Time, o.form, o.env);
  if (compareSlotKeys(boundary, startKey) <= 0) {
    // До границы видна только перенесённая раньше неё встреча хвоста: про RDATE
    // говорить нечего, и чинится это правкой всей серии, а не разрезом.
    const moved = hasVisibleBefore(o, boundary) ? [] : movedBefore(o, boundary);
    const reason = moved.length > 0
      ? `это начало серии (DTSTART), а встречи ${movedLabels(o, moved)} перенесены раньше него: отрезать начало, оставив их, нельзя`
      : "это начало серии (DTSTART), а раньше него есть встречи из RDATE: отрезать начало, оставив их, нельзя";
    throw cutRefusal(o, boundary, op, reason);
  }
  if (master.hasProperty("rrule") && positionsBefore(o, boundary) === 0) {
    throw cutRefusal(o, boundary, op, `начало серии стоит вне правила, а у правила нет встреч раньше ${keyLabel(o, boundary, "instance")}: усечённое правило не дало бы ни одной встречи`);
  }
}

function cutRefusal(o: CalendarObject, boundary: SlotKey, op: EditOp, reason: string): EditRefusal {
  const label = keyLabel(o, boundary, "instance");
  return new EditRefusal(
    "split-mismatch",
    `${op === "update" ? "Разрезать" : "Усечь"} серию на встрече ${label} нельзя: ${reason}. Объект не тронут.`,
    {
      hint: op === "update"
        ? "Измените всю серию (scope all_series) или отдельные встречи (scope this)."
        : "Удалите встречи по одной (scope this) или всю серию (scope all_series).",
    },
  );
}

function hiddenNotice(hidden: ReadonlyArray<{ loss: Loss }>): string[] {
  if (hidden.length === 0) return [];
  return [
    `Встречи ${hidden.map((entry) => entry.loss.instanceStart).join(", ")} оказались за концом серии и больше не видны; ` +
      "их компоненты сохранены как скрытые и удаляются delete_event со scope this по тому же адресу.",
  ];
}

// Встречи с адресом раньше границы, перенесённые на границу или позже.
function movedPastBoundary(o: CalendarObject, boundary: SlotKey, boundaryMs: number, what: string): string[] {
  const moved: string[] = [];
  for (const [key, refs] of o.overrides) {
    if (compareSlotKeys(key, boundary) >= 0) continue;
    const role = o.roles.get(refs[0].component)?.role;
    if (role !== "slot" && role !== "detached") continue;
    const instance = instanceAt(o, key);
    if (instance && instance.startMs >= boundaryMs) moved.push(`${instance.instanceStart} (перенесена на ${formatForModel(instance.start, o.env, "time")})`);
  }
  return moved.length > 0 ? [`Встречи ${moved.join(", ")} перенесены за границу, но ${what}.`] : [];
}

/** Горизонт перечня удаляемых встреч: дней после max(граница, сейчас, последний явный ключ). */
const HORIZON_DAYS = 800;
const HORIZON_MIN_SLOTS = 10;
const HORIZON_STEPS = 100_000;
/** Сколько удаляемых встреч перечислять в ответе. */
const LOSS_LIST = 50;

/**
 * Видимые встречи с адресом не раньше `from` — для ответа и для
 * предохранителя (О12в): ключи до горизонта с запасом (800 дней после
 * max(граница, сейчас, последний явный ключ) и ещё ≥ 10 встреч), в ответе —
 * первые 50 встреч.
 */
function meetingsFrom(o: CalendarObject, from: SlotKey, now: Date | number, reason: string): { keys: SlotKey[]; losses: Loss[]; notices: string[] } {
  const env = o.env;
  const until = horizonKey(o, from, now);
  const entries = new Map<SlotKey, () => Loss>();
  let exhausted = true;
  if (o.master) {
    let seen = 0;
    let found = 0;
    for (const slot of iterateSlots(o)) {
      if (++seen > HORIZON_STEPS) {
        exhausted = false;
        break;
      }
      if (compareSlotKeys(slot.key, from) < 0 || slot.excluded) continue;
      if (compareSlotKeys(slot.key, until) > 0 && found >= HORIZON_MIN_SLOTS) {
        exhausted = false;
        break;
      }
      found += 1;
      const own = roleOfKey(o, slot.key) === "slot";
      entries.set(slot.key, own ? () => lossOf(env, instanceAt(o, slot.key)!, reason) : () => slotLoss(o, slot, reason));
    }
  }
  for (const [key, refs] of o.overrides) {
    if (compareSlotKeys(key, from) >= 0 && o.roles.get(refs[0].component)?.role === "detached") {
      entries.set(key, () => lossOf(env, instanceAt(o, key)!, reason));
    }
  }
  const keys = [...entries.keys()].sort(compareSlotKeys);
  const losses = keys.slice(0, LOSS_LIST).map((key) => entries.get(key)!());
  const notices: string[] = [];
  if (!exhausted) notices.push("Удалены и все следующие встречи серии; в ответе перечислены первые из них.");
  else if (keys.length > LOSS_LIST) notices.push(`Удалено встреч: ${keys.length}; в ответе перечислены первые ${LOSS_LIST}.`);
  return { keys, losses, notices };
}

/** Горизонт перебора: HORIZON_DAYS дней после max(from, сейчас, последний явный ключ — RID, EXDATE, RDATE). */
function horizonKey(o: CalendarObject, from: SlotKey, now: Date | number): SlotKey {
  const explicit = [...o.overrides.keys(), ...(o.master ? [...listKeys(o.master, "exdate", o), ...listKeys(o.master, "rdate", o)] : [])];
  return keyPlusDays(o, [from, keyOfMs(o, msOf(now)), ...explicit].reduce((a, b) => (compareSlotKeys(a, b) >= 0 ? a : b)), HORIZON_DAYS);
}

function msOf(now: Date | number): number {
  return typeof now === "number" ? now : now.getTime();
}

// Время UTC по секундам Unix (time.js:1313, fromUnixTime — через UTC-поля, от пояса процесса не зависит).
function utcAt(seconds: number): ICAL.Time {
  const t = ICAL.Time.fromData({ year: 1970, month: 1, day: 1, hour: 0, minute: 0, second: 0, isDate: false }, ICAL.Timezone.utcTimezone);
  t.fromUnixTime(seconds);
  return t;
}

function keyOfMs(o: CalendarObject, ms: number): SlotKey {
  return slotKeyOf(utcAt(Math.floor(ms / 1000)), o.form, o.env);
}

// Значение по ключу: T — момент в UTC, D — дата, F — плавающее стенное время.
function timeOfKey(key: SlotKey): ICAL.Time {
  if (key.startsWith("T:")) return utcAt(Number(key.slice(2)));
  return parseModelTime(key.slice(2)).time;
}

/**
 * Ключ для сообщений по Р10 — в форме серии `o`: у серии в Москве со
 * смещением Москвы, а не UTC, которое отдаёт `timeOfKey`. Если пояс серии для
 * перевода не годится — как есть.
 */
function keyLabel(o: CalendarObject, key: SlotKey, as: "time" | "instance"): string {
  const t = timeOfKey(key);
  try {
    return formatForModel(timeInForm(t, o.form, o.zone, o.env), o.env, as);
  } catch {
    return formatForModel(t, o.env, as);
  }
}

function keyPlusDays(o: CalendarObject, key: SlotKey, days: number): SlotKey {
  if (key.startsWith("T:")) return `T:${Number(key.slice(2)) + days * 86_400}`;
  const t = timeOfKey(key).clone();
  t.adjust(days, 0, 0, 0); // time.js, adjust: календарная арифметика
  return slotKeyOf(t, o.form, o.env);
}

function tailOf(o: CalendarObject): Expectation["tail"] {
  const extent = seriesExtent(o);
  if (extent.kind === "too-long") {
    throw new EditRefusal("series-too-long", `Серия после правки длиннее ${SERIES_CAP} встреч: её протяжённость не проверить.`, {
      hint: "Задайте серии конец (recurrence.until или count) поближе.",
    });
  }
  if (extent.kind === "infinite") return undefined;
  return { count: extent.count, lastDate: extent.last ? wallDateOf(extent.last.time, o.env) : undefined };
}

// ─────────────────────────────── правка ───────────────────────────────

function updatePlan(run: Run, scope: EditScope, request: UpdateRequest): WritePlan {
  const { o } = run;
  refuseCorrupted(o, "update", scope);
  const patch = request.patch;
  const timed = hasTimeFields(fieldsOf(patch)) || patch.recurrence !== undefined;

  if (o.kind === "single") {
    // Событие правится на месте при любом scope. Неизвестный пояс мешает
    // только правке времени (её отвергнет и patch.ts, unknown-timezone).
    refuseBlocking(blockingAnomalies(o, "update", scope).filter((anomaly) => timed || anomaly.code !== "unknown-tzid"));
    if (request.instanceStart !== undefined) {
      noteAmbiguity(run, resolveTarget(o, request.instanceStart, "update", { confirm: run.confirmed }), "изменена");
    }
    return updateSingle(run, patch, scope);
  }

  refuseBlocking(blockingAnomalies(o, "update", scope));
  if (o.kind === "detached") {
    if (scope !== "this") {
      throw new EditRefusal("invalid-field", "В объекте только отдельные встречи чужой серии, самой серии здесь нет: её хвост или её целиком не изменить.", {
        hint: "Меняйте встречи по одной: scope this и instanceStart встречи.",
      });
    }
    if (request.instanceStart === undefined) throw missingAddress("update", "встречу");
  }
  let resolved: Resolved | undefined;
  if (request.instanceStart !== undefined) {
    resolved = resolveTarget(o, request.instanceStart, "update", { confirm: run.confirmed });
    noteAmbiguity(run, resolved, "изменена");
  } else if (scope !== "all_series") {
    throw missingAddress("update", scope === "this" ? "одну встречу" : "хвост");
  }

  if (scope === "this") {
    const target = resolved!.target;
    refuseBlocking(blockingAnomalies(o, "update", "this", { key: target.key }));
    return updateThis(run, target, patch);
  }
  if (scope === "all_series") {
    refuseBlocking(blockingAnomalies(o, "update", "all_series", { key: resolved?.target.key }));
    return updateAll(run, patch, "all_series");
  }

  const target = resolved!.target;
  if (target.kind !== "slot") {
    throw new EditRefusal("invalid-field", `${request.instanceStart} — не встреча серии, а отдельная встреча: разрезать серию по ней нельзя.`, {
      hint: "Передайте instanceStart встречи серии или измените эту встречу отдельно (scope this).",
    });
  }
  // Р2 у правки: «включая перенесённые» — встреча хвоста, перенесённая раньше B,
  // тоже стоит до границы, и правка всей серии одним put переписала бы её.
  if (!hasVisibleBefore(o, target.key, true)) {
    refuseBlocking(blockingAnomalies(o, "update", "this_and_following", { key: target.key }));
    run.notices.push(`До ${target.instance.instanceStart} встреч нет: изменена вся серия, событие то же (разреза нет).`);
    return updateAll(run, patch, "this_and_following", target);
  }
  refuseBlocking(blockingAnomalies(o, "update", "this_and_following", { key: target.key, split: true }));
  return updateSplit(run, target, patch);
}

/**
 * Одиночное событие: правка на месте; recurrence делает его серией.
 *
 * Если событие показано своим переопределением (RECURRENCE-ID = DTSTART,
 * роль slot — так бывает у серии из DTSTART и RDATE после снятия последнего
 * RDATE, усечения или разреза), правка ложится на него, как update this:
 * иначе поля ушли бы в невидимый основной компонент, а сдвиг DTSTART увёл бы
 * основной из-под RECURRENCE-ID — переопределение стало бы скрытым, и
 * встреча потеряла бы свои поля.
 */
function updateSingle(run: Run, patch: EventPatch, scope: EditScope): WritePlan {
  const { o } = run;
  const key = slotKeyOf(o.master!.getFirstPropertyValue("dtstart") as ICAL.Time, o.form, o.env);
  if (roleOfKey(o, key) === "slot") return updateShownOverride(run, key, patch);
  const work = copyOf(o);
  const master = work.master!;
  const touched = newTouched();
  applyFieldPatch(master, fieldsOf(patch), patchContext(run, touched));
  let ruleAdded = false;
  if (patch.recurrence !== undefined) {
    addRule(master, patch.recurrence, run.env, touched);
    ruleAdded = true;
  }
  const expect = expectation("update", scope, requestedFields(patch), { target: key, touched });
  if (!touchedEvents(touched)) return { kind: "noop", expect, removed: [], notices: run.notices };
  stampTouched(run, [master], touched);
  const next = copyOf(work);
  // Скрытые компоненты (RECURRENCE-ID мимо начала) остаются скрытыми: новое начало или правило
  // не делает их видимыми встречами со старыми полями.
  const changed = changedRoles(o, next);
  if (changed.length > 0) {
    throw new EditRefusal(
      "invalid-time",
      `После правки скрытые компоненты события стали бы видимыми встречами: ${changed.join(", ")}.`,
      { hint: "Сначала удалите скрытый компонент (delete_event со scope this по его адресу), затем повторите правку." },
    );
  }
  if (ruleAdded) {
    requireSynced(next, "первая встреча события");
    expect.ruleChanged = true;
    expect.tail = tailOf(next);
  }
  return { kind: "put", ics: serializeObject(work), expect, removed: [], notices: run.notices };
}

/**
 * Одиночное событие, показанное своим переопределением: правится оно, как
 * update this (цель — слот DTSTART), основной компонент не меняется. Для
 * предохранителя это правка одной встречи (scope this): у одиночного события
 * любой scope означает само событие. Повтор так не задать — правило легло бы
 * на основной компонент, чьих полей не видно.
 */
function updateShownOverride(run: Run, key: SlotKey, patch: EventPatch): WritePlan {
  const { o } = run;
  const instance = instanceAt(o, key);
  const slot = findSlot(o, key);
  if (!instance || !slot) throw new Error(`У одиночного события ${o.uid} нет встречи в его DTSTART.`);
  if (patch.recurrence !== undefined) {
    throw new EditRefusal(
      "invalid-field",
      `Событие ${instance.instanceStart} показано своим переопределением (RECURRENCE-ID), а не основным компонентом: ` +
        "сделать его повторяющимся нельзя — правило легло бы на основной компонент, чьих полей не видно.",
      { hint: "Измените поля и время события без recurrence или создайте новую серию." },
    );
  }
  return updateThis(run, { kind: "single", key, slot, instance }, patch);
}

/** Переопределения, чья роль после правки другая (скрытое стало видимым, видимое — скрытым или отдельным). */
function changedRoles(o: CalendarObject, next: CalendarObject): string[] {
  const changed: string[] = [];
  for (const key of new Set([...o.overrides.keys(), ...next.overrides.keys()])) {
    const was = roleOfKey(o, key);
    const now = roleOfKey(next, key);
    if (was !== now) changed.push(`${keyLabel(o, key, "instance")} (${was ?? "нет"} → ${now ?? "нет"})`);
  }
  return changed;
}

const FREQUENCIES: Readonly<Record<string, string>> = { daily: "DAILY", weekly: "WEEKLY", monthly: "MONTHLY", yearly: "YEARLY" };

/** Новое RRULE по патчу повтора (Р4): частота обязательна, прочее — как у patchRule. */
function addRule(master: ICAL.Component, rp: RecurrencePatch, env: IcalEnv, touched: Touched): void {
  const frequency = (rp as { frequency?: unknown }).frequency;
  if (typeof frequency !== "string" || !Object.hasOwn(FREQUENCIES, frequency)) {
    throw new EditRefusal("invalid-rule", "Чтобы событие стало повторяющимся, нужна частота recurrence.frequency: daily, weekly, monthly или yearly.");
  }
  const property = new ICAL.Property("rrule");
  setRuleDict(property, { freq: FREQUENCIES[frequency] });
  master.addProperty(property);
  markProperty(touched, master, property);
  patchRule(property, { ...rp, replace: undefined }, { env, touched });
}

function requireSynced(next: CalendarObject, what: string): void {
  if (isDtstartSynced(next)) return;
  const start = formatForModel(next.master!.getFirstPropertyValue("dtstart") as ICAL.Time, next.env, "instance");
  throw new EditRefusal(
    "unsynced-rule",
    `Начало серии ${start} (${what}) не совпадает с первой встречей по правилу: по RFC 5545 оно было бы лишней встречей вне правила.`,
    { hint: "Передайте start на первую дату по новому правилу или согласуйте с ним byWeekday." },
  );
}

/**
 * update this (таблица §3): правится переопределение встречи на месте
 * (RECURRENCE-ID неизменен), у встречи без него — клон основного (О6) с
 * патчем; detached — на месте. Основной компонент, EXDATE, RDATE и конец
 * серии не меняются.
 */
function updateThis(run: Run, target: Target, patch: EventPatch): WritePlan {
  const { o } = run;
  if (patch.recurrence !== undefined) {
    throw new EditRefusal("invalid-field", "Повтор (recurrence) меняется у всей серии или у её хвоста, а не у одной встречи.", {
      hint: 'Передайте scope: "all_series" или "this_and_following".',
    });
  }
  if (target.kind === "hidden") throw new Error("Скрытый компонент правкой не адресуется (resolveTarget).");
  const instance = target.instance;
  if (instance.cancelled) {
    throw new EditRefusal("invalid-field", `Встреча ${instance.instanceStart} отменена (STATUS:CANCELLED): отменённую встречу не правят.`, {
      hint: "Её можно удалить (delete_event со scope this) и при необходимости создать новую.",
    });
  }
  const fields = fieldsOf(patch);
  if (fields.allDay !== undefined && fields.allDay !== instance.start.isDate) {
    if (target.kind === "single") {
      throw new EditRefusal(
        "invalid-time",
        "Событие показано своим переопределением (RECURRENCE-ID): «весь день» у него не переключить — " +
          "форма времени переопределения обязана совпадать с основным компонентом (RFC 5545 §3.8.4.4).",
        { hint: "Измените только время события или создайте новое событие на весь день." },
      );
    }
    throw new EditRefusal("invalid-time", "«Весь день» меняется только у всей серии: у одной встречи форма времени должна совпадать с серией (RFC 5545 §3.8.4.4).", {
      hint: 'Передайте scope: "all_series" или измените только время этой встречи.',
    });
  }
  const work = copyOf(o);
  const touched = newTouched();
  const component = targetComponent(work, target, touched);
  applyFieldPatch(component, fields, patchContext(run, touched));
  const expect = expectation("update", "this", requestedFields(patch), { target: target.key, touched });
  if (!touchedEvents(touched)) return { kind: "noop", expect, removed: [], notices: run.notices };
  stampTouched(run, [component], touched);
  return { kind: "put", ics: serializeObject(work), expect, removed: [], notices: run.notices };
}

function targetComponent(work: CalendarObject, target: Target, touched: Touched): ICAL.Component {
  const role: OverrideRole = target.kind === "detached" ? "detached" : "slot";
  const own = (work.overrides.get(target.key) ?? []).filter((ref) => work.roles.get(ref.component)?.role === role);
  if (own.length > 0) return shownOverride(own).component;
  if (target.kind !== "slot") throw new Error(`У встречи ${target.key} нет своего компонента.`);
  const slot = findSlot(work, target.key);
  if (!slot || slot.excluded) throw new Error(`Слот ${target.key} не найден в копии объекта.`);
  return overrideFromMaster(work, slot, touched);
}

// ─────────────────────────────── вся серия (Р1) ───────────────────────────────

/** Поля, которые переопределения наследуют от основного (О7). */
const INHERITED: ReadonlySet<PatchField> = new Set(["summary", "description", "location", "attendees", "reminders"]);

/** Переопределение и его роль до правки. */
interface OverrideInfo {
  component: ICAL.Component;
  /** Ключ RECURRENCE-ID в форме исходной серии. */
  oldKey: SlotKey;
  role: OverrideRole;
  /** Начало не совпадает с RECURRENCE-ID (встреча перенесена). */
  moved: boolean;
}

function overridesOf(o: CalendarObject): OverrideInfo[] {
  const infos: OverrideInfo[] = [];
  for (const [key, refs] of o.overrides) {
    for (const ref of refs) {
      infos.push({ component: ref.component, oldKey: key, role: o.roles.get(ref.component)!.role, moved: isMoved(ref.component, key, o) });
    }
  }
  return infos;
}

function isMoved(c: ICAL.Component, key: SlotKey, o: CalendarObject): boolean {
  const start = c.getFirstPropertyValue("dtstart") as ICAL.Time;
  return slotKeyOf(start, o.form, o.env) !== key || start.isDate !== (o.form === "date");
}

/**
 * update all_series (таблица §3, Р1): основной компонент правится на месте;
 * из start и end — только время суток, длительность и пояс, дата начала
 * серии прежняя (дата — только вместе с recurrence). При сдвиге начала —
 * позиционное сопоставление: EXDATE, RECURRENCE-ID и UNTIL идут за своими
 * встречами, RDATE — на ту же стенную разницу (при смене одного пояса —
 * моменты прежние), COUNT не меняется; даты встреч прежние (иначе отказ
 * unsynced-rule), начало серии обязано стоять на первой позиции правила.
 * Переопределения — по О7. Смена правила — сопоставление по ключу:
 * переопределения без пары снимаются только с confirm, EXDATE остаются.
 *
 * `boundary` — t&f без встреч до границы (Р2): правка всей серии, но цель —
 * встреча B. Она получает поля патча безусловно (как при разрезе), дата в
 * start сверяется с датой B, а новое время суток берётся от B — поэтому,
 * если B идёт в другое время суток, чем начало серии, start и end отказ.
 */
function updateAll(run: Run, patch: EventPatch, scope: EditScope, boundary?: SlotTarget): WritePlan {
  const { o, env } = run;
  const source = o.master!;
  const fields = fieldsOf(patch);
  const recurrence = patch.recurrence;
  const requested = requestedFields(patch);
  const toggle = fields.allDay !== undefined && fields.allDay !== (o.form === "date");
  if (toggle) refuseToggle(o, [...o.overrides.values()].flat().length > 0);
  // Серия с несколькими RRULE сюда не доходит: она — испорченный объект (`refuseCorrupted`),
  // и правка любого scope в ней отвергается до разбора патча.
  const boundaryDate = boundary ? refuseForeignTimeOfDay(run, boundary, fields) : undefined;
  const place = boundary ? `у встреч с ${boundary.instance.instanceStart}` : "у всей серии";

  const work = copyOf(o);
  const master = work.master!;
  const touched = newTouched();
  const oldMaster = cloneComponent(master);
  const infos = overridesOf(work);
  const oldLength = lengthOf(master, env);

  // 1. Поля и время основного (Р1): время суток на прежней дате.
  const applied = applyRebased(run, master, fields, touched, { place, literalLater: recurrence !== undefined, shownDate: boundaryDate });
  const newLength = lengthOf(master, env);
  const startMoved = !sameTimeProperty(source.getFirstProperty("dtstart")!, master.getFirstProperty("dtstart")!);
  // Р1: начало вне первой позиции правила (другой клиент, BYHOUR) — отдельная встреча вне правила;
  // позиционный сдвиг слил бы её с позицией или потерял бы.
  if (startMoved && recurrence === undefined && source.hasProperty("rrule") && !isDtstartSynced(o)) {
    throw unsynced(
      `Начало серии ${formatForModel(source.getFirstPropertyValue("dtstart") as ICAL.Time, env, "instance")} стоит вне правила ` +
        "(RFC 5545 §3.8.5.3: это отдельная встреча): сдвинуть время серии, сопоставив встречи по позициям правила, нельзя.",
    );
  }
  const mode = fields.start !== undefined || toggle ? "wall" : "moment";
  let retimed: Retimed | undefined;
  if (startMoved) {
    const dtstart = source.getFirstPropertyValue("dtstart") as ICAL.Time;
    try {
      retimed = retime({
        run,
        source: o,
        root: work.root,
        master,
        anchorKey: slotKeyOf(dtstart, o.form, env),
        anchorTime: dtstart,
        skip: 0,
        mode,
        overrides: infos,
        lengths: { old: oldLength, new: newLength },
        touched,
      });
    } catch (error) {
      if (error instanceof MappingError) throw unsynced(error.message);
      throw error;
    }
    if (mode === "wall" && !toggle && recurrence === undefined) refuseShiftedDates(retimed);
  } else if (!sameLength(oldLength, newLength)) {
    for (const info of infos) {
      if (info.moved) continue;
      if (sameLength(lengthOf(info.component, env), oldLength) && newLength) {
        const start = info.component.getFirstPropertyValue("dtstart") as ICAL.Time;
        writeEnd(info.component, start, newLength, env, touched, ownEndFrame(info.component, env));
      }
    }
  }
  const inheritable = requested.filter((field) => INHERITED.has(field));
  for (const info of infos) {
    if (info.role === "hidden") continue;
    // Р2: встреча B — цель правки, как при разрезе, получает патч безусловно (дата — её собственная).
    if (boundary && info.oldKey === boundary.key) applyRebased(run, info.component, fields, touched, { place, literalLater: true, quiet: true });
    else if (inheritable.length > 0) inheritFields(info.component, oldMaster, master, inheritable, touched);
  }
  if (retimed) checkPositional(o, copyOf(work), infos, retimed);

  // 2. Повтор (Р1, Р4): сопоставление по ключу.
  let ruleChanged = startMoved || (retimed?.untilChanged ?? false);
  let step: RuleStep | undefined;
  if (recurrence !== undefined) {
    step = prepareRule(run, {
      source: o,
      root: work.root,
      master,
      recurrence,
      literal: applied.literal,
      overrides: infos,
      loss: (info) => lossOf(env, instanceAt(o, info.oldKey)!, "у встречи нет пары в новом правиле"),
      touched,
    });
    commitRule(run, work.root, step, touched);
    ruleChanged ||= step.changed;
  }

  const expect = expectation("update", scope, requested, { target: boundary?.key, touched });
  if (!touchedEvents(touched)) return { kind: "noop", expect, removed: [], notices: run.notices };
  if (touched.names.get(master)?.has("rrule")) refuseDistorted(master, "менять правило или время серии");
  stampTouched(run, [master, ...infos.map((info) => info.component)], touched);
  const next = copyOf(work);
  // Начало на первой позиции правила (RFC 5545 §3.8.5.3): иначе оно — лишняя встреча вне правила (Р1, unsynced-rule).
  if (ruleChanged && isDtstartSynced(o)) requireSynced(next, "у всей серии");
  expect.keyMap = retimed ? retimed.mapper.mapKey : undefined;
  expect.removed = step?.keys ?? [];
  expect.ruleChanged = ruleChanged;
  expect.datesFixed = recurrence === undefined && (!startMoved || retimed!.sameDates);
  if (ruleChanged) expect.tail = tailOf(next);
  if (step) confirmRule(run, step);
  return { kind: "put", ics: serializeObject(work), expect, removed: step ? ruleLosses(step) : [], notices: run.notices };
}

/**
 * Р2 (t&f без встреч до B): новое время суток из start и end считается от B,
 * а ложится на начало серии — это одно и то же, только если B идёт в то же
 * время суток, что и DTSTART. Иначе (B — RDATE в другое время, у DTSTART
 * своё время) встреча B уехала бы не туда, куда просили, — отказ.
 * Возвращает дату B (для пояснения о дате из start).
 */
function refuseForeignTimeOfDay(run: Run, boundary: SlotTarget, fields: FieldPatch): string {
  const { o, env } = run;
  const b = boundary.slot.time; // в форме и поясе DTSTART (slots.ts, Slot.time)
  const date = dateString(b);
  if (fields.start === undefined && fields.end === undefined) return date;
  // «Весь день» — у него времени суток нет: ни до правки (форма серии date), ни после (allDay: true).
  if (fields.allDay === true || o.form === "date") return date;
  const d = o.master!.getFirstPropertyValue("dtstart") as ICAL.Time;
  if (b.hour === d.hour && b.minute === d.minute && b.second === d.second) return date;
  throw unsynced(
    `Встреча ${boundary.instance.instanceStart} идёт в другое время суток, чем начало серии ` +
      `${formatForModel(d, env, "instance")}: новое время нельзя однозначно применить к ней и ко всем следующим встречам.`,
  );
}

/**
 * Р1 без recurrence: сопоставление n → n не переносит встречи на другие
 * даты. У HOURLY или BYHOUR новое время суток переводит часть позиций через
 * полночь — такой сдвиг не выразить с прежними датами.
 */
function refuseShiftedDates(retimed: Retimed): void {
  if (retimed.sameDates) return;
  throw unsynced(
    `После сдвига времени встречи правила перешли бы на другие даты${retimed.shiftedAt ? ` (${retimed.shiftedAt})` : ""}: ` +
      "без правила повтора меняется только время суток, даты встреч прежние (Р1).",
  );
}

function refuseToggle(o: CalendarObject, withOverrides: boolean): void {
  if (withOverrides) {
    throw new EditRefusal("invalid-time", "У серии есть изменённые или перенесённые встречи: переключить «весь день» у всей серии нельзя — время их переноса не сопоставить с датами.", {
      hint: "Удалите или измените эти встречи по отдельности, либо создайте новую серию.",
    });
  }
  if (o.master!.getAllProperties("rdate").some((property) => property.type === "period")) {
    throw new EditRefusal("invalid-time", "У серии есть встречи RDATE с длительностью (PERIOD): переключить «весь день» у всей серии нельзя.");
  }
}

function unsynced(message: string): EditRefusal {
  return new EditRefusal("unsynced-rule", message, {
    hint: "Измените время отдельных встреч (scope this) или передайте вместе с новым временем правило повтора (recurrence).",
  });
}

/**
 * Проверки позиционного сдвига серии: роли переопределений прежние (встреча
 * не стала скрытой или отдельной), EXDATE без встречи не накрыл новую встречу,
 * встреча из RDATE не слилась со встречей правила. Начало на первой позиции
 * правила проверяет `requireSynced` уже после смены правила: новое правило из
 * того же патча может согласовать сдвинутое начало.
 */
function checkPositional(o: CalendarObject, next: CalendarObject, infos: readonly OverrideInfo[], retimed: Retimed): void {
  const env = o.env;
  for (const info of infos) {
    if (!info.component.parent) continue;
    const rid = info.component.getFirstPropertyValue("recurrence-id") as ICAL.Time;
    const role = roleOfKey(next, slotKeyOf(rid, next.form, env));
    if (role !== info.role) {
      throw unsynced(`После сдвига серии встреча с адресом ${formatForModel(rid, env, "instance")} перестала бы совпадать со своим местом в серии (${info.role} → ${role ?? "нет"}).`);
    }
  }
  for (const key of retimed.orphans) {
    if (findSlot(next, key)) {
      throw unsynced(`После сдвига серии исключение EXDATE, не относившееся ни к одной встрече, совпало бы со встречей ${keyLabel(next, key, "time")} и скрыло бы её.`);
    }
  }
  // RDATE сдвигается сам (стенной разницей или моментом), позиция правила — по правилу: отдельная
  // дата не должна слиться с позицией, а дата на позиции — разойтись с ней (встреча раздвоилась бы).
  const onlyRdate = (slot: Slot | undefined) => slot !== undefined && slot.sources.length === 1 && slot.sources[0] === "rdate";
  for (const [oldKey, newKey] of retimed.rdates) {
    const was = findSlot(o, oldKey);
    const now = findSlot(next, newKey);
    if (onlyRdate(was) && !onlyRdate(now)) {
      throw unsynced(`После сдвига серии отдельная дата RDATE ${keyLabel(o, oldKey, "time")} совпала бы со встречей по правилу, и одна из встреч пропала бы.`);
    }
    if (was !== undefined && !onlyRdate(was) && onlyRdate(now)) {
      throw unsynced(
        `Встреча ${keyLabel(o, oldKey, "time")} задана и правилом, и RDATE: после сдвига серии дата RDATE разошлась бы с позицией правила, и встреча раздвоилась бы.`,
      );
    }
  }
}

// ─────────────────────────────── смена правила ───────────────────────────────

interface RuleStepInput {
  /** Исходный объект — для адресов в перечне потерь. */
  source: CalendarObject;
  root: ICAL.Component;
  master: ICAL.Component;
  recurrence: RecurrencePatch;
  /** start и end патча как есть — дата применяется только вместе с правилом (Р1). */
  literal?: FieldPatch;
  overrides: readonly OverrideInfo[];
  loss: (info: OverrideInfo) => Loss;
  touched: Touched;
}

/** Итог смены правила: что меняется и что теряется (подтверждение — у вызывающего, О11). */
interface RuleStep {
  changed: boolean;
  /** Части прежнего правила, потерянные при replace. */
  lostParts: string[];
  /** Видимые встречи без пары в новом правиле. */
  losses: Loss[];
  /** Их прежние ключи — для expect.removed. */
  keys: SlotKey[];
  /** Скрытые компоненты, которые новое правило сделало бы видимыми встречами. */
  traces: Loss[];
  /** Компоненты к снятию: переопределения без пары и такие скрытые. */
  drop: ICAL.Component[];
}

/**
 * Смена правила (Р1 «с recurrence», Р4): дата начала из start, правка
 * правила (patchRule), затем сопоставление по ключу. Дерево меняется на месте,
 * но компоненты не снимаются (это `commitRule`) и подтверждение не требуется
 * (это `confirmRule`): вызывающий собирает все потери плана в один отказ.
 * - видимое переопределение, у которого в новом правиле нет своего слота, —
 *   потеря; оторванное (detached), получившее слот, — не потеря: оно
 *   становится переопределением этого слота со всеми своими полями;
 * - скрытое, которое новое правило сделало бы видимым (след прошлых правок
 *   со старыми полями), — тоже потеря сверх цели: снимается, но только с
 *   confirm и с перечнем;
 * - части правила, теряемые при replace, — тоже с confirm;
 * - EXDATE не снимаются никогда: EXDATE вне нового правила безвреден, а без
 *   него следующая правка правила воскресила бы удалённую встречу.
 */
function prepareRule(run: Run, input: RuleStepInput): RuleStep {
  const { env } = run;
  const { root, master, touched } = input;
  if (input.literal) applyFieldPatch(master, input.literal, patchContext(run, touched));

  let lostParts: string[] = [];
  let changed = true;
  const rule = master.getFirstProperty("rrule");
  if (rule) {
    const outcome = patchRule(rule, input.recurrence, { env, touched });
    changed = outcome.changed || Boolean(input.literal);
    lostParts = outcome.lostParts;
  } else {
    addRule(master, input.recurrence, env, touched);
  }

  const next = reparse(textOf(root), env);
  const step: RuleStep = { changed, lostParts, losses: [], keys: [], traces: [], drop: [] };
  for (const info of input.overrides) {
    if (!info.component.parent) continue;
    const key = slotKeyOf(info.component.getFirstPropertyValue("recurrence-id") as ICAL.Time, next.form, env);
    const role = roleOfKey(next, key);
    if (info.role !== "hidden") {
      if (role === info.role || (info.role === "detached" && role === "slot")) continue;
      step.drop.push(info.component);
      if (!step.keys.includes(info.oldKey)) {
        step.keys.push(info.oldKey);
        step.losses.push(input.loss(info));
      }
    } else if (role === "slot" || role === "detached") {
      step.drop.push(info.component);
      step.traces.push({
        instanceStart: keyLabel(input.source, info.oldKey, "instance"),
        start: formatForModel(info.component.getFirstPropertyValue("dtstart") as ICAL.Time, env, "time"),
        summary: summaryOf(info.component),
        reason: "скрытый компонент (след прошлых правок) снят: в новом правиле он стал бы видимой встречей со старыми полями",
      });
    }
  }
  return step;
}

function commitRule(run: Run, root: ICAL.Component, step: RuleStep, touched: Touched): void {
  for (const c of step.drop) removeComponent(root, c, touched);
  if (step.lostParts.length > 0) run.notices.push(`Из правила удалены части ${step.lostParts.join(", ")}.`);
}

/** Потери смены правила для перечня и ответа: встречи без пары и скрытые следы. */
function ruleLosses(step: RuleStep): Loss[] {
  return [...step.losses, ...step.traces];
}

function ruleConfirmMessage(step: RuleStep): string {
  return [
    step.lostParts.length > 0 ? `Правило задано заново (replace): теряются части прежнего правила ${step.lostParts.join(", ")}.` : "",
    step.losses.length > 0 ? "У изменённых или перенесённых встреч нет пары в новом правиле, и они будут удалены." : "",
    step.traces.length > 0 ? "Скрытые компоненты серии в новом правиле стали бы видимыми встречами со старыми полями — они будут сняты." : "",
  ].filter(Boolean).join(" ");
}

function ruleNeedsConfirm(step: RuleStep): boolean {
  return step.losses.length > 0 || step.traces.length > 0 || step.lostParts.length > 0;
}

/** Подтверждение потерь смены правила (О11): без confirm — один отказ со всем перечнем. */
function confirmRule(run: Run, step: RuleStep): void {
  if (ruleNeedsConfirm(step) && !run.confirmed) throw needConfirm(ruleLosses(step), ruleConfirmMessage(step));
}

// ─────────────────────────────── разрез (Р9) ───────────────────────────────

type SlotTarget = Extract<Target, { kind: "single" | "slot" }>;

/**
 * update this_and_following с видимыми встречами до границы B (таблица §3,
 * Р9): продолжение — клон основного без SEQUENCE и CREATED с UID
 * `continuationUid`, DTSTART = дата B и время патча (дата — только с
 * recurrence, и не раньше даты B), COUNT минус позиции до B, UNTIL пересчитан
 * по последней встрече; EXDATE, RDATE и переопределения с адресом ≥ B
 * переходят в продолжение со сдвигом по позиции, поля — по О7, встреча B
 * получает патч безусловно; расписание сверяется с хвостом исходной серии
 * (`sameTail`). Исходный объект усекается перед B.
 *
 * Пустой патч (О13) ничего не пишет и серию не делит. Все потери разреза —
 * письма чужим участникам (новое событие может разослать приглашения),
 * встречи без пары в новом правиле, скрытые следы, встречи до B, которые
 * усечение сделало бы невидимыми, — подтверждаются одним отказом с полным
 * перечнем (О11).
 */
function updateSplit(run: Run, target: SlotTarget, patch: EventPatch): WritePlan {
  const { o, env } = run;
  const boundary = target.key;
  const boundaryTime = target.slot.time;
  const label = target.instance.instanceStart;
  const fields = fieldsOf(patch);
  const recurrence = patch.recurrence;
  const requested = requestedFields(patch);
  const toggle = fields.allDay !== undefined && fields.allDay !== (o.form === "date");
  const moving = [...o.overrides].filter(([key]) => compareSlotKeys(key, boundary) >= 0).flatMap(([, refs]) => refs);
  if (toggle) refuseToggle(o, moving.length > 0);

  // Продолжение: VCALENDAR с копиями нужных VTIMEZONE, клон основного и переносимых переопределений.
  const uid = continuationUid(o.uid, boundary);
  const contTouched = newTouched();
  const root = new ICAL.Component(["vcalendar", ICAL.helpers.clone(o.root.jCal[1], true), []]);
  const needed = new Set([o.master!, ...moving.map((ref) => ref.component)].flatMap((c) => [...tzidsIn(c)]));
  for (const zone of o.root.getAllSubcomponents("vtimezone")) {
    if (needed.has(String(zone.getFirstPropertyValue("tzid")))) root.addSubcomponent(new ICAL.Component(ICAL.helpers.clone(zone.jCal, true)));
  }
  // Клоны вставляются в дерево до первого чтения их значений (patch.ts, cloneComponent).
  const master = cloneComponent(o.master!);
  master.removeAllProperties("sequence");
  master.removeAllProperties("created");
  master.updatePropertyWithValue("uid", uid);
  root.addSubcomponent(master);
  const infos: OverrideInfo[] = [];
  for (const ref of moving) {
    const copy = cloneComponent(ref.component);
    copy.updatePropertyWithValue("uid", uid);
    root.addSubcomponent(copy);
    infos.push({ component: copy, oldKey: ref.key, role: o.roles.get(ref.component)!.role, moved: isMoved(ref.component, ref.key, o) });
  }
  const oldMaster = cloneComponent(o.master!);
  const oldLength = lengthOf(o.master!, env);

  // Начало продолжения — встреча B с прежней длительностью, затем патч (время суток на дате B).
  const startProperty = master.getFirstProperty("dtstart")!;
  const endFrame = ownEndFrame(master, env);
  const start = timeInForm(boundaryTime, o.form, seriesZoneOf(startProperty, env), env);
  markProperty(contTouched, master, setTimeProperty(master, "dtstart", start));
  if (oldLength && master.hasProperty("dtend")) writeEnd(master, start, oldLength, env, contTouched, endFrame);
  const place = `у встреч с ${label}`;
  const settled = JSON.stringify(master.jCal);
  const applied = applyRebased(run, master, fields, contTouched, { place, literalLater: recurrence !== undefined });
  // Меняет ли патч хоть что-то (О13): основной продолжения, встречу B или правило.
  let changed = JSON.stringify(master.jCal) !== settled;

  const before = positionsBefore(o, boundary);
  const rule = master.getFirstProperty("rrule");
  const count = rule ? ruleDict(rule).count : undefined;
  if (rule && count !== undefined) setRuleEnd(rule, { count: Number(count) - before }, contTouched);

  const mode = fields.start !== undefined || toggle ? "wall" : "moment";
  let retimed: Retimed;
  try {
    retimed = retime({
      run,
      source: o,
      root,
      master,
      anchorKey: boundary,
      anchorTime: boundaryTime,
      skip: before,
      from: boundary,
      mode,
      overrides: infos,
      lengths: { old: oldLength, new: lengthOf(master, env) },
      touched: contTouched,
    });
  } catch (error) {
    if (error instanceof MappingError) throw splitMismatch(error.message);
    throw error;
  }
  if (mode === "wall" && !toggle && recurrence === undefined) refuseShiftedDates(retimed);

  // О7; встреча самой границы получает патч безусловно.
  const inheritable = requested.filter((field) => INHERITED.has(field));
  for (const info of infos) {
    if (info.role === "hidden") continue;
    if (info.oldKey === boundary) {
      const was = JSON.stringify(info.component.jCal);
      applyRebased(run, info.component, fields, contTouched, { place, literalLater: true, quiet: true });
      if (JSON.stringify(info.component.jCal) !== was) changed = true;
    } else if (inheritable.length > 0) {
      inheritFields(info.component, oldMaster, master, inheritable, contTouched);
    }
  }

  let step: RuleStep | undefined;
  if (recurrence !== undefined) {
    step = prepareRule(run, {
      source: o,
      root,
      master,
      recurrence,
      literal: applied.literal,
      overrides: infos,
      loss: (info) => lossOf(env, instanceAt(o, info.oldKey)!, "у встречи нет пары в новом правиле продолжения"),
      touched: contTouched,
    });
    if (step.changed) changed = true;
  }
  // О13: патч ничего не меняет — ничего не пишется, серия не делится (и писем нет).
  if (!changed) {
    return { kind: "noop", expect: expectation("update", "this_and_following", requested, { target: boundary }), removed: [], notices: run.notices };
  }

  refuseUncuttable(o, boundary, "update");
  refusePeriodBoundary(o, target, oldLength);
  if (applied.literal) refuseEarlierContinuation(master, target);
  if (step) commitRule(run, root, step, contTouched);
  touchMetadata(master, run.now, true, env, contTouched);
  stampTouched(run, infos.map((info) => info.component), contTouched);
  ensureAllTimezones(root, contTouched);
  const continuationText = textOf(root);
  const continuation = reparse(continuationText, env);
  if (target.slot.sources.includes("rrule")) requireSynced(continuation, "первая встреча продолжения");
  if (recurrence === undefined) {
    const tail = sameTail(o, boundary, continuation, retimed.mapper.mapKey);
    if (!tail.same) {
      const where = tail.expected ? ` (ожидалась встреча ${keyLabel(continuation, tail.expected, "time")})` : "";
      throw splitMismatch(`Расписание продолжения не совпадает с хвостом серии: ${tail.reason}${where}.`);
    }
    for (const info of infos) {
      const rid = info.component.getFirstPropertyValue("recurrence-id") as ICAL.Time;
      const role = roleOfKey(continuation, slotKeyOf(rid, continuation.form, env));
      if (role !== info.role) {
        throw splitMismatch(`Встреча с адресом ${keyLabel(o, info.oldKey, "instance")} в продолжении не совпала бы со своим местом в серии.`);
      }
    }
  }

  // Исходный объект: усечение перед границей.
  const work = copyOf(o);
  const touched = newTouched();
  truncate(run, work, boundary, boundaryTime, touched);
  const hidden = hiddenAfterCut(o, copyOf(work), boundary, "update");

  // Подтверждение (О11): все потери разреза — одним отказом с полным перечнем.
  const guests = foreignAttendees([o.master!, ...moving.map((ref) => ref.component)], env);
  const guestMessage = guests.length > 0
    ? `Разрез серии создаст новое событие с участниками ${guests.join(", ")}: Яндекс может разослать им приглашение на новую серию и отмену части прежней.`
    : "";
  const losses = [...(step ? ruleLosses(step) : []), ...hidden.map((entry) => entry.loss)];
  if ((guests.length > 0 || losses.length > 0 || (step !== undefined && ruleNeedsConfirm(step))) && !run.confirmed) {
    throw needConfirm(losses, [guestMessage, step ? ruleConfirmMessage(step) : "", hidden.length > 0 ? HIDDEN_MESSAGE : ""].filter(Boolean).join(" "));
  }
  if (guestMessage) run.notices.push(guestMessage);
  run.notices.push(...hiddenNotice(hidden));
  run.notices.push(...movedPastBoundary(o, boundary, instantOf(boundaryTime, env), "остаются в прежней серии: их адрес раньше границы, изменения к ним не применены"));
  for (const info of infos) {
    if (info.role === "hidden" || !info.moved || info.oldKey === boundary) continue;
    const instance = instanceAt(o, info.oldKey);
    if (instance && instance.startMs < instantOf(boundaryTime, env)) {
      run.notices.push(`Встреча ${instance.instanceStart} перенесена раньше границы, но её адрес не раньше неё: она перешла в продолжение.`);
    }
  }

  const expect = expectation("update", "this_and_following", requested, {
    target: boundary,
    keyMap: (key) => (compareSlotKeys(key, boundary) < 0 ? key : retimed.mapper.mapKey(key)),
    removed: [...(step?.keys ?? []), ...hidden.map((entry) => entry.key)],
    ruleChanged: true,
    datesFixed: recurrence === undefined && retimed.sameDates,
    tail: tailOf(continuation),
    touched,
  });
  return {
    kind: "split",
    continuation: { uid, ics: continuationText },
    truncated: { ics: serializeObject(work) },
    boundary,
    expect,
    removed: losses,
    notices: run.notices,
  };
}

/**
 * Граница — значение RDATE;VALUE=PERIOD со своей длительностью: в
 * продолжении эта встреча становится DTSTART и получила бы длительность
 * основного — её конец изменился бы молча. Отказ, если длительности разные.
 */
function refusePeriodBoundary(o: CalendarObject, target: SlotTarget, oldLength: Length | undefined): void {
  const periodEnd = target.slot.periodEnd;
  if (!periodEnd) return;
  const env = o.env;
  const start = target.slot.time;
  const end = endAfter(start, oldLength ?? { days: start.isDate ? 1 : 0, seconds: 0 }, env);
  if (instantOf(end, env) === instantOf(periodEnd, env)) return;
  throw splitMismatch(
    `Встреча ${target.instance.instanceStart} задана периодом RDATE до ${formatForModel(periodEnd, env, "time")}, а её длительность не как у серии: ` +
      "в продолжении она стала бы началом серии с длительностью серии, и её конец изменился бы.",
  );
}

/**
 * С recurrence дата из start применяется (Р1), но не раньше даты границы:
 * иначе встречи продолжения легли бы на встречи, оставшиеся в прежней серии, —
 * двойники в двух объектах.
 */
function refuseEarlierContinuation(master: ICAL.Component, target: SlotTarget): void {
  const startDate = dateString(master.getFirstPropertyValue("dtstart") as ICAL.Time);
  const boundaryDate = dateString(target.slot.time);
  if (startDate >= boundaryDate) return;
  throw new EditRefusal(
    "invalid-time",
    `Продолжение с ${target.instance.instanceStart} начиналось бы ${startDate}, раньше границы: его встречи легли бы на встречи, которые остаются в прежней серии.`,
    { hint: "Передайте start не раньше даты границы или измените всю серию (scope all_series)." },
  );
}

function splitMismatch(message: string): EditRefusal {
  return new EditRefusal("split-mismatch", message, {
    hint: "Разрез не выполнен, объект не тронут. Измените всю серию (scope all_series) или отдельные встречи (scope this).",
  });
}

/** Адреса участников, кроме владельца календаря (env.ownerEmail), по одному разу. */
function foreignAttendees(components: readonly ICAL.Component[], env: IcalEnv): string[] {
  const owner = addressOf(env.ownerEmail ?? "");
  const found = new Set<string>();
  for (const c of components) {
    for (const property of c.getAllProperties("attendee")) {
      const address = addressOf(property.getFirstValue());
      if (address && address !== owner) found.add(address);
    }
  }
  return [...found];
}

function addressOf(value: unknown): string {
  return String(value ?? "").trim().replace(/^mailto:/i, "").trim().toLowerCase();
}

// TZID параметров компонента и его подкомпонентов — по jCal, без разбора значений.
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

// VTIMEZONE на каждый TZID VEVENT (О12а); пояс, которого нет и в базе, остаётся без описания.
function ensureAllTimezones(root: ICAL.Component, touched: Touched): void {
  const tzids = new Set(root.getAllSubcomponents("vevent").flatMap((c) => [...tzidsIn(c)]));
  for (const tzid of tzids) {
    try {
      for (const added of ensureTimezones(root, [tzid])) {
        const zone = root.getAllSubcomponents("vtimezone").find((sub) => String(sub.getFirstPropertyValue("tzid")) === added);
        if (zone) markComponent(touched, root, zone);
      }
    } catch {
      // описать нечем (например, TZID=Z — синоним UTC у ical.js)
    }
  }
}

// ─────────────────────────────── позиционный сдвиг ───────────────────────────────

/** Сопоставление встреч не удалось: у слота нет пары в сдвинутой серии. */
class MappingError extends Error {}

interface Length {
  days: number;
  seconds: number;
}

interface RetimeInput {
  run: Run;
  /** Исходный объект (не меняется). */
  source: CalendarObject;
  /** Дерево, в котором идёт правка: копия исходного или продолжение. */
  root: ICAL.Component;
  /** Основной компонент в `root` — уже с новым DTSTART. */
  master: ICAL.Component;
  /** Якорь: DTSTART исходной серии или граница разреза. */
  anchorKey: SlotKey;
  anchorTime: ICAL.Time;
  /** Позиций исходного правила до якоря (у разреза — до границы). */
  skip: number;
  /** Разрез: значения раньше границы в продолжение не входят. */
  from?: SlotKey;
  /** wall — стенная разница (start, «весь день»); moment — прежние моменты (только пояс). */
  mode: "wall" | "moment";
  overrides: readonly OverrideInfo[];
  lengths: { old?: Length; new?: Length };
  touched: Touched;
}

interface Retimed {
  mapper: SlotMapper;
  /** Новые ключи EXDATE, которые не указывали ни на одну встречу. */
  orphans: SlotKey[];
  /** Старый ключ RDATE → новый. */
  rdates: Map<SlotKey, SlotKey>;
  untilChanged: boolean;
  /** Даты сопоставленных встреч прежние (до горизонта сверки, shiftedDate). */
  sameDates: boolean;
  /** Первая встреча, перешедшая на другую дату, — «адрес → новое начало». */
  shiftedAt?: string;
}

/**
 * Позиционный сдвиг серии (Р1, Р9): основной в `root` уже получил новое
 * начало; значения серии переводятся за своими встречами:
 * - RDATE — на стенную разницу якоря (moment — те же моменты), в форме
 *   нового DTSTART (О4);
 * - EXDATE на встрече — на новую встречу той же позиции; EXDATE мимо встреч —
 *   тем же сдвигом, что RDATE;
 * - UNTIL — время новой встречи на месте последней встречи под прежним UNTIL
 *   (`lastSlotUpTo`, без горизонта; дальше предела — until-too-far);
 * - RECURRENCE-ID: slot — новая встреча той же позиции; hidden — так же или
 *   сдвигом; detached — сдвигом. Неперенесённые (начало = RID, в том числе
 *   скрытые) идут за новым временем, их длительность — за длительностью
 *   основного, если совпадала с прежней; перенесённые остаются на своём
 *   времени (О7).
 */
function retime(input: RetimeInput): Retimed {
  const { run, source, root, master, touched } = input;
  const env = run.env;
  const startProperty = master.getFirstProperty("dtstart")!;
  const newStart = (startProperty.getFirstValue() as ICAL.Time).clone();
  const newForm = formOf(startProperty);
  const newZone = seriesZoneOf(startProperty, env);
  const shift = makeShift(input.mode, source, input.anchorTime, newForm, newZone, newStart, env);
  const mapper = new SlotMapper(
    env,
    input.anchorKey,
    newStart,
    newForm,
    new Positions(endless(source.root, source.master!, env)),
    new Positions(endless(root, master, env)),
    input.skip,
    shift,
  );
  const from = input.from;
  const outside = (key: SlotKey) => from !== undefined && compareSlotKeys(key, from) < 0;

  // RDATE: значение границы в продолжении — его DTSTART.
  const rdates = new Map<SlotKey, SlotKey>();
  for (const property of master.getAllProperties("rdate")) {
    const next: Array<ICAL.Time | ICAL.Period> = [];
    for (const value of property.getValues() as Array<ICAL.Time | ICAL.Period>) {
      const start = value instanceof ICAL.Period ? value.start : value;
      const key = slotKeyOf(start, source.form, env);
      if (outside(key) || key === from) continue;
      const moved = shiftValue(value, shift);
      const movedStart = moved instanceof ICAL.Period ? moved.start : moved;
      mapper.addRdate(key, movedStart);
      rdates.set(key, slotKeyOf(movedStart, newForm, env));
      next.push(moved);
    }
    replaceListValues(master, property, next, touched);
  }

  // EXDATE.
  const orphans: SlotKey[] = [];
  for (const property of master.getAllProperties("exdate")) {
    const next: ICAL.Time[] = [];
    for (const value of property.getValues() as ICAL.Time[]) {
      const key = slotKeyOf(value, source.form, env);
      if (outside(key)) continue;
      const mapped = mapper.slotTime(key);
      if (mapped) {
        next.push(mapped.clone());
      } else {
        const moved = shiftTime(value, shift);
        orphans.push(slotKeyOf(moved, newForm, env));
        next.push(moved);
      }
    }
    replaceListValues(master, property, next, touched);
  }

  // UNTIL (Р1): последняя встреча под прежним UNTIL — на новое время.
  let untilChanged = false;
  const rule = master.getFirstProperty("rrule");
  const sourceUntil = (source.master!.getFirstPropertyValue("rrule") as ICAL.Recur | null)?.until;
  if (rule && sourceUntil && ruleDict(rule).until !== undefined && !shift.identity) {
    const last = lastSlotUpTo(source, sourceUntil);
    if (last.kind === "too-far") {
      throw new EditRefusal("until-too-far", `Последняя встреча серии под UNTIL дальше ${SERIES_CAP} встреч от начала: пересчитать конец серии нельзя.`, {
        hint: "Задайте новый конец явно: recurrence.until или count вместе с новым временем.",
      });
    }
    const mapped = last.kind === "slot" ? mapper.slotTime(last.slot.key) : undefined;
    untilChanged = setRuleEnd(rule, { until: untilValue(mapped ?? shiftTime(sourceUntil, shift), newForm) }, touched);
  }

  // RECURRENCE-ID и время переопределений (О7).
  for (const info of input.overrides) {
    const c = info.component;
    const ridProperty = c.getFirstProperty("recurrence-id")!;
    // Кадры читаются до правки адреса и начала: они сверяются с прежним
    // RECURRENCE-ID (в прежней форме и поясе серии), а после записи нового
    // адреса такой сверки уже не сделать.
    const startFrame = ownStartFrame(c, env);
    const endFrame = ownEndFrame(c, env);
    const mapped = mapper.slotTime(info.oldKey);
    let rid: ICAL.Time;
    if (info.role === "slot") {
      if (!mapped) throw new MappingError(`У встречи ${formatForModel(ridProperty.getFirstValue() as ICAL.Time, env, "instance")} нет пары в сдвинутой серии.`);
      rid = mapped.clone();
    } else if (info.role === "hidden" && mapped) {
      rid = mapped.clone();
    } else {
      rid = shiftTime(ridProperty.getFirstValue() as ICAL.Time, shift);
    }
    if (!sameTimeValue(ridProperty, rid)) markProperty(touched, c, setTimeProperty(c, "recurrence-id", rid));
    if (info.moved) continue;
    const own = lengthOf(c, env);
    const length = sameLength(own, input.lengths.old) && input.lengths.new ? input.lengths.new : own;
    // Момент неперенесённого начала равен адресу, но записывается он в своём
    // кадре: пояс, выбранный для этой встречи, за поясом серии не идёт.
    const start = startFrame && !rid.isDate ? timeInForm(rid, startFrame.form, startFrame.zone, env) : rid;
    const startProp = c.getFirstProperty("dtstart")!;
    if (!sameTimeValue(startProp, start)) markProperty(touched, c, setTimeProperty(c, "dtstart", start));
    if (length) writeEnd(c, start, length, env, touched, endFrame);
  }

  const shiftedAt = shiftedDate(source, from ?? input.anchorKey, from !== undefined, mapper, run.now);
  return { mapper, orphans, rdates, untilChanged, sameDates: shiftedAt === undefined, shiftedAt };
}

/** Предел сверки дат при сдвиге: слотов исходной серии. */
const DATE_CHECK_STEPS = 100_000;

/**
 * Первая встреча, которую позиционный сдвиг переносит на другую дату, —
 * строкой «адрес → новое начало»; undefined — даты прежние (Р1, datesFixed).
 * Сверяются все слоты исходной серии (с закрытыми EXDATE) от `from` до
 * горизонта, как у перечня удаляемых встреч: 800 дней после max(граница,
 * сейчас, последний явный ключ). Даты теряются не только у DTSTART: у HOURLY
 * и BYHOUR новое время суток переводит часть позиций через полночь, при смене
 * пояса — позиции после перехода часов.
 */
function shiftedDate(source: CalendarObject, from: SlotKey, cut: boolean, mapper: SlotMapper, now: Date | number): string | undefined {
  const env = source.env;
  const until = horizonKey(source, from, now);
  let steps = 0;
  for (const slot of iterateSlots(source)) {
    if (++steps > DATE_CHECK_STEPS) return undefined;
    if (cut && compareSlotKeys(slot.key, from) < 0) continue;
    if (compareSlotKeys(slot.key, until) > 0) return undefined;
    const mapped = mapper.slotTime(slot.key);
    if (mapped && dateString(mapped) !== dateString(slot.time)) {
      return `${formatForModel(slot.time, env, "instance")} → ${formatForModel(mapped, env, "time")}`;
    }
  }
  return undefined;
}

/** UNTIL в форме DTSTART (О4): дата — датой, прочее — как есть (setRuleDict переводит время с поясом в UTC). */
function untilValue(t: ICAL.Time, form: TimeForm): ICAL.Time {
  if (form === "date" && !t.isDate) return ICAL.Time.fromData({ year: t.year, month: t.month, day: t.day, isDate: true });
  return t;
}

/**
 * Копия серии для перебора позиций: VTIMEZONE и основной компонент без
 * EXDATE, RDATE, EXRULE и конца правила. Номера позиций у такой серии те же
 * (EXDATE их не сдвигает, recur_iterator.js не знает EXDATE), но она
 * продолжается за прежний конец — это нужно, когда сдвиг выводит последнюю
 * встречу за прежний UNTIL (C58).
 */
function endless(root: ICAL.Component, master: ICAL.Component, env: IcalEnv): CalendarObject {
  const cal = new ICAL.Component(["vcalendar", ICAL.helpers.clone(root.jCal[1], true), []]);
  for (const zone of root.getAllSubcomponents("vtimezone")) cal.addSubcomponent(new ICAL.Component(ICAL.helpers.clone(zone.jCal, true)));
  const copy = cloneComponent(master);
  for (const name of ["exdate", "rdate", "exrule"]) copy.removeAllProperties(name);
  for (const property of copy.getAllProperties("rrule")) {
    const dict = { ...ruleDict(property) };
    delete dict.count;
    delete dict.until;
    setRuleDict(property, dict);
  }
  cal.addSubcomponent(copy);
  return reparse(textOf(cal), env);
}

/** Позиции первого RRULE серии по порядку, лениво, с пределом SERIES_CAP. */
class Positions {
  private readonly slots: Generator<Slot>;
  private readonly byKey = new Map<SlotKey, number>();
  private readonly byNumber = new Map<number, Slot>();
  private last: SlotKey | undefined;
  private top = 0;
  private done = false;
  private seen = 0;

  constructor(o: CalendarObject) {
    this.slots = iterateSlots(o);
  }

  private pull(): boolean {
    for (;;) {
      if (this.done) return false;
      const next = this.slots.next();
      if (next.done) {
        this.done = true;
        return false;
      }
      if (++this.seen > SERIES_CAP) throw new SlotScanError("too-long", `Серия длиннее ${SERIES_CAP} встреч: сопоставить её встречи нельзя.`);
      const slot = next.value;
      this.last = slot.key;
      if (slot.position === undefined) continue;
      this.byKey.set(slot.key, slot.position);
      this.byNumber.set(slot.position, slot);
      this.top = Math.max(this.top, slot.position);
      return true;
    }
  }

  numberOf(key: SlotKey): number | undefined {
    while (!this.done && (this.last === undefined || compareSlotKeys(this.last, key) < 0)) this.pull();
    return this.byKey.get(key);
  }

  at(position: number): Slot | undefined {
    while (!this.done && this.top < position) this.pull();
    return this.byNumber.get(position);
  }
}

/** Сопоставление встреч исходной серии со сдвинутой: якорь, позиции, RDATE. */
class SlotMapper {
  private readonly rdateTimes = new Map<SlotKey, ICAL.Time>();

  constructor(
    private readonly env: IcalEnv,
    private readonly anchorKey: SlotKey,
    private readonly anchor: ICAL.Time,
    private readonly form: TimeForm,
    private readonly before: Positions,
    private readonly after: Positions,
    private readonly skip: number,
    private readonly shift: Shift,
  ) {}

  addRdate(key: SlotKey, time: ICAL.Time): void {
    this.rdateTimes.set(key, time);
  }

  /** Новое время встречи исходной серии с ключом `key`; не встреча (или раньше якоря) — undefined. */
  slotTime(key: SlotKey): ICAL.Time | undefined {
    if (key === this.anchorKey) return this.anchor;
    const number = this.before.numberOf(key);
    if (number !== undefined) {
      if (number <= this.skip) return undefined;
      const slot = this.after.at(number - this.skip);
      if (!slot) throw new MappingError(`У позиции ${number} правила нет пары в сдвинутой серии.`);
      return slot.time;
    }
    return this.rdateTimes.get(key);
  }

  /** Ключ после записи — Expectation.keyMap; значения мимо встреч — тем же сдвигом. */
  readonly mapKey = (key: SlotKey): SlotKey => {
    const time = this.slotTime(key) ?? shiftTime(timeOfKey(key), this.shift);
    return slotKeyOf(time, this.form, this.env);
  };
}

/** Перевод значения серии за сдвигом якоря. */
interface Shift {
  mode: "wall" | "moment";
  /** Значения не меняются: та же форма, тот же пояс, без сдвига. */
  identity: boolean;
  oldForm: TimeForm;
  oldZone?: ZoneRef;
  newForm: TimeForm;
  newZone?: ZoneRef;
  /** Стенная разница якорей, секунды (wall). */
  seconds: number;
  /** Разница дат якорей, дни (переход на «весь день»). */
  days: number;
  env: IcalEnv;
}

function makeShift(
  mode: "wall" | "moment",
  source: CalendarObject,
  anchorOld: ICAL.Time,
  newForm: TimeForm,
  newZone: ZoneRef | undefined,
  anchorNew: ICAL.Time,
  env: IcalEnv,
): Shift {
  const oldWall = timeInForm(anchorOld, source.form, source.zone, env);
  const seconds = wallSeconds(anchorNew) - wallSeconds(oldWall);
  const days = dayNumber(anchorNew) - dayNumber(oldWall);
  const sameFrame = newForm === source.form && zoneName(newZone) === zoneName(source.zone);
  return {
    mode,
    identity: sameFrame && (mode === "moment" || seconds === 0),
    oldForm: source.form,
    oldZone: source.zone,
    newForm,
    newZone,
    seconds,
    days,
    env,
  };
}

function zoneName(zone: ZoneRef | undefined): string | undefined {
  if (zone === undefined) return undefined;
  return typeof zone === "string" ? zone : zone.tzid;
}

/**
 * Значение серии после сдвига: moment — тот же момент в новой форме
 * (values.ts, timeInForm); wall — стенное время в прежней форме плюс
 * разница якорей, прочитанное в новой форме; у дат — та же дата плюс разница
 * дат.
 */
function shiftTime(t: ICAL.Time, s: Shift): ICAL.Time {
  if (s.mode === "moment") return timeInForm(t, s.newForm, s.newZone, s.env);
  const old = timeInForm(t, s.oldForm, s.oldZone, s.env);
  if (s.newForm === "date") {
    const date = ICAL.Time.fromData({ year: old.year, month: old.month, day: old.day, isDate: true });
    date.adjust(s.days, 0, 0, 0); // time.js, adjust: календарная арифметика
    return date;
  }
  const wall = ICAL.Time.fromData(
    {
      year: old.year,
      month: old.month,
      day: old.day,
      hour: old.isDate ? 0 : old.hour,
      minute: old.isDate ? 0 : old.minute,
      second: old.isDate ? 0 : old.second,
      isDate: false,
    },
    ICAL.Timezone.utcTimezone,
  );
  wall.adjust(0, 0, 0, s.seconds);
  const data = { year: wall.year, month: wall.month, day: wall.day, hour: wall.hour, minute: wall.minute, second: wall.second, isDate: false };
  switch (s.newForm) {
    case "utc":
      return ICAL.Time.fromData(data, ICAL.Timezone.utcTimezone);
    case "floating":
      return ICAL.Time.fromData(data, ICAL.Timezone.localTimezone);
    case "zoned":
      if (s.newZone === undefined) throw new Error("Для формы zoned нужен пояс.");
      // Синоним UTC (TZID=UTC) — именем: стенное время в нём равно UTC (values.ts, zonedTarget).
      if (typeof s.newZone === "string") return timeInForm(ICAL.Time.fromData(data, ICAL.Timezone.utcTimezone), "zoned", s.newZone, s.env);
      return ICAL.Time.fromData(data, s.newZone);
  }
}

function shiftValue(value: ICAL.Time | ICAL.Period, s: Shift): ICAL.Time | ICAL.Period {
  if (!(value instanceof ICAL.Period)) return shiftTime(value, s);
  const start = shiftTime(value.start, s);
  if (value.duration) return ICAL.Period.fromData({ start, end: null as unknown as ICAL.Time, duration: value.duration.clone() });
  const seconds = (instantOf(value.end!, s.env) - instantOf(value.start, s.env)) / 1000;
  return ICAL.Period.fromData({ start, end: atMoment(instantOf(start, s.env) / 1000 + seconds, start, s.env), duration: null as unknown as ICAL.Duration });
}

/** Переписывает значения свойства-списка (VALUE и TZID — по первому значению); пустой список снимает свойство. */
function replaceListValues(c: ICAL.Component, property: ICAL.Property, values: ReadonlyArray<ICAL.Time | ICAL.Period>, touched: Touched): void {
  if (values.length === 0) {
    c.removeProperty(property);
    markProperty(touched, c, property);
    return;
  }
  const before = JSON.stringify(property.jCal);
  // property.js, setValues: resetType по icaltype первого значения, кеш значений — копии.
  property.removeParameter("tzid");
  property.setValues(values.map((value) => value.clone()));
  const first = values[0] instanceof ICAL.Period ? values[0].start : values[0];
  if (formOf(first) === "zoned") property.setParameter("tzid", first.zone.tzid);
  if (JSON.stringify(property.jCal) !== before) markProperty(touched, c, property);
}

// ─────────────────────────────── время ───────────────────────────────

/** Длительность компонента: номинальные сутки и точные секунды (как instances.ts); без конца — undefined. */
function lengthOf(c: ICAL.Component, env: IcalEnv): Length | undefined {
  const start = c.getFirstPropertyValue("dtstart") as ICAL.Time;
  const dtend = c.getFirstPropertyValue("dtend");
  if (dtend instanceof ICAL.Time) {
    if (start.isDate && dtend.isDate) return { days: dayNumber(dtend) - dayNumber(start), seconds: 0 };
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
  return undefined;
}

function sameLength(a: Length | undefined, b: Length | undefined): boolean {
  if (!a || !b) return a === b;
  return a.days * 86_400 + a.seconds === b.days * 86_400 + b.seconds;
}

// Конец по началу и длительности: сутки — стенным сдвигом (time.js, adjust), секунды — точно, через момент.
function endAfter(start: ICAL.Time, length: Length, env: IcalEnv): ICAL.Time {
  const end = start.clone();
  if (length.days) end.adjust(length.days, 0, 0, 0);
  if (!length.seconds) return end;
  if (end.isDate) {
    const days = Math.trunc(length.seconds / 86_400);
    if (days) end.adjust(days, 0, 0, 0);
    return end;
  }
  return atMoment(instantOf(end, env) / 1000 + length.seconds, end, env);
}

// Момент `seconds` в форме и поясе значения `like` (values.ts, timeInForm).
function atMoment(seconds: number, like: ICAL.Time, env: IcalEnv): ICAL.Time {
  const form = formOf(like);
  return timeInForm(utcAt(seconds), form, form === "zoned" ? like.zone : undefined, env);
}

/**
 * Конец компонента после нового начала: DTEND — в форме и поясе начала или,
 * если до правки он был в своих (`endFrame`, рейс с DTEND в поясе прилёта), —
 * в них; DURATION — длительностью; без конца — ничего.
 */
function writeEnd(c: ICAL.Component, start: ICAL.Time, length: Length, env: IcalEnv, touched: Touched, endFrame?: Frame): void {
  const dtend = c.getFirstProperty("dtend");
  if (dtend) {
    let end = endAfter(start, length, env);
    if (endFrame && !end.isDate) end = timeInForm(end, endFrame.form, endFrame.zone, env);
    if (!sameTimeValue(dtend, end)) markProperty(touched, c, setTimeProperty(c, "dtend", end));
    return;
  }
  const duration = c.getFirstProperty("duration");
  if (!duration) return;
  const current = duration.getFirstValue() as ICAL.Duration;
  const value = length.seconds === 0 ? ICAL.Duration.fromData({ days: length.days }) : ICAL.Duration.fromSeconds(length.days * 86_400 + length.seconds);
  if (current.toSeconds() !== value.toSeconds()) {
    duration.setValue(value);
    markProperty(touched, c, duration);
  }
}

/**
 * Форма и пояс DTSTART переопределения, если они не как у его RECURRENCE-ID
 * (читать до правки адреса): такое начало сохраняет свой пояс — его выбрал
 * тот, кто эту встречу переносил или писал (в том числе наш же update this с
 * timeZone), и к поясу серии оно отношения не имеет. Начало в форме адреса
 * идёт за новой формой и поясом серии, как раньше шло всё.
 */
function ownStartFrame(c: ICAL.Component, env: IcalEnv): Frame | undefined {
  const dtstart = c.getFirstProperty("dtstart");
  const rid = c.getFirstProperty("recurrence-id");
  if (!dtstart || !rid) return undefined;
  const startForm = formOf(dtstart);
  const ridForm = formOf(rid);
  if (startForm === "date" || ridForm === "date") return undefined;
  if (startForm === ridForm && (startForm !== "zoned" || String(dtstart.getParameter("tzid")) === String(rid.getParameter("tzid")))) return undefined;
  return { form: startForm, zone: startForm === "zoned" ? seriesZoneOf(dtstart, env) : undefined };
}

/**
 * Форма и пояс DTEND, если они не как у DTSTART (читать до правки начала):
 * такой конец сохраняет свой пояс. Конец в форме начала идёт за новым
 * началом — и за сменой пояса серии.
 */
function ownEndFrame(c: ICAL.Component, env: IcalEnv): Frame | undefined {
  const dtend = c.getFirstProperty("dtend");
  const dtstart = c.getFirstProperty("dtstart");
  if (!dtend || !dtstart) return undefined;
  const endForm = formOf(dtend);
  const startForm = formOf(dtstart);
  if (endForm === "date" || startForm === "date") return undefined;
  if (endForm === startForm && (endForm !== "zoned" || String(dtend.getParameter("tzid")) === String(dtstart.getParameter("tzid")))) return undefined;
  return { form: endForm, zone: endForm === "zoned" ? seriesZoneOf(dtend, env) : undefined };
}

// Значение свойства совпадает с `time` в записи: форма, jCal-строка и TZID.
function sameTimeValue(property: ICAL.Property, time: ICAL.Time): boolean {
  let raw: unknown = property.jCal[3];
  if (Array.isArray(raw)) raw = raw[0];
  const form = formOf(property);
  if (form !== formOf(time) || String(raw) !== time.toString()) return false;
  return form !== "zoned" || String(property.getParameter("tzid")) === time.zone.tzid;
}

function sameTimeProperty(a: ICAL.Property, b: ICAL.Property): boolean {
  let left: unknown = a.jCal[3];
  let right: unknown = b.jCal[3];
  if (Array.isArray(left)) left = left[0];
  if (Array.isArray(right)) right = right[0];
  return formOf(a) === formOf(b) && String(left) === String(right) && String(a.getParameter("tzid") ?? "") === String(b.getParameter("tzid") ?? "");
}

// Стенное время как секунды (поля, прочитанные как UTC; у даты — полночь).
function wallSeconds(t: ICAL.Time): number {
  return ICAL.Time.fromData(
    {
      year: t.year,
      month: t.month,
      day: t.day,
      hour: t.isDate ? 0 : t.hour,
      minute: t.isDate ? 0 : t.minute,
      second: t.isDate ? 0 : t.second,
      isDate: false,
    },
    ICAL.Timezone.utcTimezone,
  ).toUnixTime();
}

// Номер дня по календарной дате, без пояса процесса (time.js, toUnixTime через Date.UTC).
function dayNumber(t: ICAL.Time): number {
  return Math.round(ICAL.Time.fromData({ year: t.year, month: t.month, day: t.day, hour: 0, minute: 0, second: 0, isDate: false },
    ICAL.Timezone.utcTimezone).toUnixTime() / 86_400);
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

function dateString(t: ICAL.Time): string {
  return `${pad(t.year, 4)}-${pad(t.month)}-${pad(t.day)}`;
}

function addDaysTo(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const t = ICAL.Time.fromData({ year, month, day, isDate: true });
  t.adjust(days, 0, 0, 0);
  return dateString(t);
}

function daysBetween(from: string, to: string): number {
  const [y1, m1, d1] = from.split("-").map(Number);
  const [y2, m2, d2] = to.split("-").map(Number);
  return dayNumber(ICAL.Time.fromData({ year: y2, month: m2, day: d2, isDate: true })) - dayNumber(ICAL.Time.fromData({ year: y1, month: m1, day: d1, isDate: true }));
}

// ─────────────────────────────── время суток на дате (Р1) ───────────────────────────────

/** Форма и пояс, в которых читаются start и end патча. */
interface Frame {
  form: TimeForm;
  zone?: ZoneRef;
}

/** Стенное время от модели в форме патча. */
interface Wall {
  date: string;
  hour: number;
  minute: number;
  second: number;
}

interface Rebased {
  /** start и end патча как есть — если их дата не совпала с якорем и её применит правка правила. */
  literal?: FieldPatch;
}

/**
 * Применяет поля к компоненту так, что из start и end берутся только время
 * суток, длительность и пояс, а дата — прежняя дата начала компонента (Р1):
 * start с другой датой пишется на дату якоря (с пояснением или, если дата
 * применится вместе с правилом, — в `literal`); end — с той же разницей дат,
 * что у end и start в патче; end без start — ближайшее такое время суток
 * после начала. Остальное — как applyFieldPatch (patch.ts).
 */
function applyRebased(
  run: Run,
  c: ICAL.Component,
  fields: FieldPatch,
  touched: Touched,
  options: { place: string; literalLater: boolean; quiet?: boolean; shownDate?: string },
): Rebased {
  const ctx = patchContext(run, touched);
  if (fields.start === undefined && fields.end === undefined) {
    applyFieldPatch(c, fields, ctx);
    return {};
  }
  const frame = targetFrame(run, c, fields);
  const anchor = anchorDate(run, c, frame);
  const result: Rebased = {};

  if (fields.start !== undefined) {
    const start = wallIn(run, fields.start, frame, "start");
    const end = fields.end === undefined ? undefined : wallIn(run, fields.end, frame, "end");
    const rebased: FieldPatch = { ...fields };
    if (start) {
      rebased.start = compose(anchor, start, frame);
      if (end) rebased.end = compose(addDaysTo(anchor, daysBetween(start.date, end.date)), end, frame);
      // Дата, которую видит пользователь: у t&f без встреч до границы (Р2) — дата границы, а не
      // DTSTART серии (ранние встречи могут быть удалены EXDATE).
      const shown = frame.form === "date" ? anchor : options.shownDate ?? anchor;
      if (start.date !== shown) {
        if (options.literalLater) {
          result.literal = { start: fields.start, ...(fields.end !== undefined ? { end: fields.end } : {}) };
        } else if (!options.quiet) {
          run.notices.push(dateIgnored("start", start.date, shown, options.place));
        }
      }
    }
    applyFieldPatch(c, rebased, ctx);
    return result;
  }

  // end без start: сначала прочие поля (пояс, «весь день»), затем конец.
  const { end: endIso, ...rest } = fields;
  applyFieldPatch(c, rest, ctx);
  const end = wallIn(run, endIso!, frame, "end");
  if (!end) {
    applyFieldPatch(c, { end: endIso }, ctx);
    return result;
  }
  if (frame.form === "date") {
    throw new EditRefusal("invalid-time", `end без start ${options.place} не определяет длительность событий на весь день.`, {
      hint: "Передайте start и end вместе, например 2026-10-19 и 2026-10-21.",
    });
  }
  const current = c.getFirstPropertyValue("dtstart") as ICAL.Time;
  const startWall = { hour: current.hour, minute: current.minute, second: current.second };
  const seconds = (w: { hour: number; minute: number; second: number }) => w.hour * 3600 + w.minute * 60 + w.second;
  const nextDay = seconds(end) <= seconds(startWall);
  const date = nextDay ? addDaysTo(dateString(current), 1) : dateString(current);
  const shown = options.shownDate === undefined ? date : nextDay ? addDaysTo(options.shownDate, 1) : options.shownDate;
  if (end.date !== shown && !options.quiet) run.notices.push(dateIgnored("end", end.date, shown, options.place));
  applyFieldPatch(c, { end: compose(date, end, frame) }, ctx);
  return result;
}

function dateIgnored(field: string, date: string, anchor: string, place: string): string {
  return (
    `Дата ${date} из ${field} не применена: ${place} меняется только время суток и длительность, дата прежняя — ${anchor}. ` +
    "Чтобы перенести встречи на другие даты, передайте вместе со start правило повтора (recurrence)."
  );
}

function compose(date: string, wall: Wall, frame: Frame): string {
  if (frame.form === "date") return date;
  return `${date}T${pad(wall.hour)}:${pad(wall.minute)}:${pad(wall.second)}`;
}

// Форма, в которой patch.ts прочтёт start и end (patch.ts, resolveTimes: целевая форма).
function targetFrame(run: Run, c: ICAL.Component, fields: FieldPatch): Frame {
  const property = c.getFirstProperty("dtstart")!;
  const form = formOf(property);
  const allDay = fields.allDay ?? form === "date";
  if (allDay) return { form: "date" };
  if (fields.timeZone !== undefined && !(form === "zoned" && String(property.getParameter("tzid")) === fields.timeZone)) {
    return frameForZone(fields.timeZone, c);
  }
  if (form === "date") return frameForZone(run.defaultTimeZone ?? run.env.floatingZone, c);
  return { form, zone: seriesZoneOf(property, run.env) };
}

// Пояс по имени: синонимы UTC — форма utc (timezone_service.js, reset); из
// дерева объекта (Ж10); иначе база IANA.
function frameForZone(tzid: string, c: ICAL.Component): Frame {
  const refuse = () =>
    new EditRefusal("unknown-timezone", `Неизвестный часовой пояс ${JSON.stringify(tzid)}: нужен пояс IANA, например Europe/Moscow.`);
  if (typeof tzid !== "string" || !tzid.trim()) throw refuse();
  if (ICAL.TimezoneService.get(tzid) === ICAL.Timezone.utcTimezone) return { form: "utc" };
  let root = c;
  while (root.parent) root = root.parent;
  const own = root.getAllSubcomponents("vtimezone").find((zone) => String(zone.getFirstPropertyValue("tzid")) === tzid);
  if (own) return { form: "zoned", zone: new ICAL.Timezone({ component: own, tzid }) };
  try {
    registerTimeZone(tzid);
  } catch {
    throw refuse();
  }
  return { form: "zoned", zone: tzid };
}

// Дата якоря: у даты — она; у времени — записанная стенная дата (у UTC при
// переходе на «весь день» — дата в поясе календаря, как patch.ts, dateOfTimed).
function anchorDate(run: Run, c: ICAL.Component, frame: Frame): string {
  const t = c.getFirstPropertyValue("dtstart") as ICAL.Time;
  if (t.isDate) return dateString(t);
  if (frame.form === "date" && formOf(t) === "utc") return wallDateOf(t, run.env, run.env.floatingZone);
  return dateString(t);
}

/** Стенное время строки в форме `frame`; строка другой формы — undefined (её отвергнет patch.ts). */
function wallIn(run: Run, iso: string, frame: Frame, field: string): Wall | undefined {
  if (typeof iso !== "string") return undefined;
  const zone = frame.form === "zoned" ? frame.zone : frame.form === "utc" ? ICAL.Timezone.utcTimezone : undefined;
  let parsed: ModelTime;
  try {
    parsed = parseModelTime(iso, zone);
  } catch (error) {
    if (error instanceof ModelTimeError) throw new EditRefusal("invalid-time", `${field}: ${error.message}`);
    throw error;
  }
  if (frame.form === "date") {
    const { hour, minute, second } = parsed.wall;
    if (parsed.kind === "date" || (hour === 0 && minute === 0 && second === 0)) return { date: parsed.date, hour: 0, minute: 0, second: 0 };
    return undefined;
  }
  if (parsed.kind === "date") return undefined;
  if (parsed.kind === "wall") return { date: parsed.date, hour: parsed.wall.hour, minute: parsed.wall.minute, second: parsed.wall.second };
  const t = timeInForm(parsed.time, frame.form, frame.zone, run.env);
  return { date: dateString(t), hour: t.hour, minute: t.minute, second: t.second };
}
