// Цепочки разреза серии «эта и следующие» (З05b; §6 и §7 плана переделки,
// docs/superpowers/plans/2026-09-19-recurring-events-rework.md; сценарии
// C11–C14, C16 — из §6.2 проекта «сырое дерево», C28, C40, C41, C49, C51,
// C60 — из §6 итогового плана; поломки — из
// .superpowers/sdd/2026-09-18-yandex-calendar-mcp/wave-a-results.json).
//
// Цепочка — последовательность публичных вызовов домена (readEvents,
// updateEvent, deleteEvent) на изменяемом стенде tests/support: каждый шаг
// видит то, что записал предыдущий. instanceStart и etag берутся только из
// выдачи readEvents. После каждого шага проверяется точный список видимых
// встреч (observe.visible) и инварианты О12а у всех объектов стенда.
//
// Стенд по умолчанию ведёт себя как Яндекс (conditions "yandex"): If-None-Match
// не соблюдается (Ж13 в docs/yandex-caldav-capabilities.md), повторное
// создание продолжения не даёт 412, а молча перезаписывает. Поэтому цепочки
// C28, C40, C41 и C60 проверяют, что код узнаёт о существовании продолжения
// ЧТЕНИЕМ (поправка к Р9 по итогам живой сверки): иначе на повторе он
// перезаписал бы продолжение и потерял правки. Режим conditions "rfc" здесь
// не нужен ни одной цепочке.
//
// Все цепочки — it.fails: на прежней реализации каждая падает на утверждении
// о данных (видимый список, состояние сервера, ответ пользователю). Задача З13
// снимает .fails, когда цепочки станут зелёными.
import { describe, expect, it } from "vitest";
import { deleteEvent, readEvents, updateEvent } from "../../src/domain/events.js";
import type { CalendarEvent, Context, EditScope } from "../../src/types.js";
import { makeStand, plant } from "../support/context.js";
import type { FakeCaldav, FakeRequest } from "../support/fakeCaldav.js";
import { lineName, parseRawComponents, unfold, type RawComponent } from "../support/invariants.js";
import {
  assertPropsPreserved,
  assertStoredInvariants,
  DEFAULT_WINDOW,
  DEFAULT_ZONE,
  describeStand,
  expectNoWrites,
  visible,
  wallTime,
} from "../support/observe.js";
import { dailyBerlin, weeklyMoscow, type Seed } from "../support/seeds.js";

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

// Поля etag и confirm (Р11) и частичный patch.recurrence (Р4) — интерфейс
// новой реализации; прежняя сигнатура их не знает и просто не читает.
// Приведение типа нужно только затем, чтобы один и тот же файл шёл и на
// прежнем коде, и на новом.
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

/** Вызов, чей исход — значение: цепочка сама решает, что успех, а что отказ. */
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
function expectSuccess(outcome: Outcome, what: string): void {
  expect(outcome.ok ? "успех" : `отказ: ${messageOf(outcome.error)}`, what).toBe("успех");
}

interface Refusal {
  code: unknown;
  needsConfirm: unknown;
  message: string;
}

/** Шаг обязан закончиться отказом; отдаёт его поля (отказы различаются по code). */
function refusalOf(outcome: Outcome, what: string): Refusal {
  expect(outcome.ok ? "успех" : "отказ", what).toBe("отказ");
  const error = (outcome as { error: unknown }).error;
  const fields = (typeof error === "object" && error !== null ? error : {}) as Record<string, unknown>;
  return { code: fields.code, needsConfirm: fields.needsConfirm, message: messageOf(error) };
}

// ---------------------------------------------------------------------------
// Наблюдение
// ---------------------------------------------------------------------------

async function list(ctx: Context): Promise<CalendarEvent[]> {
  return readEvents(ctx, { from: DEFAULT_WINDOW.from, to: DEFAULT_WINDOW.to });
}

/**
 * Встреча по дате её слота (instanceStart) в поясе показа. id отличает
 * исходную серию от продолжения. Адрес берётся только из выдачи.
 */
function slot(events: CalendarEvent[], date: string, options: { id?: string; zone?: string } = {}): CalendarEvent {
  const zone = options.zone ?? DEFAULT_ZONE;
  const found = events.filter(
    (event) =>
      event.instanceStart !== undefined &&
      wallTime(event.instanceStart, zone).slice(0, 10) === date &&
      (options.id === undefined || event.id === options.id),
  );
  expect(
    found.map((event) => `${event.id} ${event.instanceStart}`),
    `в выдаче ровно одна встреча со слотом ${date}${options.id ? ` в ${options.id}` : ""}`,
  ).toHaveLength(1);
  return found[0];
}

/** Строка видимого списка в формате observe.formatEvent. */
function line(
  date: string,
  options: { time?: string; summary?: string; location?: string; slot?: string } = {},
): string {
  let text = `${date} ${options.time ?? "10:00–11:00"} ${options.summary ?? "Планёрка"}`;
  if (options.location) text += ` @${options.location}`;
  if (options.slot) text += ` [слот ${options.slot}]`;
  return text;
}

/**
 * Точный видимый список и инварианты всех объектов стенда. anyOrder — для
 * шагов, где у двух встреч одинаковое начало (хвост виден дважды): порядок
 * равных по времени выдача не обещает.
 */
async function expectVisible(
  ctx: Context,
  fake: FakeCaldav,
  expected: Array<string | ReturnType<typeof expect.stringMatching>>,
  options: { zone?: string; anyOrder?: boolean } = {},
): Promise<void> {
  const seen = await visible(ctx, { zone: options.zone });
  if (options.anyOrder) {
    expect([...seen].sort(), describeStand(fake)).toEqual([...(expected as string[])].sort());
  } else {
    expect(seen, describeStand(fake)).toEqual(expected);
  }
  assertStoredInvariants(fake);
}

