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
