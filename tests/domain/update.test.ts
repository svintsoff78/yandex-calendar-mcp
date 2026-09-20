// Правка событий: домен ведёт её единственным путём — чтение объекта →
// планировщик (src/ical/edit.ts) → предохранитель (src/ical/guard.ts) →
// доставка (src/domain/writes.ts). Второго пути правки нет: прежний,
// собиравший объект заново из разобранной модели, убран целиком.
//
// Стенд — настоящий фейковый сервер tests/support (весь путь домен → CalDAV
// → транспорт исполняется боевым кодом), кроме случаев, где нужен исход
// записи, которого стенд не изображает: там подставляется `Context.io`.
import { describe, expect, it } from "vitest";
import { readEvents, updateEvent } from "../../src/domain/events.js";
import type { Calendar, CalendarEvent, Context, EditScope, ObjectIO, RawObject } from "../../src/types.js";
import { hrefFor } from "../../src/caldav/objects.js";
import { calendarA, makeStand, plant } from "../support/context.js";
import type { FakeCaldav } from "../support/fakeCaldav.js";
import { DEFAULT_WINDOW, describeStand, visible, wallTime } from "../support/observe.js";
import { singleMoscow, weeklyMoscow } from "../support/seeds.js";

const ZONE = "Europe/Moscow";

interface UpdateCall {
  calendarId?: string;
  id: string;
  scope?: EditScope;
  instanceStart?: string;
  patch: Record<string, unknown>;
  etag?: string;
  confirm?: boolean;
}

function update(ctx: Context, call: UpdateCall) {
  return updateEvent(ctx, call as unknown as Parameters<typeof updateEvent>[1]);
}

async function list(ctx: Context): Promise<CalendarEvent[]> {
  return readEvents(ctx, DEFAULT_WINDOW);
}

/** Встреча серии по дате её слота в поясе показа; адрес — только из выдачи. */
function at(events: CalendarEvent[], date: string): CalendarEvent {
  const found = events.filter((event) => event.instanceStart !== undefined && wallTime(event.instanceStart, ZONE).startsWith(date));
  expect(found.map((event) => event.instanceStart), `ровно одна встреча со слотом ${date}`).toHaveLength(1);
  return found[0];
}

/** Записи стенда после отметки: метод и путь. */
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

/** Поля отказа: они и различают причины. */
function refusalOf(error: unknown): { code?: unknown; needsConfirm?: unknown; losses?: unknown[]; message: string } {
  const fields = (typeof error === "object" && error !== null ? error : {}) as Record<string, unknown>;
  return {
    code: fields.code,
    needsConfirm: fields.needsConfirm,
    losses: fields.losses as unknown[] | undefined,
    message: error instanceof Error ? error.message : String(error),
  };
}

async function refused(run: () => Promise<unknown>): Promise<ReturnType<typeof refusalOf>> {
  try {
    await run();
  } catch (error) {
    return refusalOf(error);
  }
  throw new Error("ожидался отказ, а вызов прошёл");
}

