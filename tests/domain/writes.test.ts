// Доставка записи на сервер (З12): deliver по правилам неизвестного исхода
// (Р8) и writeSplit для разреза серии (Р9) — с поправками по живой сверке
// (docs/yandex-caldav-capabilities.md, Ж12–Ж16; раздел поправок плана
// docs/superpowers/plans/2026-09-19-recurring-events-rework.md).
//
// Всё — на изменяемом стенде tests/support через настоящий транспорт
// createClient(config, fake.fetch): порт ioFor(ctx) идёт в боевые
// queryEventByUid, putObjectWithStatus и deleteObject. Стенд по умолчанию
// ведёт себя как Яндекс: If-None-Match и If-Match на DELETE не соблюдаются
// (Ж13, Ж15), PUT с If-Match по пустому пути создаёт объект и отвечает 201
// (Ж16); режим conditions "rfc" — там, где нужен именно 412.
//
// semanticDigest обёрнут счётчиком: дайджест давней частой серии считается
// около секунды, поэтому прежний дайджест вызывающий считает один раз и
// передаёт в before, а deliver считает только то, без чего правило не
// проверить.
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { CaldavError } from "../../src/caldav/request.js";
import { hrefFor } from "../../src/domain/events.js";
import { DeliveryError, deliver, ioFor, writeSplit, type DeliveryIO, type KnownState, type SplitWrite } from "../../src/domain/writes.js";
import { semanticDigest } from "../../src/ical/object.js";
import { vtimezoneFor } from "../../src/ical/timezones.js";
import type { IcalEnv } from "../../src/ical/values.js";
import type { Calendar, Context, ObjectIO, PutOutcome } from "../../src/types.js";
import { calendarA, makeStand, OWNER, plant, yandexPath } from "../support/context.js";
import { yandexNormalize, type FakeCaldav, type FakeCaldavOptions } from "../support/fakeCaldav.js";
import { weeklyMoscow } from "../support/seeds.js";

const digestCalls = vi.hoisted(() => ({ count: 0 }));

vi.mock("../../src/ical/object.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/ical/object.js")>();
  return {
    ...actual,
    semanticDigest: (ics: string, env: IcalEnv) => {
      digestCalls.count += 1;
      return actual.semanticDigest(ics, env);
    },
  };
});

// ---------------------------------------------------------------------------
// Тексты объектов
// ---------------------------------------------------------------------------

const ENV: IcalEnv = { floatingZone: "Europe/Moscow", ownerEmail: OWNER };
const UID = weeklyMoscow.uid;
/** Пн и Ср 10:00–11:00 МСК с 19.10.2026, COUNT=6 — как лежит на Яндексе. */
const SEED = weeklyMoscow.ics;

const restampOf = (ics: string) => ics.replace("DTSTAMP:20261001T090000Z", "DTSTAMP:20261001T100000Z");

/** Правка поля: смысл меняется. */
const RENAMED = restampOf(SEED.replace("SUMMARY:Планёрка", "SUMMARY:Итоги"));

/** Правка только метаданных: смысл прежний, ожидаемый дайджест равен прежнему. */
const RESTAMPED = restampOf(SEED).replace("SEQUENCE:0", "SEQUENCE:1");

/** {timeZone}: пояс Екатеринбурга при тех же моментах (О8) — меняет только TZID. */
const REZONED = restampOf(SEED)
  .replace("DTSTART;TZID=Europe/Moscow:20261019T100000", "DTSTART;TZID=Asia/Yekaterinburg:20261019T120000")
  .replace("DTEND;TZID=Europe/Moscow:20261019T110000", "DTEND;TZID=Asia/Yekaterinburg:20261019T130000")
  .replace("END:VTIMEZONE", `END:VTIMEZONE\r\n${vtimezoneFor("Asia/Yekaterinburg").toString()}`);

/** Правка другим клиентом. */
const externalRename = (ics: string) => ics.replace("SUMMARY:Планёрка", "SUMMARY:Планёрка (важно)");

// Разрез 26.10: исходная серия — две встречи, продолжение — четыре с новым местом.
const BOUNDARY = "2026-10-26T10:00:00+03:00";
const CONT_UID = `ycm-${createHash("sha256").update(`${UID}\n${BOUNDARY}`).digest("hex").slice(0, 32)}`;
const CONT_HREF = hrefFor(calendarA, CONT_UID);
const TRUNCATED = restampOf(SEED).replace("COUNT=6", "COUNT=2");

function continuationWith(location: string): string {
  return restampOf(SEED)
    .replace(`UID:${UID}`, `UID:${CONT_UID}`)
    .replace("DTSTART;TZID=Europe/Moscow:20261019T100000", "DTSTART;TZID=Europe/Moscow:20261026T100000")
    .replace("DTEND;TZID=Europe/Moscow:20261019T110000", "DTEND;TZID=Europe/Moscow:20261026T110000")
    .replace("COUNT=6", "COUNT=4")
    .replace("SUMMARY:Планёрка", `SUMMARY:Планёрка\r\nLOCATION:${location}`)
    .replace("SEQUENCE:0\r\n", "")
    .replace(/CREATED:[^\r]*\r\n/, "");
}

const CONTINUATION = continuationWith("Переговорная 5");
const SPLIT: SplitWrite = { continuation: { uid: CONT_UID, ics: CONTINUATION }, truncated: { ics: TRUNCATED } };

// ---------------------------------------------------------------------------
// Стенд
// ---------------------------------------------------------------------------

interface Setup {
  fake: FakeCaldav;
  ctx: Context;
  io: DeliveryIO;
  calendar: Calendar;
  path: string;
  /** Прочитанное в этом вызове состояние серии, дайджест посчитан один раз. */
  before: KnownState;
}

