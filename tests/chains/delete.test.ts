// Цепочки удаления повторяющихся встреч на изменяемом стенде — задача З05a
// плана переделки (docs/superpowers/plans/2026-09-19-recurring-events-rework.md,
// §6 и §7). Сценарии C01–C38 — из §6.2 проекта A
// (.superpowers/sdd/2026-09-18-yandex-calendar-mcp/wave-b/проект-сырое-дерево.recovered.md),
// C39–C63 — из §6 плана; поломки — из каталога
// .superpowers/sdd/2026-09-18-yandex-calendar-mcp/wave-a-results.json
// (AE — adversaryEdit, AD — adversaryDelete, R13 — review13, R8 — review8).
//
// Цепочка — последовательность публичных вызовов deleteEvent, updateEvent,
// readEvents на FakeCaldav из tests/support: что записал шаг, то следующий
// шаг читает с сервера. instanceStart и etag берутся только из выдачи
// readEvents (кроме цепочек, где адрес нарочно чужой: C18, C46). После
// каждого шага: точный видимый список, инварианты О12а всех объектов стенда
// (строгий стенд к тому же отвергает запись, добавляющую нарушение, кодом
// 400) и форма хранимого объекта. Отказы сверяются по `code` и обязаны
// ничего не записать.
//
// Цепочки помечены it.fails: на прежнем коде (dd99d80; домен
// src/domain/events.ts не менялся до З13) каждая падает на утверждении о
// порче данных — какое именно, записано в строке «Прежний код» у цепочки и
// в отчёте З05a (.superpowers/sdd/2026-09-18-yandex-calendar-mcp/rework-З05a-report.md).
// C57 на прежнем коде зелёная — она охранная (§6 плана), без .fails.
// Задача З13 снимает .fails, когда цепочки станут зелёными.
//
// Помощники повторяют помощники edit.test.ts: общий модуль в tests/chains
// не входит в файлы задачи, а импорт из тестового файла зарегистрировал бы
// его тесты второй раз.
import { describe, expect, it } from "vitest";
import { deleteEvent, readEvents, updateEvent } from "../../src/domain/events.js";
import type { CalendarEvent, EditScope } from "../../src/types.js";
import { makeStand, plant, type Stand } from "../support/context.js";
import { lineName, parseRawComponents, type RawComponent } from "../support/invariants.js";
import { assertStoredInvariants, DEFAULT_WINDOW, describeStand, formatEvent, visible, wallTime } from "../support/observe.js";
import { singleMoscow, weeklyMoscow, type Seed } from "../support/seeds.js";

// ---------------------------------------------------------------------------
// Стенд цепочки
// ---------------------------------------------------------------------------

const ZONE = "Europe/Moscow";

interface Chain extends Stand {
  path: string;
  uid: string;
}

function standWith(seed: Seed): Chain {
  const stand = makeStand();
  return { ...stand, path: plant(stand.fake, seed), uid: seed.uid };
}

// Параметры вызовов — в новом виде (§2 плана): etag обязателен у удаления
// (Р11), confirm. Приведение типа — чтобы файл одинаково запускался и на
// прежних, и на новых сигнатурах домена.
interface UpdateCall {
  scope?: EditScope;
  instanceStart?: string;
  patch: Record<string, unknown>;
  etag?: string;
  confirm?: boolean;
}

interface DeleteCall {
  scope?: EditScope;
  instanceStart?: string;
  etag?: string;
  confirm?: boolean;
}

/** Ответ удаления в новом виде (§2 плана): {deleted, scope, objectRemoved, removed, notices?}. */
interface DeleteResult {
  objectRemoved?: unknown;
  removed?: Array<{ instanceStart?: unknown; summary?: unknown }>;
}

function update(chain: Chain, call: UpdateCall): Promise<unknown> {
  return updateEvent(chain.ctx, { id: chain.uid, ...call } as unknown as Parameters<typeof updateEvent>[1]);
}

async function remove(chain: Chain, call: DeleteCall): Promise<DeleteResult> {
  return (await deleteEvent(chain.ctx, { id: chain.uid, ...call } as unknown as Parameters<typeof deleteEvent>[1])) as DeleteResult;
}

// ---------------------------------------------------------------------------
// Сообщения, шаги и проверки
// ---------------------------------------------------------------------------

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function writesAfter(chain: Chain, mark: number): string {
  return chain.fake
    .writes(mark)
    .map((w) => `${w.method} ${w.path} → ${w.status}${w.rejected ? ` (стенд отверг как порчу: ${w.rejected.join("; ")})` : ""}`)
    .join("; ");
}

function failure(chain: Chain, label: string, detail: string, mark?: number): Error {
  const rejected =
    mark === undefined
      ? []
      : chain.fake
          .since(mark)
          .filter((entry) => entry.rejected)
          .map((entry) => `${entry.method} ${entry.path}: ${entry.rejected!.join("; ")}`);
  const rejections = rejected.length ? `\nСтрогий стенд отверг запись как порчу данных (О12а):\n  ${rejected.join("\n  ")}` : "";
  return new Error(`${label}: ${detail}${rejections}\nСостояние стенда:\n${describeStand(chain.fake)}`);
}

