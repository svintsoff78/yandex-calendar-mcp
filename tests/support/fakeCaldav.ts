// Изменяемый фейковый CalDAV-сервер «под Яндекс» (§6 плана переделки,
// docs/superpowers/plans/2026-09-19-recurring-events-rework.md, с поправками
// по живой сверке Ж1–Ж18 из docs/yandex-caldav-capabilities.md).
//
// Сервер подключается к настоящему транспорту: createClient(config, fake.fetch)
// (см. tests/support/context.ts), так что весь путь request.ts → objects.ts →
// домен исполняется боевым кодом. Состояние переходит между вызовами само,
// потому что это сервер: то, что записал предыдущий шаг цепочки, видит
// следующий. Статическими затравками задаются только чужие объекты.
//
// Основа — стенды разрушителей прошлых раундов (путь в R13-O4:
// scratchpad/delstand/tests/stand/fakeServer.ts и
// scratchpad/breaker/tests/breaker/stand.ts).
//
// Что умеет:
// - хранилище Map<путь, {etag, ics}>; ETag — голое растущее число (метка
//   времени в мс, как у Яндекса), новое на каждую запись, даже того же текста (Ж12);
// - REPORT: calendar-query по окну отдаёт надмножество — все объекты
//   календаря; по UID — подстроковое совпадение без учёта регистра (худший
//   случай RFC 4791 §9.7.5); calendar-multiget — ровно запрошенные пути;
//   ответ — со смешанными пространствами имён, как у Яндекса: href и status
//   без префикса с xmlns="DAV:", свойства с префиксом D:
//   (tests/fixtures/events-query.xml; docs/yandex-caldav-capabilities.md,
//   «Особенности», п. 3);
// - условные заголовки в двух режимах (`conditions`):
//   "yandex" (по умолчанию) — как на живом Яндексе: If-Match на PUT
//   соблюдается (Ж14), If-None-Match: * не соблюдается (Ж13), If-Match на
//   DELETE не соблюдается (Ж15), PUT с If-Match по отсутствующему пути
//   создаёт объект (Ж16); "rfc" — всё соблюдается и даёт 412;
//   DELETE отсутствующего — 404 в обоих режимах;
// - If-Match совпадает только с голым ETag, как его отдаёт Яндекс («ETag
//   передавать как есть, не добавляя кавычек»); "…" и W/"…" — только при
//   `acceptQuotedEtag`;
// - ETag в ответе на PUT — по умолчанию есть (`etagOnPut`); живая сверка
//   этого не подтверждала, код не вправе на него полагаться: `etagOnPut:
//   false` отвечает без ETag;
// - строгий режим (`strict`, по умолчанию включён): PUT, добавляющий
//   нарушение инвариантов О12а сверх прежней версии объекта, получает 400 и
//   не применяется; два основных компонента, чужой UID, неразбираемый текст
//   и календарь без VEVENT — 400 на любой PUT, даже если они были в прежней
//   версии (ABSOLUTE_KINDS, writeViolations в invariants.ts); сюда же входит
//   грамматика значений времени (`bad-time-value`): строку вроде
//   `DTSTART:1-01-01T00:00:00` ical.js разбирает молча, а сервер и следующее
//   чтение — нет, поэтому она отклоняется на записи; причины — в
//   `rejections` и в записи журнала;
// - история внешних версий (`externalVersions`): затравка и правки другим
//   клиентом, с которыми сверяются инварианты; удаление объекта (клиентом
//   или externalDelete) начинает её заново;
// - крючки: `beforeRequest`, `externalEdit`, `externalDelete`, `loseResponse`,
//   `dropRequest`, `rejectBeforeApply`, `reorderComponents`,
//   `normalizeOnStore`, `seed`, `seedRaw`;
// - журнал `log` всех запросов клиента: метод, путь, заголовки, условия,
//   статус, тело PUT, применён ли запрос, какой крючок сработал.
import ICAL from "ical.js";
import tzdb from "@touch4it/ical-timezones";
import { dateString, instantOfWall, unfold, wallString, writeViolations, type Wall } from "./invariants.js";

export const FAKE_BASE_URL = "https://caldav.fake.test";

