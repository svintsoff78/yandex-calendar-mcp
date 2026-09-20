// Удаление событий — единственная необратимая операция сервиса. Домен ведёт
// её тем же путём, что правку: чтение объекта → планировщик
// (src/ical/edit.ts, planDelete) → предохранитель (src/ical/guard.ts) →
// доставка (src/domain/writes.ts). Отдельного пути удаления больше нет.
import { describe, expect, it } from "vitest";
import { deleteEvent, readEvents } from "../../src/domain/events.js";
import { hrefFor } from "../../src/caldav/objects.js";
import type { Calendar, CalendarEvent, Context, EditScope, ObjectIO, RawObject } from "../../src/types.js";
import { calendarA, makeStand, plant } from "../support/context.js";
import type { FakeCaldav } from "../support/fakeCaldav.js";
import { DEFAULT_WINDOW, describeStand, visible, wallTime } from "../support/observe.js";
import { singleMoscow, weeklyMoscow } from "../support/seeds.js";

const ZONE = "Europe/Moscow";

interface DeleteCall {
  calendarId?: string;
  id: string;
  scope?: EditScope;
  instanceStart?: string;
  etag?: string;
  confirm?: boolean;
}

function remove(ctx: Context, call: DeleteCall) {
  return deleteEvent(ctx, call as unknown as Parameters<typeof deleteEvent>[1]);
}

async function list(ctx: Context): Promise<CalendarEvent[]> {
  return readEvents(ctx, DEFAULT_WINDOW);
}

function at(events: CalendarEvent[], date: string): CalendarEvent {
  const found = events.filter((event) => event.instanceStart !== undefined && wallTime(event.instanceStart, ZONE).startsWith(date));
  expect(found.map((event) => event.instanceStart), `ровно одна встреча со слотом ${date}`).toHaveLength(1);
  return found[0];
}

function writes(fake: FakeCaldav, mark: number): string[] {
  return fake.writesSince(mark).map((entry) => `${entry.method} ${entry.path}`);
}

function weeklyStand() {
  const stand = makeStand();
  return { ...stand, path: plant(stand.fake, weeklyMoscow) };
}

function singleStand() {
  const stand = makeStand();
  return { ...stand, path: plant(stand.fake, singleMoscow) };
}

function refusalOf(error: unknown): { code?: unknown; message: string } {
  const fields = (typeof error === "object" && error !== null ? error : {}) as Record<string, unknown>;
  return { code: fields.code, message: error instanceof Error ? error.message : String(error) };
}

async function refused(run: () => Promise<unknown>): Promise<{ code?: unknown; message: string }> {
  try {
    await run();
  } catch (error) {
    return refusalOf(error);
  }
  throw new Error("ожидался отказ, а вызов прошёл");
}

describe("deleteEvent: одиночное событие", () => {
  it("удаляет объект целиком и говорит об этом в ответе", async () => {
    const { fake, ctx, path } = singleStand();
    const seen = (await list(ctx))[0];

    const mark = fake.mark();
    const result = await remove(ctx, { id: singleMoscow.uid, etag: seen.etag });

    expect(writes(fake, mark)).toEqual([`DELETE ${path}`]);
    expect(fake.has(path)).toBe(false);
    expect(result.objectRemoved).toBe(true);
    expect(result.scope).toBe("this");
    expect(await visible(ctx)).toEqual([]);
  });

  // Путь объекта на сервере Яндекса не выводится из UID: удалять нужно по
  // пути из ответа сервера. Цена ошибки здесь выше, чем у чтения: DELETE
  // либо не найдёт ничего, либо попадёт не в тот объект.
  it("удаляет по пути из ответа сервера, а не по пути, собранному из UID", async () => {
    const { fake, ctx, path } = singleStand();
    expect(path).not.toBe(hrefFor(calendarA, singleMoscow.uid));
    const seen = (await list(ctx))[0];

    const mark = fake.mark();
    await remove(ctx, { id: singleMoscow.uid, etag: seen.etag });

    expect(writes(fake, mark)).toEqual([`DELETE ${path}`]);
  });
});

