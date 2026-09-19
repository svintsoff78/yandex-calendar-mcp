// Цепочки З05c: объекты других клиентов и следы прежнего кода (§6 плана
// переделки, docs/superpowers/plans/2026-09-19-recurring-events-rework.md;
// сценарии — .superpowers/sdd/2026-09-18-yandex-calendar-mcp/wave-b/
// проект-сырое-дерево.recovered.md §6.2 и каталог поломок wave-a-results.json).
//
// Цепочка — ПОСЛЕДОВАТЕЛЬНОСТЬ публичных вызовов на изменяемом стенде: что
// записал предыдущий шаг, то читает следующий. Чужие объекты кладутся
// затравкой дословно (seedRaw), всё остальное получается настоящими вызовами.
// instanceStart и etag берутся только из выдачи readEvents или readEvent,
// отказы сверяются по `code`, а не по тексту.
//
// После каждого шага сверяются: точный видимый список (visible), инварианты
// О12а у всех объектов стенда (assertStoredInvariants), сохранность того,
// что шаг не называл (assertPropsPreserved), и число записей в журнале.
//
// Порядок проверок внутри шага: сначала данные (видимый список, журнал,
// хранимый текст), затем исход вызова. Поэтому на прежнем коде цепочка
// падает на утверждении о данных, даже если вызов бросил исключение.
//
// На текущем коде все цепочки красные — `it.fails`; снимает `.fails`
// задача З13. Первое упавшее утверждение каждой цепочки — в отчёте З05c
// (.superpowers/sdd/2026-09-18-yandex-calendar-mcp/rework-З05c-report.md).
//
// Цепочек C55 (эхо) и C56 (stale-shift) здесь нет: по поправке плана «без
// ремонта следов прежнего кода» роли echo и stale-shift и ремонт
// legacy-override исключены. Переопределение получает одну из трёх ролей —
// slot, hidden, detached. Цепочки «наследие» (C34) остались: они проверяют
// роль hidden, ключ О3 и аномалию multiple-masters, а такие объекты
// оставляют и другие клиенты. Цепочка C64 (сверх перечня плана) держит
// случай, который путала удалённая эвристика: RECURRENCE-ID в дату слота, но
// не в его время, — это detached, и в этот день видны две встречи.
import ICAL from "ical.js";
import { assert, describe, expect, it } from "vitest";
import { deleteEvent, readEvent, readEvents, updateEvent } from "../../src/domain/events.js";
import { findFreeSlots } from "../../src/domain/freeSlots.js";
import type { CalendarEvent, Context } from "../../src/types.js";
import { calendarA, makeStand, plant } from "../support/context.js";
import type { FakeCaldav } from "../support/fakeCaldav.js";
import { lineName, parseRawComponents, type RawComponent } from "../support/invariants.js";
import {
  assertPropsPreserved,
  assertStoredInvariants,
  DEFAULT_WINDOW,
  DEFAULT_ZONE,
  describeStand,
  expectNoWrites,
  formatEvent,
  lastPutBody,
  visible,
  wallTime,
} from "../support/observe.js";
import * as seeds from "../support/seeds.js";
import type { Seed } from "../support/seeds.js";

// ---------------------------------------------------------------------------
// Вызовы: параметры нового интерфейса (etag, confirm, частичный recurrence,
// участники без status) передаются как есть; прежний код их не знает.
// ---------------------------------------------------------------------------

type EditScope = "this" | "this_and_following" | "all_series";

interface UpdateArgs {
  id: string;
  scope?: EditScope;
  instanceStart?: string;
  patch: Record<string, unknown>;
  etag?: string;
  confirm?: boolean;
}

interface DeleteArgs {
  id: string;
  scope?: EditScope;
  instanceStart?: string;
  etag?: string;
  confirm?: boolean;
}

const update = (ctx: Context, args: UpdateArgs) => updateEvent(ctx, args as unknown as Parameters<typeof updateEvent>[1]);
const remove = (ctx: Context, args: DeleteArgs) => deleteEvent(ctx, args as unknown as Parameters<typeof deleteEvent>[1]);

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

/** Исход вызова без исключения: проверки данных идут раньше проверки исхода. */
async function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, error };
  }
}

function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const code = (error as { code?: unknown }).code;
  return `${error.name}${code === undefined ? "" : ` [${String(code)}]`}: ${error.message}`;
}

/** Вызов обязан был пройти. */
function done<T>(outcome: Settled<T>, fake: FakeCaldav): T {
  if (!outcome.ok) {
    assert.fail(
      `вызов отказал: ${errorText(outcome.error)}\nотказы стенда: ${JSON.stringify(fake.rejections)}\n${describeStand(fake)}`,
    );
  }
  return outcome.value;
}

/** Вызов обязан был отказать; возвращает ошибку для сверки `code`. */
function refusal(outcome: Settled<unknown>): Record<string, unknown> {
  if (outcome.ok) assert.fail(`ожидался отказ, а вызов прошёл: ${JSON.stringify(outcome.value)}`);
  return outcome.error as Record<string, unknown>;
}

/** Методы записей в журнале после отметки. */
function writes(fake: FakeCaldav, mark: number): string[] {
  return fake.writesSince(mark).map((entry) => entry.method);
}

// ---------------------------------------------------------------------------
// Выдача
// ---------------------------------------------------------------------------

const ZONE = DEFAULT_ZONE;

async function listAll(ctx: Context): Promise<CalendarEvent[]> {
  return readEvents(ctx, { from: DEFAULT_WINDOW.from, to: DEFAULT_WINDOW.to });
}

/** Слот экземпляра, как его показывает visible: стенное время или дата. */
function slotLabel(event: CalendarEvent, zone = ZONE): string {
  const address = event.instanceStart ?? event.start;
  return event.allDay ? address.slice(0, 10) : wallTime(address, zone);
}

/** Ровно один экземпляр серии uid со слотом label — из настоящей выдачи. */
async function instance(ctx: Context, uid: string, label: string, zone = ZONE): Promise<CalendarEvent> {
  const events = await listAll(ctx);
  const found = events.filter((event) => event.id === uid && slotLabel(event, zone) === label);
  expect(
    found.length,
    `в выдаче ровно один экземпляр ${uid} со слотом ${label}:\n${events.map((e) => formatEvent(e, { zone })).join("\n")}`,
  ).toBe(1);
  return found[0];
}

/** Строки видимого списка серии по дням: "2026-10-19 10:00–11:00 Планёрка". */
function lines(days: string[], time: string, summary: string): string[] {
  return days.map((day) => `${day} ${time} ${summary}`);
}

const SERIES_DAYS = ["2026-10-19", "2026-10-21", "2026-10-26", "2026-10-28", "2026-11-02", "2026-11-04"];

// ---------------------------------------------------------------------------
// Хранимый текст
// ---------------------------------------------------------------------------

function vevents(ics: string): RawComponent[] {
  const root = parseRawComponents(ics)[0];
  return root ? root.children.filter((component) => component.name === "VEVENT") : [];
}

function isOverride(component: RawComponent): boolean {
  return component.lines.some((line) => lineName(line) === "RECURRENCE-ID");
}

function mastersOf(ics: string): RawComponent[] {
  return vevents(ics).filter((component) => !isOverride(component));
}

function masterOf(ics: string): RawComponent {
  const masters = mastersOf(ics);
  expect(masters.length, `в объекте ровно один основной компонент:\n${ics}`).toBe(1);
  return masters[0];
}

function overridesOf(ics: string): RawComponent[] {
  return vevents(ics).filter(isOverride);
}

function linesOf(component: RawComponent, name: string): string[] {
  return component.lines.filter((line) => lineName(line) === name.toUpperCase());
}

// Индекс первого двоеточия вне кавычек: граница имени с параметрами и значения.
function valueColon(line: string): number {
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] === '"') quoted = !quoted;
    if (line[i] === ":" && !quoted) return i;
  }
  return -1;
}

/**
 * Значения времени свойства по одному, с параметрами: "TZID=Europe/Moscow:20261021T100000",
 * "VALUE=DATE:20261026", "20261021T000000Z". Список через запятую раскрывается,
 * параметры — в верхнем регистре имени и по алфавиту: так не важно, одним
 * свойством код пишет EXDATE или несколькими.
 */
function timeValues(component: RawComponent, name: string): string[] {
  const out: string[] = [];
  for (const line of linesOf(component, name)) {
    const colon = valueColon(line);
    const params = line
      .slice(0, colon)
      .split(";")
      .slice(1)
      .map((param) => {
        const eq = param.indexOf("=");
        return `${param.slice(0, eq).toUpperCase()}=${param.slice(eq + 1).replace(/^"(.*)"$/, "$1")}`;
      })
      .sort()
      .join(";");
    for (const value of line.slice(colon + 1).split(",")) out.push(params ? `${params}:${value}` : value);
  }
  return out.sort();
}