/** Шаг цепочки, который обязан пройти. */
async function act<T>(chain: Chain, label: string, run: () => Promise<T>): Promise<T> {
  const mark = chain.fake.mark();
  try {
    return await run();
  } catch (error) {
    throw failure(chain, label, `вызов не удался: ${messageOf(error)}`, mark);
  }
}

interface Refusal {
  code?: unknown;
  needsConfirm?: unknown;
  losses?: Array<{ instanceStart?: unknown }>;
  hint?: unknown;
  message?: string;
}

type CodeCheck = readonly string[] | { test: (code: unknown) => boolean; what: string };

/** Шаг, который обязан кончиться отказом с кодом и ничего не записать. */
async function expectRefused(chain: Chain, label: string, run: () => Promise<unknown>, codes: CodeCheck): Promise<Refusal> {
  const mark = chain.fake.mark();
  const what = Array.isArray(codes) ? codes.join(" или ") : (codes as { what: string }).what;
  let error: unknown;
  let resolved = false;
  try {
    await run();
    resolved = true;
  } catch (caught) {
    error = caught;
  }
  const writes = writesAfter(chain, mark);
  if (resolved) {
    throw failure(chain, label, `ожидался отказ (${what}), а вызов прошёл${writes ? ` и записал: ${writes}` : ""}`, mark);
  }
  if (writes) {
    throw failure(chain, label, `отказ обязан ничего не писать, а в журнале: ${writes}; ошибка: ${messageOf(error)}`, mark);
  }
  const code = (error as Refusal | undefined)?.code;
  const ok = Array.isArray(codes) ? codes.includes(code as string) : (codes as { test: (c: unknown) => boolean }).test(code);
  if (!ok) {
    throw failure(chain, label, `ожидался отказ с кодом ${what}, а пришёл ${code === undefined ? "отказ без кода" : `код ${String(code)}`}: ${messageOf(error)}`, mark);
  }
  return error as Refusal;
}

async function expectVisible(chain: Chain, label: string, expected: string[], options: { unordered?: boolean; from?: string; to?: string } = {}): Promise<void> {
  const got = await visible(chain.ctx, { from: options.from, to: options.to });
  const [actual, wanted] = options.unordered ? [[...got].sort(), [...expected].sort()] : [got, expected];
  expect(actual, `${label}: видимый список readEvents не совпал\n${describeStand(chain.fake)}`).toEqual(wanted);
}

function expectInvariants(chain: Chain, label: string): void {
  try {
    assertStoredInvariants(chain.fake);
  } catch (error) {
    throw new Error(`${label}: ${messageOf(error)}`);
  }
}

function expectAlive(chain: Chain, label: string, alive: boolean): void {
  expect(
    chain.fake.has(chain.path),
    `${label}: объект серии ${alive ? "обязан остаться на сервере" : "обязан быть удалён с сервера"}\n${describeStand(chain.fake)}`,
  ).toBe(alive);
}

function slotOf(event: CalendarEvent): string {
  const address = event.instanceStart ?? event.start;
  return event.allDay ? address.slice(0, 10) : wallTime(address, ZONE);
}

/** Встреча серии по её слоту — ровно одна, из настоящей выдачи readEvents. */
async function occurrence(chain: Chain, slot: string): Promise<CalendarEvent> {
  const list = await readEvents(chain.ctx, DEFAULT_WINDOW);
  const hits = list.filter((event) => (event.id === chain.uid || event.seriesId === chain.uid) && slotOf(event) === slot);
  if (hits.length !== 1) {
    throw new Error(
      `в выдаче readEvents ${hits.length} встреч со слотом ${slot} (нужна ровно одна):\n${list.map((e) => formatEvent(e)).join("\n")}`,
    );
  }
  return hits[0];
}

/** ETag объекта из выдачи readEvents (у любой его встречи). */
async function etagSeen(chain: Chain): Promise<string | undefined> {
  const list = await readEvents(chain.ctx, DEFAULT_WINDOW);
  return list.find((event) => event.id === chain.uid || event.seriesId === chain.uid)?.etag;
}

// ---------------------------------------------------------------------------
// Разбор хранимого текста (независимо от src/)
// ---------------------------------------------------------------------------

interface Stored {
  masters: RawComponent[];
  overrides: RawComponent[];
}

function stored(chain: Chain): Stored {
  const root = parseRawComponents(chain.fake.ics(chain.path))[0];
  const events = root.children.filter((child) => child.name === "VEVENT");
  const has = (component: RawComponent, name: string) => component.lines.some((line) => lineName(line) === name);
  return {
    masters: events.filter((event) => !has(event, "RECURRENCE-ID")),
    overrides: events.filter((event) => has(event, "RECURRENCE-ID")),
  };
}

function timesOf(component: RawComponent, name: string): string[] {
  return component.lines
    .filter((line) => lineName(line) === name)
    .flatMap((line) => {
      const colon = line.indexOf(":");
      const tzid = /;TZID=([^;]+)/i.exec(line.slice(0, colon))?.[1];
      return line
        .slice(colon + 1)
        .split(",")
        .map((value) => (tzid ? `${tzid} ${value}` : value));
    });
}

