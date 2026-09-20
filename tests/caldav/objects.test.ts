import { describe, expect, it, vi } from "vitest";
import {
  deleteObject,
  getObject,
  putObject,
  putObjectWithStatus,
  queryEventByUid,
  queryEvents,
} from "../../src/caldav/objects.js";
import { CaldavError, createClient, type CaldavClient } from "../../src/caldav/request.js";

function client(response: { status?: number; text?: string; headers?: Record<string, string> }) {
  const request = vi.fn().mockResolvedValue({
    status: response.status ?? 207,
    headers: new Headers(response.headers ?? {}),
    text: response.text ?? "",
  });
  return { client: { request } as unknown as CaldavClient, request };
}

const multistatus = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:response>
    <d:href>/calendars/user/work/event-1.ics</d:href>
    <d:propstat><d:prop>
      <d:getetag>"etag-1"</d:getetag>
      <c:calendar-data>BEGIN:VCALENDAR
END:VCALENDAR</c:calendar-data>
    </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>
</d:multistatus>`;

describe("queryEvents", () => {
  it("шлёт REPORT с Depth 1 и разбирает ответ", async () => {
    const { client: caldav, request } = client({ text: multistatus });

    const objects = await queryEvents(
      caldav,
      "/calendars/user/work/",
      new Date("2026-09-01T00:00:00Z"),
      new Date("2026-10-01T00:00:00Z"),
    );

    expect(request.mock.calls[0][0].method).toBe("REPORT");
    expect(request.mock.calls[0][0].depth).toBe("1");
    expect(objects).toHaveLength(1);
    expect(objects[0].etag).toBe('"etag-1"');
    expect(objects[0].ics).toContain("BEGIN:VCALENDAR");
  });
});

describe("getObject", () => {
  it("шлёт GET и берёт ETag из заголовка ответа", async () => {
    const { client: caldav, request } = client({
      text: "BEGIN:VCALENDAR\nEND:VCALENDAR",
      headers: { ETag: "1789383239000" },
    });

    const object = await getObject(caldav, "/calendars/user/work/event-1.ics");

    expect(request.mock.calls[0][0].method).toBe("GET");
    expect(request.mock.calls[0][0].path).toBe("/calendars/user/work/event-1.ics");
    expect(object.href).toBe("/calendars/user/work/event-1.ics");
    expect(object.etag).toBe("1789383239000");
    expect(object.ics).toContain("BEGIN:VCALENDAR");
  });

  it("возвращает пустой ETag, если сервер его не прислал", async () => {
    const { client: caldav } = client({ text: "BEGIN:VCALENDAR\nEND:VCALENDAR" });

    const object = await getObject(caldav, "/x.ics");

    expect(object.etag).toBe("");
  });
});

describe("putObject", () => {
  it("при создании ставит If-None-Match и возвращает новый ETag", async () => {
    const { client: caldav, request } = client({
      status: 201,
      headers: { ETag: '"new-etag"' },
    });

    const etag = await putObject(caldav, "/calendars/user/work/x.ics", "BEGIN:VCALENDAR", {
      ifNoneMatch: true,
    });

    expect(request.mock.calls[0][0].headers["If-None-Match"]).toBe("*");
    expect(request.mock.calls[0][0].headers["Content-Type"]).toContain("text/calendar");
    expect(etag).toBe('"new-etag"');
  });

  it("при обновлении ставит If-Match с переданным ETag", async () => {
    const { client: caldav, request } = client({ status: 204 });

    await putObject(caldav, "/calendars/user/work/x.ics", "BEGIN:VCALENDAR", {
      ifMatch: '"etag-1"',
    });

    expect(request.mock.calls[0][0].headers["If-Match"]).toBe('"etag-1"');
  });

  it("возвращает пустую строку, если сервер не прислал ETag", async () => {
    const { client: caldav } = client({ status: 204 });

    const etag = await putObject(caldav, "/x.ics", "BEGIN:VCALENDAR", { ifNoneMatch: true });

    expect(etag).toBe("");
  });

  it("ETag Яндекса — голое число без кавычек, передаётся как есть", async () => {
    const { client: caldav, request } = client({
      status: 204,
      headers: { ETag: "1789383239000" },
    });

    const etag = await putObject(caldav, "/x.ics", "BEGIN:VCALENDAR", {
      ifMatch: "1789383239000",
    });

    expect(request.mock.calls[0][0].headers["If-Match"]).toBe("1789383239000");
    expect(etag).toBe("1789383239000");
  });
});

describe("putObjectWithStatus", () => {
  it("отдаёт код ответа вместе с ETag: 204 — объект заменён", async () => {
    const { client: caldav } = client({ status: 204, headers: { ETag: "1789383239000" } });

    expect(await putObjectWithStatus(caldav, "/x.ics", "BEGIN:VCALENDAR", { ifMatch: "1789383238000" })).toEqual({
      status: 204,
      etag: "1789383239000",
    });
  });

  it("201 на запись с If-Match: объекта по пути не было, сервер создал его (Ж16)", async () => {
    const { client: caldav, request } = client({ status: 201, headers: { ETag: "1789383240000" } });

    expect(await putObjectWithStatus(caldav, "/x.ics", "BEGIN:VCALENDAR", { ifMatch: "1789383239000" })).toEqual({
      status: 201,
      etag: "1789383240000",
    });
    expect(request.mock.calls[0][0].headers["If-Match"]).toBe("1789383239000");
  });

  it("код есть и тогда, когда сервер не прислал ETag", async () => {
    const { client: caldav } = client({ status: 201 });

    expect(await putObjectWithStatus(caldav, "/x.ics", "BEGIN:VCALENDAR", { ifNoneMatch: true })).toEqual({
      status: 201,
      etag: "",
    });
  });
});

describe("deleteObject", () => {
  it("шлёт DELETE с If-Match", async () => {
    const { client: caldav, request } = client({ status: 204 });

    await deleteObject(caldav, "/calendars/user/work/x.ics", '"etag-1"');

    expect(request.mock.calls[0][0].method).toBe("DELETE");
    expect(request.mock.calls[0][0].headers["If-Match"]).toBe('"etag-1"');
  });
});

describe("queryEventByUid", () => {
  // UID вида "...@yandex.ru" на сервере Яндекса соответствует объекту
  // "...yandex.ru.ics" — собака выброшена, а не закодирована (Задача 1).
  // Если бы queryEventByUid собирал путь из UID сам, он получил бы
  // "/calendars/user/work/aaaabbbbccccdddd11%40yandex.ru.ics" —
  // адрес, которого на сервере не существует. Фикстура ниже намеренно
  // возвращает от «сервера» другой, непохожий на UID href, чтобы отличить
  // правильную реализацию (берёт href из ответа) от неправильной
  // (реконструирует его из UID).
  const uid = "aaaabbbbccccdddd11@yandex.ru";
  const realHref = "/calendars/user/work/aaaabbbbccccdddd11yandex.ru.ics";
  const foundByUid = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:response>
    <d:href>${realHref}</d:href>
    <d:propstat><d:prop>
      <d:getetag>1789383239000</d:getetag>
      <c:calendar-data>BEGIN:VCALENDAR
UID:aaaabbbbccccdddd11@yandex.ru
END:VCALENDAR</c:calendar-data>
    </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>
</d:multistatus>`;

  it("шлёт REPORT calendar-query с фильтром по UID (экранированным)", async () => {
    const { client: caldav, request } = client({ text: foundByUid });

    await queryEventByUid(caldav, "/calendars/user/work/", uid);

    const sent = request.mock.calls[0][0];
    expect(sent.method).toBe("REPORT");
    expect(sent.path).toBe("/calendars/user/work/");
    expect(sent.body).toContain('<c:prop-filter name="UID">');
    expect(sent.body).toContain("<c:text-match");
    // "@" должен уйти в тело как есть, а вот "&", "<", ">" — экранироваться.
    expect(sent.body).toContain("aaaabbbbccccdddd11@yandex.ru");
  });

  it("экранирует спецсимволы XML в UID", async () => {
    const { client: caldav, request } = client({ text: "<d:multistatus/>" });

    await queryEventByUid(caldav, "/calendars/user/work/", "a&b<c>d");

    const sent = request.mock.calls[0][0];
    expect(sent.body).toContain("a&amp;b&lt;c&gt;d");
    expect(sent.body).not.toContain("a&b<c>d");
  });

  it("возвращает найденный объект с href из ответа сервера, а не собранным из UID", async () => {
    const { client: caldav } = client({ text: foundByUid });

    const object = await queryEventByUid(caldav, "/calendars/user/work/", uid);

    expect(object).toBeDefined();
    // Ключевая проверка: href — тот, что реально прислал сервер (без "@",
    // со слитным доменом), а НЕ то, что получилось бы из
    // encodeURIComponent(uid) + ".ics".
    expect(object!.href).toBe(realHref);
    expect(object!.href).not.toBe(
      `/calendars/user/work/${encodeURIComponent(uid)}.ics`,
    );
    expect(object!.etag).toBe("1789383239000");
    expect(object!.ics).toContain("BEGIN:VCALENDAR");
  });

  it("возвращает undefined, если событие с таким UID не найдено", async () => {
    const empty = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"></d:multistatus>`;
    const { client: caldav } = client({ text: empty });

    const object = await queryEventByUid(caldav, "/calendars/user/work/", uid);

    expect(object).toBeUndefined();
  });

  // <c:text-match> в CalDAV — подстроковое сравнение (RFC 4791 §9.7.5:
  // "substring match"), collation="i;octet" управляет только регистром,
  // а не гранулярностью. Сервер может честно вернуть событие, чей UID лишь
  // содержит искомый как часть, — такие ответы нужно отбрасывать самим,
  // сверяя настоящий UID из calendar-data.
  it("отбрасывает объект, чей UID лишь содержит искомый как подстроку", async () => {
    const substringMatch = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:response>
    <d:href>/calendars/user/work/other.ics</d:href>
    <d:propstat><d:prop>
      <d:getetag>1</d:getetag>
      <c:calendar-data>BEGIN:VCALENDAR
UID:aaaabbbbccccdddd11@yandex.ru-extra
END:VCALENDAR</c:calendar-data>
    </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>
</d:multistatus>`;
    const { client: caldav } = client({ text: substringMatch });

    const object = await queryEventByUid(caldav, "/calendars/user/work/", uid);

    expect(object).toBeUndefined();
  });

  it("бросает понятную ошибку, если найдено больше одного объекта с точным совпадением UID", async () => {
    const duplicateMatch = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:response>
    <d:href>/calendars/user/work/dup-1.ics</d:href>
    <d:propstat><d:prop>
      <d:getetag>1</d:getetag>
      <c:calendar-data>BEGIN:VCALENDAR
UID:aaaabbbbccccdddd11@yandex.ru
END:VCALENDAR</c:calendar-data>
    </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>
  <d:response>
    <d:href>/calendars/user/work/dup-2.ics</d:href>
    <d:propstat><d:prop>
      <d:getetag>2</d:getetag>
      <c:calendar-data>BEGIN:VCALENDAR
UID:aaaabbbbccccdddd11@yandex.ru
END:VCALENDAR</c:calendar-data>
    </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>
</d:multistatus>`;
    const { client: caldav } = client({ text: duplicateMatch });

    await expect(queryEventByUid(caldav, "/calendars/user/work/", uid)).rejects.toThrow(/2/);
  });

  it("находит объект, если строка UID перенесена по правилам iCalendar", async () => {
    // Правило переноса строк RFC 5545 §3.1: продолжение начинается с
    // одного пробела или таба, который при разборе убирается, а хвост
    // склеивается с предыдущей строкой.
    const foldedMatch = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:response>
    <d:href>${realHref}</d:href>
    <d:propstat><d:prop>
      <d:getetag>1789383239000</d:getetag>
      <c:calendar-data>BEGIN:VCALENDAR
UID:aaaabbbbccccdddd11@yandex.r
 u
END:VCALENDAR</c:calendar-data>
    </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>
</d:multistatus>`;
    const { client: caldav } = client({ text: foldedMatch });

    const object = await queryEventByUid(caldav, "/calendars/user/work/", uid);

    expect(object).toBeDefined();
    expect(object!.href).toBe(realHref);
  });

  // Развёртывание перенесённых строк (RFC 5545 §3.1) снимает РОВНО ОДИН
  // служебный пробел продолжения — сам пробел или таб. Всё остальное в
  // значении свойства значимо, включая краевые пробелы, и сравнение
  // должно быть побайтовым: лишняя нормализация (например, trim())
  // воссоздаёт то же ложное «точное совпадение», от которого защищает
  // сверка UID, — только теперь через хвостовой/ведущий пробел вместо
  // серверного text-match.
  it("не считает совпадением UID, отличающийся только хвостовым пробелом", async () => {
    const uidWithTrailingSpace = uid + " ";
    const trailingSpaceMatch = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:response>
    <d:href>/calendars/user/work/other.ics</d:href>
    <d:propstat><d:prop>
      <d:getetag>1</d:getetag>
      <c:calendar-data>BEGIN:VCALENDAR
UID:${uidWithTrailingSpace}
END:VCALENDAR</c:calendar-data>
    </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>
</d:multistatus>`;
    const { client: caldav } = client({ text: trailingSpaceMatch });

    const object = await queryEventByUid(caldav, "/calendars/user/work/", uid);

    expect(object).toBeUndefined();
  });
});

