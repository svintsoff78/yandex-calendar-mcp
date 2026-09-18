# MCP-сервер для Яндекс Календаря — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** MCP-сервер на TypeScript, дающий Claude полный доступ к Яндекс Календарю через собственный CalDAV-клиент.

**Architecture:** Четыре слоя. `caldav/` говорит по протоколу поверх `fetch`. `ical/` переводит VEVENT в доменный объект и обратно, используя `ical.js`. `domain/` выполняет операции и ничего не знает про MCP. `mcp/` описывает инструменты и ничего не знает про CalDAV. Транспорт stdio, один аккаунт, секреты из окружения.

**Tech Stack:** TypeScript 5, Node 26, `@modelcontextprotocol/sdk`, `ical.js`, `fast-xml-parser`, `zod`, `vitest`.

**Spec:** `docs/superpowers/specs/2026-09-18-yandex-calendar-mcp-design.md`

## Global Constraints

- Node 20 и выше; разработка ведётся на Node 26.5.1.
- Модули ESM: в `package.json` стоит `"type": "module"`, импорты внутри `src/` пишутся с расширением `.js`.
- Пароль приложения не попадает ни в один лог, текст ошибки или ответ инструмента. Проверяется отдельным тестом в задаче 3.
- Времена на границе инструментов — ISO 8601 со смещением, например `2026-09-21T10:00:00+03:00`.
- Внутри iCalendar используется `DTSTART;TZID=<зона>` с вложенным VTIMEZONE. Перевод всего в UTC запрещён: правило повтора уедет на час при переходе времени.
- Повторы раскрываются локально, серверное `<C:expand>` не используется.
- Все записи в календарь идут с условными заголовками: `If-None-Match: *` при создании, `If-Match: <etag>` при обновлении и удалении.
- Тесты, требующие сети, помечаются `describe.skip` и снабжаются комментарием о том, как их запустить вручную.
- Разработка по TDD: сначала падающий тест, потом минимальная реализация.
- Коммит после каждой задачи.
- Базовый URL по умолчанию `https://caldav.yandex.ru`.

## Структура файлов

| Файл | Ответственность |
|---|---|
| `src/config.ts` | Чтение и валидация переменных окружения |
| `src/caldav/request.ts` | HTTP: Basic-авторизация, таймауты, повторы, вырезание пароля |
| `src/caldav/xml.ts` | Сборка тел PROPFIND и REPORT, разбор multistatus |
| `src/caldav/discovery.ts` | Principal → calendar-home-set → список календарей |
| `src/caldav/objects.ts` | calendar-query, multiget, PUT, DELETE |
| `src/ical/parse.ts` | VEVENT → Event |
| `src/ical/build.ts` | Event → VEVENT с TZID и VTIMEZONE |
| `src/ical/expand.ts` | Раскрытие повторов в окне времени |
| `src/types.ts` | Доменные типы: Event, Calendar, Recurrence |
| `src/domain/calendars.ts` | Операции над календарями |
| `src/domain/events.ts` | Операции над событиями |
| `src/domain/freeSlots.ts` | Поиск свободных окон |
| `src/mcp/server.ts` | Сборка сервера, транспорт stdio |
| `src/mcp/tools/*.ts` | По файлу на инструмент: схема, вызов domain, формат ответа |
| `tests/fixtures/*.xml`, `*.ics` | Записанные ответы Яндекса и события |

---

## Task 1: Проверка возможностей сервера и запись фикстур

Единственная задача, требующая живого аккаунта. Её результат — файлы фикстур,
на которых будут построены все последующие тесты, поэтому она идёт первой.

**Требуется от пользователя:** пароль приложения Яндекса. Заводится в
Яндекс ID → Безопасность → Пароли приложений → тип «Календарь». Пароль
задаётся в окружении командой `export YANDEX_LOGIN=...` и
`export YANDEX_APP_PASSWORD=...` в том же терминале; в файлы он не пишется.

**Files:**
- Create: `tests/fixtures/README.md`
- Create: `tests/fixtures/principal.xml`
- Create: `tests/fixtures/home.xml`
- Create: `tests/fixtures/calendars.xml`
- Create: `tests/fixtures/events-query.xml`
- Create: `docs/yandex-caldav-capabilities.md`

**Interfaces:**
- Consumes: ничего
- Produces: файлы фикстур для задач 4, 5, 6, 7, 8, 9

- [ ] **Step 1: Узнать, что сервер вообще отвечает**

```bash
curl -s -i -u "$YANDEX_LOGIN:$YANDEX_APP_PASSWORD" \
  -X OPTIONS https://caldav.yandex.ru/ | head -30
```

Ожидается: `HTTP/1.1 200`, заголовок `DAV:` со списком классов (в нём должно
быть `calendar-access`) и заголовок `Allow` с методами. Ответ 401 означает,
что пароль приложения не подошёл — обычный пароль от аккаунта здесь не работает.

Сохранить вывод в `docs/yandex-caldav-capabilities.md` под заголовком `## OPTIONS /`.

- [ ] **Step 2: Найти principal**

```bash
curl -s -u "$YANDEX_LOGIN:$YANDEX_APP_PASSWORD" \
  -X PROPFIND -H 'Depth: 0' -H 'Content-Type: application/xml' \
  --data '<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>' \
  https://caldav.yandex.ru/ > tests/fixtures/principal.xml
cat tests/fixtures/principal.xml
```

Ожидается XML с `<d:current-user-principal><d:href>/principals/users/...`.
Путь из `href` понадобится на следующем шаге.

- [ ] **Step 3: Найти дом календарей**

```bash
PRINCIPAL=<href из шага 2>
curl -s -u "$YANDEX_LOGIN:$YANDEX_APP_PASSWORD" \
  -X PROPFIND -H 'Depth: 0' -H 'Content-Type: application/xml' \
  --data '<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
<d:prop><c:calendar-home-set/></d:prop></d:propfind>' \
  "https://caldav.yandex.ru$PRINCIPAL" > tests/fixtures/home.xml
cat tests/fixtures/home.xml
```

- [ ] **Step 4: Получить список календарей**

```bash
HOME=<href из шага 3>
curl -s -u "$YANDEX_LOGIN:$YANDEX_APP_PASSWORD" \
  -X PROPFIND -H 'Depth: 1' -H 'Content-Type: application/xml' \
  --data '<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"
            xmlns:ic="http://apple.com/ns/ical/">
<d:prop>
  <d:displayname/><d:resourcetype/><d:current-user-privilege-set/>
  <c:supported-calendar-component-set/><c:calendar-timezone/><ic:calendar-color/>
</d:prop></d:propfind>' \
  "https://caldav.yandex.ru$HOME" > tests/fixtures/calendars.xml
cat tests/fixtures/calendars.xml
```

Записать в `docs/yandex-caldav-capabilities.md`: сколько календарей вернулось,
какие свойства реально присутствуют, а какие сервер молча опустил.
Пропущенные свойства — это не ошибка, а факт, который учтёт задача 4.

- [ ] **Step 5: Прочитать события за месяц**

```bash
CAL=<href одного календаря из шага 4>
curl -s -u "$YANDEX_LOGIN:$YANDEX_APP_PASSWORD" \
  -X REPORT -H 'Depth: 1' -H 'Content-Type: application/xml' \
  --data '<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
<d:prop><d:getetag/><c:calendar-data/></d:prop>
<c:filter><c:comp-filter name="VCALENDAR">
<c:comp-filter name="VEVENT">
<c:time-range start="20260901T000000Z" end="20261001T000000Z"/>
</c:comp-filter></c:comp-filter></c:filter></c:calendar-query>' \
  "https://caldav.yandex.ru$CAL" > tests/fixtures/events-query.xml
head -60 tests/fixtures/events-query.xml
```

- [ ] **Step 6: Проверить, поддерживается ли серверное раскрытие повторов**

Тот же запрос, но вместо `<c:calendar-data/>` подставить:

```xml
<c:calendar-data>
  <c:expand start="20260901T000000Z" end="20261001T000000Z"/>
</c:calendar-data>
```

Записать в `docs/yandex-caldav-capabilities.md` результат: пришли ли раскрытые
экземпляры или сервер вернул ошибку. На реализацию это не влияет — раскрываем
локально в любом случае — но факт стоит зафиксировать.

- [ ] **Step 7: Обезличить фикстуры**

В сохранённых XML заменить настоящий логин на `user@yandex.ru`, а заголовки
и описания личных событий — на нейтральные. Фикстуры лежат в репозитории,
и настоящих данных в них быть не должно.

```bash
sed -i '' "s/$YANDEX_LOGIN/user@yandex.ru/g" tests/fixtures/*.xml
grep -c "$YANDEX_LOGIN" tests/fixtures/*.xml || echo "логин вычищен"
```

- [ ] **Step 8: Описать фикстуры**

Создать `tests/fixtures/README.md` с таблицей: имя файла, каким запросом получен,
что в нём проверяется. Один абзац на файл.

- [ ] **Step 9: Обновить раздел 4 спека**

Открыть `docs/superpowers/specs/2026-09-18-yandex-calendar-mcp-design.md`,
раздел «Ограничения Яндекс CalDAV». Заменить формулировки «под вопросом» на
установленные факты со ссылкой на `docs/yandex-caldav-capabilities.md`.

- [ ] **Step 10: Commit**

```bash
git add tests/fixtures docs/yandex-caldav-capabilities.md docs/superpowers/specs
git commit -m "Проверка возможностей CalDAV Яндекса, фикстуры для тестов"
```

---

## Task 2: Каркас проекта и конфигурация

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`
- Create: `src/config.ts`
- Test: `tests/config.test.ts`

**Interfaces:**
- Consumes: ничего
- Produces: `loadConfig(env: NodeJS.ProcessEnv): Config`, где
  `Config = { login: string; appPassword: string; defaultTimeZone: string; baseUrl: string }`

- [ ] **Step 1: Завести проект**

```bash
npm init -y
npm pkg set type=module name=yandex-calendar-mcp version=0.1.0
npm install @modelcontextprotocol/sdk ical.js fast-xml-parser zod
npm install -D typescript vitest @types/node tsx
npm pkg set scripts.test=vitest scripts.build="tsc -p ."
```

- [ ] **Step 2: Настроить TypeScript**

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "outDir": "dist",
    "rootDir": "src",
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts"]
}
```

`vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["tests/**/*.test.ts"] },
});
```

- [ ] **Step 3: Написать падающий тест конфигурации**

`tests/config.test.ts`:

```ts
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
```

- [ ] **Step 4: Убедиться, что тест падает**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL, модуль `../src/config.js` не найден.

- [ ] **Step 5: Реализовать конфигурацию**

`src/config.ts`:

```ts
import { z } from "zod";

const schema = z.object({
  YANDEX_LOGIN: z.string().min(1, "YANDEX_LOGIN обязателен: полный адрес вида name@yandex.ru"),
  YANDEX_APP_PASSWORD: z.string().min(1, "YANDEX_APP_PASSWORD обязателен: пароль приложения из Яндекс ID"),
  YANDEX_DEFAULT_TZ: z.string().min(1, "YANDEX_DEFAULT_TZ обязателен, например Europe/Moscow"),
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
```

Текст ошибки собирается только из сообщений схемы и никогда не включает значения,
поэтому пароль в него не попадает.

- [ ] **Step 6: Убедиться, что тесты проходят**

Run: `npx vitest run tests/config.test.ts`
Expected: PASS, три теста.

- [ ] **Step 7: Проверить, что MCP SDK ставится и заводится**

`src/mcp/server.ts` — временный каркас, который в задаче 10 обрастёт инструментами:

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "../config.js";

export async function main(): Promise<void> {
  loadConfig(process.env);
  const server = new McpServer({ name: "yandex-calendar", version: "0.1.0" });
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  console.error(String(error));
  process.exit(1);
});
```

```bash
YANDEX_LOGIN=user@yandex.ru YANDEX_APP_PASSWORD=x YANDEX_DEFAULT_TZ=Europe/Moscow \
  npx tsx src/mcp/server.ts < /dev/null
```

Ожидается: процесс завершается без ошибок. Если `McpServer` или
`StdioServerTransport` не найдены по этим путям, значит установленная версия SDK
экспортирует их иначе — посмотреть `node_modules/@modelcontextprotocol/sdk/README.md`
и поправить импорты здесь же. Это единственное место в плане, где встречается
API SDK, дальше он используется только через задачу 10.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts src tests
git commit -m "Каркас проекта и конфигурация из окружения"
```

---

## Task 3: HTTP-слой CalDAV

**Files:**
- Create: `src/caldav/request.ts`
- Test: `tests/caldav/request.test.ts`

**Interfaces:**
- Consumes: `Config` из задачи 2
- Produces:
  - `createClient(config: Config, fetchImpl?: typeof fetch): CaldavClient`
  - `interface CaldavClient { request(options: RequestOptions): Promise<CaldavResponse> }`
  - `interface RequestOptions { method: string; path: string; body?: string; headers?: Record<string, string>; depth?: "0" | "1" }`
  - `interface CaldavResponse { status: number; headers: Headers; text: string }`
  - `class CaldavError extends Error { readonly status: number; readonly hint: string }`

- [ ] **Step 1: Написать падающие тесты**

`tests/caldav/request.test.ts`:

```ts
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
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `npx vitest run tests/caldav/request.test.ts`
Expected: FAIL, модуль не найден.

- [ ] **Step 3: Реализовать слой**

`src/caldav/request.ts`:

```ts
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
```

Тело ответа при ошибке намеренно не подмешивается в сообщение: именно так пароль
или чужие данные не утекут в текст, который увидит модель.

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `npx vitest run tests/caldav/request.test.ts`
Expected: PASS, пять тестов.

- [ ] **Step 5: Commit**

```bash
git add src/caldav/request.ts tests/caldav/request.test.ts
git commit -m "HTTP-слой CalDAV: авторизация, повторы, понятные ошибки"
```

---

## Task 4: Разбор и сборка XML

**Files:**
- Create: `src/caldav/xml.ts`
- Test: `tests/caldav/xml.test.ts`

**Interfaces:**
- Consumes: фикстуры из задачи 1
- Produces:
  - `buildPropfind(props: string[]): string`
  - `buildCalendarQuery(from: Date, to: Date): string`
  - `interface MultistatusEntry { href: string; status: number; props: Record<string, unknown> }`
  - `parseMultistatus(xml: string): MultistatusEntry[]`
  - `toIcalUtc(date: Date): string`

- [ ] **Step 1: Написать падающие тесты**

`tests/caldav/xml.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildCalendarQuery,
  buildPropfind,
  parseMultistatus,
  toIcalUtc,
} from "../../src/caldav/xml.js";

