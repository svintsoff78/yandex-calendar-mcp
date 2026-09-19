import type { RawObject } from "./caldav/objects.js";
import type { CaldavClient } from "./caldav/request.js";
import type { Config } from "./config.js";

export interface Calendar {
  id: string;
  href: string;
  displayName: string;
  color?: string;
  timeZone?: string;
  readOnly: boolean;
}

export type RecurrenceFrequency = "daily" | "weekly" | "monthly" | "yearly";

type Weekday = "MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU";

export interface Recurrence {
  frequency: RecurrenceFrequency;
  interval: number;
  /**
   * Дни недели BYDAY (RFC 5545 §3.3.10). Помимо дня без префикса ("MO")
   * значение может нести порядковый префикс: "2MO" — второй понедельник
   * месяца, "-1FR" — последняя пятница месяца. Префикс — часть значения
   * BYDAY, а не мусор: срезать его при разборе значит молча превратить
   * "второй понедельник" в "каждый понедельник". Парсер и сборщик правила
   * сохраняют строку как есть.
   */
  byWeekday?: Array<Weekday | `${number}${Weekday}`>;
  until?: string;
  count?: number;
  /**
   * Части RRULE, которые модель не выражает, дословно, через ";":
   * например, "BYSETPOS=-1;WKST=SU". Только для чтения: правило в объекте
   * остаётся текстом с сервера, и правка без явной замены эти части не
   * трогает (решение Р4 плана переделки,
   * docs/superpowers/plans/2026-09-19-recurring-events-rework.md).
   */
  unmodeled?: string;
}

export interface Reminder {
  /**
   * Отступ напоминания от начала события в минутах.
   * Положительное значение — раньше начала (обычный случай: TRIGGER:-PT15M
   * даёт 15). Отрицательное — позже начала (TRIGGER:PT15M без минуса —
   * валидный по RFC 5545 триггер "после", даёт -15). Имя поля сохранено
   * ради совместимости, но ноль — не единственная граница: смысл несёт знак.
   */
  minutesBefore: number;
  method: "display" | "email";
}

export interface Attendee {
  email: string;
  status: "accepted" | "declined" | "tentative" | "needs-action";
}

/** STATUS у VEVENT (RFC 5545 §3.8.1.11): других значений у события нет. */
export type EventStatus = "tentative" | "confirmed" | "cancelled";

/**
 * Состояние записи в `CalendarEvent.exceptions` (решения Р5–Р7 плана;
 * роли переопределений — ровно три: slot, hidden, detached, поправка
 * «без ремонта следов прежнего кода» от 19.09.2026):
 * - "changed" — переопределение слота с прежним временем, другие поля;
 * - "moved" — переопределение слота, перенесённое на другое время;
 * - "cancelled" — переопределение со STATUS:CANCELLED, время не занимает;
 * - "excluded" — слот закрыт EXDATE, своего компонента у него нет;
 * - "hidden" — переопределение, чей RECURRENCE-ID под EXDATE или вне
 *   серии: в list_events и find_free_slots его нет, удаляется delete this
 *   по своему адресу;
 * - "detached" — RECURRENCE-ID мимо слотов: показывается отдельной
 *   встречей по адресу своего RECURRENCE-ID и занимает время (в том числе
 *   объект без основного компонента, Р6);
 * - "duplicate" — лишний компонент с тем же RECURRENCE-ID.
 */
export type ExceptionState =
  | "changed"
  | "moved"
  | "cancelled"
  | "excluded"
  | "hidden"
  | "detached"
  | "duplicate";

/** Отступление серии от её правила — запись в `CalendarEvent.exceptions` (get_event). */
export interface EventException {
  /**
   * Адрес для update_event и delete_event со scope "this" в формате Р10:
   * слот, а у скрытого, оторванного или лишнего компонента — его
   * RECURRENCE-ID.
   */
  instanceStart: string;
  state: ExceptionState;
  /** Фактическое начало и конец, если у записи есть свой компонент. */
  start?: string;
  end?: string;
  summary?: string;
  /** Пояснение по-русски, почему запись в таком состоянии. */
  reason?: string;
}