describe("updateEvent: один путь записи", () => {
  it("вся серия: один PUT с If-Match прочитанного ETag, правило цело", async () => {
    const { fake, ctx, path } = weeklyStand();
    const etag = fake.etag(path);

    const mark = fake.mark();
    const result = await update(ctx, { id: weeklyMoscow.uid, scope: "all_series", patch: { summary: "Планёрка отдела" } });

    const log = fake.writesSince(mark);
    expect(log.map((entry) => `${entry.method} ${entry.path}`)).toEqual([`PUT ${path}`]);
    expect(log[0].ifMatch, "запись условна по прочитанному ETag").toBe(etag);
    expect(fake.ics(path)).toContain("RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6");
    expect(result.changed).toBe(true);
    expect(result.scope).toBe("all_series");
    expect(await visible(ctx)).toEqual([
      "2026-10-19 10:00–11:00 Планёрка отдела",
      "2026-10-21 10:00–11:00 Планёрка отдела",
      "2026-10-26 10:00–11:00 Планёрка отдела",
      "2026-10-28 10:00–11:00 Планёрка отдела",
      "2026-11-02 10:00–11:00 Планёрка отдела",
      "2026-11-04 10:00–11:00 Планёрка отдела",
    ]);
  });

  it("не трогает полей, которых нет в патче", async () => {
    const { fake, ctx, path } = singleStand();
    const before = fake.ics(path);

    await update(ctx, { id: singleMoscow.uid, patch: { location: "Офис" } });

    const after = fake.ics(path);
    expect(after).toContain("LOCATION:Офис");
    // Заголовок и время прежние — их патч не называл.
    for (const line of before.split("\r\n")) {
      if (line.startsWith("SUMMARY:") || line.startsWith("DTSTART") || line.startsWith("DTEND")) {
        expect(after, `строка «${line}» обязана была уцелеть`).toContain(line);
      }
    }
  });

  it("scope this: добавляет переопределение с RECURRENCE-ID, правило серии цело", async () => {
    const { fake, ctx, path } = weeklyStand();
    const target = at(await list(ctx), "2026-10-21");

    await update(ctx, { id: weeklyMoscow.uid, scope: "this", instanceStart: target.instanceStart, patch: { summary: "С заказчиком" } });

    const text = fake.ics(path);
    expect(text).toContain("RECURRENCE-ID;TZID=Europe/Moscow:20261021T100000");
    expect(text).toContain("SUMMARY:С заказчиком");
    expect(text).toContain("RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6");
    expect(await visible(ctx)).toContain("2026-10-21 10:00–11:00 С заказчиком");
  });

  it("scope по умолчанию — this, а не вся серия", async () => {
    const { ctx } = weeklyStand();
    const target = at(await list(ctx), "2026-10-21");

    await update(ctx, { id: weeklyMoscow.uid, instanceStart: target.instanceStart, patch: { summary: "Только 21-е" } });

    const seen = await visible(ctx);
    expect(seen.filter((row) => row.includes("Только 21-е"))).toHaveLength(1);
  });

  it("требует адрес встречи у серии при scope this: отказ с кодом, без записей", async () => {
    const { fake, ctx } = weeklyStand();

    const mark = fake.mark();
    const refusal = await refused(() => update(ctx, { id: weeklyMoscow.uid, scope: "this", patch: { summary: "Без адреса" } }));

    expect(writes(fake, mark), "отказ ничего не пишет").toEqual([]);
    expect(refusal.code, `отказ обязан нести код: ${refusal.message}`).toEqual(expect.any(String));
  });

  it("адрес, которого в серии нет, — отказ с кодом, без записей", async () => {
    const { fake, ctx } = weeklyStand();

    const mark = fake.mark();
    const refusal = await refused(() =>
      update(ctx, { id: weeklyMoscow.uid, scope: "this", instanceStart: "2026-10-20T10:00:00+03:00", patch: { summary: "Мимо" } }),
    );

    expect(writes(fake, mark)).toEqual([]);
    expect(refusal.code).toEqual(expect.any(String));
  });

  // Разрез серии (writeSplit): продолжение создаётся раньше усечения
  // исходной серии — иначе сорвавшаяся вторая запись оставила бы хвост
  // нигде.
  it("scope this_and_following: сначала создаётся продолжение, потом усекается исходная серия", async () => {
    const { fake, ctx, path } = weeklyStand();
    const target = at(await list(ctx), "2026-10-26");

    const mark = fake.mark();
    const result = await update(ctx, {
      id: weeklyMoscow.uid,
      scope: "this_and_following",
      instanceStart: target.instanceStart,
      patch: { location: "Переговорная 5" },
    });

    const log = fake.writesSince(mark);
    expect(log).toHaveLength(2);
    expect(log[0].path, "первой записью создаётся продолжение").not.toBe(path);
    expect(log[0].ifNoneMatch, "продолжение создаётся условно").toBe("*");
    expect(log[1].path, "второй записью усекается исходная серия").toBe(path);
    expect(result.id, "ответ называет продолжение").not.toBe(weeklyMoscow.uid);
    expect(result.series?.id, "ответ называет и исходную серию").toBe(weeklyMoscow.uid);
    expect(await visible(ctx), describeStand(fake)).toEqual([
      "2026-10-19 10:00–11:00 Планёрка",
      "2026-10-21 10:00–11:00 Планёрка",
      "2026-10-26 10:00–11:00 Планёрка @Переговорная 5",
      "2026-10-28 10:00–11:00 Планёрка @Переговорная 5",
      "2026-11-02 10:00–11:00 Планёрка @Переговорная 5",
      "2026-11-04 10:00–11:00 Планёрка @Переговорная 5",
    ]);
  });

  // Путь объекта на сервере Яндекса не выводится из UID (собака
  // выбрасывается, а не кодируется): писать нужно по пути из ответа
  // сервера, иначе правка ушла бы мимо — в новый объект.
  it("пишет по пути из ответа сервера, а не по пути, собранному из UID", async () => {
    const { fake, ctx, path } = weeklyStand();
    expect(path, "путь на сервере не совпадает с собранным из UID").not.toBe(hrefFor(calendarA, weeklyMoscow.uid));

    const mark = fake.mark();
    await update(ctx, { id: weeklyMoscow.uid, scope: "all_series", patch: { summary: "Новое имя" } });

    expect(writes(fake, mark)).toEqual([`PUT ${path}`]);
    expect(fake.objects.size, "второго объекта не появилось").toBe(1);
  });

  it("отказывается писать в календарь только для чтения", async () => {
    const readOnly: Calendar = { ...calendarA, readOnly: true };
    const { fake, ctx } = makeStand({ calendars: [readOnly] });
    plant(fake, weeklyMoscow, readOnly);

    const mark = fake.mark();
    await expect(update(ctx, { id: weeklyMoscow.uid, scope: "all_series", patch: { summary: "Нельзя" } })).rejects.toThrow(
      /только для чтения/,
    );
    expect(writes(fake, mark)).toEqual([]);
  });

  it("события с неизвестным идентификатором не выдумывает", async () => {
    const { fake, ctx } = weeklyStand();

    const mark = fake.mark();
    const refusal = await refused(() => update(ctx, { id: "нет-такого@yandex.ru", patch: { summary: "x" } }));

    expect(writes(fake, mark)).toEqual([]);
    expect(refusal.message).toMatch(/не найдено/);
  });
});