function ruleOf(master: RawComponent): Record<string, string> {
  const rule = master.lines.find((line) => lineName(line) === "RRULE");
  if (!rule) return {};
  return Object.fromEntries(
    rule
      .slice(rule.indexOf(":") + 1)
      .split(";")
      .map((part) => part.split("=") as [string, string]),
  );
}

/** Один основной компонент; переопределения и EXDATE — ровно такие. */
function expectShape(chain: Chain, label: string, shape: { rids: string[]; exdates: string[] }): Stored {
  const now = stored(chain);
  const context = `\n${describeStand(chain.fake)}`;
  expect(now.masters.length, `${label}: основных компонентов (VEVENT без RECURRENCE-ID)${context}`).toBe(1);
  expect(now.overrides.flatMap((o) => timesOf(o, "RECURRENCE-ID")).sort(), `${label}: RECURRENCE-ID переопределений${context}`).toEqual(
    [...shape.rids].sort(),
  );
  expect(timesOf(now.masters[0], "EXDATE").sort(), `${label}: EXDATE основного компонента${context}`).toEqual([...shape.exdates].sort());
  return now;
}

// ---------------------------------------------------------------------------
// Затравки чужих объектов (текст целиком здесь, чтобы не зависеть от правок seeds.ts)
// ---------------------------------------------------------------------------

const CRLF = "\r\n";
const MOSCOW_TZ = [
  "BEGIN:VTIMEZONE",
  "TZID:Europe/Moscow",
  "BEGIN:STANDARD",
  "TZNAME:MSK",
  "TZOFFSETFROM:+0300",
  "TZOFFSETTO:+0300",
  "DTSTART:19700101T000000",
  "END:STANDARD",
  "END:VTIMEZONE",
];
const YANDEX_TAIL = ["SEQUENCE:0", "CREATED:20261001T090000Z", "LAST-MODIFIED:20261001T090000Z", "TRANSP:OPAQUE", "CLASS:PUBLIC"];

function seedOf(uid: string, about: string, ...events: string[][]): Seed {
  const lines = [
    "BEGIN:VCALENDAR",
    "PRODID:-//Yandex LLC//Yandex Calendar//EN",
    "VERSION:2.0",
    "CALSCALE:GREGORIAN",
    ...MOSCOW_TZ,
    ...events.flatMap((event) => ["BEGIN:VEVENT", `UID:${uid}`, "DTSTAMP:20261001T090000Z", ...event, "END:VEVENT"]),
    "END:VCALENDAR",
  ];
  return { uid, about, ics: lines.join(CRLF) + CRLF };
}

const moscow = (wall: string) => `TZID=Europe/Moscow:${wall}`;

const masterLines = (rule: string, start = "20261019T100000", end = "20261019T110000") => [
  `DTSTART;${moscow(start)}`,
  `DTEND;${moscow(end)}`,
  `RRULE:${rule}`,
  "SUMMARY:Планёрка",
  ...YANDEX_TAIL,
];

/** C21: Пн и Ср 10:00 МСК, COUNT=2 — 19 и 21 октября. */
const twoMeetings = seedOf("c21count2mw@yandex.ru", "Пн и Ср 10:00–11:00 МСК с 19.10.2026, COUNT=2", masterLines("FREQ=WEEKLY;BYDAY=MO,WE;COUNT=2"));

/** C42 (а): COUNT=2 и настоящее отдельное переопределение (RID вторник 20.10 — мимо позиций, внутри серии). */
const withDetached = seedOf(
  "c42detached1@yandex.ru",
  "Пн и Ср 10:00 МСК, COUNT=2; отдельная встреча с RECURRENCE-ID 20.10 10:00 (Р5.5, detached)",
  masterLines("FREQ=WEEKLY;BYDAY=MO,WE;COUNT=2"),
  [
    `RECURRENCE-ID;${moscow("20261020T100000")}`,
    `DTSTART;${moscow("20261020T140000")}`,
    `DTEND;${moscow("20261020T150000")}`,
    "SUMMARY:Разбор инцидента",
    ...YANDEX_TAIL,
  ],
);

/** C42 (б): COUNT=2 и скрытое переопределение за концом серии (RID 26.10, Р5.2, след R8-N1). */
const withHidden = seedOf(
  "c42hidden001@yandex.ru",
  "Пн и Ср 10:00 МСК, COUNT=2; переопределение 26.10 за концом серии (Р5.2, hidden)",
  masterLines("FREQ=WEEKLY;BYDAY=MO,WE;COUNT=2"),
  [
    `RECURRENCE-ID;${moscow("20261026T100000")}`,
    `DTSTART;${moscow("20261026T100000")}`,
    `DTEND;${moscow("20261026T110000")}`,
    "SUMMARY:Старый хвост",
    ...YANDEX_TAIL,
  ],
);

/** C57: раз в два года 19.10 10:00 МСК — шаг между встречами больше 400 дней. */
const everyTwoYears = seedOf("c57yearly2x@yandex.ru", "Раз в два года 19.10 10:00–11:00 МСК, без конца", masterLines("FREQ=YEARLY;INTERVAL=2"));

/** C57: ежегодно 29.02 10:00 МСК с 2028 года. */
const leapDay = seedOf(
  "c57leapday29@yandex.ru",
  "Ежегодно 29.02 10:00–11:00 МСК с 29.02.2028, без конца",
  masterLines("FREQ=YEARLY", "20280229T100000", "20280229T110000"),
);

