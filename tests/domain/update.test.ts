import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { updateEvent } from "../../src/domain/events.js";
import type { Calendar } from "../../src/types.js";
import type { CaldavClient } from "../../src/caldav/request.js";

const weekly = readFileSync("tests/fixtures/weekly.ics", "utf8");
const simple = readFileSync("tests/fixtures/simple.ics", "utf8");

const calendar: Calendar = {
  id: "work",
  href: "/c/work/",
  displayName: "Работа",
  readOnly: false,
};

function contextWith(ics: string) {
  const put = vi.fn().mockResolvedValue('"etag-new"');
  const get = vi.fn().mockResolvedValue({ href: "/c/work/x.ics", etag: '"etag-old"', ics });
  return {
    context: {
      client: {} as never,
      config: { defaultTimeZone: "Europe/Moscow" } as never,
      calendars: async () => [calendar],
      resolveCalendar: async () => calendar,
      get,
      put,
    },
    put,
    get,
  };
}

describe("updateEvent", () => {
  it("правит всю серию и шлёт If-Match со свежим ETag", async () => {
    const { context, put } = contextWith(weekly);

    await updateEvent(context as never, {
      id: "test-weekly-1",
      scope: "all_series",
      patch: { summary: "Проект «Заря» — новое название" },
    });

    const [, ics, options] = put.mock.calls[0];
    expect(options.ifMatch).toBe('"etag-old"');
    expect(ics).toContain("новое название");
    expect(ics).toContain("RRULE");
  });

  it("не трогает поля, которых нет в патче", async () => {
    const { context, put } = contextWith(simple);

    await updateEvent(context as never, {
      id: "test-simple-1",
      scope: "all_series",
      patch: { location: "Офис" },
    });

    const ics = put.mock.calls[0][1];
    expect(ics).toContain("LOCATION:Офис");
    expect(ics).toContain("первая половина дня");
  });

  it("при scope this добавляет исключение с RECURRENCE-ID", async () => {
    const { context, put } = contextWith(weekly);

    await updateEvent(context as never, {
      id: "test-weekly-1",
      scope: "this",
      instanceStart: "2026-10-21T10:00:00+03:00",
      patch: { summary: "Перенесённая встреча" },
    });

    const ics = put.mock.calls[0][1];
    expect(ics).toContain("RECURRENCE-ID");
    expect(ics).toContain("Перенесённая встреча");
    expect(ics).toContain("RRULE");
  });

  it("требует instanceStart при scope this", async () => {
    const { context } = contextWith(weekly);

    await expect(
      updateEvent(context as never, {
        id: "test-weekly-1",
        scope: "this",
        patch: { summary: "Без экземпляра" },
      }),
    ).rejects.toThrow(/instanceStart/);
  });

  it("при scope this_and_following обрезает серию и создаёт новую", async () => {
    const { context, put } = contextWith(weekly);

    await updateEvent(context as never, {
      id: "test-weekly-1",
      scope: "this_and_following",
      instanceStart: "2026-11-02T10:00:00+03:00",
      patch: { summary: "Новая часть серии" },
    });

    expect(put).toHaveBeenCalledTimes(2);
    expect(put.mock.calls[0][1]).toContain("UNTIL=");
    expect(put.mock.calls[1][1]).toContain("Новая часть серии");
    expect(put.mock.calls[1][2].ifNoneMatch).toBe(true);
  });

  it("по умолчанию использует scope this, а не всю серию", async () => {
    const { context, put } = contextWith(weekly);

    await updateEvent(context as never, {
      id: "test-weekly-1",
      instanceStart: "2026-10-21T10:00:00+03:00",
      patch: { summary: "Только этот" },
    });

    expect(put.mock.calls[0][1]).toContain("RECURRENCE-ID");
  });

  // ---------------------------------------------------------------------
  // Дополнительные тесты, требуемые диспетчером задачи 13 сверх брифа.
  // ---------------------------------------------------------------------

  describe("путь к объекту берётся от сервера, а не собирается из UID", () => {
    // Задача 1 (docs/yandex-caldav-capabilities.md): имя файла объекта на
    // сервере Яндекса не выводится из UID. UID "aaaabbbbccccdddd11@yandex.ru"
    // хранится как объект "aaaabbbbccccdddd11yandex.ru.ics" — собака
    // выброшена, а не закодирована. Этот тест НЕ подставляет context.get —
    // он идёт через настоящий getFor→queryEventByUid поверх фиктивного
    // CaldavClient, поэтому падает на реализации, которая находит объект по
    // hrefFor(calendar, uid) (как было в брифе), а не по ответу сервера.
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

    // Один и тот же фиктивный ответ на любой request(): для REPORT (поиск по
    // UID) отдаёт multistatus с событием, для последующего PUT — тот же
    // текст не важен, важен только путь (request.mock.calls[...][0].path).
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
        config: { defaultTimeZone: "Europe/Moscow" } as never,
        calendars: async () => [calendar],
        resolveCalendar: async () => calendar,
      };
    }

    it("находит событие по ответу сервера и пишет по этому пути, а не по hrefFor(calendar, uid)", async () => {
      const { client, request } = fakeClient(multistatusFor(realHref));

      await updateEvent(contextFor(client) as never, {
        id: uid,
        patch: { summary: "Новое название" },
      });

      expect(request.mock.calls[0][0].method).toBe("REPORT");
      expect(request.mock.calls[0][0].path).toBe("/c/work/");
      expect(request.mock.calls[0][0].body).toContain('<c:prop-filter name="UID">');

      const putCall = request.mock.calls.find((call) => call[0].method === "PUT");
      expect(putCall).toBeDefined();
      // Ключевая проверка: путь записи взят из ответа сервера, а не построен
      // через hrefFor(calendar, uid) — эти два пути для UID с собакой
      // различаются.
      expect(putCall![0].path).toBe(realHref);
      expect(putCall![0].path).not.toBe(hrefFromUid);
    });

    it("бросает понятную ошибку, если событие с таким UID не найдено", async () => {
      const empty = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"></d:multistatus>`;
      const { client } = fakeClient(empty);

      await expect(
        updateEvent(contextFor(client) as never, {
          id: uid,
          patch: { summary: "Не найдётся" },
        }),
      ).rejects.toThrow(/не найдено/);
    });
  });

  it("распространяет отказ 412 (конфликт ETag) наружу, а не подавляет его", async () => {
    const { context, put } = contextWith(simple);
    put.mockRejectedValueOnce(
      new Error(
        "Событие изменили после того, как мы его прочитали. Перечитайте событие и повторите операцию.",
      ),
    );

    await expect(
      updateEvent(context as never, {
        id: "test-simple-1",
        scope: "all_series",
        patch: { summary: "Не долетит" },
      }),
    ).rejects.toThrow(/изменили/);
  });

  it("отказывает понятной ошибкой, если instanceStart не совпадает ни с одним экземпляром серии", async () => {
    const { context } = contextWith(weekly);

    // Вторник — в BYDAY=MO,WE вторников не бывает, значит такого экземпляра
    // в серии нет ни на одной неделе.
    await expect(
      updateEvent(context as never, {
        id: "test-weekly-1",
        scope: "this",
        instanceStart: "2026-10-20T10:00:00+03:00",
        patch: { summary: "Мимо экземпляра" },
      }),
    ).rejects.toThrow(/экземпляр/i);
  });

  it("при scope this_and_following пересчитывает COUNT новой серии, не превышая исходный", async () => {
    const { context, put } = contextWith(weekly);

    // weekly.ics: WEEKLY;BYDAY=MO,WE;COUNT=6 от 2026-10-19 (Пн) даёт
    // экземпляры 19,21,26,28 октября и 2,4 ноября. instanceStart=2 ноября —
    // пятый из шести, до него остаётся 4 уже прожитых экземпляра.
    await updateEvent(context as never, {
      id: "test-weekly-1",
      scope: "this_and_following",
      instanceStart: "2026-11-02T10:00:00+03:00",
      patch: { summary: "Хвост серии" },
    });

    // Если бы COUNT перенёсся в новую серию без изменений (было бы COUNT=6),
    // общее число повторов (4 в усечённой исходной + 6 в новой) превысило бы
    // исходные 6 — новая серия обязана унести только ОСТАВШИЕСЯ 6-4=2.
    expect(put.mock.calls[1][1]).toContain("COUNT=2");
    expect(put.mock.calls[1][1]).not.toContain("COUNT=6");
  });

  it("при scope this_and_following переносит напоминания и участников в новую серию", async () => {
    const withExtras = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:test-weekly-extras-1
DTSTAMP:20261001T090000Z
DTSTART;TZID=Europe/Moscow:20261019T100000
DTEND;TZID=Europe/Moscow:20261019T140000
RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,WE;COUNT=6
SUMMARY:Проект «Заря»
ATTENDEE;PARTSTAT=ACCEPTED:mailto:user@yandex.ru
BEGIN:VALARM
ACTION:DISPLAY
TRIGGER:-PT15M
DESCRIPTION:Напоминание
END:VALARM
END:VEVENT
END:VCALENDAR`;
    const { context, put } = contextWith(withExtras);

    await updateEvent(context as never, {
      id: "test-weekly-extras-1",
      scope: "this_and_following",
      instanceStart: "2026-11-02T10:00:00+03:00",
      patch: { summary: "Хвост с допами" },
    });

    const continuationIcs = put.mock.calls[1][1];
    expect(continuationIcs).toContain("BEGIN:VALARM");
    expect(continuationIcs).toContain("ATTENDEE");
    expect(continuationIcs).toContain("user@yandex.ru");
  });

  it("отказывается писать в календарь только для чтения", async () => {
    const readOnly = { ...calendar, readOnly: true };
    const { context } = contextWith(weekly);
    context.resolveCalendar = async () => readOnly;

    await expect(
      updateEvent(context as never, {
        id: "test-weekly-1",
        scope: "all_series",
        patch: { summary: "Не пройдёт" },
      }),
    ).rejects.toThrow(/только для чтения/);
  });

  it("не теряет etag при повторной правке того же события подряд", async () => {
    const { context, put, get } = contextWith(simple);
    // Второй вызов get() имитирует то, что сервер вернул уже ОБНОВЛЁННЫЙ
    // etag после первой правки — это то, что произошло бы в реальности,
    // так как getFor всегда запрашивает объект заново, а не переиспользует
    // старый снимок.
    get.mockResolvedValueOnce({ href: "/c/work/x.ics", etag: '"etag-1"', ics: simple });
    get.mockResolvedValueOnce({ href: "/c/work/x.ics", etag: '"etag-2"', ics: simple });

    await updateEvent(context as never, {
      id: "test-simple-1",
      scope: "all_series",
      patch: { summary: "Первая правка" },
    });
    await updateEvent(context as never, {
      id: "test-simple-1",
      scope: "all_series",
      patch: { summary: "Вторая правка" },
    });

    expect(put.mock.calls[0][2].ifMatch).toBe('"etag-1"');
    expect(put.mock.calls[1][2].ifMatch).toBe('"etag-2"');
  });

  // -----------------------------------------------------------------------
  // Регрессионные тесты по ревью задачи 13 (круг 1): две находки Critical
  // и одна Important.
  // -----------------------------------------------------------------------

  // Объект с master-компонентом (RRULE) и уже существующим переопределением
  // экземпляра (RECURRENCE-ID) — например, ранее правленным через scope
  // "this". Используется находками 1 и 2 ниже.
  const weeklyWithOverride = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:test-weekly-override-1
DTSTAMP:20261001T090000Z
DTSTART;TZID=Europe/Moscow:20261019T100000
DTEND;TZID=Europe/Moscow:20261019T140000
RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,WE;COUNT=6
SUMMARY:Проект «Заря»
END:VEVENT
BEGIN:VEVENT
UID:test-weekly-override-1
RECURRENCE-ID;TZID=Europe/Moscow:20261021T100000
DTSTAMP:20261001T090000Z
DTSTART;TZID=Europe/Moscow:20261021T113000
DTEND;TZID=Europe/Moscow:20261021T150000
SUMMARY:Перенесённая среда
END:VEVENT
END:VCALENDAR`;

  it("НАХОДКА 1: all_series сохраняет уже существующее переопределение экземпляра", async () => {
    const { context, put } = contextWith(weeklyWithOverride);

    await updateEvent(context as never, {
      id: "test-weekly-override-1",
      scope: "all_series",
      patch: { summary: "Новое общее название" },
    });

    const ics = put.mock.calls[0][1];
    // Переопределение не пропало (было потеряно при пересборке через
    // buildEvent, у которой в календаре всегда ровно один VEVENT).
    expect(ics).toContain("RECURRENCE-ID");
    expect(ics).toContain("Перенесённая среда");
    // При этом master действительно поправлен.
    expect(ics).toContain("Новое общее название");
    expect(ics).toContain("RRULE");
  });

  it("НАХОДКА 1: this_and_following сохраняет переопределение при усечении исходной серии", async () => {
    // Переопределение стоит на 21 октября — раньше instanceStart (2 ноября),
    // то есть попадает в «хвост», который остаётся у исходной серии после
    // усечения. Усечение не должно его терять.
    const { context, put } = contextWith(weeklyWithOverride);

    await updateEvent(context as never, {
      id: "test-weekly-override-1",
      scope: "this_and_following",
      instanceStart: "2026-11-02T10:00:00+03:00",
      patch: { summary: "Хвост серии" },
    });

    const truncatedIcs = put.mock.calls[0][1];
    expect(truncatedIcs).toContain("UNTIL=");
    expect(truncatedIcs).toContain("RECURRENCE-ID");
    expect(truncatedIcs).toContain("Перенесённая среда");
  });

  it("НАХОДКА 2: scope this идемпотентен — повторная правка того же экземпляра не копит дубликаты RECURRENCE-ID", async () => {
    const put = vi.fn().mockResolvedValue('"etag-new"');
    const get = vi.fn();
    get.mockResolvedValueOnce({ href: "/c/work/x.ics", etag: '"etag-1"', ics: weekly });
    const context = {
      client: {} as never,
      config: { defaultTimeZone: "Europe/Moscow" } as never,
      calendars: async () => [calendar],
      resolveCalendar: async () => calendar,
      get,
      put,
    };

    await updateEvent(context as never, {
      id: "test-weekly-1",
      scope: "this",
      instanceStart: "2026-10-21T10:00:00+03:00",
      patch: { summary: "Первая правка экземпляра" },
    });

    // Второй вызов get() отдаёт РЕЗУЛЬТАТ первой записи — именно то, что
    // реально вернул бы сервер при повторном чтении после первой правки.
    const firstResultIcs = put.mock.calls[0][1];
    get.mockResolvedValueOnce({ href: "/c/work/x.ics", etag: '"etag-2"', ics: firstResultIcs });

    await updateEvent(context as never, {
      id: "test-weekly-1",
      scope: "this",
      instanceStart: "2026-10-21T10:00:00+03:00",
      patch: { summary: "Вторая правка того же экземпляра" },
    });

    const secondResultIcs = put.mock.calls[1][1];
    const overrideCount = (secondResultIcs.match(/RECURRENCE-ID/g) ?? []).length;
    expect(overrideCount).toBe(1);
    expect(secondResultIcs).toContain("Вторая правка того же экземпляра");
    expect(secondResultIcs).not.toContain("Первая правка экземпляра");
  });

  it("НАХОДКА 3: this_and_following называет усечение серии и не созданную новую часть при отказе второй записи", async () => {
    const { context, put } = contextWith(weekly);
    put.mockResolvedValueOnce('"etag-truncated"'); // первая запись (усечение) — успех
    const serverError = new Error("Сервер календаря ответил кодом 500.");
    put.mockRejectedValueOnce(serverError); // вторая (новая серия) — отказ

    expect.assertions(5);
    try {
      await updateEvent(context as never, {
        id: "test-weekly-1",
        scope: "this_and_following",
        instanceStart: "2026-11-02T10:00:00+03:00",
        patch: { summary: "Хвост серии" },
      });
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/усечен/i);
      expect((error as Error).message).toMatch(/не создан/i);
      // Исходная ошибка сохранена как причина, а не потеряна.
      expect((error as Error).cause).toBe(serverError);
    }
    // Обе записи реально были предприняты (первая прошла, вторая отказала) —
    // отказ во второй не должен помешать первой попытке случиться.
    expect(put).toHaveBeenCalledTimes(2);
  });
});
