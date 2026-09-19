// Самопроверка стенда (§6 плана переделки,
// docs/superpowers/plans/2026-09-19-recurring-events-rework.md): фейковый
// CalDAV-сервер, инварианты объекта, наблюдение и затравки. Всё, что здесь
// проверяется, потом держит на себе цепочки tests/chains/* — если стенд
// врёт, цепочки доказывают ничего.
//
// Запросы идут через настоящий транспорт: createClient(config, fake.fetch) и
// функции src/caldav/objects.ts. Утверждения о том, сколько раз транспорт
// повторяет запрос, здесь не делаются — это свойство транспорта (З02), а не
// стенда.
import ICAL from "ical.js";
import { describe, expect, it } from "vitest";
import {
  deleteObject,
  getObject,
  putObject,
  queryEventByUid,
  queryEvents,
} from "../../src/caldav/objects.js";
import { readEvents } from "../../src/domain/events.js";
import type { CalendarEvent } from "../../src/types.js";
import { calendarA, calendarB, makeContext, makeStand, plant, yandexPath } from "./context.js";
import { FAKE_BASE_URL, FakeCaldav, reorderOverridesFirst, yandexNormalize } from "./fakeCaldav.js";
import {
  assertInvariants,
  findViolations,
  newViolations,
  parseRawComponents,
  VIOLATION_KINDS,
  type ViolationKind,
} from "./invariants.js";
import {
  assertPropsPreserved,
  assertStoredInvariants,
  describeObject,
  expectNoWrites,
  formatEvent,
  lastPutBody,
  visible,
  wallTime,
} from "./observe.js";
import * as seeds from "./seeds.js";

const CRLF = "\r\n";

// Минимальный объект «одиночная встреча» для проверок транспорта.
function single(uid: string, summary: string): string {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Yandex LLC//Yandex Calendar//EN",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    "DTSTAMP:20261001T090000Z",
    "DTSTART:20261019T070000Z",
    "DTEND:20261019T080000Z",
    `SUMMARY:${summary}`,
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join(CRLF);
}

function kinds(ics: string): ViolationKind[] {
  return findViolations(ics).map((violation) => violation.kind);
}

async function rawFetch(fake: FakeCaldav, method: string, path: string, init: RequestInit = {}) {
  return fake.fetch(`${FAKE_BASE_URL}${path}`, { ...init, method });
}

describe("FakeCaldav: хранилище, ETag, REPORT", () => {
  it("находит объект по UID через настоящий клиент; ETag — голое растущее число", async () => {
    const { fake, ctx } = makeStand();
    const path = yandexPath(calendarA, "abc@yandex.ru");
    const etag0 = fake.seed(path, single("abc@yandex.ru", "v0"));
    expect(etag0).toMatch(/^\d+$/);

    const found = await queryEventByUid(ctx.client, calendarA.href, "abc@yandex.ru");
    expect(found).toEqual({ href: path, etag: etag0, ics: expect.stringContaining("SUMMARY:v0") });

    const etag1 = await putObject(ctx.client, path, single("abc@yandex.ru", "v1"), { ifMatch: etag0 });
    expect(etag1).toMatch(/^\d+$/);
    expect(BigInt(etag1) > BigInt(etag0)).toBe(true);
    const again = await queryEventByUid(ctx.client, calendarA.href, "abc@yandex.ru");
    expect(again?.etag).toBe(etag1);
    expect(again?.ics).toContain("SUMMARY:v1");
    expect(fake.ics(path)).toContain("SUMMARY:v1");
  });

  it("путь чужого объекта — UID без собаки", () => {
    expect(yandexPath(calendarA, "aaaabbbb11@yandex.ru")).toBe(`${calendarA.href}aaaabbbb11yandex.ru.ics`);
  });

  it("ETag меняется при каждой записи, даже если текст тот же (Ж12)", async () => {
    const { fake, ctx } = makeStand();
    const path = yandexPath(calendarA, "same@yandex.ru");
    const text = single("same@yandex.ru", "одно и то же");
    const etag0 = fake.seed(path, text);
    const etag1 = await putObject(ctx.client, path, text, { ifMatch: etag0 });
    expect(etag1).not.toBe(etag0);
    expect(fake.etag(path)).toBe(etag1);
  });

  it("GET отдаёт текст и ETag", async () => {
    const { fake, ctx } = makeStand();
    const path = yandexPath(calendarA, "get@yandex.ru");
    const etag = fake.seed(path, single("get@yandex.ru", "g"));
    const object = await getObject(ctx.client, path);
    expect(object.etag).toBe(etag);
    expect(object.ics).toBe(fake.ics(path));
  });

  it("REPORT по окну отдаёт надмножество: все объекты календаря и ни одного из чужого", async () => {
    const { fake, ctx } = makeStand({ calendars: [calendarA, calendarB] });
    fake.seed(yandexPath(calendarA, "a1@yandex.ru"), single("a1@yandex.ru", "в окне"));
    fake.seed(yandexPath(calendarA, "a2@yandex.ru"), single("a2@yandex.ru", "вне окна"));
    fake.seed(yandexPath(calendarB, "b1@yandex.ru"), single("b1@yandex.ru", "другой календарь"));
    const objects = await queryEvents(
      ctx.client,
      calendarA.href,
      new Date("2030-01-01T00:00:00Z"),
      new Date("2030-01-02T00:00:00Z"),
    );
    expect(objects.map((object) => object.href).sort()).toEqual([
      yandexPath(calendarA, "a1@yandex.ru"),
      yandexPath(calendarA, "a2@yandex.ru"),
    ]);
  });

  it("text-match по UID — подстрока без учёта регистра (худший случай для клиента)", async () => {
    const { fake, ctx } = makeStand();
    fake.seed(yandexPath(calendarA, "ABC@yandex.ru"), single("ABC@yandex.ru", "A"));
    fake.seed(yandexPath(calendarA, "abc@yandex.ru.x"), single("abc@yandex.ru.x", "B"));
    fake.seed(yandexPath(calendarA, "zzz@yandex.ru"), single("zzz@yandex.ru", "C"));
    const raw = await ctx.client.request({
      method: "REPORT",
      path: calendarA.href,
      depth: "1",
      body: `<c:prop-filter name="UID"><c:text-match collation="i;octet">abc@yandex.ru</c:text-match></c:prop-filter>`,
    });
    expect((raw.text.match(/<d:response>/g) ?? []).length).toBe(2);
    // Точного совпадения нет — настоящий клиент обязан это заметить сам.
    expect(await queryEventByUid(ctx.client, calendarA.href, "abc@yandex.ru")).toBeUndefined();
  });

  it("calendar-multiget отдаёт ровно запрошенные объекты", async () => {
    const { fake, ctx } = makeStand();
    const p1 = yandexPath(calendarA, "m1@yandex.ru");
    const p2 = yandexPath(calendarA, "m2@yandex.ru");
    fake.seed(p1, single("m1@yandex.ru", "1"));
    fake.seed(p2, single("m2@yandex.ru", "2"));
    const raw = await ctx.client.request({
      method: "REPORT",
      path: calendarA.href,
      depth: "1",
      body: `<c:calendar-multiget xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data/></d:prop><d:href>${p2}</d:href></c:calendar-multiget>`,
    });
    expect(raw.text).toContain(p2);
    expect(raw.text).not.toContain(p1);
  });

  it("seed отвергает неразбираемый текст, seedRaw кладёт любой и отдаёт его дословно", async () => {
    const { fake, ctx } = makeStand();
    expect(() => fake.seed(yandexPath(calendarA, "bad@x"), "это не iCalendar")).toThrow();
    const path = yandexPath(calendarA, seeds.c63BadFreq.uid);
    fake.seedRaw(path, seeds.c63BadFreq.ics);
    const object = await getObject(ctx.client, path);
    expect(object.ics).toBe(seeds.c63BadFreq.ics);
    expect(fake.findByUid(seeds.c63BadFreq.uid).map((found) => found.path)).toEqual([path]);
  });

  it("externalEdit — правка «другим клиентом» с новым ETag, без записи в журнал", () => {
    const { fake } = makeStand();
    const path = yandexPath(calendarA, "ext@yandex.ru");
    const etag0 = fake.seed(path, single("ext@yandex.ru", "моя"));
    const etag1 = fake.externalEdit(path, (ics) => ics.replace("SUMMARY:моя", "SUMMARY:чужая"));
    expect(etag1).not.toBe(etag0);
    expect(fake.ics(path)).toContain("SUMMARY:чужая");
    expect(fake.log).toEqual([]);
    fake.externalDelete(path);
    expect(fake.has(path)).toBe(false);
  });
});