/** Какой объект показывает какие встречи: строки вида "дата время #id". */
async function owners(ctx: Context, zone = DEFAULT_ZONE): Promise<string[]> {
  const events = await list(ctx);
  return events.map((event) => `${wallTime(event.start, zone)} #${event.id}`);
}

function uidOf(ics: string): string {
  return /^UID(?:;[^:\n]*)?:(.*)$/m.exec(unfold(ics))?.[1] ?? "";
}

/** Единственный объект на сервере, кроме исходного: продолжение разреза. */
function continuation(fake: FakeCaldav, originalPath: string): { path: string; uid: string; ics: string } {
  const others = [...fake.objects.entries()].filter(([path]) => path !== originalPath);
  expect(
    others.map(([path]) => path),
    `рядом с исходной серией на сервере ровно одно продолжение\n${describeStand(fake)}`,
  ).toHaveLength(1);
  const [path, object] = others[0];
  return { path, uid: uidOf(object.ics), ics: object.ics };
}

function isOverride(component: RawComponent): boolean {
  return component.name === "VEVENT" && component.lines.some((l) => lineName(l) === "RECURRENCE-ID");
}

/** Основной компонент и VTIMEZONE — всё, кроме переопределений. */
const masterAndZones = (component: RawComponent) => component.name !== "VEVENT" || !isOverride(component);

function masterOf(ics: string): RawComponent {
  const root = parseRawComponents(ics)[0];
  const masters = (root?.children ?? []).filter((c) => c.name === "VEVENT" && !isOverride(c));
  expect(masters, "в объекте ровно один основной компонент").toHaveLength(1);
  return masters[0];
}

/** Части RRULE основного компонента по смыслу: ключ в верхнем регистре → значение. */
function ruleParts(ics: string): Record<string, string> {
  const rule = masterOf(ics).lines.find((l) => lineName(l) === "RRULE");
  expect(rule, "у основного компонента есть RRULE").toBeDefined();
  const value = rule!.slice(rule!.indexOf(":") + 1);
  return Object.fromEntries(
    value.split(";").map((part) => {
      const [key, ...rest] = part.split("=");
      return [key.toUpperCase(), rest.join("=")];
    }),
  );
}

/** Части правила без конца серии: COUNT и UNTIL разрез меняет законно. */
function withoutEnd(parts: Record<string, string>): Record<string, string> {
  const { COUNT: _count, UNTIL: _until, ...rest } = parts;
  return rest;
}

/** Журнал запросов с телами: по нему видно, читал ли код продолжение до записи. */
function recordRequests(fake: FakeCaldav): FakeRequest[] {
  const seen: FakeRequest[] = [];
  fake.beforeRequest = (request) => {
    seen.push({ ...request });
  };
  return seen;
}

// ---------------------------------------------------------------------------
// Затравки цепочек (чужие объекты, как их хранит Яндекс)
// ---------------------------------------------------------------------------

const CRLF = "\r\n";

// VTIMEZONE Europe/Moscow в том виде, в каком его отдаёт Яндекс
// (tests/fixtures/events-query.xml, как в tests/support/seeds.ts).
const MOSCOW_TZ = [
  "BEGIN:VTIMEZONE",
  "TZID:Europe/Moscow",
  "LAST-MODIFIED:20240422T053451Z",
  "TZURL:https://www.tzurl.org/zoneinfo-outlook/Europe/Moscow",
  "X-LIC-LOCATION:Europe/Moscow",
  "BEGIN:STANDARD",
  "TZNAME:MSK",
  "TZOFFSETFROM:+0300",
  "TZOFFSETTO:+0300",
  "DTSTART:19700101T000000",
  "END:STANDARD",
  "END:VTIMEZONE",
];