export interface CalendarEvent {
  id: string;
  calendarId: string;
  summary: string;
  description?: string;
  location?: string;
  start: string;
  end: string;
  timeZone: string;
  allDay: boolean;
  /**
   * Повтор в терминах модели. Отсутствует, если частота вне
   * RecurrenceFrequency (HOURLY и другие) или RRULE нет вовсе (серия из
   * одних RDATE). Невыразимые части RRULE — в `recurrence.unmodeled`,
   * дословное правило, когда модели мало, — в `recurrenceRule` (Р4).
   */
  recurrence?: Recurrence;
  reminders: Reminder[];
  attendees: Attendee[];
  etag?: string;
  href?: string;
  /**
   * Адрес экземпляра — слот, то есть RECURRENCE-ID, одинаковый у
   * перенесённой и неперенесённой встречи (Р10): ISO со смещением пояса
   * DTSTART, у встречи на весь день — дата YYYY-MM-DD.
   */
  instanceStart?: string;
  seriesId?: string;
  /**
   * Встреча — часть серии: у основного компонента RRULE любой частоты или
   * RDATE, либо это переопределение с RECURRENCE-ID. Поле необязательно,
   * пока его не заполняют все производители события.
   */
  recurring?: boolean;
  /**
   * Дословные строки RRULE и RDATE, по одной на строку, когда `recurrence`
   * правило не выражает: HOURLY и прочие частоты, RDATE, несколько RRULE
   * (Р4).
   */
  recurrenceRule?: string;
  /** STATUS компонента; отсутствует, если STATUS не задан. "cancelled" время не занимает (Р7). */
  status?: EventStatus;
  /** Фактическое начало встречи отличается от её слота `instanceStart` (Р10). */
  moved?: boolean;
  /**
   * Переопределение вне слотов серии или из объекта без основного
   * компонента (Р5, Р6); `instanceStart` у него — его RECURRENCE-ID.
   */
  detached?: boolean;
  /** Отступления серии от правила; заполняет get_event. */
  exceptions?: EventException[];
  /**
   * Аномалии объекта в виде "код: пояснение", например
   * "unparsable: …" или "duplicate-override: …" (О14, Р4, Р5).
   */
  anomalies?: string[];
}

/**
 * Условие записи: ровно одно из двух. If-Match с ETag, прочитанным в этом же
 * вызове, — замена существующего объекта; If-None-Match: * — создание
 * нового, если по пути ещё ничего нет.
 */
export type WriteCondition =
  | { ifMatch: string; ifNoneMatch?: never }
  | { ifNoneMatch: "*"; ifMatch?: never };

/**
 * Неуспешный исход записи (решение Р8 плана):
 * - "precondition-failed" — 412, условие не выполнено, запись не применена;
 * - "not-found" — 404, объекта по пути нет;
 * - "rejected" — иной отказ сервера (4xx, CaldavError.applied === "no"),
 *   запись точно не применена;
 * - "unknown" — сеть, таймаут или 5xx (CaldavError.applied === "unknown"):
 *   запись могла примениться, исход выясняется перечитыванием.
 * В `error` — исходная ошибка транспорта, обычно CaldavError с hint.
 */
export type WriteFailure =
  | { status: "precondition-failed" }
  | { status: "not-found" }
  | { status: "rejected"; error: Error }
  | { status: "unknown"; error: Error };

/** Исход PUT; etag — пустая строка, если сервер ETag не прислал. */
export type PutOutcome = { status: "applied"; etag: string } | WriteFailure;

/** Исход DELETE. */
export type RemoveOutcome = { status: "applied" } | WriteFailure;

export type WriteOutcome = PutOutcome | RemoveOutcome;

/**
 * Порт ввода-вывода объектов календаря для правки и удаления. Реализация
 * по умолчанию (`ioFor` в src/domain/writes.ts) ходит через CalDAV:
 * queryEventByUid, putObject, deleteObject; тесты подставляют свою через
 * `Context.io`.
 *
 * `put` и `remove` уходят на сервер ровно один раз и не бросают ни при
 * ответе сервера, ни при сбое сети: исход — значение, повтор решает
 * вызывающий по Р8.
 */
export interface ObjectIO {
  /**
   * Объект по UID: путь и ETag — из ответа сервера, а не собраны из UID.
   * undefined — объекта нет. Поиск — безопасный запрос, его при сбоях
   * повторяет сам транспорт, поэтому, в отличие от записи, сбой поиска
   * (и несколько объектов с одним UID) бросается исключением.
   */
  find(calendar: Calendar, uid: string): Promise<RawObject | undefined>;
  put(href: string, ics: string, condition: WriteCondition): Promise<PutOutcome>;
  /** DELETE всегда условный: If-Match с ETag, прочитанным в этом же вызове. */
  remove(href: string, ifMatch: string): Promise<RemoveOutcome>;
}

export interface Context {
  client: CaldavClient;
  config: Config;
  discover(): Promise<Calendar[]>;
  calendars(): Promise<Calendar[]>;
  resolveCalendar(idOrName?: string): Promise<Calendar>;
  /** Ввод-вывод объектов; если не задан, `ioFor` строит его на `client`. */
  io?: ObjectIO;
  /**
   * Текущий момент для DTSTAMP, LAST-MODIFIED и горизонтов проверок; тесты
   * подставляют неподвижные часы. Если не задан — системные часы.
   */
  now?: () => Date;
}

export type EditScope = "this" | "this_and_following" | "all_series";