// Первая метка ETag: 2026-10-01T09:00:00Z в миллисекундах; каждая запись +1 с.
const FIRST_STAMP_MS = Date.UTC(2026, 9, 1, 9, 0, 0);

export interface StoredObject {
  etag: string;
  ics: string;
}

export type ConditionMode = "yandex" | "rfc";

/** Запрос клиента, как его видят крючки. */
export interface FakeRequest {
  method: string;
  path: string;
  ifMatch?: string;
  ifNoneMatch?: string;
  body: string;
}

export interface LogEntry {
  /** Порядковый номер запроса, с 1. */
  n: number;
  method: string;
  path: string;
  /** Заголовки запроса, имена в нижнем регистре. */
  headers: Record<string, string>;
  ifMatch?: string;
  ifNoneMatch?: string;
  /** Тело PUT — ровно то, что прислал клиент (до нормализации сервером). */
  body?: string;
  /** Код ответа; 0 — ответа не было (сеть, таймаут). */
  status: number;
  /** Изменил ли запрос состояние сервера. */
  applied: boolean;
  /** Какой крючок сбоя сработал. */
  fault?: "lose" | "drop" | "reject";
  /** Причины отказа строгого режима. */
  rejected?: string[];
}

export type RequestMatch =
  | {
      method?: string;
      path?: string | RegExp;
      /** true — только с заголовком If-Match, false — только без него. */
      ifMatch?: boolean;
      /** true — только с заголовком If-None-Match, false — только без него. */
      ifNoneMatch?: boolean;
    }
  | ((request: FakeRequest) => boolean);

export interface FaultOptions {
  /** Сработать на n-м подходящем запросе (с 1), считая от установки крючка. */
  nth?: number;
  /** Сколько раз сработать подряд, начиная с nth; по умолчанию один. */
  times?: number;
}

export interface FaultHandle {
  /** Сколько раз крючок сработал. */
  readonly fired: number;
  /** Сколько подходящих запросов он видел (в том числе после разоружения). */
  readonly seen: number;
  disarm(): void;
}

export type LostAs = "network" | "timeout" | 503 | 504;
export type DroppedAs = "network" | "timeout" | 504;

interface Fault {
  match: RequestMatch;
  action: "lose" | "drop" | "reject";
  as: LostAs | DroppedAs | number;
  nth: number;
  times: number;
  fired: number;
  seen: number;
  armed: boolean;
}

export interface FakeCaldavOptions {
  baseUrl?: string;
  strict?: boolean;
  conditions?: ConditionMode;
  ignoreIfMatch?: boolean;
  caseInsensitiveTextMatch?: boolean;
  /**
   * Считать совпадением с ETag и значение в кавычках ("…", W/"…"). По
   * умолчанию нет: Яндекс отдаёт голый ETag, и код обязан вернуть его как есть.
   */
  acceptQuotedEtag?: boolean;
  etagOnPut?: boolean;
  reorderComponents?: boolean;
  normalizeOnStore?: boolean | ((ics: string, path: string) => string);
  /** Владелец аккаунта: его ORGANIZER сервер добавляет при нормализации (Ж9). */
  owner?: string;
  /** Имена календарей по href — для CATEGORIES при нормализации (Ж8). */
  calendarNames?: Record<string, string>;
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function xmlUnescape(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function uidsOf(ics: string): string[] {
  return [...unfold(ics).matchAll(/^UID(?:;[^:\n]*)?:(.*)$/gim)].map((match) => match[1]);
}

function networkError(as: "network" | "timeout"): Error {
  // Так fetch сообщает о сбое сети (undici: TypeError "fetch failed") и о
  // срабатывании AbortSignal.timeout (DOMException TimeoutError).
  return as === "network"
    ? new TypeError("fetch failed")
    : new DOMException("The operation was aborted due to timeout", "TimeoutError");
}

function basicStamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]|\.\d{3}/g, "");
}

export class FakeCaldav {
  readonly baseUrl: string;
  /** Хранилище: путь → текущая версия. Менять напрямую — только в самопроверке. */
  readonly objects = new Map<string, StoredObject>();
  readonly log: LogEntry[] = [];
  /** Отказы строгого режима: путь и причины. */
  readonly rejections: Array<{ path: string; reasons: string[] }> = [];