/** Части RRULE словарём: {FREQ: "WEEKLY", COUNT: "6", …}. */
function ruleOf(component: RawComponent): Record<string, string> {
  const rules = linesOf(component, "RRULE");
  expect(rules.length, `ровно одно RRULE: ${rules.join(" | ")}`).toBe(1);
  const value = rules[0].slice(valueColon(rules[0]) + 1);
  return Object.fromEntries(
    value.split(";").map((part) => {
      const [key, ...rest] = part.split("=");
      return [key.toUpperCase(), rest.join("=")];
    }),
  );
}

/** Предикат для assertPropsPreserved: все компоненты, кроме переопределения с этим RID. */
function exceptOverride(ridValue: string) {
  return (component: RawComponent) =>
    !(isOverride(component) && linesOf(component, "RECURRENCE-ID").some((line) => line.endsWith(`:${ridValue}`)));
}

// ---------------------------------------------------------------------------
// Затравки других клиентов, собранные из публичных затравок стенда
// ---------------------------------------------------------------------------

const CRLF = "\r\n";
const text = (...rows: string[]) => rows.join(CRLF) + CRLF;

/** Строки VTIMEZONE пояса tzid из текста затравки. */
function zoneLines(ics: string, tzid: string): string[] {
  const rows = ics.split(/\r?\n/);
  const start = rows.findIndex((row, i) => row === "BEGIN:VTIMEZONE" && rows[i + 1] === `TZID:${tzid}`);
  if (start < 0) throw new Error(`затравка без VTIMEZONE ${tzid}`);
  const end = rows.indexOf("END:VTIMEZONE", start);
  return rows.slice(start, end + 1);
}

const MOSCOW_ZONE = zoneLines(seeds.weeklyMoscow.ics, "Europe/Moscow");
const BERLIN_ZONE = zoneLines(seeds.dailyBerlin.ics, "Europe/Berlin");

/** Текст затравки с компонентами, вставленными перед END:VCALENDAR. */
function withComponents(ics: string, ...rows: string[]): string {
  const at = ics.lastIndexOf("END:VCALENDAR");
  return ics.slice(0, at) + rows.join(CRLF) + CRLF + ics.slice(at);
}

/** Текст затравки со строками, вставленными после первой строки, начинающейся с prefix. */
function withLinesAfter(ics: string, prefix: string, ...rows: string[]): string {
  const at = ics.indexOf(`${CRLF}${prefix}`);
  if (at < 0) throw new Error(`в затравке нет строки ${prefix}`);
  const end = ics.indexOf(CRLF, at + CRLF.length);
  return ics.slice(0, end + CRLF.length) + rows.join(CRLF) + CRLF + ics.slice(end + CRLF.length);
}

const W = seeds.weeklyMoscow.uid;

/** Переопределение серии weeklyMoscow. */
function override(rid: string, ...rows: string[]): string[] {
  return ["BEGIN:VEVENT", `UID:${W}`, "DTSTAMP:20261001T090000Z", rid, ...rows, "END:VEVENT"];
}

const seed = (uid: string, about: string, ics: string): Seed => ({ uid, about, ics });

/** AE4, AD1: переопределение стоит раньше основного компонента, VTIMEZONE — в конце. */
const overrideFirst = seed(
  "c04rid1st@example.com",
  "Пн и Ср 10:00 МСК с 19.10.2026, COUNT=6; перенос 21.10 на 11:30 стоит первым VEVENT",
  text(
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Example Corp.//Other Client//EN",
    "BEGIN:VEVENT",
    "UID:c04rid1st@example.com",
    "DTSTAMP:20261001T090000Z",
    "RECURRENCE-ID;TZID=Europe/Moscow:20261021T100000",
    "DTSTART;TZID=Europe/Moscow:20261021T113000",
    "DTEND;TZID=Europe/Moscow:20261021T123000",
    "SUMMARY:Планёрка",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:c04rid1st@example.com",
    "DTSTAMP:20261001T090000Z",
    "DTSTART;TZID=Europe/Moscow:20261019T100000",
    "DTEND;TZID=Europe/Moscow:20261019T110000",
    "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6",
    "SUMMARY:Планёрка",
    "END:VEVENT",
    ...MOSCOW_ZONE,
    "END:VCALENDAR",
  ),
);

/** AE5, AD2: HOURLY, частота вне модели. Встречи 10:00, 12:00, 14:00, 16:00 по 15 минут. */
const hourly = seed(
  "hourly-sensors@example.com",
  "FREQ=HOURLY;INTERVAL=2;COUNT=4 с 19.10.2026 10:00 МСК, по 15 минут",
  text(
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Example Corp.//Sensors//EN",
    ...MOSCOW_ZONE,
    "BEGIN:VEVENT",
    "UID:hourly-sensors@example.com",
    "DTSTAMP:20261001T090000Z",
    "DTSTART;TZID=Europe/Moscow:20261019T100000",
    "DTEND;TZID=Europe/Moscow:20261019T101500",
    "RRULE:FREQ=HOURLY;INTERVAL=2;COUNT=4",
    "SUMMARY:Проверка датчиков",
    "END:VEVENT",
    "END:VCALENDAR",
  ),
);

/** AE5, AE20, AD2: серия только из RDATE; DTSTART — тоже встреча (О2). */
const rdateOnly = seed(
  "rdate-only@example.com",
  "DTSTART 19.10.2026 10:00 МСК и RDATE 22.10, 27.10 — три встречи",
  text(
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Example Corp.//Other Client//EN",
    ...MOSCOW_ZONE,
    "BEGIN:VEVENT",
    "UID:rdate-only@example.com",
    "DTSTAMP:20261001T090000Z",
    "DTSTART;TZID=Europe/Moscow:20261019T100000",
    "DTEND;TZID=Europe/Moscow:20261019T110000",
    "RDATE;TZID=Europe/Moscow:20261022T100000,20261027T100000",
    "SUMMARY:Встречи по датам",
    "END:VEVENT",
    "END:VCALENDAR",
  ),
);

/** AE6: «последний рабочий день месяца» — BYSETPOS вне модели. 30.10, 30.11, 31.12. */
const lastWorkday = seed(
  "last-workday@example.com",
  "FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;COUNT=3 с 30.10.2026 17:00 МСК",
  text(
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Example Corp.//Other Client//EN",
    ...MOSCOW_ZONE,
    "BEGIN:VEVENT",
    "UID:last-workday@example.com",
    "DTSTAMP:20261001T090000Z",
    "DTSTART;TZID=Europe/Moscow:20261030T170000",
    "DTEND;TZID=Europe/Moscow:20261030T180000",
    "RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;COUNT=3",
    "SUMMARY:Отчёт за месяц",
    "END:VEVENT",
    "END:VCALENDAR",
  ),
);

/** R8-N3, Ж3: приглашение на одну встречу чужой серии — объект без основного компонента. */
const lonelyOverride = seed(
  "c31invite@example.com",
  "Одно переопределение 21.10.2026 10:00 МСК без основного компонента",
  text(
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Example Corp.//Other Client//EN",
    "BEGIN:VEVENT",
    "UID:c31invite@example.com",
    "DTSTAMP:20261001T090000Z",
    "RECURRENCE-ID;TZID=Europe/Moscow:20261021T100000",
    "DTSTART;TZID=Europe/Moscow:20261021T100000",
    "DTEND;TZID=Europe/Moscow:20261021T110000",
    "SUMMARY:Приглашение на одну встречу",
    "ORGANIZER;CN=Иван Иванов:mailto:ivanov@example.com",
    "ATTENDEE;PARTSTAT=ACCEPTED:mailto:user@yandex.ru",
    "SEQUENCE:1",
    "END:VEVENT",
    ...MOSCOW_ZONE,
    "END:VCALENDAR",
  ),
);

