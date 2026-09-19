// Цепочки транспорта и чтения (З05b; §6 и §7 плана переделки,
// docs/superpowers/plans/2026-09-19-recurring-events-rework.md; сценарии
// C26, C27, C29 — из §6.2 проекта «сырое дерево», C59 — из §6 итогового
// плана; поломки — из
// .superpowers/sdd/2026-09-18-yandex-calendar-mcp/wave-a-results.json).
//
// Цепочка — последовательность публичных вызовов домена (createEvent,
// readEvents, updateEvent, deleteEvent) на изменяемом стенде tests/support
// через настоящий транспорт createClient(config, fake.fetch). instanceStart
// и etag берутся только из выдачи readEvents. После каждого шага —
// точный видимый список и инварианты О12а.
//
// Сбои задаёт стенд: loseResponse — запрос применён, ответ потерян (обрыв
// сети, таймаут, 503, 504); dropRequest — запрос не применён, 504. По Р8
// PUT и DELETE вслепую не повторяются: исход выясняется перечитыванием, и
// повтор допустим ровно один — когда перечитывание показало, что запись не
// дошла. Стенд по умолчанию ведёт себя как Яндекс (Ж13–Ж16 в
// docs/yandex-caldav-capabilities.md): If-None-Match и If-Match на DELETE не
// соблюдаются, поэтому устаревший etag ловит только сам код, а не сервер.
// Режим conditions "rfc" здесь не нужен ни одной цепочке.
//
// Все цепочки — it.fails: на прежней реализации каждая падает на утверждении
// о данных (видимый список, состояние сервера, ответ пользователю, журнал
// записей). Задача З13 снимает .fails, когда цепочки станут зелёными.
import { describe, expect, it } from "vitest";
import { createEvent, deleteEvent, readEvents, updateEvent } from "../../src/domain/events.js";
import type { CalendarEvent, Context, EditScope } from "../../src/types.js";
import { makeStand, plant } from "../support/context.js";
import type { FakeCaldav } from "../support/fakeCaldav.js";
import { lineName, parseRawComponents } from "../support/invariants.js";
import {
  assertStoredInvariants,
  DEFAULT_WINDOW,
  DEFAULT_ZONE,
  describeStand,
  expectNoWrites,
  visible,
  wallTime,
} from "../support/observe.js";
import { weeklyMoscow } from "../support/seeds.js";

// ---------------------------------------------------------------------------
// Вызовы домена
// ---------------------------------------------------------------------------

interface UpdateArgs {
  calendarId?: string;
  id: string;
  scope?: EditScope;
  instanceStart?: string;
  patch: Record<string, unknown>;
  etag?: string;
  confirm?: boolean;
}

// Поля etag и confirm (Р11) — интерфейс новой реализации; прежняя сигнатура
// их не знает и просто не читает. Приведение типа нужно только затем, чтобы
// один и тот же файл шёл и на прежнем коде, и на новом.
function update(ctx: Context, args: UpdateArgs): Promise<unknown> {
  return updateEvent(ctx, args as unknown as Parameters<typeof updateEvent>[1]);
}

function remove(
  ctx: Context,
  args: { id: string; scope?: EditScope; instanceStart?: string; etag?: string; confirm?: boolean },
): Promise<unknown> {
  return deleteEvent(ctx, args as unknown as Parameters<typeof deleteEvent>[1]);
}

type Outcome = { ok: true; value: unknown } | { ok: false; error: unknown };

async function attempt(run: () => Promise<unknown>): Promise<Outcome> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return { ok: false, error };
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Шаг обязан завершиться успехом; иначе в сообщении — текст отказа. */
function expectSuccess(outcome: Outcome, what: string): unknown {
  expect(outcome.ok ? "успех" : `отказ: ${messageOf(outcome.error)}`, what).toBe("успех");
  return (outcome as { value: unknown }).value;
}