  strict: boolean;
  conditions: ConditionMode;
  /** Отрицательный контроль: сервер, который не смотрит на If-Match. */
  ignoreIfMatch: boolean;
  caseInsensitiveTextMatch: boolean;
  /** Совпадает ли If-Match в кавычках ("…", W/"…") с голым ETag. */
  acceptQuotedEtag: boolean;
  /** Присылать ли ETag в ответе на PUT. */
  etagOnPut: boolean;
  /** Отдавать переопределения раньше основного компонента (REPORT и GET). */
  reorderComponents: boolean;
  /** Хранить не присланный текст, а переписанный: true — как Яндекс (yandexNormalize). */
  normalizeOnStore: boolean | ((ics: string, path: string) => string);
  owner: string;
  calendarNames: Record<string, string>;
  /** Вызывается до обработки каждого запроса клиента: место для «другого клиента». */
  beforeRequest?: (request: FakeRequest) => void | Promise<void>;

  private stampMs = FIRST_STAMP_MS;
  private faults: Fault[] = [];
  // Версии, пришедшие извне (затравка, правка другим клиентом): с ними
  // сверяются инварианты — чужие нарушения стенд терпит, новые — нет.
  // С удалением объекта история кончается: объект, созданный потом по тому
  // же пути, наследства не имеет.
  private readonly external = new Map<string, string[]>();

  constructor(options: FakeCaldavOptions = {}) {
    this.baseUrl = options.baseUrl ?? FAKE_BASE_URL;
    this.strict = options.strict ?? true;
    this.conditions = options.conditions ?? "yandex";
    this.ignoreIfMatch = options.ignoreIfMatch ?? false;
    this.caseInsensitiveTextMatch = options.caseInsensitiveTextMatch ?? true;
    this.acceptQuotedEtag = options.acceptQuotedEtag ?? false;
    this.etagOnPut = options.etagOnPut ?? true;
    this.reorderComponents = options.reorderComponents ?? false;
    this.normalizeOnStore = options.normalizeOnStore ?? false;
    this.owner = options.owner ?? "user@yandex.ru";
    this.calendarNames = options.calendarNames ?? {};
  }

  // -------------------------------------------------------------------------
  // Состояние
  // -------------------------------------------------------------------------

  private nextEtag(): string {
    this.stampMs += 1000;
    return String(this.stampMs);
  }

  /** Кладёт разбираемый объект как есть. Для любого текста — seedRaw. */
  seed(path: string, ics: string): string {
    try {
      ICAL.parse(ics);
    } catch (error) {
      throw new Error(`seed: текст не разбирается ical.js (${(error as Error).message}); для такого есть seedRaw`);
    }
    return this.seedRaw(path, ics);
  }

  /** Кладёт любой текст, даже неразбираемый, и отдаёт его дословно. */
  seedRaw(path: string, text: string): string {
    const etag = this.nextEtag();
    this.objects.set(path, { etag, ics: text });
    this.external.set(path, [text]);
    return etag;
  }

  /** Правка «другим клиентом» прямо на сервере: новый ETag, в журнал не пишется. */
  externalEdit(path: string, mutate: (ics: string) => string): string {
    const current = this.objects.get(path);
    if (!current) throw new Error(`externalEdit: по пути ${path} объекта нет`);
    const ics = mutate(current.ics);
    const etag = this.nextEtag();
    this.objects.set(path, { etag, ics });
    this.external.set(path, [...(this.external.get(path) ?? []), ics]);
    return etag;
  }

  /** Удаление «другим клиентом»; история внешних версий пути очищается. */
  externalDelete(path: string): void {
    if (!this.objects.delete(path)) throw new Error(`externalDelete: по пути ${path} объекта нет`);
    this.external.delete(path);
  }

  has(path: string): boolean {
    return this.objects.has(path);
  }

  ics(path: string): string {
    const object = this.objects.get(path);
    if (!object) throw new Error(`по пути ${path} объекта нет`);
    return object.ics;
  }

  etag(path: string): string {
    const object = this.objects.get(path);
    if (!object) throw new Error(`по пути ${path} объекта нет`);
    return object.etag;
  }

  /** Объекты с точно таким UID (сравнение побайтовое). */
  findByUid(uid: string): Array<{ path: string; etag: string; ics: string }> {
    return [...this.objects.entries()]
      .filter(([, object]) => uidsOf(object.ics).includes(uid))
      .map(([path, object]) => ({ path, ...object }));
  }

