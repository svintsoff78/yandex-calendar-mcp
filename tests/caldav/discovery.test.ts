import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { discoverCalendars } from "../../src/caldav/discovery.js";
import type { CaldavClient } from "../../src/caldav/request.js";

const fixture = (name: string) => readFileSync(`tests/fixtures/${name}`, "utf8");

function clientReturning(...bodies: string[]): CaldavClient {
  const request = vi.fn();
  for (const text of bodies) {
    request.mockResolvedValueOnce({ status: 207, headers: new Headers(), text });
  }
  return { request } as unknown as CaldavClient;
}

describe("discoverCalendars", () => {
  it("проходит цепочку principal → home → календари, отсеивая список задач", async () => {
    const client = clientReturning(
      fixture("principal.xml"),
      fixture("home.xml"),
      fixture("calendars.xml"),
    );

    const calendars = await discoverCalendars(client);

    // В настоящей фикстуре шесть коллекций, из них три календаря
    // (два события + один список задач VTODO). Список задач отфильтрован
    // по supported-calendar-component-set, поэтому остаётся ровно два.
    expect(calendars).toHaveLength(2);
    expect(calendars.map((c) => c.displayName).sort()).toEqual(["Мои события", "Рабочий"]);
    expect(calendars[0].displayName).toBeTruthy();
    expect(calendars[0].href).toMatch(/^\//);
  });

  it("отбрасывает коллекции, не являющиеся календарями", async () => {
    const home = `<?xml version="1.0"?>
      <d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
        <d:response>
          <d:href>/calendars/user/</d:href>
          <d:propstat><d:prop>
            <d:displayname>Корень</d:displayname>
            <d:resourcetype><d:collection/></d:resourcetype>
          </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
        </d:response>
        <d:response>
          <d:href>/calendars/user/work/</d:href>
          <d:propstat><d:prop>
            <d:displayname>Работа</d:displayname>
            <d:resourcetype><d:collection/><c:calendar/></d:resourcetype>
          </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
        </d:response>
      </d:multistatus>`;
    const client = clientReturning(fixture("principal.xml"), fixture("home.xml"), home);

    const calendars = await discoverCalendars(client);

    expect(calendars).toHaveLength(1);
    expect(calendars[0].displayName).toBe("Работа");
  });

  it("помечает календарь только для чтения, если нет привилегии записи", async () => {
    const home = `<?xml version="1.0"?>
      <d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
        <d:response>
          <d:href>/calendars/user/holidays/</d:href>
          <d:propstat><d:prop>
            <d:displayname>Праздники</d:displayname>
            <d:resourcetype><d:collection/><c:calendar/></d:resourcetype>
            <d:current-user-privilege-set>
              <d:privilege><d:read/></d:privilege>
            </d:current-user-privilege-set>
          </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
        </d:response>
      </d:multistatus>`;
    const client = clientReturning(fixture("principal.xml"), fixture("home.xml"), home);

    const calendars = await discoverCalendars(client);

    expect(calendars[0].readOnly).toBe(true);
  });

  it("отсеивает коллекцию, чей supported-calendar-component-set не содержит VEVENT", async () => {
    const home = `<?xml version="1.0"?>
      <d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
        <d:response>
          <d:href>/calendars/user/tasks/</d:href>
          <d:propstat><d:prop>
            <d:displayname>Задачи</d:displayname>
            <d:resourcetype><d:collection/><c:calendar/></d:resourcetype>
            <c:supported-calendar-component-set><c:comp name="VTODO"/></c:supported-calendar-component-set>
          </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
        </d:response>
        <d:response>
          <d:href>/calendars/user/events/</d:href>
          <d:propstat><d:prop>
            <d:displayname>События</d:displayname>
            <d:resourcetype><d:collection/><c:calendar/></d:resourcetype>
            <c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set>
          </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
        </d:response>
      </d:multistatus>`;
    const client = clientReturning(fixture("principal.xml"), fixture("home.xml"), home);

    const calendars = await discoverCalendars(client);

    expect(calendars).toHaveLength(1);
    expect(calendars[0].displayName).toBe("События");
  });
});
