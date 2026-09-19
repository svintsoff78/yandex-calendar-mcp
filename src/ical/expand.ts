import { instancesBetween, toCalendarEvent, type EventMeta, type Instance } from "./instances.js";
import { isUnparsable, loadObject, type CalendarObject, type Unparsable } from "./object.js";
import { DEFAULT_READ_ENV, eventOfObject, modelReminders, unparsableEvent } from "./parse.js";
import { SERIES_CAP, SlotScanError } from "./slots.js";
import type { IcalEnv } from "./values.js";
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
 *   серии), — заглушка основного компонента с аномалией «unexpanded: …»:
 *   встреч в окне не видно, но объект виден и сказано почему (Р4: «читается
 *   один DTSTART»).
 * Заглушки показываются при любом окне: сервер отобрал объект для этого окна
 * (Ж17), а какие его встречи в окне — не узнать. find_free_slots по ним
 * отказывает (`unreadableReason`).
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
  try {
    instances = instancesBetween(o, fromMs, toMs);
  } catch (error) {
    if (!(error instanceof SlotScanError)) throw error;
    return [unexpandedEvent(o, error, meta)];
  }
  return instances.map((instance) => {
    const event = toCalendarEvent(o, instance, meta);
    event.reminders = modelReminders(instance.shown);
    return event;
  });
}

/**
 * Коды аномалий, при которых встречи объекта в выдаче не прочитаны целиком:
 * - unparsable — заглушка неразбираемого текста (Р4);
 * - unexpanded — заглушка серии, чьих встреч в окне не перебрать;
 * - bad-rrule — правило, которое итератор ical.js не принимает (Р4): видна
 *   только встреча DTSTART, а какие встречи назначило правило — неизвестно.
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

// Заглушка серии, чьи встречи в окне не перебрать: основной компонент (его
// DTSTART, поля и повтор) без адреса и без exceptions — это строка
// list_events, а не get_event.
function unexpandedEvent(o: CalendarObject, error: SlotScanError, meta: EventMeta): CalendarEvent {
  const event = eventOfObject(o, meta, o.env);
  delete event.exceptions;
  const why = error.code === "too-long"
    ? `до конца окна у серии больше ${SERIES_CAP} встреч`
    : `правило перестало давать встречи посреди серии (${error.message})`;
  event.anomalies = [
    ...(event.anomalies ?? []),
    `unexpanded: встречи серии в окне не перебраны: ${why}; показано только начало серии (DTSTART)`,
  ];
  return event;
}
