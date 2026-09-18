import type { CaldavClient } from "./request.js";
import { buildCalendarQuery, buildUidQuery, parseMultistatus, type MultistatusEntry } from "./xml.js";

export interface RawObject {
  href: string;
  etag: string;
  ics: string;
}

// ETag у Яндекса приходит голым числом без кавычек (например,
// "1789383239000") — берём значение как есть, ничего не добавляя и не
// снимая. Пустой ETag в ответе — нормальный случай: часть серверов его
// не присылает.
function toRawObject(entry: MultistatusEntry): RawObject {
  return {
    href: entry.href,
    etag: String(entry.props.getetag ?? ""),
    ics: String(entry.props["calendar-data"]),
  };
}

export async function queryEvents(
  client: CaldavClient,
  calendarHref: string,
  from: Date,
  to: Date,
): Promise<RawObject[]> {
  const response = await client.request({
    method: "REPORT",
    path: calendarHref,
    depth: "1",
    body: buildCalendarQuery(from, to),
  });

  return parseMultistatus(response.text)
    .filter((entry) => typeof entry.props["calendar-data"] === "string")
    .map(toRawObject);
}

// RFC 5545 §3.1: если строка длиннее 75 октетов, её можно перенести —
// продолжение начинается с одного пробела или таба, который при разборе
// убирается, а хвост склеивается с предыдущей строкой. XML-парсер уже
// нормализует "\r\n" в "\n" (calendar-data приходит внутри XML-текста), но
// сырой ICS с GET может нести "\r\n", поэтому убираем оба варианта.
function unfoldIcs(ics: string): string {
  return ics.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "");
}

// Достаёт значение свойства UID из текста ICS без полного разбора
// iCalendar: слой CalDAV не должен зависеть от слоя iCalendar (ical.js).
// Имя свойства регистронезависимо (RFC 5545), значение — нет. unfoldIcs
// уже снял ровно один служебный пробел продолжения (RFC 5545 §3.1) — сверх
// этого значение не нормализуется: краевые пробелы в UID значимы, и
// сравнение с запрошенным UID должно быть побайтовым.
function extractUid(ics: string): string | undefined {
  return /^UID(?:;[^:\n]*)?:(.*)$/im.exec(unfoldIcs(ics))?.[1];
}

// Имя файла объекта не выводится из UID (docs/yandex-caldav-capabilities.md):
// "aaaabbbbccccdddd11@yandex.ru" на сервере лежит как
// "aaaabbbbccccdddd11yandex.ru.ics". Для чужих событий восстановить путь по
// UID нельзя — его находят REPORT calendar-query с фильтром по UID, а href
// берут из ответа сервера, а не собирают из UID.
//
// Серверный <c:text-match> — подстроковое сравнение (RFC 4791 §9.7.5:
// "substring match"), collation="i;octet" управляет только регистром, а не
// гранулярностью совпадения. Точного совпадения UID он не гарантирует,
// поэтому здесь сверяем настоящий UID из calendar-data с запрошенным и
// отбрасываем всё, что совпало лишь частично.
export async function queryEventByUid(
  client: CaldavClient,
  calendarHref: string,
  uid: string,
): Promise<RawObject | undefined> {
  const response = await client.request({
    method: "REPORT",
    path: calendarHref,
    depth: "1",
    body: buildUidQuery(uid),
  });

  const matches = parseMultistatus(response.text)
    .filter((entry) => typeof entry.props["calendar-data"] === "string")
    .map(toRawObject)
    .filter((object) => extractUid(object.ics) === uid);

  // Несколько объектов с одним и тем же UID в одном календаре — это уже
  // ошибка данных на сервере, а не нормальный случай. Результат этой
  // функции используется для правки и удаления событий, поэтому тихо
  // выбирать один из нескольких недопустимо — это может стереть чужое
  // событие.
  if (matches.length > 1) {
    throw new Error(
      `По UID «${uid}» на сервере нашлось ${matches.length} объектов вместо одного — выбрать между ними безопасно нельзя.`,
    );
  }

  return matches[0];
}

export async function getObject(client: CaldavClient, href: string): Promise<RawObject> {
  const response = await client.request({ method: "GET", path: href });
  return {
    href,
    etag: response.headers.get("etag") ?? "",
    ics: response.text,
  };
}

export async function putObject(
  client: CaldavClient,
  href: string,
  ics: string,
  options: { ifMatch?: string; ifNoneMatch?: boolean },
): Promise<string> {
  const headers: Record<string, string> = {
    "Content-Type": "text/calendar; charset=utf-8",
  };
  if (options.ifNoneMatch) headers["If-None-Match"] = "*";
  if (options.ifMatch) headers["If-Match"] = options.ifMatch;

  const response = await client.request({ method: "PUT", path: href, body: ics, headers });
  return response.headers.get("etag") ?? "";
}

export async function deleteObject(
  client: CaldavClient,
  href: string,
  etag?: string,
): Promise<void> {
  const headers: Record<string, string> = {};
  if (etag) headers["If-Match"] = etag;
  await client.request({ method: "DELETE", path: href, headers });
}
