import ICAL from "ical.js";
import { randomUUID } from "node:crypto";
import { deleteObject, queryEventByUid, queryEvents, putObject } from "../caldav/objects.js";
import { expandOccurrences } from "../ical/expand.js";
import { buildEvent } from "../ical/build.js";
import { parseEvent } from "../ical/parse.js";
import { registerTimeZone } from "../ical/timezones.js";
import { resolveCalendarIn } from "./calendars.js";
import type {
  Attendee,
  Calendar,
  CalendarEvent,
  Context,
  EditScope,
  Recurrence,
  Reminder,
} from "../types.js";

export interface ReadParams {
  from: string;
  to: string;
  calendarIds?: string[];
  query?: string;
  expandRecurring?: boolean;
}

export function matchesQuery(event: CalendarEvent, query?: string): boolean {
  if (!query) return true;
  const needle = query.toLowerCase();
  return [event.summary, event.description, event.location]
    .filter((value): value is string => Boolean(value))
    .some((value) => value.toLowerCase().includes(needle));
}

// Годится только для событий, которые создаём мы сами (задача 12): наш UID
// не содержит "@", поэтому encodeURIComponent даёт путь, совпадающий с тем,
// что кладёт на диск сервер Яндекса. Для чтения ЧУЖОГО события (заведённого
// в вебе или на телефоне) эта функция непригодна — см. предупреждение у
// readEvent ниже и docs/yandex-caldav-capabilities.md.
export function hrefFor(calendar: Calendar, eventId: string): string {
  return `${calendar.href.replace(/\/?$/, "/")}${encodeURIComponent(eventId)}.ics`;
}

type QueryFn = (calendar: Calendar, from: Date, to: Date) => Promise<
  Array<{ href: string; etag: string; ics: string }>
>;

function queryFor(context: Context): QueryFn {
  const injected = (context as unknown as { query?: QueryFn }).query;
  if (injected) return injected;
  return (calendar, from, to) => queryEvents(context.client, calendar.href, from, to);
}