describe("deleteEvent: серия", () => {
  it("scope this закрывает один слот EXDATE, объект и правило целы", async () => {
    const { fake, ctx, path } = weeklyStand();
    const target = at(await list(ctx), "2026-10-21");

    const mark = fake.mark();
    const result = await remove(ctx, { id: weeklyMoscow.uid, scope: "this", instanceStart: target.instanceStart, etag: target.etag });

    expect(writes(fake, mark)).toEqual([`PUT ${path}`]);
    expect(fake.has(path)).toBe(true);
    expect(result.objectRemoved).toBe(false);
    expect(fake.ics(path)).toContain("EXDATE;TZID=Europe/Moscow:20261021T100000");
    expect(fake.ics(path)).toContain("RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6");
    expect(await visible(ctx), describeStand(fake)).toEqual([
      "2026-10-19 10:00–11:00 Планёрка",
      "2026-10-26 10:00–11:00 Планёрка",
      "2026-10-28 10:00–11:00 Планёрка",
      "2026-11-02 10:00–11:00 Планёрка",
      "2026-11-04 10:00–11:00 Планёрка",
    ]);
  });

  it("scope this_and_following укорачивает правило, объект остаётся", async () => {
    const { fake, ctx, path } = weeklyStand();
    const target = at(await list(ctx), "2026-11-02");

    const mark = fake.mark();
    const result = await remove(ctx, {
      id: weeklyMoscow.uid,
      scope: "this_and_following",
      instanceStart: target.instanceStart,
      etag: target.etag,
    });

    expect(writes(fake, mark)).toEqual([`PUT ${path}`]);
    expect(fake.has(path)).toBe(true);
    expect(result.objectRemoved).toBe(false);
    expect(result.deleted).toContain("и далее");
    expect(await visible(ctx), describeStand(fake)).toEqual([
      "2026-10-19 10:00–11:00 Планёрка",
      "2026-10-21 10:00–11:00 Планёрка",
      "2026-10-26 10:00–11:00 Планёрка",
      "2026-10-28 10:00–11:00 Планёрка",
    ]);
  });

  it("scope all_series удаляет объект целиком", async () => {
    const { fake, ctx, path } = weeklyStand();
    const seen = at(await list(ctx), "2026-10-19");

    const mark = fake.mark();
    const result = await remove(ctx, { id: weeklyMoscow.uid, scope: "all_series", etag: seen.etag });

    expect(writes(fake, mark)).toEqual([`DELETE ${path}`]);
    expect(result.objectRemoved).toBe(true);
    expect(await visible(ctx)).toEqual([]);
  });

  // Умолчание зависит от вида события: у серии неточная просьба не должна
  // стирать всю серию.
  it("без scope у серии удаляется только названная встреча", async () => {
    const { fake, ctx, path } = weeklyStand();
    const target = at(await list(ctx), "2026-10-26");

    await remove(ctx, { id: weeklyMoscow.uid, instanceStart: target.instanceStart, etag: target.etag });

    expect(fake.has(path), "серия обязана остаться").toBe(true);
    expect((await list(ctx)).length).toBe(5);
  });

  it("без адреса встречи у серии — отказ с кодом, без записей", async () => {
    const { fake, ctx } = weeklyStand();

    const mark = fake.mark();
    const refusal = await refused(() => remove(ctx, { id: weeklyMoscow.uid, scope: "this", etag: fake.etag(fake.findByUid(weeklyMoscow.uid)[0].path) }));

    expect(writes(fake, mark), "отказ ничего не пишет").toEqual([]);
    expect(refusal.code, `отказ обязан нести код: ${refusal.message}`).toEqual(expect.any(String));
  });

  it("адрес, которого в серии нет, — отказ с кодом, без записей", async () => {
    const { fake, ctx } = weeklyStand();
    const etag = fake.etag(fake.findByUid(weeklyMoscow.uid)[0].path);

    const mark = fake.mark();
    const refusal = await refused(() =>
      remove(ctx, { id: weeklyMoscow.uid, scope: "this", instanceStart: "2026-10-20T10:00:00+03:00", etag }),
    );

    expect(writes(fake, mark)).toEqual([]);
    expect(refusal.code).toEqual(expect.any(String));
  });

  // Удаление последней живой встречи оставило бы объект без встреч — «зомби»,
  // которого не показывает ни один клиент. Такой объект удаляется целиком.
  it("удаление последней встречи убирает объект с сервера", async () => {
    const { fake, ctx, path } = singleStand();
    const seen = (await list(ctx))[0];

    const result = await remove(ctx, { id: singleMoscow.uid, scope: "this", instanceStart: seen.instanceStart ?? seen.start, etag: seen.etag });

    expect(fake.has(path)).toBe(false);
    expect(result.objectRemoved).toBe(true);
  });
});