/** Шаг обязан закончиться отказом; отдаёт код отказа (отказы различаются по code). */
function refusalCode(outcome: Outcome, what: string): unknown {
  expect(outcome.ok ? "успех" : "отказ", what).toBe("отказ");
  const error = (outcome as { error: unknown }).error;
  return typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
}

// ---------------------------------------------------------------------------
// Наблюдение
// ---------------------------------------------------------------------------

async function list(ctx: Context, window: { from: string; to: string } = DEFAULT_WINDOW): Promise<CalendarEvent[]> {
  return readEvents(ctx, { from: window.from, to: window.to });
}

/** Встреча по дате её слота (instanceStart) в поясе показа; адрес — только из выдачи. */
function slot(events: CalendarEvent[], date: string, zone = DEFAULT_ZONE): CalendarEvent {
  const found = events.filter(
    (event) => event.instanceStart !== undefined && wallTime(event.instanceStart, zone).slice(0, 10) === date,
  );
  expect(
    found.map((event) => `${event.id} ${event.instanceStart}`),
    `в выдаче ровно одна встреча со слотом ${date}`,
  ).toHaveLength(1);
  return found[0];
}

function line(
  date: string,
  options: { time?: string; summary?: string; location?: string; slot?: string } = {},
): string {
  let text = `${date} ${options.time ?? "10:00–11:00"} ${options.summary ?? "Планёрка"}`;
  if (options.location) text += ` @${options.location}`;
  if (options.slot) text += ` [слот ${options.slot}]`;
  return text;
}

async function expectVisible(
  ctx: Context,
  fake: FakeCaldav,
  expected: string[],
  options: { zone?: string; from?: string; to?: string } = {},
): Promise<void> {
  expect(await visible(ctx, options), describeStand(fake)).toEqual(expected);
  assertStoredInvariants(fake);
}

/** Журнал: ни один PUT или DELETE не ушёл на тот же путь дважды. */
function expectNoRepeatedWrites(fake: FakeCaldav, mark: number): void {
  const writes = fake.writesSince(mark).map((w) => `${w.method} ${w.path}`);
  const repeated = writes.filter((w, i) => writes.indexOf(w) !== i);
  expect(repeated, `журнал записей: ${writes.join("; ")}`).toEqual([]);
}

function masterLines(ics: string): string[] {
  const root = parseRawComponents(ics)[0];
  const masters = (root?.children ?? []).filter(
    (c) => c.name === "VEVENT" && !c.lines.some((l) => lineName(l) === "RECURRENCE-ID"),
  );
  expect(masters, "в объекте ровно один основной компонент").toHaveLength(1);
  return masters[0].lines;
}

// ---------------------------------------------------------------------------
// Серия по умолчанию: Пн и Ср 10:00–11:00 МСК с 19.10.2026, COUNT=6
// ---------------------------------------------------------------------------

const SERIES = weeklyMoscow.uid;
const ALL_SIX = ["2026-10-19", "2026-10-21", "2026-10-26", "2026-10-28", "2026-11-02", "2026-11-04"].map((d) => line(d));
const SPLIT_26 = [
  line("2026-10-19"),
  line("2026-10-21"),
  ...["2026-10-26", "2026-10-28", "2026-11-02", "2026-11-04"].map((d) => line(d, { location: "Переговорная 5" })),
];

function weeklyStand() {
  const stand = makeStand();
  const path = plant(stand.fake, weeklyMoscow);
  return { ...stand, path };
}