export async function readEvents(context: Context, params: ReadParams): Promise<CalendarEvent[]> {
  const from = new Date(params.from);
  const to = new Date(params.to);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new Error("Параметры from и to должны быть датами в формате ISO 8601.");
  }
  if (from >= to) throw new Error("Начало окна должно быть раньше конца.");

  const all = await context.calendars();
  const selected = params.calendarIds?.length
    ? params.calendarIds.map((id) => resolveCalendarIn(all, id))
    : all;

  const expand = params.expandRecurring !== false;
  const query = queryFor(context);
  const collected: CalendarEvent[] = [];

  // Календари опрашиваются последовательно, в цикле: если их станет много
  // (например десять), время сложится из времени всех REPORT-запросов, а не
  // одного самого медленного. Для типичного личного аккаунта (единицы
  // календарей) это неощутимо; при явном требовании параллельности —
  // см. отчёт задачи, это осознанный компромисс, а не недосмотр.
  for (const calendar of selected) {
    // Ошибка чтения одного календаря не должна тихо срезать часть выдачи:
    // неполный список, отданный как полный, опаснее явного отказа —
    // пользователь не заметит пропавшие встречи. Поэтому распространяем
    // ошибку наружу, но оборачиваем её, чтобы в тексте было имя отказавшего
    // календаря (иначе наружу ушло бы сообщение уровня CalDAV, из которого
    // не видно, какой именно календарь виноват), сохраняя исходную ошибку
    // как cause.
    let objects: Array<{ href: string; etag: string; ics: string }>;
    try {
      objects = await query(calendar, from, to);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Не удалось прочитать календарь «${calendar.displayName}»: ${reason}`,
        { cause: error },
      );
    }
    for (const object of objects) {
      const events = expand
        ? expandOccurrences(object.ics, calendar.id, from, to, object.etag)
        : [parseEvent(object.ics, calendar.id, object.etag)];
      for (const event of events) {
        if (matchesQuery(event, params.query)) collected.push({ ...event, href: object.href });
      }
    }
  }

  return collected.sort(
    (left, right) => new Date(left.start).getTime() - new Date(right.start).getTime(),
  );
}

export async function readEvent(
  context: Context,
  calendarId: string,
  eventId: string,
): Promise<CalendarEvent> {
  const calendar = await context.resolveCalendar(calendarId);

  // ОБЯЗАТЕЛЬНОЕ ОТСТУПЛЕНИЕ ОТ БРИФА: путь к объекту нельзя построить из
  // UID (hrefFor) — сервер Яндекса не выводит имя файла из UID
  // (docs/yandex-caldav-capabilities.md, задача 1): UID вида
  // "aaaabbbbccccdddd11@yandex.ru" хранится как объект
  // "aaaabbbbccccdddd11yandex.ru.ics" — собака выброшена, а не
  // закодирована. Это верно для ЛЮБОГО события, заведённого не нами
  // (веб-интерфейс, телефон), то есть почти для всех событий в реальном
  // аккаунте. Поэтому ищем объект REPORT'ом calendar-query по UID
  // (queryEventByUid, задача 9) и берём href и etag из ответа сервера.
  const object = await queryEventByUid(context.client, calendar.href, eventId);
  if (!object) {
    throw new Error(
      `Событие с идентификатором «${eventId}» не найдено в календаре «${calendar.displayName}».`,
    );
  }

  const event = parseEvent(object.ics, calendar.id, object.etag);
  return { ...event, href: object.href };
}

// Поля события на границе создания: без id/etag/href (их присваивает
// сервер и hrefFor — вызывающий код их не выбирает) и без timeZone как
// обязательного поля — если его не передали, используется пояс из
// конфигурации (YANDEX_DEFAULT_TZ).
export interface EventInput {
  calendarId?: string;
  summary: string;
  description?: string;
  location?: string;
  start: string;
  end: string;
  timeZone?: string;
  allDay?: boolean;
  recurrence?: Recurrence;
  reminders?: Reminder[];
  attendees?: Attendee[];
}

export interface BulkResult {
  ok: boolean;
  summary: string;
  id?: string;
  error?: string;
}

// Предел размера пачки. CalDAV не умеет пакетные операции — createEvents
// (ниже) кладёт каждое событие отдельным PUT-запросом последовательно, без
// параллелизма и без отката при частичной неудаче. Такая пачка не
// сломается и на сотне событий, но время линейно растёт с числом событий и
// рискует упереться в таймаут вызывающей стороны (MCP-клиента) или в лимиты
// сервера Яндекса на частоту запросов. 50 — заведомо достаточно для
// разумного сценария (перенести неделю или месяц встреч разом) и заведомо
// укладывается в единицы-десятки секунд при обычной задержке CalDAV-запроса.
const MAX_BATCH_SIZE = 50;

type PutFn = (
  href: string,
  ics: string,
  options: { ifMatch?: string; ifNoneMatch?: boolean },
) => Promise<string>;

// Тот же приём внедрения зависимости, что и у queryFor выше: тесты кладут
// в context.put мок вместо настоящего PUT по сети.
function putFor(context: Context): PutFn {
  const injected = (context as unknown as { put?: PutFn }).put;
  if (injected) return injected;
  return (href, ics, options) => putObject(context.client, href, ics, options);
}

export async function createEvent(context: Context, input: EventInput): Promise<CalendarEvent> {
  // Самопроверка задачи 12 (проверки, которых нет в брифе): дешёвые проверки
  // формы входа — до resolveCalendar и уж тем более до сети.
  if (!input.summary.trim()) {
    throw new Error("Заголовок события не может быть пустым.");
  }
  const start = new Date(input.start);
  const end = new Date(input.end);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new Error("Параметры start и end должны быть датами в формате ISO 8601.");
  }
  if (start >= end) {
    throw new Error("Конец события должен быть позже начала.");
  }

  const calendar = await context.resolveCalendar(input.calendarId);
  if (calendar.readOnly) {
    throw new Error(`Календарь «${calendar.displayName}» открыт только для чтения.`);
  }

  const event = {
    calendarId: calendar.id,
    summary: input.summary,
    description: input.description,
    location: input.location,
    start: input.start,
    end: input.end,
    timeZone: input.timeZone ?? context.config.defaultTimeZone,
    allDay: input.allDay ?? false,
    recurrence: input.recurrence,
    reminders: input.reminders ?? [],
    attendees: input.attendees ?? [],
  };

  const { ics, uid } = buildEvent(event);
  const href = hrefFor(calendar, uid);
  const etag = await putFor(context)(href, ics, { ifNoneMatch: true });

  return { ...event, id: uid, href, etag };
}

// Пачка намеренно не откатывается при частичной неудаче: транзакций в
// CalDAV нет, а отчёт по каждой строке позволяет повторить только
// неудавшиеся события, не трогая уже созданные.
export async function createEvents(
  context: Context,
  inputs: EventInput[],
): Promise<BulkResult[]> {
  if (inputs.length > MAX_BATCH_SIZE) {
    throw new Error(
      `Пачка из ${inputs.length} событий превышает предел в ${MAX_BATCH_SIZE}: разбейте на несколько вызовов.`,
    );
  }

  const results: BulkResult[] = [];
  for (const input of inputs) {
    try {
      const event = await createEvent(context, input);
      results.push({ ok: true, summary: input.summary, id: event.id });
    } catch (error) {
      results.push({
        ok: false,
        summary: input.summary,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Правка событий (задача 13)
// ---------------------------------------------------------------------------

export interface UpdateParams {
  calendarId?: string;
  id: string;
  scope?: EditScope;
  instanceStart?: string;
  patch: Partial<EventInput>;
}

type GetFn = (calendar: Calendar, uid: string) => Promise<{ href: string; etag: string; ics: string }>;

// Тот же приём внедрения зависимости, что у queryFor/putFor выше: тесты
// подставляют context.get вместо похода в сеть.
//
// ОБЯЗАТЕЛЬНОЕ ОТСТУПЛЕНИЕ ОТ БРИФА: там объект для правки находился по
// `hrefFor(calendar, params.id)` + GET. Это неверно для чужих событий: задача 1
// установила на живом сервере Яндекса, что имя файла объекта НЕ выводится из
// UID (docs/yandex-caldav-capabilities.md) — собака выбрасывается, а не
// кодируется, поэтому собранный путь не совпадёт с реальным почти для любого
// события, заведённого не нами (веб, телефон). Задача 11 уже решила это для
// чтения (readEvent выше, тот же аргумент подробно расписан там) — здесь тот
// же приём: ищем объект REPORT'ом calendar-query по UID (queryEventByUid) и
// берём href, etag и ics из ответа сервера. hrefFor остаётся пригоден только
// там, где UID выдаём мы сами — ниже, для новой серии при this_and_following.
function getFor(context: Context): GetFn {
  const injected = (context as unknown as { get?: GetFn }).get;
  if (injected) return injected;
  return async (calendar, uid) => {
    const object = await queryEventByUid(context.client, calendar.href, uid);
    if (!object) {
      throw new Error(
        `Событие с идентификатором «${uid}» не найдено в календаре «${calendar.displayName}».`,
      );
    }
    return object;
  };
}

// Патч не трогает поля, которых в нём нет: там, где patch[поле] === undefined,
// остаётся значение из переданного события.
function merge(event: CalendarEvent, patch: Partial<EventInput>) {
  return {
    calendarId: event.calendarId,
    summary: patch.summary ?? event.summary,
    description: patch.description ?? event.description,
    location: patch.location ?? event.location,
    start: patch.start ?? event.start,
    end: patch.end ?? event.end,
    timeZone: patch.timeZone ?? event.timeZone,
    allDay: patch.allDay ?? event.allDay,
    recurrence: patch.recurrence ?? event.recurrence,
    reminders: patch.reminders ?? event.reminders,
    attendees: patch.attendees ?? event.attendees,
  };
}

function veventOf(ics: string): { root: ICAL.Component; vevent: ICAL.Component } {
  const root = new ICAL.Component(ICAL.parse(ics));
  const vevent = root.getFirstSubcomponent("vevent");
  if (!vevent) throw new Error("В календарной записи нет компонента VEVENT.");
  return { root, vevent };
}

// Значение RECURRENCE-ID обязано быть в том же представлении, что и DTSTART
// экземпляра, который оно опознаёт (RFC 5545 §3.8.4.4) — иначе сервер и
// другие клиенты не смогут сопоставить переопределение с конкретным
// вхождением серии.
//
// Отступление от брифа: там стояло `ICAL.Time.fromJSDate(date, false)` +
// `ICAL.TimezoneService.get(tzid) ?? ICAL.Timezone.utcTimezone`. Это тот же
// баг, что уже был найден и исправлен в toIcalTime (src/ical/build.ts,
// см. комментарий там подробно): при useUTC=false ical.js берёт год/час/
// минуту и т. д. из геттеров JS Date БЕЗ смещения — то есть в часовом поясе
// ХОСТ-МАШИНЫ, а не из смещения, указанного в самой ISO-строке. На машине,
// где локальный пояс случайно совпадает с TZID события, это не проявляется,
// но ломается на сервере с другим TZ (например, UTC). Плюс `??
// ICAL.Timezone.utcTimezone` тихо подменяет пояс на UTC, если он ещё не
// зарегистрирован в TimezoneService, — RECURRENCE-ID тогда не совпадёт с
// DTSTART опознаваемого экземпляра ни по времени, ни по TZID. Здесь —
// fromJSDate(date, true) (момент уже учёл смещение при парсинге ISO-строки)
// плюс registerTimeZone, которая при необходимости зарегистрирует пояс из
// базы IANA, а не молча подставит UTC.
function icalTimeOf(iso: string, tzid: string): ICAL.Time {
  const zone = registerTimeZone(tzid);
  return ICAL.Time.fromJSDate(new Date(iso), true).convertToZone(zone);
}

// Число экземпляров исходной серии СТРОГО раньше instanceStart. Используется
// в двух местах ниже: чтобы проверить, что instanceStart вообще указывает на
// реальный экземпляр (иначе RECURRENCE-ID/UNTIL ссылались бы в пустоту, и
// правка молча создавала бы «сиротский» объект, который не покажет ни один
// календарный клиент, — это хуже явного отказа), и чтобы пересчитать
// оставшийся COUNT для новой серии при this_and_following (см. там).
function occurrencesBefore(ics: string, calendarId: string, instanceStart: string): number {
  return expandOccurrences(ics, calendarId, new Date(0), new Date(instanceStart)).length;
}

// Самопроверка задачи 13 (проверки, которых нет в брифе): без неё scope
// "this"/"this_and_following" с опечаткой в instanceStart (например, времени,
// которого в серии никогда не было) не давал бы никакой ошибки — сервер
// молча принял бы RECURRENCE-ID или UNTIL, ссылающиеся на несуществующий
// экземпляр, и правка выглядела бы успешной, ничего не изменив ни в одном
// клиенте.
function assertInstanceExists(ics: string, calendarId: string, instanceStart: string): void {
  const target = new Date(instanceStart);
  if (Number.isNaN(target.getTime())) {
    throw new Error(`instanceStart «${instanceStart}» не является датой в формате ISO 8601.`);
  }
  // expandOccurrences берёт полуоткрытый интервал [from, to) — окно длиной в
  // секунду, начинающееся ровно в target, ловит экземпляр с началом ровно в
  // target и не задевает соседние.
  const occurrences = expandOccurrences(ics, calendarId, target, new Date(target.getTime() + 1000));
  const exists = occurrences.some(
    (occurrence) => new Date(occurrence.start).getTime() === target.getTime(),
  );
  if (!exists) {
    throw new Error(
      `Момент instanceStart «${instanceStart}» не совпадает ни с одним экземпляром серии. ` +
        "Проверьте время начала конкретного вхождения, например через list_events.",
    );
  }
}

export async function updateEvent(
  context: Context,
  params: UpdateParams,
): Promise<CalendarEvent> {
  const calendar = await context.resolveCalendar(params.calendarId);
  if (calendar.readOnly) {
    throw new Error(`Календарь «${calendar.displayName}» открыт только для чтения.`);
  }

  const object = await getFor(context)(calendar, params.id);
  const current = parseEvent(object.ics, calendar.id, object.etag);
  const scope: EditScope = params.scope ?? "this";
  const put = putFor(context);
  const merged = merge(current, params.patch);

  // Одиночное событие или правка сразу всей серии: правится сам исходный
  // компонент, без RECURRENCE-ID и без второй серии.
  if (!current.recurrence || scope === "all_series") {
    const { ics } = buildEvent({ ...merged, id: params.id });
    const etag = await put(object.href, ics, { ifMatch: object.etag });
    return { ...merged, id: params.id, href: object.href, etag };
  }

  // Дальше — правка повторяющегося события с прицелом на конкретный
  // экземпляр ("this" или "this_and_following"): без instanceStart непонятно,
  // какое вхождение серии имеется в виду.
  if (!params.instanceStart) {
    throw new Error(
      "Для правки повторяющегося события укажите instanceStart — начало того экземпляра, который меняем. Либо передайте scope: \"all_series\", чтобы изменить всю серию.",
    );
  }

  assertInstanceExists(object.ics, calendar.id, params.instanceStart);
  // current.recurrence уже проверен выше (первый if вернул бы раньше, если
  // бы его не было) — фиксируем это в локальной переменной, чтобы TypeScript
  // не терял сужение типа после промежуточных вызовов функций.
  const recurrence: Recurrence = current.recurrence;

  if (scope === "this") {
    // Экземпляр правим относительно ЕГО СОБСТВЕННОГО времени (instanceStart),
    // а не относительно времени первого вхождения серии (current.start) —
    // иначе правка одного только summary у второго и последующих экземпляров
    // молча переносила бы их на время самого первого вхождения серии.
    const duration = new Date(current.end).getTime() - new Date(current.start).getTime();
    const instanceEnd = new Date(new Date(params.instanceStart).getTime() + duration).toISOString();
    const instanceMerged = merge(
      { ...current, start: params.instanceStart, end: instanceEnd },
      params.patch,
    );

    const { root } = veventOf(object.ics);
    const override = veventOf(
      buildEvent({ ...instanceMerged, id: params.id, recurrence: undefined }).ics,
    ).vevent;
    const recurrenceId = override.addPropertyWithValue(
      "recurrence-id",
      icalTimeOf(params.instanceStart, current.timeZone),
    );
    if (!current.allDay) recurrenceId.setParameter("tzid", current.timeZone);
    root.addSubcomponent(override);

    const etag = await put(object.href, root.toString(), { ifMatch: object.etag });
    return {
      ...instanceMerged,
      id: params.id,
      href: object.href,
      etag,
      instanceStart: params.instanceStart,
    };
  }

  // scope === "this_and_following": у исходной серии выставляется UNTIL на
  // момент перед правимым экземпляром, и создаётся новая серия с новым UID и
  // изменёнными полями — здесь UID выдаём мы сами, поэтому hrefFor уместен.
  const boundary = new Date(new Date(params.instanceStart).getTime() - 1000).toISOString();
  const truncated = buildEvent({
    ...current,
    id: params.id,
    recurrence: { ...recurrence, count: undefined, until: boundary },
  });
  await put(object.href, truncated.ics, { ifMatch: object.etag });

  // COUNT — предел ОТНОСИТЕЛЬНЫЙ (число повторов от DTSTART серии), в
  // отличие от UNTIL (абсолютная дата, которая остаётся верной точкой
  // отсечения без изменений и переносится в новую серию как есть через
  // merged.recurrence). Если перенести recurrence.count в новую серию не
  // тронув, общее число повторов превысит то, что было в исходной серии:
  // часть уже прожита в усечённом «хвосте», а новая серия добавит ещё
  // столько же. Пересчитываем остаток — если только пользователь не задал
  // recurrence патчем явно, тогда это его осознанный выбор, и трогать его
  // не нужно.
  let continuationRecurrence = merged.recurrence;
  if (!params.patch.recurrence && recurrence.count) {
    const kept = occurrencesBefore(object.ics, calendar.id, params.instanceStart);
    const remaining = recurrence.count - kept;
    if (remaining > 0) continuationRecurrence = { ...recurrence, count: remaining };
  }

  const continuation = buildEvent({
    ...merged,
    recurrence: continuationRecurrence,
    id: randomUUID(),
    start: params.patch.start ?? params.instanceStart,
    end:
      params.patch.end ??
      new Date(
        new Date(params.instanceStart).getTime() +
          (new Date(current.end).getTime() - new Date(current.start).getTime()),
      ).toISOString(),
  });
  const continuationHref = hrefFor(calendar, continuation.uid);
  const etag = await put(continuationHref, continuation.ics, { ifNoneMatch: true });

  return {
    ...merged,
    recurrence: continuationRecurrence,
    id: continuation.uid,
    href: continuationHref,
    etag,
  };
}

// ---------------------------------------------------------------------------
// Удаление событий (задача 14) — единственная необратимая операция сервера.
// ---------------------------------------------------------------------------

export interface DeleteParams {
  calendarId?: string;
  id: string;
  scope?: EditScope;
  instanceStart?: string;
}

type RemoveFn = (href: string, etag?: string) => Promise<void>;

// Тот же приём внедрения зависимости, что у get/putFor выше: тесты
// подставляют context.remove вместо похода в сеть. По умолчанию — настоящий
// DELETE с If-Match на etag, снятым с ответа сервера (см. getFor): для
// необратимой операции недопустимо ни угадывать путь, ни отправлять запрос
// без условного заголовка, если etag известен.
function removeFor(context: Context): RemoveFn {
  const injected = (context as unknown as { remove?: RemoveFn }).remove;
  if (injected) return injected;
  return (href, etag) => deleteObject(context.client, href, etag);
}

export async function deleteEvent(
  context: Context,
  params: DeleteParams,
): Promise<{ deleted: string; scope: EditScope }> {
  const calendar = await context.resolveCalendar(params.calendarId);
  if (calendar.readOnly) {
    throw new Error(`Календарь «${calendar.displayName}» открыт только для чтения.`);
  }

  // ОБЯЗАТЕЛЬНОЕ ОТСТУПЛЕНИЕ ОТ БРИФА: там объект для удаления находился по
  // `hrefFor(calendar, params.id)`. По тем же причинам, что уже разобраны у
  // getFor выше (используется updateEvent'ом, задача 13, тот же аргумент —
  // задача 11): имя файла объекта на сервере Яндекса НЕ выводится из UID
  // (docs/yandex-caldav-capabilities.md) — собака выбрасывается, а не
  // кодируется, поэтому собранный путь не совпадёт с реальным почти для
  // любого события, заведённого не нами (веб, телефон). Для удаления — самой
  // необратимой операции сервиса — цена ошибки здесь хуже, чем для чтения
  // или правки: операция либо молча ничего не найдёт, либо (что куда хуже)
  // попадёт не в тот объект. getFor уже решает это через queryEventByUid и
  // отдаёт href/etag/ics из ответа сервера — используем ту же функцию, а не
  // переписываем поиск заново.
  const object = await getFor(context)(calendar, params.id);
  const current = parseEvent(object.ics, calendar.id, object.etag);
  // Умолчание зависит от типа события: у одиночного удалять «экземпляр»
  // нечего (у него нет отдельного понятия «экземпляр» помимо самого
  // объекта), поэтому оно сразу трактуется как all_series; у серии по
  // умолчанию исчезает только названный экземпляр — неточная формулировка
  // не должна стирать всю серию.
  const scope: EditScope = params.scope ?? (current.recurrence ? "this" : "all_series");
  const remove = removeFor(context);

  // Одиночное событие или явная просьба удалить всю серию — удаляется сам
  // объект, найденный getFor. Ветка одна и та же для обоих случаев: для
  // одиночного события "экземпляр" и "серия" — один и тот же объект, поэтому
  // сужать поведение по scope там не на чем.
  if (!current.recurrence || scope === "all_series") {
    await remove(object.href, object.etag);
    return { deleted: params.id, scope: "all_series" };
  }

  // Дальше — частичное удаление серии ("this" или "this_and_following"):
  // без instanceStart непонятно, какой именно экземпляр (или начиная с
  // какого момента) нужно убрать, а гадать в необратимой операции
  // недопустимо — лучше понятная ошибка, чем удаление наугад.
  if (!params.instanceStart) {
    throw new Error(
      "Для удаления части серии укажите instanceStart — начало удаляемого экземпляра. " +
        'Либо передайте scope: "all_series", чтобы удалить всю серию целиком.',
    );
  }

  // Самопроверка (тот же приём, что и assertInstanceExists в updateEvent
  // выше): без неё instanceStart, не совпадающий ни с одним настоящим
  // экземпляром серии (опечатка во времени, чужой часовой пояс), тихо
  // добавил бы бесполезный EXDATE или UNTIL «в пустоту» — операция выглядела
  // бы успешной, ничего не удалив, а пользователь решил бы, что экземпляр
  // убран, хотя он остался на месте в календаре.
  assertInstanceExists(object.ics, calendar.id, params.instanceStart);

  const { root, vevent } = veventOf(object.ics);

  if (scope === "this") {
    // EXDATE, а не удаление объекта: серия остаётся, пропадает только
    // названный экземпляр. Правим СЫРОЙ компонент (root/vevent из
    // veventOf), а не пересобираем событие через buildEvent из
    // распарсенного CalendarEvent, — потому что тип CalendarEvent/Recurrence
    // не несёт уже существующие EXDATE (parseRecurrence их не читает):
    // пересборка потеряла бы прежде поставленные исключения серии.
    const exdate = vevent.addPropertyWithValue(
      "exdate",
      icalTimeOf(params.instanceStart, current.timeZone),
    );
    // RFC 5545 §3.8.5.1: параметр TZID у EXDATE обязан совпадать с DTSTART
    // того же VEVENT. Проверено отдельно на живом ical.js: без явного
    // setParameter("tzid", ...) addPropertyWithValue сериализует EXDATE как
    // floating-время без зоны ("EXDATE:20261021T100000" вместо
    // "EXDATE;TZID=...:20261021T100000") — клиенты не смогут надёжно
    // сопоставить исключение с экземпляром в его настоящем часовом поясе.
    // allDay-события используют VALUE=DATE без TZID, поэтому параметр
    // ставится только при явном времени — тот же приём, что у
    // RECURRENCE-ID в updateEvent выше.
    if (!current.allDay) exdate.setParameter("tzid", current.timeZone);

    await putFor(context)(object.href, root.toString(), { ifMatch: object.etag });
    return { deleted: params.instanceStart, scope };
  }

  // scope === "this_and_following": у серии выставляется UNTIL перед
  // удаляемым экземпляром — сам объект остаётся, просто перестаёт порождать
  // экземпляры начиная с этого момента. Новая серия (в отличие от
  // updateEvent) не создаётся: удаление хвоста не переносит вперёд
  // изменённые поля, продолжать нечему.
  //
  // Отступление от брифа: там UNTIL выставлялся через buildEvent(current...)
  // — пересборку всего VEVENT из распарсенного CalendarEvent (тот же приём,
  // что updateEvent использует для этого scope). Для удаления это опаснее,
  // чем для правки: CalendarEvent не несёт уже существующие EXDATE серии
  // (см. комментарий у scope "this" выше), поэтому пересборка потеряла бы
  // экземпляры, удалённые РАНЕЕ через scope "this", если они попадают до
  // новой границы UNTIL, — прежде удалённый экземпляр «воскрес» бы. Здесь
  // вместо пересборки правится только сам RRULE внутри исходного сырого
  // компонента (root/vevent из veventOf, тот же объект, что и у "this"
  // выше) — EXDATE, ATTENDEE, VALARM и всё остальное остаются как есть.
  // Проверено отдельно на живом ical.js: mutating recur.until/recur.count и
  // rruleProperty.setValue(recur) корректно переписывают RRULE, не трогая
  // соседние свойства VEVENT.
  //
  // current.recurrence уже проверен веткой выше (иначе мы бы не дошли
  // сюда), а сам rrule получен именно из него — parseRecurrence в
  // src/ical/parse.ts читает свойство "rrule" и ничего больше, поэтому оно
  // гарантированно есть в сыром компоненте.
  const rruleProperty = vevent.getFirstProperty("rrule");
  if (!rruleProperty) throw new Error("В повторяющемся событии нет свойства RRULE.");
  const recur = rruleProperty.getFirstValue() as ICAL.Recur;
  const boundary = new Date(new Date(params.instanceStart).getTime() - 1000).toISOString();
  // UNTIL обязан быть в UTC (RFC 5545 §3.3.10) — в отличие от RECURRENCE-ID
  // и EXDATE, которые обязаны совпадать по представлению с DTSTART. Тот же
  // приём, что и в toRrule (src/ical/build.ts): useUTC=true без
  // convertToZone.
  recur.until = ICAL.Time.fromJSDate(new Date(boundary), true);
  recur.count = null;
  rruleProperty.setValue(recur);

  await putFor(context)(object.href, root.toString(), { ifMatch: object.etag });
  return { deleted: `${params.instanceStart} и далее`, scope };
}
