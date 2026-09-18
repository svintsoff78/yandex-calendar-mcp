import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const full = {
  YANDEX_LOGIN: "user@yandex.ru",
  YANDEX_APP_PASSWORD: "secret",
  YANDEX_DEFAULT_TZ: "Europe/Moscow",
};

describe("loadConfig", () => {
  it("читает полный набор переменных", () => {
    const config = loadConfig(full);
    expect(config.login).toBe("user@yandex.ru");
    expect(config.defaultTimeZone).toBe("Europe/Moscow");
    expect(config.baseUrl).toBe("https://caldav.yandex.ru");
  });

  it("падает с понятным текстом, если нет пароля", () => {
    const { YANDEX_APP_PASSWORD, ...without } = full;
    expect(() => loadConfig(without)).toThrow(/YANDEX_APP_PASSWORD/);
  });

  it("не пишет пароль в текст ошибки", () => {
    const broken = { ...full, YANDEX_DEFAULT_TZ: "" };
    try {
      loadConfig(broken);
    } catch (error) {
      expect(String(error)).not.toContain("secret");
    }
  });
});
