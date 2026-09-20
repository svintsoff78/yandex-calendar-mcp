// Договор оркестрации с предохранителем (src/ical/guard.ts, GuardOptions):
// у правки патч передаётся ВСЕГДА, у удаления патча нет вовсе.
//
// Без патча предохранитель верит `expect.fields` планировщика и молчит там,
// где он обязан говорить: поле, которого в патче нет, но которое план
// объявил применённым, пройдёт сверку, а переход «серия кончалась ↔ не
// кончается» вообще не судится. Потеря патча по дороге ничем другим не
// видна — ни один тест правки от этого не покраснеет, — поэтому договор
// сторожит этот файл.
//
// Предохранитель подменяется обёрткой: она записывает аргументы и зовёт
// настоящий verifyPlan, так что сами проверки работают как обычно.
import { describe, expect, it, vi } from "vitest";

const seen = vi.hoisted(() => ({ calls: [] as Array<{ beforeIcs: string; options: Record<string, unknown> }> }));

vi.mock("../../src/ical/guard.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/ical/guard.js")>();
  return {
    ...actual,
    verifyPlan(beforeIcs: string, plan: never, env: never, options: Record<string, unknown> = {}) {
      seen.calls.push({ beforeIcs, options });
      return actual.verifyPlan(beforeIcs, plan, env, options as never);
    },
  };
});

import { deleteEvent, readEvents, updateEvent } from "../../src/domain/events.js";
import type { CalendarEvent, Context } from "../../src/types.js";
import { makeStand, plant } from "../support/context.js";
import { DEFAULT_WINDOW, wallTime } from "../support/observe.js";
import { weeklyMoscow } from "../support/seeds.js";

function weeklyStand() {
  const stand = makeStand();
  seen.calls.length = 0;
  return { ...stand, path: plant(stand.fake, weeklyMoscow) };
}

async function at(ctx: Context, date: string): Promise<CalendarEvent> {
  const events = await readEvents(ctx, DEFAULT_WINDOW);
  const found = events.filter(
    (event) => event.instanceStart !== undefined && wallTime(event.instanceStart, "Europe/Moscow").startsWith(date),
  );
  expect(found, `ровно одна встреча со слотом ${date}`).toHaveLength(1);
  return found[0];
}

describe("предохранитель зовётся по договору", () => {
  it("правка всей серии: патч передан, и это тот же патч, что получил планировщик", async () => {
    const { ctx } = weeklyStand();
    const patch = { summary: "Планёрка отдела" };

    await updateEvent(ctx, { id: weeklyMoscow.uid, scope: "all_series", patch } as never);

    expect(seen.calls, "предохранитель позван ровно раз").toHaveLength(1);
    expect(seen.calls[0].options.patch, "патч передан в предохранитель").toBe(patch);
    expect(seen.calls[0].options.now, "«сейчас» передано: от него считается горизонт сверки").toBeDefined();
  });

  it("правка одной встречи: патч передан", async () => {
    const { ctx } = weeklyStand();
    const target = await at(ctx, "2026-10-21");
    const patch = { summary: "С заказчиком" };
    seen.calls.length = 0;

    await updateEvent(ctx, { id: weeklyMoscow.uid, scope: "this", instanceStart: target.instanceStart, patch } as never);

    expect(seen.calls).toHaveLength(1);
    expect(seen.calls[0].options.patch).toBe(patch);
  });

  it("разрез серии: патч передан и там", async () => {
    const { ctx } = weeklyStand();
    const target = await at(ctx, "2026-10-26");
    const patch = { location: "Переговорная 5" };
    seen.calls.length = 0;

    await updateEvent(ctx, {
      id: weeklyMoscow.uid,
      scope: "this_and_following",
      instanceStart: target.instanceStart,
      patch,
    } as never);

    expect(seen.calls).toHaveLength(1);
    expect(seen.calls[0].options.patch).toBe(patch);
  });

  it("удаление: патча нет — его и не передают", async () => {
    const { ctx } = weeklyStand();
    const target = await at(ctx, "2026-10-21");
    seen.calls.length = 0;

    await deleteEvent(ctx, {
      id: weeklyMoscow.uid,
      scope: "this",
      instanceStart: target.instanceStart,
      etag: target.etag,
    } as never);

    expect(seen.calls).toHaveLength(1);
    expect(seen.calls[0].options).not.toHaveProperty("patch");
    expect(seen.calls[0].options.now).toBeDefined();
  });

  it("сверяется прочитанный текст объекта, а не что-нибудь другое", async () => {
    const { fake, ctx, path } = weeklyStand();
    const before = fake.ics(path);
    seen.calls.length = 0;

    await updateEvent(ctx, { id: weeklyMoscow.uid, scope: "all_series", patch: { summary: "Иначе" } } as never);

    // Разбор ответа сервера нормализует переводы строк, поэтому сверяем
    // построчно: важно, что это текст ДО записи, а не после.
    const lines = (ics: string) => ics.replace(/\r\n/g, "\n").trimEnd().split("\n");
    expect(lines(seen.calls[0].beforeIcs), "предохранителю дают текст ДО записи").toEqual(lines(before));
  });

  // Предохранитель — не украшение: его отказ обязан останавливать запись.
  it("отказ предохранителя останавливает запись", async () => {
    const { fake, ctx } = weeklyStand();
    const guard = await import("../../src/ical/guard.js");
    const spy = vi.spyOn(guard, "verifyPlan").mockImplementation(() => {
      throw new guard.GuardError([{ code: "meeting-lost", message: "проба: встреча пропала" }]);
    });

    const mark = fake.mark();
    try {
      await expect(
        updateEvent(ctx, { id: weeklyMoscow.uid, scope: "all_series", patch: { summary: "Не должно записаться" } } as never),
      ).rejects.toMatchObject({ code: "meeting-lost" });
      expect(fake.writesSince(mark), "запись не ушла").toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
});
