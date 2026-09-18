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

// Имя файла объекта не выводится из UID (docs/yandex-caldav-capabilities.md):
// "aaaabbbbccccdddd11@yandex.ru" на сервере лежит как
// "aaaabbbbccccdddd11yandex.ru.ics". Для чужих событий восстановить путь по
// UID нельзя — его находят REPORT calendar-query с фильтром по UID, а href
// берут из ответа сервера, а не собирают из UID.
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

  const [entry] = parseMultistatus(response.text).filter(
    (entry) => typeof entry.props["calendar-data"] === "string",
  );
  return entry ? toRawObject(entry) : undefined;
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
