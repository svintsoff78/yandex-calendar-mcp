import { queryEventByUid, queryEvents, putObject } from "../caldav/objects.js";
import { expandOccurrences } from "../ical/expand.js";
import { buildEvent } from "../ical/build.js";
import { parseEvent } from "../ical/parse.js";
import { resolveCalendarIn } from "./calendars.js";
import type { Attendee, Calendar, CalendarEvent, Context, Recurrence, Reminder } from "../types.js";

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