describe("FakeCaldav: условные заголовки", () => {
  it("по умолчанию сервер ведёт себя как Яндекс (Ж13–Ж16)", async () => {
    const { fake, ctx } = makeStand();
    expect(fake.conditions).toBe("yandex");
    const path = yandexPath(calendarA, "y@yandex.ru");
    const etag0 = fake.seed(path, single("y@yandex.ru", "v0"));
    fake.externalEdit(path, (ics) => ics.replace("SUMMARY:v0", "SUMMARY:чужая"));

    // Ж14: If-Match на PUT соблюдается.
    await expect(putObject(ctx.client, path, single("y@yandex.ru", "моя"), { ifMatch: etag0 })).rejects.toMatchObject({
      status: 412,
    });
    expect(fake.ics(path)).toContain("SUMMARY:чужая");

    // Ж13: If-None-Match: * на существующий объект не соблюдается — перезапись, 201.
    await putObject(ctx.client, path, single("y@yandex.ru", "поверх"), { ifNoneMatch: true });
    expect(fake.ics(path)).toContain("SUMMARY:поверх");
    expect(fake.log.at(-1)).toMatchObject({ method: "PUT", status: 201, applied: true });

    // Ж16: PUT с If-Match по несуществующему объекту создаёт его.
    const ghost = yandexPath(calendarA, "ghost@yandex.ru");
    await putObject(ctx.client, ghost, single("ghost@yandex.ru", "воскрес"), { ifMatch: "1" });
    expect(fake.has(ghost)).toBe(true);

    // Ж15: If-Match на DELETE не соблюдается — удаление с устаревшим ETag проходит.
    await deleteObject(ctx.client, path, etag0);
    expect(fake.has(path)).toBe(false);
    await expect(deleteObject(ctx.client, path, "1")).rejects.toMatchObject({ status: 404 });
  });

  it("в режиме rfc все условия дают 412, DELETE отсутствующего — 404", async () => {
    const { fake, ctx } = makeStand({ conditions: "rfc" });
    const path = yandexPath(calendarA, "r@yandex.ru");
    const etag0 = fake.seed(path, single("r@yandex.ru", "v0"));
    fake.externalEdit(path, (ics) => ics);

    await expect(putObject(ctx.client, path, single("r@yandex.ru", "x"), { ifMatch: etag0 })).rejects.toMatchObject({
      status: 412,
    });
    await expect(putObject(ctx.client, path, single("r@yandex.ru", "x"), { ifNoneMatch: true })).rejects.toMatchObject({
      status: 412,
    });
    const ghost = yandexPath(calendarA, "ghost@yandex.ru");
    await expect(putObject(ctx.client, ghost, single("ghost@yandex.ru", "x"), { ifMatch: "1" })).rejects.toMatchObject({
      status: 412,
    });
    expect(fake.has(ghost)).toBe(false);
    await expect(deleteObject(ctx.client, path, etag0)).rejects.toMatchObject({ status: 412 });
    expect(fake.ics(path)).toContain("SUMMARY:v0");

    await deleteObject(ctx.client, path, fake.etag(path));
    expect(fake.has(path)).toBe(false);
    await expect(deleteObject(ctx.client, path, "1")).rejects.toMatchObject({ status: 404 });
  });

  // Отрицательный контроль: одна и та же проверка гонки обязана поймать
  // потерянное обновление на честном сервере и НЕ поймать его на сервере,
  // который игнорирует If-Match. Если бы она проходила в обоих случаях,
  // она ничего бы не проверяла.
  async function raceIsDetected(fake: FakeCaldav): Promise<boolean> {
    const ctx = makeContext(fake);
    const path = yandexPath(calendarA, "race@yandex.ru");
    fake.seed(path, single("race@yandex.ru", "v0"));
    const read = await queryEventByUid(ctx.client, calendarA.href, "race@yandex.ru");
    fake.externalEdit(path, (ics) => ics.replace("SUMMARY:v0", "SUMMARY:чужая правка"));
    try {
      await putObject(ctx.client, path, single("race@yandex.ru", "моя правка"), { ifMatch: read!.etag });
    } catch (error) {
      return (error as { status?: number }).status === 412 && fake.ics(path).includes("чужая правка");
    }
    return false;
  }

  it("отрицательный контроль: при ignoreIfMatch проверка гонки перестаёт ловить потерю правки", async () => {
    expect(await raceIsDetected(new FakeCaldav())).toBe(true);
    expect(await raceIsDetected(new FakeCaldav({ conditions: "rfc" }))).toBe(true);
    expect(await raceIsDetected(new FakeCaldav({ ignoreIfMatch: true }))).toBe(false);
  });

  it("beforeRequest вклинивает правку другого клиента между чтением и записью", async () => {
    const { fake, ctx } = makeStand();
    const path = yandexPath(calendarA, "hook@yandex.ru");
    fake.seed(path, single("hook@yandex.ru", "v0"));
    const read = await queryEventByUid(ctx.client, calendarA.href, "hook@yandex.ru");
    const seen: string[] = [];
    fake.beforeRequest = (request) => {
      seen.push(`${request.method} ${request.path}`);
      if (request.method === "PUT") fake.externalEdit(path, (ics) => ics.replace("v0", "чужая"));
    };
    await expect(putObject(ctx.client, path, single("hook@yandex.ru", "моя"), { ifMatch: read!.etag })).rejects.toMatchObject({
      status: 412,
    });
    expect(seen).toEqual([`PUT ${path}`]);
    expect(fake.ics(path)).toContain("чужая");
  });
});

