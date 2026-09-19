import type ICAL from "ical.js";
import { hiddenOverrides, instanceAt, instancesBetween, toCalendarEvent, type EventMeta, type Instance } from "./instances.js";
import { isUnparsable, loadObject, type CalendarObject, type Unparsable } from "./object.js";
import { DEFAULT_READ_ENV, eventOfObject, modelReminders, unparsableEvent } from "./parse.js";
import { SERIES_CAP, SlotScanError } from "./slots.js";
import { instantOf, slotKeyOf, type IcalEnv } from "./values.js";
import type { CalendarEvent } from "../types.js";

/**
 * Встречи календарного объекта в окне — то, что показывают list_events и
 * find_free_slots (З09 плана переделки,
 * docs/superpowers/plans/2026-09-19-recurring-events-rework.md).
 *
 * Обёртка над `instancesBetween` (instances.ts): раскрытие локальное —
 * Яндекс игнорирует `<C:expand>` (docs/yandex-caldav-capabilities.md), —
 * окно и порядок по фактическому времени, встреча показывается ровно одним
 * путём: слот серии, его переопределение (роль slot) или detached по своему
 * RECURRENCE-ID. Скрытые переопределения (роль hidden: под EXDATE, раньше
 * первой встречи, после конца серии) не показываются и времени не занимают —
 * прежний проход «по всем исключениям» делал из них призраков (R8-N1).
 * Ролей ровно три — slot, hidden, detached (поправка «без ремонта следов
 * прежнего кода»).
 *
 * Выдача не обрезается молча и объект не прячется:
 * - текст, который ical.js не разбирает, — одна заглушка на объект с
 *   аномалией «unparsable: …» (Р4, parse.ts, unparsableEvent); нечитаемое
 *   начало — `UnparsableEventError` с UID;
 * - серию, чьи встречи до конца окна не перебрать (`SlotScanError` из
 *   instancesBetween: больше SERIES_CAP слотов или итератор сбился посреди
 *   серии), — заглушка основного компонента с аномалией «unexpanded: …» и
 *   встречи со своим компонентом (переопределения), чьё время в окне: их
 *   время записано в компоненте и известно без перебора;
 * - серию с правилом, которое итератор не перебирает (bad-rrule, Р4: правило
 *   не читается вовсе, слоты — DTSTART и RDATE), — если окно кончается позже
 *   первого неизвестного момента (`unknownFromMs`: DTSTART, а при
 *   переопределении, скрытом как «вне серии», — и его собственное начало), а
 *   встречи DTSTART в выдаче нет, к выдаче добавляется та же заглушка
 *   основного компонента: какие встречи назначило правило, не узнать.
 * Заглушки unparsable и unexpanded показываются при любом окне: сервер отобрал
 * объект для этого окна (Ж17), а какие его встречи в окне — не узнать.
 * find_free_slots по ним отказывает (`unreadableReason`).
 *
 * Напоминания — только те, что модель умеет вернуть (parse.ts,
 * modelReminders, О9).
 */

/**
 * Встречи объекта `ics` в окне [from, to), по возрастанию фактического
 * начала (RFC 4791 §9.9: встреча с длительностью — пересекает окно, без —
 * начинается в нём).
 *
 * Прежняя сигнатура сохранена; `env` необязателен (`DEFAULT_READ_ENV`: даты и
 * плавающее время — в UTC, как читал прежний код). `from` и `to` — моменты;
 * используются только их миллисекунды (`getTime`), пояс процесса не участвует.
 */
export function expandOccurrences(
  ics: string,
  calendarId: string,
  from: Date,
  to: Date,
  etag?: string,
  env: IcalEnv = DEFAULT_READ_ENV,
): CalendarEvent[] {
  const fromMs = from.getTime();
  const toMs = to.getTime();
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
    throw new Error("Границы окна должны быть моментами времени (ISO 8601 со смещением).");
  }
  return occurrencesOf(loadObject(ics, env), fromMs, toMs, { calendarId, etag }, env);
}

/**
 * То же для уже загруженного объекта (readEvents, З13): `meta` — календарь,
 * etag и путь объекта; `env` нужен заглушке неразбираемого объекта (у
 * разобранного он свой, `o.env`).
 */