  /**
   * Версии объекта, пришедшие извне: затравка и правки другим клиентом. После
   * удаления объекта (клиентом или externalDelete) — пусто.
   */
  externalVersions(path: string): string[] {
    return [...(this.external.get(path) ?? [])];
  }

  // -------------------------------------------------------------------------
  // Журнал
  // -------------------------------------------------------------------------

  /** Отметка в журнале: всё, что после неё, отдаёт since/writesSince. */
  mark(): number {
    return this.log.length;
  }

  since(mark: number): LogEntry[] {
    return this.log.slice(mark);
  }

  /** PUT и DELETE клиента после отметки (по умолчанию — все). */
  writes(mark = 0): LogEntry[] {
    return this.since(mark).filter((entry) => entry.method === "PUT" || entry.method === "DELETE");
  }

  writesSince(mark: number): LogEntry[] {
    return this.writes(mark);
  }

  // -------------------------------------------------------------------------
  // Крючки сбоев
  // -------------------------------------------------------------------------

  private addFault(match: RequestMatch, action: Fault["action"], as: Fault["as"], options: FaultOptions): FaultHandle {
    const fault: Fault = {
      match,
      action,
      as,
      nth: options.nth ?? 1,
      times: options.times ?? 1,
      fired: 0,
      seen: 0,
      armed: true,
    };
    this.faults.push(fault);
    return {
      get fired() {
        return fault.fired;
      },
      get seen() {
        return fault.seen;
      },
      disarm: () => {
        fault.armed = false;
      },
    };
  }

  /** Применить запрос, но ответ «потерять»: обрыв сети, таймаут, 503 или 504. */
  loseResponse(match: RequestMatch, as: LostAs = "network", options: FaultOptions = {}): FaultHandle {
    return this.addFault(match, "lose", as, options);
  }

  /** Не применять запрос и ответить 504 (или оборвать сеть, таймаут). */
  dropRequest(match: RequestMatch, as: DroppedAs = 504, options: FaultOptions = {}): FaultHandle {
    return this.addFault(match, "drop", as, options);
  }

  /** Не применять запрос и ответить заданным кодом, например 507. */
  rejectBeforeApply(match: RequestMatch, status: number, options: FaultOptions = {}): FaultHandle {
    return this.addFault(match, "reject", status, options);
  }

  clearFaults(): void {
    this.faults = [];
  }

  private matches(match: RequestMatch, request: FakeRequest): boolean {
    if (typeof match === "function") return match(request);
    if (match.method && match.method.toUpperCase() !== request.method) return false;
    if (typeof match.path === "string" && match.path !== request.path) return false;
    if (match.path instanceof RegExp && !match.path.test(request.path)) return false;
    if (match.ifMatch !== undefined && match.ifMatch !== (request.ifMatch !== undefined)) return false;
    if (match.ifNoneMatch !== undefined && match.ifNoneMatch !== (request.ifNoneMatch !== undefined)) return false;
    return true;
  }

  private pickFault(request: FakeRequest): Fault | undefined {
    let picked: Fault | undefined;
    for (const fault of this.faults) {
      if (!this.matches(fault.match, request)) continue;
      fault.seen += 1;
      if (!picked && fault.armed && fault.seen >= fault.nth && fault.fired < fault.times) {
        fault.fired += 1;
        if (fault.fired >= fault.times) fault.armed = false;
        picked = fault;
      }
    }
    return picked;
  }

  // -------------------------------------------------------------------------
  // HTTP
  // -------------------------------------------------------------------------

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = url.startsWith(this.baseUrl) ? url.slice(this.baseUrl.length) : new URL(url).pathname;
    const method = String(init?.method ?? "GET").toUpperCase();
    const headers = Object.fromEntries(new Headers(init?.headers));
    const body = typeof init?.body === "string" ? init.body : init?.body == null ? "" : await new Response(init.body).text();
    const request: FakeRequest = {
      method,
      path,
      ifMatch: headers["if-match"],
      ifNoneMatch: headers["if-none-match"],
      body,
    };

    await this.beforeRequest?.(request);

