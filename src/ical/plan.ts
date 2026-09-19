import type ICAL from "ical.js";
import type { Attendee, EditScope, Recurrence, RecurrenceFrequency, Reminder } from "../types.js";
import type { AnomalyCode, EditOp } from "./object.js";
import type { SlotKey } from "./values.js";

/**
 * Язык правки и планы записи (§2 плана переделки,
 * docs/superpowers/plans/2026-09-19-recurring-events-rework.md).
 *
 * `EventPatch` — только язык патча: из него объект не пересобирается никогда.
 * Правка ложится на дерево ical.js прочитанного объекта и трогает лишь
 * свойства названных полей (patch.ts); планировщик (edit.ts) решает, к каким
 * компонентам её применить, а предохранитель (guard.ts) сверяет результат с
 * ожиданием `Expectation`.
 */

// ─────────────────────────────── патч ───────────────────────────────

/**
 * Правка повтора (Р4). Меняются только переданные части правила, прочие — в
 * том числе части, которых модель не знает, — остаются дословно:
 * - `null` снимает часть (INTERVAL, BYDAY, COUNT, UNTIL); пустой `byWeekday`
 *   тоже снимает BYDAY;
 * - `count` и `until` взаимоисключающие: одно заменяет другое на том же
 *   месте правила, оба сразу — отказ;
 * - умолчаний нет: не переданное не меняется;
 * - `replace: true` собирает правило только из патча (частота без патча —
 *   прежняя); потерянные части планировщик требует подтвердить confirm.
 * BYSETPOS и WKST при правке не вводятся: Яндекс их искажает (Ж6,
 * docs/yandex-caldav-capabilities.md).
 */
export interface RecurrencePatch {
  frequency?: RecurrenceFrequency;
  interval?: number | null;
  byWeekday?: NonNullable<Recurrence["byWeekday"]> | null;
  /**
   * Последняя встреча включительно, как в сборке нового события (build.ts):
   * у серии на весь день — дата; у серии со временем дата — весь этот день в
   * поясе события, ISO без смещения — стенное время пояса события, со
   * смещением — момент.
   */
  until?: string | null;
  count?: number | null;
  replace?: boolean;
}

/** Участник в патче: без `status` PARTSTAT имеющегося участника не трогается, новый получает NEEDS-ACTION (О9). */
export interface AttendeePatch {
  email: string;
  status?: Attendee["status"];
}

/**
 * Правка полей одного компонента (О5, О8, О9). Не переданное поле не
 * меняется.
 * - `summary` — не пустой; `description` и `location` пустой строкой
 *   снимаются;
 * - `start`, `end` — ISO со смещением (момент), без смещения (стенное время
 *   пояса события) или дата у события на весь день; `start` без `end`
 *   сохраняет длительность; `timeZone` без `start` сохраняет моменты;
 * - `reminders` — полный список напоминаний DISPLAY и EMAIL со сдвигом от
 *   начала; прочие VALARM (AUDIO, от конца, абсолютные) не трогаются;
 * - `attendees` — полный список участников по адресу.
 */
export interface FieldPatch {
  summary?: string;
  description?: string;
  location?: string;
  start?: string;
  end?: string;
  timeZone?: string;
  allDay?: boolean;
  reminders?: readonly Reminder[];
  attendees?: readonly AttendeePatch[];
}

/** Патч update_event: поля и повтор. Повтор правит только planUpdate через patchRule. */
export interface EventPatch extends FieldPatch {
  recurrence?: RecurrencePatch;
}

export type PatchField = keyof EventPatch;

/** Поля патча в порядке, в котором их перечисляют результаты правки. */
export const PATCH_FIELDS: readonly PatchField[] = [
  "summary",
  "description",
  "location",
  "start",
  "end",
  "timeZone",
  "allDay",
  "attendees",
  "reminders",
  "recurrence",
];

// ─────────────────────────────── потери и отказы ───────────────────────────────

/**
 * Встреча, которую план убирает или теряет сверх названной цели (О11): для
 * отказа с needsConfirm и для ответа delete_event. `instanceStart` — адрес по
 * Р10, `start` — фактическое начало, `reason` — по-русски.
 */
export interface Loss {
  instanceStart: string;
  start: string;
  summary: string;
  reason: string;
}

/**
 * Код отказа правки. Коды этой задачи (patch.ts):
 * - `invalid-field` — пустой summary, неверный участник или напоминание,
 *   неизвестное поле патча;
 * - `invalid-time` — время не разобрано, не той формы (дата вместо времени и
 *   наоборот), из разрыва перевода часов, конец не позже начала, смена
 *   «весь день» без нужных start и end;
 * - `unknown-timezone` — пояса нет в базе IANA;
 * - `invalid-rule` — правило после правки нарушает RFC 5545 или модель;
 * - `unsupported-rule` — часть правила вне модели в патче, BYSETPOS и WKST
 *   (Ж6).
 * Прочие — коды планировщиков из плана (О12д, Р1, Р9, Р4) и блокирующие
 * аномалии объекта (О14); планировщик может расширить перечень.
 */