export function occurrencesOf(
  o: CalendarObject | Unparsable,
  fromMs: number,
  toMs: number,
  meta: EventMeta,
  env: IcalEnv,
): CalendarEvent[] {
  if (isUnparsable(o)) return [unparsableEvent(o, meta, env)];
  let instances: Instance[];
  let stub: Shown | undefined;
  try {
    instances = instancesBetween(o, fromMs, toMs);
    stub = badRuleStub(o, instances, toMs, meta);
  } catch (error) {
    if (!(error instanceof SlotScanError)) throw error;
    instances = ownComponentInstances(o, fromMs, toMs);
    stub = masterStub(o, meta, scanFailure(error));
  }
  const shown: Shown[] = instances.map((instance) => ({ startMs: instance.startMs, event: instanceEvent(o, instance, meta) }));
  if (stub) shown.push(stub);
  // Сортировка устойчивая: встречи уже идут по возрастанию (instancesBetween,
  // byStart), заглушка встаёт по своему DTSTART.
  return shown.sort((a, b) => a.startMs - b.startMs).map((item) => item.event);
}

/**
 * Коды аномалий, при которых встречи объекта в выдаче не прочитаны целиком:
 * - unparsable — заглушка неразбираемого текста (Р4);
 * - unexpanded — заглушка серии, чьих встреч в окне не перебрать;
 * - bad-rrule — правило, которое итератор ical.js не принимает (Р4): видна
 *   только встреча DTSTART (в окне позже неё — заглушка основного
 *   компонента), а какие встречи назначило правило — неизвестно.
 * no-positions сюда не входит: правило без позиций по RFC 5545 не даёт
 * встреч, и набор — DTSTART и RDATE — известен точно.
 */
export const UNREADABLE_CODES: readonly string[] = ["unparsable", "unexpanded", "bad-rrule"];

/**
 * Почему встречи события не прочитаны целиком: первая аномалия с кодом из
 * `UNREADABLE_CODES` («код: пояснение», types.ts, CalendarEvent.anomalies)
 * или undefined. Нужна find_free_slots: время таких встреч неизвестно, и
 * считать его свободным нельзя.
 */
export function unreadableReason(event: CalendarEvent): string | undefined {
  return event.anomalies?.find((anomaly) => UNREADABLE_CODES.some((code) => anomaly.startsWith(`${code}:`)));
}

// ─────────────────────────────── внутреннее ───────────────────────────────

/** Строка выдачи и её фактическое начало — ключ сортировки. */
interface Shown {
  startMs: number;
  event: CalendarEvent;
}

function instanceEvent(o: CalendarObject, instance: Instance, meta: EventMeta): CalendarEvent {
  const event = toCalendarEvent(o, instance, meta);
  event.reminders = modelReminders(instance.shown);
  return event;
}

// Заглушка основного компонента: его DTSTART, поля и повтор (eventOfObject,
// parse.ts) без адреса и без exceptions — это строка list_events, а не
// get_event; в аномалии unexpanded — почему встречи окна не показаны.
function masterStub(o: CalendarObject, meta: EventMeta, why: string): Shown {
  const event = eventOfObject(o, meta, o.env);
  delete event.exceptions;
  event.anomalies = [
    ...(event.anomalies ?? []),
    `unexpanded: встречи серии в окне не перебраны: ${why}; показано только начало серии (DTSTART)`,
  ];
  // Серия без основного компонента не бросает SlotScanError и не бывает
  // bad-rrule (аномалия ставится основному, object.ts, ruleAnomalies).
  return { startMs: instantOf(dtstartOf(o.master!), o.env), event };
}

function scanFailure(error: SlotScanError): string {
  return error.code === "too-long"
    ? `до конца окна у серии больше ${SERIES_CAP} встреч`
    : `правило перестало давать встречи посреди серии (${error.message})`;
}