const fixture = (name: string) => readFileSync(`tests/fixtures/${name}`, "utf8");

describe("toIcalUtc", () => {
  it("переводит дату в базовый формат iCalendar", () => {
    expect(toIcalUtc(new Date("2026-09-18T07:05:00Z"))).toBe("20260918T070500Z");
  });
});

describe("buildPropfind", () => {
  it("собирает тело с запрошенными свойствами", () => {
    const xml = buildPropfind(["d:displayname", "c:calendar-home-set"]);
    expect(xml).toContain("<d:displayname/>");
    expect(xml).toContain("<c:calendar-home-set/>");
    expect(xml).toContain('xmlns:c="urn:ietf:params:xml:ns:caldav"');
  });
});

describe("buildCalendarQuery", () => {
  it("кладёт окно времени в фильтр VEVENT", () => {
    const xml = buildCalendarQuery(
      new Date("2026-09-01T00:00:00Z"),
      new Date("2026-10-01T00:00:00Z"),
    );
    expect(xml).toContain('name="VEVENT"');
    expect(xml).toContain('start="20260901T000000Z"');
    expect(xml).toContain('end="20261001T000000Z"');
  });
});

describe("parseMultistatus", () => {
  it("разбирает список календарей из настоящего ответа Яндекса", () => {
    const entries = parseMultistatus(fixture("calendars.xml"));
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0].href).toMatch(/^\//);
  });

  it("возвращает principal из ответа на PROPFIND", () => {
    const entries = parseMultistatus(fixture("principal.xml"));
    const principal = entries[0].props["current-user-principal"];
    expect(JSON.stringify(principal)).toContain("href");
  });

  it("сохраняет статус каждого propstat, а не только общий", () => {
    const xml = `<?xml version="1.0"?>
      <d:multistatus xmlns:d="DAV:">
        <d:response>
          <d:href>/calendars/x/</d:href>
          <d:propstat>
            <d:prop><d:displayname>Работа</d:displayname></d:prop>
            <d:status>HTTP/1.1 200 OK</d:status>
          </d:propstat>
          <d:propstat>
            <d:prop><d:getctag/></d:prop>
            <d:status>HTTP/1.1 404 Not Found</d:status>
          </d:propstat>
        </d:response>
      </d:multistatus>`;
    const entries = parseMultistatus(xml);
    expect(entries).toHaveLength(1);
    expect(entries[0].props.displayname).toBe("Работа");
    expect(entries[0].props.getctag).toBeUndefined();
  });
});
```

Последний тест закрывает реальный случай: Яндекс отвечает 404 на свойства,
которых у него нет, и они не должны попадать в разобранный результат.

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `npx vitest run tests/caldav/xml.test.ts`
Expected: FAIL, модуль не найден.

- [ ] **Step 3: Реализовать**

`src/caldav/xml.ts`:

```ts
import { XMLParser } from "fast-xml-parser";

const NS =
  'xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:ic="http://apple.com/ns/ical/"';

export function toIcalUtc(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

export function buildPropfind(props: string[]): string {
  const body = props.map((name) => `<${name}/>`).join("");
  return `<?xml version="1.0" encoding="utf-8"?>
<d:propfind ${NS}><d:prop>${body}</d:prop></d:propfind>`;
}

export function buildCalendarQuery(from: Date, to: Date): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query ${NS}>
  <d:prop><d:getetag/><c:calendar-data/></d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT">
        <c:time-range start="${toIcalUtc(from)}" end="${toIcalUtc(to)}"/>
      </c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`;
}

export interface MultistatusEntry {
  href: string;
  status: number;
  props: Record<string, unknown>;
}

const parser = new XMLParser({
  removeNSPrefix: true,
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  parseTagValue: false,
});

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function statusCode(text: unknown): number {
  const match = /\s(\d{3})\s/.exec(` ${String(text)} `);
  return match ? Number(match[1]) : 0;
}

export function parseMultistatus(xml: string): MultistatusEntry[] {
  const parsed = parser.parse(xml) as Record<string, any>;
  const responses = asArray(parsed?.multistatus?.response);

  return responses.map((response) => {
    const props: Record<string, unknown> = {};
    let entryStatus = 200;

    for (const propstat of asArray(response.propstat)) {
      const code = statusCode(propstat.status);
      if (code >= 400) continue;
      entryStatus = code || entryStatus;
      Object.assign(props, propstat.prop ?? {});
    }

    for (const [key, value] of Object.entries(props)) {
      if (value === "" || value === null) delete props[key];
    }

    return { href: String(response.href ?? ""), status: entryStatus, props };
  });
}
```

`removeNSPrefix` снимает префиксы `d:` и `c:`, поэтому дальше по коду свойства
называются просто `displayname`, `calendar-data`, `getetag`.

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `npx vitest run tests/caldav/xml.test.ts`
Expected: PASS, шесть тестов. Если тесты на фикстурах падают из-за структуры,
отличной от ожидаемой, поправить парсер под то, что реально прислал Яндекс,
а не подгонять фикстуру.

- [ ] **Step 5: Commit**

```bash
git add src/caldav/xml.ts tests/caldav/xml.test.ts
git commit -m "Сборка запросов и разбор multistatus"
```

---

## Task 5: Доменные типы и обнаружение календарей

**Files:**
- Create: `src/types.ts`
- Create: `src/caldav/discovery.ts`
- Test: `tests/caldav/discovery.test.ts`

**Interfaces:**
- Consumes: `CaldavClient` (задача 3), `parseMultistatus`, `buildPropfind` (задача 4)
- Produces:
  - весь `src/types.ts` — используется всеми последующими задачами
  - `discoverCalendars(client: CaldavClient): Promise<Calendar[]>`
  - `resolveHome(client: CaldavClient): Promise<string>`

- [ ] **Step 1: Определить доменные типы**

`src/types.ts` — единственное место, где живут типы; все последующие задачи
импортируют отсюда и ничего не переопределяют:

```ts
import type { CaldavClient } from "./caldav/request.js";
import type { Config } from "./config.js";

export interface Calendar {
  id: string;
  href: string;
  displayName: string;
  color?: string;
  timeZone?: string;
  readOnly: boolean;
}

export type RecurrenceFrequency = "daily" | "weekly" | "monthly" | "yearly";

export interface Recurrence {
  frequency: RecurrenceFrequency;
  interval: number;
  byWeekday?: Array<"MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU">;
  until?: string;
  count?: number;
}

export interface Reminder {
  minutesBefore: number;
  method: "display" | "email";
}

export interface Attendee {
  email: string;
  status: "accepted" | "declined" | "tentative" | "needs-action";
}

export interface CalendarEvent {
  id: string;
  calendarId: string;
  summary: string;
  description?: string;
  location?: string;
  start: string;
  end: string;
  timeZone: string;
  allDay: boolean;
  recurrence?: Recurrence;
  reminders: Reminder[];
  attendees: Attendee[];
  etag?: string;
  href?: string;
  instanceStart?: string;
  seriesId?: string;
}

export interface Context {
  client: CaldavClient;
  config: Config;
  discover(): Promise<Calendar[]>;
  calendars(): Promise<Calendar[]>;
  resolveCalendar(idOrName?: string): Promise<Calendar>;
}

export type EditScope = "this" | "this_and_following" | "all_series";
```

`instanceStart` и `seriesId` заполняются только у раскрытых экземпляров
повторяющихся событий, у обычных они отсутствуют.

- [ ] **Step 2: Написать падающие тесты обнаружения**

`tests/caldav/discovery.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { discoverCalendars } from "../../src/caldav/discovery.js";
import type { CaldavClient } from "../../src/caldav/request.js";

const fixture = (name: string) => readFileSync(`tests/fixtures/${name}`, "utf8");

function clientReturning(...bodies: string[]): CaldavClient {
  const request = vi.fn();
  for (const text of bodies) {
    request.mockResolvedValueOnce({ status: 207, headers: new Headers(), text });
  }
  return { request } as unknown as CaldavClient;
}

describe("discoverCalendars", () => {
  it("проходит цепочку principal → home → календари", async () => {
    const client = clientReturning(
      fixture("principal.xml"),
      fixture("home.xml"),
      fixture("calendars.xml"),
    );

    const calendars = await discoverCalendars(client);

    expect(calendars.length).toBeGreaterThan(0);
    expect(calendars[0].displayName).toBeTruthy();
    expect(calendars[0].href).toMatch(/^\//);
  });

  it("отбрасывает коллекции, не являющиеся календарями", async () => {
    const home = `<?xml version="1.0"?>
      <d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
        <d:response>
          <d:href>/calendars/user/</d:href>
          <d:propstat><d:prop>
            <d:displayname>Корень</d:displayname>
            <d:resourcetype><d:collection/></d:resourcetype>
          </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
        </d:response>
        <d:response>
          <d:href>/calendars/user/work/</d:href>
          <d:propstat><d:prop>
            <d:displayname>Работа</d:displayname>
            <d:resourcetype><d:collection/><c:calendar/></d:resourcetype>
          </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
        </d:response>
      </d:multistatus>`;
    const client = clientReturning(fixture("principal.xml"), fixture("home.xml"), home);

    const calendars = await discoverCalendars(client);

    expect(calendars).toHaveLength(1);
    expect(calendars[0].displayName).toBe("Работа");
  });

  it("помечает календарь только для чтения, если нет привилегии записи", async () => {
    const home = `<?xml version="1.0"?>
      <d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
        <d:response>
          <d:href>/calendars/user/holidays/</d:href>
          <d:propstat><d:prop>
            <d:displayname>Праздники</d:displayname>
            <d:resourcetype><d:collection/><c:calendar/></d:resourcetype>
            <d:current-user-privilege-set>
              <d:privilege><d:read/></d:privilege>
            </d:current-user-privilege-set>
          </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
        </d:response>
      </d:multistatus>`;
    const client = clientReturning(fixture("principal.xml"), fixture("home.xml"), home);

    const calendars = await discoverCalendars(client);

    expect(calendars[0].readOnly).toBe(true);
  });
});
```

- [ ] **Step 3: Убедиться, что тесты падают**

Run: `npx vitest run tests/caldav/discovery.test.ts`
Expected: FAIL, модуль не найден.

- [ ] **Step 4: Реализовать обнаружение**

`src/caldav/discovery.ts`:

```ts
import type { CaldavClient } from "./request.js";
import { buildPropfind, parseMultistatus } from "./xml.js";
import type { Calendar } from "../types.js";

function firstHref(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") return value;
  const record = value as Record<string, unknown>;
  if (typeof record.href === "string") return record.href;
  if (Array.isArray(record.href) && typeof record.href[0] === "string") return record.href[0];
  return undefined;
}

export async function resolvePrincipal(client: CaldavClient): Promise<string> {
  const response = await client.request({
    method: "PROPFIND",
    path: "/",
    depth: "0",
    body: buildPropfind(["d:current-user-principal"]),
  });
  const href = firstHref(parseMultistatus(response.text)[0]?.props["current-user-principal"]);
  if (!href) throw new Error("Сервер не вернул principal — проверьте логин и пароль приложения.");
  return href;
}

export async function resolveHome(client: CaldavClient): Promise<string> {
  const principal = await resolvePrincipal(client);
  const response = await client.request({
    method: "PROPFIND",
    path: principal,
    depth: "0",
    body: buildPropfind(["c:calendar-home-set"]),
  });
  const href = firstHref(parseMultistatus(response.text)[0]?.props["calendar-home-set"]);
  if (!href) throw new Error("Сервер не вернул дом календарей.");
  return href;
}

function isCalendar(resourcetype: unknown): boolean {
  return resourcetype != null && typeof resourcetype === "object" && "calendar" in resourcetype;
}

function isWritable(privileges: unknown): boolean {
  if (privileges == null) return true;
  return JSON.stringify(privileges).includes("write");
}

export async function discoverCalendars(client: CaldavClient): Promise<Calendar[]> {
  const home = await resolveHome(client);
  const response = await client.request({
    method: "PROPFIND",
    path: home,
    depth: "1",
    body: buildPropfind([
      "d:displayname",
      "d:resourcetype",
      "d:current-user-privilege-set",
      "c:calendar-timezone",
      "ic:calendar-color",
    ]),
  });

  return parseMultistatus(response.text)
    .filter((entry) => isCalendar(entry.props.resourcetype))
    .map((entry) => ({
      id: decodeURIComponent(entry.href.replace(/\/$/, "").split("/").pop() ?? entry.href),
      href: entry.href,
      displayName: String(entry.props.displayname ?? "Без названия"),
      color: entry.props["calendar-color"] ? String(entry.props["calendar-color"]) : undefined,
      timeZone: entry.props["calendar-timezone"]
        ? String(entry.props["calendar-timezone"])
        : undefined,
      readOnly: !isWritable(entry.props["current-user-privilege-set"]),
    }));
}
```

Отсутствие `current-user-privilege-set` трактуется как «запись разрешена»:
Яндекс это свойство может не прислать, и запрещать запись из-за молчания сервера
было бы неверно — реальный отказ придёт как 403 и будет объяснён задачей 3.

- [ ] **Step 5: Убедиться, что тесты проходят**

Run: `npx vitest run tests/caldav/discovery.test.ts`
Expected: PASS, три теста.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/caldav/discovery.ts tests/caldav/discovery.test.ts
git commit -m "Доменные типы и обнаружение календарей"
```

---

## Task 6: Разбор VEVENT

**Files:**
- Create: `src/ical/parse.ts`
- Create: `tests/fixtures/simple.ics`, `tests/fixtures/allday.ics`, `tests/fixtures/weekly.ics`
- Test: `tests/ical/parse.test.ts`

**Interfaces:**
- Consumes: типы из `src/types.ts` (задача 5)
- Produces:
  - `parseEvent(ics: string, calendarId: string, etag?: string): CalendarEvent`
  - `parseRecurrence(vevent: unknown): Recurrence | undefined`

- [ ] **Step 1: Подготовить фикстуры событий**

`tests/fixtures/simple.ics`:

```
BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Yandex LLC//Yandex Calendar//EN
BEGIN:VEVENT
UID:test-simple-1
DTSTAMP:20260901T090000Z
DTSTART;TZID=Europe/Moscow:20260921T100000
DTEND;TZID=Europe/Moscow:20260921T140000
SUMMARY:Проект «Заря»\, первая половина дня
DESCRIPTION:Строка один\nСтрока два
LOCATION:Дома
BEGIN:VALARM
ACTION:DISPLAY
TRIGGER:-PT15M
DESCRIPTION:Напоминание
END:VALARM
END:VEVENT
END:VCALENDAR
```

`tests/fixtures/allday.ics`:

```
BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:test-allday-1
DTSTAMP:20260901T090000Z
DTSTART;VALUE=DATE:20260923
DTEND;VALUE=DATE:20260924
SUMMARY:Выходной
END:VEVENT
END:VCALENDAR
```

`tests/fixtures/weekly.ics`:

```
BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:test-weekly-1
DTSTAMP:20261001T090000Z
DTSTART;TZID=Europe/Moscow:20261019T100000
DTEND;TZID=Europe/Moscow:20261019T140000
RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,WE;COUNT=6
SUMMARY:Проект «Заря»
END:VEVENT
END:VCALENDAR
```

- [ ] **Step 2: Написать падающие тесты**

`tests/ical/parse.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseEvent } from "../../src/ical/parse.js";