describe("FakeCaldav: журнал", () => {
  it("пишет метод, путь, условия, статус, тело PUT и факт применения", async () => {
    const { fake, ctx } = makeStand();
    const path = yandexPath(calendarA, "log@yandex.ru");
    const etag0 = fake.seed(path, single("log@yandex.ru", "v0"));
    const body = single("log@yandex.ru", "v1");
    await putObject(ctx.client, path, body, { ifMatch: etag0 });
    await expect(putObject(ctx.client, path, body, { ifMatch: etag0 })).rejects.toMatchObject({ status: 412 });

    expect(fake.log).toHaveLength(2);
    expect(fake.log[0]).toMatchObject({ n: 1, method: "PUT", path, ifMatch: etag0, status: 204, applied: true, body });
    expect(fake.log[0].headers.authorization).toMatch(/^Basic /);
    expect(fake.log[1]).toMatchObject({ n: 2, method: "PUT", status: 412, applied: false });
    expect(fake.writes()).toHaveLength(2);
  });

  it("mark и writesSince отделяют записи шага; чтения записями не считаются", async () => {
    const { fake, ctx } = makeStand();
    const path = yandexPath(calendarA, "mark@yandex.ru");
    const etag0 = fake.seed(path, single("mark@yandex.ru", "v0"));
    await putObject(ctx.client, path, single("mark@yandex.ru", "v1"), { ifMatch: etag0 });
    const mark = fake.mark();
    await queryEventByUid(ctx.client, calendarA.href, "mark@yandex.ru");
    expect(fake.writesSince(mark)).toEqual([]);
    expect(() => expectNoWrites(fake, mark)).not.toThrow();
    await deleteObject(ctx.client, path, fake.etag(path));
    expect(fake.writesSince(mark).map((entry) => entry.method)).toEqual(["DELETE"]);
    expect(() => expectNoWrites(fake, mark)).toThrow(/DELETE/);
  });

  it("lastPutBody отдаёт тело последнего PUT по пути — то, что прислал клиент, а не что сервер сохранил", async () => {
    const { fake, ctx } = makeStand({ normalizeOnStore: true });
    const path = yandexPath(calendarA, "body@yandex.ru");
    const etag0 = fake.seed(path, single("body@yandex.ru", "v0"));
    const body = single("body@yandex.ru", "v1").replace("END:VEVENT", "X-MINE:1\r\nEND:VEVENT");
    await putObject(ctx.client, path, body, { ifMatch: etag0 });
    expect(lastPutBody(fake, path)).toBe(body);
    expect(fake.ics(path)).not.toContain("X-MINE");
  });
});