function moscowSeries(uid: string, about: string, props: string[]): Seed {
  const lines = [
    "BEGIN:VCALENDAR",
    "PRODID:-//Yandex LLC//Yandex Calendar//EN",
    "VERSION:2.0",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    ...MOSCOW_TZ,
    "BEGIN:VEVENT",
    `UID:${uid}`,
    "DTSTAMP:20261001T090000Z",
    ...props,
    "SEQUENCE:0",
    "CREATED:20261001T090000Z",
    "LAST-MODIFIED:20261001T090000Z",
    "TRANSP:OPAQUE",
    "CLASS:PUBLIC",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return { uid, about, ics: lines.join(CRLF) + CRLF };
}

/** C16a (AE6): «последний рабочий день месяца» — 30.10, 30.11, 31.12. */
const lastWorkday = moscowSeries("c16setpos01@yandex.ru", "Последний рабочий день месяца 17:00, COUNT=3", [
  "DTSTART;TZID=Europe/Moscow:20261030T170000",
  "DTEND;TZID=Europe/Moscow:20261030T180000",
  "RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;COUNT=3",
  "SUMMARY:Итоги месяца",
]);

/** C16b (AE6): 1-е и 15-е числа — 01.10, 15.10, 01.11, 15.11, 01.12, 15.12. */
const firstAndFifteenth = moscowSeries("c16monthday1@yandex.ru", "1-е и 15-е числа 10:00, COUNT=6", [
  "DTSTART;TZID=Europe/Moscow:20261001T100000",
  "DTEND;TZID=Europe/Moscow:20261001T110000",
  "RRULE:FREQ=MONTHLY;BYMONTHDAY=1,15;COUNT=6",
  "SUMMARY:Сверка",
]);

/**
 * C16c (AE6): раз в две недели по вт и вс, неделя с воскресенья. С WKST=SU
 * слоты 20.10, 01.11, 03.11, 15.11, 17.11, 29.11, 01.12, 13.12; без WKST
 * (неделя с понедельника) хвост от 03.11 другой: 08.11, 22.11, 06.12 —
 * проверено итератором ical.js (lib/ical/recur_iterator.js).
 */
const biweeklySundayStart = moscowSeries("c16wkstsu001@yandex.ru", "Вт и Вс раз в две недели, WKST=SU, COUNT=8", [
  "DTSTART;TZID=Europe/Moscow:20261020T100000",
  "DTEND;TZID=Europe/Moscow:20261020T110000",
  "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,SU;WKST=SU;COUNT=8",
  "SUMMARY:Синхронизация",
]);

/**
 * C51 (Р9, T16): серия владельца с чужим участником. Новый UID продолжения
 * с прежними участниками может разослать письма — разрез требует confirm.
 */
const withGuest = moscowSeries("c51guest0001@yandex.ru", "Пн и Ср 10:00 с участником petrov@example.com, COUNT=6", [
  "DTSTART;TZID=Europe/Moscow:20261019T100000",
  "DTEND;TZID=Europe/Moscow:20261019T110000",
  "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6",
  "SUMMARY:Планёрка",
  "ORGANIZER:mailto:user@yandex.ru",
  "ATTENDEE;CN=Пётр Петров;PARTSTAT=ACCEPTED;ROLE=REQ-PARTICIPANT:mailto:petrov@example.com",
  "ATTENDEE;PARTSTAT=ACCEPTED;ROLE=CHAIR:mailto:user@yandex.ru",
]);

// ---------------------------------------------------------------------------
// Серия по умолчанию: Пн и Ср 10:00–11:00 МСК с 19.10.2026, COUNT=6
// (19, 21, 26, 28 окт., 2, 4 нояб.)
// ---------------------------------------------------------------------------

const SERIES = weeklyMoscow.uid;
const ALL_SIX = [
  line("2026-10-19"),
  line("2026-10-21"),
  line("2026-10-26"),
  line("2026-10-28"),
  line("2026-11-02"),
  line("2026-11-04"),
];

function weeklyStand() {
  const stand = makeStand();
  const path = plant(stand.fake, weeklyMoscow);
  return { ...stand, path };
}

describe("цепочки разреза серии «эта и следующие» (З05b)", () => {
  it.fails("C11: перенос 04.11 на 05.11 → t&f 26.10 {location}: 6 встреч, перенос в продолжении с новым местом", async () => {
    // R13-N5, AE10, R8-N1(D): переопределение после границы оставалось в
    // исходном объекте сиротой и задваивалось с продолжением.
    const { fake, ctx, path } = weeklyStand();
    const before = fake.ics(path);

    const moved = await attempt(async () =>
      update(ctx, {
        id: SERIES,
        scope: "this",
        instanceStart: slot(await list(ctx), "2026-11-04").instanceStart,
        patch: { start: "2026-11-05T10:00:00+03:00", end: "2026-11-05T11:00:00+03:00" },
      }),
    );
    await expectVisible(ctx, fake, [...ALL_SIX.slice(0, 5), line("2026-11-05", { slot: "2026-11-04 10:00" })]);
    expectSuccess(moved, "перенос 04.11 на 05.11");

    const split = await attempt(async () =>
      update(ctx, {
        id: SERIES,
        scope: "this_and_following",
        instanceStart: slot(await list(ctx), "2026-10-26").instanceStart,
        patch: { location: "Переговорная 5" },
      }),
    );
    await expectVisible(ctx, fake, [
      line("2026-10-19"),
      line("2026-10-21"),
      line("2026-10-26", { location: "Переговорная 5" }),
      line("2026-10-28", { location: "Переговорная 5" }),
      line("2026-11-02", { location: "Переговорная 5" }),
      line("2026-11-05", { location: "Переговорная 5", slot: "2026-11-04 10:00" }),
    ]);
    expectSuccess(split, "разрез 26.10");

    const tail = continuation(fake, path);
    expect(await owners(ctx)).toEqual([
      `2026-10-19 10:00 #${SERIES}`,
      `2026-10-21 10:00 #${SERIES}`,
      `2026-10-26 10:00 #${tail.uid}`,
      `2026-10-28 10:00 #${tail.uid}`,
      `2026-11-02 10:00 #${tail.uid}`,
      `2026-11-05 10:00 #${tail.uid}`,
    ]);
    // В исходном объекте переопределений не осталось: RID ≥ B ушли в продолжение.
    expect(parseRawComponents(fake.ics(path))[0].children.filter(isOverride)).toHaveLength(0);
    // Исходный основной компонент и VTIMEZONE тронуты только в конце правила.
    assertPropsPreserved(before, fake.ics(path), { scope: masterAndZones, except: ["RRULE"] });
    // Продолжение — клон основного (О6): всё, кроме времени, правила, UID и патча, прежнее.
    assertPropsPreserved(before, tail.ics, {
      scope: "master",
      except: ["UID", "DTSTART", "DTEND", "RRULE", "LOCATION", "CREATED", "SEQUENCE"],
    });
  });

  it.fails("C12: delete this 21.10 → all_series {location}: 21.10 не воскрес, EXDATE побайтово", async () => {
    // R13-N3, AE1, AD7: all_series пересобирал основной компонент из модели и терял EXDATE.
    const { fake, ctx, path } = weeklyStand();

    const target = slot(await list(ctx), "2026-10-21");
    const removed = await attempt(() =>
      remove(ctx, { id: SERIES, scope: "this", instanceStart: target.instanceStart, etag: target.etag }),
    );
    await expectVisible(ctx, fake, [ALL_SIX[0], ...ALL_SIX.slice(2)]);
    expectSuccess(removed, "delete this 21.10");
    expect(masterOf(fake.ics(path)).lines).toContain("EXDATE;TZID=Europe/Moscow:20261021T100000");
    const afterDelete = fake.ics(path);

    const renamed = await attempt(() =>
      update(ctx, { id: SERIES, scope: "all_series", patch: { location: "Переговорная 5" } }),
    );
    await expectVisible(ctx, fake, [
      line("2026-10-19", { location: "Переговорная 5" }),
      line("2026-10-26", { location: "Переговорная 5" }),
      line("2026-10-28", { location: "Переговорная 5" }),
      line("2026-11-02", { location: "Переговорная 5" }),
      line("2026-11-04", { location: "Переговорная 5" }),
    ]);
    expectSuccess(renamed, "all_series {location}");
    assertPropsPreserved(afterDelete, fake.ics(path), { scope: "master", only: ["EXDATE"], exact: true });
    assertPropsPreserved(afterDelete, fake.ics(path), { except: ["LOCATION"] });
  });

  it.fails("C13a: delete this 04.11 → t&f 26.10: 04.11 не воскрес в продолжении", async () => {
    // AE2, R13-N3 (S15): продолжение собиралось из модели без EXDATE.
    const { fake, ctx } = weeklyStand();

    const target = slot(await list(ctx), "2026-11-04");
    const removed = await attempt(() =>
      remove(ctx, { id: SERIES, scope: "this", instanceStart: target.instanceStart, etag: target.etag }),
    );
    await expectVisible(ctx, fake, ALL_SIX.slice(0, 5));
    expectSuccess(removed, "delete this 04.11");

    const split = await attempt(async () =>
      update(ctx, {
        id: SERIES,
        scope: "this_and_following",
        instanceStart: slot(await list(ctx), "2026-10-26").instanceStart,
        patch: { location: "Переговорная 5" },
      }),
    );
    await expectVisible(ctx, fake, [
      line("2026-10-19"),
      line("2026-10-21"),
      line("2026-10-26", { location: "Переговорная 5" }),
      line("2026-10-28", { location: "Переговорная 5" }),
      line("2026-11-02", { location: "Переговорная 5" }),
    ]);
    expectSuccess(split, "разрез 26.10");
  });

  it.fails("C13b: delete 21.10 и 04.11 → t&f 28.10: всего 4, лишней встречи 09.11 нет (S10)", async () => {
    // AD8: COUNT продолжения считался по видимым экземплярам, удалённые до
    // границы удлиняли серию, а удалённый после границы воскресал.
    const { fake, ctx } = weeklyStand();

    for (const date of ["2026-10-21", "2026-11-04"]) {
      const target = slot(await list(ctx), date);
      const removed = await attempt(() =>
        remove(ctx, { id: SERIES, scope: "this", instanceStart: target.instanceStart, etag: target.etag }),
      );
      expectSuccess(removed, `delete this ${date}`);
    }
    await expectVisible(ctx, fake, [line("2026-10-19"), line("2026-10-26"), line("2026-10-28"), line("2026-11-02")]);

    const split = await attempt(async () =>
      update(ctx, {
        id: SERIES,
        scope: "this_and_following",
        instanceStart: slot(await list(ctx), "2026-10-28").instanceStart,
        patch: { summary: "Планёрка (новый формат)" },
      }),
    );
    await expectVisible(ctx, fake, [
      line("2026-10-19"),
      line("2026-10-26"),
      line("2026-10-28", { summary: "Планёрка (новый формат)" }),
      line("2026-11-02", { summary: "Планёрка (новый формат)" }),
    ]);
    expectSuccess(split, "разрез 28.10");
  });

  it.fails("C14a: delete 21.10 → t&f 02.11: 5 встреч, COUNT по позициям правила", async () => {
    // AE3, R8-O3: остаток COUNT считался по видимым экземплярам — лишняя 09.11.
    const { fake, ctx } = weeklyStand();

    const target = slot(await list(ctx), "2026-10-21");
    expectSuccess(
      await attempt(() =>
        remove(ctx, { id: SERIES, scope: "this", instanceStart: target.instanceStart, etag: target.etag }),
      ),
      "delete this 21.10",
    );
    await expectVisible(ctx, fake, [ALL_SIX[0], ...ALL_SIX.slice(2)]);

    const split = await attempt(async () =>
      update(ctx, {
        id: SERIES,
        scope: "this_and_following",
        instanceStart: slot(await list(ctx), "2026-11-02").instanceStart,
        patch: { summary: "Итоговая" },
      }),
    );
    await expectVisible(ctx, fake, [
      line("2026-10-19"),
      line("2026-10-26"),
      line("2026-10-28"),
      line("2026-11-02", { summary: "Итоговая" }),
      line("2026-11-04", { summary: "Итоговая" }),
    ]);
    expectSuccess(split, "разрез 02.11");
  });

  it.fails("C14b: перенос 21.10 на 03.11 → t&f 02.11: 6 встреч, лишней 09.11 нет", async () => {
    // AE3: перенесённый через границу считался по фактическому времени — лишняя встреча.
    const { fake, ctx } = weeklyStand();

    expectSuccess(
      await attempt(async () =>
        update(ctx, {
          id: SERIES,
          scope: "this",
          instanceStart: slot(await list(ctx), "2026-10-21").instanceStart,
          patch: { start: "2026-11-03T10:00:00+03:00", end: "2026-11-03T11:00:00+03:00" },
        }),
      ),
      "перенос 21.10 на 03.11",
    );
    await expectVisible(ctx, fake, [
      line("2026-10-19"),
      line("2026-10-26"),
      line("2026-10-28"),
      line("2026-11-02"),
      line("2026-11-03", { slot: "2026-10-21 10:00" }),
      line("2026-11-04"),
    ]);

    const split = await attempt(async () =>
      update(ctx, {
        id: SERIES,
        scope: "this_and_following",
        instanceStart: slot(await list(ctx), "2026-11-02").instanceStart,
        patch: { summary: "Планёрка (хвост)" },
      }),
    );
    // Перенесённая встреча принадлежит стороне своего слота (21.10 < B) и
    // остаётся в исходном объекте; применится ли к ней патч — решение
    // планировщика (notice), поэтому её название здесь не проверяется.
    await expectVisible(ctx, fake, [
      line("2026-10-19"),
      line("2026-10-26"),
      line("2026-10-28"),
      line("2026-11-02", { summary: "Планёрка (хвост)" }),
      expect.stringMatching(/^2026-11-03 10:00–11:00 .+ \[слот 2026-10-21 10:00\]$/),
      line("2026-11-04", { summary: "Планёрка (хвост)" }),
    ]);
    expectSuccess(split, "разрез 02.11");
  });

  it.fails("C14c: перенос 28.10 на 25.10 → t&f 26.10: COUNT продолжения 4, 04.11 есть", async () => {
    // R8-N2: COUNT продолжения по фактическим началам — 3 вместо 4, 04.11 терялась.
    const { fake, ctx, path } = weeklyStand();

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
    await expectVisible(ctx, fake, [
      line("2026-10-19"),
      line("2026-10-21"),
      line("2026-10-25", { slot: "2026-10-28 10:00" }),
      line("2026-10-26"),
      line("2026-11-02"),
      line("2026-11-04"),
    ]);

    const split = await attempt(async () =>
      update(ctx, {
        id: SERIES,
        scope: "this_and_following",
        instanceStart: slot(await list(ctx), "2026-10-26").instanceStart,
        patch: { summary: "Планёрка (хвост)" },
      }),
    );
    // Слот 28.10 ≥ B: встреча уходит в продолжение, хотя стоит раньше границы;
    // её название — по правилу наследования, здесь не проверяется.
    await expectVisible(ctx, fake, [
      line("2026-10-19"),
      line("2026-10-21"),
      expect.stringMatching(/^2026-10-25 10:00–11:00 .+ \[слот 2026-10-28 10:00\]$/),
      line("2026-10-26", { summary: "Планёрка (хвост)" }),
      line("2026-11-02", { summary: "Планёрка (хвост)" }),
      line("2026-11-04", { summary: "Планёрка (хвост)" }),
    ]);
    expectSuccess(split, "разрез 26.10");
    expect(ruleParts(continuation(fake, path).ics).COUNT, "COUNT продолжения — 6 минус 2 позиции до 26.10").toBe("4");
  });

  it.fails("C14d: DAILY COUNT=10 Europe/Berlin: this 26.10, delete 27.10, t&f 29.10 → 9 встреч", async () => {
    // AE3 (Berlin): через переход CEST→CET 25.10 COUNT продолжения завышался — лишняя 31.10.
    const zone = "Europe/Berlin";
    const { fake, ctx } = makeStand();
    plant(fake, dailyBerlin);
    const day = (date: string, extra: { summary?: string; location?: string } = {}) =>
      line(date, { summary: extra.summary ?? "Стендап Берлин", location: extra.location });

    expectSuccess(
      await attempt(async () =>
        update(ctx, {
          id: dailyBerlin.uid,
          scope: "this",
          instanceStart: slot(await list(ctx), "2026-10-26", { zone }).instanceStart,
          patch: { summary: "Стендап (особый)" },
        }),
      ),
      "this 26.10",
    );
    const target = slot(await list(ctx), "2026-10-27", { zone });
    expectSuccess(
      await attempt(() =>
        remove(ctx, { id: dailyBerlin.uid, scope: "this", instanceStart: target.instanceStart, etag: target.etag }),
      ),
      "delete this 27.10",
    );
    const beforeSplit = [
      day("2026-10-21"),
      day("2026-10-22"),
      day("2026-10-23"),
      day("2026-10-24"),
      day("2026-10-25"),
      day("2026-10-26", { summary: "Стендап (особый)" }),
      day("2026-10-28"),
      day("2026-10-29"),
      day("2026-10-30"),
    ];
    await expectVisible(ctx, fake, beforeSplit, { zone });

    const split = await attempt(async () =>
      update(ctx, {
        id: dailyBerlin.uid,
        scope: "this_and_following",
        instanceStart: slot(await list(ctx), "2026-10-29", { zone }).instanceStart,
        patch: { location: "Зал 2" },
      }),
    );
    await expectVisible(
      ctx,
      fake,
      [...beforeSplit.slice(0, 7), day("2026-10-29", { location: "Зал 2" }), day("2026-10-30", { location: "Зал 2" })],
      { zone },
    );
    expectSuccess(split, "разрез 29.10");
  });

  it.fails("C16a: BYSETPOS=-1 → all_series rename: правило не искажено молча, 3 встречи", async () => {
    // AE6: пересборка из модели выбрасывала BYSETPOS — 30.10, 02.11, 03.11 вместо
    // последних рабочих дней. Отступление по Ж6: Яндекс BYSETPOS не хранит, и
    // поправка к Р4 велит такие правила при записи отклонять, — поэтому
    // допустим и чистый отказ без записей; недопустима только тихая порча.
    const { fake, ctx } = makeStand();
    const path = plant(fake, lastWorkday);
    const before = fake.ics(path);
    const unchanged = [
      line("2026-10-30", { time: "17:00–18:00", summary: "Итоги месяца" }),
      line("2026-11-30", { time: "17:00–18:00", summary: "Итоги месяца" }),
      line("2026-12-31", { time: "17:00–18:00", summary: "Итоги месяца" }),
    ];
    await expectVisible(ctx, fake, unchanged);

    const mark = fake.mark();
    const renamed = await attempt(() =>
      update(ctx, { id: lastWorkday.uid, scope: "all_series", patch: { summary: "Итоги месяца (новый формат)" } }),
    );
    if (renamed.ok) {
      await expectVisible(ctx, fake, [
        line("2026-10-30", { time: "17:00–18:00", summary: "Итоги месяца (новый формат)" }),
        line("2026-11-30", { time: "17:00–18:00", summary: "Итоги месяца (новый формат)" }),
        line("2026-12-31", { time: "17:00–18:00", summary: "Итоги месяца (новый формат)" }),
      ]);
      assertPropsPreserved(before, fake.ics(path), { scope: "master", only: ["RRULE"], exact: true });
    } else {
      await expectVisible(ctx, fake, unchanged);
      expectNoWrites(fake, mark);
      expect(refusalOf(renamed, "отказ правки BYSETPOS").code, "отказ с кодом").toEqual(expect.any(String));
    }
  });

  it.fails("C16b: BYMONTHDAY=1,15 → t&f 01.11: 15-е числа на месте", async () => {
    // AE6: продолжение из модели теряло BYMONTHDAY — 01.12, 01.01, 01.02 вместо 15-х.
    const { fake, ctx } = makeStand();
    const path = plant(fake, firstAndFifteenth);
    const day = (date: string, summary = "Сверка") => line(date, { summary });

    const split = await attempt(async () =>
      update(ctx, {
        id: firstAndFifteenth.uid,
        scope: "this_and_following",
        instanceStart: slot(await list(ctx), "2026-11-01").instanceStart,
        patch: { summary: "Сверка (новая)" },
      }),
    );
    await expectVisible(ctx, fake, [
      day("2026-10-01"),
      day("2026-10-15"),
      day("2026-11-01", "Сверка (новая)"),
      day("2026-11-15", "Сверка (новая)"),
      day("2026-12-01", "Сверка (новая)"),
      day("2026-12-15", "Сверка (новая)"),
    ]);
    expectSuccess(split, "разрез 01.11");
    const seedRule = withoutEnd(ruleParts(firstAndFifteenth.ics));
    expect(withoutEnd(ruleParts(fake.ics(path))), "правило исходной серии, кроме конца").toEqual(seedRule);
    expect(withoutEnd(ruleParts(continuation(fake, path).ics)), "правило продолжения, кроме конца").toEqual(seedRule);
  });

  it.fails("C16c: WEEKLY;INTERVAL=2;WKST=SU → t&f 03.11: хвост совпадает или чистый отказ", async () => {
    // AE6: продолжение из модели теряло WKST — хвост 08.11, 22.11, 06.12 вместо
    // 15.11, 29.11, 13.12. Отступление по Ж6: Яндекс WKST выбрасывает, поправка
    // к Р4 велит такие правила при записи отклонять — допустим и чистый отказ.
    const { fake, ctx } = makeStand();
    const path = plant(fake, biweeklySundayStart);
    const dates = ["2026-10-20", "2026-11-01", "2026-11-03", "2026-11-15", "2026-11-17", "2026-11-29", "2026-12-01", "2026-12-13"];
    const unchanged = dates.map((date) => line(date, { summary: "Синхронизация" }));
    await expectVisible(ctx, fake, unchanged);

    const mark = fake.mark();
    const split = await attempt(async () =>
      update(ctx, {
        id: biweeklySundayStart.uid,
        scope: "this_and_following",
        instanceStart: slot(await list(ctx), "2026-11-03").instanceStart,
        patch: { summary: "Синхронизация (хвост)" },
      }),
    );
    if (split.ok) {
      await expectVisible(
        ctx,
        fake,
        dates.map((date, i) => line(date, { summary: i < 2 ? "Синхронизация" : "Синхронизация (хвост)" })),
      );
      const seedRule = withoutEnd(ruleParts(biweeklySundayStart.ics));
      expect(withoutEnd(ruleParts(fake.ics(path))), "правило исходной серии, кроме конца").toEqual(seedRule);
      expect(withoutEnd(ruleParts(continuation(fake, path).ics)), "правило продолжения, кроме конца").toEqual(seedRule);
    } else {
      await expectVisible(ctx, fake, unchanged);
      expectNoWrites(fake, mark);
      expect(refusalOf(split, "отказ разреза с WKST").code, "отказ с кодом").toEqual(expect.any(String));
    }
  });

  it.fails("C28: 507 на втором PUT разреза → продолжение названо, повтор завершает: 6 встреч без дублей", async () => {
    // AE18, R13-N8: прежний порядок (усечение, потом продолжение) терял хвост,
    // а совет «повторите update_event» был невыполним.
    const { fake, ctx, path } = weeklyStand();
    const before = fake.ics(path);
    const instanceStart = slot(await list(ctx), "2026-10-26").instanceStart;
    const call = () =>
      update(ctx, { id: SERIES, scope: "this_and_following", instanceStart, patch: { location: "Переговорная 5" } });

    const requests = recordRequests(fake);
    // 507 — ответ 5xx, транспорт помечает его applied "unknown" (Р8): код
    // вправе перечитать объект и один раз повторить усечение. Поэтому сбой
    // держится до конца вызова, а не на одном запросе.
    const fault = fake.rejectBeforeApply({ method: "PUT" }, 507, { nth: 2, times: Number.POSITIVE_INFINITY });
    const first = await attempt(call);
    fault.disarm();
    // Сорвалась вторая запись: продолжение создано, исходная серия цела —
    // хвост виден дважды, ничего не потеряно.
    await expectVisible(
      ctx,
      fake,
      [
        ...ALL_SIX,
        line("2026-10-26", { location: "Переговорная 5" }),
        line("2026-10-28", { location: "Переговорная 5" }),
        line("2026-11-02", { location: "Переговорная 5" }),
        line("2026-11-04", { location: "Переговорная 5" }),
      ],
      { anyOrder: true },
    );
    expect(fake.ics(path), "исходная серия не тронута").toBe(before);
    const tail = continuation(fake, path);
    expect([1, 2], "усечение отклонено, повтор после перечитывания — не больше одного").toContain(fault.fired);
    expect(refusalOf(first, "вызов с сорванным усечением").message, "сообщение называет продолжение").toContain(tail.uid);
    // Существование продолжения узнаётся чтением до его создания (Ж13: 412 не будет).
    const created = requests.findIndex((r) => r.method === "PUT" && r.path === tail.path);
    expect(
      requests
        .slice(0, created)
        .some(
          (r) =>
            (r.method === "GET" && r.path === tail.path) ||
            (r.method === "REPORT" && (r.body.includes(tail.uid) || r.body.includes(tail.path))),
        ),
      "до PUT продолжения код прочитал, нет ли его уже на сервере",
    ).toBe(true);

    const mark = fake.mark();
    const retry = await attempt(call);
    await expectVisible(ctx, fake, [
      line("2026-10-19"),
      line("2026-10-21"),
      line("2026-10-26", { location: "Переговорная 5" }),
      line("2026-10-28", { location: "Переговорная 5" }),
      line("2026-11-02", { location: "Переговорная 5" }),
      line("2026-11-04", { location: "Переговорная 5" }),
    ]);
    expectSuccess(retry, "повтор того же вызова");
    expect(continuation(fake, path).uid, "продолжение то же").toBe(tail.uid);
    // Повтор дописывает только усечение: продолжение прочитано и совпало с планом.
    expect(fake.writesSince(mark).map((w) => `${w.method} ${w.path}`)).toEqual([`PUT ${path}`]);
  });

  for (const variant of ["rename", "delete"] as const) {
    it.fails(`C40 (${variant}): t&f 26.10, 507 на усечении → ${variant} 04.11 в исходной → повтор: split-stale-continuation`, async () => {
      // J-A2: повтор принимал существующее продолжение за своё и усекал
      // исходную серию — правка или удаление 04.11 в ней терялись.
      const { fake, ctx, path } = weeklyStand();
      const before = fake.ics(path);
      const instanceStart = slot(await list(ctx), "2026-10-26").instanceStart;
      const call = () =>
        update(ctx, { id: SERIES, scope: "this_and_following", instanceStart, patch: { location: "Переговорная 5" } });
      const tailLines = [
        line("2026-10-26", { location: "Переговорная 5" }),
        line("2026-10-28", { location: "Переговорная 5" }),
        line("2026-11-02", { location: "Переговорная 5" }),
        line("2026-11-04", { location: "Переговорная 5" }),
      ];

      // Сбой держится до конца вызова: 507 — 5xx, и один повтор после
      // перечитывания законен (Р8); см. C28.
      const fault = fake.rejectBeforeApply({ method: "PUT", path }, 507, { times: Number.POSITIVE_INFINITY });
      const first = await attempt(call);
      fault.disarm();
      await expectVisible(ctx, fake, [...ALL_SIX, ...tailLines], { anyOrder: true });
      expect(fake.ics(path), "исходная серия не тронута").toBe(before);
      const tail = continuation(fake, path);
      expect(refusalOf(first, "вызов с сорванным усечением").message).toContain(tail.uid);

      // Пользователь правит 04.11 в исходной серии, пока хвост виден дважды.
      const target = slot(await list(ctx), "2026-11-04", { id: SERIES });
      const edit = await attempt(() =>
        variant === "rename"
          ? update(ctx, { id: SERIES, scope: "this", instanceStart: target.instanceStart, patch: { summary: "Итоги" } })
          : remove(ctx, { id: SERIES, scope: "this", instanceStart: target.instanceStart, etag: target.etag }),
      );
      const afterEdit = [
        ...ALL_SIX.slice(0, 5),
        ...(variant === "rename" ? [line("2026-11-04", { summary: "Итоги" })] : []),
        ...tailLines,
      ];
      await expectVisible(ctx, fake, afterEdit, { anyOrder: true });
      expectSuccess(edit, `${variant} 04.11 в исходной серии`);
      const editedOriginal = fake.ics(path);
      const tailBefore = fake.ics(tail.path);

      const mark = fake.mark();
      const retry = await attempt(call);
      await expectVisible(ctx, fake, afterEdit, { anyOrder: true });
      expectNoWrites(fake, mark);
      expect(fake.ics(path), "правка 04.11 в исходной серии цела").toBe(editedOriginal);
      expect(fake.ics(tail.path), "устаревшее продолжение не перезаписано").toBe(tailBefore);
      expect(refusalOf(retry, "повтор при устаревшем продолжении").code).toBe("split-stale-continuation");
    });
  }

  it.fails("C41: t&f 26.10 → all_series until позже → t&f 26.10: отказ, ничего не записано", async () => {
    // J-A2: после продления усечённой серии повтор разреза в той же границе
    // находил старое продолжение и снимал из исходной то, чего в нём нет.
    const { fake, ctx, path } = weeklyStand();
    const instanceStart = slot(await list(ctx), "2026-10-26").instanceStart;
    const call = () => update(ctx, { id: SERIES, scope: "this_and_following", instanceStart, patch: { summary: "Хвост" } });

    expectSuccess(await attempt(call), "разрез 26.10");
    const tailLines = ["2026-10-26", "2026-10-28", "2026-11-02", "2026-11-04"].map((d) => line(d, { summary: "Хвост" }));
    await expectVisible(ctx, fake, [line("2026-10-19"), line("2026-10-21"), ...tailLines]);

    const extended = await attempt(() =>
      update(ctx, {
        id: SERIES,
        scope: "all_series",
        patch: { recurrence: { until: "2026-11-30T23:59:59+03:00", count: null } },
      }),
    );
    // Исходная серия снова идёт до 30.11 и перекрывает продолжение — так просил пользователь.
    const extendedOriginal = [
      "2026-10-19", "2026-10-21", "2026-10-26", "2026-10-28", "2026-11-02", "2026-11-04",
      "2026-11-09", "2026-11-11", "2026-11-16", "2026-11-18", "2026-11-23", "2026-11-25", "2026-11-30",
    ].map((d) => line(d));
    await expectVisible(ctx, fake, [...extendedOriginal, ...tailLines], { anyOrder: true });
    expectSuccess(extended, "all_series {until}");
    const tail = continuation(fake, path);
    const originalBefore = fake.ics(path);
    const tailBefore = tail.ics;

    const mark = fake.mark();
    const again = await attempt(call);
    await expectVisible(ctx, fake, [...extendedOriginal, ...tailLines], { anyOrder: true });
    expectNoWrites(fake, mark);
    expect(fake.ics(path)).toBe(originalBefore);
    expect(fake.ics(tail.path)).toBe(tailBefore);
    expect(refusalOf(again, "повторный разрез в той же границе").code).toBe("split-stale-continuation");
  });

  it.fails("C49: delete 04.11 → t&f 26.10 со сменой времени: 04.11 не воскрес", async () => {
    // Изъян B: EXDATE ≥ B копировались без сдвига и переставали совпадать со
    // слотами продолжения; у прежнего кода продолжение из модели их не знало вовсе.
    const { fake, ctx } = weeklyStand();

    const target = slot(await list(ctx), "2026-11-04");
    expectSuccess(
      await attempt(() =>
        remove(ctx, { id: SERIES, scope: "this", instanceStart: target.instanceStart, etag: target.etag }),
      ),
      "delete this 04.11",
    );
    await expectVisible(ctx, fake, ALL_SIX.slice(0, 5));

    const split = await attempt(async () =>
      update(ctx, {
        id: SERIES,
        scope: "this_and_following",
        instanceStart: slot(await list(ctx), "2026-10-26").instanceStart,
        patch: { start: "2026-10-26T12:00:00+03:00", end: "2026-10-26T13:00:00+03:00" },
      }),
    );
    await expectVisible(ctx, fake, [
      line("2026-10-19"),
      line("2026-10-21"),
      line("2026-10-26", { time: "12:00–13:00" }),
      line("2026-10-28", { time: "12:00–13:00" }),
      line("2026-11-02", { time: "12:00–13:00" }),
    ]);
    expectSuccess(split, "разрез 26.10 с 12:00");
  });

  it.fails("C51: разрез серии с чужим участником: needsConfirm без записей, с confirm — продолжение с участниками", async () => {
    // Р9, T16: новый UID продолжения с прежними ATTENDEE может разослать письма.
    const { fake, ctx } = makeStand();
    const path = plant(fake, withGuest);
    const before = fake.ics(path);
    const target = slot(await list(ctx), "2026-10-26");
    const args = {
      id: withGuest.uid,
      scope: "this_and_following" as const,
      instanceStart: target.instanceStart,
      patch: { location: "Переговорная 5" },
    };

    const mark = fake.mark();
    const unconfirmed = await attempt(() => update(ctx, args));
    await expectVisible(ctx, fake, ALL_SIX);
    expectNoWrites(fake, mark);
    expect(refusalOf(unconfirmed, "разрез без confirm").needsConfirm).toBe(true);

    const confirmed = await attempt(() => update(ctx, { ...args, confirm: true, etag: target.etag }));
    await expectVisible(ctx, fake, [
      line("2026-10-19"),
      line("2026-10-21"),
      line("2026-10-26", { location: "Переговорная 5" }),
      line("2026-10-28", { location: "Переговорная 5" }),
      line("2026-11-02", { location: "Переговорная 5" }),
      line("2026-11-04", { location: "Переговорная 5" }),
    ]);
    expectSuccess(confirmed, "разрез с confirm");
    assertPropsPreserved(before, continuation(fake, path).ics, { scope: "master", only: ["ORGANIZER", "ATTENDEE"] });
  });

  it.fails("C60a: t&f 26.10 {summary} → тот же t&f {location}: split-already-done с id продолжения", async () => {
    // П (повтор разреза), M25: «уже выполнено» без сверки патча молча
    // теряло новую правку; прежний код отвечал «экземпляра нет» без кода.
    const { fake, ctx, path } = weeklyStand();
    const instanceStart = slot(await list(ctx), "2026-10-26").instanceStart;

    expectSuccess(
      await attempt(() =>
        update(ctx, { id: SERIES, scope: "this_and_following", instanceStart, patch: { summary: "Хвост" } }),
      ),
      "разрез 26.10",
    );
    const afterSplit = [
      line("2026-10-19"),
      line("2026-10-21"),
      ...["2026-10-26", "2026-10-28", "2026-11-02", "2026-11-04"].map((d) => line(d, { summary: "Хвост" })),
    ];
    await expectVisible(ctx, fake, afterSplit);
    const tail = continuation(fake, path);

    const mark = fake.mark();
    const again = await attempt(() =>
      update(ctx, { id: SERIES, scope: "this_and_following", instanceStart, patch: { location: "Зал" } }),
    );
    await expectVisible(ctx, fake, afterSplit);
    expectNoWrites(fake, mark);
    const refusal = refusalOf(again, "повтор разреза с другим патчем");
    expect(refusal.code).toBe("split-already-done");
    expect(refusal.message, "отказ называет продолжение").toContain(tail.uid);
  });

  it.fails("C60b: t&f 26.10 {summary} → тот же t&f с тем же патчем: «уже выполнено», без записей", async () => {
    // Р9: повтор уже выполненного разреза с тем же патчем — успех без записей
    // (тот же патч на экземпляре B продолжения даёт пустой план).
    const { fake, ctx } = weeklyStand();
    const instanceStart = slot(await list(ctx), "2026-10-26").instanceStart;
    const call = () => update(ctx, { id: SERIES, scope: "this_and_following", instanceStart, patch: { summary: "Хвост" } });

    expectSuccess(await attempt(call), "разрез 26.10");
    const afterSplit = [
      line("2026-10-19"),
      line("2026-10-21"),
      ...["2026-10-26", "2026-10-28", "2026-11-02", "2026-11-04"].map((d) => line(d, { summary: "Хвост" })),
    ];
    await expectVisible(ctx, fake, afterSplit);

    const mark = fake.mark();
    const again = await attempt(call);
    await expectVisible(ctx, fake, afterSplit);
    expectNoWrites(fake, mark);
    expectSuccess(again, "повтор того же разреза");
  });
});