    const entry: LogEntry = {
      n: this.log.length + 1,
      method,
      path,
      headers,
      ifMatch: request.ifMatch,
      ifNoneMatch: request.ifNoneMatch,
      status: 0,
      applied: false,
    };
    if (method === "PUT") entry.body = body;
    this.log.push(entry);

    const fault = this.pickFault(request);
    if (fault && fault.action !== "lose") {
      entry.fault = fault.action;
      if (fault.as === "network" || fault.as === "timeout") throw networkError(fault.as);
      entry.status = Number(fault.as);
      return new Response(`fake: ${fault.action}`, { status: entry.status });
    }

    const result = this.handle(request, entry);

    if (fault) {
      entry.fault = "lose";
      if (fault.as === "network" || fault.as === "timeout") {
        entry.status = 0;
        throw networkError(fault.as);
      }
      entry.status = Number(fault.as);
      return new Response("fake: ответ потерян", { status: entry.status });
    }

    entry.status = result.status;
    const noBody = result.status === 204 || result.status === 304;
    return new Response(noBody ? null : result.body ?? "", { status: result.status, headers: result.headers });
  };

  private handle(request: FakeRequest, entry: LogEntry): { status: number; body?: string; headers?: Record<string, string> } {
    switch (request.method) {
      case "REPORT":
        return this.report(request);
      case "GET": {
        const object = this.objects.get(request.path);
        if (!object) return { status: 404 };
        return {
          status: 200,
          body: this.serve(object.ics),
          headers: { ETag: object.etag, "Content-Type": "text/calendar; charset=utf-8" },
        };
      }
      case "PUT":
        return this.put(request, entry);
      case "DELETE":
        return this.delete(request, entry);
      default:
        return { status: 405 };
    }
  }

  private etagMatches(object: StoredObject, header: string): boolean {
    if (header === "*" || header === object.etag) return true;
    return this.acceptQuotedEtag && (header === `"${object.etag}"` || header === `W/"${object.etag}"`);
  }

  private put(request: FakeRequest, entry: LogEntry) {
    const existing = this.objects.get(request.path);
    if (request.ifNoneMatch === "*" && existing && this.conditions === "rfc") return { status: 412 };
    if (request.ifMatch !== undefined) {
      if (!existing) {
        if (this.conditions === "rfc") return { status: 412 };
      } else if (!this.ignoreIfMatch && !this.etagMatches(existing, request.ifMatch)) {
        return { status: 412 };
      }
    }
    if (this.strict) {
      const reasons = writeViolations(request.body, existing ? [existing.ics] : []).map((v) => `${v.kind}: ${v.detail}`);
      if (reasons.length > 0) {
        entry.rejected = reasons;
        this.rejections.push({ path: request.path, reasons });
        return { status: 400, body: `Объект отклонён строгим режимом стенда:\n${reasons.join("\n")}` };
      }
    }
    const etag = this.nextEtag();
    // Новый объект по пустому пути наследства прежнего не имеет.
    if (!existing) this.external.delete(request.path);
    this.objects.set(request.path, { etag, ics: this.storedText(request.body, request.path) });
    entry.applied = true;
    // Ж13: запись поверх существующего объекта с If-None-Match: * Яндекс
    // принимает с ответом 201, как создание.
    const status = existing && request.ifNoneMatch === undefined ? 204 : 201;
    return { status, headers: this.etagOnPut ? { ETag: etag } : undefined };
  }

  private delete(request: FakeRequest, entry: LogEntry) {
    const existing = this.objects.get(request.path);
    if (!existing) return { status: 404 };
    if (
      this.conditions === "rfc" &&
      request.ifMatch !== undefined &&
      !this.ignoreIfMatch &&
      !this.etagMatches(existing, request.ifMatch)
    ) {
      return { status: 412 };
    }
    this.objects.delete(request.path);
    this.external.delete(request.path);
    entry.applied = true;
    return { status: 204 };
  }

  private storedText(body: string, path: string): string {
    if (!this.normalizeOnStore) return body;
    try {
      if (typeof this.normalizeOnStore === "function") return this.normalizeOnStore(body, path);
      return yandexNormalize(body, {
        owner: this.owner,
        calendarName: this.calendarNameFor(path),
        stamp: basicStamp(this.stampMs),
      });
    } catch {
      return body;
    }
  }

  private calendarNameFor(path: string): string | undefined {
    const href = Object.keys(this.calendarNames)
      .filter((prefix) => path.startsWith(prefix))
      .sort((a, b) => b.length - a.length)[0];
    return href === undefined ? undefined : this.calendarNames[href];
  }

  private serve(ics: string): string {
    return this.reorderComponents ? reorderOverridesFirst(ics) : ics;
  }

  private report(request: FakeRequest) {
    const inCollection = [...this.objects.entries()].filter(([href]) => href.startsWith(request.path));
    let selected = inCollection;
    if (/<(?:[\w-]+:)?calendar-multiget[\s>]/.test(request.body)) {
      const hrefs = new Set(
        [...request.body.matchAll(/<(?:[\w-]+:)?href>([^<]*)<\/(?:[\w-]+:)?href>/g)].map((match) => xmlUnescape(match[1].trim())),
      );
      selected = [...this.objects.entries()].filter(([href]) => hrefs.has(href));
    } else {
      const uidMatch =
        /<(?:[\w-]+:)?prop-filter\s+name="UID"[^>]*>\s*<(?:[\w-]+:)?text-match[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?text-match>/i.exec(
          request.body,
        );
      if (uidMatch) {
        const needle = xmlUnescape(uidMatch[1]);
        selected = inCollection.filter(([, object]) =>
          uidsOf(object.ics).some((uid) =>
            this.caseInsensitiveTextMatch ? uid.toLowerCase().includes(needle.toLowerCase()) : uid.includes(needle),
          ),
        );
      }
      // Окно времени не проверяется: отдаётся надмножество, раскрытие и
      // отбор по окну — дело клиента.
    }
    // Разметка — как у Яндекса (tests/fixtures/events-query.xml): href и
    // status без префикса с xmlns="DAV:", остальное с префиксом D:,
    // calendar-data с собственным объявлением C:, всё одной строкой.
    const responses = selected
      .map(
        ([href, object]) =>
          `<D:response><href xmlns="DAV:">${xmlEscape(href)}</href><D:propstat><D:prop>` +
          `<D:getetag>${object.etag}</D:getetag>` +
          `<C:calendar-data xmlns:C="urn:ietf:params:xml:ns:caldav">${xmlEscape(this.serve(object.ics))}</C:calendar-data>` +
          `</D:prop><status xmlns="DAV:">HTTP/1.1 200 OK</status></D:propstat></D:response>`,
      )
      .join("");
    return {
      status: 207,
      body: `<?xml version='1.0' encoding='utf-8'?>\n<D:multistatus xmlns:D="DAV:">${responses}</D:multistatus>`,
      headers: { "Content-Type": "application/xml; charset=utf-8" },
    };
  }
}

