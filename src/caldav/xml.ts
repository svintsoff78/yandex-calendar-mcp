import { XMLParser } from "fast-xml-parser";

const NS =
  'xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:ic="http://apple.com/ns/ical/"';

export function toIcalUtc(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

export function buildPropfind(props: string[]): string {
  const body = props.map((name) => `<${name}/>`).join("");
  return `<?xml version="1.0" encoding="utf-8"?>
<d:propfind ${NS}><d:prop>${body}</d:prop></d:propfind>`;
}

export function buildCalendarQuery(from: Date, to: Date): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query ${NS}>
  <d:prop><d:getetag/><c:calendar-data/></d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT">
        <c:time-range start="${toIcalUtc(from)}" end="${toIcalUtc(to)}"/>
      </c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`;
}

function escapeXmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Яндекс не выводит имя файла объекта из UID (задача 1, docs/yandex-caldav-capabilities.md):
// "aaaabbbbccccdddd11@yandex.ru" на сервере лежит как
// "aaaabbbbccccdddd11yandex.ru.ics" — собака выброшена, а не закодирована.
// Поэтому для события, созданного не нами, путь нельзя восстановить из UID —
// его находят этим запросом (RFC 4791 §7.8) и берут href из ответа.
// UID экранируется как текст XML: он может содержать "&", "<", ">".
export function buildUidQuery(uid: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query ${NS}>
  <d:prop><d:getetag/><c:calendar-data/></d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT">
        <c:prop-filter name="UID">
          <c:text-match collation="i;octet">${escapeXmlText(uid)}</c:text-match>
        </c:prop-filter>
      </c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`;
}

export interface MultistatusEntry {
  href: string;
  status: number;
  props: Record<string, unknown>;
}

const parser = new XMLParser({
  removeNSPrefix: true,
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  parseTagValue: false,
});

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function statusCode(text: unknown): number {
  const match = /\s(\d{3})\s/.exec(` ${String(text)} `);
  return match ? Number(match[1]) : 0;
}

export function parseMultistatus(xml: string): MultistatusEntry[] {
  const parsed = parser.parse(xml) as Record<string, any>;
  const responses = asArray(parsed?.multistatus?.response);

  return responses.map((response) => {
    const props: Record<string, unknown> = {};
    let entryStatus = 200;

    for (const propstat of asArray(response.propstat)) {
      const code = statusCode(propstat.status);
      if (code >= 400) continue;
      entryStatus = code || entryStatus;
      Object.assign(props, propstat.prop ?? {});
    }

    return { href: String(response.href ?? ""), status: entryStatus, props };
  });
}
