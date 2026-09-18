import type { CaldavClient } from "./request.js";
import { buildPropfind, parseMultistatus } from "./xml.js";
import type { Calendar } from "../types.js";

function firstHref(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") return value;
  const record = value as Record<string, unknown>;
  if (typeof record.href === "string") return record.href;
  if (Array.isArray(record.href) && typeof record.href[0] === "string") return record.href[0];
  return undefined;
}

export async function resolvePrincipal(client: CaldavClient): Promise<string> {
  const response = await client.request({
    method: "PROPFIND",
    path: "/",
    depth: "0",
    body: buildPropfind(["d:current-user-principal"]),
  });
  const href = firstHref(parseMultistatus(response.text)[0]?.props["current-user-principal"]);
  if (!href) throw new Error("Сервер не вернул principal — проверьте логин и пароль приложения.");
  return href;
}

export async function resolveHome(client: CaldavClient): Promise<string> {
  const principal = await resolvePrincipal(client);
  const response = await client.request({
    method: "PROPFIND",
    path: principal,
    depth: "0",
    body: buildPropfind(["c:calendar-home-set"]),
  });
  const href = firstHref(parseMultistatus(response.text)[0]?.props["calendar-home-set"]);
  if (!href) throw new Error("Сервер не вернул дом календарей.");
  return href;
}

function isCalendar(resourcetype: unknown): boolean {
  return resourcetype != null && typeof resourcetype === "object" && "calendar" in resourcetype;
}

// Разбирает <d:privilege> в список имён привилегий. После снятия префиксов
// пространств имён каждая привилегия — это объект с одним ключом-именем
// (например { write: "" } или { "write-acl": "" }); одна привилегия придёт
// объектом, несколько — массивом, как и comp в supportsVevent.
function privilegeNames(privilegeSet: unknown): string[] {
  if (privilegeSet == null || typeof privilegeSet !== "object") return [];
  const record = privilegeSet as Record<string, unknown>;
  const list = Array.isArray(record.privilege)
    ? record.privilege
    : record.privilege != null
      ? [record.privilege]
      : [];
  return list.flatMap((item) =>
    item != null && typeof item === "object" ? Object.keys(item as Record<string, unknown>) : [],
  );
}

// RFC 3744 различает write-properties, write-content и write-acl. Только
// write (целиком) и write-content дают право писать содержимое событий;
// write-acl — это право менять список доступа, а не события, и текстовый
// поиск подстроки "write" ошибочно принял бы его за право на запись.
function isWritable(privileges: unknown): boolean {
  if (privileges == null) return true;
  const names = privilegeNames(privileges);
  return names.includes("write") || names.includes("write-content");
}

// Яндекс держит в доме календарей не только коллекции событий: там же лежит
// список задач (VTODO). Внешне это такой же <c:calendar/>, поэтому отличить
// его можно только по supported-calendar-component-set. Отсутствие этого
// свойства в ответе не повод отфильтровывать календарь — Яндекс присылает
// его не для всех коллекций.
function supportsVevent(componentSet: unknown): boolean {
  if (componentSet == null || typeof componentSet !== "object") return true;
  const record = componentSet as Record<string, unknown>;
  const comps = Array.isArray(record.comp) ? record.comp : record.comp != null ? [record.comp] : [];
  if (comps.length === 0) return true;
  return comps.some((comp) => {
    if (comp != null && typeof comp === "object") {
      return (comp as Record<string, unknown>)["@name"] === "VEVENT";
    }
    return false;
  });
}

// xml.ts больше не вычищает свойства с пустым значением (задача 4), поэтому
// пустой <d:displayname></d:displayname> приходит как "", а не отсутствует.
// "??" пропускает пустую строку, значит подстановку по умолчанию нужно
// делать явно — в том числе для строки из одних пробелов.
function displayNameOrFallback(value: unknown): string {
  const text = value == null ? "" : String(value);
  return text.trim().length > 0 ? text : "Без названия";
}

export async function discoverCalendars(client: CaldavClient): Promise<Calendar[]> {
  const home = await resolveHome(client);
  const response = await client.request({
    method: "PROPFIND",
    path: home,
    depth: "1",
    body: buildPropfind([
      "d:displayname",
      "d:resourcetype",
      "d:current-user-privilege-set",
      "c:calendar-timezone",
      "c:supported-calendar-component-set",
      "ic:calendar-color",
    ]),
  });

  return parseMultistatus(response.text)
    .filter((entry) => isCalendar(entry.props.resourcetype))
    .filter((entry) => supportsVevent(entry.props["supported-calendar-component-set"]))
    .map((entry) => ({
      id: decodeURIComponent(entry.href.replace(/\/$/, "").split("/").pop() ?? entry.href),
      href: entry.href,
      displayName: displayNameOrFallback(entry.props.displayname),
      color: entry.props["calendar-color"] ? String(entry.props["calendar-color"]) : undefined,
      timeZone: entry.props["calendar-timezone"]
        ? String(entry.props["calendar-timezone"])
        : undefined,
      readOnly: !isWritable(entry.props["current-user-privilege-set"]),
    }));
}