describe("updateEvent: отказ движка переведён для пользователя", () => {
  /** Серия с перенесённой 21.10: новое правило «только понедельники» её теряет. */
  async function standWithMoved() {
    const stand = weeklyStand();
    const target = at(await list(stand.ctx), "2026-10-21");
    await update(stand.ctx, {
      id: weeklyMoscow.uid,
      scope: "this",
      instanceStart: target.instanceStart,
      patch: { start: "2026-10-21T11:30:00+03:00", end: "2026-10-21T12:30:00+03:00" },
    });
    return stand;
  }

  const mondaysOnly = { recurrence: { frequency: "weekly", interval: 1, byWeekday: ["MO"] } };

  // Потеря сверх названной цели — отказ с перечнем потерь. В тексте обязаны
  // быть и сами потери, и etag, которым их подтверждают: без него
  // пользователю пришлось бы догадываться, что передать.
  it("потери названы в тексте, и там же — etag для подтверждения", async () => {
    const { fake, ctx, path } = await standWithMoved();
    const etag = fake.etag(path);

    const mark = fake.mark();
    const refusal = await refused(() => update(ctx, { id: weeklyMoscow.uid, scope: "all_series", patch: mondaysOnly }));

    expect(writes(fake, mark), "отказ ничего не пишет").toEqual([]);
    expect(refusal.needsConfirm).toBe(true);
    expect((refusal.losses ?? []).length, "перечень потерь не пуст").toBeGreaterThan(0);
    expect(refusal.message, "в тексте перечислены потери").toContain("Будет потеряно");
    expect(refusal.message, "в тексте названа потерянная встреча").toContain("2026-10-21");
    expect(refusal.message, "в тексте назван etag для подтверждения").toContain(etag);
    expect(refusal.message, "во внешнем тексте нет внутренних обозначений").not.toMatch(/\b[ОРЖЗ]\d+\b/);
  });

  it("с confirm и тем же etag правка проходит, а потери названы в ответе", async () => {
    const { fake, ctx, path } = await standWithMoved();

    const result = await update(ctx, {
      id: weeklyMoscow.uid,
      scope: "all_series",
      patch: mondaysOnly,
      confirm: true,
      etag: fake.etag(path),
    });

    expect(result.changed).toBe(true);
    expect(
      result.removed.some((loss) => loss.instanceStart.startsWith("2026-10-21")),
      `ответ перечисляет то же, что подтверждали: ${JSON.stringify(result.removed)}`,
    ).toBe(true);
    expect(fake.rejections, "строгий стенд не отверг запись").toEqual([]);
  });

  it("confirm с чужим etag не действует: отказ и ни одной записи", async () => {
    const { fake, ctx } = await standWithMoved();

    const mark = fake.mark();
    const refusal = await refused(() =>
      update(ctx, { id: weeklyMoscow.uid, scope: "all_series", patch: mondaysOnly, confirm: true, etag: "устаревший" }),
    );

    expect(writes(fake, mark)).toEqual([]);
    expect(refusal.code).toBe("confirm-required");
  });
});