const fixture = (name: string) => readFileSync(`tests/fixtures/${name}`, "utf8");

describe("parseEvent", () => {
  it("читает обычное событие с поясом", () => {
    const event = parseEvent(fixture("simple.ics"), "work", '"etag-1"');

    expect(event.id).toBe("test-simple-1");
    expect(event.calendarId).toBe("work");
    expect(event.etag).toBe('"etag-1"');
    expect(event.allDay).toBe(false);
    expect(event.timeZone).toBe("Europe/Moscow");
    expect(event.start).toBe("2026-09-21T10:00:00+03:00");
    expect(event.end).toBe("2026-09-21T14:00:00+03:00");
  });

  it("снимает экранирование запятых и переносов строк", () => {
    const event = parseEvent(fixture("simple.ics"), "work");

    expect(event.summary).toBe("Проект «Заря», первая половина дня");
    expect(event.description).toBe("Строка один\nСтрока два");
  });

  it("читает напоминание из VALARM", () => {
    const event = parseEvent(fixture("simple.ics"), "work");

    expect(event.reminders).toEqual([{ minutesBefore: 15, method: "display" }]);
  });

  it("распознаёт событие на весь день", () => {
    const event = parseEvent(fixture("allday.ics"), "personal");

    expect(event.allDay).toBe(true);
    expect(event.start.slice(0, 10)).toBe("2026-09-23");
  });

  it("переводит RRULE в читаемое правило", () => {
    const event = parseEvent(fixture("weekly.ics"), "work");

    expect(event.recurrence).toEqual({
      frequency: "weekly",
      interval: 1,
      byWeekday: ["MO", "WE"],
      count: 6,
    });
  });

  it("не выдумывает правило у события без повтора", () => {
    expect(parseEvent(fixture("simple.ics"), "work").recurrence).toBeUndefined();
  });
});
```

- [ ] **Step 3: Убедиться, что тесты падают**

Run: `npx vitest run tests/ical/parse.test.ts`
Expected: FAIL, модуль не найден.

- [ ] **Step 4: Реализовать разбор**

`src/ical/parse.ts`:

```ts
import ICAL from "ical.js";
import type {
  Attendee,
  CalendarEvent,
  Recurrence,
  RecurrenceFrequency,
  Reminder,
} from "../types.js";

const FREQUENCIES: Record<string, RecurrenceFrequency> = {
  DAILY: "daily",
  WEEKLY: "weekly",
  MONTHLY: "monthly",
  YEARLY: "yearly",
};

function offsetString(time: ICAL.Time): string {
  const seconds = time.utcOffset();
  const sign = seconds < 0 ? "-" : "+";
  const abs = Math.abs(seconds);
  const hh = String(Math.floor(abs / 3600)).padStart(2, "0");
  const mm = String(Math.floor((abs % 3600) / 60)).padStart(2, "0");
  return `${sign}${hh}:${mm}`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function formatTime(time: ICAL.Time): string {
  const date = `${time.year}-${pad(time.month)}-${pad(time.day)}`;
  if (time.isDate) return `${date}T00:00:00${offsetString(time)}`;
  const clock = `${pad(time.hour)}:${pad(time.minute)}:${pad(time.second)}`;
  return `${date}T${clock}${offsetString(time)}`;
}

export function parseRecurrence(vevent: ICAL.Component): Recurrence | undefined {
  const rule = vevent.getFirstPropertyValue("rrule") as ICAL.Recur | null;
  if (!rule) return undefined;

  const frequency = FREQUENCIES[String(rule.freq)];
  if (!frequency) return undefined;

  const byday = rule.getComponent("BYDAY") as string[] | undefined;
  const recurrence: Recurrence = { frequency, interval: rule.interval || 1 };
  if (byday && byday.length > 0) {
    recurrence.byWeekday = byday.map((day) => day.replace(/^[-+]?\d+/, "")) as Recurrence["byWeekday"];
  }
  if (rule.count) recurrence.count = rule.count;
  if (rule.until) recurrence.until = formatTime(rule.until);
  return recurrence;
}

function parseReminders(vevent: ICAL.Component): Reminder[] {
  return vevent.getAllSubcomponents("valarm").map((alarm) => {
    const trigger = alarm.getFirstPropertyValue("trigger") as ICAL.Duration | null;
    const action = String(alarm.getFirstPropertyValue("action") ?? "DISPLAY").toLowerCase();
    const seconds = trigger ? Math.abs(trigger.toSeconds()) : 0;
    return {
      minutesBefore: Math.round(seconds / 60),
      method: action === "email" ? "email" : "display",
    };
  });
}

function parseAttendees(vevent: ICAL.Component): Attendee[] {
  return vevent.getAllProperties("attendee").map((property) => {
    const value = String(property.getFirstValue() ?? "").replace(/^mailto:/i, "");
    const partstat = String(property.getParameter("partstat") ?? "NEEDS-ACTION").toLowerCase();
    const status =
      partstat === "accepted" || partstat === "declined" || partstat === "tentative"
        ? partstat
        : "needs-action";
    return { email: value, status } as Attendee;
  });
}

export function parseEvent(ics: string, calendarId: string, etag?: string): CalendarEvent {
  const root = new ICAL.Component(ICAL.parse(ics));
  const vevent = root.getFirstSubcomponent("vevent");
  if (!vevent) throw new Error("В календарной записи нет компонента VEVENT.");

  const event = new ICAL.Event(vevent);
  const start = event.startDate;
  const end = event.endDate;

  return {
    id: event.uid,
    calendarId,
    summary: event.summary ?? "",
    description: event.description || undefined,
    location: event.location || undefined,
    start: formatTime(start),
    end: formatTime(end),
    timeZone: start.zone?.tzid ?? "UTC",
    allDay: start.isDate,
    recurrence: parseRecurrence(vevent),
    reminders: parseReminders(vevent),
    attendees: parseAttendees(vevent),
    etag,
  };
}
```

Снятие экранирования `\,` и `\n` делает сама `ical.js` при разборе значений,
отдельного кода это не требует — тесты шага 2 подтверждают.

- [ ] **Step 5: Убедиться, что тесты проходят**

Run: `npx vitest run tests/ical/parse.test.ts`
Expected: PASS, шесть тестов.

Если пояс `Europe/Moscow` не распознан и смещение вышло нулевым, значит база
поясов не зарегистрирована — это чинится в задаче 7 шагом 1, и тогда этот тест
нужно перезапустить после неё.

- [ ] **Step 6: Commit**

```bash
git add src/ical/parse.ts tests/ical tests/fixtures
git commit -m "Разбор VEVENT в доменное событие"
```

---

## Task 7: Сборка VEVENT с часовыми поясами

**Files:**
- Create: `src/ical/timezones.ts`
- Create: `src/ical/build.ts`
- Test: `tests/ical/build.test.ts`

**Interfaces:**
- Consumes: типы (задача 5), `parseEvent` (задача 6) для проверки кругового преобразования
- Produces:
  - `registerTimeZone(tzid: string): ICAL.Timezone` — регистрирует зону в `ICAL.TimezoneService`
  - `buildEvent(event: NewEvent): { ics: string; uid: string }`
  - `interface NewEvent` — `CalendarEvent` без `id`, `etag`, `href`, `instanceStart`, `seriesId`

- [ ] **Step 1: Обеспечить базу часовых поясов**

`ical.js` без зарегистрированных зон считает `TZID=Europe/Moscow` неизвестным и
молча берёт нулевое смещение. Нужна база VTIMEZONE.

```bash
npm install @touch4it/ical-timezones
node --input-type=module -e "
import tz from '@touch4it/ical-timezones';
console.log(tz.getVtimezoneComponent('Europe/Moscow').slice(0, 120));
"
```

Ожидается блок, начинающийся с `BEGIN:VTIMEZONE`. Если пакет не ставится или
не экспортирует такой функции, взять запасной путь: Яндекс присылает VTIMEZONE
своих календарей в свойстве `calendar-timezone`, которое уже читает задача 5,
и `registerTimeZone` тогда принимает эту строку вторым аргументом. Запасной путь
покрывает только зоны, встречающиеся в аккаунте, — этого достаточно для личного
использования.

`src/ical/timezones.ts`:

```ts
import ICAL from "ical.js";
import tzdb from "@touch4it/ical-timezones";

export function registerTimeZone(tzid: string, vtimezoneIcs?: string): ICAL.Timezone {
  const existing = ICAL.TimezoneService.get(tzid);
  if (existing) return existing;

  const ics = vtimezoneIcs ?? tzdb.getVtimezoneComponent(tzid);
  if (!ics) throw new Error(`Неизвестный часовой пояс: ${tzid}`);

  const wrapped = ics.includes("BEGIN:VCALENDAR")
    ? ics
    : `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${ics}\r\nEND:VCALENDAR`;
  const component = new ICAL.Component(ICAL.parse(wrapped)).getFirstSubcomponent("vtimezone");
  if (!component) throw new Error(`В описании пояса ${tzid} нет блока VTIMEZONE.`);

  const zone = new ICAL.Timezone(component);
  ICAL.TimezoneService.register(tzid, zone);
  return zone;
}
```

- [ ] **Step 2: Написать падающие тесты сборки**

`tests/ical/build.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildEvent } from "../../src/ical/build.js";
import { parseEvent } from "../../src/ical/parse.js";

const base = {
  calendarId: "work",
  summary: "Проект «Заря», утро",
  description: "Строка один\nСтрока два",
  location: "Дома",
  start: "2026-09-21T10:00:00+03:00",
  end: "2026-09-21T14:00:00+03:00",
  timeZone: "Europe/Moscow",
  allDay: false,
  reminders: [{ minutesBefore: 15, method: "display" as const }],
  attendees: [],
};

describe("buildEvent", () => {
  it("пишет время с TZID, а не в UTC", () => {
    const { ics } = buildEvent(base);

    expect(ics).toContain("DTSTART;TZID=Europe/Moscow:20260921T100000");
    expect(ics).not.toContain("DTSTART:20260921T070000Z");
  });

  it("вкладывает описание пояса в календарь", () => {
    const { ics } = buildEvent(base);

    expect(ics).toContain("BEGIN:VTIMEZONE");
    expect(ics).toContain("TZID:Europe/Moscow");
  });

  it("переживает круговое преобразование без потерь", () => {
    const { ics } = buildEvent(base);
    const parsed = parseEvent(ics, "work");

    expect(parsed.summary).toBe(base.summary);
    expect(parsed.description).toBe(base.description);
    expect(parsed.start).toBe(base.start);
    expect(parsed.end).toBe(base.end);
    expect(parsed.reminders).toEqual(base.reminders);
  });

  it("сохраняет правило повтора при круговом преобразовании", () => {
    const recurring = {
      ...base,
      recurrence: { frequency: "weekly" as const, interval: 1, byWeekday: ["MO", "WE"] as const, count: 6 },
    };

    const parsed = parseEvent(buildEvent(recurring).ics, "work");

    expect(parsed.recurrence).toEqual(recurring.recurrence);
  });

  it("пишет событие на весь день как DATE без времени", () => {
    const { ics } = buildEvent({
      ...base,
      allDay: true,
      start: "2026-09-23T00:00:00+03:00",
      end: "2026-09-24T00:00:00+03:00",
    });

    expect(ics).toContain("DTSTART;VALUE=DATE:20260923");
    expect(ics).not.toContain("T000000");
  });

  it("выдаёт свой UID, когда его не передали", () => {
    const first = buildEvent(base);
    const second = buildEvent(base);

    expect(first.uid).toBeTruthy();
    expect(first.uid).not.toBe(second.uid);
  });
});
```

- [ ] **Step 3: Убедиться, что тесты падают**

Run: `npx vitest run tests/ical/build.test.ts`
Expected: FAIL, модуль не найден.

- [ ] **Step 4: Реализовать сборку**

`src/ical/build.ts`:

```ts
import { randomUUID } from "node:crypto";
import ICAL from "ical.js";
import { registerTimeZone } from "./timezones.js";
import type { CalendarEvent, Recurrence } from "../types.js";

export type NewEvent = Omit<
  CalendarEvent,
  "id" | "etag" | "href" | "instanceStart" | "seriesId"
> & { id?: string };

function toIcalTime(iso: string, tzid: string, allDay: boolean): ICAL.Time {
  const zone = registerTimeZone(tzid);
  const date = new Date(iso);
  const time = ICAL.Time.fromJSDate(date, false).convertToZone(zone);
  if (allDay) {
    return ICAL.Time.fromData({
      year: time.year,
      month: time.month,
      day: time.day,
      isDate: true,
    });
  }
  return time;
}

function toRrule(recurrence: Recurrence): ICAL.Recur {
  const parts = [`FREQ=${recurrence.frequency.toUpperCase()}`, `INTERVAL=${recurrence.interval}`];
  if (recurrence.byWeekday?.length) parts.push(`BYDAY=${recurrence.byWeekday.join(",")}`);
  if (recurrence.count) parts.push(`COUNT=${recurrence.count}`);
  if (recurrence.until) {
    parts.push(`UNTIL=${new Date(recurrence.until).toISOString().replace(/[-:]|\.\d{3}/g, "")}`);
  }
  return ICAL.Recur.fromString(parts.join(";"));
}