// Р4: правило, которое итератор ical.js не перебирает (bad-rrule; сломанный
// EXRULE — тоже), не читается вовсе (slots.ts, specOf): слоты — только
// DTSTART и RDATE, встречи правила в окне неизвестны. Если окно кончается
// не позже первого неизвестного момента (`unknownFromMs`), неизвестных
// встреч в нём нет. Иначе, если встречи DTSTART с аномалией в выдаче нет,
// объект показывается заглушкой основного компонента: без неё list_events
// молча не покажет объект, а find_free_slots сочтёт время свободным.
function badRuleStub(o: CalendarObject, instances: readonly Instance[], toMs: number, meta: EventMeta): Shown | undefined {
  if (!o.master || !o.anomalies.some((anomaly) => anomaly.code === "bad-rrule")) return undefined;
  const dtstart = dtstartOf(o.master);
  if (unknownFromMs(o, instantOf(dtstart, o.env)) >= toMs) return undefined;
  const key = slotKeyOf(dtstart, o.form, o.env);
  if (instances.some((instance) => instance.key === key)) return undefined;
  return masterStub(o, meta, "правило не перебирается (bad-rrule), и какие встречи оно назначило, неизвестно");
}

// Раньше какого момента у объекта с bad-rrule неизвестных встреч нет.
//
// Обычно это DTSTART: правило не назначает встреч раньше него — итератор
// пропускает такие позиции (recur_iterator.js:451-453). Но при bad-rrule
// серия выглядит конечной из одной встречи DTSTART, и переопределение с
// RECURRENCE-ID позже него `assignRoles` (object.ts) прячет как «вне серии»,
// хотя протяжённость серии на деле неизвестна. Собственное время такого
// компонента известно и бывает раньше DTSTART: тогда прятать объект нельзя и
// в окне раньше DTSTART (находка перепроверки З09). Само переопределение
// заглушка не показывает — роль ему назначает object.ts; здесь важно, что
// объект виден и find_free_slots по нему отказывает, а не отдаёт занятое
// время как свободное.
//
// Скрытое под EXDATE (reason "excluded") к правилу не относится и остаётся
// надёжно скрытым; RECURRENCE-ID раньше DTSTART правило назначить не могло,
// так что такое скрытие тоже надёжно.
function unknownFromMs(o: CalendarObject, dtstartMs: number): number {
  let earliest = dtstartMs;
  for (const hidden of hiddenOverrides(o)) {
    if (hidden.reason !== "outside-series" || instantOf(hidden.address, o.env) < dtstartMs) continue;
    for (const ref of hidden.refs) earliest = Math.min(earliest, instantOf(dtstartOf(ref.component), o.env));
  }
  return earliest;
}

// Встречи со своим компонентом (роль slot или detached), пересекающие окно,
// когда слоты серии не перебрать (SlotScanError): их время записано в
// компоненте (instances.ts, instanceAt → explicitInstance), перебор слотов
// для них не нужен. Скрытые (hidden) не показываются, и в instanceAt они не
// идут: там их ждал бы findSlot — тот же перебор слотов, что уже не удался.
// SlotScanError из instanceAt всё равно перехватывается: встреча, которую не
// построить, не показывается, а заглушка unexpanded об этом предупреждает.
function ownComponentInstances(o: CalendarObject, fromMs: number, toMs: number): Instance[] {
  const found: Instance[] = [];
  for (const [key, refs] of o.overrides) {
    if (o.roles.get(refs[0].component)?.role === "hidden") continue;
    let instance: Instance | undefined;
    try {
      instance = instanceAt(o, key);
    } catch (error) {
      if (!(error instanceof SlotScanError)) throw error;
      continue;
    }
    if (instance && overlapsWindow(instance, fromMs, toMs)) found.push(instance);
  }
  return found.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
}

// RFC 4791 §9.9, как в instances.ts (overlaps): с длительностью — [start,
// end) пересекает окно; без — начало в окне.
function overlapsWindow(instance: Instance, fromMs: number, toMs: number): boolean {
  if (instance.endMs > instance.startMs) return instance.startMs < toMs && instance.endMs > fromMs;
  return instance.startMs >= fromMs && instance.startMs < toMs;
}

function dtstartOf(master: ICAL.Component): ICAL.Time {
  return master.getFirstPropertyValue("dtstart") as ICAL.Time;
}