describe("цепочки транспорта (З05b): потерянный ответ, устаревший etag, повтор после обрыва", () => {
  it.fails("C26a: потерян ответ на PUT усечения при разрезе → ответ честный, 6 встреч без повторов записи", async () => {
    // AE7: транспорт повторял условный PUT, получал 412 на собственную
    // применённую запись, продолжение не создавалось — хвост терялся.
    const { fake, ctx, path } = weeklyStand();
    const instanceStart = slot(await list(ctx), "2026-10-26").instanceStart;

    const fault = fake.loseResponse({ method: "PUT", path }, "network");
    const mark = fake.mark();
    const split = await attempt(() =>
      update(ctx, { id: SERIES, scope: "this_and_following", instanceStart, patch: { location: "Переговорная 5" } }),
    );
    await expectVisible(ctx, fake, SPLIT_26);
    expect(fault.fired, "ответ на усечение потерян ровно раз").toBe(1);
    expectNoRepeatedWrites(fake, mark);
    expectSuccess(split, "разрез с потерянным ответом на усечение");
  });

  it.fails("C26b: потерян ответ на PUT продолжения → ответ честный, 6 встреч без повторов записи", async () => {
    // AE18: потерянный ответ на создание продолжения выдавался за «новая часть
    // не создана — досоздайте вручную», и совет давал дубли.
    const { fake, ctx, path } = weeklyStand();
    const instanceStart = slot(await list(ctx), "2026-10-26").instanceStart;

    const fault = fake.loseResponse((r) => r.method === "PUT" && r.path !== path, 504);
    const mark = fake.mark();
    const split = await attempt(() =>
      update(ctx, { id: SERIES, scope: "this_and_following", instanceStart, patch: { location: "Переговорная 5" } }),
    );
    await expectVisible(ctx, fake, SPLIT_26);
    expect(fault.fired, "ответ на создание продолжения потерян ровно раз").toBe(1);
    expectNoRepeatedWrites(fake, mark);
    expectSuccess(split, "разрез с потерянным ответом на продолжение");
  });

  it.fails("C26c: потерян ответ на DELETE → «удалено», а не «код 404»; DELETE ровно один", async () => {
    // AD12: повтор DELETE получал 404 на собственное удаление и сообщал об ошибке.
    const { fake, ctx, path } = weeklyStand();
    const etag = slot(await list(ctx), "2026-10-19").etag;

    const fault = fake.loseResponse({ method: "DELETE" }, 503);
    const mark = fake.mark();
    const removed = await attempt(() => remove(ctx, { id: SERIES, scope: "all_series", etag }));
    await expectVisible(ctx, fake, []);
    expect(fake.has(path), "объект удалён").toBe(false);
    expect(fault.fired).toBe(1);
    expectNoRepeatedWrites(fake, mark);
    const result = expectSuccess(removed, "удаление с потерянным ответом") as { objectRemoved?: unknown };
    expect(result.objectRemoved, "ответ сообщает, что объект удалён").toBe(true);
  });

  it.fails("C26d: потерян ответ на PUT правки this → ответ честный, PUT ровно один", async () => {
    // AE7 (правка экземпляра): повтор с тем же If-Match давал 412 на свою же запись.
    const { fake, ctx } = weeklyStand();
    const instanceStart = slot(await list(ctx), "2026-10-21").instanceStart;

    const fault = fake.loseResponse({ method: "PUT" }, "timeout");
    const mark = fake.mark();
    const edited = await attempt(() =>
      update(ctx, { id: SERIES, scope: "this", instanceStart, patch: { summary: "Особая планёрка" } }),
    );
    await expectVisible(ctx, fake, [ALL_SIX[0], line("2026-10-21", { summary: "Особая планёрка" }), ...ALL_SIX.slice(2)]);
    expect(fault.fired).toBe(1);
    expectNoRepeatedWrites(fake, mark);
    expectSuccess(edited, "правка this с потерянным ответом");
  });

  it.fails("C26e: потерян ответ на PUT создания → ответ честный, один объект, PUT ровно один", async () => {
    // NEW-7: повтор создания после потерянного ответа — 412 «событие изменили»
    // (по RFC) или молчаливая перезапись (Яндекс, Ж13); ни то, ни другое не ответ.
    const { fake, ctx } = makeStand();

    const fault = fake.loseResponse({ method: "PUT" }, "network");
    const mark = fake.mark();
    const created = await attempt(() =>
      createEvent(ctx, {
        summary: "Созвон с подрядчиком",
        start: "2026-10-22T15:00:00+03:00",
        end: "2026-10-22T16:00:00+03:00",
        timeZone: "Europe/Moscow",
      }),
    );
    await expectVisible(ctx, fake, [line("2026-10-22", { time: "15:00–16:00", summary: "Созвон с подрядчиком" })]);
    expect(fake.objects.size, "на сервере ровно один объект").toBe(1);
    expect(fault.fired).toBe(1);
    expectNoRepeatedWrites(fake, mark);
    expectSuccess(created, "создание с потерянным ответом");
  });

  it.fails("C27a: list → внешняя правка → delete all_series с etag из выдачи: отказ, объект цел", async () => {
    // AD9: delete_event не принимал etag и стирал чужую свежую правку; If-Match
    // на DELETE Яндекс не соблюдает (Ж15) — сверять обязан сам код.
    const { fake, ctx, path } = weeklyStand();
    const etag = slot(await list(ctx), "2026-10-19").etag;

    fake.externalEdit(path, (ics) => ics.replace("SUMMARY:Планёрка", "SUMMARY:Планёрка — перенесена в Переговорную 5"));
    const edited = ["2026-10-19", "2026-10-21", "2026-10-26", "2026-10-28", "2026-11-02", "2026-11-04"].map((d) =>
      line(d, { summary: "Планёрка — перенесена в Переговорную 5" }),
    );
    const afterExternal = fake.ics(path);

    const mark = fake.mark();
    const removed = await attempt(() => remove(ctx, { id: SERIES, scope: "all_series", etag }));
    await expectVisible(ctx, fake, edited);
    expect(fake.ics(path), "чужая правка цела").toBe(afterExternal);
    expectNoWrites(fake, mark);
    expect(refusalCode(removed, "удаление по устаревшему etag"), "отказ с кодом").toEqual(expect.any(String));
  });

  it.fails("C27b: list → внешняя правка → delete this 21.10 с etag из выдачи: отказ, 21.10 на месте", async () => {
    // AD9 (delete this): прежний код перечитывал объект и писал EXDATE поверх чужой правки.
    const { fake, ctx, path } = weeklyStand();
    const target = slot(await list(ctx), "2026-10-21");

    fake.externalEdit(path, (ics) => ics.replace("SUMMARY:Планёрка", "SUMMARY:Планёрка (важно)"));
    const edited = ["2026-10-19", "2026-10-21", "2026-10-26", "2026-10-28", "2026-11-02", "2026-11-04"].map((d) =>
      line(d, { summary: "Планёрка (важно)" }),
    );
    const afterExternal = fake.ics(path);

    const mark = fake.mark();
    const removed = await attempt(() =>
      remove(ctx, { id: SERIES, scope: "this", instanceStart: target.instanceStart, etag: target.etag }),
    );
    await expectVisible(ctx, fake, edited);
    expect(fake.ics(path), "чужая правка цела").toBe(afterExternal);
    expectNoWrites(fake, mark);
    expect(refusalCode(removed, "удаление экземпляра по устаревшему etag"), "отказ с кодом").toEqual(expect.any(String));
  });

  it.fails("C29: перенос из окна наружу — 0; перенос раньше соседа — порядок по start; перенос в окно — 1, moved", async () => {
    // R8-F1, F3, F5..F7 (окно по фактическому времени, сортировка) закрыты
    // прежним кодом — эта часть цепочки охранная. Новое требование Р10: у
    // перенесённой встречи moved:true, у прочих его нет.
    const { fake, ctx } = weeklyStand();

    expectSuccess(
      await attempt(async () =>
        update(ctx, {
          id: SERIES,
          scope: "this",
          instanceStart: slot(await list(ctx), "2026-10-21").instanceStart,
          patch: { start: "2026-10-23T10:00:00+03:00", end: "2026-10-23T11:00:00+03:00" },
        }),
      ),
      "перенос 21.10 на 23.10",
    );
    expectSuccess(
      await attempt(async () =>
        update(ctx, {
          id: SERIES,
          scope: "this",
          instanceStart: slot(await list(ctx), "2026-10-28").instanceStart,
          patch: { start: "2026-10-25T10:00:00+03:00", end: "2026-10-25T11:00:00+03:00" },
        }),
      ),
      "перенос 28.10 на 25.10",
    );

    // Порядок — по фактическому началу, а не по слоту.
    await expectVisible(ctx, fake, [
      line("2026-10-19"),
      line("2026-10-23", { slot: "2026-10-21 10:00" }),
      line("2026-10-25", { slot: "2026-10-28 10:00" }),
      line("2026-10-26"),
      line("2026-11-02"),
      line("2026-11-04"),
    ]);
    // Окно слота 21.10: встреча оттуда перенесена наружу.
    await expectVisible(ctx, fake, [], { from: "2026-10-21T00:00:00+03:00", to: "2026-10-22T00:00:00+03:00" });
    // Окно 23.10: встреча перенесена сюда извне.
    const into = { from: "2026-10-23T00:00:00+03:00", to: "2026-10-24T00:00:00+03:00" };
    await expectVisible(ctx, fake, [line("2026-10-23", { slot: "2026-10-21 10:00" })], into);

    const moved = (await list(ctx)).map((e) => `${wallTime(e.start, DEFAULT_ZONE)} moved=${e.moved === true}`);
    expect(moved, "перенесённые помечены moved:true (Р10)").toEqual([
      "2026-10-19 10:00 moved=false",
      "2026-10-23 10:00 moved=true",
      "2026-10-25 10:00 moved=true",
      "2026-10-26 10:00 moved=false",
      "2026-11-02 10:00 moved=false",
      "2026-11-04 10:00 moved=false",
    ]);
    const [inWindow] = await list(ctx, into);
    expect(wallTime(inWindow.instanceStart!, DEFAULT_ZONE), "адрес перенесённой — её слот").toBe("2026-10-21 10:00");
  });

  it.fails("C59: {timeZone} при dropRequest → перечитывание, ровно одна повторная попытка, пояс сменён", async () => {
    // Р8, П (потерянная смена пояса): запись не дошла — ETag и смысл прежние,
    // допустим один повтор, но только после перечитывания, а не вслепую.
    const { fake, ctx, path } = weeklyStand();

    const fault = fake.dropRequest({ method: "PUT" }, 504);
    const mark = fake.mark();
    const changed = await attempt(() =>
      update(ctx, { id: SERIES, scope: "all_series", patch: { timeZone: "Asia/Yekaterinburg" } }),
    );
    // Моменты прежние (timeZone без start сохраняет моменты, О8): по Москве те же 10:00.
    await expectVisible(ctx, fake, ALL_SIX);
    await expectVisible(
      ctx,
      fake,
      ["2026-10-19", "2026-10-21", "2026-10-26", "2026-10-28", "2026-11-02", "2026-11-04"].map((d) =>
        line(d, { time: "12:00–13:00" }),
      ),
      { zone: "Asia/Yekaterinburg" },
    );
    expect(
      [...new Set((await list(ctx)).map((e) => e.timeZone))],
      "пояс серии сменён",
    ).toEqual(["Asia/Yekaterinburg"]);
    expect(masterLines(fake.ics(path))).toContain("DTSTART;TZID=Asia/Yekaterinburg:20261019T120000");
    expect(fault.fired).toBe(1);

    const log = fake.since(mark);
    const puts = log.flatMap((entry, i) => (entry.method === "PUT" ? [i] : []));
    expect(
      puts.map((i) => `${log[i].method} ${log[i].path} → ${log[i].status}`),
      "первая запись не дошла (504), повтор ровно один",
    ).toEqual([`PUT ${path} → 504`, `PUT ${path} → 204`]);
    expect(
      log.slice(puts[0] + 1, puts[1]).some((entry) => entry.method === "REPORT" || entry.method === "GET"),
      "перед повтором объект перечитан",
    ).toBe(true);
    expectSuccess(changed, "смена пояса после недошедшей записи");
  });
});