export function buildEvent(event: NewEvent): { ics: string; uid: string } {
  const uid = event.id ?? randomUUID();
  const calendar = new ICAL.Component(["vcalendar", [], []]);
  calendar.addPropertyWithValue("version", "2.0");
  calendar.addPropertyWithValue("prodid", "-//yandex-calendar-mcp//RU");

  if (!event.allDay) {
    calendar.addSubcomponent(registerTimeZone(event.timeZone).component);
  }

  const vevent = new ICAL.Component("vevent");
  vevent.addPropertyWithValue("uid", uid);
  vevent.addPropertyWithValue("dtstamp", ICAL.Time.now());
  vevent.addPropertyWithValue("summary", event.summary);
  if (event.description) vevent.addPropertyWithValue("description", event.description);
  if (event.location) vevent.addPropertyWithValue("location", event.location);

  const start = vevent.addPropertyWithValue(
    "dtstart",
    toIcalTime(event.start, event.timeZone, event.allDay),
  );
  const end = vevent.addPropertyWithValue(
    "dtend",
    toIcalTime(event.end, event.timeZone, event.allDay),
  );
  if (!event.allDay) {
    start.setParameter("tzid", event.timeZone);
    end.setParameter("tzid", event.timeZone);
  }

  if (event.recurrence) vevent.addPropertyWithValue("rrule", toRrule(event.recurrence));

  for (const reminder of event.reminders) {
    const alarm = new ICAL.Component("valarm");
    alarm.addPropertyWithValue("action", reminder.method === "email" ? "EMAIL" : "DISPLAY");
    alarm.addPropertyWithValue(
      "trigger",
      ICAL.Duration.fromSeconds(-reminder.minutesBefore * 60),
    );
    alarm.addPropertyWithValue("description", event.summary);
    vevent.addSubcomponent(alarm);
  }

  for (const attendee of event.attendees) {
    const property = vevent.addPropertyWithValue("attendee", `mailto:${attendee.email}`);
    property.setParameter("partstat", attendee.status.toUpperCase());
  }

  calendar.addSubcomponent(vevent);
  return { ics: calendar.toString(), uid };
}
```

- [ ] **Step 5: Убедиться, что тесты проходят**

Run: `npx vitest run tests/ical`
Expected: PASS, все тесты задач 6 и 7.

- [ ] **Step 6: Commit**

```bash
git add src/ical package.json package-lock.json tests/ical
git commit -m "Сборка VEVENT с TZID и вложенным VTIMEZONE"
```

---

## Task 8: Раскрытие повторов

**Files:**
- Create: `src/ical/expand.ts`
- Test: `tests/ical/expand.test.ts`

**Interfaces:**
- Consumes: `parseEvent`, `formatTime` (задача 6), `registerTimeZone` (задача 7)
- Produces: `expandOccurrences(ics: string, calendarId: string, from: Date, to: Date, etag?: string): CalendarEvent[]`

- [ ] **Step 1: Написать падающие тесты**

`tests/ical/expand.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { expandOccurrences } from "../../src/ical/expand.js";

const fixture = (name: string) => readFileSync(`tests/fixtures/${name}`, "utf8");

describe("expandOccurrences", () => {
  it("раскрывает еженедельную серию в отдельные экземпляры", () => {
    const occurrences = expandOccurrences(
      fixture("weekly.ics"),
      "work",
      new Date("2026-10-01T00:00:00Z"),
      new Date("2026-11-30T00:00:00Z"),
    );

    expect(occurrences).toHaveLength(6);
    expect(occurrences[0].instanceStart).toBe("2026-10-19T10:00:00+03:00");
    expect(occurrences[1].instanceStart).toBe("2026-10-21T10:00:00+03:00");
    expect(occurrences.every((item) => item.seriesId === "test-weekly-1")).toBe(true);
  });

  it("отдаёт только экземпляры внутри запрошенного окна", () => {
    const occurrences = expandOccurrences(
      fixture("weekly.ics"),
      "work",
      new Date("2026-10-19T00:00:00Z"),
      new Date("2026-10-22T00:00:00Z"),
    );

    expect(occurrences).toHaveLength(2);
  });

  it("держит одно и то же местное время через перевод часов", () => {
    const dst = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:dst-1
DTSTAMP:20261001T090000Z
DTSTART;TZID=Europe/Berlin:20261020T100000
DTEND;TZID=Europe/Berlin:20261020T110000
RRULE:FREQ=WEEKLY;COUNT=3
SUMMARY:Еженедельная встреча
END:VEVENT
END:VCALENDAR`;

    const occurrences = expandOccurrences(
      dst,
      "work",
      new Date("2026-10-01T00:00:00Z"),
      new Date("2026-11-30T00:00:00Z"),
    );

    expect(occurrences[0].instanceStart).toBe("2026-10-20T10:00:00+02:00");
    expect(occurrences[2].instanceStart).toBe("2026-11-03T10:00:00+01:00");
  });

  it("возвращает одиночное событие как один экземпляр", () => {
    const occurrences = expandOccurrences(
      fixture("simple.ics"),
      "work",
      new Date("2026-09-01T00:00:00Z"),
      new Date("2026-10-01T00:00:00Z"),
    );

    expect(occurrences).toHaveLength(1);
    expect(occurrences[0].seriesId).toBeUndefined();
  });

  it("не зацикливается на бесконечной серии", () => {
    const endless = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:endless-1
DTSTAMP:20260101T090000Z
DTSTART;TZID=Europe/Moscow:20260105T100000
DTEND;TZID=Europe/Moscow:20260105T110000
RRULE:FREQ=DAILY
SUMMARY:Каждый день
END:VEVENT
END:VCALENDAR`;

    const occurrences = expandOccurrences(
      endless,
      "work",
      new Date("2026-01-01T00:00:00Z"),
      new Date("2026-01-11T00:00:00Z"),
    );

    expect(occurrences).toHaveLength(6);
  });
});
```

Третий тест — главный: Берлин переходит на зимнее время 25 октября 2026 года,
и правильная реализация сохраняет местные 10:00, меняя смещение с +02:00 на +01:00.

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `npx vitest run tests/ical/expand.test.ts`
Expected: FAIL, модуль не найден.

- [ ] **Step 3: Реализовать раскрытие**

`src/ical/expand.ts`:

```ts
import ICAL from "ical.js";
import { formatTime, parseEvent } from "./parse.js";
import { registerTimeZone } from "./timezones.js";
import type { CalendarEvent } from "../types.js";

const MAX_OCCURRENCES = 1000;

export function expandOccurrences(
  ics: string,
  calendarId: string,
  from: Date,
  to: Date,
  etag?: string,
): CalendarEvent[] {
  const base = parseEvent(ics, calendarId, etag);
  const root = new ICAL.Component(ICAL.parse(ics));

  for (const vtimezone of root.getAllSubcomponents("vtimezone")) {
    const tzid = String(vtimezone.getFirstPropertyValue("tzid") ?? "");
    if (tzid) registerTimeZone(tzid, `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${vtimezone.toString()}\r\nEND:VCALENDAR`);
  }

  const vevent = root.getFirstSubcomponent("vevent");
  if (!vevent) return [];

  const event = new ICAL.Event(vevent);
  if (!event.isRecurring()) {
    const startsBefore = new Date(base.start) < to;
    const endsAfter = new Date(base.end) > from;
    return startsBefore && endsAfter ? [base] : [];
  }

  const durationSeconds = event.endDate.subtractDate(event.startDate).toSeconds();
  const iterator = event.iterator();
  const occurrences: CalendarEvent[] = [];

  for (let i = 0; i < MAX_OCCURRENCES; i += 1) {
    const next = iterator.next();
    if (!next) break;

    const startDate = next.toJSDate();
    if (startDate >= to) break;

    const endTime = next.clone();
    endTime.addDuration(ICAL.Duration.fromSeconds(durationSeconds));
    if (endTime.toJSDate() <= from) continue;

    occurrences.push({
      ...base,
      instanceStart: formatTime(next),
      start: formatTime(next),
      end: formatTime(endTime),
      seriesId: base.id,
    });
  }

  return occurrences;
}
```

`MAX_OCCURRENCES` защищает от бесконечной серии в широком окне: цикл всё равно
прерывается по времени, но ограничение даёт верхнюю границу на случай ошибки
в правиле.

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `npx vitest run tests/ical/expand.test.ts`
Expected: PASS, пять тестов.

- [ ] **Step 5: Commit**

```bash
git add src/ical/expand.ts tests/ical/expand.test.ts
git commit -m "Локальное раскрытие повторов с учётом перевода часов"
```

---

## Task 9: Чтение и запись объектов календаря

**Files:**
- Create: `src/caldav/objects.ts`
- Test: `tests/caldav/objects.test.ts`

**Interfaces:**
- Consumes: `CaldavClient` (задача 3), `buildCalendarQuery`, `parseMultistatus` (задача 4)
- Produces:
  - `interface RawObject { href: string; etag: string; ics: string }`
  - `queryEvents(client, calendarHref, from, to): Promise<RawObject[]>`
  - `getObject(client, href): Promise<RawObject>`
  - `putObject(client, href, ics, options: { ifMatch?: string; ifNoneMatch?: boolean }): Promise<string>` — возвращает новый ETag
  - `deleteObject(client, href, etag?): Promise<void>`

- [ ] **Step 1: Написать падающие тесты**

`tests/caldav/objects.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import {
  deleteObject,
  putObject,
  queryEvents,
} from "../../src/caldav/objects.js";
import type { CaldavClient } from "../../src/caldav/request.js";

function client(response: { status?: number; text?: string; headers?: Record<string, string> }) {
  const request = vi.fn().mockResolvedValue({
    status: response.status ?? 207,
    headers: new Headers(response.headers ?? {}),
    text: response.text ?? "",
  });
  return { client: { request } as unknown as CaldavClient, request };
}

const multistatus = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:response>
    <d:href>/calendars/user/work/event-1.ics</d:href>
    <d:propstat><d:prop>
      <d:getetag>"etag-1"</d:getetag>
      <c:calendar-data>BEGIN:VCALENDAR
END:VCALENDAR</c:calendar-data>
    </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>
</d:multistatus>`;

describe("queryEvents", () => {
  it("шлёт REPORT с Depth 1 и разбирает ответ", async () => {
    const { client: caldav, request } = client({ text: multistatus });

    const objects = await queryEvents(
      caldav,
      "/calendars/user/work/",
      new Date("2026-09-01T00:00:00Z"),
      new Date("2026-10-01T00:00:00Z"),
    );

    expect(request.mock.calls[0][0].method).toBe("REPORT");
    expect(request.mock.calls[0][0].depth).toBe("1");
    expect(objects).toHaveLength(1);
    expect(objects[0].etag).toBe('"etag-1"');
    expect(objects[0].ics).toContain("BEGIN:VCALENDAR");
  });
});

describe("putObject", () => {
  it("при создании ставит If-None-Match и возвращает новый ETag", async () => {
    const { client: caldav, request } = client({
      status: 201,
      headers: { ETag: '"new-etag"' },
    });

    const etag = await putObject(caldav, "/calendars/user/work/x.ics", "BEGIN:VCALENDAR", {
      ifNoneMatch: true,
    });

    expect(request.mock.calls[0][0].headers["If-None-Match"]).toBe("*");
    expect(request.mock.calls[0][0].headers["Content-Type"]).toContain("text/calendar");
    expect(etag).toBe('"new-etag"');
  });

  it("при обновлении ставит If-Match с переданным ETag", async () => {
    const { client: caldav, request } = client({ status: 204 });

    await putObject(caldav, "/calendars/user/work/x.ics", "BEGIN:VCALENDAR", {
      ifMatch: '"etag-1"',
    });

    expect(request.mock.calls[0][0].headers["If-Match"]).toBe('"etag-1"');
  });

  it("возвращает пустую строку, если сервер не прислал ETag", async () => {
    const { client: caldav } = client({ status: 204 });

    const etag = await putObject(caldav, "/x.ics", "BEGIN:VCALENDAR", { ifNoneMatch: true });

    expect(etag).toBe("");
  });
});

describe("deleteObject", () => {
  it("шлёт DELETE с If-Match", async () => {
    const { client: caldav, request } = client({ status: 204 });

    await deleteObject(caldav, "/calendars/user/work/x.ics", '"etag-1"');

    expect(request.mock.calls[0][0].method).toBe("DELETE");
    expect(request.mock.calls[0][0].headers["If-Match"]).toBe('"etag-1"');
  });
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `npx vitest run tests/caldav/objects.test.ts`
Expected: FAIL, модуль не найден.

- [ ] **Step 3: Реализовать**

`src/caldav/objects.ts`:

```ts
import type { CaldavClient } from "./request.js";
import { buildCalendarQuery, parseMultistatus } from "./xml.js";

export interface RawObject {
  href: string;
  etag: string;
  ics: string;
}

export async function queryEvents(
  client: CaldavClient,
  calendarHref: string,
  from: Date,
  to: Date,
): Promise<RawObject[]> {
  const response = await client.request({
    method: "REPORT",
    path: calendarHref,
    depth: "1",
    body: buildCalendarQuery(from, to),
  });

  return parseMultistatus(response.text)
    .filter((entry) => typeof entry.props["calendar-data"] === "string")
    .map((entry) => ({
      href: entry.href,
      etag: String(entry.props.getetag ?? ""),
      ics: String(entry.props["calendar-data"]),
    }));
}

export async function getObject(client: CaldavClient, href: string): Promise<RawObject> {
  const response = await client.request({ method: "GET", path: href });
  return {
    href,
    etag: response.headers.get("etag") ?? "",
    ics: response.text,
  };
}

export async function putObject(
  client: CaldavClient,
  href: string,
  ics: string,
  options: { ifMatch?: string; ifNoneMatch?: boolean },
): Promise<string> {
  const headers: Record<string, string> = {
    "Content-Type": "text/calendar; charset=utf-8",
  };
  if (options.ifNoneMatch) headers["If-None-Match"] = "*";
  if (options.ifMatch) headers["If-Match"] = options.ifMatch;

  const response = await client.request({ method: "PUT", path: href, body: ics, headers });
  return response.headers.get("etag") ?? "";
}

