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

  it("не пишет пароль в текст ошибки, если ошибка вызвана самим паролем", () => {
    // Пароль — единственное невалидное поле (логин и таймзона в норме), поэтому
    // источник ошибки — точно он. expect.assertions гарантирует, что catch
    // действительно выполнился: без него тест молча проходил бы и в случае,
    // если loadConfig вообще не бросит исключение.
    expect.assertions(2);
    const broken = { ...full, YANDEX_APP_PASSWORD: "" };
    try {
      loadConfig(broken);
    } catch (error) {
      expect(String(error)).toMatch(/YANDEX_APP_PASSWORD/);
      expect(String(error)).not.toContain(full.YANDEX_APP_PASSWORD);
    }
  });

  it("не пишет значения других полей в текст ошибки, когда пароль валиден", () => {
    // YANDEX_DEFAULT_TZ здесь не годится как «сломанное» поле: схема проверяет
    // только непустоту строки, а не реальное имя таймзоны, поэтому заметное
    // значение вроде "Europe/НЕСУЩЕСТВУЕТ" прошло бы валидацию и не вызвало
    // бы исключения вовсе. CALDAV_BASE_URL — единственное поле с содержательной
    // проверкой (.url()), где можно подставить непустое, узнаваемое и при этом
    // действительно невалидное значение.
    expect.assertions(2);
    const marker = "МАРКЕР-НЕ-URL-3f9a";
    const broken = { ...full, CALDAV_BASE_URL: marker };
    try {
      loadConfig(broken);
    } catch (error) {
      expect(String(error)).not.toContain(full.YANDEX_APP_PASSWORD);
      expect(String(error)).not.toContain(marker);
    }
  });
});