// ---------------------------------------------------------------------------
// Порядок компонентов
// ---------------------------------------------------------------------------

/**
 * Переставляет компоненты VCALENDAR: сначала переопределения (VEVENT с
 * RECURRENCE-ID), потом основные VEVENT, потом остальные (VTIMEZONE…).
 * Работает по тексту: байты каждого компонента, включая переносы строк,
 * сохраняются.
 */
export function reorderOverridesFirst(ics: string): string {
  const eol = ics.includes("\r\n") ? "\r\n" : "\n";
  const physical = ics.split(/\r?\n/);
  const trailing = physical.at(-1) === "";
  if (trailing) physical.pop();
  const lines: string[] = [];
  for (const line of physical) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && lines.length > 0) lines[lines.length - 1] += eol + line;
    else lines.push(line);
  }

  let depth = 0;
  let begin: string | undefined;
  let end: string | undefined;
  const calendarProps: string[] = [];
  const blocks: string[][] = [];
  let current: string[] | undefined;
  for (const line of lines) {
    const upper = line.toUpperCase();
    if (upper.startsWith("BEGIN:")) {
      depth += 1;
      if (depth === 1) begin = line;
      else {
        if (depth === 2) current = [];
        current?.push(line);
      }
      continue;
    }
    if (upper.startsWith("END:")) {
      if (depth === 1) end = line;
      else {
        current?.push(line);
        if (depth === 2 && current) {
          blocks.push(current);
          current = undefined;
        }
      }
      depth -= 1;
      continue;
    }
    if (depth === 1) calendarProps.push(line);
    else current?.push(line);
  }
  if (!begin || !end) return ics;

  const kind = (block: string[]) => {
    if (!block[0].toUpperCase().startsWith("BEGIN:VEVENT")) return 2;
    return block.some((line) => line.toUpperCase().startsWith("RECURRENCE-ID")) ? 0 : 1;
  };
  const ordered = [...blocks].sort((a, b) => kind(a) - kind(b));
  const out = [begin, ...calendarProps, ...ordered.flat(), end].join(eol);
  return trailing ? out + eol : out;
}