export async function deleteObject(
  client: CaldavClient,
  href: string,
  etag?: string,
): Promise<void> {
  const headers: Record<string, string> = {};
  if (etag) headers["If-Match"] = etag;
  await client.request({ method: "DELETE", path: href, headers });
}
```

Пустой ETag в ответе — нормальный случай: часть серверов его не присылает,
и тогда следующее обновление начинается с повторного чтения объекта.

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `npx vitest run tests/caldav`
Expected: PASS, все тесты задач 3, 4, 5 и 9.

- [ ] **Step 5: Commit**

```bash
git add src/caldav/objects.ts tests/caldav/objects.test.ts
git commit -m "Чтение и запись объектов календаря с условными заголовками"
```

---

## Task 10: Первый рабочий срез — сервер и `list_calendars`

После этой задачи сервер можно подключить к Claude и увидеть свои календари.
Дальше добавляются только инструменты.

**Files:**
- Create: `src/domain/calendars.ts`
- Create: `src/mcp/context.ts`
- Create: `src/mcp/defineTool.ts`
- Create: `src/mcp/tools/listCalendars.ts`
- Modify: `src/mcp/server.ts` (заменить каркас из задачи 2)
- Test: `tests/domain/calendars.test.ts`

**Interfaces:**
- Consumes: `discoverCalendars` (задача 5), `createClient` (задача 3), `loadConfig` (задача 2)
- Produces:
  - `interface Context { client: CaldavClient; config: Config; calendars(): Promise<Calendar[]>; resolveCalendar(id?: string): Promise<Calendar> }`
  - `createContext(env: NodeJS.ProcessEnv): Context`
  - `defineTool(server, name, description, shape, handler): void` — единственное место в коде, где виден API SDK
  - `listCalendars(context: Context): Promise<Calendar[]>`

- [ ] **Step 1: Написать падающий тест доменного слоя**

`tests/domain/calendars.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { listCalendars, resolveCalendarIn } from "../../src/domain/calendars.js";
import type { Calendar } from "../../src/types.js";

const calendars: Calendar[] = [
  { id: "work", href: "/c/work/", displayName: "Работа", readOnly: false },
  { id: "home", href: "/c/home/", displayName: "Дом", readOnly: false },
];

describe("listCalendars", () => {
  it("спрашивает сервер один раз и дальше отдаёт из кеша", async () => {
    const discover = vi.fn().mockResolvedValue(calendars);
    const context = { client: {} as never, config: {} as never, discover };

    await listCalendars(context as never);
    await listCalendars(context as never);

    expect(discover).toHaveBeenCalledTimes(1);
  });
});

