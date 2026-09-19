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

// Дошёл ли запрос до сервера (решение Р8 плана
// docs/superpowers/plans/2026-09-19-recurring-events-rework.md):
// - "no" — сервер ответил 4xx, то есть по семантике HTTP запрос не выполнил
//   (412, 404, 403, 409, 429 и прочие);
// - "unknown" — ответа нет вовсе (сеть, таймаут, оборванное тело) или
//   пришёл 5xx: запись могла примениться, а ответ потеряться. Исход такой
//   записи выясняется перечитыванием объекта (src/domain/writes.ts, З12),
//   а не вслепую повторённым PUT или DELETE.
// Поле зависит только от того, что пришло от сервера, и не зависит от метода.
// У безопасных методов оно ни на что не влияет: побочных действий у них нет.
export type CaldavApplied = "no" | "unknown";

export class CaldavError extends Error {
  // applied по умолчанию "unknown": ошибка, созданная без явного знания
  // исхода, ведёт к перечитыванию, а оно безвредно. Обратное умолчание
  // выдало бы возможно применённую запись за недошедшую.
  constructor(
    message: string,
    readonly status: number,
    readonly hint: string,
    readonly applied: CaldavApplied = "unknown",
  ) {
    super(message);
    this.name = "CaldavError";
  }
}

export interface CaldavClient {
  request(options: RequestOptions): Promise<CaldavResponse>;
}

// Повторяются только безопасные методы: они ничего не меняют на сервере,
// и лишняя попытка ничего не портит (RFC 9110 §9.2.1 для GET, HEAD,
// OPTIONS; PROPFIND — RFC 4918 §9.1; REPORT в CalDAV — только чтение).
// PUT и DELETE уходят ровно один раз: повтор условной записи после
// потерянного ответа получал 412 или 404 на собственную же применённую
// первую попытку, и пользователь видел ложный отказ, а при разрезе серии
// терялся хвост (AE7, AE18, AD12 в wave-a-results.json). Прочие методы
// (POST, MKCOL, PROPPATCH…) тоже не повторяются: безопасность не доказана.
const RETRYABLE_METHODS = new Set(["GET", "HEAD", "OPTIONS", "PROPFIND", "REPORT"]);
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

function appliedFor(status: number): CaldavApplied {
  return status >= 400 && status < 500 ? "no" : "unknown";
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

// Класс ошибки «таймаут, 5xx» из раздела 11 спека для безопасных методов:
// сеть или сервер недоступны, повторы исчерпаны. lastStatus — последний
// полученный статус из числа повторяемых (например, 503), либо 0, если
// полного ответа не было ни разу (все попытки упали таймаутом, сетевой
// ошибкой или обрывом тела).
function unavailableError(attempts: number, lastStatus: number): CaldavError {
  const hint = `Сеть или сервер недоступны, повтор выполнен ${attempts} ${timesWord(attempts)}.`;
  return new CaldavError(hint, lastStatus, hint, appliedFor(lastStatus));
}

// Небезопасный запрос (PUT, DELETE…) без внятного ответа: status = 0 —
// ответа нет вовсе, иначе это 5xx. Текст не утверждает ни успеха, ни
// провала: запись могла дойти до сервера.
function unconfirmedError(method: string, status: number): CaldavError {
  const reason =
    status === 0 ? "Сеть или сервер недоступны: ответа на запрос нет." : explain(status);
  const hint = `${reason} Дошла ли запись (${method}) до сервера, неизвестно; автоматически она не повторялась.`;
  return new CaldavError(hint, status, hint, "unknown");
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
      // fetch сам приводит стандартные имена методов к верхнему регистру,
      // так что "put" — тот же PUT и повторяться не должен.
      const method = options.method.toUpperCase();
      const retryable = RETRYABLE_METHODS.has(method);
      const maxAttempts = retryable ? MAX_ATTEMPTS : 1;
      let lastStatus = 0;

      for (let attemptsMade = 1; ; attemptsMade += 1) {
        const isLastAttempt = attemptsMade >= maxAttempts;

        let current: Response;
        try {
          current = await attempt(options);
        } catch {
          // fetch отклоняет промис (а не возвращает Response) на таймауте
          // (AbortSignal.timeout → DOMException) и на сетевых сбоях —
          // DNS/connection refused (TypeError). Это тот же класс ошибок
          // «сеть или сервер недоступны», что и исчерпанные повторы на 5xx.
          if (!retryable) throw unconfirmedError(method, 0);
          if (isLastAttempt) throw unavailableError(attemptsMade, lastStatus);
          continue;
        }

        if (!retryable && current.status >= 500) {
          await discard(current);
          throw unconfirmedError(method, current.status);
        }

        if (retryable && RETRY_STATUSES.has(current.status)) {
          lastStatus = current.status;
          await discard(current);
          if (isLastAttempt) throw unavailableError(attemptsMade, lastStatus);
          continue;
        }

        if (current.status >= 400) {
          const hint = explain(current.status);
          await discard(current);
          throw new CaldavError(hint, current.status, hint, appliedFor(current.status));
        }

        // Тело читается под тем же AbortSignal.timeout и может оборваться
        // уже после статуса. Для записи статус 2xx сам подтверждает, что
        // она применена, и ETag уже есть в заголовках, — тело не нужно,
        // бросать ошибку здесь значило бы выдать применённую запись за
        // сбой. Для чтения обрыв тела — тот же сетевой сбой: повторяем.
        let text: string;
        try {
          text = await current.text();
        } catch {
          if (!retryable) {
            text = "";
          } else {
            if (isLastAttempt) throw unavailableError(attemptsMade, lastStatus);
            continue;
          }
        }
        return { status: current.status, headers: current.headers, text };
      }
    },
  };
}
