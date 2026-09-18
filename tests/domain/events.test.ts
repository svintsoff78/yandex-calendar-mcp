import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { matchesQuery, readEvent, readEvents } from "../../src/domain/events.js";
import type { Calendar } from "../../src/types.js";
import type { CaldavClient } from "../../src/caldav/request.js";

const weekly = readFileSync("tests/fixtures/weekly.ics", "utf8");
const simple = readFileSync("tests/fixtures/simple.ics", "utf8");

const calendars: Calendar[] = [
  { id: "work", href: "/c/work/", displayName: "Работа", readOnly: false },
];

function contextWith(objects: Array<{ href: string; etag: string; ics: string }>) {
  return {
    client: {} as never,
    config: { defaultTimeZone: "Europe/Moscow" } as never,
    calendars: async () => calendars,
    resolveCalendar: async () => calendars[0],
    query: vi.fn().mockResolvedValue(objects),
  };
}

describe("matchesQuery", () => {
  it("ищет по заголовку, описанию и месту без учёта регистра", () => {
    const event = {
      summary: "Проект «Заря»",
      description: "обсудить смету",
      location: "Дома",
    } as never;

    expect(matchesQuery(event, "заря")).toBe(true);
    expect(matchesQuery(event, "СМЕТУ")).toBe(true);
    expect(matchesQuery(event, "дома")).toBe(true);
    expect(matchesQuery(event, "отпуск")).toBe(false);
  });

  it("пропускает всё, когда запрос пустой", () => {
    expect(matchesQuery({ summary: "что угодно" } as never, undefined)).toBe(true);
  });
});

describe("readEvents", () => {
  it("раскрывает повторы по умолчанию", async () => {
    const context = contextWith([{ href: "/c/work/w.ics", etag: '"1"', ics: weekly }]);

    const events = await readEvents(context as never, {
      from: "2026-10-01T00:00:00+03:00",
      to: "2026-11-30T00:00:00+03:00",
    });

    expect(events).toHaveLength(6);
  });

  it("отдаёт одну запись на серию, когда раскрытие выключено", async () => {
    const context = contextWith([{ href: "/c/work/w.ics", etag: '"1"', ics: weekly }]);

    const events = await readEvents(context as never, {
      from: "2026-10-01T00:00:00+03:00",
      to: "2026-11-30T00:00:00+03:00",
      expandRecurring: false,
    });

    expect(events).toHaveLength(1);
    expect(events[0].recurrence?.frequency).toBe("weekly");
  });

  it("фильтрует по тексту", async () => {
    const context = contextWith([
      { href: "/c/work/w.ics", etag: '"1"', ics: weekly },
      { href: "/c/work/s.ics", etag: '"2"', ics: simple },
    ]);

    const events = await readEvents(context as never, {
      from: "2026-09-01T00:00:00+03:00",
      to: "2026-11-30T00:00:00+03:00",
      query: "первая половина",
    });

    expect(events).toHaveLength(1);
    expect(events[0].summary).toContain("первая половина");
  });

  it("сортирует результат по времени начала", async () => {
    const context = contextWith([
      { href: "/c/work/w.ics", etag: '"1"', ics: weekly },
      { href: "/c/work/s.ics", etag: '"2"', ics: simple },
    ]);

    const events = await readEvents(context as never, {
      from: "2026-09-01T00:00:00+03:00",
      to: "2026-11-30T00:00:00+03:00",
    });

    const times = events.map((event) => new Date(event.start).getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it("бросает ошибку, когда from и to перепутаны местами", async () => {
    const context = contextWith([]);

    await expect(
      readEvents(context as never, {
        from: "2026-11-30T00:00:00+03:00",
        to: "2026-10-01T00:00:00+03:00",
      }),
    ).rejects.toThrow(/раньше конца/);
  });

  it("бросает ошибку на окне нулевой длины (from равен to)", async () => {
    const context = contextWith([]);

    await expect(
      readEvents(context as never, {
        from: "2026-10-01T00:00:00+03:00",
        to: "2026-10-01T00:00:00+03:00",
      }),
    ).rejects.toThrow(/раньше конца/);
  });
});

describe("readEvent", () => {
  // Задача 1 (docs/yandex-caldav-capabilities.md): имя файла объекта на
  // сервере Яндекса не выводится из UID. UID "aaaabbbbccccdddd11@yandex.ru"
  // хранится как объект "aaaabbbbccccdddd11yandex.ru.ics" — собака выброшена,
  // а не закодирована. Поэтому readEvent обязан искать объект REPORT'ом
  // calendar-query по UID (queryEventByUid) и брать href/etag из ответа
  // сервера, а не собирать путь сам через hrefFor. Фикстура ниже намеренно
  // отдаёт от «сервера» href, непохожий на то, что построил бы hrefFor —
  // это отличает верную реализацию от той, что строит путь из UID.
  const uid = "aaaabbbbccccdddd11@yandex.ru";
  const realHref = "/c/work/aaaabbbbccccdddd11yandex.ru.ics";
  const hrefFromUid = `/c/work/${encodeURIComponent(uid)}.ics`;

  function multistatusFor(href: string): string {
    return `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:response>
    <d:href>${href}</d:href>
    <d:propstat><d:prop>
      <d:getetag>1789383239000</d:getetag>
      <c:calendar-data>BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:aaaabbbbccccdddd11@yandex.ru
DTSTAMP:20261001T090000Z
DTSTART;TZID=Europe/Moscow:20261019T100000
DTEND;TZID=Europe/Moscow:20261019T140000
SUMMARY:Событие с собакой в UID
END:VEVENT
END:VCALENDAR</c:calendar-data>
    </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>
</d:multistatus>`;
  }

  function fakeClient(text: string) {
    const request = vi.fn().mockResolvedValue({
      status: 207,
      headers: new Headers(),
      text,
    });
    return { client: { request } as unknown as CaldavClient, request };
  }

  function contextFor(client: CaldavClient) {
    return {
      client,
      config: {} as never,
      calendars: async () => calendars,
      resolveCalendar: async () => calendars[0],
    };
  }

  it("находит событие с собакой в UID по ответу сервера, а не по пути, собранному из UID", async () => {
    const { client } = fakeClient(multistatusFor(realHref));

    const event = await readEvent(contextFor(client) as never, "work", uid);

    // Ключевая проверка: href взят из ответа сервера, а не построен через
    // hrefFor(calendar, uid) — эти два пути для UID с собакой различаются.
    expect(event.href).toBe(realHref);
    expect(event.href).not.toBe(hrefFromUid);
    expect(event.id).toBe(uid);
  });

  it("шлёт REPORT calendar-query по UID, а не GET по собранному пути", async () => {
    const { client, request } = fakeClient(multistatusFor(realHref));

    await readEvent(contextFor(client) as never, "work", uid);

    expect(request.mock.calls[0][0].method).toBe("REPORT");
    expect(request.mock.calls[0][0].path).toBe("/c/work/");
    expect(request.mock.calls[0][0].body).toContain('<c:prop-filter name="UID">');
  });

  it("бросает понятную ошибку, если событие с таким UID не найдено в календаре", async () => {
    const empty = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"></d:multistatus>`;
    const { client } = fakeClient(empty);

    await expect(readEvent(contextFor(client) as never, "work", uid)).rejects.toThrow(
      /не найдено/,
    );
  });
});