export type RefusalCode =
  | "invalid-field"
  | "invalid-time"
  | "unknown-timezone"
  | "invalid-rule"
  | "unsupported-rule"
  | "unparsable"
  | "series-too-long"
  | "unsynced-rule"
  | "until-too-far"
  | "split-mismatch"
  | "split-already-done"
  | "split-stale-continuation"
  | "confirm-required"
  | AnomalyCode;

/**
 * Отказ правки или удаления: запись не выполняется. `needsConfirm` — отказ
 * снимается повтором с confirm и etag прочитанного состояния (О11), тогда
 * `losses` перечисляет, что будет потеряно. Сообщение — по-русски, для
 * пользователя; `hint` — что сделать иначе.
 */
export class EditRefusal extends Error {
  readonly code: RefusalCode;
  readonly needsConfirm: boolean;
  readonly losses: readonly Loss[];
  readonly hint?: string;

  constructor(code: RefusalCode, message: string, options: { needsConfirm?: boolean; losses?: readonly Loss[]; hint?: string } = {}) {
    super(message);
    this.name = "EditRefusal";
    this.code = code;
    this.needsConfirm = options.needsConfirm ?? false;
    this.losses = options.losses ?? [];
    this.hint = options.hint;
  }
}

// ─────────────────────────────── ожидание и план ───────────────────────────────

/**
 * Что правка тронула в дереве объекта — для предохранителя (О12б: всё вне
 * `touched` прежнее, до параметра и значения).
 * - `properties` — изменённые и добавленные свойства (объекты дерева после
 *   правки) и снятые (их прежние объекты, уже вне дерева);
 * - `components` — добавленные и снятые подкомпоненты (клоны переопределений,
 *   VALARM, VTIMEZONE);
 * - `names` — по компоненту дерева: имена (в нижнем регистре) свойств и
 *   подкомпонентов, которые правка меняла, добавляла или снимала. Всё прочее
 *   в этом компоненте обязано совпасть с прочитанным. Для VCALENDAR — имена
 *   добавленных подкомпонентов ("vevent", "vtimezone").
 */
export interface Touched {
  properties: Set<ICAL.Property>;
  components: Set<ICAL.Component>;
  names: Map<ICAL.Component, Set<string>>;
}

/**
 * Ожидание от плана (О12). Заполняет планировщик, проверяет предохранитель.
 * - `fields` — поля патча, которые план применяет;
 * - `keyMap` — прежний ключ видимой встречи → ключ после записи (сдвиг
 *   серии, Р1); без него ключи не меняются;
 * - `removed` — ключи видимых встреч, которые план убирает;
 * - `ruleChanged` — план меняет правило, время или конец серии (О12д);
 * - `datesFixed` — даты слотов после записи прежние (Р1 без recurrence);
 * - `tail` — ожидаемая протяжённость конечной серии после записи: число
 *   позиций и дата последнего слота `YYYY-MM-DD`;
 * - `touched` — см. `Touched`.
 */
export interface Expectation {
  op: EditOp;
  scope: EditScope;
  target?: SlotKey;
  fields: ReadonlySet<PatchField>;
  keyMap?: (key: SlotKey) => SlotKey;
  removed: readonly SlotKey[];
  ruleChanged: boolean;
  datesFixed: boolean;
  tail?: { count: number; lastDate?: string };
  touched: Touched;
}

/** Общее у планов: ожидание, убираемые встречи для ответа и пояснения по-русски. */
interface PlanCommon {
  expect: Expectation;
  removed: readonly Loss[];
  notices: readonly string[];
}

/**
 * План записи (О13: пустой план ничего не пишет):
 * - `noop` — ничего не менять;
 * - `put` — записать объект целиком (If-Match по прочитанному ETag);
 * - `delete-object` — удалить объект;
 * - `split` — разрез (Р9): сначала продолжение с новым UID, затем усечённый
 *   исходный объект; `boundary` — ключ первой встречи продолжения.
 */
export type WritePlan =
  | ({ kind: "noop" } & PlanCommon)
  | ({ kind: "put"; ics: string } & PlanCommon)
  | ({ kind: "delete-object" } & PlanCommon)
  | ({ kind: "split"; continuation: { uid: string; ics: string }; truncated: { ics: string }; boundary: SlotKey } & PlanCommon);
