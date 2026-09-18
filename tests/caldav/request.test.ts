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
      /пароль приложения/,
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
});
