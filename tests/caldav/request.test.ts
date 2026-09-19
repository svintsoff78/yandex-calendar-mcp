import { describe, expect, it, vi } from "vitest";
import { CaldavError, createClient } from "../../src/caldav/request.js";

const config = {
  login: "user@yandex.ru",
  appPassword: "secret",
  defaultTimeZone: "Europe/Moscow",
  baseUrl: "https://caldav.yandex.ru",
};

function reply(status: number, text = "", headers: Record<string, string> = {}) {
  return new Response(text, { status, headers });
}

describe("createClient", () => {
  it("подставляет Basic-авторизацию и Depth", async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(207, "<ok/>"));
    const client = createClient(config, fetchMock as unknown as typeof fetch);

    await client.request({ method: "PROPFIND", path: "/", depth: "1", body: "<x/>" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://caldav.yandex.ru/");
    expect(init.headers.Authorization).toBe(
      "Basic " + Buffer.from("user@yandex.ru:secret").toString("base64"),
    );
    expect(init.headers.Depth).toBe("1");
  });

  it("на 401 бросает CaldavError с подсказкой про пароль приложения", async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(401));
    const client = createClient(config, fetchMock as unknown as typeof fetch);

    await expect(client.request({ method: "PROPFIND", path: "/" })).rejects.toThrow(
      /[Пп]ароль приложения/,
    );
  });

  it("никогда не упоминает пароль в тексте ошибки", async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(401, "secret leaked"));
    const client = createClient(config, fetchMock as unknown as typeof fetch);

    await expect(client.request({ method: "PROPFIND", path: "/" })).rejects.toSatisfy(
      (error: CaldavError) => !String(error.message).includes("secret"),
    );
  });

  it("повторяет запрос при 503 и отдаёт успех со второй попытки", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(reply(503))
      .mockResolvedValueOnce(reply(207, "<ok/>"));
    const client = createClient(config, fetchMock as unknown as typeof fetch);

    const response = await client.request({ method: "PROPFIND", path: "/" });

    expect(response.status).toBe(207);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("на 412 объясняет, что событие изменили", async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(412));
    const client = createClient(config, fetchMock as unknown as typeof fetch);

    await expect(client.request({ method: "PUT", path: "/x.ics" })).rejects.toThrow(
      /изменили/,
    );
  });

  it("на таймауте (AbortSignal.timeout) бросает CaldavError, а не сырой DOMException", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValue(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    const client = createClient(config, fetchMock as unknown as typeof fetch);

    const failing = client.request({ method: "PROPFIND", path: "/" });

    await expect(failing).rejects.toBeInstanceOf(CaldavError);
    await expect(failing).rejects.toThrow(/сеть или сервер недоступны/i);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("на сетевом сбое (DNS/connection refused) бросает CaldavError, а не сырой TypeError", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const client = createClient(config, fetchMock as unknown as typeof fetch);

    const failing = client.request({ method: "PROPFIND", path: "/" });

    await expect(failing).rejects.toBeInstanceOf(CaldavError);
    await expect(failing).rejects.toThrow(/сеть или сервер недоступны/i);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("бросает CaldavError про недоступность, когда все попытки исчерпаны на 503", async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(503));
    const client = createClient(config, fetchMock as unknown as typeof fetch);

    const failing = client.request({ method: "PROPFIND", path: "/" });

    await expect(failing).rejects.toBeInstanceOf(CaldavError);
    await expect(failing).rejects.toThrow(/сеть или сервер недоступны/i);
    await expect(failing).rejects.toThrow(/3/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("отменяет тело отброшенного ответа при повторе, не дожидаясь сборщика мусора", async () => {
    const discarded = reply(503);
    const cancelSpy = vi.spyOn(discarded.body as ReadableStream, "cancel");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(discarded)
      .mockResolvedValueOnce(reply(207, "<ok/>"));
    const client = createClient(config, fetchMock as unknown as typeof fetch);

    await client.request({ method: "PROPFIND", path: "/" });

    expect(cancelSpy).toHaveBeenCalledTimes(1);
  });
});

// Задача З02, решение Р8 плана переделки
// (docs/superpowers/plans/2026-09-19-recurring-events-rework.md): PUT и
// DELETE уходят ровно один раз. Повтор условной записи после потерянного
// ответа — корень поломок AE7, AE18 и AD12 (wave-a-results.json): первая
// попытка применилась, повтор получает 412 или 404, и пользователь видит
// ложный отказ, а хвост серии теряется. Исход записи без ответа выясняет
// перечитыванием слой домена (З12) — транспорту для этого нужно только
// честно сказать, дошла ли запись: applied "no" или "unknown".

// Тело ответа, которое обрывается при чтении: заголовки и статус пришли,
// а соединение упало на середине тела.
function brokenBody(status: number, headers: Record<string, string> = {}) {
  const body = new ReadableStream({
    start(controller) {
      controller.error(new TypeError("terminated"));
    },
  });
  return new Response(body, { status, headers });
}

function clientWith(fetchMock: ReturnType<typeof vi.fn>) {
  return createClient(config, fetchMock as unknown as typeof fetch);
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

describe("политика повторов по методу", () => {
  it.each(["GET", "HEAD", "OPTIONS", "PROPFIND", "REPORT"])(
    "безопасный %s повторяется на 503",
    async (method) => {
      const fetchMock = vi.fn().mockResolvedValueOnce(reply(503)).mockResolvedValueOnce(reply(200));
      const response = await clientWith(fetchMock).request({ method, path: "/" });

      expect(response.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["PUT", "DELETE"])("%s на 503 уходит ровно один раз, applied: unknown", async (method) => {
    const fetchMock = vi.fn().mockResolvedValue(reply(503));

    const error = await caught(clientWith(fetchMock).request({ method, path: "/x.ics" }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error.applied).toBe("unknown");
    expect(error.status).toBe(503);
  });

  it.each(["PUT", "DELETE"])("%s после сетевого сбоя (TypeError) не повторяется", async (method) => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));

    const error = await caught(clientWith(fetchMock).request({ method, path: "/x.ics" }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error.applied).toBe("unknown");
    expect(error.status).toBe(0);
  });

  it.each(["PUT", "DELETE"])("%s после таймаута не повторяется", async (method) => {
    const fetchMock = vi
      .fn()
      .mockRejectedValue(new DOMException("The operation was aborted due to timeout", "TimeoutError"));

    const error = await caught(clientWith(fetchMock).request({ method, path: "/x.ics" }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error.applied).toBe("unknown");
    expect(error.status).toBe(0);
  });

  it.each([500, 502, 504, 507])("PUT на %i уходит один раз, applied: unknown", async (status) => {
    const fetchMock = vi.fn().mockResolvedValue(reply(status));

    const error = await caught(clientWith(fetchMock).request({ method: "PUT", path: "/x.ics" }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error.applied).toBe("unknown");
    expect(error.status).toBe(status);
  });

  it.each(["PUT", "DELETE"])("%s на 429 не повторяется: сервер запрос не выполнил, applied: no", async (method) => {
    const fetchMock = vi.fn().mockResolvedValue(reply(429));

    const error = await caught(clientWith(fetchMock).request({ method, path: "/x.ics" }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error.applied).toBe("no");
    expect(error.status).toBe(429);
  });

  it.each([
    ["PUT", 412],
    ["DELETE", 412],
    ["DELETE", 404],
    ["PUT", 403],
    ["PUT", 409],
    ["PUT", 400],
  ] as const)("%s на %i: один запрос, applied: no, статус сохранён", async (method, status) => {
    const fetchMock = vi.fn().mockResolvedValue(reply(status));

    const error = await caught(clientWith(fetchMock).request({ method, path: "/x.ics" }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error.applied).toBe("no");
    expect(error.status).toBe(status);
  });

  it.each(["POST", "MKCOL", "MKCALENDAR", "PROPPATCH"])(
    "прочий метод %s не повторяется: повторять можно только заведомо безопасные",
    async (method) => {
      const fetchMock = vi.fn().mockResolvedValue(reply(503));

      const error = await caught(clientWith(fetchMock).request({ method, path: "/" }));

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(error.applied).toBe("unknown");
    },
  );

  it("регистр имени метода политику не меняет", async () => {
    const put = vi.fn().mockResolvedValue(reply(503));
    await caught(clientWith(put).request({ method: "put", path: "/x.ics" }));
    expect(put).toHaveBeenCalledTimes(1);

    const get = vi.fn().mockResolvedValueOnce(reply(503)).mockResolvedValueOnce(reply(200));
    await clientWith(get).request({ method: "get", path: "/x.ics" });
    expect(get).toHaveBeenCalledTimes(2);
  });
});

describe("текст ошибки записи без ответа", () => {
  it("после сетевого сбоя говорит, что исход неизвестен и повтора не было", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));

    const error = await caught(clientWith(fetchMock).request({ method: "PUT", path: "/x.ics" }));

    expect(error.message).toMatch(/сеть или сервер недоступны/i);
    expect(error.message).toMatch(/неизвестно/);
    expect(error.message).toMatch(/не повторял/);
    expect(error.message).not.toMatch(/повтор выполнен/);
    expect(error.hint).toBe(error.message);
  });

  it("на 5xx называет код и говорит, что исход неизвестен", async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(503));

    const error = await caught(clientWith(fetchMock).request({ method: "DELETE", path: "/x.ics" }));

    expect(error.message).toMatch(/503/);
    expect(error.message).toMatch(/неизвестно/);
    expect(error.message).toMatch(/DELETE/);
  });

  it("на 507 сохраняет подсказку про место на сервере", async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(507));

    const error = await caught(clientWith(fetchMock).request({ method: "PUT", path: "/x.ics" }));

    expect(error.message).toMatch(/кончилось место/);
    expect(error.message).toMatch(/неизвестно/);
  });
});

describe("поле applied у безопасных методов и по умолчанию", () => {
  it("исчерпанные повторы 5xx дают applied: unknown", async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(503));

    const error = await caught(clientWith(fetchMock).request({ method: "REPORT", path: "/" }));

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(error.applied).toBe("unknown");
  });

  it("ответ 4xx на чтение даёт applied: no", async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(401));

    const error = await caught(clientWith(fetchMock).request({ method: "PROPFIND", path: "/" }));

    expect(error.applied).toBe("no");
  });

  it("CaldavError без явного applied считается unknown: перечитывание безвредно, ложное «не дошло» — нет", () => {
    expect(new CaldavError("x", 503, "x").applied).toBe("unknown");
    expect(new CaldavError("x", 412, "x", "no").applied).toBe("no");
  });
});

describe("оборванное тело ответа", () => {
  it("успешный PUT с оборванным телом не бросает: статус 2xx уже подтвердил запись", async () => {
    const fetchMock = vi.fn().mockResolvedValue(brokenBody(201, { ETag: "7" }));

    const response = await clientWith(fetchMock).request({ method: "PUT", path: "/x.ics" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(201);
    expect(response.headers.get("etag")).toBe("7");
    expect(response.text).toBe("");
  });

  it("обрыв тела ответа на REPORT повторяется как сетевой сбой", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(brokenBody(207))
      .mockResolvedValueOnce(reply(207, "<ok/>"));

    const response = await clientWith(fetchMock).request({ method: "REPORT", path: "/" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(response.text).toBe("<ok/>");
  });

  it("обрыв тела во всех попытках чтения даёт CaldavError со статусом 0, а не сырой TypeError", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => brokenBody(207));

    const error = await caught(clientWith(fetchMock).request({ method: "REPORT", path: "/" }));

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(error.status).toBe(0);
    expect(error.applied).toBe("unknown");
    expect(error.message).toMatch(/сеть или сервер недоступны/i);
  });
});
