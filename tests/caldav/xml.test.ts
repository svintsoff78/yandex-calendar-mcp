import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildCalendarQuery,
  buildPropfind,
  parseMultistatus,
  toIcalUtc,
} from "../../src/caldav/xml.js";

const fixture = (name: string) => readFileSync(`tests/fixtures/${name}`, "utf8");

describe("toIcalUtc", () => {
  it("переводит дату в базовый формат iCalendar", () => {
    expect(toIcalUtc(new Date("2026-09-18T07:05:00Z"))).toBe("20260918T070500Z");
  });
});

describe("buildPropfind", () => {
  it("собирает тело с запрошенными свойствами", () => {
    const xml = buildPropfind(["d:displayname", "c:calendar-home-set"]);
    expect(xml).toContain("<d:displayname/>");
    expect(xml).toContain("<c:calendar-home-set/>");
    expect(xml).toContain('xmlns:c="urn:ietf:params:xml:ns:caldav"');
  });
});

describe("buildCalendarQuery", () => {
  it("кладёт окно времени в фильтр VEVENT", () => {
    const xml = buildCalendarQuery(
      new Date("2026-09-01T00:00:00Z"),
      new Date("2026-10-01T00:00:00Z"),
    );
    expect(xml).toContain('name="VEVENT"');
    expect(xml).toContain('start="20260901T000000Z"');
    expect(xml).toContain('end="20261001T000000Z"');
  });
});

describe("parseMultistatus", () => {
  it("разбирает список календарей из настоящего ответа Яндекса", () => {
    const entries = parseMultistatus(fixture("calendars.xml"));
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0].href).toMatch(/^\//);
  });

  it("возвращает principal из ответа на PROPFIND", () => {
    const entries = parseMultistatus(fixture("principal.xml"));
    const principal = entries[0].props["current-user-principal"];
    expect(JSON.stringify(principal)).toContain("href");
  });

  it("сохраняет статус каждого propstat, а не только общий", () => {
    const xml = `<?xml version="1.0"?>
      <d:multistatus xmlns:d="DAV:">
        <d:response>
          <d:href>/calendars/x/</d:href>
          <d:propstat>
            <d:prop><d:displayname>Работа</d:displayname></d:prop>
            <d:status>HTTP/1.1 200 OK</d:status>
          </d:propstat>
          <d:propstat>
            <d:prop><d:getctag/></d:prop>
            <d:status>HTTP/1.1 404 Not Found</d:status>
          </d:propstat>
        </d:response>
      </d:multistatus>`;
    const entries = parseMultistatus(xml);
    expect(entries).toHaveLength(1);
    expect(entries[0].status).toBe(200);
    expect(entries[0].props.displayname).toBe("Работа");
    expect(entries[0].props.getctag).toBeUndefined();
  });

  it("берёт статус из успешного propstat, а не подставляет 200 по умолчанию", () => {
    const xml = `<?xml version="1.0"?>
      <d:multistatus xmlns:d="DAV:">
        <d:response>
          <d:href>/calendars/y/</d:href>
          <d:propstat>
            <d:prop><d:displayname>Личное</d:displayname></d:prop>
            <d:status>HTTP/1.1 201 Created</d:status>
          </d:propstat>
        </d:response>
      </d:multistatus>`;
    const entries = parseMultistatus(xml);
    expect(entries[0].status).toBe(201);
  });
});