describe("updateEvent: ответ сервера разбирается доставкой", () => {
  // Ж16 на живом пути: событие удалили между нашим чтением и записью.
  // Яндекс такой PUT не отклоняет, а создаёт объект нашим текстом и отвечает
  // 201. Это конфликт, а не успех: прежний код, бравший из ответа только
  // ETag, выдал бы его за удачную правку.
  it("ответ 201 на правку прочитанного объекта — конфликт, а не успех", async () => {
    const { fake, ctx, path } = weeklyStand();
    fake.beforeRequest = (request) => {
      if (request.method === "PUT" && fake.has(path)) fake.externalDelete(path);
    };

    let caught: unknown;
    try {
      await update(ctx, { id: weeklyMoscow.uid, scope: "all_series", patch: { summary: "Гонка" } });
    } catch (error) {
      caught = error;
    }

    expect(fake.log.filter((entry) => entry.method === "PUT").map((entry) => entry.status)).toEqual([201]);
    const refusal = refusalOf(caught);
    expect(refusal.code, `исход записи — конфликт: ${refusal.message}`).toBe("conflict");
    expect(refusal.message).toMatch(/создал событие заново/);
    expect((caught as { recreated?: unknown }).recreated, "правка воскресила удалённое событие").toBe(true);
  });

  it("412 на правку — конфликт «событие изменили», чужая правка цела", async () => {
    const { fake, ctx, path } = weeklyStand();
    // Чужая запись успевает между нашим чтением и нашим PUT: If-Match
    // прочитанного ETag Яндекс соблюдает, и наш PUT получает 412.
    fake.beforeRequest = (request) => {
      if (request.method === "PUT") {
        fake.beforeRequest = undefined;
        fake.externalEdit(path, (ics) => ics.replace("SUMMARY:Планёрка", "SUMMARY:Чужая правка"));
      }
    };

    const mark = fake.mark();
    const refusal = await refused(() => update(ctx, { id: weeklyMoscow.uid, scope: "all_series", patch: { summary: "Моя правка" } }));

    expect(fake.ics(path), "чужая правка цела").toContain("SUMMARY:Чужая правка");
    expect(fake.writesSince(mark).map((entry) => entry.status), "повторной записи нет").toEqual([412]);
    expect(refusal.code).toBe("conflict");
    expect(refusal.message).toMatch(/изменили после того, как его прочитали/);
  });

  // Перечитывание вместо слепого повтора: ответа сервера не было, объект на
  // месте и прежний — значит запись не дошла, и повтор допустим ровно один.
  it("потерянный ответ: объект перечитывается, повтор ровно один", async () => {
    const { fake, ctx, path } = weeklyStand();
    const fault = fake.dropRequest({ method: "PUT" }, 504);

    const mark = fake.mark();
    const result = await update(ctx, { id: weeklyMoscow.uid, scope: "all_series", patch: { summary: "После обрыва" } });

    expect(fault.fired).toBe(1);
    const log = fake.since(mark);
    expect(log.filter((entry) => entry.method === "PUT").map((entry) => entry.status)).toEqual([504, 204]);
    const firstPut = log.findIndex((entry) => entry.method === "PUT");
    const secondPut = log.findIndex((entry, index) => index > firstPut && entry.method === "PUT");
    expect(
      log.slice(firstPut + 1, secondPut).some((entry) => entry.method === "REPORT" || entry.method === "GET"),
      "перед повтором объект перечитан",
    ).toBe(true);
    expect(result.changed).toBe(true);
    expect(fake.ics(path)).toContain("SUMMARY:После обрыва");
  });
});

describe("updateEvent: отказ ввода-вывода доходит до пользователя целым", () => {
  // Исход, которого стенд не изображает: сервер отклонил запись насовсем.
  it("отказ сервера назван причиной, и объект не тронут", async () => {
    const { fake, ctx, path } = weeklyStand();
    const raw: RawObject = { href: path, etag: fake.etag(path), ics: fake.ics(path) };
    let puts = 0;
    const io: ObjectIO = {
      find: async () => raw,
      put: async () => {
        puts += 1;
        return { status: "rejected", error: new Error("Сервер: календарь переполнен") };
      },
      remove: async () => ({ status: "applied" }),
    };
    ctx.io = io;

    const refusal = await refused(() => update(ctx, { id: weeklyMoscow.uid, scope: "all_series", patch: { summary: "Нельзя" } }));

    expect(puts, "отклонённая запись не повторяется").toBe(1);
    expect(refusal.code).toBe("rejected");
    expect(refusal.message).toContain("календарь переполнен");
  });
});