async function setup(options: FakeCaldavOptions = {}): Promise<Setup> {
  const { fake, ctx, calendar } = makeStand(options);
  const path = plant(fake, weeklyMoscow);
  const io = ioFor(ctx);
  const before = await known(io, calendar);
  return { fake, ctx, io, calendar, path, before };
}

/** Чтение серии, как его делает вызывающий код: путь и ETag с сервера, дайджест — один раз. */
async function known(io: DeliveryIO, calendar: Calendar): Promise<KnownState> {
  const found = await io.find(calendar, UID);
  expect(found, "серия на сервере").toBeDefined();
  const state = { uid: UID, href: found!.href, etag: found!.etag, digest: semanticDigest(found!.ics, ENV) };
  digestCalls.count = 0;
  return state;
}

/** Журнал запросов после отметки: метод, чей путь, условие, код ответа. */
function journal(fake: FakeCaldav, mark: number, setup: Pick<Setup, "path" | "before" | "calendar">): string[] {
  const names: Record<string, string> = {
    [setup.path]: "исходный",
    [CONT_HREF]: "продолжение",
    [setup.calendar.href]: "календарь",
  };
  return fake.since(mark).map((entry) => {
    let condition = "";
    if (entry.ifMatch !== undefined) condition = ` If-Match=${entry.ifMatch === setup.before.etag ? "прочитанный" : entry.ifMatch}`;
    if (entry.ifNoneMatch !== undefined) condition += ` If-None-Match=${entry.ifNoneMatch}`;
    return `${entry.method} ${names[entry.path] ?? entry.path}${condition} → ${entry.status}`;
  });
}

async function failure(run: () => Promise<unknown>): Promise<DeliveryError> {
  try {
    await run();
  } catch (error) {
    expect(error, error instanceof Error ? error.message : String(error)).toBeInstanceOf(DeliveryError);
    return error as DeliveryError;
  }
  throw new Error("ожидался отказ DeliveryError, а вызов прошёл");
}

/** Второй основной компонент: строгий стенд отвечает на такой PUT 400. */
const TWO_MASTERS = SEED.replace("END:VCALENDAR", SEED.slice(SEED.indexOf("BEGIN:VEVENT"), SEED.indexOf("END:VCALENDAR")) + "END:VCALENDAR");

// ---------------------------------------------------------------------------
// ioFor
// ---------------------------------------------------------------------------

describe("ioFor: порт ввода-вывода на транспорте CalDAV", () => {
  it("find берёт путь и ETag из ответа сервера, а не собирает путь из UID", async () => {
    const { fake, io, calendar, path } = await setup();
    const found = await io.find(calendar, UID);
    expect(found?.href).toBe(yandexPath(calendarA, UID));
    expect(found?.href).not.toBe(hrefFor(calendarA, UID));
    expect(found?.etag).toBe(fake.etag(path));
    expect(await io.find(calendar, "нет-такого@yandex.ru")).toBeUndefined();
  });

  it("put с If-Match — applied и ETag из ответа; без ETag в ответе — пустая строка", async () => {
    const { fake, io, path, before } = await setup();
    // Замена существующего объекта — ответ 204, пометки «создан» нет.
    expect(await io.put(path, RENAMED, { ifMatch: before.etag })).toEqual({ status: "applied", etag: fake.etag(path) });
    expect(fake.log.at(-1)?.status).toBe(204);
    expect(fake.log.at(-1)?.ifMatch).toBe(before.etag);

    const silent = await setup({ etagOnPut: false });
    expect(await silent.io.put(silent.path, RENAMED, { ifMatch: silent.before.etag })).toEqual({ status: "applied", etag: "" });
  });

  it("put с If-None-Match шлёт заголовок «*» по заданному пути", async () => {
    const { fake, io } = await setup();
    const outcome = await io.put(CONT_HREF, CONTINUATION, { ifNoneMatch: "*" });
    expect(outcome).toEqual({ status: "applied", etag: fake.etag(CONT_HREF), created: true });
    expect(fake.log.at(-1)?.ifNoneMatch).toBe("*");
  });

  it("ответ 201 помечается created — и при создании, и при записи по пустому пути (Ж16)", async () => {
    const { fake, io, path, before } = await setup();
    fake.externalDelete(path);
    const outcome = await io.put(path, RENAMED, { ifMatch: before.etag });
    expect(outcome, "сервер создал объект, а не заменил").toEqual({ status: "applied", etag: fake.etag(path), created: true });
    expect(fake.log.at(-1)?.status).toBe(201);
  });

  it("сбои — значения, а не исключения; каждый запрос уходит ровно один раз", async () => {
    const { fake, io, path, before } = await setup({ conditions: "rfc" });
    const mark = fake.mark();

    expect(await io.put(path, RENAMED, { ifMatch: "1" })).toEqual({ status: "precondition-failed" });
    expect(await io.remove(`${calendarA.href}missing.ics`, "1")).toEqual({ status: "not-found" });

    const rejected = await io.put(path, TWO_MASTERS, { ifMatch: before.etag });
    expect(rejected.status).toBe("rejected");
    expect((rejected as Extract<PutOutcome, { status: "rejected" }>).error).toBeInstanceOf(CaldavError);

    fake.rejectBeforeApply({ method: "PUT" }, 507);
    const full = await io.put(path, RENAMED, { ifMatch: before.etag });
    expect(full.status).toBe("unknown");
    expect(((full as Extract<PutOutcome, { status: "unknown" }>).error as CaldavError).applied).toBe("unknown");

    fake.dropRequest({ method: "DELETE" }, "network");
    expect((await io.remove(path, before.etag)).status).toBe("unknown");

    expect(fake.since(mark).map((e) => `${e.method} ${e.status}`)).toEqual(["PUT 412", "DELETE 404", "PUT 400", "PUT 507", "DELETE 0"]);
    expect(fake.ics(path)).toBe(SEED);
  });

  it("Context.io подменяет транспорт целиком", async () => {
    const { ctx } = makeStand();
    const custom: ObjectIO = {
      find: async () => undefined,
      put: async () => ({ status: "applied", etag: "x" }),
      remove: async () => ({ status: "applied" }),
    };
    expect(ioFor({ ...ctx, io: custom })).toBe(custom);
  });
});