describe("deleteEvent: чужая правка между показом и удалением", () => {
  // If-Match на DELETE Яндекс не соблюдает, поэтому сверять состояние обязан
  // сам код: удаляется то, что пользователю показали, а не то, что успел
  // записать другой клиент.
  it("устаревший etag — отказ, объект и чужая правка целы", async () => {
    const { fake, ctx, path } = weeklyStand();
    const seen = at(await list(ctx), "2026-10-19");
    fake.externalEdit(path, (ics) => ics.replace("SUMMARY:Планёрка", "SUMMARY:Чужая правка"));
    const external = fake.ics(path);

    const mark = fake.mark();
    const refusal = await refused(() => remove(ctx, { id: weeklyMoscow.uid, scope: "all_series", etag: seen.etag }));

    expect(writes(fake, mark), "отказ ничего не пишет").toEqual([]);
    expect(fake.ics(path), "чужая правка цела").toBe(external);
    expect(refusal.code).toBe("stale-etag");
    expect(refusal.message).toMatch(/уже изменилось/);
  });

  it("перед DELETE объект перечитывается: чужая правка, попавшая в это окно, спасает объект", async () => {
    const { fake, ctx, path } = weeklyStand();
    const seen = at(await list(ctx), "2026-10-19");
    // Правка приходит после нашего чтения, но до сверки перед DELETE.
    let armed = true;
    fake.beforeRequest = (request) => {
      if (armed && request.method === "REPORT" && fake.has(path)) {
        armed = false;
        fake.externalEdit(path, (ics) => ics.replace("SUMMARY:Планёрка", "SUMMARY:Свежая чужая"));
      }
    };

    const mark = fake.mark();
    const refusal = await refused(() => remove(ctx, { id: weeklyMoscow.uid, scope: "all_series", etag: seen.etag }));

    expect(writes(fake, mark), "DELETE не ушёл").toEqual([]);
    expect(fake.has(path)).toBe(true);
    expect(refusal.code).toEqual(expect.any(String));
  });

  it("потерянный ответ на DELETE — «удалено», а не ошибка, и DELETE ровно один", async () => {
    const { fake, ctx, path } = weeklyStand();
    const seen = at(await list(ctx), "2026-10-19");
    const fault = fake.loseResponse({ method: "DELETE" }, 503);

    const mark = fake.mark();
    const result = await remove(ctx, { id: weeklyMoscow.uid, scope: "all_series", etag: seen.etag });

    expect(fault.fired).toBe(1);
    expect(writes(fake, mark).filter((entry) => entry.startsWith("DELETE"))).toHaveLength(1);
    expect(fake.has(path)).toBe(false);
    expect(result.objectRemoved).toBe(true);
  });
});

describe("deleteEvent: границы", () => {
  it("отказывается удалять из календаря только для чтения", async () => {
    const readOnly: Calendar = { ...calendarA, readOnly: true };
    const { fake, ctx } = makeStand({ calendars: [readOnly] });
    plant(fake, weeklyMoscow, readOnly);

    const mark = fake.mark();
    await expect(remove(ctx, { id: weeklyMoscow.uid, scope: "all_series" })).rejects.toThrow(/только для чтения/);
    expect(writes(fake, mark)).toEqual([]);
  });

  it("события с неизвестным идентификатором не выдумывает", async () => {
    const { fake, ctx } = weeklyStand();

    const mark = fake.mark();
    const refusal = await refused(() => remove(ctx, { id: "нет-такого@yandex.ru", scope: "all_series" }));

    expect(writes(fake, mark)).toEqual([]);
    expect(refusal.message).toMatch(/не найдено/);
  });

  // Исход, которого стенд не изображает: сервер отклонил DELETE насовсем.
  it("отказ сервера назван причиной, объект не тронут", async () => {
    const { fake, ctx, path } = weeklyStand();
    const raw: RawObject = { href: path, etag: fake.etag(path), ics: fake.ics(path) };
    let removes = 0;
    const io: ObjectIO = {
      find: async () => raw,
      put: async () => ({ status: "applied", etag: "x" }),
      remove: async () => {
        removes += 1;
        return { status: "rejected", error: new Error("Сервер: удаление запрещено") };
      },
    };
    ctx.io = io;

    const refusal = await refused(() => remove(ctx, { id: weeklyMoscow.uid, scope: "all_series", etag: raw.etag }));

    expect(removes, "отклонённое удаление не повторяется").toBe(1);
    expect(refusal.code).toBe("rejected");
    expect(refusal.message).toContain("удаление запрещено");
  });
});
