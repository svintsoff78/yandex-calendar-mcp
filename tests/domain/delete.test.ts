import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { deleteEvent } from "../../src/domain/events.js";
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
  const remove = vi.fn().mockResolvedValue(undefined);
  const get = vi.fn().mockResolvedValue({ href: "/c/work/x.ics", etag: '"etag-old"', ics });
  return {
    context: {
      client: {} as never,
      config: { defaultTimeZone: "Europe/Moscow" } as never,
      calendars: async () => [calendar],
      resolveCalendar: async () => calendar,
      get,
      put,
      remove,
    },
    put,
    remove,
    get,
  };
}

describe("deleteEvent", () => {
  it("удаляет одиночное событие целиком", async () => {
    const { context, remove } = contextWith(simple);

    const result = await deleteEvent(context as never, { id: "test-simple-1" });

    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove.mock.calls[0][1]).toBe('"etag-old"');
    expect(result).toEqual({ deleted: "test-simple-1", scope: "all_series" });
  });

  it("при явном scope all_series на одиночном событии удаляет ровно его, а не что-то ещё", async () => {
    // Самопроверка диспетчера: у одиночного события явный all_series не
    // должен вести себя иначе, чем умолчание, — удаляется тот же (и
    // единственный) объект, что нашёл getFor, без побочного PUT.
    const { context, remove, put } = contextWith(simple);

    await deleteEvent(context as never, { id: "test-simple-1", scope: "all_series" });

    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove.mock.calls[0][0]).toBe("/c/work/x.ics");
    expect(put).not.toHaveBeenCalled();
  });

  it("при scope this добавляет EXDATE вместо удаления объекта", async () => {
    const { context, put, remove } = contextWith(weekly);

    await deleteEvent(context as never, {
      id: "test-weekly-1",
      scope: "this",
      instanceStart: "2026-10-21T10:00:00+03:00",
    });

    expect(remove).not.toHaveBeenCalled();
    expect(put.mock.calls[0][1]).toContain("EXDATE");
    expect(put.mock.calls[0][1]).toContain("RRULE");
    expect(put.mock.calls[0][2].ifMatch).toBe('"etag-old"');
  });

  it("EXDATE несёт тот же TZID, что и DTSTART серии", async () => {
    // Без явного параметра TZID ical.js молча пишет EXDATE floating-временем
    // без зоны (проверено отдельно на живом ical.js: addPropertyWithValue
    // сериализует "EXDATE:20261021T100000" без TZID, если TZID не выставлен
    // явно через setParameter) — сервер и другие клиенты не смогут надёжно
    // сопоставить исключение с экземпляром в его настоящем часовом поясе.
    // RFC 5545 §3.8.5.1 требует совпадения представления EXDATE и DTSTART —
    // тот же приём, что уже применён к RECURRENCE-ID в updateEvent.
    const { context, put } = contextWith(weekly);

    await deleteEvent(context as never, {
      id: "test-weekly-1",
      scope: "this",
      instanceStart: "2026-10-21T10:00:00+03:00",
    });

    expect(put.mock.calls[0][1]).toContain("EXDATE;TZID=Europe/Moscow:");
  });

  it("при scope all_series удаляет объект", async () => {
    const { context, remove } = contextWith(weekly);

    const result = await deleteEvent(context as never, { id: "test-weekly-1", scope: "all_series" });

    expect(remove).toHaveBeenCalledTimes(1);
    expect(result.scope).toBe("all_series");
  });

  it("по умолчанию у серии удаляет только названный экземпляр, а не всю серию", async () => {
    const { context, put, remove } = contextWith(weekly);

    await deleteEvent(context as never, {
      id: "test-weekly-1",
      instanceStart: "2026-10-21T10:00:00+03:00",
    });

    expect(remove).not.toHaveBeenCalled();
    expect(put.mock.calls[0][1]).toContain("EXDATE");
  });

  it("при scope this_and_following обрезает серию через UNTIL, не создавая новый объект", async () => {
    const { context, put, remove } = contextWith(weekly);

    await deleteEvent(context as never, {
      id: "test-weekly-1",
      scope: "this_and_following",
      instanceStart: "2026-11-02T10:00:00+03:00",
    });

    expect(remove).not.toHaveBeenCalled();
    // В отличие от updateEvent, удаление "хвоста" серии не создаёт новую
    // серию — только один PUT, обрезающий исходный объект.
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0][1]).toContain("UNTIL=");
    expect(put.mock.calls[0][1]).not.toContain("COUNT=");
    expect(put.mock.calls[0][2].ifMatch).toBe('"etag-old"');
  });

  it("при scope this_and_following сохраняет уже существующие EXDATE серии", async () => {
    // Серия уже несёт EXDATE на 21 октября (например, добавленный раньше
    // отдельным удалением scope: this). Обрезка хвоста через
    // this_and_following не должна «воскрешать» этот экземпляр, потеряв
    // EXDATE при пересборке события с нуля.
    const withExdate = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:test-weekly-1
DTSTAMP:20261001T090000Z
DTSTART;TZID=Europe/Moscow:20261019T100000
DTEND;TZID=Europe/Moscow:20261019T140000
RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,WE;COUNT=6
EXDATE;TZID=Europe/Moscow:20261021T100000
SUMMARY:Проект «Заря»
END:VEVENT
END:VCALENDAR`;
    const { context, put } = contextWith(withExdate);

    await deleteEvent(context as never, {
      id: "test-weekly-1",
      scope: "this_and_following",
      instanceStart: "2026-11-02T10:00:00+03:00",
    });

    expect(put.mock.calls[0][1]).toContain("EXDATE;TZID=Europe/Moscow:20261021T100000");
  });

  it("требует instanceStart для частичного удаления серии (scope this)", async () => {
    const { context } = contextWith(weekly);

    await expect(
      deleteEvent(context as never, { id: "test-weekly-1", scope: "this" }),
    ).rejects.toThrow(/instanceStart/);
  });

  it("требует instanceStart для частичного удаления серии (scope this_and_following)", async () => {
    const { context } = contextWith(weekly);

    await expect(
      deleteEvent(context as never, { id: "test-weekly-1", scope: "this_and_following" }),
    ).rejects.toThrow(/instanceStart/);
  });

  it("отказывает понятной ошибкой, если instanceStart не совпадает ни с одним экземпляром серии", async () => {
    const { context } = contextWith(weekly);

    // Вторник — в BYDAY=MO,WE вторников не бывает, значит такого экземпляра
    // в серии нет ни на одной неделе. Без проверки это тихо добавило бы
    // бесполезный EXDATE «в пустоту»: операция выглядела бы успешной, ничего
    // не удалив.
    await expect(
      deleteEvent(context as never, {
        id: "test-weekly-1",
        scope: "this",
        instanceStart: "2026-10-20T10:00:00+03:00",
      }),
    ).rejects.toThrow(/экземпляр/i);
  });

  it("удаление последнего оставшегося экземпляра серии через this не удаляет объект", async () => {
    // COUNT=1 — единственный экземпляр серии. scope "this" всё равно только
    // добавляет EXDATE: серия остаётся объектом в календаре (пустой,
    // больше ничего не порождающей), а не пропадает целиком, — потому что
    // пользователь просил удалить экземпляр, а не серию.
    const single = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:test-weekly-single-1
DTSTAMP:20261001T090000Z
DTSTART;TZID=Europe/Moscow:20261019T100000
DTEND;TZID=Europe/Moscow:20261019T140000
RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO;COUNT=1
SUMMARY:Единственный раз
END:VEVENT
END:VCALENDAR`;
    const { context, put, remove } = contextWith(single);

    await deleteEvent(context as never, {
      id: "test-weekly-single-1",
      scope: "this",
      instanceStart: "2026-10-19T10:00:00+03:00",
    });

    expect(remove).not.toHaveBeenCalled();
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0][1]).toContain("EXDATE");
    expect(put.mock.calls[0][1]).toContain("RRULE");
  });

  it("распространяет отказ 412 (конфликт ETag) наружу при удалении объекта целиком", async () => {
    const { context, remove } = contextWith(simple);
    remove.mockRejectedValueOnce(
      new Error(
        "Событие изменили после того, как мы его прочитали. Перечитайте событие и повторите операцию.",
      ),
    );

    await expect(deleteEvent(context as never, { id: "test-simple-1" })).rejects.toThrow(
      /изменили/,
    );
  });

  it("распространяет отказ 412 наружу при частичном удалении серии", async () => {
    const { context, put } = contextWith(weekly);
    put.mockRejectedValueOnce(
      new Error("Событие изменили после того, как мы его прочитали."),
    );

    await expect(
      deleteEvent(context as never, {
        id: "test-weekly-1",
        scope: "this",
        instanceStart: "2026-10-21T10:00:00+03:00",
      }),
    ).rejects.toThrow(/изменили/);
  });

  it("отказывается удалять из календаря только для чтения, не трогая сеть", async () => {
    const readOnly = { ...calendar, readOnly: true };
    const { context, remove, put, get } = contextWith(simple);
    context.resolveCalendar = async () => readOnly;

    await expect(deleteEvent(context as never, { id: "test-simple-1" })).rejects.toThrow(
      /только для чтения/,
    );
    expect(get).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  describe("путь к объекту берётся от сервера, а не собирается из UID", () => {
    // Тот же приём, что и в tests/domain/update.test.ts (задача 13): не
    // подставляем context.get/context.remove — идём через настоящие
    // getFor→queryEventByUid и removeFor→deleteObject поверх фиктивного
    // CaldavClient. Падает, если реализация находит/удаляет объект по
    // hrefFor(calendar, uid), а не по href из ответа сервера.
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
        config: { defaultTimeZone: "Europe/Moscow" } as never,
        calendars: async () => [calendar],
        resolveCalendar: async () => calendar,
      };
    }

    it("находит событие по ответу сервера и шлёт DELETE по этому пути, а не по hrefFor(calendar, uid)", async () => {
      const { client, request } = fakeClient(multistatusFor(realHref));

      await deleteEvent(contextFor(client) as never, { id: uid });

      expect(request.mock.calls[0][0].method).toBe("REPORT");
      expect(request.mock.calls[0][0].path).toBe("/c/work/");
      expect(request.mock.calls[0][0].body).toContain('<c:prop-filter name="UID">');

      const deleteCall = request.mock.calls.find((call) => call[0].method === "DELETE");
      expect(deleteCall).toBeDefined();
      // Ключевая проверка: путь удаления взят из ответа сервера, а не
      // построен через hrefFor(calendar, uid) — эти два пути для UID с
      // собакой различаются, и удаление по неверному пути либо ничего не
      // найдёт, либо (что хуже) попадёт не в тот объект.
      expect(deleteCall![0].path).toBe(realHref);
      expect(deleteCall![0].path).not.toBe(hrefFromUid);
      // If-Match несёт ETag, пришедший от сервера, как есть (без кавычек).
      expect(deleteCall![0].headers["If-Match"]).toBe("1789383239000");
    });

    it("бросает понятную ошибку, если событие с таким UID не найдено, и не шлёт DELETE", async () => {
      const empty = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"></d:multistatus>`;
      const { client, request } = fakeClient(empty);

      await expect(deleteEvent(contextFor(client) as never, { id: uid })).rejects.toThrow(
        /не найдено/,
      );
      expect(request.mock.calls.some((call) => call[0].method === "DELETE")).toBe(false);
    });
  });

  describe("настоящие последовательности вызовов (мутируемый контекст)", () => {
    // Находка ревью: contextWith выше подставляет ОДИН И ТОТ ЖЕ снимок ics на
    // каждый вызов get() — второй deleteEvent в тесте видел бы состояние ДО
    // первого, а не то, что первый реально записал. Это годится для проверки
    // одного вызова, но не для проверки последовательности: тест на
    // "this_and_following сохраняет уже существующие EXDATE" (выше) кладёт
    // готовый EXDATE фикстурой, а не получает его настоящим предыдущим
    // вызовом deleteEvent — это статическая имитация состояния, а не
    // последовательность.
    //
    // Здесь put()/remove() ДЕЙСТВИТЕЛЬНО меняют то, что вернёт следующий
    // get() — так же, как в реальности следующий REPORT/GET увидел бы то,
    // что записал предыдущий PUT/DELETE на сервере. Это единственный способ
    // честно проверить, что делает ВТОРОЙ вызов deleteEvent, а не то, что мы
    // заранее решили, будто он должен увидеть.
    function mutableContextWith(initialIcs: string) {
      let store: { href: string; etag: string; ics: string } | undefined = {
        href: "/c/work/x.ics",
        etag: '"etag-0"',
        ics: initialIcs,
      };
      let etagSeq = 0;

      const get = vi.fn(async () => {
        if (!store) {
          throw new Error("Объект уже удалён — сервер больше не находит его по UID.");
        }
        return store;
      });

      const put = vi.fn(async (href: string, ics: string) => {
        etagSeq += 1;
        const etag = `"etag-${etagSeq}"`;
        store = { href, etag, ics };
        return etag;
      });

      const remove = vi.fn(async () => {
        store = undefined;
      });

      return {
        context: {
          client: {} as never,
          config: { defaultTimeZone: "Europe/Moscow" } as never,
          calendars: async () => [calendar],
          resolveCalendar: async () => calendar,
          get,
          put,
          remove,
        },
        get,
        put,
        remove,
      };
    }

    it("удаление одного и того же экземпляра дважды подряд: второй раз — понятная ошибка, а не дубликат исключения и не удаление объекта", async () => {
      const { context, put, remove } = mutableContextWith(weekly);

      await deleteEvent(context as never, {
        id: "test-weekly-1",
        scope: "this",
        instanceStart: "2026-10-21T10:00:00+03:00",
      });

      // Первый вызов честно дошёл до PUT с EXDATE — читаем НЕ фикстуру, а то,
      // что реально записал deleteEvent.
      expect(put).toHaveBeenCalledTimes(1);
      const afterFirstDelete = put.mock.calls[0][1];
      expect(afterFirstDelete).toContain("EXDATE");
      expect(put.mock.calls[0][2].ifMatch).toBe('"etag-0"');

      // Второй вызов передаёт ТОТ ЖЕ instanceStart. Следующий get() отдаёт
      // ics с уже стоящим EXDATE (записанный первым вызовом, а не исходную
      // фикстуру weekly.ics) — assertInstanceExists честно раскрывает повтор
      // с учётом EXDATE (ICAL.RecurExpansion сам его учитывает) и не находит
      // экземпляр в 21 октября: он исключён.
      await expect(
        deleteEvent(context as never, {
          id: "test-weekly-1",
          scope: "this",
          instanceStart: "2026-10-21T10:00:00+03:00",
        }),
      ).rejects.toThrow(/экземпляр/i);

      // Ключевая проверка: второй вызов не должен был дойти ни до PUT
      // (дубликат EXDATE), ни тем более до DELETE (удаление всего объекта
      // вместо понятной ошибки) — он обязан остановиться на проверке.
      expect(put).toHaveBeenCalledTimes(1);
      expect(remove).not.toHaveBeenCalled();
    });

    it("удалить экземпляр, затем усечь серию: итоговый объект несёт и поставленное исключение, и границу окончания", async () => {
      const { context, put, remove } = mutableContextWith(weekly);

      await deleteEvent(context as never, {
        id: "test-weekly-1",
        scope: "this",
        instanceStart: "2026-10-21T10:00:00+03:00",
      });

      await deleteEvent(context as never, {
        id: "test-weekly-1",
        scope: "this_and_following",
        instanceStart: "2026-11-02T10:00:00+03:00",
      });

      expect(remove).not.toHaveBeenCalled();
      expect(put).toHaveBeenCalledTimes(2);
      // Второй вызов принял ifMatch со свежим ETag, оставленным первым —
      // ещё одно подтверждение, что состояние действительно перетекает
      // между вызовами, а не берётся из готового снимка.
      expect(put.mock.calls[1][2].ifMatch).toBe('"etag-1"');

      // Итоговый ics — тот, что читает ВТОРОЙ вызов put (после усечения),
      // построенный поверх результата ПЕРВОГО вызова, а не поверх исходной
      // фикстуры weekly.ics.
      const finalIcs = put.mock.calls[1][1];
      expect(finalIcs).toContain("EXDATE;TZID=Europe/Moscow:20261021T100000");
      expect(finalIcs).toContain("UNTIL=");
    });
  });
});