// ---------------------------------------------------------------------------
// Нормализация «как Яндекс» (Ж2, Ж5–Ж10)
// ---------------------------------------------------------------------------

type JProp = [string, Record<string, unknown>, string, ...unknown[]];
type JComp = [string, JProp[], JComp[]];

export interface YandexNormalizeOptions {
  /** Владелец аккаунта: ORGANIZER, если его нет (Ж9). */
  owner?: string;
  /** Имя календаря: им перезаписываются CATEGORIES (Ж8). */
  calendarName?: string;
  /** Метка сервера для CREATED и LAST-MODIFIED, вида 20261002T100000Z. */
  stamp?: string;
  /** Превратить COUNT в UNTIL последней позиции (Ж5: «COUNT может превратиться в UNTIL»). */
  countToUntil?: boolean;
}

const RULE_ORDER = [
  "freq",
  "until",
  "count",
  "interval",
  "bysecond",
  "byminute",
  "byhour",
  "byday",
  "bymonthday",
  "byyearday",
  "byweekno",
  "bymonth",
  "bysetpos",
];
const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

function jcalStamp(basic: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(basic);
  if (!m) throw new Error(`метка ${basic} не вида 20261002T100000Z`);
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
}

function hasProp(component: JComp, name: string): boolean {
  return component[1].some((prop) => prop[0] === name);
}

// UNTIL последней позиции правила с COUNT, в форме О4. Позиции — из
// итератора ical.js (lib/ical/recur.js:280, lib/ical/recur_iterator.js:386).
function untilForCount(root: ICAL.Component, event: ICAL.Component, rule: ICAL.Recur): string | undefined {
  const dtstart = event.getFirstProperty("dtstart");
  const start = dtstart?.getFirstValue() as ICAL.Time | undefined;
  if (!dtstart || !start || !rule.count) return undefined;
  const iterator = rule.iterator(start);
  let last: Wall | undefined;
  for (let i = 0; i < 200_000; i += 1) {
    const next = iterator.next();
    if (!next) break;
    last = { year: next.year, month: next.month, day: next.day, hour: next.hour, minute: next.minute, second: next.second };
  }
  if (!last) return undefined;
  if (start.isDate) return dateString(last);
  const raw = dtstart.jCal[3] as string;
  const tzid = dtstart.getParameter("tzid") as string | undefined;
  if (raw.endsWith("Z")) return `${wallString(last)}Z`;
  if (!tzid) return wallString(last);
  const ms = instantOfWall(last, tzid, root);
  return ms === undefined ? undefined : `${new Date(ms).toISOString().slice(0, 19)}Z`;
}

/**
 * Переписывает объект так, как, по живой сверке, его хранит Яндекс:
 * основной компонент первым (Ж2); части RRULE в порядке сервера, INTERVAL=1
 * добавлен, у WEEKLY без BYDAY — день недели DTSTART, WKST выброшен (Ж5, Ж6);
 * X-свойства вырезаны, кроме X-TELEMOST-CONFERENCE (Ж7); CATEGORIES — имя
 * календаря (Ж8); ORGANIZER владельца, CREATED, LAST-MODIFIED, CLASS,
 * CALSCALE, METHOD добавлены (Ж9); VTIMEZONE заменён описанием из базы IANA
 * (Ж10); SEQUENCE не трогается (Ж11). Порядок частей RRULE выбран стендом:
 * дословный порядок Яндекса сверкой не снят. Результат сериализуется ical.js
 * (CRLF, переносы по 75 октетов).
 */