describe("FakeCaldav: крючки сбоев", () => {
  it("loseResponse network: запись применена, ответа нет (TypeError)", async () => {
    const { fake, ctx } = makeStand();
    const path = yandexPath(calendarA, "lose@yandex.ru");
    const etag0 = fake.seed(path, single("lose@yandex.ru", "v0"));
    const fault = fake.loseResponse({ method: "PUT" }, "network");
    await expect(putObject(ctx.client, path, single("lose@yandex.ru", "v1"), { ifMatch: etag0 })).rejects.toBeDefined();
    expect(fault.fired).toBe(1);
    expect(fake.ics(path)).toContain("SUMMARY:v1");
    expect(fake.log[0]).toMatchObject({ method: "PUT", applied: true, fault: "lose", status: 0 });
  });

  it("loseResponse 503 и 504: запись применена, клиент видит 5xx", async () => {
    for (const status of [503, 504] as const) {
      const fake = new FakeCaldav();
      const path = yandexPath(calendarA, "lose5@yandex.ru");
      fake.seed(path, single("lose5@yandex.ru", "v0"));
      fake.loseResponse({ method: "DELETE" }, status);
      const response = await rawFetch(fake, "DELETE", path);
      expect(response.status).toBe(status);
      expect(fake.has(path)).toBe(false);
      expect(fake.log[0]).toMatchObject({ applied: true, fault: "lose", status });
    }
  });

  it("loseResponse timeout бросает TimeoutError, как AbortSignal.timeout", async () => {
    const fake = new FakeCaldav();
    const path = yandexPath(calendarA, "t@yandex.ru");
    fake.seed(path, single("t@yandex.ru", "v0"));
    fake.loseResponse({ method: "DELETE" }, "timeout");
    await expect(rawFetch(fake, "DELETE", path)).rejects.toMatchObject({ name: "TimeoutError" });
    expect(fake.has(path)).toBe(false);
  });

  it("dropRequest: запись не применена, 504 или обрыв сети", async () => {
    const fake = new FakeCaldav();
    const path = yandexPath(calendarA, "drop@yandex.ru");
    const etag0 = fake.seed(path, single("drop@yandex.ru", "v0"));
    fake.dropRequest({ method: "PUT" });
    const response = await rawFetch(fake, "PUT", path, {
      headers: { "If-Match": etag0 },
      body: single("drop@yandex.ru", "v1"),
    });
    expect(response.status).toBe(504);
    expect(fake.etag(path)).toBe(etag0);
    expect(fake.ics(path)).toContain("SUMMARY:v0");
    expect(fake.log[0]).toMatchObject({ applied: false, fault: "drop", status: 504 });

    fake.dropRequest({ method: "PUT" }, "network");
    await expect(
      rawFetch(fake, "PUT", path, { headers: { "If-Match": etag0 }, body: single("drop@yandex.ru", "v1") }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(fake.ics(path)).toContain("SUMMARY:v0");
  });

  it("rejectBeforeApply с nth: первый PUT проходит, второй получает 507 и не применяется", async () => {
    const fake = new FakeCaldav();
    const p1 = yandexPath(calendarA, "n1@yandex.ru");
    const p2 = yandexPath(calendarA, "n2@yandex.ru");
    const fault = fake.rejectBeforeApply({ method: "PUT" }, 507, { nth: 2 });
    expect((await rawFetch(fake, "PUT", p1, { body: single("n1@yandex.ru", "1") })).status).toBe(201);
    expect((await rawFetch(fake, "PUT", p2, { body: single("n2@yandex.ru", "2") })).status).toBe(507);
    expect(fake.has(p2)).toBe(false);
    expect(fault.fired).toBe(1);
    // Сработав times раз (по умолчанию один), крючок разоружается.
    expect((await rawFetch(fake, "PUT", p2, { body: single("n2@yandex.ru", "2") })).status).toBe(201);
    expect(fault.seen).toBe(3);
  });

  it("совпадение по пути (строка или RegExp), по условию и предикатом", async () => {
    const fake = new FakeCaldav();
    const path = yandexPath(calendarA, "match@yandex.ru");
    const etag0 = fake.seed(path, single("match@yandex.ru", "v0"));
    const byRegExp = fake.rejectBeforeApply({ path: /other/ }, 500);
    const byCondition = fake.rejectBeforeApply({ method: "PUT", ifNoneMatch: true }, 507);
    const byPredicate = fake.rejectBeforeApply((request) => request.body.includes("SUMMARY:v9"), 400);
    expect((await rawFetch(fake, "PUT", path, { headers: { "If-Match": etag0 }, body: single("match@yandex.ru", "v1") })).status).toBe(204);
    expect(
      (await rawFetch(fake, "PUT", path, { headers: { "If-None-Match": "*" }, body: single("match@yandex.ru", "v2") })).status,
    ).toBe(507);
    expect((await rawFetch(fake, "PUT", path, { body: single("match@yandex.ru", "v9") })).status).toBe(400);
    expect([byRegExp.fired, byCondition.fired, byPredicate.fired]).toEqual([0, 1, 1]);
    fake.clearFaults();
    expect((await rawFetch(fake, "PUT", path, { body: single("match@yandex.ru", "v9") })).status).toBe(204);
  });
});

describe("FakeCaldav: строгий режим (О12а)", () => {
  const twoMasters = single("two@yandex.ru", "первый").replace(
    "END:VCALENDAR",
    ["BEGIN:VEVENT", "UID:two@yandex.ru", "DTSTAMP:20261001T090000Z", "DTSTART:20261020T070000Z", "DTEND:20261020T080000Z", "SUMMARY:второй", "END:VEVENT", "END:VCALENDAR"].join(CRLF),
  );

  it("отклоняет 400 объект, нарушающий инвариант, и ничего не применяет", async () => {
    const { fake, ctx } = makeStand();
    const path = yandexPath(calendarA, "two@yandex.ru");
    const etag0 = fake.seed(path, single("two@yandex.ru", "первый"));
    await expect(putObject(ctx.client, path, twoMasters, { ifMatch: etag0 })).rejects.toMatchObject({ status: 400 });
    expect(fake.etag(path)).toBe(etag0);
    expect(fake.rejections).toHaveLength(1);
    expect(fake.rejections[0].reasons.join("\n")).toMatch(/multiple-masters/);
    expect(fake.log[0]).toMatchObject({ status: 400, applied: false });
    expect(fake.log[0].rejected?.join("\n")).toMatch(/multiple-masters/);
  });

  it("терпит нарушение, которое уже было в прежней версии, но не новое сверх него", async () => {
    const fake = new FakeCaldav();
    const path = yandexPath(calendarA, "two@yandex.ru");
    const etag0 = fake.seed(path, twoMasters);
    const renamed = twoMasters.replace("SUMMARY:первый", "SUMMARY:переименован");
    const ok = await rawFetch(fake, "PUT", path, { headers: { "If-Match": etag0 }, body: renamed });
    expect(ok.status).toBe(204);

    const threeMasters = renamed.replace(
      "END:VCALENDAR",
      ["BEGIN:VEVENT", "UID:two@yandex.ru", "DTSTAMP:20261001T090000Z", "DTSTART:20261021T070000Z", "DTEND:20261021T080000Z", "SUMMARY:третий", "END:VEVENT", "END:VCALENDAR"].join(CRLF),
    );
    const rejected = await rawFetch(fake, "PUT", path, { headers: { "If-Match": fake.etag(path) }, body: threeMasters });
    expect(rejected.status).toBe(400);
  });

  it("с strict = false принимает что угодно", async () => {
    const fake = new FakeCaldav({ strict: false });
    const response = await rawFetch(fake, "PUT", yandexPath(calendarA, "two@yandex.ru"), { body: twoMasters });
    expect(response.status).toBe(201);
  });
});

describe("FakeCaldav: переупорядочивание и нормализация", () => {
  it("reorderComponents отдаёт переопределения раньше основного, хранимый текст не меняется", async () => {
    const { fake, ctx } = makeStand({ reorderComponents: true });
    const path = plant(fake, seeds.c55EchoOverride);
    const roles = (ics: string) =>
      parseRawComponents(ics)[0].children.map((child) =>
        child.name === "VEVENT" ? (child.lines.some((line) => line.startsWith("RECURRENCE-ID")) ? "override" : "master") : child.name,
      );
    // В затравке основной компонент стоит раньше переопределений.
    expect(roles(seeds.c55EchoOverride.ics)).toEqual(["VTIMEZONE", "master", "override", "override"]);
    const found = await queryEventByUid(ctx.client, calendarA.href, seeds.c55EchoOverride.uid);
    expect(roles(found!.ics)).toEqual(["override", "override", "master", "VTIMEZONE"]);
    expect(fake.ics(path)).toBe(seeds.c55EchoOverride.ics);
    // Из XML перевод строки приходит нормализованным, из GET — как есть.
    expect((await getObject(ctx.client, path)).ics.replace(/\r\n/g, "\n")).toBe(found!.ics.replace(/\r\n/g, "\n"));
  });

  it("normalizeOnStore: true переписывает объект по фактам Ж2, Ж5–Ж10, не меняя смысла", () => {
    // Без CALSCALE, METHOD, CREATED и CLASS — их сервер обязан добавить сам.
    const withOverride = seeds.weeklyMoscow.ics
      .replace("CALSCALE:GREGORIAN\r\nMETHOD:PUBLISH\r\n", "")
      .replace("CREATED:20261001T090000Z\r\n", "")
      .replace("CLASS:PUBLIC\r\n", "")
      .replace("RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6", "RRULE:COUNT=6;FREQ=WEEKLY;WKST=SU;BYDAY=MO,WE\r\nX-MINE:1\r\nCATEGORIES:Работа")
      .replace(
        "END:VCALENDAR",
        [
          "BEGIN:VEVENT",
          `UID:${seeds.weeklyMoscow.uid}`,
          "DTSTAMP:20261001T090000Z",
          "RECURRENCE-ID;TZID=Europe/Moscow:20261021T100000",
          "DTSTART;TZID=Europe/Moscow:20261021T113000",
          "DTEND;TZID=Europe/Moscow:20261021T123000",
          "SUMMARY:Планёрка",
          "END:VEVENT",
          "END:VCALENDAR",
        ].join(CRLF),
      );
    // Вход — переопределение раньше основного, как у старых записей.
    const input = reorderOverridesFirst(withOverride);
    const inputRoot = parseRawComponents(input)[0];
    const inputEvents = inputRoot.children.filter((child) => child.name === "VEVENT");
    expect(inputEvents[0].lines.some((line) => line.startsWith("RECURRENCE-ID"))).toBe(true);
    expect(inputRoot.lines.some((line) => line.startsWith("CALSCALE") || line.startsWith("METHOD"))).toBe(false);
    expect(inputEvents.flatMap((event) => event.lines).some((line) => /^(CREATED|CLASS|ORGANIZER)/.test(line))).toBe(false);

    const stored = yandexNormalize(input, { owner: "user@yandex.ru", calendarName: "Мои события", stamp: "20261002T100000Z" });
    const [root] = parseRawComponents(stored);
    const events = root.children.filter((child) => child.name === "VEVENT");
    // Ж2: основной компонент первым.
    expect(events[0].lines.some((line) => line.startsWith("RECURRENCE-ID"))).toBe(false);
    const masterOut = events[0].lines;
    // Ж5, Ж6: части правила переставлены, INTERVAL добавлен, WKST выброшен.
    expect(masterOut).toContain("RRULE:FREQ=WEEKLY;COUNT=6;INTERVAL=1;BYDAY=MO,WE");
    // Ж7: X-свойства вырезаны; Ж8: CATEGORIES — имя календаря.
    expect(masterOut.some((line) => line.startsWith("X-MINE"))).toBe(false);
    expect(masterOut).toContain("CATEGORIES:Мои события");
    // Ж9: ORGANIZER владельца, CREATED, LAST-MODIFIED, CLASS; CALSCALE и METHOD у календаря.
    expect(masterOut).toContain("ORGANIZER:mailto:user@yandex.ru");
    expect(masterOut).toContain("LAST-MODIFIED:20261002T100000Z");
    expect(masterOut.some((line) => line.startsWith("CREATED:"))).toBe(true);
    expect(masterOut.some((line) => line.startsWith("CLASS:"))).toBe(true);
    expect(events[1].lines).toContain("ORGANIZER:mailto:user@yandex.ru");
    expect(root.lines).toContain("CALSCALE:GREGORIAN");
    expect(root.lines).toContain("METHOD:PUBLISH");
    // Ж10: VTIMEZONE заменён описанием из базы IANA.
    const zone = root.children.find((child) => child.name === "VTIMEZONE")!;
    expect(zone.lines.some((line) => line.startsWith("TZURL:http://tzurl.org/"))).toBe(true);
    // Смысл не изменился: нарушений нет ни во входе, ни в сохранённом.
    expect(findViolations(input)).toEqual([]);
    expect(findViolations(stored)).toEqual([]);
    // Эхо-сирота C55 остаётся сиротой и после нормализации.
    expect(kinds(yandexNormalize(seeds.c55EchoOverride.ics, { stamp: "20261002T100000Z" }))).toEqual(["orphan-override"]);
  });

  it("у WEEKLY без BYDAY нормализация дописывает день недели DTSTART (Ж5)", () => {
    const bare = seeds.weeklyMoscow.ics.replace("RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6", "RRULE:FREQ=WEEKLY;COUNT=3");
    const stored = yandexNormalize(bare, { stamp: "20261002T100000Z" });
    expect(unfoldedLines(stored)).toContain("RRULE:FREQ=WEEKLY;COUNT=3;INTERVAL=1;BYDAY=MO");
  });

  it("normalizeOnStore c countToUntil превращает COUNT в UNTIL последней позиции", () => {
    const stored = yandexNormalize(seeds.weeklyMoscow.ics, { countToUntil: true, stamp: "20261002T100000Z" });
    expect(stored).toContain("RRULE:FREQ=WEEKLY;UNTIL=20261104T070000Z;INTERVAL=1;BYDAY=MO,WE");
    const allDay = yandexNormalize(seeds.allDayWeekly.ics, { countToUntil: true, stamp: "20261002T100000Z" });
    expect(allDay).toMatch(/RRULE:FREQ=WEEKLY;UNTIL=20261104;/);
    expect(findViolations(stored)).toEqual([]);
    expect(findViolations(allDay)).toEqual([]);
  });

  it("normalizeOnStore: true на стенде хранит нормализованный текст; своя функция тоже принимается", async () => {
    const { fake, ctx } = makeStand({ normalizeOnStore: true });
    const path = yandexPath(calendarA, "norm@yandex.ru");
    const etag0 = fake.seed(path, single("norm@yandex.ru", "v0"));
    await putObject(ctx.client, path, single("norm@yandex.ru", "v1"), { ifMatch: etag0 });
    expect(fake.ics(path)).toContain("ORGANIZER:mailto:user@yandex.ru");
    expect(fake.ics(path)).toContain("SUMMARY:v1");

    const custom = new FakeCaldav({ normalizeOnStore: (ics) => ics.replace("SUMMARY:", "SUMMARY:[сервер] ") });
    await rawFetch(custom, "PUT", path, { body: single("norm@yandex.ru", "v2") });
    expect(custom.ics(path)).toContain("SUMMARY:[сервер] v2");
  });
});

describe("инварианты: каждый ловит свой образец порчи", () => {
  const base = seeds.weeklyMoscow.ics;
  // Конец по умолчанию — через час после начала ("20261021T150000" → "…T160000").
  const plusHour = (start: string) => `${start.slice(0, 9)}${String(Number(start.slice(9, 11)) + 1).padStart(2, "0")}${start.slice(11)}`;
  const withOverride = (rid: string, start: string, end = plusHour(start)) =>
    base.replace(
      "END:VCALENDAR",
      [
        "BEGIN:VEVENT",
        `UID:${seeds.weeklyMoscow.uid}`,
        "DTSTAMP:20261001T090000Z",
        rid,
        `DTSTART;TZID=Europe/Moscow:${start}`,
        `DTEND;TZID=Europe/Moscow:${end}`,
        "SUMMARY:перенос",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join(CRLF),
    );
  const allDay = seeds.allDayWeekly.ics;

  it("чистые затравки нарушений не имеют", () => {
    for (const seed of seeds.cleanSeeds) expect({ uid: seed.uid, violations: findViolations(seed.ics) }).toEqual({
      uid: seed.uid,
      violations: [],
    });
    expect(findViolations(withOverride("RECURRENCE-ID;TZID=Europe/Moscow:20261021T100000", "20261021T113000", "20261021T123000"))).toEqual(
      [],
    );
  });

  const cases: Array<[ViolationKind, string, string]> = [
    ["unparsable", "текст не iCalendar", "это не iCalendar"],
    ["unparsable", "плохой RRULE", seeds.c63BadFreq.ics],
    ["no-vevent", "календарь без VEVENT", "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n"],
    ["missing-uid", "VEVENT без UID", base.replace(`UID:${seeds.weeklyMoscow.uid}\r\n`, "")],
    ["no-dtstart", "основной компонент без DTSTART", base.replace("DTSTART;TZID=Europe/Moscow:20261019T100000\r\n", "")],
    [
      "mixed-uids",
      "переопределение с чужим UID",
      withOverride("RECURRENCE-ID;TZID=Europe/Moscow:20261021T100000", "20261021T113000", "20261021T123000").replace(
        /UID:[^\r\n]*(\r\nDTSTAMP:[^\r\n]*\r\nRECURRENCE-ID)/,
        "UID:other@yandex.ru$1",
      ),
    ],
    [
      "multiple-masters",
      "два основных компонента",
      base.replace("END:VCALENDAR", base.slice(base.indexOf("BEGIN:VEVENT"), base.indexOf("END:VCALENDAR")) + "END:VCALENDAR"),
    ],
    [
      "duplicate-rid",
      "два переопределения одного слота",
      withOverride("RECURRENCE-ID;TZID=Europe/Moscow:20261021T100000", "20261021T113000", "20261021T123000").replace(
        "END:VCALENDAR",
        ["BEGIN:VEVENT", `UID:${seeds.weeklyMoscow.uid}`, "DTSTAMP:20261001T090000Z", "RECURRENCE-ID:20261021T070000Z", "DTSTART:20261021T090000Z", "DTEND:20261021T100000Z", "SUMMARY:дубль", "END:VEVENT", "END:VCALENDAR"].join(CRLF),
      ),
    ],
    [
      "duplicate-exdate",
      "EXDATE одного слота дважды",
      base.replace(/(RRULE:[^\r\n]*)/, "$1\r\nEXDATE;TZID=Europe/Moscow:20261021T100000\r\nEXDATE;TZID=Europe/Moscow:20261021T100000"),
    ],
    ["missing-vtimezone", "TZID без VTIMEZONE", base.replace(/BEGIN:VTIMEZONE[\s\S]*?END:VTIMEZONE\r\n/, "")],
    ["tzid-on-utc", "TZID у значения в UTC", base.replace("DTEND;TZID=Europe/Moscow:20261019T110000", "DTEND;TZID=Europe/Moscow:20261019T080000Z")],
    [
      "form-mismatch",
      "EXDATE в UTC у серии с TZID",
      base.replace(/(RRULE:[^\r\n]*)/, "$1\r\nEXDATE:20261021T070000Z"),
    ],
    [
      "form-mismatch",
      "RECURRENCE-ID DATE-TIME у серии на весь день",
      allDay.replace(
        "END:VCALENDAR",
        ["BEGIN:VEVENT", `UID:${seeds.allDayWeekly.uid}`, "DTSTAMP:20261001T090000Z", "RECURRENCE-ID:20261021T000000Z", "DTSTART;VALUE=DATE:20261022", "DTEND;VALUE=DATE:20261023", "SUMMARY:перенос", "END:VEVENT", "END:VCALENDAR"].join(CRLF),
      ),
    ],
    ["form-mismatch", "UNTIL не в UTC у серии с TZID", base.replace("COUNT=6", "UNTIL=20261104T100000")],
    ["form-mismatch", "UNTIL DATE-TIME у серии на весь день", allDay.replace("COUNT=6", "UNTIL=20261104T000000Z")],
    ["form-mismatch", "DTEND DATE-TIME при DTSTART DATE", allDay.replace("DTEND;VALUE=DATE:20261020", "DTEND:20261020T000000Z")],
    ["until-before-dtstart", "UNTIL раньше DTSTART", base.replace("COUNT=6", "UNTIL=20261019T065959Z")],
    ["end-not-after-start", "DTEND раньше DTSTART", base.replace("DTEND;TZID=Europe/Moscow:20261019T110000", "DTEND;TZID=Europe/Moscow:20261019T090000")],
    ["end-not-after-start", "DTEND равен DTSTART", base.replace("DTEND;TZID=Europe/Moscow:20261019T110000", "DTEND;TZID=Europe/Moscow:20261019T100000")],
    ["end-not-after-start", "нулевая DURATION", seeds.c62DurationMaster.ics.replace("DURATION:PT45M", "DURATION:PT0S")],
    [
      "dtend-with-duration",
      "DTEND вместе с DURATION",
      seeds.c62DurationMaster.ics.replace("DURATION:PT45M", "DURATION:PT45M\r\nDTEND;TZID=Europe/Moscow:20261019T104500"),
    ],
    ["orphan-override", "RECURRENCE-ID мимо слотов", withOverride("RECURRENCE-ID;TZID=Europe/Moscow:20261021T150000", "20261021T150000")],
    ["orphan-override", "RECURRENCE-ID после конца серии", withOverride("RECURRENCE-ID;TZID=Europe/Moscow:20261109T100000", "20261109T100000")],
    [
      "excluded-override",
      "RECURRENCE-ID под EXDATE",
      withOverride("RECURRENCE-ID;TZID=Europe/Moscow:20261021T100000", "20261021T113000", "20261021T123000").replace(
        /(RRULE:[^\r\n]*)/,
        "$1\r\nEXDATE;TZID=Europe/Moscow:20261021T100000",
      ),
    ],
  ];

  it.each(cases)("%s: %s", (kind, _title, ics) => {
    expect(kinds(ics)).toContain(kind);
  });

  it("образец порчи есть на каждый вид нарушения", () => {
    expect([...new Set(cases.map(([kind]) => kind))].sort()).toEqual([...VIOLATION_KINDS].sort());
  });

  it("RECURRENCE-ID в чужом поясе на месте слота — не сирота (О3: ключ по моменту), но форма не по О4", () => {
    const berlinZone = seeds.dailyBerlin.ics.slice(
      seeds.dailyBerlin.ics.indexOf("BEGIN:VTIMEZONE"),
      seeds.dailyBerlin.ics.indexOf("END:VTIMEZONE") + "END:VTIMEZONE\r\n".length,
    );
    const ics = withOverride("RECURRENCE-ID;TZID=Europe/Berlin:20261021T090000", "20261021T113000", "20261021T123000").replace(
      "BEGIN:VEVENT",
      `${berlinZone}BEGIN:VEVENT`,
    );
    // RFC 5545 другой TZID у RECURRENCE-ID допускает, О4 для записи — нет.
    expect(kinds(ics)).toEqual(["form-mismatch"]);
  });

  it("серия, где DTSTART не на позиции правила: DTSTART — тоже слот", () => {
    // Вторник при BYDAY=MO,WE: итератор ical.js его не выдаёт (План, О2).
    const tuesday = base
      .replace("DTSTART;TZID=Europe/Moscow:20261019T100000", "DTSTART;TZID=Europe/Moscow:20261020T100000")
      .replace("DTEND;TZID=Europe/Moscow:20261019T110000", "DTEND;TZID=Europe/Moscow:20261020T110000");
    const ics = tuesday.replace(
      "END:VCALENDAR",
      ["BEGIN:VEVENT", `UID:${seeds.weeklyMoscow.uid}`, "DTSTAMP:20261001T090000Z", "RECURRENCE-ID;TZID=Europe/Moscow:20261020T100000", "DTSTART;TZID=Europe/Moscow:20261020T120000", "DTEND;TZID=Europe/Moscow:20261020T130000", "SUMMARY:перенос", "END:VEVENT", "END:VCALENDAR"].join(CRLF),
    );
    expect(findViolations(ics)).toEqual([]);
  });

  it("объект из одних переопределений (Р6) аномалией не считается", () => {
    const onlyOverride = withOverride("RECURRENCE-ID;TZID=Europe/Moscow:20261021T150000", "20261021T150000").replace(
      /BEGIN:VEVENT\r\nUID:[^\r\n]*\r\nDTSTAMP:[^\r\n]*\r\nDTSTART[\s\S]*?END:VEVENT\r\n/,
      "",
    );
    expect(onlyOverride).toContain("RECURRENCE-ID");
    expect(onlyOverride).not.toContain("RRULE");
    expect(findViolations(onlyOverride)).toEqual([]);
  });

  it("newViolations: сверх прежнего; переход сирота ↔ скрытое не считается новым", () => {
    const orphan = withOverride("RECURRENCE-ID;TZID=Europe/Moscow:20261021T150000", "20261021T150000");
    expect(newViolations(orphan, base).map((violation) => violation.kind)).toEqual(["orphan-override"]);
    expect(newViolations(orphan, orphan)).toEqual([]);
    expect(newViolations(orphan, [base, orphan])).toEqual([]);
    const excluded = withOverride("RECURRENCE-ID;TZID=Europe/Moscow:20261021T100000", "20261021T113000", "20261021T123000").replace(
      /(RRULE:[^\r\n]*)/,
      "$1\r\nEXDATE;TZID=Europe/Moscow:20261021T100000",
    );
    expect(newViolations(excluded, orphan)).toEqual([]);
    expect(newViolations(base, orphan)).toEqual([]);
  });

  it("assertInvariants бросает с перечнем нарушений и терпит прежние", () => {
    const broken = base.replace("DTEND;TZID=Europe/Moscow:20261019T110000", "DTEND;TZID=Europe/Moscow:20261019T090000");
    expect(() => assertInvariants(broken)).toThrow(/end-not-after-start/);
    expect(() => assertInvariants(broken, broken)).not.toThrow();
    expect(() => assertInvariants(base)).not.toThrow();
  });
});

describe("затравки", () => {
  it("серии в Москве, Берлине (переход 25.10), Нью-Йорке (переход 01.11), на весь день и плавающая", () => {
    expect(seeds.weeklyMoscow.ics).toContain("DTSTART;TZID=Europe/Moscow:20261019T100000");
    expect(seeds.dailyBerlin.ics).toContain("TZID=Europe/Berlin");
    expect(seeds.weeklyNewYork.ics).toContain("TZID=America/New_York");
    expect(seeds.allDayWeekly.ics).toContain("DTSTART;VALUE=DATE:");
    expect(seeds.floatingDaily.ics).toMatch(/DTSTART:\d{8}T\d{6}\r\n/);
    const all = Object.values(seeds).filter(isSeed);
    expect(all).toHaveLength(seeds.cleanSeeds.length + seeds.legacySeeds.length + seeds.unparsableSeeds.length);
    for (const seed of all) {
      // Концы строк — CRLF, как пишут ical.js и сервер; голых LF нет.
      expect(seed.ics).toContain("\r\n");
      expect(seed.ics).not.toMatch(/[^\r]\n/);
      expect(seed.about.length).toBeGreaterThan(0);
      expect(seed.ics).toContain(`UID:${seed.uid}\r\n`);
    }
  });

  it("C55 — как записал старый код: перенос 21.10 на 15:00 и эхо с RECURRENCE-ID 15:00", () => {
    const events = parseRawComponents(seeds.c55EchoOverride.ics)[0].children.filter((child) => child.name === "VEVENT");
    const rids = events.flatMap((event) => event.lines.filter((line) => line.startsWith("RECURRENCE-ID")));
    expect(rids).toHaveLength(2);
    expect(kinds(seeds.c55EchoOverride.ics)).toEqual(["orphan-override"]);
  });

  it("C56 — как записал старый код: серия сдвинута на 09:00, переопределение осталось с RECURRENCE-ID 10:00", () => {
    expect(seeds.c56StaleShift.ics).toMatch(/DTSTART;TZID=Europe\/Moscow:20261019T090000/);
    expect(seeds.c56StaleShift.ics).toMatch(/RECURRENCE-ID;TZID=Europe\/Moscow:20261021T100000/);
    expect(kinds(seeds.c56StaleShift.ics)).toEqual(["orphan-override"]);
  });

  it("C62 — основной компонент с DURATION и без DTEND", () => {
    const master = parseRawComponents(seeds.c62DurationMaster.ics)[0].children.find((child) => child.name === "VEVENT")!;
    expect(master.lines.some((line) => line.startsWith("DURATION:"))).toBe(true);
    expect(master.lines.some((line) => line.startsWith("DTEND"))).toBe(false);
    expect(master.lines.some((line) => line.startsWith("RRULE:"))).toBe(true);
  });

  it("C63 — плохие RRULE роняют ICAL.parse (lib/ical/parse.js → design.js → recur.js)", () => {
    for (const seed of seeds.unparsableSeeds) {
      expect(() => ICAL.parse(seed.ics)).toThrow();
      expect(kinds(seed.ics)).toEqual(["unparsable"]);
    }
    expect(seeds.c63BadFreq.ics).toContain("FREQ=FOO");
    expect(seeds.c63BadByday.ics).toContain("BYDAY=0MO");
  });

  it("настоящий readEvents видит чистые затравки на стенде в поясе события", async () => {
    const { fake, ctx } = makeStand();
    plant(fake, seeds.weeklyMoscow);
    expect(await visible(ctx)).toEqual([
      "2026-10-19 10:00–11:00 Планёрка",
      "2026-10-21 10:00–11:00 Планёрка",
      "2026-10-26 10:00–11:00 Планёрка",
      "2026-10-28 10:00–11:00 Планёрка",
      "2026-11-02 10:00–11:00 Планёрка",
      "2026-11-04 10:00–11:00 Планёрка",
    ]);

    const berlin = makeStand();
    plant(berlin.fake, seeds.dailyBerlin);
    const lines = await visible(berlin.ctx, { zone: "Europe/Berlin" });
    expect(lines).toHaveLength(10);
    expect(lines.every((line) => line.includes(" 10:00–11:00 "))).toBe(true);
    expect(lines[0].startsWith("2026-10-21")).toBe(true);
    expect(lines[9].startsWith("2026-10-30")).toBe(true);

    const york = makeStand();
    plant(york.fake, seeds.weeklyNewYork);
    const nyLines = await visible(york.ctx, { zone: "America/New_York" });
    expect(nyLines).toHaveLength(6);
    expect(nyLines.every((line) => line.includes(" 09:00–10:00 "))).toBe(true);
  });
});

describe("наблюдение: visible и formatEvent", () => {
  const event = (fields: Partial<CalendarEvent>): CalendarEvent => ({
    id: "e1",
    calendarId: calendarA.id,
    summary: "Встреча",
    start: "2026-10-21T10:00:00+03:00",
    end: "2026-10-21T11:00:00+03:00",
    timeZone: "Europe/Moscow",
    allDay: false,
    reminders: [],
    attendees: [],
    ...fields,
  });

  it("wallTime переводит ISO со смещением в стенное время пояса, не завися от пояса процесса", () => {
    expect(wallTime("2026-10-21T10:00:00+03:00", "Europe/Moscow")).toBe("2026-10-21 10:00");
    expect(wallTime("2026-10-21T07:00:00Z", "America/New_York")).toBe("2026-10-21 03:00");
    expect(wallTime("2026-10-21T10:00:30+03:00", "Europe/Moscow")).toBe("2026-10-21 10:00:30");
    expect(wallTime("2026-10-21", "Europe/Moscow")).toBe("2026-10-21");
    expect(wallTime("2026-10-21T10:00:00", "America/New_York")).toBe("2026-10-21 10:00");
  });

  it("формат строки: время, место, слот перенесённой, отмена, id", () => {
    expect(formatEvent(event({}))).toBe("2026-10-21 10:00–11:00 Встреча");
    expect(formatEvent(event({ location: "Переговорная" }))).toBe("2026-10-21 10:00–11:00 Встреча @Переговорная");
    expect(
      formatEvent(event({ start: "2026-10-21T11:30:00+03:00", end: "2026-10-21T12:30:00+03:00", instanceStart: "2026-10-21T10:00:00+03:00" })),
    ).toBe("2026-10-21 11:30–12:30 Встреча [слот 2026-10-21 10:00]");
    expect(formatEvent(event({ instanceStart: "2026-10-21T07:00:00Z" }))).toBe("2026-10-21 10:00–11:00 Встреча");
    expect(formatEvent(event({ end: "2026-10-22T01:00:00+03:00" }))).toBe("2026-10-21 10:00–2026-10-22 01:00 Встреча");
    expect(formatEvent(event({ status: "cancelled" }))).toBe("2026-10-21 10:00–11:00 Встреча [отменена]");
    expect(formatEvent(event({}), { showId: true })).toBe("2026-10-21 10:00–11:00 Встреча #e1");
    expect(formatEvent(event({}), { zone: "UTC" })).toBe("2026-10-21 07:00–08:00 Встреча");
  });

  it("весь день: буквальная дата, как бы её ни выразили старый и новый код", () => {
    const old = event({ allDay: true, start: "2026-10-21T00:00:00+00:00", end: "2026-10-22T00:00:00+00:00", instanceStart: "2026-10-21T00:00:00+00:00" });
    const fresh = event({ allDay: true, start: "2026-10-21T00:00:00+03:00", end: "2026-10-22T00:00:00+03:00", instanceStart: "2026-10-21" });
    expect(formatEvent(old, { zone: "America/New_York" })).toBe("2026-10-21 весь день Встреча");
    expect(formatEvent(fresh)).toBe("2026-10-21 весь день Встреча");
    expect(formatEvent(event({ allDay: true, start: "2026-10-21", end: "2026-10-24" }))).toBe("2026-10-21–2026-10-23 весь день Встреча");
    expect(formatEvent(event({ allDay: true, start: "2026-10-22", end: "2026-10-23", instanceStart: "2026-10-21" }))).toBe(
      "2026-10-22 весь день Встреча [слот 2026-10-21]",
    );
  });

  it("visible сохраняет порядок выдачи readEvents", async () => {
    const { fake, ctx } = makeStand();
    plant(fake, seeds.singleMoscow);
    plant(fake, seeds.weeklyMoscow);
    const direct = await readEvents(ctx, { from: "2026-01-01T00:00:00Z", to: "2030-01-01T00:00:00Z" });
    expect(await visible(ctx)).toEqual(direct.map((e) => formatEvent(e)));
    expect((await visible(ctx))[0]).toBe("2026-10-19 10:00–11:00 Планёрка");
  });
});

describe("наблюдение: assertPropsPreserved, assertStoredInvariants, describeObject", () => {
  const seed = seeds.richMoscow.ics;

  it("затравка richMoscow несёт всё, что правка обязана сохранить (C15)", () => {
    for (const piece of ['ORGANIZER;CN="', "ATTENDEE;CN=", "ROLE=", "CATEGORIES:", "X-TELEMOST-CONFERENCE:", "SEQUENCE:", "EXDATE;", "RDATE;", "ACTION:AUDIO", "\r\n "]) {
      expect(seed).toContain(piece);
    }
    expect(findViolations(seed)).toEqual([]);
  });

  it("тождественный текст проходит; метаданные по умолчанию не сверяются", () => {
    expect(() => assertPropsPreserved(seed, seed)).not.toThrow();
    const restamped = seed.replace("DTSTAMP:20261001T090000Z", "DTSTAMP:20261005T120000Z");
    expect(() => assertPropsPreserved(seed, restamped)).not.toThrow();
    expect(() => assertPropsPreserved(seed, restamped, { keepMetadata: true })).toThrow(/DTSTAMP/);
  });

  it("ловит пропавшее свойство, изменённый PARTSTAT и чужой VALARM", () => {
    const noAttendee = seed.replace(/ATTENDEE;[^\r\n]*petrov[^\r\n]*\r\n/, "");
    expect(() => assertPropsPreserved(seed, noAttendee)).toThrow(/ATTENDEE/);
    const partstat = seed.replace("PARTSTAT=ACCEPTED", "PARTSTAT=NEEDS-ACTION");
    expect(() => assertPropsPreserved(seed, partstat)).toThrow(/PARTSTAT=ACCEPTED/);
    const alarm = seed.replace("ACTION:AUDIO", "ACTION:DISPLAY");
    expect(() => assertPropsPreserved(seed, alarm)).toThrow(/VALARM/);
    expect(() => assertPropsPreserved(seed, alarm, { except: ["VALARM"] })).not.toThrow();
  });

  it("only сужает проверку; except разрешает названным свойствам меняться", () => {
    const renamed = seed.replace("SUMMARY:Созвон", "SUMMARY:Новое имя");
    expect(() => assertPropsPreserved(seed, renamed)).toThrow(/SUMMARY/);
    expect(() => assertPropsPreserved(seed, renamed, { except: ["SUMMARY"] })).not.toThrow();
    expect(() => assertPropsPreserved(seed, renamed, { only: ["RRULE", "ATTENDEE"] })).not.toThrow();
  });

  it("по умолчанию кавычки и регистр параметров не важны, exact сверяет строки дословно", () => {
    const requoted = seed.replace('ORGANIZER;CN="Анна Смирнова"', "ORGANIZER;cn=Анна Смирнова");
    expect(requoted).not.toBe(seed);
    expect(() => assertPropsPreserved(seed, requoted)).not.toThrow();
    expect(() => assertPropsPreserved(seed, requoted, { exact: true })).toThrow(/ORGANIZER/);
    const refolded = seed.replace(/\r\n /g, "");
    expect(() => assertPropsPreserved(seed, refolded, { exact: true })).not.toThrow();
  });

  it("scope выбирает компоненты: основной, переопределения; пропавший компонент — ошибка", () => {
    const legacy = seeds.c56StaleShift.ics;
    const withoutOverride = legacy.replace(/BEGIN:VEVENT(?:(?!END:VEVENT)[\s\S])*RECURRENCE-ID[\s\S]*?END:VEVENT\r\n/, "");
    expect(withoutOverride).not.toContain("RECURRENCE-ID");
    expect(() => assertPropsPreserved(legacy, withoutOverride)).toThrow(/RECURRENCE-ID/);
    expect(() => assertPropsPreserved(legacy, withoutOverride, { scope: "master" })).not.toThrow();
    expect(() => assertPropsPreserved(legacy, withoutOverride, { scope: "overrides" })).toThrow();
  });

  it("assertStoredInvariants сверяет каждый объект стенда с его затравкой и внешними правками", () => {
    const { fake } = makeStand();
    const path = plant(fake, seeds.c55EchoOverride);
    plant(fake, seeds.weeklyMoscow);
    expect(() => assertStoredInvariants(fake)).not.toThrow();
    fake.externalEdit(path, (ics) => ics.replace(/DTEND;TZID=Europe\/Moscow:20261019T110000/, "DTEND;TZID=Europe/Moscow:20261019T090000"));
    expect(() => assertStoredInvariants(fake)).not.toThrow();
    const clean = yandexPath(calendarA, seeds.weeklyMoscow.uid);
    fake.objects.set(clean, { etag: "1", ics: seeds.weeklyMoscow.ics.replace("COUNT=6", "UNTIL=20261019T065959Z") });
    expect(() => assertStoredInvariants(fake)).toThrow(/until-before-dtstart/);
  });

  it("describeObject кратко перечисляет компоненты для сообщений об ошибках", () => {
    const lines = describeObject(seeds.c56StaleShift.ics);
    expect(lines[0]).toMatch(/^VEVENT основной/);
    expect(lines.join("\n")).toContain("RECURRENCE-ID;TZID=Europe/Moscow:20261021T100000");
    expect(lines.join("\n")).toContain("RRULE:");
  });
});

describe("контекст стенда", () => {
  it("makeContext строит настоящий клиент поверх fake.fetch; календари разрешаются по id и имени", async () => {
    const fake = new FakeCaldav();
    const ctx = makeContext(fake, { calendars: [calendarA, calendarB] });
    expect(ctx.config.baseUrl).toBe(FAKE_BASE_URL);
    expect(await ctx.resolveCalendar("Работа")).toBe(calendarB);
    expect(await ctx.resolveCalendar()).toBe(calendarA);
    expect(ctx.io).toBeUndefined();
    expect(ctx.now?.().toISOString()).toBe("2026-10-01T09:00:00.000Z");
    await ctx.client.request({ method: "REPORT", path: calendarA.href, depth: "1", body: "" });
    expect(fake.log[0]).toMatchObject({ method: "REPORT", path: calendarA.href, status: 207 });
  });

  it("plant кладёт затравку по пути Яндекса; now можно отключить", () => {
    const { fake } = makeStand();
    const path = plant(fake, seeds.weeklyMoscow, calendarB);
    expect(path).toBe(yandexPath(calendarB, seeds.weeklyMoscow.uid));
    expect(fake.ics(path)).toBe(seeds.weeklyMoscow.ics);
    expect(makeContext(fake, { now: null }).now).toBeUndefined();
    const unparsable = plant(fake, seeds.c63BadByday);
    expect(fake.ics(unparsable)).toBe(seeds.c63BadByday.ics);
  });
});

function unfoldedLines(ics: string): string[] {
  return ics.replace(/\r\n[ \t]/g, "").split("\r\n");
}

function isSeed(value: unknown): value is seeds.Seed {
  return typeof value === "object" && value !== null && "uid" in value && "ics" in value && "about" in value;
}