// Задача З02, решение Р8 плана переделки
// (docs/superpowers/plans/2026-09-19-recurring-events-rework.md): записи
// объектов уходят на сервер ровно один раз, а CaldavError с полем applied
// доходит до вызывающего без обёрток — по нему слой домена (З12) решает,
// перечитывать ли объект. Здесь putObject и deleteObject проверяются через
// настоящий createClient, а не через мок client.request: иначе повтор
// внутри транспорта был бы не виден.
describe("запись объектов через настоящий транспорт", () => {
  const config = {
    login: "user@yandex.ru",
    appPassword: "secret",
    defaultTimeZone: "Europe/Moscow",
    baseUrl: "https://caldav.yandex.ru",
  };

  function transport(fetchMock: ReturnType<typeof vi.fn>): CaldavClient {
    return createClient(config, fetchMock as unknown as typeof fetch);
  }

  function reply(status: number, text = "", headers: Record<string, string> = {}) {
    return new Response(text, { status, headers });
  }

  async function caught(promise: Promise<unknown>): Promise<CaldavError> {
    try {
      await promise;
    } catch (error) {
      if (error instanceof CaldavError) return error;
      throw new Error(`ожидалась CaldavError, а пришло: ${String(error)}`);
    }
    throw new Error("ожидался отказ, а запрос прошёл");
  }

  it("putObject на 503 шлёт PUT ровно один раз и отдаёт applied: unknown", async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(503));

    const error = await caught(
      putObject(transport(fetchMock), "/calendars/user/work/x.ics", "BEGIN:VCALENDAR", {
        ifMatch: "1789383239000",
      }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].method).toBe("PUT");
    expect(error.applied).toBe("unknown");
    expect(error.status).toBe(503);
  });

  it("putObject с If-None-Match после таймаута не повторяется", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValue(new DOMException("The operation was aborted due to timeout", "TimeoutError"));

    const error = await caught(
      putObject(transport(fetchMock), "/calendars/user/work/x.ics", "BEGIN:VCALENDAR", {
        ifNoneMatch: true,
      }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error.applied).toBe("unknown");
    expect(error.status).toBe(0);
  });

  it("deleteObject после сетевого сбоя (TypeError) не повторяет DELETE", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));

    const error = await caught(
      deleteObject(transport(fetchMock), "/calendars/user/work/x.ics", "1789383239000"),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].method).toBe("DELETE");
    expect(error.applied).toBe("unknown");
    expect(error.status).toBe(0);
  });

  it("putObject на 412 отдаёт applied: no и статус 412", async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(412));

    const error = await caught(
      putObject(transport(fetchMock), "/x.ics", "BEGIN:VCALENDAR", { ifMatch: "1" }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error.applied).toBe("no");
    expect(error.status).toBe(412);
  });

  it("deleteObject на 404 отдаёт applied: no и статус 404 — «уже удалено» решает домен", async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(404));

    const error = await caught(deleteObject(transport(fetchMock), "/x.ics", "1"));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error.applied).toBe("no");
    expect(error.status).toBe(404);
  });

  it("putObject с оборванным телом успешного ответа возвращает ETag из заголовка", async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.error(new TypeError("terminated"));
      },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(body, { status: 201, headers: { ETag: "1789383239001" } }));

    const etag = await putObject(transport(fetchMock), "/x.ics", "BEGIN:VCALENDAR", {
      ifNoneMatch: true,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(etag).toBe("1789383239001");
  });

  // Охранные тесты: чтение безопасно повторять, и перечитывание после
  // записи без ответа (Р8) должно переживать кратковременный сбой.
  it("queryEventByUid повторяет REPORT на 503", async () => {
    const found = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:response>
    <d:href>/calendars/user/work/a.ics</d:href>
    <d:propstat><d:prop>
      <d:getetag>5</d:getetag>
      <c:calendar-data>BEGIN:VCALENDAR
UID:a
END:VCALENDAR</c:calendar-data>
    </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>
</d:multistatus>`;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(reply(503))
      .mockResolvedValueOnce(reply(207, found));

    const object = await queryEventByUid(transport(fetchMock), "/calendars/user/work/", "a");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(object?.etag).toBe("5");
  });

  it("getObject повторяет GET после сетевого сбоя", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(reply(200, "BEGIN:VCALENDAR", { ETag: "9" }));

    const object = await getObject(transport(fetchMock), "/x.ics");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(object.etag).toBe("9");
  });
});