/** R13-N1 S4: прежний код превратил переопределение во второй основной компонент. */
const twoMasters = seed(
  "5d0c2a8e-3f7b-4c1e-9a6d-2b8e4f1c7a90",
  "Два VEVENT без RECURRENCE-ID с одним UID, записано прежним кодом (this → all_series → this)",
  [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//yandex-calendar-mcp//RU",
    "BEGIN:VEVENT",
    "UID:5d0c2a8e-3f7b-4c1e-9a6d-2b8e4f1c7a90",
    "DTSTAMP:20260919T144801Z",
    "SUMMARY:Только 26-е",
    "DTSTART;TZID=Europe/Moscow:20261021T100000",
    "DTEND;TZID=Europe/Moscow:20261021T110000",
    "END:VEVENT",
    ...MOSCOW_ZONE,
    "BEGIN:VEVENT",
    "UID:5d0c2a8e-3f7b-4c1e-9a6d-2b8e4f1c7a90",
    "DTSTAMP:20260919T144801Z",
    "SUMMARY:Планёрка",
    "LOCATION:Переговорная 5",
    "DTSTART;TZID=Europe/Moscow:20261019T100000",
    "DTEND;TZID=Europe/Moscow:20261019T110000",
    "RRULE:FREQ=WEEKLY;COUNT=6;BYDAY=MO,WE",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join(CRLF),
);

// ---------------------------------------------------------------------------
// Цепочки
// ---------------------------------------------------------------------------

describe("З05c: объекты других клиентов и следы прежнего кода", () => {
  it.fails("C04: переопределение раньше основного — get_event; this 26.10; all_series; delete this 26.10; delete t&f 02.11", async () => {
    const { fake, ctx } = makeStand();
    const uid = overrideFirst.uid;
    const path = plant(fake, overrideFirst);

    expect(await visible(ctx), describeStand(fake)).toEqual([
      "2026-10-19 10:00–11:00 Планёрка",
      "2026-10-21 11:30–12:30 Планёрка [слот 2026-10-21 10:00]",
      ...lines(SERIES_DAYS.slice(2), "10:00–11:00", "Планёрка"),
    ]);

    // get_event: основной компонент — VEVENT без RECURRENCE-ID, а не первый в файле (О1).
    const main = await readEvent(ctx, calendarA.id, uid);
    expect(wallTime(main.start, ZONE)).toBe("2026-10-19 10:00");
    expect(main.recurrence).toMatchObject({ frequency: "weekly", byWeekday: ["MO", "WE"], count: 6 });
    expect((main.exceptions ?? []).map((e) => `${wallTime(e.instanceStart, ZONE)} ${e.state}`)).toContain(
      "2026-10-21 10:00 moved",
    );

    // update this 26.10: переопределение нового слота, основной и перенос 21.10 не тронуты.
    let before = fake.ics(path);
    let mark = fake.mark();
    let target = await instance(ctx, uid, "2026-10-26 10:00");
    const s1 = await settle(update(ctx, { id: uid, scope: "this", instanceStart: target.instanceStart, patch: { summary: "Только 26-е" } }));
    expect(await visible(ctx), describeStand(fake)).toEqual([
      "2026-10-19 10:00–11:00 Планёрка",
      "2026-10-21 11:30–12:30 Планёрка [слот 2026-10-21 10:00]",
      "2026-10-26 10:00–11:00 Только 26-е",
      ...lines(SERIES_DAYS.slice(3), "10:00–11:00", "Планёрка"),
    ]);
    expect(writes(fake, mark)).toEqual(["PUT"]);
    masterOf(fake.ics(path));
    expect(overridesOf(fake.ics(path)).flatMap((c) => timeValues(c, "RECURRENCE-ID"))).toEqual([
      "TZID=Europe/Moscow:20261021T100000",
      "TZID=Europe/Moscow:20261026T100000",
    ]);
    assertStoredInvariants(fake);
    assertPropsPreserved(before, fake.ics(path));
    done(s1, fake);

    // all_series: переименование доходит до переноса 21.10 (его summary совпадал с
    // основным, О7), правка 26.10 своя и остаётся.
    before = fake.ics(path);
    mark = fake.mark();
    const s2 = await settle(update(ctx, { id: uid, scope: "all_series", patch: { summary: "Планёрка команды" } }));
    expect(await visible(ctx), describeStand(fake)).toEqual([
      "2026-10-19 10:00–11:00 Планёрка команды",
      "2026-10-21 11:30–12:30 Планёрка команды [слот 2026-10-21 10:00]",
      "2026-10-26 10:00–11:00 Только 26-е",
      ...lines(SERIES_DAYS.slice(3), "10:00–11:00", "Планёрка команды"),
    ]);
    expect(writes(fake, mark)).toEqual(["PUT"]);
    masterOf(fake.ics(path));
    expect(overridesOf(fake.ics(path))).toHaveLength(2);
    assertStoredInvariants(fake);
    assertPropsPreserved(before, fake.ics(path), { except: ["SUMMARY"] });
    done(s2, fake);

    // delete this 26.10: EXDATE на слот и снятие его переопределения; объект жив.
    before = fake.ics(path);
    mark = fake.mark();
    target = await instance(ctx, uid, "2026-10-26 10:00");
    const s3 = await settle(remove(ctx, { id: uid, scope: "this", instanceStart: target.instanceStart, etag: target.etag }));
    expect(await visible(ctx), describeStand(fake)).toEqual([
      "2026-10-19 10:00–11:00 Планёрка команды",
      "2026-10-21 11:30–12:30 Планёрка команды [слот 2026-10-21 10:00]",
      ...lines(SERIES_DAYS.slice(3), "10:00–11:00", "Планёрка команды"),
    ]);
    expect(writes(fake, mark)).toEqual(["PUT"]);
    expect(timeValues(masterOf(fake.ics(path)), "EXDATE")).toEqual(["TZID=Europe/Moscow:20261026T100000"]);
    expect(overridesOf(fake.ics(path)).flatMap((c) => timeValues(c, "RECURRENCE-ID"))).toEqual([
      "TZID=Europe/Moscow:20261021T100000",
    ]);
    assertStoredInvariants(fake);
    assertPropsPreserved(before, fake.ics(path), { scope: exceptOverride("20261026T100000") });
    done(s3, fake);

    // delete this_and_following 02.11: COUNT по позициям правила (19, 21, 26, 28 — 4),
    // перенос 21.10 раньше границы остаётся.
    before = fake.ics(path);
    mark = fake.mark();
    target = await instance(ctx, uid, "2026-11-02 10:00");
    const s4 = await settle(
      remove(ctx, { id: uid, scope: "this_and_following", instanceStart: target.instanceStart, etag: target.etag }),
    );
    expect(await visible(ctx), describeStand(fake)).toEqual([
      "2026-10-19 10:00–11:00 Планёрка команды",
      "2026-10-21 11:30–12:30 Планёрка команды [слот 2026-10-21 10:00]",
      "2026-10-28 10:00–11:00 Планёрка команды",
    ]);
    expect(writes(fake, mark)).toEqual(["PUT"]);
    expect(ruleOf(masterOf(fake.ics(path)))).toMatchObject({ FREQ: "WEEKLY", BYDAY: "MO,WE", COUNT: "4" });
    expect(timeValues(masterOf(fake.ics(path)), "EXDATE")).toEqual(["TZID=Europe/Moscow:20261026T100000"]);
    expect(overridesOf(fake.ics(path))).toHaveLength(1);
    assertStoredInvariants(fake);
    assertPropsPreserved(before, fake.ics(path), { except: ["RRULE"] });
    done(s4, fake);
  });

  it.fails("C15: all_series rename сохраняет EXDATE, RDATE, ORGANIZER, ATTENDEE, CATEGORIES, X-, SEQUENCE, VALARM", async () => {
    const { fake, ctx } = makeStand();
    const uid = seeds.richMoscow.uid;
    const path = plant(fake, seeds.richMoscow);
    const rich = (summary: string) =>
      lines(["2026-10-21", "2026-10-30", "2026-11-04", "2026-11-11", "2026-11-18"], "12:00–13:00", summary);

    expect(await visible(ctx), describeStand(fake)).toEqual(rich("Созвон по проекту"));

    const before = fake.ics(path);
    const mark = fake.mark();
    const s = await settle(update(ctx, { id: uid, scope: "all_series", patch: { summary: "Созвон по проекту — итоги" } }));
    // 28.10 закрыт EXDATE и не воскрес; 30.10 по RDATE на месте.
    expect(await visible(ctx), describeStand(fake)).toEqual(rich("Созвон по проекту — итоги"));
    expect(writes(fake, mark)).toEqual(["PUT"]);
    const body = lastPutBody(fake, path);
    expect(body, "тело PUT").toBeDefined();
    // Все строки основного компонента, VALARM и VTIMEZONE — в теле PUT, кроме SUMMARY и метаданных.
    assertPropsPreserved(before, body!, { except: ["SUMMARY"] });
    // SEQUENCE не растёт: время и правило не менялись (О10).
    expect(linesOf(masterOf(body!), "SEQUENCE")).toEqual(["SEQUENCE:2"]);
    assertStoredInvariants(fake);
    done(s, fake);
  });

  it.fails("C17: HOURLY — delete this 12:00, update this 14:00; объект жив", async () => {
    const { fake, ctx } = makeStand();
    const uid = hourly.uid;
    const path = plant(fake, hourly);

    expect(await visible(ctx), describeStand(fake)).toEqual([
      "2026-10-19 10:00–10:15 Проверка датчиков",
      "2026-10-19 12:00–12:15 Проверка датчиков",
      "2026-10-19 14:00–14:15 Проверка датчиков",
      "2026-10-19 16:00–16:15 Проверка датчиков",
    ]);

    // delete this 12:00: EXDATE, а не удаление всей серии (AE5, AD2).
    let before = fake.ics(path);
    let mark = fake.mark();
    let target = await instance(ctx, uid, "2026-10-19 12:00");
    const s1 = await settle(remove(ctx, { id: uid, scope: "this", instanceStart: target.instanceStart, etag: target.etag }));
    expect(await visible(ctx), describeStand(fake)).toEqual([
      "2026-10-19 10:00–10:15 Проверка датчиков",
      "2026-10-19 14:00–14:15 Проверка датчиков",
      "2026-10-19 16:00–16:15 Проверка датчиков",
    ]);
    expect(writes(fake, mark)).toEqual(["PUT"]);
    expect(fake.has(path)).toBe(true);
    expect(timeValues(masterOf(fake.ics(path)), "EXDATE")).toEqual(["TZID=Europe/Moscow:20261019T120000"]);
    assertStoredInvariants(fake);
    assertPropsPreserved(before, fake.ics(path));
    expect(done(s1, fake)).toMatchObject({ scope: "this", objectRemoved: false });

    // update this 14:00: переопределение, правило HOURLY цело.
    before = fake.ics(path);
    mark = fake.mark();
    target = await instance(ctx, uid, "2026-10-19 14:00");
    const s2 = await settle(update(ctx, { id: uid, scope: "this", instanceStart: target.instanceStart, patch: { summary: "Только 14:00" } }));
    expect(await visible(ctx), describeStand(fake)).toEqual([
      "2026-10-19 10:00–10:15 Проверка датчиков",
      "2026-10-19 14:00–14:15 Только 14:00",
      "2026-10-19 16:00–16:15 Проверка датчиков",
    ]);
    expect(writes(fake, mark)).toEqual(["PUT"]);
    expect(ruleOf(masterOf(fake.ics(path)))).toEqual({ FREQ: "HOURLY", INTERVAL: "2", COUNT: "4" });
    expect(overridesOf(fake.ics(path)).flatMap((c) => timeValues(c, "RECURRENCE-ID"))).toEqual([
      "TZID=Europe/Moscow:20261019T140000",
    ]);
    assertStoredInvariants(fake);
    assertPropsPreserved(before, fake.ics(path));
    done(s2, fake);
  });

  it.fails("C17: серия только из RDATE — три встречи с DTSTART; delete this по одной до пустоты", async () => {
    const { fake, ctx } = makeStand();
    const uid = rdateOnly.uid;
    const path = plant(fake, rdateOnly);

    expect(await visible(ctx), describeStand(fake)).toEqual(
      lines(["2026-10-19", "2026-10-22", "2026-10-27"], "10:00–11:00", "Встречи по датам"),
    );

    // delete this 22.10 — слот из RDATE: снимается значение RDATE (таблица §3).
    let mark = fake.mark();
    let target = await instance(ctx, uid, "2026-10-22 10:00");
    const s1 = await settle(remove(ctx, { id: uid, scope: "this", instanceStart: target.instanceStart, etag: target.etag }));
    expect(await visible(ctx), describeStand(fake)).toEqual(
      lines(["2026-10-19", "2026-10-27"], "10:00–11:00", "Встречи по датам"),
    );
    expect(writes(fake, mark)).toEqual(["PUT"]);
    expect(timeValues(masterOf(fake.ics(path)), "RDATE")).toEqual(["TZID=Europe/Moscow:20261027T100000"]);
    expect(timeValues(masterOf(fake.ics(path)), "EXDATE")).toEqual([]);
    assertStoredInvariants(fake);
    expect(done(s1, fake)).toMatchObject({ scope: "this", objectRemoved: false });

    // delete this 19.10 — слот DTSTART: EXDATE.
    mark = fake.mark();
    target = await instance(ctx, uid, "2026-10-19 10:00");
    const s2 = await settle(remove(ctx, { id: uid, scope: "this", instanceStart: target.instanceStart, etag: target.etag }));
    expect(await visible(ctx), describeStand(fake)).toEqual(["2026-10-27 10:00–11:00 Встречи по датам"]);
    expect(writes(fake, mark)).toEqual(["PUT"]);
    expect(timeValues(masterOf(fake.ics(path)), "EXDATE")).toEqual(["TZID=Europe/Moscow:20261019T100000"]);
    assertStoredInvariants(fake);
    done(s2, fake);

    // delete this 27.10 — последняя встреча: объект пуст и удаляется (Р3).
    mark = fake.mark();
    target = await instance(ctx, uid, "2026-10-27 10:00");
    const s3 = await settle(remove(ctx, { id: uid, scope: "this", instanceStart: target.instanceStart, etag: target.etag }));
    expect(await visible(ctx), describeStand(fake)).toEqual([]);
    expect(writes(fake, mark)).toEqual(["DELETE"]);
    expect(fake.has(path)).toBe(false);
    expect(done(s3, fake)).toMatchObject({ objectRemoved: true });
  });

  it.fails("C30: переопределение CANCELLED — status, свободное время, правка отклонена, delete this", async () => {
    const { fake, ctx } = makeStand();
    const path = plant(
      fake,
      seed(
        W,
        "weeklyMoscow с отменённой встречей 21.10",
        withComponents(
          seeds.weeklyMoscow.ics,
          ...override(
            "RECURRENCE-ID;TZID=Europe/Moscow:20261021T100000",
            "DTSTART;TZID=Europe/Moscow:20261021T100000",
            "DTEND;TZID=Europe/Moscow:20261021T110000",
            "SUMMARY:Планёрка",
            "STATUS:CANCELLED",
            "SEQUENCE:1",
          ),
        ),
      ),
    );

    expect(await visible(ctx), describeStand(fake)).toEqual([
      "2026-10-19 10:00–11:00 Планёрка",
      "2026-10-21 10:00–11:00 Планёрка [отменена]",
      ...lines(SERIES_DAYS.slice(2), "10:00–11:00", "Планёрка"),
    ]);

    // Отменённая встреча время не занимает (Р7): в рабочих часах 21.10 свободно всё.
    const free = await findFreeSlots(ctx, {
      from: "2026-10-21T10:00:00+03:00",
      to: "2026-10-21T19:00:00+03:00",
      durationMinutes: 30,
    });
    expect(free.map((slot) => [Date.parse(slot.start), Date.parse(slot.end)])).toEqual([
      [Date.parse("2026-10-21T10:00:00+03:00"), Date.parse("2026-10-21T19:00:00+03:00")],
    ]);

    // Правка отменённой — отказ, без записей.
    const before = fake.ics(path);
    let mark = fake.mark();
    let target = await instance(ctx, W, "2026-10-21 10:00");
    const s1 = await settle(update(ctx, { id: W, scope: "this", instanceStart: target.instanceStart, patch: { summary: "Вернули" } }));
    expectNoWrites(fake, mark);
    expect(fake.ics(path)).toBe(before);
    expect(refusal(s1)).toHaveProperty("code");

    // delete this: EXDATE на слот и снятие отменённого компонента.
    mark = fake.mark();
    target = await instance(ctx, W, "2026-10-21 10:00");
    const s2 = await settle(remove(ctx, { id: W, scope: "this", instanceStart: target.instanceStart, etag: target.etag }));
    expect(await visible(ctx), describeStand(fake)).toEqual([
      "2026-10-19 10:00–11:00 Планёрка",
      ...lines(SERIES_DAYS.slice(2), "10:00–11:00", "Планёрка"),
    ]);
    expect(writes(fake, mark)).toEqual(["PUT"]);
    expect(timeValues(masterOf(fake.ics(path)), "EXDATE")).toEqual(["TZID=Europe/Moscow:20261021T100000"]);
    expect(overridesOf(fake.ics(path))).toEqual([]);
    assertStoredInvariants(fake);
    done(s2, fake);
  });

  it.fails("C30: основной компонент CANCELLED — status, свободное время, правка отклонена", async () => {
    const { fake, ctx } = makeStand();
    const uid = seeds.singleMoscow.uid;
    const path = plant(
      fake,
      seed(uid, "singleMoscow со STATUS:CANCELLED", withLinesAfter(seeds.singleMoscow.ics, "SUMMARY:", "STATUS:CANCELLED")),
    );

    expect(await visible(ctx), describeStand(fake)).toEqual(["2026-10-20 15:00–16:00 Обед с командой [отменена]"]);

    const free = await findFreeSlots(ctx, {
      from: "2026-10-20T10:00:00+03:00",
      to: "2026-10-20T19:00:00+03:00",
      durationMinutes: 30,
    });
    expect(free.map((slot) => [Date.parse(slot.start), Date.parse(slot.end)])).toEqual([
      [Date.parse("2026-10-20T10:00:00+03:00"), Date.parse("2026-10-20T19:00:00+03:00")],
    ]);

    const before = fake.ics(path);
    const mark = fake.mark();
    const s = await settle(update(ctx, { id: uid, patch: { summary: "Обед всё-таки будет" } }));
    expectNoWrites(fake, mark);
    expect(fake.ics(path)).toBe(before);
    expect(await visible(ctx)).toEqual(["2026-10-20 15:00–16:00 Обед с командой [отменена]"]);
    expect(refusal(s)).toHaveProperty("code");
  });

  it.fails("C31: объект из одного переопределения — виден; update this на месте; delete this удаляет объект", async () => {
    const { fake, ctx } = makeStand();
    const uid = lonelyOverride.uid;
    const path = plant(fake, lonelyOverride);

    expect(await visible(ctx), describeStand(fake)).toEqual(["2026-10-21 10:00–11:00 Приглашение на одну встречу"]);

    // update this — правка компонента на месте, RECURRENCE-ID неизменен (Р6).
    const before = fake.ics(path);
    let mark = fake.mark();
    let target = await instance(ctx, uid, "2026-10-21 10:00");
    const s1 = await settle(
      update(ctx, { id: uid, scope: "this", instanceStart: target.instanceStart, patch: { location: "Переговорная 7" } }),
    );
    expect(await visible(ctx), describeStand(fake)).toEqual([
      "2026-10-21 10:00–11:00 Приглашение на одну встречу @Переговорная 7",
    ]);
    expect(writes(fake, mark)).toEqual(["PUT"]);
    expect(mastersOf(fake.ics(path))).toEqual([]);
    expect(overridesOf(fake.ics(path)).flatMap((c) => timeValues(c, "RECURRENCE-ID"))).toEqual([
      "TZID=Europe/Moscow:20261021T100000",
    ]);
    assertStoredInvariants(fake);
    assertPropsPreserved(before, fake.ics(path));
    done(s1, fake);

    // delete this — последний компонент уходит вместе с объектом.
    mark = fake.mark();
    target = await instance(ctx, uid, "2026-10-21 10:00");
    const s2 = await settle(remove(ctx, { id: uid, scope: "this", instanceStart: target.instanceStart, etag: target.etag }));
    expect(await visible(ctx), describeStand(fake)).toEqual([]);
    expect(writes(fake, mark)).toEqual(["DELETE"]);
    expect(fake.has(path)).toBe(false);
    expect(done(s2, fake)).toMatchObject({ objectRemoved: true });
  });

  it.fails("C32: RANGE=THISANDFUTURE — чтение со сдвигом; update и delete this — отказ; delete all_series", async () => {
    const { fake, ctx } = makeStand();
    const path = plant(
      fake,
      seed(
        W,
        "weeklyMoscow, с 26.10 и далее на 12:00 (RANGE=THISANDFUTURE)",
        withComponents(
          seeds.weeklyMoscow.ics,
          ...override(
            "RECURRENCE-ID;RANGE=THISANDFUTURE;TZID=Europe/Moscow:20261026T100000",
            "DTSTART;TZID=Europe/Moscow:20261026T120000",
            "DTEND;TZID=Europe/Moscow:20261026T130000",
            "SUMMARY:Планёрка",
            "SEQUENCE:1",
          ),
        ),
      ),
    );

    // RFC 5545 §3.8.4.4: сдвиг +2 ч действует на 26.10 и все следующие (Р7).
    const shifted = [
      "2026-10-19 10:00–11:00 Планёрка",
      "2026-10-21 10:00–11:00 Планёрка",
      "2026-10-26 12:00–13:00 Планёрка [слот 2026-10-26 10:00]",
      "2026-10-28 12:00–13:00 Планёрка [слот 2026-10-28 10:00]",
      "2026-11-02 12:00–13:00 Планёрка [слот 2026-11-02 10:00]",
      "2026-11-04 12:00–13:00 Планёрка [слот 2026-11-04 10:00]",
    ];
    expect(await visible(ctx), describeStand(fake)).toEqual(shifted);

    // Запись в объект с RANGE — только delete all_series (О14).
    const before = fake.ics(path);
    let mark = fake.mark();
    let target = await instance(ctx, W, "2026-10-28 10:00");
    const s1 = await settle(update(ctx, { id: W, scope: "this", instanceStart: target.instanceStart, patch: { summary: "X" } }));
    expectNoWrites(fake, mark);
    expect(fake.ics(path)).toBe(before);
    expect(refusal(s1)).toMatchObject({ code: "range-override" });

    mark = fake.mark();
    target = await instance(ctx, W, "2026-10-21 10:00");
    const s2 = await settle(remove(ctx, { id: W, scope: "this", instanceStart: target.instanceStart, etag: target.etag }));
    expectNoWrites(fake, mark);
    expect(await visible(ctx)).toEqual(shifted);
    expect(refusal(s2)).toMatchObject({ code: "range-override" });

    mark = fake.mark();
    const s3 = await settle(remove(ctx, { id: W, scope: "all_series", etag: target.etag }));
    expect(await visible(ctx), describeStand(fake)).toEqual([]);
    expect(writes(fake, mark)).toEqual(["DELETE"]);
    expect(fake.has(path)).toBe(false);
    done(s3, fake);
  });

  it.fails("C33: RECURRENCE-ID в поясе Europe/Berlin у серии в Europe/Moscow — один экземпляр +03:00; delete this", async () => {
    const { fake, ctx } = makeStand();
    const berlin = withLinesAfter(seeds.weeklyMoscow.ics, "METHOD:", ...BERLIN_ZONE);
    const path = plant(
      fake,
      seed(
        W,
        "weeklyMoscow, перенос 21.10 на 11:30 с RECURRENCE-ID в поясе Berlin (09:00 CEST = 10:00 МСК)",
        withComponents(
          berlin,
          ...override(
            "RECURRENCE-ID;TZID=Europe/Berlin:20261021T090000",
            "DTSTART;TZID=Europe/Moscow:20261021T113000",
            "DTEND;TZID=Europe/Moscow:20261021T123000",
            "SUMMARY:Планёрка (перенесена)",
            "SEQUENCE:1",
          ),
        ),
      ),
    );

    // Сопоставление по моменту (О3), а не по строке: 21.10 один, без дубля в 10:00 (R8-N5).
    expect(await visible(ctx), describeStand(fake)).toEqual([
      "2026-10-19 10:00–11:00 Планёрка",
      "2026-10-21 11:30–12:30 Планёрка (перенесена) [слот 2026-10-21 10:00]",
      ...lines(SERIES_DAYS.slice(2), "10:00–11:00", "Планёрка"),
    ]);
    const target = await instance(ctx, W, "2026-10-21 10:00");
    expect(target.instanceStart).toMatch(/\+03:00$/);

    const mark = fake.mark();
    const s = await settle(remove(ctx, { id: W, scope: "this", instanceStart: target.instanceStart, etag: target.etag }));
    expect(await visible(ctx), describeStand(fake)).toEqual([
      "2026-10-19 10:00–11:00 Планёрка",
      ...lines(SERIES_DAYS.slice(2), "10:00–11:00", "Планёрка"),
    ]);
    expect(writes(fake, mark)).toEqual(["PUT"]);
    // EXDATE — в форме DTSTART (О4), переопределение снято.
    expect(timeValues(masterOf(fake.ics(path)), "EXDATE")).toEqual(["TZID=Europe/Moscow:20261021T100000"]);
    expect(overridesOf(fake.ics(path))).toEqual([]);
    assertStoredInvariants(fake);
    done(s, fake);
  });

  it.fails("C34: наследие — дубль EXDATE и переопределение под ним скрыты; скрытое удаляется delete this по своему RID", async () => {
    const { fake, ctx } = makeStand();
    // Так оставлял прежний код: update this 21.10 {summary} → delete this 21.10 дважды (AD5).
    const path = plant(
      fake,
      seed(
        W,
        "weeklyMoscow: EXDATE 21.10 дважды и переопределение того же слота",
        withComponents(
          withLinesAfter(
            seeds.weeklyMoscow.ics,
            "RRULE:",
            "EXDATE;TZID=Europe/Moscow:20261021T100000",
            "EXDATE;TZID=Europe/Moscow:20261021T100000",
          ),
          ...override(
            "RECURRENCE-ID;TZID=Europe/Moscow:20261021T100000",
            "DTSTART;TZID=Europe/Moscow:20261021T100000",
            "DTEND;TZID=Europe/Moscow:20261021T110000",
            "SUMMARY:Особая планёрка",
          ),
        ),
      ),
    );
    const five = [
      "2026-10-19 10:00–11:00 Планёрка",
      ...lines(SERIES_DAYS.slice(2), "10:00–11:00", "Планёрка"),
    ];

    // Р5.2: переопределение под EXDATE скрыто — без призрака «Особая планёрка» (R8-N1 B).
    expect(await visible(ctx), describeStand(fake)).toEqual(five);
    const main = await readEvent(ctx, calendarA.id, W);
    const hidden = (main.exceptions ?? []).filter((e) => e.state === "hidden");
    expect(hidden.map((e) => wallTime(e.instanceStart, ZONE))).toEqual(["2026-10-21 10:00"]);

    // delete this по RID скрытого снимает только его; EXDATE не меняются.
    const before = fake.ics(path);
    const mark = fake.mark();
    const s = await settle(remove(ctx, { id: W, scope: "this", instanceStart: hidden[0].instanceStart, etag: main.etag }));
    expect(await visible(ctx), describeStand(fake)).toEqual(five);
    expect(writes(fake, mark)).toEqual(["PUT"]);
    expect(overridesOf(fake.ics(path))).toEqual([]);
    expect(timeValues(masterOf(fake.ics(path)), "EXDATE")).toEqual(timeValues(masterOf(before), "EXDATE"));
    assertStoredInvariants(fake);
    assertPropsPreserved(before, fake.ics(path), { scope: exceptOverride("20261021T100000") });
    done(s, fake);
  });

  it.fails("C34: наследие — сирота после UNTIL скрыта и не воскресает после all_series", async () => {
    const { fake, ctx } = makeStand();
    // Так оставлял прежний код: update this 02.11 → delete t&f 26.10 (R8-N1 C, AD6).
    const path = plant(
      fake,
      seed(
        W,
        "Пн и Ср 10:00 МСК, UNTIL перед 26.10; переопределение 02.11 за концом серии",
        withComponents(
          seeds.weeklyMoscow.ics.replace("RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6", "RRULE:FREQ=WEEKLY;UNTIL=20261026T065959Z;BYDAY=MO,WE"),
          ...override(
            "RECURRENCE-ID;TZID=Europe/Moscow:20261102T100000",
            "DTSTART;TZID=Europe/Moscow:20261102T100000",
            "DTEND;TZID=Europe/Moscow:20261102T110000",
            "SUMMARY:Итоговая встреча",
          ),
        ),
      ),
    );

    expect(await visible(ctx), describeStand(fake)).toEqual(lines(["2026-10-19", "2026-10-21"], "10:00–11:00", "Планёрка"));

    const before = fake.ics(path);
    const mark = fake.mark();
    const s = await settle(update(ctx, { id: W, scope: "all_series", patch: { summary: "Планёрка (итог)" } }));
    expect(await visible(ctx), describeStand(fake)).toEqual(
      lines(["2026-10-19", "2026-10-21"], "10:00–11:00", "Планёрка (итог)"),
    );
    expect(writes(fake, mark)).toEqual(["PUT"]);
    // UNTIL и скрытый компонент — на месте (О5).
    assertPropsPreserved(before, fake.ics(path), { except: ["SUMMARY"] });
    assertStoredInvariants(fake);
    done(s, fake);
  });

  it.fails("C34: наследие — RECURRENCE-ID в DATE-TIME у серии на весь день: одна встреча; delete this", async () => {
    const { fake, ctx } = makeStand();
    const uid = seeds.allDayWeekly.uid;
    // Так писал прежний код (AE14): RECURRENCE-ID:20261021T000000Z при DTSTART;VALUE=DATE.
    const path = plant(
      fake,
      seed(
        uid,
        "allDayWeekly с переопределением 21.10 в форме DATE-TIME UTC",
        withComponents(
          seeds.allDayWeekly.ics,
          "BEGIN:VEVENT",
          `UID:${uid}`,
          "DTSTAMP:20260919T144801Z",
          "SUMMARY:Особое дежурство",
          "DTSTART;VALUE=DATE:20261021",
          "DTEND;VALUE=DATE:20261022",
          "RECURRENCE-ID:20261021T000000Z",
          "END:VEVENT",
        ),
      ),
    );

    // О3: у серии на весь день ключ RID — буквальная дата; 21.10 один раз.
    expect(await visible(ctx), describeStand(fake)).toEqual([
      "2026-10-19 весь день Дежурство",
      "2026-10-21 весь день Особое дежурство",
      ...lines(SERIES_DAYS.slice(2), "весь день", "Дежурство"),
    ]);

    const mark = fake.mark();
    const target = await instance(ctx, uid, "2026-10-21");
    const s = await settle(remove(ctx, { id: uid, scope: "this", instanceStart: target.instanceStart, etag: target.etag }));
    expect(await visible(ctx), describeStand(fake)).toEqual([
      "2026-10-19 весь день Дежурство",
      ...lines(SERIES_DAYS.slice(2), "весь день", "Дежурство"),
    ]);
    expect(writes(fake, mark)).toEqual(["PUT"]);
    // EXDATE — в форме DTSTART (О4, Ж4), переопределение снято.
    expect(timeValues(masterOf(fake.ics(path)), "EXDATE")).toEqual(["VALUE=DATE:20261021"]);
    expect(overridesOf(fake.ics(path))).toEqual([]);
    assertStoredInvariants(fake);
    done(s, fake);
  });

  it.fails("C34: наследие — два основных компонента: аномалия, правка отклонена, delete all_series удаляет", async () => {
    const { fake, ctx } = makeStand();
    const uid = twoMasters.uid;
    const path = plant(fake, twoMasters);

    // Р12: объект читается с аномалией multiple-masters.
    const main = await readEvent(ctx, calendarA.id, uid);
    expect((main.anomalies ?? []).some((a) => a.startsWith("multiple-masters"))).toBe(true);

    // Запись в объект с двумя основными — отказ (О14), выдача не меняется.
    const shown = await visible(ctx);
    const before = fake.ics(path);
    let mark = fake.mark();
    const s1 = await settle(update(ctx, { id: uid, scope: "all_series", patch: { summary: "Планёрка команды" } }));
    expectNoWrites(fake, mark);
    expect(fake.ics(path)).toBe(before);
    expect(await visible(ctx)).toEqual(shown);
    expect(refusal(s1)).toMatchObject({ code: "multiple-masters" });

    // delete all_series не блокируется ничем.
    mark = fake.mark();
    const s2 = await settle(remove(ctx, { id: uid, scope: "all_series", etag: main.etag }));
    expect(await visible(ctx), describeStand(fake)).toEqual([]);
    expect(writes(fake, mark)).toEqual(["DELETE"]);
    expect(fake.has(path)).toBe(false);
    done(s2, fake);
  });

  // C64 — сверх перечня плана (задача «уборка»): случай, который путала
  // удалённая эвристика stale-shift. RECURRENCE-ID 21.10 10:00 приходится на
  // дату слота 21.10 09:00, но не на его время. Эвристика показывала такое
  // переопределение вместо встречи слота — 21.10 была видна одна встреча, а
  // delete this слота снимал и её. По ролям поправки «без ремонта следов
  // прежнего кода» это detached: отдельная встреча с адресом своего
  // RECURRENCE-ID. 21.10 видны две встречи, обе занимают время, и запись
  // одной не трогает другую.
  // Прежний код: падает на шаге 2 — update this по адресу detached он
  // отвергает (встречи с таким началом нет), и видимый список не меняется.
  it.fails("C64: detached в дату слота, но не во время слота — две встречи 21.10; delete this слота; update и delete this detached по его адресу", async () => {
    const { fake, ctx } = makeStand();
    const uid = seeds.detachedOnSlotDate.uid;
    const path = plant(fake, seeds.detachedOnSlotDate);
    const series = (days: string[]) => lines(days, "09:00–10:00", "Планёрка");
    const [d19, d21, ...rest] = SERIES_DAYS;

    expect(await visible(ctx), describeStand(fake)).toEqual([
      ...series([d19, d21]),
      "2026-10-21 11:30–12:30 Планёрка [слот 2026-10-21 10:00]",
      ...series(rest),
    ]);
    // Обе встречи 21.10 занимают время.
    const free = await findFreeSlots(ctx, {
      from: "2026-10-21T09:00:00+03:00",
      to: "2026-10-21T13:00:00+03:00",
      durationMinutes: 30,
    });
    expect(free.map((slot) => [Date.parse(slot.start), Date.parse(slot.end)])).toEqual([
      [Date.parse("2026-10-21T10:00:00+03:00"), Date.parse("2026-10-21T11:30:00+03:00")],
      [Date.parse("2026-10-21T12:30:00+03:00"), Date.parse("2026-10-21T13:00:00+03:00")],
    ]);

    // delete this 21.10 09:00: EXDATE на слот; detached — не встреча этого слота и остаётся.
    let before = fake.ics(path);
    let mark = fake.mark();
    const slot = await instance(ctx, uid, "2026-10-21 09:00");
    const s1 = await settle(remove(ctx, { id: uid, scope: "this", instanceStart: slot.instanceStart, etag: slot.etag }));
    expect(await visible(ctx), describeStand(fake)).toEqual([
      ...series([d19]),
      "2026-10-21 11:30–12:30 Планёрка [слот 2026-10-21 10:00]",
      ...series(rest),
    ]);
    expect(writes(fake, mark)).toEqual(["PUT"]);
    expect(timeValues(masterOf(fake.ics(path)), "EXDATE")).toEqual(["TZID=Europe/Moscow:20261021T090000"]);
    expect(overridesOf(fake.ics(path)).flatMap((c) => timeValues(c, "RECURRENCE-ID"))).toEqual([
      "TZID=Europe/Moscow:20261021T100000",
    ]);
    assertStoredInvariants(fake);
    assertPropsPreserved(before, fake.ics(path));
    done(s1, fake);

    // update this по адресу detached: правка его компонента на месте, RECURRENCE-ID неизменен.
    before = fake.ics(path);
    mark = fake.mark();
    let target = await instance(ctx, uid, "2026-10-21 10:00");
    const s2 = await settle(
      update(ctx, { id: uid, scope: "this", instanceStart: target.instanceStart, patch: { summary: "Разбор с заказчиком" } }),
    );
    expect(await visible(ctx), describeStand(fake)).toEqual([
      ...series([d19]),
      "2026-10-21 11:30–12:30 Разбор с заказчиком [слот 2026-10-21 10:00]",
      ...series(rest),
    ]);
    expect(writes(fake, mark)).toEqual(["PUT"]);
    masterOf(fake.ics(path));
    expect(overridesOf(fake.ics(path)).flatMap((c) => timeValues(c, "RECURRENCE-ID"))).toEqual([
      "TZID=Europe/Moscow:20261021T100000",
    ]);
    assertStoredInvariants(fake);
    assertPropsPreserved(before, fake.ics(path), { except: ["SUMMARY"] });
    // Выдача помечает её как detached, get_event — среди отступлений серии.
    expect(target.detached).toBe(true);
    const main = await readEvent(ctx, calendarA.id, uid);
    expect((main.exceptions ?? []).map((e) => `${wallTime(e.instanceStart, ZONE)} ${e.state}`)).toContain(
      "2026-10-21 10:00 detached",
    );
    done(s2, fake);

    // delete this по адресу detached: снимается только его компонент, объект жив.
    before = fake.ics(path);
    mark = fake.mark();
    target = await instance(ctx, uid, "2026-10-21 10:00");
    const s3 = await settle(remove(ctx, { id: uid, scope: "this", instanceStart: target.instanceStart, etag: target.etag }));
    expect(await visible(ctx), describeStand(fake)).toEqual(series([d19, ...rest]));
    expect(writes(fake, mark)).toEqual(["PUT"]);
    expect(fake.has(path)).toBe(true);
    expect(overridesOf(fake.ics(path))).toEqual([]);
    assertStoredInvariants(fake);
    assertPropsPreserved(before, fake.ics(path), { scope: exceptOverride("20261021T100000") });
    done(s3, fake);
  });

  it("C35: дубль EXDATE 21.10 и EXDATE 26.10 — 26.10 исключён; delete this 28.10 без новых дублей", async () => {
    const { fake, ctx } = makeStand();
    const path = plant(
      fake,
      seed(
        W,
        "weeklyMoscow: EXDATE 21.10 дважды и EXDATE 26.10",
        withLinesAfter(
          seeds.weeklyMoscow.ics,
          "RRULE:",
          "EXDATE;TZID=Europe/Moscow:20261021T100000",
          "EXDATE;TZID=Europe/Moscow:20261021T100000",
          "EXDATE;TZID=Europe/Moscow:20261026T100000",
        ),
      ),
    );

    // EXDATE — множество ключей (О2): дубль не сдвигает следующее исключение.
    expect(await visible(ctx), describeStand(fake)).toEqual(
      lines(["2026-10-19", "2026-10-28", "2026-11-02", "2026-11-04"], "10:00–11:00", "Планёрка"),
    );

    const before = fake.ics(path);
    const mark = fake.mark();
    const target = await instance(ctx, W, "2026-10-28 10:00");
    const s = await settle(remove(ctx, { id: W, scope: "this", instanceStart: target.instanceStart, etag: target.etag }));
    expect(await visible(ctx), describeStand(fake)).toEqual(
      lines(["2026-10-19", "2026-11-02", "2026-11-04"], "10:00–11:00", "Планёрка"),
    );
    expect(writes(fake, mark)).toEqual(["PUT"]);
    const exdates = timeValues(masterOf(fake.ics(path)), "EXDATE");
    expect(exdates.filter((v) => v === "TZID=Europe/Moscow:20261028T100000")).toHaveLength(1);
    expect(exdates).toEqual(expect.arrayContaining(["TZID=Europe/Moscow:20261026T100000"]));
    assertStoredInvariants(fake);
    assertPropsPreserved(before, fake.ics(path));
    done(s, fake);
  });

  it("C35: EXDATE «в пустоту» 21.10 11:30 и EXDATE 26.10 — 26.10 исключён, 21.10 на месте", async () => {
    const { fake, ctx } = makeStand();
    const path = plant(
      fake,
      seed(
        W,
        "weeklyMoscow: EXDATE 21.10 11:30 (мимо слотов) и EXDATE 26.10",
        withLinesAfter(
          seeds.weeklyMoscow.ics,
          "RRULE:",
          "EXDATE;TZID=Europe/Moscow:20261021T113000",
          "EXDATE;TZID=Europe/Moscow:20261026T100000",
        ),
      ),
    );

    expect(await visible(ctx), describeStand(fake)).toEqual(
      lines(["2026-10-19", "2026-10-21", "2026-10-28", "2026-11-02", "2026-11-04"], "10:00–11:00", "Планёрка"),
    );

    const before = fake.ics(path);
    const mark = fake.mark();
    const target = await instance(ctx, W, "2026-10-28 10:00");
    const s = await settle(remove(ctx, { id: W, scope: "this", instanceStart: target.instanceStart, etag: target.etag }));
    expect(await visible(ctx), describeStand(fake)).toEqual(
      lines(["2026-10-19", "2026-10-21", "2026-11-02", "2026-11-04"], "10:00–11:00", "Планёрка"),
    );
    expect(writes(fake, mark)).toEqual(["PUT"]);
    assertStoredInvariants(fake);
    assertPropsPreserved(before, fake.ics(path));
    done(s, fake);
  });

  it.fails("C37: all_series reminders частично — чужой AUDIO и совпадающий DISPLAY побайтово; attendees без status — PARTSTAT цел", async () => {
    const { fake, ctx } = makeStand();
    const uid = seeds.richMoscow.uid;
    const path = plant(fake, seeds.richMoscow);
    const rich = lines(["2026-10-21", "2026-10-30", "2026-11-04", "2026-11-11", "2026-11-18"], "12:00–13:00", "Созвон по проекту");

    expect(await visible(ctx), describeStand(fake)).toEqual(rich);

    // reminders: DISPLAY за 15 минут уже есть, EMAIL за час — новый (О9).
    let before = fake.ics(path);
    let mark = fake.mark();
    const s1 = await settle(
      update(ctx, {
        id: uid,
        scope: "all_series",
        patch: {
          reminders: [
            { minutesBefore: 15, method: "display" },
            { minutesBefore: 60, method: "email" },
          ],
        },
      }),
    );
    expect(await visible(ctx), describeStand(fake)).toEqual(rich);
    expect(writes(fake, mark)).toEqual(["PUT"]);
    let body = lastPutBody(fake, path);
    expect(body, "тело PUT").toBeDefined();
    assertPropsPreserved(before, body!, { only: ["VALARM"], exact: true });
    assertPropsPreserved(before, body!);
    const emails = masterOf(body!).children.filter(
      (alarm) => alarm.name === "VALARM" && linesOf(alarm, "ACTION").some((line) => /:EMAIL$/i.test(line)),
    );
    expect(emails).toHaveLength(1);
    const trigger = linesOf(emails[0], "TRIGGER")[0] ?? "";
    // lib/ical/duration.js: fromString, toSeconds.
    expect(ICAL.Duration.fromString(trigger.slice(valueColon(trigger) + 1)).toSeconds()).toBe(-3600);
    assertStoredInvariants(fake);
    done(s1, fake);

    // attendees без status: PARTSTAT, CN и ROLE прежних побайтово, новый — NEEDS-ACTION (О9).
    before = fake.ics(path);
    mark = fake.mark();
    const s2 = await settle(
      update(ctx, {
        id: uid,
        scope: "all_series",
        patch: {
          attendees: [{ email: "petrov@example.com" }, { email: "anna@example.com" }, { email: "new@example.com" }],
        },
      }),
    );
    expect(await visible(ctx), describeStand(fake)).toEqual(rich);
    expect(writes(fake, mark)).toEqual(["PUT"]);
    body = lastPutBody(fake, path);
    expect(body, "тело PUT").toBeDefined();
    assertPropsPreserved(before, body!, { only: ["ATTENDEE"], exact: true });
    assertPropsPreserved(before, body!);
    const added = linesOf(masterOf(body!), "ATTENDEE").filter((line) => /:mailto:new@example\.com$/i.test(line));
    expect(added).toHaveLength(1);
    expect(added[0]).toMatch(/[;:]PARTSTAT=NEEDS-ACTION[;:]/i);
    assertStoredInvariants(fake);
    done(s2, fake);
  });

  it.fails("C38: HOURLY — recurrence.count 6 меняет только COUNT", async () => {
    const { fake, ctx } = makeStand();
    const uid = hourly.uid;
    const path = plant(fake, hourly);

    // Р4: частота вне модели читается дословно.
    const main = await readEvent(ctx, calendarA.id, uid);
    expect(main.recurrenceRule ?? "").toMatch(/FREQ=HOURLY/);

    const before = fake.ics(path);
    const mark = fake.mark();
    const s = await settle(update(ctx, { id: uid, scope: "all_series", patch: { recurrence: { count: 6 } } }));
    expect(await visible(ctx), describeStand(fake)).toEqual(
      ["10:00–10:15", "12:00–12:15", "14:00–14:15", "16:00–16:15", "18:00–18:15", "20:00–20:15"].map(
        (time) => `2026-10-19 ${time} Проверка датчиков`,
      ),
    );
    expect(writes(fake, mark)).toEqual(["PUT"]);
    expect(ruleOf(masterOf(fake.ics(path)))).toEqual({ FREQ: "HOURLY", INTERVAL: "2", COUNT: "6" });
    assertPropsPreserved(before, fake.ics(path), { except: ["RRULE"] });
    assertStoredInvariants(fake);
    done(s, fake);
  });

  it.fails("C38: BYSETPOS — recurrence.replace без confirm отклонён, с confirm и etag правило заменено", async () => {
    const { fake, ctx } = makeStand();
    const uid = lastWorkday.uid;
    const path = plant(fake, lastWorkday);
    const original = lines(["2026-10-30", "2026-11-30", "2026-12-31"], "17:00–18:00", "Отчёт за месяц");

    expect(await visible(ctx), describeStand(fake)).toEqual(original);
    // Р4: части правила вне модели видны в unmodeled.
    const main = await readEvent(ctx, calendarA.id, uid);
    expect(main.recurrence?.unmodeled ?? "").toContain("BYSETPOS=-1");

    // replace теряет BYSETPOS — только с confirm (Р4, О11).
    const replacement = { frequency: "monthly", byWeekday: ["-1FR"], count: 3, replace: true };
    const before = fake.ics(path);
    let mark = fake.mark();
    const s1 = await settle(update(ctx, { id: uid, scope: "all_series", patch: { recurrence: replacement } }));
    expectNoWrites(fake, mark);
    expect(fake.ics(path)).toBe(before);
    expect(await visible(ctx)).toEqual(original);
    expect(refusal(s1)).toMatchObject({ needsConfirm: true });

    mark = fake.mark();
    const s2 = await settle(
      update(ctx, { id: uid, scope: "all_series", patch: { recurrence: replacement }, confirm: true, etag: main.etag }),
    );
    expect(await visible(ctx), describeStand(fake)).toEqual(
      lines(["2026-10-30", "2026-11-27", "2026-12-25"], "17:00–18:00", "Отчёт за месяц"),
    );
    expect(writes(fake, mark)).toEqual(["PUT"]);
    const rule = ruleOf(masterOf(fake.ics(path)));
    expect(rule).toMatchObject({ FREQ: "MONTHLY", BYDAY: "-1FR", COUNT: "3" });
    expect(rule).not.toHaveProperty("BYSETPOS");
    assertPropsPreserved(before, fake.ics(path), { except: ["RRULE"] });
    assertStoredInvariants(fake);
    done(s2, fake);
  });

  it.fails("C48: HOURLY — delete this 12:00, затем all_series +1 ч: EXDATE переехал по позиции", async () => {
    const { fake, ctx } = makeStand();
    const uid = hourly.uid;
    const path = plant(fake, hourly);

    let mark = fake.mark();
    const target = await instance(ctx, uid, "2026-10-19 12:00");
    const s1 = await settle(remove(ctx, { id: uid, scope: "this", instanceStart: target.instanceStart, etag: target.etag }));
    expect(await visible(ctx), describeStand(fake)).toEqual([
      "2026-10-19 10:00–10:15 Проверка датчиков",
      "2026-10-19 14:00–14:15 Проверка датчиков",
      "2026-10-19 16:00–16:15 Проверка датчиков",
    ]);
    expect(writes(fake, mark)).toEqual(["PUT"]);
    done(s1, fake);

    // Р1 без recurrence: время суток сдвигается, длительность сохраняется (О8),
    // исключение идёт за своей позицией: 12:00 → 13:00.
    const before = fake.ics(path);
    mark = fake.mark();
    const s2 = await settle(update(ctx, { id: uid, scope: "all_series", patch: { start: "2026-10-19T11:00:00+03:00" } }));
    expect(await visible(ctx), describeStand(fake)).toEqual([
      "2026-10-19 11:00–11:15 Проверка датчиков",
      "2026-10-19 15:00–15:15 Проверка датчиков",
      "2026-10-19 17:00–17:15 Проверка датчиков",
    ]);
    expect(writes(fake, mark)).toEqual(["PUT"]);
    const master = masterOf(fake.ics(path));
    expect(timeValues(master, "EXDATE")).toEqual(["TZID=Europe/Moscow:20261019T130000"]);
    expect(timeValues(master, "DTSTART")).toEqual(["TZID=Europe/Moscow:20261019T110000"]);
    expect(ruleOf(master)).toEqual({ FREQ: "HOURLY", INTERVAL: "2", COUNT: "4" });
    assertPropsPreserved(before, fake.ics(path), { except: ["DTSTART", "DTEND", "EXDATE"] });
    assertStoredInvariants(fake);
    done(s2, fake);
  });

  it.fails("C62: основной компонент с DURATION — update this и t&f без DTEND рядом с DURATION", async () => {
    const { fake, ctx } = makeStand();
    const uid = seeds.c62DurationMaster.uid;
    const path = plant(fake, seeds.c62DurationMaster);

    expect(await visible(ctx), describeStand(fake)).toEqual(lines(SERIES_DAYS, "10:00–10:45", "Разбор задач"));

    // update this 21.10 {start}: длительность сохраняется (О8), конец — DURATION, как у основного (О6).
    let mark = fake.mark();
    let target = await instance(ctx, uid, "2026-10-21 10:00");
    const s1 = await settle(
      update(ctx, { id: uid, scope: "this", instanceStart: target.instanceStart, patch: { start: "2026-10-21T12:00:00+03:00" } }),
    );
    expect(await visible(ctx), describeStand(fake)).toEqual([
      "2026-10-19 10:00–10:45 Разбор задач",
      "2026-10-21 12:00–12:45 Разбор задач [слот 2026-10-21 10:00]",
      ...lines(SERIES_DAYS.slice(2), "10:00–10:45", "Разбор задач"),
    ]);
    expect(writes(fake, mark)).toEqual(["PUT"]);
    const moved = overridesOf(fake.ics(path));
    expect(moved).toHaveLength(1);
    expect(linesOf(moved[0], "DTEND")).toEqual([]);
    expect(linesOf(moved[0], "DURATION")).toEqual(["DURATION:PT45M"]);
    assertStoredInvariants(fake);
    done(s1, fake);

    // t&f 26.10: продолжение — клон основного, тоже с одним DURATION.
    mark = fake.mark();
    target = await instance(ctx, uid, "2026-10-26 10:00");
    const s2 = await settle(
      update(ctx, {
        id: uid,
        scope: "this_and_following",
        instanceStart: target.instanceStart,
        patch: { summary: "Разбор задач (новый формат)" },
      }),
    );
    expect(await visible(ctx), describeStand(fake)).toEqual([
      "2026-10-19 10:00–10:45 Разбор задач",
      "2026-10-21 12:00–12:45 Разбор задач [слот 2026-10-21 10:00]",
      ...lines(SERIES_DAYS.slice(2), "10:00–10:45", "Разбор задач (новый формат)"),
    ]);
    expect(writes(fake, mark)).toEqual(["PUT", "PUT"]);
    expect(fake.objects.size).toBe(2);
    expect(ruleOf(masterOf(fake.ics(path)))).toMatchObject({ COUNT: "2" });
    const [continuationPath] = [...fake.objects.keys()].filter((p) => p !== path);
    const continuation = masterOf(fake.ics(continuationPath));
    expect(linesOf(continuation, "DTEND")).toEqual([]);
    expect(linesOf(continuation, "DURATION")).toEqual(["DURATION:PT45M"]);
    expect(ruleOf(continuation)).toMatchObject({ COUNT: "4" });
    assertStoredInvariants(fake);
    done(s2, fake);
  });

  it.fails("C63: неразбираемые FREQ=FOO и BYDAY=0MO — list_events жив; update — отказ unparsable; delete all_series удаляет", async () => {
    const { fake, ctx } = makeStand();
    plant(fake, seeds.weeklyMoscow);
    const bad = [seeds.c63BadFreq, seeds.c63BadByday];
    const paths = bad.map((s) => plant(fake, s));
    const summaries = ["Правило с неизвестной частотой", "Правило с нулевым днём"];

    // Р4: неразбираемый объект — заглушка с аномалией, остальное читается как обычно.
    const listed = await settle(listAll(ctx));
    const events = listed.ok ? listed.value : [];
    expect(events.filter((e) => e.id === W).map((e) => formatEvent(e))).toEqual(
      lines(SERIES_DAYS, "10:00–11:00", "Планёрка"),
    );
    const stubs = bad.map((s) => events.filter((e) => e.id === s.uid));
    expect(stubs.map((found) => found.map((e) => e.summary))).toEqual(summaries.map((summary) => [summary]));
    for (const [stub] of stubs) {
      expect(wallTime(stub.start, ZONE)).toBe("2026-10-19 10:00");
      expect((stub.anomalies ?? []).some((a) => a.startsWith("unparsable"))).toBe(true);
    }
    done(listed, fake);

    for (const [i, s] of bad.entries()) {
      // Правка неразбираемого — отказ, без записей (О14).
      const before = fake.ics(paths[i]);
      let mark = fake.mark();
      const refused = await settle(update(ctx, { id: s.uid, scope: "all_series", patch: { summary: "Новое имя" } }));
      expectNoWrites(fake, mark);
      expect(fake.ics(paths[i])).toBe(before);
      expect(refusal(refused)).toMatchObject({ code: "unparsable" });

      // delete all_series — без дерева: найти, сверить etag, удалить.
      mark = fake.mark();
      const removed = await settle(remove(ctx, { id: s.uid, scope: "all_series", etag: stubs[i][0].etag }));
      expect(writes(fake, mark)).toEqual(["DELETE"]);
      expect(fake.has(paths[i])).toBe(false);
      done(removed, fake);
    }

    expect(await visible(ctx), describeStand(fake)).toEqual(lines(SERIES_DAYS, "10:00–11:00", "Планёрка"));
  });
});
