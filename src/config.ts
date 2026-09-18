import { z } from "zod";

// В zod 4 сообщение из .min() применяется только к уже присутствующей,
// но короткой строке; для отсутствующего ключа (undefined) нужен отдельный
// error на самом z.string(), иначе используется общее "expected string,
// received undefined" без имени переменной.
const YANDEX_LOGIN_MESSAGE = "YANDEX_LOGIN обязателен: полный адрес вида name@yandex.ru";
const YANDEX_APP_PASSWORD_MESSAGE = "YANDEX_APP_PASSWORD обязателен: пароль приложения из Яндекс ID";
const YANDEX_DEFAULT_TZ_MESSAGE = "YANDEX_DEFAULT_TZ обязателен, например Europe/Moscow";

const schema = z.object({
  YANDEX_LOGIN: z.string({ error: YANDEX_LOGIN_MESSAGE }).min(1, YANDEX_LOGIN_MESSAGE),
  YANDEX_APP_PASSWORD: z.string({ error: YANDEX_APP_PASSWORD_MESSAGE }).min(1, YANDEX_APP_PASSWORD_MESSAGE),
  YANDEX_DEFAULT_TZ: z.string({ error: YANDEX_DEFAULT_TZ_MESSAGE }).min(1, YANDEX_DEFAULT_TZ_MESSAGE),
  CALDAV_BASE_URL: z.string().url().default("https://caldav.yandex.ru"),
});

export interface Config {
  login: string;
  appPassword: string;
  defaultTimeZone: string;
  baseUrl: string;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const reasons = parsed.error.issues.map((issue) => issue.message).join("; ");
    throw new Error(`Конфигурация неполна: ${reasons}`);
  }
  return {
    login: parsed.data.YANDEX_LOGIN,
    appPassword: parsed.data.YANDEX_APP_PASSWORD,
    defaultTimeZone: parsed.data.YANDEX_DEFAULT_TZ,
    baseUrl: parsed.data.CALDAV_BASE_URL.replace(/\/+$/, ""),
  };
}