export function yandexNormalize(ics: string, options: YandexNormalizeOptions = {}): string {
  const jcal = ICAL.parse(ics) as unknown as JComp;
  const stamp = jcalStamp(options.stamp ?? basicStamp(FIRST_STAMP_MS));

  // Проход только для чтения — по копии, чтобы гидратация ical.js не
  // трогала массивы, которые правятся ниже.
  const untils = new Map<string, string>();
  if (options.countToUntil) {
    const readRoot = new ICAL.Component(structuredClone(jcal) as unknown as unknown[]);
    readRoot.getAllSubcomponents("vevent").forEach((event, eventIndex) => {
      event.getAllProperties("rrule").forEach((prop, ruleIndex) => {
        const until = untilForCount(readRoot, event, prop.getFirstValue() as ICAL.Recur);
        if (until) untils.set(`${eventIndex}/${ruleIndex}`, until);
      });
    });
  }

  const [, calendarProps, components] = jcal;
  if (!calendarProps.some((prop) => prop[0] === "calscale")) calendarProps.push(["calscale", {}, "text", "GREGORIAN"]);
  if (!calendarProps.some((prop) => prop[0] === "method")) calendarProps.push(["method", {}, "text", "PUBLISH"]);

  const zones = components.filter((c) => c[0] === "vtimezone").map((zone) => {
    const tzid = zone[1].find((prop) => prop[0] === "tzid")?.[3];
    const text = typeof tzid === "string" ? tzdb.getVtimezoneComponent(tzid) : undefined;
    if (!text) return zone;
    const wrapped = ICAL.parse(`BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${text.trim()}\r\nEND:VCALENDAR\r\n`) as unknown as JComp;
    return wrapped[2].find((c) => c[0] === "vtimezone") ?? zone;
  });

  const events = components.filter((c) => c[0] === "vevent");
  events.forEach((event, eventIndex) => {
    let props = event[1].filter((prop) => !prop[0].startsWith("x-") || prop[0] === "x-telemost-conference");
    if (options.calendarName !== undefined && props.some((prop) => prop[0] === "categories")) {
      const first = props.findIndex((prop) => prop[0] === "categories");
      props = props.filter((prop, i) => prop[0] !== "categories" || i === first);
      props[first] = ["categories", {}, "text", options.calendarName];
    }
    const dtstart = props.find((prop) => prop[0] === "dtstart");
    let ruleIndex = 0;
    props = props.map((prop) => {
      if (prop[0] !== "rrule" || typeof prop[3] !== "object" || prop[3] === null) return prop;
      const rule = { ...(prop[3] as Record<string, unknown>) };
      delete rule.wkst;
      if (rule.interval === undefined) rule.interval = 1;
      if (rule.freq === "WEEKLY" && rule.byday === undefined && typeof dtstart?.[3] === "string") {
        const [y, m, d] = (dtstart[3] as string).slice(0, 10).split("-").map(Number);
        rule.byday = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
      }
      const until = untils.get(`${eventIndex}/${ruleIndex}`);
      ruleIndex += 1;
      if (until) {
        delete rule.count;
        rule.until = until;
      }
      const ordered: Record<string, unknown> = {};
      for (const key of RULE_ORDER) if (key in rule) ordered[key] = rule[key];
      for (const key of Object.keys(rule)) if (!(key in ordered)) ordered[key] = rule[key];
      return [prop[0], prop[1], prop[2], ordered] as JProp;
    });
    props = props.filter((prop) => prop[0] !== "last-modified");
    props.push(["last-modified", {}, "date-time", stamp]);
    if (!props.some((prop) => prop[0] === "created")) props.push(["created", {}, "date-time", stamp]);
    if (!props.some((prop) => prop[0] === "class")) props.push(["class", {}, "text", "PUBLIC"]);
    if (options.owner && !props.some((prop) => prop[0] === "organizer")) {
      props.push(["organizer", {}, "cal-address", `mailto:${options.owner}`]);
    }
    event[1] = props;
  });

  const masters = events.filter((event) => !hasProp(event, "recurrence-id"));
  const overrides = events.filter((event) => hasProp(event, "recurrence-id"));
  const rest = components.filter((c) => c[0] !== "vtimezone" && c[0] !== "vevent");
  jcal[2] = [...zones, ...masters, ...overrides, ...rest];
  return ICAL.stringify(jcal as unknown as unknown[]);
}