describe("resolveCalendarIn", () => {
  it("находит календарь по идентификатору", () => {
    expect(resolveCalendarIn(calendars, "home").displayName).toBe("Дом");
  });

  it("находит календарь по названию, если идентификатор не подошёл", () => {
    expect(resolveCalendarIn(calendars, "Работа").id).toBe("work");
  });

  it("берёт первый, когда ничего не передали", () => {
    expect(resolveCalendarIn(calendars, undefined).id).toBe("work");
  });

  it("перечисляет доступные варианты, когда календарь не найден", () => {
    expect(() => resolveCalendarIn(calendars, "отпуск")).toThrow(/Работа.*Дом|work.*home/s);
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `npx vitest run tests/domain/calendars.test.ts`
Expected: FAIL, модуль не найден.

- [ ] **Step 3: Реализовать доменный слой календарей**

`src/domain/calendars.ts`:

```ts
import type { Calendar } from "../types.js";

export interface CalendarSource {
  discover(): Promise<Calendar[]>;
}

const cache = new WeakMap<object, Calendar[]>();

export async function listCalendars(source: CalendarSource): Promise<Calendar[]> {
  const cached = cache.get(source as object);
  if (cached) return cached;
  const calendars = await source.discover();
  cache.set(source as object, calendars);
  return calendars;
}

export function resolveCalendarIn(calendars: Calendar[], idOrName?: string): Calendar {
  if (calendars.length === 0) throw new Error("В аккаунте не нашлось ни одного календаря.");
  if (!idOrName) return calendars[0];

  const found = calendars.find(
    (calendar) =>
      calendar.id === idOrName ||
      calendar.displayName.toLowerCase() === idOrName.toLowerCase(),
  );
  if (found) return found;

  const available = calendars.map((calendar) => `${calendar.id} (${calendar.displayName})`).join(", ");
  throw new Error(`Календарь «${idOrName}» не найден. Доступные: ${available}.`);
}
```

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `npx vitest run tests/domain/calendars.test.ts`
Expected: PASS, четыре теста.

- [ ] **Step 5: Собрать контекст**

`src/mcp/context.ts`:

```ts
import { createClient } from "../caldav/request.js";
import { discoverCalendars } from "../caldav/discovery.js";
import { listCalendars, resolveCalendarIn } from "../domain/calendars.js";
import { loadConfig } from "../config.js";
import type { Calendar, Context } from "../types.js";

export type { Context } from "../types.js";

export function createContext(env: NodeJS.ProcessEnv): Context {
  const config = loadConfig(env);
  const client = createClient(config);

  const context: Context = {
    client,
    config,
    discover: () => discoverCalendars(client),
    calendars: () => listCalendars(context),
    resolveCalendar: async (idOrName) => resolveCalendarIn(await context.calendars(), idOrName),
  };

  return context;
}
```

- [ ] **Step 6: Изолировать API SDK в одной функции**

`src/mcp/defineTool.ts`:

```ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodRawShape } from "zod";

export type ToolResult = { content: Array<{ type: "text"; text: string }> };

export function ok(payload: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

export function defineTool(
  server: McpServer,
  name: string,
  description: string,
  shape: ZodRawShape,
  handler: (args: Record<string, never>) => Promise<ToolResult>,
): void {
  server.registerTool(name, { description, inputSchema: shape }, handler as never);
}
```

Если установленная версия SDK не знает `registerTool`, заменить последнюю строку
на `server.tool(name, description, shape, handler as never);` — это единственная
строка во всём проекте, зависящая от формы API, остальные инструменты её не видят.

- [ ] **Step 7: Написать инструмент**

`src/mcp/tools/listCalendars.ts`:

```ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { defineTool, ok } from "../defineTool.js";
import type { Context } from "../context.js";

export function registerListCalendars(server: McpServer, context: Context): void {
  defineTool(
    server,
    "list_calendars",
    "Список календарей аккаунта: идентификатор, название, цвет, часовой пояс, доступен ли для записи.",
    {},
    async () => ok(await context.calendars()),
  );
}
```

- [ ] **Step 8: Собрать сервер**

`src/mcp/server.ts` — заменить содержимое из задачи 2:

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createContext } from "./context.js";
import { registerListCalendars } from "./tools/listCalendars.js";

export async function main(): Promise<void> {
  const context = createContext(process.env);
  const server = new McpServer({ name: "yandex-calendar", version: "0.1.0" });

  registerListCalendars(server, context);

  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
```

- [ ] **Step 9: Проверить на живом аккаунте**

```bash
npm run build
YANDEX_LOGIN=... YANDEX_APP_PASSWORD=... YANDEX_DEFAULT_TZ=Europe/Moscow \
  npx @modelcontextprotocol/inspector node dist/mcp/server.js
```

В инспекторе вызвать `list_calendars`. Ожидается список настоящих календарей
аккаунта. Если инспектор недоступен, достаточно того, что процесс стартует без
ошибок и тесты зелёные — полная проверка идёт задачей 16.

- [ ] **Step 10: Commit**

```bash
git add src/domain src/mcp tests/domain
git commit -m "Рабочий сервер stdio с инструментом list_calendars"
```

---

## Task 11: Чтение событий — `list_events` и `get_event`

**Files:**
- Create: `src/domain/events.ts`
- Create: `src/mcp/tools/readEvents.ts`
- Modify: `src/mcp/server.ts`
- Test: `tests/domain/events.test.ts`

**Interfaces:**
- Consumes: `queryEvents`, `getObject` (задача 9), `expandOccurrences` (задача 8), `parseEvent` (задача 6), `Context` (задача 10)
- Produces:
  - `readEvents(context, params: ReadParams): Promise<CalendarEvent[]>`
  - `interface ReadParams { from: string; to: string; calendarIds?: string[]; query?: string; expandRecurring?: boolean }`
  - `readEvent(context, calendarId: string, eventId: string): Promise<CalendarEvent>`
  - `hrefFor(calendar: Calendar, eventId: string): string`

- [ ] **Step 1: Написать падающие тесты**

`tests/domain/events.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { matchesQuery, readEvents } from "../../src/domain/events.js";
import type { Calendar } from "../../src/types.js";

const weekly = readFileSync("tests/fixtures/weekly.ics", "utf8");
const simple = readFileSync("tests/fixtures/simple.ics", "utf8");

const calendars: Calendar[] = [
  { id: "work", href: "/c/work/", displayName: "Работа", readOnly: false },
];

function contextWith(objects: Array<{ href: string; etag: string; ics: string }>) {
  return {
    client: {} as never,
    config: { defaultTimeZone: "Europe/Moscow" } as never,
    calendars: async () => calendars,
    resolveCalendar: async () => calendars[0],
    query: vi.fn().mockResolvedValue(objects),
  };
}

describe("matchesQuery", () => {
  it("ищет по заголовку, описанию и месту без учёта регистра", () => {
    const event = {
      summary: "Проект «Заря»",
      description: "обсудить смету",
      location: "Дома",
    } as never;

    expect(matchesQuery(event, "заря")).toBe(true);
    expect(matchesQuery(event, "СМЕТУ")).toBe(true);
    expect(matchesQuery(event, "дома")).toBe(true);
    expect(matchesQuery(event, "отпуск")).toBe(false);
  });

  it("пропускает всё, когда запрос пустой", () => {
    expect(matchesQuery({ summary: "что угодно" } as never, undefined)).toBe(true);
  });
});

describe("readEvents", () => {
  it("раскрывает повторы по умолчанию", async () => {
    const context = contextWith([{ href: "/c/work/w.ics", etag: '"1"', ics: weekly }]);

    const events = await readEvents(context as never, {
      from: "2026-10-01T00:00:00+03:00",
      to: "2026-11-30T00:00:00+03:00",
    });

    expect(events).toHaveLength(6);
  });

  it("отдаёт одну запись на серию, когда раскрытие выключено", async () => {
    const context = contextWith([{ href: "/c/work/w.ics", etag: '"1"', ics: weekly }]);

    const events = await readEvents(context as never, {
      from: "2026-10-01T00:00:00+03:00",
      to: "2026-11-30T00:00:00+03:00",
      expandRecurring: false,
    });

    expect(events).toHaveLength(1);
    expect(events[0].recurrence?.frequency).toBe("weekly");
  });

  it("фильтрует по тексту", async () => {
    const context = contextWith([
      { href: "/c/work/w.ics", etag: '"1"', ics: weekly },
      { href: "/c/work/s.ics", etag: '"2"', ics: simple },
    ]);

    const events = await readEvents(context as never, {
      from: "2026-09-01T00:00:00+03:00",
      to: "2026-11-30T00:00:00+03:00",
      query: "первая половина",
    });

    expect(events).toHaveLength(1);
    expect(events[0].summary).toContain("первая половина");
  });

  it("сортирует результат по времени начала", async () => {
    const context = contextWith([
      { href: "/c/work/w.ics", etag: '"1"', ics: weekly },
      { href: "/c/work/s.ics", etag: '"2"', ics: simple },
    ]);

    const events = await readEvents(context as never, {
      from: "2026-09-01T00:00:00+03:00",
      to: "2026-11-30T00:00:00+03:00",
    });

    const times = events.map((event) => new Date(event.start).getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `npx vitest run tests/domain/events.test.ts`
Expected: FAIL, модуль не найден.

- [ ] **Step 3: Реализовать чтение**

`src/domain/events.ts`:

```ts
import { getObject, queryEvents } from "../caldav/objects.js";
import { expandOccurrences } from "../ical/expand.js";
import { parseEvent } from "../ical/parse.js";
import { resolveCalendarIn } from "./calendars.js";
import type { Calendar, CalendarEvent, Context } from "../types.js";

export interface ReadParams {
  from: string;
  to: string;
  calendarIds?: string[];
  query?: string;
  expandRecurring?: boolean;
}

export function matchesQuery(event: CalendarEvent, query?: string): boolean {
  if (!query) return true;
  const needle = query.toLowerCase();
  return [event.summary, event.description, event.location]
    .filter((value): value is string => Boolean(value))
    .some((value) => value.toLowerCase().includes(needle));
}

export function hrefFor(calendar: Calendar, eventId: string): string {
  return `${calendar.href.replace(/\/?$/, "/")}${encodeURIComponent(eventId)}.ics`;
}

type QueryFn = (calendar: Calendar, from: Date, to: Date) => Promise<
  Array<{ href: string; etag: string; ics: string }>
>;

function queryFor(context: Context): QueryFn {
  const injected = (context as unknown as { query?: QueryFn }).query;
  if (injected) return injected;
  return (calendar, from, to) => queryEvents(context.client, calendar.href, from, to);
}

export async function readEvents(context: Context, params: ReadParams): Promise<CalendarEvent[]> {
  const from = new Date(params.from);
  const to = new Date(params.to);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new Error("Параметры from и to должны быть датами в формате ISO 8601.");
  }
  if (from >= to) throw new Error("Начало окна должно быть раньше конца.");

  const all = await context.calendars();
  const selected = params.calendarIds?.length
    ? params.calendarIds.map((id) => resolveCalendarIn(all, id))
    : all;

  const expand = params.expandRecurring !== false;
  const query = queryFor(context);
  const collected: CalendarEvent[] = [];

  for (const calendar of selected) {
    const objects = await query(calendar, from, to);
    for (const object of objects) {
      const events = expand
        ? expandOccurrences(object.ics, calendar.id, from, to, object.etag)
        : [parseEvent(object.ics, calendar.id, object.etag)];
      for (const event of events) {
        if (matchesQuery(event, params.query)) collected.push({ ...event, href: object.href });
      }
    }
  }

  return collected.sort(
    (left, right) => new Date(left.start).getTime() - new Date(right.start).getTime(),
  );
}

export async function readEvent(
  context: Context,
  calendarId: string,
  eventId: string,
): Promise<CalendarEvent> {
  const calendar = await context.resolveCalendar(calendarId);
  const object = await getObject(context.client, hrefFor(calendar, eventId));
  const event = parseEvent(object.ics, calendar.id, object.etag);
  return { ...event, href: object.href };
}
```

`queryFor` даёт тестам подставить свою выборку, не трогая сеть, а в бою
прозрачно уходит в `queryEvents`.

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `npx vitest run tests/domain/events.test.ts`
Expected: PASS, шесть тестов.

- [ ] **Step 5: Написать инструменты**

`src/mcp/tools/readEvents.ts`:

```ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { defineTool, ok } from "../defineTool.js";
import { readEvent, readEvents } from "../../domain/events.js";
import type { Context } from "../context.js";

export function registerReadTools(server: McpServer, context: Context): void {
  defineTool(
    server,
    "list_events",
    "События за период. Повторяющиеся события по умолчанию раскрываются в отдельные экземпляры.",
    {
      from: z.string().describe("Начало окна, ISO 8601 со смещением"),
      to: z.string().describe("Конец окна, ISO 8601 со смещением"),
      calendarIds: z.array(z.string()).optional().describe("Календари; по умолчанию все"),
      query: z.string().optional().describe("Подстрока в заголовке, описании или месте"),
      expandRecurring: z.boolean().optional().describe("Раскрывать повторы, по умолчанию да"),
    },
    async (args) => ok(await readEvents(context, args as never)),
  );

  defineTool(
    server,
    "get_event",
    "Одно событие целиком, включая исходное правило повтора.",
    {
      calendarId: z.string(),
      id: z.string().describe("UID события"),
    },
    async (args) => {
      const { calendarId, id } = args as unknown as { calendarId: string; id: string };
      return ok(await readEvent(context, calendarId, id));
    },
  );
}
```

Пути импортов в файлах инструментов считаются от `src/mcp/tools/`: доменный слой
лежит на два уровня выше, поэтому `../../domain/...`, а соседние модули MCP —
на один, поэтому `../defineTool.js` и `../context.js`.

- [ ] **Step 6: Подключить к серверу**

В `src/mcp/server.ts` добавить импорт и вызов рядом с `registerListCalendars`:

```ts
import { registerReadTools } from "./tools/readEvents.js";
// ...
registerReadTools(server, context);
```

- [ ] **Step 7: Проверить сборку и тесты**

Run: `npm run build && npx vitest run`
Expected: сборка без ошибок, все тесты зелёные.

- [ ] **Step 8: Commit**

```bash
git add src tests
git commit -m "Инструменты чтения событий: list_events и get_event"
```

---

## Task 12: Создание событий — `create_event` и `create_events`

**Files:**
- Modify: `src/domain/events.ts`
- Create: `src/mcp/tools/createEvents.ts`
- Modify: `src/mcp/server.ts`
- Test: `tests/domain/create.test.ts`

**Interfaces:**
- Consumes: `buildEvent` (задача 7), `putObject` (задача 9), `hrefFor` (задача 11)
- Produces:
  - `createEvent(context, input: EventInput): Promise<CalendarEvent>`
  - `createEvents(context, inputs: EventInput[]): Promise<BulkResult[]>`
  - `interface EventInput` — поля события без `id`, `etag`, `href`; `timeZone` необязателен и берётся из конфигурации
  - `interface BulkResult { ok: boolean; summary: string; id?: string; error?: string }`

- [ ] **Step 1: Написать падающие тесты**

`tests/domain/create.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { createEvent, createEvents } from "../../src/domain/events.js";
import type { Calendar } from "../../src/types.js";

const calendar: Calendar = {
  id: "work",
  href: "/c/work/",
  displayName: "Работа",
  readOnly: false,
};

function contextWith(put = vi.fn().mockResolvedValue('"etag-new"')) {
  return {
    context: {
      client: {} as never,
      config: { defaultTimeZone: "Europe/Moscow" } as never,
      calendars: async () => [calendar],
      resolveCalendar: async () => calendar,
      put,
    },
    put,
  };
}

const input = {
  calendarId: "work",
  summary: "Проект «Заря», утро",
  start: "2026-09-21T10:00:00+03:00",
  end: "2026-09-21T14:00:00+03:00",
};

describe("createEvent", () => {
  it("кладёт событие по пути календаря и ставит If-None-Match", async () => {
    const { context, put } = contextWith();

    const event = await createEvent(context as never, input);

    const [href, ics, options] = put.mock.calls[0];
    expect(href).toMatch(/^\/c\/work\/.+\.ics$/);
    expect(ics).toContain("SUMMARY:Проект");
    expect(options.ifNoneMatch).toBe(true);
    expect(event.id).toBeTruthy();
    expect(event.etag).toBe('"etag-new"');
  });

  it("подставляет пояс из конфигурации, если он не задан", async () => {
    const { context, put } = contextWith();

    await createEvent(context as never, input);

    expect(put.mock.calls[0][1]).toContain("TZID=Europe/Moscow");
  });

  it("отказывается писать в календарь только для чтения", async () => {
    const readOnly = { ...calendar, readOnly: true };
    const { context } = contextWith();
    context.resolveCalendar = async () => readOnly;

    await expect(createEvent(context as never, input)).rejects.toThrow(/только для чтения/);
  });
});

describe("createEvents", () => {
  it("создаёт все события и отчитывается по каждому", async () => {
    const { context } = contextWith();

    const results = await createEvents(context as never, [
      { ...input, summary: "Первое" },
      { ...input, summary: "Второе" },
    ]);

    expect(results).toHaveLength(2);
    expect(results.every((result) => result.ok)).toBe(true);
  });

  it("продолжает работу после отказа по одному событию", async () => {
    const put = vi
      .fn()
      .mockResolvedValueOnce('"etag-1"')
      .mockRejectedValueOnce(new Error("Доступ запрещён"))
      .mockResolvedValueOnce('"etag-3"');
    const { context } = contextWith(put);

    const results = await createEvents(context as never, [
      { ...input, summary: "Первое" },
      { ...input, summary: "Второе" },
      { ...input, summary: "Третье" },
    ]);

    expect(results.map((result) => result.ok)).toEqual([true, false, true]);
    expect(results[1].error).toContain("Доступ запрещён");
  });
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `npx vitest run tests/domain/create.test.ts`
Expected: FAIL, `createEvent` не экспортируется.

- [ ] **Step 3: Дописать доменный слой**

Добавить в `src/domain/events.ts`:

```ts
import { buildEvent } from "../ical/build.js";
import { putObject } from "../caldav/objects.js";
import type { Attendee, Recurrence, Reminder } from "../types.js";

export interface EventInput {
  calendarId?: string;
  summary: string;
  description?: string;
  location?: string;
  start: string;
  end: string;
  timeZone?: string;
  allDay?: boolean;
  recurrence?: Recurrence;
  reminders?: Reminder[];
  attendees?: Attendee[];
}

export interface BulkResult {
  ok: boolean;
  summary: string;
  id?: string;
  error?: string;
}

type PutFn = (
  href: string,
  ics: string,
  options: { ifMatch?: string; ifNoneMatch?: boolean },
) => Promise<string>;

function putFor(context: Context): PutFn {
  const injected = (context as unknown as { put?: PutFn }).put;
  if (injected) return injected;
  return (href, ics, options) => putObject(context.client, href, ics, options);
}

export async function createEvent(context: Context, input: EventInput): Promise<CalendarEvent> {
  const calendar = await context.resolveCalendar(input.calendarId);
  if (calendar.readOnly) {
    throw new Error(`Календарь «${calendar.displayName}» открыт только для чтения.`);
  }

  const event = {
    calendarId: calendar.id,
    summary: input.summary,
    description: input.description,
    location: input.location,
    start: input.start,
    end: input.end,
    timeZone: input.timeZone ?? context.config.defaultTimeZone,
    allDay: input.allDay ?? false,
    recurrence: input.recurrence,
    reminders: input.reminders ?? [],
    attendees: input.attendees ?? [],
  };

  const { ics, uid } = buildEvent(event);
  const href = hrefFor(calendar, uid);
  const etag = await putFor(context)(href, ics, { ifNoneMatch: true });

  return { ...event, id: uid, href, etag };
}

export async function createEvents(
  context: Context,
  inputs: EventInput[],
): Promise<BulkResult[]> {
  const results: BulkResult[] = [];
  for (const input of inputs) {
    try {
      const event = await createEvent(context, input);
      results.push({ ok: true, summary: input.summary, id: event.id });
    } catch (error) {
      results.push({
        ok: false,
        summary: input.summary,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}
```

Пачка намеренно не откатывается при частичной неудаче: транзакций в CalDAV нет,
а отчёт по каждой строке позволяет повторить только неудавшиеся.

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `npx vitest run tests/domain/create.test.ts`
Expected: PASS, пять тестов.

- [ ] **Step 5: Написать инструменты**

`src/mcp/tools/createEvents.ts`:

```ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { defineTool, ok } from "../defineTool.js";
import { createEvent, createEvents } from "../../domain/events.js";
import type { Context } from "../context.js";

const recurrenceSchema = z.object({
  frequency: z.enum(["daily", "weekly", "monthly", "yearly"]),
  interval: z.number().int().positive().default(1),
  byWeekday: z.array(z.enum(["MO", "TU", "WE", "TH", "FR", "SA", "SU"])).optional(),
  until: z.string().optional(),
  count: z.number().int().positive().optional(),
});

const eventShape = {
  calendarId: z.string().optional().describe("Календарь; по умолчанию первый"),
  summary: z.string().describe("Заголовок события"),
  description: z.string().optional(),
  location: z.string().optional(),
  start: z.string().describe("Начало, ISO 8601 со смещением"),
  end: z.string().describe("Конец, ISO 8601 со смещением"),
  timeZone: z.string().optional().describe("IANA-зона; по умолчанию из настроек"),
  allDay: z.boolean().optional(),
  recurrence: recurrenceSchema.optional(),
  reminders: z
    .array(z.object({ minutesBefore: z.number().int().nonnegative(), method: z.enum(["display", "email"]) }))
    .optional(),
  attendees: z
    .array(
      z.object({
        email: z.string().email(),
        status: z.enum(["accepted", "declined", "tentative", "needs-action"]).default("needs-action"),
      }),
    )
    .optional(),
};

export function registerCreateTools(server: McpServer, context: Context): void {
  defineTool(server, "create_event", "Создать одно событие.", eventShape, async (args) =>
    ok(await createEvent(context, args as never)),
  );

  defineTool(
    server,
    "create_events",
    "Создать несколько событий за один вызов. Отчёт приходит по каждому: успех или причина отказа.",
    { events: z.array(z.object(eventShape)).min(1).describe("Список событий") },
    async (args) => {
      const { events } = args as unknown as { events: Array<Record<string, unknown>> };
      return ok(await createEvents(context, events as never));
    },
  );
}
```

- [ ] **Step 6: Подключить к серверу**

В `src/mcp/server.ts`:

```ts
import { registerCreateTools } from "./tools/createEvents.js";
// ...
registerCreateTools(server, context);
```

- [ ] **Step 7: Проверить сборку и тесты**

Run: `npm run build && npx vitest run`
Expected: сборка без ошибок, все тесты зелёные.

- [ ] **Step 8: Commit**

```bash
git add src tests
git commit -m "Создание событий поодиночке и пачкой"
```

---

## Task 13: Правка событий — `update_event`

**Files:**
- Modify: `src/domain/events.ts`
- Create: `src/mcp/tools/updateEvent.ts`
- Modify: `src/mcp/server.ts`
- Test: `tests/domain/update.test.ts`

**Interfaces:**
- Consumes: `getObject`, `putObject` (задача 9), `buildEvent` (задача 7), `parseEvent` (задача 6)
- Produces:
  - `updateEvent(context, params: UpdateParams): Promise<CalendarEvent>`
  - `interface UpdateParams { calendarId?: string; id: string; scope?: EditScope; instanceStart?: string; patch: Partial<EventInput> }`

- [ ] **Step 1: Написать падающие тесты**

`tests/domain/update.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { updateEvent } from "../../src/domain/events.js";
import type { Calendar } from "../../src/types.js";

const weekly = readFileSync("tests/fixtures/weekly.ics", "utf8");
const simple = readFileSync("tests/fixtures/simple.ics", "utf8");

const calendar: Calendar = {
  id: "work",
  href: "/c/work/",
  displayName: "Работа",
  readOnly: false,
};

function contextWith(ics: string) {
  const put = vi.fn().mockResolvedValue('"etag-new"');
  const get = vi.fn().mockResolvedValue({ href: "/c/work/x.ics", etag: '"etag-old"', ics });
  return {
    context: {
      client: {} as never,
      config: { defaultTimeZone: "Europe/Moscow" } as never,
      calendars: async () => [calendar],
      resolveCalendar: async () => calendar,
      get,
      put,
    },
    put,
    get,
  };
}

describe("updateEvent", () => {
  it("правит всю серию и шлёт If-Match со свежим ETag", async () => {
    const { context, put } = contextWith(weekly);

    await updateEvent(context as never, {
      id: "test-weekly-1",
      scope: "all_series",
      patch: { summary: "Проект «Заря» — новое название" },
    });

    const [, ics, options] = put.mock.calls[0];
    expect(options.ifMatch).toBe('"etag-old"');
    expect(ics).toContain("новое название");
    expect(ics).toContain("RRULE");
  });

  it("не трогает поля, которых нет в патче", async () => {
    const { context, put } = contextWith(simple);

    await updateEvent(context as never, {
      id: "test-simple-1",
      scope: "all_series",
      patch: { location: "Офис" },
    });

    const ics = put.mock.calls[0][1];
    expect(ics).toContain("LOCATION:Офис");
    expect(ics).toContain("первая половина дня");
  });

  it("при scope this добавляет исключение с RECURRENCE-ID", async () => {
    const { context, put } = contextWith(weekly);

    await updateEvent(context as never, {
      id: "test-weekly-1",
      scope: "this",
      instanceStart: "2026-10-21T10:00:00+03:00",
      patch: { summary: "Перенесённая встреча" },
    });

    const ics = put.mock.calls[0][1];
    expect(ics).toContain("RECURRENCE-ID");
    expect(ics).toContain("Перенесённая встреча");
    expect(ics).toContain("RRULE");
  });

  it("требует instanceStart при scope this", async () => {
    const { context } = contextWith(weekly);

    await expect(
      updateEvent(context as never, {
        id: "test-weekly-1",
        scope: "this",
        patch: { summary: "Без экземпляра" },
      }),
    ).rejects.toThrow(/instanceStart/);
  });

  it("при scope this_and_following обрезает серию и создаёт новую", async () => {
    const { context, put } = contextWith(weekly);

    await updateEvent(context as never, {
      id: "test-weekly-1",
      scope: "this_and_following",
      instanceStart: "2026-11-02T10:00:00+03:00",
      patch: { summary: "Новая часть серии" },
    });

    expect(put).toHaveBeenCalledTimes(2);
    expect(put.mock.calls[0][1]).toContain("UNTIL=");
    expect(put.mock.calls[1][1]).toContain("Новая часть серии");
    expect(put.mock.calls[1][2].ifNoneMatch).toBe(true);
  });

  it("по умолчанию использует scope this, а не всю серию", async () => {
    const { context, put } = contextWith(weekly);

    await updateEvent(context as never, {
      id: "test-weekly-1",
      instanceStart: "2026-10-21T10:00:00+03:00",
      patch: { summary: "Только этот" },
    });

    expect(put.mock.calls[0][1]).toContain("RECURRENCE-ID");
  });
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `npx vitest run tests/domain/update.test.ts`
Expected: FAIL, `updateEvent` не экспортируется.

- [ ] **Step 3: Дописать доменный слой**

Добавить в `src/domain/events.ts`:

```ts
import ICAL from "ical.js";
import { randomUUID } from "node:crypto";
import type { EditScope } from "../types.js";

export interface UpdateParams {
  calendarId?: string;
  id: string;
  scope?: EditScope;
  instanceStart?: string;
  patch: Partial<EventInput>;
}

type GetFn = (href: string) => Promise<{ href: string; etag: string; ics: string }>;

function getFor(context: Context): GetFn {
  const injected = (context as unknown as { get?: GetFn }).get;
  if (injected) return injected;
  return (href) => getObject(context.client, href);
}

function merge(event: CalendarEvent, patch: Partial<EventInput>) {
  return {
    calendarId: event.calendarId,
    summary: patch.summary ?? event.summary,
    description: patch.description ?? event.description,
    location: patch.location ?? event.location,
    start: patch.start ?? event.start,
    end: patch.end ?? event.end,
    timeZone: patch.timeZone ?? event.timeZone,
    allDay: patch.allDay ?? event.allDay,
    recurrence: patch.recurrence ?? event.recurrence,
    reminders: patch.reminders ?? event.reminders,
    attendees: patch.attendees ?? event.attendees,
  };
}

function veventOf(ics: string): { root: ICAL.Component; vevent: ICAL.Component } {
  const root = new ICAL.Component(ICAL.parse(ics));
  const vevent = root.getFirstSubcomponent("vevent");
  if (!vevent) throw new Error("В календарной записи нет компонента VEVENT.");
  return { root, vevent };
}

function icalTimeOf(iso: string, tzid: string): ICAL.Time {
  return ICAL.Time.fromJSDate(new Date(iso), false).convertToZone(
    ICAL.TimezoneService.get(tzid) ?? ICAL.Timezone.utcTimezone,
  );
}

export async function updateEvent(
  context: Context,
  params: UpdateParams,
): Promise<CalendarEvent> {
  const calendar = await context.resolveCalendar(params.calendarId);
  if (calendar.readOnly) {
    throw new Error(`Календарь «${calendar.displayName}» открыт только для чтения.`);
  }

  const href = hrefFor(calendar, params.id);
  const object = await getFor(context)(href);
  const current = parseEvent(object.ics, calendar.id, object.etag);
  const scope: EditScope = params.scope ?? "this";
  const put = putFor(context);
  const merged = merge(current, params.patch);

  if (!current.recurrence || scope === "all_series") {
    const { ics } = buildEvent({ ...merged, id: params.id });
    const etag = await put(href, ics, { ifMatch: object.etag });
    return { ...merged, id: params.id, href, etag };
  }

  if (!params.instanceStart) {
    throw new Error(
      "Для правки повторяющегося события укажите instanceStart — начало того экземпляра, который меняем. Либо передайте scope: \"all_series\", чтобы изменить всю серию.",
    );
  }

  if (scope === "this") {
    const { root } = veventOf(object.ics);
    const override = veventOf(buildEvent({ ...merged, id: params.id, recurrence: undefined }).ics)
      .vevent;
    override.addPropertyWithValue(
      "recurrence-id",
      icalTimeOf(params.instanceStart, current.timeZone),
    );
    root.addSubcomponent(override);
    const etag = await put(href, root.toString(), { ifMatch: object.etag });
    return { ...merged, id: params.id, href, etag, instanceStart: params.instanceStart };
  }

  const boundary = new Date(new Date(params.instanceStart).getTime() - 1000).toISOString();
  const truncated = buildEvent({
    ...current,
    id: params.id,
    recurrence: { ...current.recurrence, count: undefined, until: boundary },
  });
  await put(href, truncated.ics, { ifMatch: object.etag });

  const continuation = buildEvent({
    ...merged,
    id: randomUUID(),
    start: params.patch.start ?? params.instanceStart,
    end:
      params.patch.end ??
      new Date(
        new Date(params.instanceStart).getTime() +
          (new Date(current.end).getTime() - new Date(current.start).getTime()),
      ).toISOString(),
  });
  const continuationHref = hrefFor(calendar, continuation.uid);
  const etag = await put(continuationHref, continuation.ics, { ifNoneMatch: true });

  return { ...merged, id: continuation.uid, href: continuationHref, etag };
}
```

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `npx vitest run tests/domain/update.test.ts`
Expected: PASS, шесть тестов.

- [ ] **Step 5: Написать инструмент**

`src/mcp/tools/updateEvent.ts`:

```ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { defineTool, ok } from "../defineTool.js";
import { updateEvent } from "../../domain/events.js";
import type { Context } from "../context.js";

export function registerUpdateTool(server: McpServer, context: Context): void {
  defineTool(
    server,
    "update_event",
    "Изменить событие. У повторяющихся событий по умолчанию меняется только названный экземпляр; чтобы задеть всю серию, передайте scope: all_series.",
    {
      calendarId: z.string().optional(),
      id: z.string().describe("UID события"),
      scope: z
        .enum(["this", "this_and_following", "all_series"])
        .optional()
        .describe("Область правки, по умолчанию this"),
      instanceStart: z
        .string()
        .optional()
        .describe("Начало правимого экземпляра; обязательно при scope this и this_and_following"),
      patch: z
        .object({
          summary: z.string().optional(),
          description: z.string().optional(),
          location: z.string().optional(),
          start: z.string().optional(),
          end: z.string().optional(),
          timeZone: z.string().optional(),
          allDay: z.boolean().optional(),
        })
        .describe("Только изменяемые поля; остальные останутся прежними"),
    },
    async (args) => ok(await updateEvent(context, args as never)),
  );
}
```

- [ ] **Step 6: Подключить и проверить**

В `src/mcp/server.ts` добавить `import { registerUpdateTool } from "./tools/updateEvent.js";`
и `registerUpdateTool(server, context);`

Run: `npm run build && npx vitest run`
Expected: сборка без ошибок, все тесты зелёные.

- [ ] **Step 7: Commit**

```bash
git add src tests
git commit -m "Правка событий с разделением на экземпляр, хвост серии и всю серию"
```

---

## Task 14: Удаление событий — `delete_event`

**Files:**
- Modify: `src/domain/events.ts`
- Create: `src/mcp/tools/deleteEvent.ts`
- Modify: `src/mcp/server.ts`
- Test: `tests/domain/delete.test.ts`

**Interfaces:**
- Consumes: `getFor`, `putFor` (задача 13), `deleteObject` (задача 9)
- Produces: `deleteEvent(context, params: DeleteParams): Promise<{ deleted: string; scope: EditScope }>`
  где `interface DeleteParams { calendarId?: string; id: string; scope?: EditScope; instanceStart?: string }`

- [ ] **Step 1: Написать падающие тесты**

`tests/domain/delete.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { deleteEvent } from "../../src/domain/events.js";
import type { Calendar } from "../../src/types.js";

const weekly = readFileSync("tests/fixtures/weekly.ics", "utf8");
const simple = readFileSync("tests/fixtures/simple.ics", "utf8");

const calendar: Calendar = {
  id: "work",
  href: "/c/work/",
  displayName: "Работа",
  readOnly: false,
};

function contextWith(ics: string) {
  const put = vi.fn().mockResolvedValue('"etag-new"');
  const remove = vi.fn().mockResolvedValue(undefined);
  const get = vi.fn().mockResolvedValue({ href: "/c/work/x.ics", etag: '"etag-old"', ics });
  return {
    context: {
      client: {} as never,
      config: { defaultTimeZone: "Europe/Moscow" } as never,
      calendars: async () => [calendar],
      resolveCalendar: async () => calendar,
      get,
      put,
      remove,
    },
    put,
    remove,
  };
}

describe("deleteEvent", () => {
  it("удаляет одиночное событие целиком", async () => {
    const { context, remove } = contextWith(simple);

    await deleteEvent(context as never, { id: "test-simple-1" });

    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove.mock.calls[0][1]).toBe('"etag-old"');
  });

  it("при scope this добавляет EXDATE вместо удаления объекта", async () => {
    const { context, put, remove } = contextWith(weekly);

    await deleteEvent(context as never, {
      id: "test-weekly-1",
      scope: "this",
      instanceStart: "2026-10-21T10:00:00+03:00",
    });

    expect(remove).not.toHaveBeenCalled();
    expect(put.mock.calls[0][1]).toContain("EXDATE");
    expect(put.mock.calls[0][2].ifMatch).toBe('"etag-old"');
  });

  it("при scope all_series удаляет объект", async () => {
    const { context, remove } = contextWith(weekly);

    await deleteEvent(context as never, { id: "test-weekly-1", scope: "all_series" });

    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("при scope this_and_following обрезает серию через UNTIL", async () => {
    const { context, put, remove } = contextWith(weekly);

    await deleteEvent(context as never, {
      id: "test-weekly-1",
      scope: "this_and_following",
      instanceStart: "2026-11-02T10:00:00+03:00",
    });

    expect(remove).not.toHaveBeenCalled();
    expect(put.mock.calls[0][1]).toContain("UNTIL=");
  });

  it("требует instanceStart для частичного удаления серии", async () => {
    const { context } = contextWith(weekly);

    await expect(
      deleteEvent(context as never, { id: "test-weekly-1", scope: "this" }),
    ).rejects.toThrow(/instanceStart/);
  });
});

```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `npx vitest run tests/domain/delete.test.ts`
Expected: FAIL, `deleteEvent` не экспортируется.

- [ ] **Step 3: Дописать доменный слой**

Добавить в `src/domain/events.ts`:

```ts
import { deleteObject } from "../caldav/objects.js";

export interface DeleteParams {
  calendarId?: string;
  id: string;
  scope?: EditScope;
  instanceStart?: string;
}

type RemoveFn = (href: string, etag?: string) => Promise<void>;

function removeFor(context: Context): RemoveFn {
  const injected = (context as unknown as { remove?: RemoveFn }).remove;
  if (injected) return injected;
  return (href, etag) => deleteObject(context.client, href, etag);
}

export async function deleteEvent(
  context: Context,
  params: DeleteParams,
): Promise<{ deleted: string; scope: EditScope }> {
  const calendar = await context.resolveCalendar(params.calendarId);
  if (calendar.readOnly) {
    throw new Error(`Календарь «${calendar.displayName}» открыт только для чтения.`);
  }

  const href = hrefFor(calendar, params.id);
  const object = await getFor(context)(href);
  const current = parseEvent(object.ics, calendar.id, object.etag);
  const scope: EditScope = params.scope ?? (current.recurrence ? "this" : "all_series");

  if (!current.recurrence || scope === "all_series") {
    await removeFor(context)(href, object.etag);
    return { deleted: params.id, scope: "all_series" };
  }

  if (!params.instanceStart) {
    throw new Error(
      "Для удаления части серии укажите instanceStart — начало удаляемого экземпляра. Либо передайте scope: \"all_series\", чтобы удалить всю серию.",
    );
  }

  const { root, vevent } = veventOf(object.ics);

  if (scope === "this") {
    vevent.addPropertyWithValue(
      "exdate",
      icalTimeOf(params.instanceStart, current.timeZone),
    );
    await putFor(context)(href, root.toString(), { ifMatch: object.etag });
    return { deleted: params.instanceStart, scope };
  }

  const boundary = new Date(new Date(params.instanceStart).getTime() - 1000).toISOString();
  const truncated = buildEvent({
    ...current,
    id: params.id,
    recurrence: { ...current.recurrence, count: undefined, until: boundary },
  });
  await putFor(context)(href, truncated.ics, { ifMatch: object.etag });
  return { deleted: `${params.instanceStart} и далее`, scope };
}
```

Умолчание здесь зависит от типа события: у одиночного удалять «экземпляр» нечего,
поэтому оно сразу трактуется как `all_series`, а у серии по умолчанию исчезает
только названный экземпляр.

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `npx vitest run tests/domain/delete.test.ts`
Expected: PASS, пять тестов.

- [ ] **Step 5: Написать инструмент**

`src/mcp/tools/deleteEvent.ts`:

```ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { defineTool, ok } from "../defineTool.js";
import { deleteEvent } from "../../domain/events.js";
import type { Context } from "../context.js";

export function registerDeleteTool(server: McpServer, context: Context): void {
  defineTool(
    server,
    "delete_event",
    "Удалить событие. У повторяющихся событий по умолчанию исчезает только названный экземпляр; чтобы удалить всю серию, передайте scope: all_series.",
    {
      calendarId: z.string().optional(),
      id: z.string().describe("UID события"),
      scope: z.enum(["this", "this_and_following", "all_series"]).optional(),
      instanceStart: z
        .string()
        .optional()
        .describe("Начало удаляемого экземпляра; обязательно при scope this и this_and_following"),
    },
    async (args) => ok(await deleteEvent(context, args as never)),
  );
}
```

- [ ] **Step 6: Подключить и проверить**

В `src/mcp/server.ts` добавить `import { registerDeleteTool } from "./tools/deleteEvent.js";`
и `registerDeleteTool(server, context);`

Run: `npm run build && npx vitest run`
Expected: сборка без ошибок, все тесты зелёные.

- [ ] **Step 7: Commit**

```bash
git add src tests
git commit -m "Удаление событий с разделением на экземпляр, хвост серии и всю серию"
```

---

## Task 15: Поиск свободных окон — `find_free_slots`

**Files:**
- Create: `src/domain/freeSlots.ts`
- Create: `src/mcp/tools/findFreeSlots.ts`
- Modify: `src/mcp/server.ts`
- Test: `tests/domain/freeSlots.test.ts`

**Interfaces:**
- Consumes: `readEvents` (задача 11)
- Produces:
  - `subtractBusy(window: Interval, busy: Interval[]): Interval[]`
  - `findFreeSlots(context, params: FreeSlotParams): Promise<Array<{ start: string; end: string }>>`
  - `interface Interval { start: Date; end: Date }`
  - `interface FreeSlotParams { from: string; to: string; durationMinutes: number; workingHours?: { start: string; end: string }; weekdays?: number[]; calendarIds?: string[] }`

- [ ] **Step 1: Написать падающие тесты**

`tests/domain/freeSlots.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { subtractBusy } from "../../src/domain/freeSlots.js";

const at = (iso: string) => new Date(iso);

describe("subtractBusy", () => {
  it("возвращает окно целиком, когда занятости нет", () => {
    const free = subtractBusy(
      { start: at("2026-09-21T10:00:00Z"), end: at("2026-09-21T19:00:00Z") },
      [],
    );

    expect(free).toHaveLength(1);
    expect(free[0].start.toISOString()).toBe("2026-09-21T10:00:00.000Z");
  });

  it("вырезает событие в середине окна", () => {
    const free = subtractBusy(
      { start: at("2026-09-21T10:00:00Z"), end: at("2026-09-21T19:00:00Z") },
      [{ start: at("2026-09-21T13:00:00Z"), end: at("2026-09-21T14:00:00Z") }],
    );

    expect(free).toHaveLength(2);
    expect(free[0].end.toISOString()).toBe("2026-09-21T13:00:00.000Z");
    expect(free[1].start.toISOString()).toBe("2026-09-21T14:00:00.000Z");
  });

  it("склеивает пересекающиеся события и не плодит пустые промежутки", () => {
    const free = subtractBusy(
      { start: at("2026-09-21T10:00:00Z"), end: at("2026-09-21T19:00:00Z") },
      [
        { start: at("2026-09-21T12:00:00Z"), end: at("2026-09-21T15:00:00Z") },
        { start: at("2026-09-21T14:00:00Z"), end: at("2026-09-21T16:00:00Z") },
      ],
    );

    expect(free).toHaveLength(2);
    expect(free[0].end.toISOString()).toBe("2026-09-21T12:00:00.000Z");
    expect(free[1].start.toISOString()).toBe("2026-09-21T16:00:00.000Z");
  });

  it("не создаёт пустых промежутков между смежными событиями", () => {
    const free = subtractBusy(
      { start: at("2026-09-21T10:00:00Z"), end: at("2026-09-21T19:00:00Z") },
      [
        { start: at("2026-09-21T12:00:00Z"), end: at("2026-09-21T13:00:00Z") },
        { start: at("2026-09-21T13:00:00Z"), end: at("2026-09-21T14:00:00Z") },
      ],
    );

    expect(free).toHaveLength(2);
    expect(free[0].end.toISOString()).toBe("2026-09-21T12:00:00.000Z");
    expect(free[1].start.toISOString()).toBe("2026-09-21T14:00:00.000Z");
  });

  it("возвращает пустой список, когда занято целиком", () => {
    const free = subtractBusy(
      { start: at("2026-09-21T10:00:00Z"), end: at("2026-09-21T19:00:00Z") },
      [{ start: at("2026-09-21T09:00:00Z"), end: at("2026-09-21T20:00:00Z") }],
    );

    expect(free).toHaveLength(0);
  });

  it("игнорирует занятость за пределами окна", () => {
    const free = subtractBusy(
      { start: at("2026-09-21T10:00:00Z"), end: at("2026-09-21T19:00:00Z") },
      [{ start: at("2026-09-22T10:00:00Z"), end: at("2026-09-22T11:00:00Z") }],
    );

    expect(free).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `npx vitest run tests/domain/freeSlots.test.ts`
Expected: FAIL, модуль не найден.

- [ ] **Step 3: Реализовать**

`src/domain/freeSlots.ts`:

```ts
import { readEvents } from "./events.js";
import type { Context } from "../types.js";

export interface Interval {
  start: Date;
  end: Date;
}

export interface FreeSlotParams {
  from: string;
  to: string;
  durationMinutes: number;
  workingHours?: { start: string; end: string };
  weekdays?: number[];
  calendarIds?: string[];
}

export function subtractBusy(window: Interval, busy: Interval[]): Interval[] {
  const relevant = busy
    .filter((item) => item.end > window.start && item.start < window.end)
    .sort((left, right) => left.start.getTime() - right.start.getTime());

  const free: Interval[] = [];
  let cursor = window.start;

  for (const item of relevant) {
    if (item.start > cursor) free.push({ start: cursor, end: item.start });
    if (item.end > cursor) cursor = item.end;
  }
  if (cursor < window.end) free.push({ start: cursor, end: window.end });

  return free.filter((slot) => slot.end > slot.start);
}

function parseClock(value: string): { hour: number; minute: number } {
  const [hour, minute] = value.split(":").map(Number);
  if (Number.isNaN(hour) || Number.isNaN(minute)) {
    throw new Error(`Время «${value}» должно быть в формате ЧЧ:ММ, например 10:00.`);
  }
  return { hour, minute };
}

export async function findFreeSlots(
  context: Context,
  params: FreeSlotParams,
): Promise<Array<{ start: string; end: string }>> {
  if (params.durationMinutes <= 0) {
    throw new Error("durationMinutes должно быть положительным числом минут.");
  }

  const events = await readEvents(context, {
    from: params.from,
    to: params.to,
    calendarIds: params.calendarIds,
  });
  const busy: Interval[] = events.map((event) => ({
    start: new Date(event.start),
    end: new Date(event.end),
  }));

  const hours = params.workingHours ?? { start: "10:00", end: "19:00" };
  const open = parseClock(hours.start);
  const close = parseClock(hours.end);
  const weekdays = params.weekdays ?? [1, 2, 3, 4, 5];

  const from = new Date(params.from);
  const to = new Date(params.to);
  const slots: Array<{ start: string; end: string }> = [];
  const day = new Date(from);
  day.setHours(0, 0, 0, 0);

  while (day < to) {
    if (weekdays.includes(day.getDay())) {
      const windowStart = new Date(day);
      windowStart.setHours(open.hour, open.minute, 0, 0);
      const windowEnd = new Date(day);
      windowEnd.setHours(close.hour, close.minute, 0, 0);

      const bounded: Interval = {
        start: windowStart < from ? from : windowStart,
        end: windowEnd > to ? to : windowEnd,
      };

      if (bounded.end > bounded.start) {
        for (const slot of subtractBusy(bounded, busy)) {
          const minutes = (slot.end.getTime() - slot.start.getTime()) / 60000;
          if (minutes >= params.durationMinutes) {
            slots.push({ start: slot.start.toISOString(), end: slot.end.toISOString() });
          }
        }
      }
    }
    day.setDate(day.getDate() + 1);
  }

  return slots;
}
```

Рабочие часы считаются в местном поясе процесса. Для личного использования на
одной машине этого достаточно; если понадобится считать в поясе календаря,
это отдельная задача.

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `npx vitest run tests/domain/freeSlots.test.ts`
Expected: PASS, шесть тестов.

- [ ] **Step 5: Написать инструмент**

`src/mcp/tools/findFreeSlots.ts`:

```ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { defineTool, ok } from "../defineTool.js";
import { findFreeSlots } from "../../domain/freeSlots.js";
import type { Context } from "../context.js";

export function registerFreeSlotsTool(server: McpServer, context: Context): void {
  defineTool(
    server,
    "find_free_slots",
    "Свободные окна в собственных календарях с учётом рабочих часов. Календари других людей недоступны.",
    {
      from: z.string().describe("Начало поиска, ISO 8601"),
      to: z.string().describe("Конец поиска, ISO 8601"),
      durationMinutes: z.number().int().positive().describe("Минимальная длина окна в минутах"),
      workingHours: z
        .object({ start: z.string(), end: z.string() })
        .optional()
        .describe("Рабочие часы в формате ЧЧ:ММ, по умолчанию 10:00–19:00"),
      weekdays: z
        .array(z.number().int().min(0).max(6))
        .optional()
        .describe("Дни недели, 0 — воскресенье; по умолчанию с понедельника по пятницу"),
      calendarIds: z.array(z.string()).optional(),
    },
    async (args) => ok(await findFreeSlots(context, args as never)),
  );
}
```

- [ ] **Step 6: Подключить и проверить**

В `src/mcp/server.ts` добавить `import { registerFreeSlotsTool } from "./tools/findFreeSlots.js";`
и `registerFreeSlotsTool(server, context);`

Run: `npm run build && npx vitest run`
Expected: сборка без ошибок, все тесты зелёные.

- [ ] **Step 7: Commit**

```bash
git add src tests
git commit -m "Поиск свободных окон с учётом рабочих часов"
```

---

## Task 16: Проверка на живом аккаунте и подключение к Claude

**Files:**
- Create: `tests/integration/roundtrip.test.ts`
- Create: `README.md`
- Modify: `package.json` (поле `bin`)

**Interfaces:**
- Consumes: весь собранный сервер
- Produces: работающее подключение и описание, как им пользоваться

- [ ] **Step 1: Написать ручной интеграционный тест**

`tests/integration/roundtrip.test.ts`:

```ts
import { afterAll, describe, expect, it } from "vitest";
import { createContext } from "../../src/mcp/context.js";
import { createEvent, deleteEvent, readEvents } from "../../src/domain/events.js";

// Запускается вручную:
//   YANDEX_LOGIN=... YANDEX_APP_PASSWORD=... YANDEX_DEFAULT_TZ=Europe/Moscow \
//   npx vitest run tests/integration --testTimeout=30000
// Меняет настоящий календарь, поэтому в общий прогон не входит.
describe.skip("полный цикл на живом аккаунте", () => {
  const context = createContext(process.env);
  const marker = `проверка mcp ${Date.now()}`;
  let createdId = "";

  it("создаёт событие", async () => {
    const event = await createEvent(context, {
      summary: marker,
      start: "2030-01-15T10:00:00+03:00",
      end: "2030-01-15T11:00:00+03:00",
    });

    expect(event.id).toBeTruthy();
    createdId = event.id;
  });

  it("находит созданное событие чтением", async () => {
    const events = await readEvents(context, {
      from: "2030-01-01T00:00:00+03:00",
      to: "2030-02-01T00:00:00+03:00",
      query: marker,
    });

    expect(events.map((event) => event.summary)).toContain(marker);
  });

  afterAll(async () => {
    if (createdId) {
      await deleteEvent(context, { id: createdId, scope: "all_series" });
    }
  });
});
```

- [ ] **Step 2: Прогнать его вручную**

```bash
YANDEX_LOGIN=... YANDEX_APP_PASSWORD=... YANDEX_DEFAULT_TZ=Europe/Moscow \
  npx vitest run tests/integration --testTimeout=30000
```

Перед запуском убрать `.skip`. Ожидается: два теста проходят, в календаре на
15 января 2030 года кратко появляется и исчезает событие с меткой.
После проверки `.skip` вернуть на место.

- [ ] **Step 3: Убедиться, что общий прогон остался быстрым**

Run: `npx vitest run`
Expected: PASS, интеграционный блок помечен как пропущенный, сеть не задействована.

- [ ] **Step 4: Сделать сервер запускаемым**

```bash
npm pkg set bin.yandex-calendar-mcp=dist/mcp/server.js
npm run build
```

Добавить первой строкой `src/mcp/server.ts`:

```ts
#!/usr/bin/env node
```

- [ ] **Step 5: Написать README**

`README.md` со следующими разделами, каждый — несколько строк:

1. Что это: MCP-сервер к Яндекс Календарю через CalDAV, личное использование.
2. Установка: `npm install && npm run build`.
3. Пароль приложения: Яндекс ID → Безопасность → Пароли приложений → «Календарь».
   Обычный пароль аккаунта не подходит.
4. Подключение — блок конфигурации:

```json
{
  "mcpServers": {
    "yandex-calendar": {
      "command": "node",
      "args": ["/полный/путь/dist/mcp/server.js"],
      "env": {
        "YANDEX_LOGIN": "name@yandex.ru",
        "YANDEX_APP_PASSWORD": "пароль-приложения",
        "YANDEX_DEFAULT_TZ": "Europe/Moscow"
      }
    }
  }
}
```

5. Список инструментов: восемь строк, по одной на инструмент.
6. Ограничения: приглашения участников не рассылаются, свободно/занято чужих
   календарей недоступно; подробности в `docs/yandex-caldav-capabilities.md`.
7. Тесты: `npx vitest run` без сети; интеграционный запускается вручную.

- [ ] **Step 6: Подключить к Claude и проверить вживую**

Прописать блок из шага 5 в конфигурацию Claude, перезапустить приложение,
попросить показать календари и создать одно тестовое событие, затем удалить его.

- [ ] **Step 7: Commit**

```bash
git add README.md package.json tests/integration src/mcp/server.ts
git commit -m "Ручной интеграционный тест, запуск сервера и README"
```

---

## Порядок и зависимости

Задача 1 требует живого аккаунта и даёт фикстуры для задач 4, 5, 6, 8, 9.
Задачи 2 и 3 ни от чего не зависят и могут идти параллельно с 1.
Задача 10 — первый момент, когда сервер работает целиком; до неё проверка
идёт только тестами.

| Задача | Зависит от |
|---|---|
| 1 Проверка сервера | — |
| 2 Каркас | — |
| 3 HTTP-слой | 2 |
| 4 XML | 1, 2 |
| 5 Типы и обнаружение | 3, 4 |
| 6 Разбор VEVENT | 2, 5 |
| 7 Сборка VEVENT | 6 |
| 8 Раскрытие повторов | 6, 7 |
| 9 Объекты календаря | 3, 4 |
| 10 Сервер и list_calendars | 5, 9 |
| 11 Чтение событий | 8, 9, 10 |
| 12 Создание | 7, 11 |
| 13 Правка | 12 |
| 14 Удаление | 13 |
| 15 Свободные окна | 11 |
| 16 Живая проверка | 12, 14, 15 |