// ---------------------------------------------------------------------------
// deliver: правка
// ---------------------------------------------------------------------------

describe("deliver: правка — PUT с If-Match прочитанного ETag (Р8)", () => {
  it("успех: одна запись, без перечитывания и без дайджестов", async () => {
    const s = await setup();
    const mark = s.fake.mark();
    const result = await deliver(s.io, s.calendar, { kind: "put", ics: RENAMED }, s.before, ENV);
    expect(journal(s.fake, mark, s)).toEqual(["PUT исходный If-Match=прочитанный → 204"]);
    expect(result).toEqual({ href: s.path, etag: s.fake.etag(s.path), confirmedByReread: false, retried: false });
    expect(s.fake.ics(s.path)).toBe(RENAMED);
    expect(digestCalls.count, "дайджест при успехе не нужен").toBe(0);
  });

  it("412: событие изменили после чтения — conflict, без перечитывания и повтора", async () => {
    const s = await setup();
    s.fake.beforeRequest = (request) => {
      if (request.method === "PUT") s.fake.externalEdit(s.path, externalRename);
      s.fake.beforeRequest = undefined;
    };
    const mark = s.fake.mark();
    const error = await failure(() => deliver(s.io, s.calendar, { kind: "put", ics: RENAMED }, s.before, ENV));
    expect(error.code).toBe("conflict");
    expect(error.message).toMatch(/изменили/);
    expect(journal(s.fake, mark, s)).toEqual(["PUT исходный If-Match=прочитанный → 412"]);
    expect(s.fake.ics(s.path)).toBe(externalRename(SEED));
  });

  it("правило 3: ответ потерян, запись дошла — «применено» перечитыванием, PUT один", async () => {
    const s = await setup();
    s.fake.loseResponse({ method: "PUT" }, "network");
    const mark = s.fake.mark();
    const result = await deliver(s.io, s.calendar, { kind: "put", ics: RENAMED }, s.before, ENV);
    expect(journal(s.fake, mark, s)).toEqual(["PUT исходный If-Match=прочитанный → 0", "REPORT календарь → 207"]);
    expect(result).toEqual({ href: s.path, etag: s.fake.etag(s.path), confirmedByReread: true, retried: false });
    expect(s.fake.ics(s.path)).toBe(RENAMED);
    expect(digestCalls.count, "ожидаемый и перечитанный; прежний не пересчитывается").toBe(2);
  });

  it("правило 3 при нормализации «как Яндекс»: сервер переписал текст, а «применено» узнаётся", async () => {
    const s = await setup({ normalizeOnStore: true });
    s.fake.loseResponse({ method: "PUT" }, 503);
    const result = await deliver(s.io, s.calendar, { kind: "put", ics: RENAMED }, s.before, ENV);
    expect(s.fake.ics(s.path), "сервер хранит переписанный текст").not.toBe(RENAMED);
    expect(result.confirmedByReread).toBe(true);
    expect(s.fake.writes().filter((w) => w.method === "PUT")).toHaveLength(1);
  });

  it("правило 2: запись не дошла — перечитывание и ровно одна повторная попытка", async () => {
    const s = await setup();
    s.fake.dropRequest({ method: "PUT" }, 504);
    const mark = s.fake.mark();
    const result = await deliver(s.io, s.calendar, { kind: "put", ics: RENAMED }, s.before, ENV);
    expect(journal(s.fake, mark, s)).toEqual([
      "PUT исходный If-Match=прочитанный → 504",
      "REPORT календарь → 207",
      "PUT исходный If-Match=прочитанный → 204",
    ]);
    expect(result).toEqual({ href: s.path, etag: s.fake.etag(s.path), confirmedByReread: false, retried: true });
    expect(s.fake.ics(s.path)).toBe(RENAMED);
    expect(digestCalls.count, "только перечитанный: ETag и смысл прежние").toBe(1);
  });

  it("правило 2 дважды: повтор тоже не дошёл — not-delivered, третьей попытки нет", async () => {
    const s = await setup();
    s.fake.dropRequest({ method: "PUT" }, "timeout", { times: 2 });
    const mark = s.fake.mark();
    const error = await failure(() => deliver(s.io, s.calendar, { kind: "put", ics: RENAMED }, s.before, ENV));
    expect(error.code).toBe("not-delivered");
    expect(journal(s.fake, mark, s)).toEqual([
      "PUT исходный If-Match=прочитанный → 0",
      "REPORT календарь → 207",
      "PUT исходный If-Match=прочитанный → 0",
      "REPORT календарь → 207",
    ]);
    expect(s.fake.ics(s.path)).toBe(SEED);
  });

  it("правило 2, затем потерянный ответ на повтор — «применено» перечитыванием", async () => {
    const s = await setup();
    s.fake.dropRequest({ method: "PUT" }, 504);
    s.fake.loseResponse({ method: "PUT" }, "network", { nth: 2 });
    const result = await deliver(s.io, s.calendar, { kind: "put", ics: RENAMED }, s.before, ENV);
    expect(result).toMatchObject({ confirmedByReread: true, retried: true, etag: s.fake.etag(s.path) });
    expect(s.fake.writes().map((w) => w.status)).toEqual([504, 0]);
  });

  it("{timeZone} при dropRequest: дайджест различает пояс — одна повторная попытка, пояс сменён", async () => {
    const s = await setup();
    s.fake.dropRequest({ method: "PUT" }, 504);
    const result = await deliver(s.io, s.calendar, { kind: "put", ics: REZONED }, s.before, ENV);
    expect(result.retried).toBe(true);
    expect(s.fake.ics(s.path)).toContain("DTSTART;TZID=Asia/Yekaterinburg:20261019T120000");
    expect(s.fake.writes().map((w) => w.status)).toEqual([504, 204]);
  });

  it("{timeZone} при потерянном ответе: смена пояса при тех же моментах распознаётся как «применено»", async () => {
    const s = await setup();
    s.fake.loseResponse({ method: "PUT" }, 504);
    const result = await deliver(s.io, s.calendar, { kind: "put", ics: REZONED }, s.before, ENV);
    expect(result).toMatchObject({ confirmedByReread: true, retried: false });
    expect(s.fake.writes()).toHaveLength(1);
  });

  it("ожидаемый дайджест равен прежнему и запись не дошла — повтор, а не ложное «применено» (правило 2 раньше 3)", async () => {
    const s = await setup();
    s.fake.dropRequest({ method: "PUT" }, 504);
    const result = await deliver(s.io, s.calendar, { kind: "put", ics: RESTAMPED }, s.before, ENV);
    expect(result).toMatchObject({ confirmedByReread: false, retried: true });
    expect(s.fake.ics(s.path)).toBe(RESTAMPED);
    expect(s.fake.writes().map((w) => w.status)).toEqual([504, 204]);
  });

  it("ожидаемый дайджест равен прежнему и ответ потерян — решает ETag: «применено»", async () => {
    const s = await setup();
    s.fake.loseResponse({ method: "PUT" }, "network");
    const result = await deliver(s.io, s.calendar, { kind: "put", ics: RESTAMPED }, s.before, ENV);
    expect(result).toMatchObject({ confirmedByReread: true, retried: false, etag: s.fake.etag(s.path) });
    expect(s.fake.writes()).toHaveLength(1);
  });

  it("правило 4: запись не дошла, а событие изменил другой клиент — unknown с текущим состоянием, без повтора", async () => {
    const s = await setup();
    s.fake.beforeRequest = (request) => {
      if (request.method === "PUT") s.fake.externalEdit(s.path, externalRename);
    };
    s.fake.dropRequest({ method: "PUT" }, 504);
    const error = await failure(() => deliver(s.io, s.calendar, { kind: "put", ics: RENAMED }, s.before, ENV));
    expect(error.code).toBe("unknown");
    expect(error.current?.ics).toContain("SUMMARY:Планёрка (важно)");
    expect(error.current?.etag).toBe(s.fake.etag(s.path));
    expect(s.fake.writes()).toHaveLength(1);
  });

  it("нет ложного «применено» при normalizeOnStore: другой клиент пересохранил тот же смысл, запись не дошла", async () => {
    // Текст и ETag сменились (Ж12), смысл прежний: по тексту или по одному
    // ETag это выглядело бы как применённая запись.
    const s = await setup({ normalizeOnStore: true });
    s.fake.beforeRequest = (request) => {
      if (request.method === "PUT") s.fake.externalEdit(s.path, (ics) => yandexNormalize(ics, { owner: OWNER, calendarName: "Мои события" }));
    };
    s.fake.dropRequest({ method: "PUT" }, 504);
    const error = await failure(() => deliver(s.io, s.calendar, { kind: "put", ics: RENAMED }, s.before, ENV));
    expect(error.code).toBe("unknown");
    expect(s.fake.ics(s.path)).not.toContain("SUMMARY:Итоги");
    expect(s.fake.writes()).toHaveLength(1);
  });

  it("правило 1: запись не дошла, а событие удалили — conflict, объект не воскрешён", async () => {
    const s = await setup();
    s.fake.beforeRequest = (request) => {
      if (request.method === "PUT" && s.fake.has(s.path)) s.fake.externalDelete(s.path);
    };
    s.fake.dropRequest({ method: "PUT" }, 504);
    const error = await failure(() => deliver(s.io, s.calendar, { kind: "put", ics: RENAMED }, s.before, ENV));
    expect(error.code).toBe("conflict");
    expect(error.message).toMatch(/удал/);
    expect(s.fake.has(s.path)).toBe(false);
    expect(s.fake.writes()).toHaveLength(1);
  });

  it("другой клиент удалил событие до нашего PUT (Ж16): ответ 201 — не успех, а конфликт", async () => {
    const s = await setup();
    // Удаление успевает пройти между нашим чтением и записью: If-Match по
    // пустому пути Яндекс не отклоняет, а создаёт объект нашим текстом.
    s.fake.externalDelete(s.path);
    const mark = s.fake.mark();
    const error = await failure(() => deliver(s.io, s.calendar, { kind: "put", ics: RENAMED }, s.before, ENV));
    expect(error.code).toBe("conflict");
    expect(error.recreated, "правка создала удалённое событие заново").toBe(true);
    expect(error.message).toMatch(/удалили/);
    expect(error.message).toMatch(/создал событие заново/);
    expect(error.message, "во внятном тексте нет внутренних обозначений").not.toMatch(/Ж1|201/);
    expect(journal(s.fake, mark, s)).toEqual(["PUT исходный If-Match=прочитанный → 201"]);
    expect(s.fake.ics(s.path), "воскрешённый объект остаётся с правкой: вслепую его не стираем").toBe(RENAMED);
    expect(digestCalls.count, "исход дал ответ сервера — сверять смысл не нужно").toBe(0);
  });

  it("отказ сервера (4xx): rejected, без перечитывания и повтора", async () => {
    const s = await setup();
    const mark = s.fake.mark();
    const error = await failure(() => deliver(s.io, s.calendar, { kind: "put", ics: TWO_MASTERS }, s.before, ENV));
    expect(error.code).toBe("rejected");
    expect(journal(s.fake, mark, s)).toEqual(["PUT исходный If-Match=прочитанный → 400"]);
  });

  it("перечитать не удалось — unknown с объяснением, повторов записи нет", async () => {
    const s = await setup();
    s.fake.loseResponse({ method: "PUT" }, "network");
    s.fake.dropRequest({ method: "REPORT" }, 504, { times: 10 });
    const error = await failure(() => deliver(s.io, s.calendar, { kind: "put", ics: RENAMED }, s.before, ENV));
    expect(error.code).toBe("unknown");
    expect(error.message).toMatch(/неизвест/);
    expect(error.current).toBeUndefined();
    expect(s.fake.writes()).toHaveLength(1);
  });

  it("правка без прочитанного состояния — программная ошибка до запросов", async () => {
    const s = await setup();
    const mark = s.fake.mark();
    await expect(deliver(s.io, s.calendar, { kind: "put", ics: RENAMED }, undefined, ENV)).rejects.toThrow(/прочитан/);
    expect(s.fake.since(mark)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// deliver: создание
// ---------------------------------------------------------------------------

describe("deliver: создание — PUT с If-None-Match (Р8)", () => {
  const create = { kind: "create", uid: CONT_UID, href: CONT_HREF, ics: CONTINUATION } as const;

  it("успех: один PUT с If-None-Match: * по заданному пути", async () => {
    const s = await setup();
    const mark = s.fake.mark();
    const result = await deliver(s.io, s.calendar, create, undefined, ENV);
    expect(journal(s.fake, mark, s)).toEqual(["PUT продолжение If-None-Match=* → 201"]);
    expect(result).toEqual({ href: CONT_HREF, etag: s.fake.etag(CONT_HREF), confirmedByReread: false, retried: false });
  });

  it("ответ потерян, объект на месте и совпал по смыслу — «применено»", async () => {
    const s = await setup({ normalizeOnStore: true });
    s.fake.loseResponse({ method: "PUT" }, "timeout");
    const result = await deliver(s.io, s.calendar, create, undefined, ENV);
    expect(result).toEqual({ href: CONT_HREF, etag: s.fake.etag(CONT_HREF), confirmedByReread: true, retried: false });
    expect(s.fake.writes()).toHaveLength(1);
  });

  it("правило 1: объекта нет — одна повторная попытка с If-None-Match", async () => {
    const s = await setup();
    s.fake.dropRequest({ method: "PUT" }, 504);
    const mark = s.fake.mark();
    const result = await deliver(s.io, s.calendar, create, undefined, ENV);
    expect(journal(s.fake, mark, s)).toEqual([
      "PUT продолжение If-None-Match=* → 504",
      "REPORT календарь → 207",
      "PUT продолжение If-None-Match=* → 201",
    ]);
    expect(result.retried).toBe(true);
  });

  it("повтор создания тоже не дошёл — not-delivered, объекта нет", async () => {
    const s = await setup();
    s.fake.dropRequest({ method: "PUT" }, 504, { times: 2 });
    const error = await failure(() => deliver(s.io, s.calendar, create, undefined, ENV));
    expect(error.code).toBe("not-delivered");
    expect(s.fake.has(CONT_HREF)).toBe(false);
    expect(s.fake.writes()).toHaveLength(2);
  });

  it("412 (RFC): объект уже есть и совпал по смыслу — «применено» перечитыванием", async () => {
    const s = await setup({ conditions: "rfc" });
    s.fake.seedRaw(CONT_HREF, yandexNormalize(CONTINUATION, { owner: OWNER }));
    const result = await deliver(s.io, s.calendar, create, undefined, ENV);
    expect(result).toMatchObject({ href: CONT_HREF, confirmedByReread: true, retried: false });
    expect(s.fake.writes().map((w) => w.status)).toEqual([412]);
  });

  it("412 (RFC): объект уже есть и другой — exists с текущим состоянием", async () => {
    const s = await setup({ conditions: "rfc" });
    s.fake.seedRaw(CONT_HREF, continuationWith("Переговорная 7"));
    const error = await failure(() => deliver(s.io, s.calendar, create, undefined, ENV));
    expect(error.code).toBe("exists");
    expect(error.current?.ics).toContain("Переговорная 7");
  });
});

// ---------------------------------------------------------------------------
// deliver: удаление
// ---------------------------------------------------------------------------

describe("deliver: удаление — чтение и сверка ETag перед DELETE (Ж15)", () => {
  it("успех: сначала чтение, затем DELETE с If-Match прочитанного ETag", async () => {
    const s = await setup();
    const mark = s.fake.mark();
    const result = await deliver(s.io, s.calendar, { kind: "delete" }, s.before, ENV);
    expect(journal(s.fake, mark, s)).toEqual(["REPORT календарь → 207", "DELETE исходный If-Match=прочитанный → 204"]);
    expect(result).toEqual({ href: s.path, etag: "", confirmedByReread: false, retried: false });
    expect(s.fake.has(s.path)).toBe(false);
  });

  it("ETag не совпал: сервер удалил бы (Ж15), но DELETE не уходит — conflict", async () => {
    const s = await setup();
    s.fake.externalEdit(s.path, externalRename);
    const mark = s.fake.mark();
    const error = await failure(() => deliver(s.io, s.calendar, { kind: "delete" }, s.before, ENV));
    expect(error.code).toBe("conflict");
    expect(error.message).toMatch(/изменили/);
    expect(error.current?.etag).toBe(s.fake.etag(s.path));
    expect(journal(s.fake, mark, s)).toEqual(["REPORT календарь → 207"]);
    expect(s.fake.ics(s.path)).toBe(externalRename(SEED));
  });

  it("объекта уже нет до удаления — «уже удалено», DELETE не уходит", async () => {
    const s = await setup();
    s.fake.externalDelete(s.path);
    const mark = s.fake.mark();
    const result = await deliver(s.io, s.calendar, { kind: "delete" }, s.before, ENV);
    expect(result).toEqual({ href: s.path, etag: "", confirmedByReread: true, retried: false, alreadyGone: true });
    expect(journal(s.fake, mark, s)).toEqual(["REPORT календарь → 207"]);
  });

  it("правило 1: ответ на DELETE потерян, объекта нет — удалено, DELETE один", async () => {
    const s = await setup();
    s.fake.loseResponse({ method: "DELETE" }, 503);
    const mark = s.fake.mark();
    const result = await deliver(s.io, s.calendar, { kind: "delete" }, s.before, ENV);
    expect(journal(s.fake, mark, s)).toEqual([
      "REPORT календарь → 207",
      "DELETE исходный If-Match=прочитанный → 503",
      "REPORT календарь → 207",
    ]);
    expect(result).toEqual({ href: s.path, etag: "", confirmedByReread: true, retried: false });
    expect(digestCalls.count).toBe(0);
  });

  it("правило 2: DELETE не дошёл — одна повторная попытка", async () => {
    const s = await setup();
    s.fake.dropRequest({ method: "DELETE" }, 504);
    const mark = s.fake.mark();
    const result = await deliver(s.io, s.calendar, { kind: "delete" }, s.before, ENV);
    expect(journal(s.fake, mark, s)).toEqual([
      "REPORT календарь → 207",
      "DELETE исходный If-Match=прочитанный → 504",
      "REPORT календарь → 207",
      "DELETE исходный If-Match=прочитанный → 204",
    ]);
    expect(result.retried).toBe(true);
    expect(s.fake.has(s.path)).toBe(false);
  });

  it("правило 2 дважды — not-delivered, объект цел, третьей попытки нет", async () => {
    const s = await setup();
    s.fake.dropRequest({ method: "DELETE" }, "network", { times: 2 });
    const error = await failure(() => deliver(s.io, s.calendar, { kind: "delete" }, s.before, ENV));
    expect(error.code).toBe("not-delivered");
    expect(s.fake.ics(s.path)).toBe(SEED);
    expect(s.fake.writes()).toHaveLength(2);
  });

  it("правило 4 при неизвестном исходе: объект на месте, но изменён — unknown с текущим состоянием", async () => {
    const s = await setup();
    s.fake.beforeRequest = (request) => {
      if (request.method === "DELETE") s.fake.externalEdit(s.path, externalRename);
    };
    s.fake.dropRequest({ method: "DELETE" }, 504);
    const error = await failure(() => deliver(s.io, s.calendar, { kind: "delete" }, s.before, ENV));
    expect(error.code).toBe("unknown");
    expect(error.current?.ics).toContain("(важно)");
    expect(s.fake.writes()).toHaveLength(1);
  });

  it("412 на DELETE (RFC, гонка после чтения): перечитывание, объект изменён — conflict, объект цел", async () => {
    const s = await setup({ conditions: "rfc" });
    s.fake.beforeRequest = (request) => {
      if (request.method === "DELETE") s.fake.externalEdit(s.path, externalRename);
    };
    const mark = s.fake.mark();
    const error = await failure(() => deliver(s.io, s.calendar, { kind: "delete" }, s.before, ENV));
    expect(error.code).toBe("conflict");
    expect(journal(s.fake, mark, s)).toEqual([
      "REPORT календарь → 207",
      "DELETE исходный If-Match=прочитанный → 412",
      "REPORT календарь → 207",
    ]);
    expect(s.fake.ics(s.path)).toBe(externalRename(SEED));
  });

  it("404 на DELETE (удалили после чтения): перечитывание — «уже удалено»", async () => {
    const s = await setup();
    s.fake.beforeRequest = (request) => {
      if (request.method === "DELETE" && s.fake.has(s.path)) s.fake.externalDelete(s.path);
    };
    const result = await deliver(s.io, s.calendar, { kind: "delete" }, s.before, ENV);
    expect(result).toMatchObject({ confirmedByReread: true, retried: false });
    expect(s.fake.writes().map((w) => w.status)).toEqual([404]);
  });
});

// ---------------------------------------------------------------------------
// writeSplit
// ---------------------------------------------------------------------------

describe("writeSplit: разрез серии — продолжение, затем усечение (Р9, Ж13)", () => {
  it("успех: чтение продолжения по UID, PUT продолжения, PUT усечения; без DELETE", async () => {
    const s = await setup();
    const bodies: string[] = [];
    s.fake.beforeRequest = (request) => {
      if (request.method === "REPORT") bodies.push(request.body);
    };
    const mark = s.fake.mark();
    const result = await writeSplit(s.io, s.calendar, s.before, SPLIT, ENV);
    expect(journal(s.fake, mark, s)).toEqual([
      "REPORT календарь → 207",
      "PUT продолжение If-None-Match=* → 201",
      "PUT исходный If-Match=прочитанный → 204",
    ]);
    expect(bodies[0], "до создания продолжения код прочитал, нет ли его уже").toContain(CONT_UID);
    expect(result).toEqual({
      continuation: { uid: CONT_UID, href: CONT_HREF, etag: s.fake.etag(CONT_HREF), created: true },
      truncated: { href: s.path, etag: s.fake.etag(s.path), confirmedByReread: false, retried: false },
    });
    expect(s.fake.ics(CONT_HREF)).toBe(CONTINUATION);
    expect(s.fake.ics(s.path)).toBe(TRUNCATED);
    expect(digestCalls.count, "продолжения не было — сверять нечего").toBe(0);
  });

  it("продолжение уже есть и совпадает с планом по смыслу — только усечение", async () => {
    const s = await setup();
    s.fake.seedRaw(CONT_HREF, yandexNormalize(CONTINUATION, { owner: OWNER, calendarName: "Мои события", countToUntil: true }));
    const mark = s.fake.mark();
    const result = await writeSplit(s.io, s.calendar, s.before, SPLIT, ENV);
    expect(journal(s.fake, mark, s)).toEqual(["REPORT календарь → 207", "PUT исходный If-Match=прочитанный → 204"]);
    expect(result.continuation).toMatchObject({ uid: CONT_UID, href: CONT_HREF, created: false });
    expect(s.fake.ics(s.path)).toBe(TRUNCATED);
  });

  it("продолжение уже есть и отличается — split-stale-continuation с различиями, записей нет", async () => {
    const s = await setup();
    const stale = continuationWith("Переговорная 7");
    s.fake.seedRaw(CONT_HREF, stale);
    const mark = s.fake.mark();
    const error = await failure(() => writeSplit(s.io, s.calendar, s.before, SPLIT, ENV));
    expect(error.code).toBe("split-stale-continuation");
    expect(error.message).toContain(CONT_UID);
    expect(error.continuation).toEqual({ uid: CONT_UID, href: CONT_HREF });
    expect(error.differences?.join("\n")).toContain("Переговорная 7");
    expect(error.differences?.join("\n")).toContain("Переговорная 5");
    expect(error.message).toMatch(/ничего не записано/);
    expect(s.fake.writesSince(mark)).toEqual([]);
    expect(s.fake.ics(s.path)).toBe(SEED);
    expect(s.fake.ics(CONT_HREF)).toBe(stale);
  });

  it("различия называют пропавшие и лишние встречи продолжения", async () => {
    const s = await setup();
    s.fake.seedRaw(CONT_HREF, CONTINUATION.replace("COUNT=4", "COUNT=3"));
    const error = await failure(() => writeSplit(s.io, s.calendar, s.before, SPLIT, ENV));
    expect(error.code).toBe("split-stale-continuation");
    expect(error.differences?.join("\n")).toContain("2026-11-04T10:00:00+03:00");
  });

  for (const normalizeOnStore of [false, true]) {
    it(`507 на усечении${normalizeOnStore ? " (нормализация «как Яндекс»)" : ""}: split-incomplete называет продолжение; повтор дописывает только усечение`, async () => {
      const s = await setup({ normalizeOnStore });
      const fault = s.fake.rejectBeforeApply({ method: "PUT", path: s.path }, 507, { times: Number.POSITIVE_INFINITY });
      const mark = s.fake.mark();
      const error = await failure(() => writeSplit(s.io, s.calendar, s.before, SPLIT, ENV));
      fault.disarm();
      expect(error.code).toBe("split-incomplete");
      expect(error.message).toContain(CONT_UID);
      expect(error.message).toMatch(/Повторите тот же вызов/);
      expect(error.message, "совет вложенной ошибки не смешивается с советом разреза").not.toMatch(/позже/);
      expect(error.message).toMatch(/видны дважды/);
      expect(error.continuation).toEqual({ uid: CONT_UID, href: CONT_HREF });
      expect(journal(s.fake, mark, s)).toEqual([
        "REPORT календарь → 207",
        "PUT продолжение If-None-Match=* → 201",
        "PUT исходный If-Match=прочитанный → 507",
        "REPORT календарь → 207",
        "PUT исходный If-Match=прочитанный → 507",
        "REPORT календарь → 207",
      ]);
      expect(s.fake.writesSince(mark).some((w) => w.method === "DELETE"), "компенсирующего DELETE нет").toBe(false);
      expect(s.fake.ics(s.path), "исходная серия не тронута").toBe(SEED);
      expect(s.fake.has(CONT_HREF), "продолжение создано").toBe(true);

      // Повтор того же вызова: состояние перечитано заново, продолжение совпало.
      const again = await known(s.io, s.calendar);
      const retryMark = s.fake.mark();
      const result = await writeSplit(s.io, s.calendar, again, SPLIT, ENV);
      expect(journal(s.fake, retryMark, s)).toEqual(["REPORT календарь → 207", "PUT исходный If-Match=прочитанный → 204"]);
      expect(result.continuation.created).toBe(false);
    });
  }

  it("ответ на PUT продолжения потерян: перечитывание подтверждает продолжение, затем усечение", async () => {
    const s = await setup();
    s.fake.loseResponse({ method: "PUT", path: CONT_HREF }, 504);
    const mark = s.fake.mark();
    const result = await writeSplit(s.io, s.calendar, s.before, SPLIT, ENV);
    expect(journal(s.fake, mark, s)).toEqual([
      "REPORT календарь → 207",
      "PUT продолжение If-None-Match=* → 504",
      "REPORT календарь → 207",
      "PUT исходный If-Match=прочитанный → 204",
    ]);
    expect(result.continuation.created).toBe(true);
    expect(s.fake.ics(s.path)).toBe(TRUNCATED);
  });

  it("ответ на PUT продолжения потерян, а на сервере оно уже другое — split-stale-continuation, усечения нет", async () => {
    const s = await setup();
    s.fake.loseResponse({ method: "PUT", path: CONT_HREF }, "network");
    let reports = 0;
    s.fake.beforeRequest = (request) => {
      if (request.method === "REPORT" && ++reports === 2) {
        s.fake.externalEdit(CONT_HREF, (ics) => ics.replace("Переговорная 5", "Переговорная 7"));
      }
    };
    const error = await failure(() => writeSplit(s.io, s.calendar, s.before, SPLIT, ENV));
    expect(error.code).toBe("split-stale-continuation");
    expect(error.differences?.join("\n")).toContain("Переговорная 7");
    expect(error.message, "запись продолжения была, «ничего не записано» — неправда").toMatch(/неизвестно/);
    expect(s.fake.writes().map((w) => w.path)).toEqual([CONT_HREF]);
    expect(s.fake.ics(s.path)).toBe(SEED);
  });

  it("ответ на усечение потерян: «применено» перечитыванием", async () => {
    const s = await setup();
    s.fake.loseResponse({ method: "PUT", path: s.path }, "network");
    const result = await writeSplit(s.io, s.calendar, s.before, SPLIT, ENV);
    expect(result.truncated).toMatchObject({ confirmedByReread: true, retried: false });
    expect(s.fake.writes()).toHaveLength(2);
  });

  it("412 на продолжении (RFC; появилось после чтения) с тем же смыслом — усечение идёт", async () => {
    const s = await setup({ conditions: "rfc" });
    s.fake.beforeRequest = (request) => {
      if (request.method === "PUT" && request.path === CONT_HREF && !s.fake.has(CONT_HREF)) {
        s.fake.seedRaw(CONT_HREF, yandexNormalize(CONTINUATION, { owner: OWNER }));
      }
    };
    const mark = s.fake.mark();
    const result = await writeSplit(s.io, s.calendar, s.before, SPLIT, ENV);
    expect(journal(s.fake, mark, s)).toEqual([
      "REPORT календарь → 207",
      "PUT продолжение If-None-Match=* → 412",
      "REPORT календарь → 207",
      "PUT исходный If-Match=прочитанный → 204",
    ]);
    expect(result.continuation.created).toBe(false);
  });

  it("412 на продолжении (RFC) с другим смыслом — split-stale-continuation, усечения нет", async () => {
    const s = await setup({ conditions: "rfc" });
    const stale = continuationWith("Переговорная 7");
    s.fake.beforeRequest = (request) => {
      if (request.method === "PUT" && request.path === CONT_HREF && !s.fake.has(CONT_HREF)) s.fake.seedRaw(CONT_HREF, stale);
    };
    const error = await failure(() => writeSplit(s.io, s.calendar, s.before, SPLIT, ENV));
    expect(error.code).toBe("split-stale-continuation");
    expect(error.differences?.join("\n")).toContain("Переговорная 7");
    expect(s.fake.writes().map((w) => `${w.method} ${w.path} → ${w.status}`)).toEqual([`PUT ${CONT_HREF} → 412`]);
    expect(s.fake.ics(CONT_HREF)).toBe(stale);
    expect(s.fake.ics(s.path)).toBe(SEED);
  });

  it("продолжение не создано (4xx) — исходная серия не тронута, усечения нет", async () => {
    const s = await setup();
    s.fake.rejectBeforeApply({ method: "PUT", path: CONT_HREF }, 403);
    const error = await failure(() => writeSplit(s.io, s.calendar, s.before, SPLIT, ENV));
    expect(error.code).toBe("rejected");
    expect(error.message).toMatch(/не тронута/);
    expect(s.fake.writes()).toHaveLength(1);
    expect(s.fake.ics(s.path)).toBe(SEED);
  });

  it("продолжение не дошло и после повтора — not-delivered, усечения нет", async () => {
    const s = await setup();
    s.fake.dropRequest({ method: "PUT", path: CONT_HREF }, 504, { times: 2 });
    const error = await failure(() => writeSplit(s.io, s.calendar, s.before, SPLIT, ENV));
    expect(error.code).toBe("not-delivered");
    expect(error.message).toMatch(/не тронута/);
    expect(s.fake.writes().map((w) => w.path)).toEqual([CONT_HREF, CONT_HREF]);
    expect(s.fake.has(CONT_HREF)).toBe(false);
  });

  it("исходную серию изменили после чтения: усечение 412 — split-incomplete с причиной, продолжение названо", async () => {
    const s = await setup();
    s.fake.beforeRequest = (request) => {
      if (request.method === "PUT" && request.path === s.path) {
        s.fake.externalEdit(s.path, externalRename);
        s.fake.beforeRequest = undefined;
      }
    };
    const error = await failure(() => writeSplit(s.io, s.calendar, s.before, SPLIT, ENV));
    expect(error.code).toBe("split-incomplete");
    expect(error.message).toContain(CONT_UID);
    expect(error.message).toMatch(/изменили/);
    expect((error.cause as DeliveryError).code).toBe("conflict");
    expect(error.message, "исходную серию изменили — о «видны дважды» знать нельзя").not.toMatch(/видны дважды/);
    expect(s.fake.ics(s.path)).toBe(externalRename(SEED));
    expect(s.fake.writes().some((w) => w.method === "DELETE")).toBe(false);
  });

  it("исходную серию удалили до усечения (Ж16): оно создало её заново — split-incomplete говорит об этом", async () => {
    const s = await setup();
    s.fake.beforeRequest = (request) => {
      if (request.method === "PUT" && request.path === s.path) {
        s.fake.externalDelete(s.path);
        s.fake.beforeRequest = undefined;
      }
    };
    const mark = s.fake.mark();
    const error = await failure(() => writeSplit(s.io, s.calendar, s.before, SPLIT, ENV));
    expect(error.code).toBe("split-incomplete");
    expect((error.cause as DeliveryError).recreated).toBe(true);
    expect(error.message).toMatch(/создало исходную серию заново/);
    expect(error.message).toMatch(/Ничего не удалено/);
    expect(error.message, "дописывать нечего — совет о повторе вызова не годится").not.toMatch(/Повторите тот же вызов/);
    expect(journal(s.fake, mark, s)).toEqual([
      "REPORT календарь → 207",
      "PUT продолжение If-None-Match=* → 201",
      "PUT исходный If-Match=прочитанный → 201",
    ]);
    expect(s.fake.ics(s.path), "усечённая серия создана заново").toBe(TRUNCATED);
    expect(s.fake.has(CONT_HREF)).toBe(true);
    expect(s.fake.writesSince(mark).some((w) => w.method === "DELETE"), "компенсирующего DELETE нет").toBe(false);
  });

  it("сервер без ETag в ответе на PUT: разрез проходит, etag пустые", async () => {
    const s = await setup({ etagOnPut: false });
    const result = await writeSplit(s.io, s.calendar, s.before, SPLIT, ENV);
    expect(result.continuation).toMatchObject({ created: true, etag: "" });
    expect(result.truncated.etag).toBe("");
    expect(s.fake.ics(s.path)).toBe(TRUNCATED);
  });
});