// ---------------------------------------------------------------------------
// Ожидаемые строки
// ---------------------------------------------------------------------------

const DATES = ["2026-10-19", "2026-10-21", "2026-10-26", "2026-10-28", "2026-11-02", "2026-11-04"];

/** Строки серии по умолчанию в формате visible(); replace заменяет строку даты (null — даты нет). */
function rows(text: string, replace: Record<string, string | null> = {}, time = "10:00–11:00", dates = DATES): string[] {
  return dates.flatMap((date) => (date in replace ? (replace[date] === null ? [] : [replace[date] as string]) : [`${date} ${time} ${text}`]));
}

const MOVED_21 = "2026-10-21 11:30–12:30 Планёрка [слот 2026-10-21 10:00]";

async function move21(chain: Chain, label: string): Promise<void> {
  const slot21 = await occurrence(chain, "2026-10-21 10:00");
  await act(chain, `${label} (перенос 21.10 на 11:30)`, () =>
    update(chain, {
      scope: "this",
      instanceStart: slot21.instanceStart,
      patch: { start: "2026-10-21T11:30:00+03:00", end: "2026-10-21T12:30:00+03:00" },
    }),
  );
  await expectVisible(chain, label, rows("Планёрка", { "2026-10-21": MOVED_21 }));
}

// ---------------------------------------------------------------------------
// Цепочки
// ---------------------------------------------------------------------------

