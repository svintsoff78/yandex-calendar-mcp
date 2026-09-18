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
    return "Пароль приложения не принят. Заведите новый в Яндекс ID → Безопасность → Пароли приложений, тип «Календарь», и положите его в YANDEX_APP_PASSWORD. Обычный пароль от аккаунта здесь не работает.";
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

// "раз"/"раза" по правилам русского числительного. При текущем MAX_ATTEMPTS = 3
// сюда всегда приходит 3, но функция написана универсально на случай, если
// MAX_ATTEMPTS изменится.
function timesWord(n: number): string {
  const mod100 = n % 100;
  const mod10 = n % 10;
  if (mod100 >= 11 && mod100 <= 14) return "раз";
  if (mod10 === 1) return "раз";
  if (mod10 >= 2 && mod10 <= 4) return "раза";
  return "раз";
}

// Класс ошибки «таймаут, 5xx» из раздела 11 спека: сеть или сервер недоступны.
// lastStatus — последний реально полученный HTTP-статус (например, 503,
// когда исчерпаны повторы на 5xx), либо 0, если ни одного ответа получить
// не удалось (все попытки упали таймаутом или сетевой ошибкой).
function unavailableError(attempts: number, lastStatus: number): CaldavError {
  const hint = `Сеть или сервер недоступны, повтор выполнен ${attempts} ${timesWord(attempts)}.`;
  return new CaldavError(hint, lastStatus, hint);
}

async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => {});
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
      let response: Response | undefined;
      let lastStatus = 0;

      for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
        const attemptsMade = i + 1;
        const isLastAttempt = attemptsMade >= MAX_ATTEMPTS;

        let current: Response;
        try {
          current = await attempt(options);
        } catch {
          // fetch отклоняет промис (а не возвращает Response) на таймауте
          // (AbortSignal.timeout → DOMException) и на сетевых сбоях —
          // DNS/connection refused (TypeError). Это тот же класс ошибок
          // «сеть или сервер недоступны», что и исчерпанные повторы на 5xx.
          if (isLastAttempt) throw unavailableError(attemptsMade, lastStatus);
          continue;
        }

        lastStatus = current.status;

        if (RETRY_STATUSES.has(current.status)) {
          if (isLastAttempt) {
            await discard(current);
            throw unavailableError(attemptsMade, lastStatus);
          }
          await discard(current);
          continue;
        }

        response = current;
        break;
      }

      const finalResponse = response as Response;
      if (finalResponse.status >= 400) {
        const hint = explain(finalResponse.status);
        await discard(finalResponse);
        throw new CaldavError(hint, finalResponse.status, hint);
      }
      return {
        status: finalResponse.status,
        headers: finalResponse.headers,
        text: await finalResponse.text(),
      };
    },
  };
}
