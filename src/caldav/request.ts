import type { Config } from "../config.js";

export interface RequestOptions {
  method: string;
  path: string;
  body?: string;
  headers?: Record<string, string>;
  depth?: "0" | "1";
}

export interface CaldavResponse {
  status: number;
  headers: Headers;
  text: string;
}

export class CaldavError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly hint: string,
  ) {
    super(message);
    this.name = "CaldavError";
  }
}

export interface CaldavClient {
  request(options: RequestOptions): Promise<CaldavResponse>;
}

const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const TIMEOUT_MS = 20_000;

function explain(status: number): string {
  if (status === 401) {
    return "пароль приложения не принят. Заведите новый в Яндекс ID → Безопасность → Пароли приложений, тип «Календарь», и положите его в YANDEX_APP_PASSWORD. Обычный пароль от аккаунта здесь не работает.";
  }
  if (status === 403) {
    return "Доступ запрещён: календарь открыт только для чтения.";
  }
  if (status === 412) {
    return "Событие изменили после того, как мы его прочитали. Перечитайте событие и повторите операцию.";
  }
  if (status === 507) {
    return "На сервере кончилось место для календаря.";
  }
  return `Сервер календаря ответил кодом ${status}.`;
}

export function createClient(config: Config, fetchImpl: typeof fetch = fetch): CaldavClient {
  const authorization =
    "Basic " + Buffer.from(`${config.login}:${config.appPassword}`).toString("base64");

  async function attempt(options: RequestOptions): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: authorization,
      "Content-Type": "application/xml; charset=utf-8",
      ...options.headers,
    };
    if (options.depth) headers.Depth = options.depth;

    return fetchImpl(`${config.baseUrl}${options.path}`, {
      method: options.method,
      headers,
      body: options.body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  }

  return {
    async request(options) {
      let last: Response | undefined;
      for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
        last = await attempt(options);
        if (!RETRY_STATUSES.has(last.status)) break;
      }
      const response = last as Response;
      if (response.status >= 400) {
        const hint = explain(response.status);
        throw new CaldavError(hint, response.status, hint);
      }
      return {
        status: response.status,
        headers: response.headers,
        text: await response.text(),
      };
    },
  };
}