describe("Цепочки удаления (З05a)", () => {
  // Поломки: AD3, AE12, R13-N4 — перенесённую нельзя удалить по
  // instanceStart из выдачи; по фактическому времени delete ставит EXDATE
  // «в пустоту» и рапортует успех (AD5).
  // Прежний код: падает на (а) шаге 2 — отказ «не совпадает ни с одним экземпляром».
  it.fails("C07: перенос 21.10 → удаление по слоту; отдельно — по фактическому времени (actual-start)", async () => {
    // (а) По слоту из выдачи.
    const bySlot = standWith(weeklyMoscow);
    await move21(bySlot, "C07 (а) шаг 1");
    const moved = await occurrence(bySlot, "2026-10-21 10:00");
    await act(bySlot, "C07 (а) шаг 2 (удаление перенесённой по её instanceStart)", () =>
      remove(bySlot, { scope: "this", instanceStart: moved.instanceStart, etag: moved.etag }),
    );
    await expectVisible(bySlot, "C07 (а) шаг 2", rows("Планёрка", { "2026-10-21": null }));
    expectInvariants(bySlot, "C07 (а) шаг 2");
    expectAlive(bySlot, "C07 (а) шаг 2", true);
    expectShape(bySlot, "C07 (а) шаг 2", { rids: [], exdates: ["Europe/Moscow 20261021T100000"] });

    // (б) По фактическому времени — отказ с подсказкой адреса.
    const byStart = standWith(weeklyMoscow);
    await move21(byStart, "C07 (б) шаг 1");
    const shown = await occurrence(byStart, "2026-10-21 10:00");
    const refusal = await expectRefused(
      byStart,
      "C07 (б) шаг 2 (удаление по фактическому времени 11:30)",
      () => remove(byStart, { scope: "this", instanceStart: shown.start, etag: shown.etag }),
      ["actual-start"],
    );
    expect(
      `${String(refusal.hint ?? "")} ${refusal.message ?? ""}`,
      "C07 (б) шаг 2: подсказка называет адрес перенесённой встречи (её слот)",
    ).toContain("2026-10-21T10:00");
    await expectVisible(byStart, "C07 (б) шаг 2", rows("Планёрка", { "2026-10-21": MOVED_21 }));
  });

  // Поломка: AD3 — перенос на время другого экземпляра: EXDATE гасит не ту встречу.
  // Прежний код: падает на шаге 2 — вместо отказа ambiguous удалена обычная 28.10.
  it.fails("C08: перенос 26.10 на 28.10 10:00 → удаление 28.10 — ambiguous; с confirm — обычная 28.10; по слоту 26.10 — перенесённая", async () => {
    const chain = standWith(weeklyMoscow);
    const moved = "2026-10-28 10:00–11:00 Планёрка [слот 2026-10-26 10:00]";

    const slot26 = await occurrence(chain, "2026-10-26 10:00");
    await act(chain, "C08 шаг 1 (перенос 26.10 на 28.10 10:00)", () =>
      update(chain, {
        scope: "this",
        instanceStart: slot26.instanceStart,
        patch: { start: "2026-10-28T10:00:00+03:00", end: "2026-10-28T11:00:00+03:00" },
      }),
    );
    await expectVisible(chain, "C08 шаг 1", [...rows("Планёрка", { "2026-10-26": null }), moved], { unordered: true });

    const slot28 = await occurrence(chain, "2026-10-28 10:00");
    await expectRefused(
      chain,
      "C08 шаг 2 (удаление по адресу 28.10 10:00 без confirm)",
      () => remove(chain, { scope: "this", instanceStart: slot28.instanceStart, etag: slot28.etag }),
      ["ambiguous"],
    );
    await expectVisible(chain, "C08 шаг 2", [...rows("Планёрка", { "2026-10-26": null }), moved], { unordered: true });

    await act(chain, "C08 шаг 3 (то же с confirm)", () =>
      remove(chain, { scope: "this", instanceStart: slot28.instanceStart, etag: slot28.etag, confirm: true }),
    );
    await expectVisible(chain, "C08 шаг 3", rows("Планёрка", { "2026-10-26": null, "2026-10-28": moved }));
    expectInvariants(chain, "C08 шаг 3");
    expectShape(chain, "C08 шаг 3", { rids: ["Europe/Moscow 20261026T100000"], exdates: ["Europe/Moscow 20261028T100000"] });

    const movedNow = await occurrence(chain, "2026-10-26 10:00");
    await act(chain, "C08 шаг 4 (удаление перенесённой по слоту 26.10)", () =>
      remove(chain, { scope: "this", instanceStart: movedNow.instanceStart, etag: movedNow.etag }),
    );
    await expectVisible(chain, "C08 шаг 4", rows("Планёрка", { "2026-10-26": null, "2026-10-28": null }));
    expectInvariants(chain, "C08 шаг 4");
    expectAlive(chain, "C08 шаг 4", true);
    expectShape(chain, "C08 шаг 4", { rids: [], exdates: ["Europe/Moscow 20261026T100000", "Europe/Moscow 20261028T100000"] });
  });

  // Поломки: AE13, AD5 — delete this не снимает переопределение: встреча
  // остаётся, повтор копит дубли EXDATE.
  // Прежний код: падает на шаге 2 — «Особая» 21.10 по-прежнему в выдаче.
  it.fails("C09: имя 21.10 → удаление 21.10 дважды — встречи нет, EXDATE один, второй вызов ничего не пишет", async () => {
    const chain = standWith(weeklyMoscow);

    const slot21 = await occurrence(chain, "2026-10-21 10:00");
    await act(chain, "C09 шаг 1 (21.10: имя)", () =>
      update(chain, { scope: "this", instanceStart: slot21.instanceStart, patch: { summary: "Особая" } }),
    );
    await expectVisible(chain, "C09 шаг 1", rows("Планёрка", { "2026-10-21": "2026-10-21 10:00–11:00 Особая" }));

    const renamed = await occurrence(chain, "2026-10-21 10:00");
    const mark = chain.fake.mark();
    await act(chain, "C09 шаг 2 (удаление 21.10)", () =>
      remove(chain, { scope: "this", instanceStart: renamed.instanceStart, etag: renamed.etag }),
    );
    await expectVisible(chain, "C09 шаг 2", rows("Планёрка", { "2026-10-21": null }));
    expectInvariants(chain, "C09 шаг 2");
    expectShape(chain, "C09 шаг 2", { rids: [], exdates: ["Europe/Moscow 20261021T100000"] });
    expect(chain.fake.writes(mark).length, `C09 шаг 2: запись ровно одна: ${writesAfter(chain, mark)}`).toBe(1);

    // Повтор: «уже удалено» — либо без ошибки, либо отказ excluded; записей нет.
    const again = chain.fake.mark();
    const before = chain.fake.ics(chain.path);
    let refusal: unknown;
    try {
      await remove(chain, { scope: "this", instanceStart: renamed.instanceStart, etag: await etagSeen(chain) });
    } catch (error) {
      refusal = error;
    }
    if (refusal !== undefined && (refusal as Refusal).code !== "excluded") {
      throw failure(chain, "C09 шаг 3 (повторное удаление 21.10)", `ожидалось «уже удалено» или отказ excluded, а пришло: ${messageOf(refusal)}`, again);
    }
    expect(writesAfter(chain, again), "C09 шаг 3: повтор ничего не пишет").toBe("");
    expect(chain.fake.ics(chain.path), "C09 шаг 3: объект не тронут").toBe(before);
    await expectVisible(chain, "C09 шаг 3", rows("Планёрка", { "2026-10-21": null }));
  });

  // Поломки: AD6, AE10, R13-O1 — усечение оставляет переопределения после
  // границы: «удалённая» встреча продолжает показываться.
  // Прежний код: падает на шаге 2 — строгий стенд отвергает PUT (orphan-override).
  it.fails("C10: имя 04.11 → удаление хвоста с 28.10 — 3 встречи, переопределения нет, COUNT=3", async () => {
    const chain = standWith(weeklyMoscow);

    const slot04 = await occurrence(chain, "2026-11-04 10:00");
    await act(chain, "C10 шаг 1 (04.11: имя)", () =>
      update(chain, { scope: "this", instanceStart: slot04.instanceStart, patch: { summary: "Итоговая" } }),
    );
    await expectVisible(chain, "C10 шаг 1", rows("Планёрка", { "2026-11-04": "2026-11-04 10:00–11:00 Итоговая" }));

    const slot28 = await occurrence(chain, "2026-10-28 10:00");
    await act(chain, "C10 шаг 2 (удаление хвоста с 28.10)", () =>
      remove(chain, { scope: "this_and_following", instanceStart: slot28.instanceStart, etag: slot28.etag }),
    );
    await expectVisible(chain, "C10 шаг 2", rows("Планёрка", { "2026-10-28": null, "2026-11-02": null, "2026-11-04": null }));
    expectInvariants(chain, "C10 шаг 2");
    expectAlive(chain, "C10 шаг 2", true);
    const after = expectShape(chain, "C10 шаг 2", { rids: [], exdates: [] });
    const rule = ruleOf(after.masters[0]);
    expect({ COUNT: rule.COUNT, UNTIL: rule.UNTIL }, "C10 шаг 2: COUNT по позициям до границы, без UNTIL").toEqual({ COUNT: "3", UNTIL: undefined });
  });

  // Поломка: AD2 — явный scope this у одиночного события с чужим
  // instanceStart удалял весь объект без отказа.
  // Прежний код: падает на шаге 1 — вместо отказа DELETE всего объекта.
  it.fails("C18: одиночное событие — delete и update this с чужим instanceStart: отказ, объект цел", async () => {
    const chain = standWith(singleMoscow);
    const initial = chain.fake.ics(chain.path);
    const foreign = "2026-10-27T15:00:00+03:00";
    const etag = await etagSeen(chain);

    await expectRefused(
      chain,
      "C18 шаг 1 (delete this с instanceStart 27.10 15:00)",
      () => remove(chain, { scope: "this", instanceStart: foreign, etag }),
      ["mismatch", "not-found"],
    );
    expectAlive(chain, "C18 шаг 1", true);

    await expectRefused(
      chain,
      "C18 шаг 2 (update this с instanceStart 27.10 15:00)",
      () => update(chain, { scope: "this", instanceStart: foreign, patch: { summary: "Чужой экземпляр" } }),
      ["mismatch", "not-found"],
    );
    expect(chain.fake.ics(chain.path), "C18 шаг 2: объект не тронут").toBe(initial);
    await expectVisible(chain, "C18 шаг 2", ["2026-10-20 15:00–16:00 Обед с командой"]);
  });

  // Поломки: AE15, AD10 — this_and_following с первой встречи ставил UNTIL
  // раньше DTSTART и заводил вторую серию или оставлял объект-зомби.
  // Прежний код: падает на (а) шаге 1 — строгий стенд отвергает PUT (until-before-dtstart).
  it.fails("C20: this_and_following с первой встречи: правка — та же серия и UID; удаление — объект удалён", async () => {
    // (а) Правка.
    const edited = standWith(weeklyMoscow);
    const first = await occurrence(edited, "2026-10-19 10:00");
    await act(edited, "C20 (а) шаг 1 (правка с 19.10 и далее)", () =>
      update(edited, { scope: "this_and_following", instanceStart: first.instanceStart, patch: { summary: "Новая планёрка" } }),
    );
    await expectVisible(edited, "C20 (а) шаг 1", rows("Новая планёрка"));
    expectInvariants(edited, "C20 (а) шаг 1");
    expect([...edited.fake.objects.keys()], "C20 (а) шаг 1: объект один — прежний, второй серии нет").toEqual([edited.path]);
    const after = expectShape(edited, "C20 (а) шаг 1", { rids: [], exdates: [] });
    expect(ruleOf(after.masters[0]), "C20 (а) шаг 1: правило прежнее").toMatchObject({ FREQ: "WEEKLY", BYDAY: "MO,WE", COUNT: "6" });

    // (б) Удаление.
    const removed = standWith(weeklyMoscow);
    const head = await occurrence(removed, "2026-10-19 10:00");
    await act(removed, "C20 (б) шаг 1 (удаление с 19.10 и далее)", () =>
      remove(removed, { scope: "this_and_following", instanceStart: head.instanceStart, etag: head.etag }),
    );
    expectAlive(removed, "C20 (б) шаг 1", false);
    await expectVisible(removed, "C20 (б) шаг 1", []);
  });

  // Поломки: AD10, S4 — удаление через this всех встреч оставляло пустой объект-зомби.
  // Прежний код: падает на шаге 2 — объект остался на сервере.
  it.fails("C21: COUNT=2 — удаление обеих встреч по одной удаляет объект", async () => {
    const chain = standWith(twoMeetings);

    const slot19 = await occurrence(chain, "2026-10-19 10:00");
    await act(chain, "C21 шаг 1 (удаление 19.10)", () => remove(chain, { scope: "this", instanceStart: slot19.instanceStart, etag: slot19.etag }));
    await expectVisible(chain, "C21 шаг 1", ["2026-10-21 10:00–11:00 Планёрка"]);
    expectInvariants(chain, "C21 шаг 1");
    expectAlive(chain, "C21 шаг 1", true);

    const slot21 = await occurrence(chain, "2026-10-21 10:00");
    const result = await act(chain, "C21 шаг 2 (удаление 21.10)", () =>
      remove(chain, { scope: "this", instanceStart: slot21.instanceStart, etag: slot21.etag }),
    );
    expectAlive(chain, "C21 шаг 2", false);
    expect(result.objectRemoved, "C21 шаг 2: ответ сообщает, что объект удалён").toBe(true);
    await expectVisible(chain, "C21 шаг 2", []);
  });

  // Поломки: AD10, R8-N1 — (а) отдельная (detached) встреча держит объект
  // живым; (б) скрытое переопределение за концом серии — след прошлых
  // удалений: не показывается и не держит объект, уходит в removed.
  // Прежний код: (а) проходит; падает на (б) шаге 0 — скрытая сирота 26.10
  // видна в выдаче (R8-N1).
  it.fails("C42: удаление всех слотов при detached — объект жив; при скрытом переопределении — DELETE, скрытое в removed", async () => {
    // (а) Отдельная встреча.
    const detached = standWith(withDetached);
    const separate = "2026-10-20 14:00–15:00 Разбор инцидента [слот 2026-10-20 10:00]";
    await expectVisible(detached, "C42 (а) шаг 0", ["2026-10-19 10:00–11:00 Планёрка", separate, "2026-10-21 10:00–11:00 Планёрка"]);
    for (const [step, slot] of [
      [1, "2026-10-19 10:00"],
      [2, "2026-10-21 10:00"],
    ] as const) {
      const target = await occurrence(detached, slot);
      await act(detached, `C42 (а) шаг ${step} (удаление ${slot})`, () =>
        remove(detached, { scope: "this", instanceStart: target.instanceStart, etag: target.etag }),
      );
      expectInvariants(detached, `C42 (а) шаг ${step}`);
    }
    expectAlive(detached, "C42 (а) шаг 2", true);
    await expectVisible(detached, "C42 (а) шаг 2", [separate]);

    // (б) Скрытое переопределение.
    const hidden = standWith(withHidden);
    await expectVisible(hidden, "C42 (б) шаг 0", ["2026-10-19 10:00–11:00 Планёрка", "2026-10-21 10:00–11:00 Планёрка"]);
    const slot19 = await occurrence(hidden, "2026-10-19 10:00");
    await act(hidden, "C42 (б) шаг 1 (удаление 19.10)", () => remove(hidden, { scope: "this", instanceStart: slot19.instanceStart, etag: slot19.etag }));
    expectAlive(hidden, "C42 (б) шаг 1", true);
    await expectVisible(hidden, "C42 (б) шаг 1", ["2026-10-21 10:00–11:00 Планёрка"]);
    const slot21 = await occurrence(hidden, "2026-10-21 10:00");
    const result = await act(hidden, "C42 (б) шаг 2 (удаление 21.10)", () =>
      remove(hidden, { scope: "this", instanceStart: slot21.instanceStart, etag: slot21.etag }),
    );
    expectAlive(hidden, "C42 (б) шаг 2", false);
    expect(
      (result.removed ?? []).some((loss) => String(loss.instanceStart ?? "").startsWith("2026-10-26")),
      `C42 (б) шаг 2: скрытое переопределение 26.10 названо в removed: ${JSON.stringify(result.removed)}`,
    ).toBe(true);
    await expectVisible(hidden, "C42 (б) шаг 2", []);
  });

  // Поломки: AD2, AD9 — delete all_series не проверял переданный
  // instanceStart: адрес, не указывающий ни на одну встречу, удалял серию.
  // Прежний код: падает на шаге 1 — вместо отказа DELETE всего объекта.
  it.fails("C46: удаление всей серии с неразрешимым instanceStart — отказ, объект цел", async () => {
    const chain = standWith(weeklyMoscow);
    const initial = chain.fake.ics(chain.path);
    const etag = await etagSeen(chain);

    await expectRefused(
      chain,
      "C46 шаг 1 (all_series с instanceStart вторника 20.10 10:00)",
      () => remove(chain, { scope: "all_series", instanceStart: "2026-10-20T10:00:00+03:00", etag }),
      ["not-found", "mismatch"],
    );
    expectAlive(chain, "C46 шаг 1", true);
    expect(chain.fake.ics(chain.path), "C46 шаг 1: объект не тронут").toBe(initial);
    await expectVisible(chain, "C46 шаг 1", rows("Планёрка"));
  });

  // Поломки: AD6, AE10, J-B2 — удаление хвоста снимает встречу, перенесённую
  // раньше границы: это потеря сверх названного, нужен confirm.
  // Прежний код: падает на шаге 2 — вместо отказа PUT, отвергнутый строгим
  // стендом (orphan-override).
  it.fails("C50: перенос 04.11 на 27.10 → удаление хвоста с 28.10 — needsConfirm; с confirm — 3 встречи, COUNT=3", async () => {
    const chain = standWith(weeklyMoscow);

    const slot04 = await occurrence(chain, "2026-11-04 10:00");
    await act(chain, "C50 шаг 1 (перенос 04.11 на 27.10)", () =>
      update(chain, {
        scope: "this",
        instanceStart: slot04.instanceStart,
        patch: { start: "2026-10-27T10:00:00+03:00", end: "2026-10-27T11:00:00+03:00" },
      }),
    );
    const early = "2026-10-27 10:00–11:00 Планёрка [слот 2026-11-04 10:00]";
    await expectVisible(chain, "C50 шаг 1", [
      "2026-10-19 10:00–11:00 Планёрка",
      "2026-10-21 10:00–11:00 Планёрка",
      "2026-10-26 10:00–11:00 Планёрка",
      early,
      "2026-10-28 10:00–11:00 Планёрка",
      "2026-11-02 10:00–11:00 Планёрка",
    ]);

    const slot28 = await occurrence(chain, "2026-10-28 10:00");
    const refusal = await expectRefused(
      chain,
      "C50 шаг 2 (удаление хвоста с 28.10 без confirm)",
      () => remove(chain, { scope: "this_and_following", instanceStart: slot28.instanceStart, etag: slot28.etag }),
      { test: () => true, what: "с needsConfirm" },
    );
    expect(refusal.needsConfirm, `C50 шаг 2: отказ обязан просить confirm: ${refusal.message}`).toBe(true);
    expect(
      (refusal.losses ?? []).map((loss) => String(loss.instanceStart ?? "")).some((address) => address.startsWith("2026-11-04")),
      `C50 шаг 2: в перечне потерь — встреча слота 04.11, перенесённая на 27.10: ${JSON.stringify(refusal.losses)}`,
    ).toBe(true);

    await act(chain, "C50 шаг 3 (то же с confirm)", () =>
      remove(chain, { scope: "this_and_following", instanceStart: slot28.instanceStart, etag: slot28.etag, confirm: true }),
    );
    await expectVisible(chain, "C50 шаг 3", rows("Планёрка", { "2026-10-28": null, "2026-11-02": null, "2026-11-04": null }));
    expectInvariants(chain, "C50 шаг 3");
    const after = expectShape(chain, "C50 шаг 3", { rids: [], exdates: [] });
    expect(ruleOf(after.masters[0]).COUNT, "C50 шаг 3: COUNT по позициям до границы").toBe("3");
  });

  // Поломка: AD9 — удаление не принимало etag вызывающего: чужая правка
  // между list_events и delete_event стиралась молча.
  // Прежний код: падает на шаге 1 — вместо отказа PUT с EXDATE поверх чужой правки.
  it.fails("C52: удаление и правка с устаревшим etag — отказ, чужая правка цела", async () => {
    const chain = standWith(weeklyMoscow);

    const seen = await occurrence(chain, "2026-10-21 10:00");
    chain.fake.externalEdit(chain.path, (ics) => ics.split("SUMMARY:Планёрка").join("SUMMARY:Планёрка — перенесена в переговорную 5"));
    const external = chain.fake.ics(chain.path);
    const staleCode = { test: (code: unknown) => typeof code === "string", what: "отказа по устаревшему etag" };

    await expectRefused(
      chain,
      "C52 шаг 1 (delete this 21.10 с etag до чужой правки)",
      () => remove(chain, { scope: "this", instanceStart: seen.instanceStart, etag: seen.etag }),
      staleCode,
    );
    await expectRefused(
      chain,
      "C52 шаг 2 (update this 21.10 с etag до чужой правки)",
      () => update(chain, { scope: "this", instanceStart: seen.instanceStart, patch: { summary: "Особая" }, etag: seen.etag }),
      staleCode,
    );
    expect(chain.fake.ics(chain.path), "C52 шаг 2: чужая правка цела").toBe(external);
    await expectVisible(chain, "C52 шаг 2", rows("Планёрка — перенесена в переговорную 5"));
  });

  // Охранная (без .fails, §6 плана): прежний код серию при delete this не
  // удалял вовсе, поэтому здесь зелёный. Цепочка ловит мутант M22 новой
  // реализации — `isEmpty` по горизонту: у серии с шагом больше горизонта
  // (раз в два года; 29.02) после удаления ближайшей встречи в горизонте
  // слотов нет, но объект пуст не бывает (Р3).
  it("C57: YEARLY;INTERVAL=2 и YEARLY 29.02 — удаление ближайшей встречи оставляет объект", async () => {
    const twoYears = standWith(everyTwoYears);
    await expectVisible(twoYears, "C57 (а) шаг 0", ["2026-10-19 10:00–11:00 Планёрка", "2028-10-19 10:00–11:00 Планёрка"]);
    const nearest = await occurrence(twoYears, "2026-10-19 10:00");
    await act(twoYears, "C57 (а) шаг 1 (удаление 19.10.2026)", () =>
      remove(twoYears, { scope: "this", instanceStart: nearest.instanceStart, etag: nearest.etag }),
    );
    expectAlive(twoYears, "C57 (а) шаг 1", true);
    expectInvariants(twoYears, "C57 (а) шаг 1");
    await expectVisible(twoYears, "C57 (а) шаг 1", ["2028-10-19 10:00–11:00 Планёрка"]);

    // Окно — до 2029 года: где ical.js ставит следующую встречу 29.02
    // невисокосного года, здесь не проверяется (это вопрос З06).
    const leap = standWith(leapDay);
    const window = { from: "2026-01-01T00:00:00Z", to: "2029-01-01T00:00:00Z" };
    await expectVisible(leap, "C57 (б) шаг 0", ["2028-02-29 10:00–11:00 Планёрка"], window);
    const day = await occurrence(leap, "2028-02-29 10:00");
    await act(leap, "C57 (б) шаг 1 (удаление 29.02.2028)", () => remove(leap, { scope: "this", instanceStart: day.instanceStart, etag: day.etag }));
    expectAlive(leap, "C57 (б) шаг 1", true);
    expectInvariants(leap, "C57 (б) шаг 1");
    await expectVisible(leap, "C57 (б) шаг 1", [], window);
  });
});
