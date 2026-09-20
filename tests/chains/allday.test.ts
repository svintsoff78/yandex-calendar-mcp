// Цепочки З05c: встречи на весь день и время без смещения (§6 плана
// переделки, docs/superpowers/plans/2026-09-19-recurring-events-rework.md;
// сценарии — .superpowers/sdd/2026-09-18-yandex-calendar-mcp/wave-b/
// проект-сырое-дерево.recovered.md §6.2, поломки AE9, AE14, AD11, NEW-1,
// NEW-2, J-B6 из wave-a-results.json).
//
// Правила записи для серий на весь день (О4, факт Ж4 в
// docs/yandex-caldav-capabilities.md): RECURRENCE-ID, EXDATE и UNTIL — в форме
// DTSTART, то есть `VALUE=DATE`, а не DATE-TIME в UTC. Адрес экземпляра —
// дата YYYY-MM-DD (Р10). Цепочки не зависят от пояса процесса и обязаны
// давать один и тот же итог в каждом прогоне `npm run test:tz`.
//
// Устройство цепочек — как в foreign.test.ts: только публичные вызовы на
// изменяемом стенде, instanceStart и etag — из выдачи, отказы — по `code`,
// сначала проверки данных, потом исход вызова. Пометка it.fails снята: все
// цепочки этого файла зелёные.
import { assert, describe, expect, it } from "vitest";
import { createEvent, deleteEvent, readEvents, updateEvent } from "../../src/domain/events.js";
import type { CalendarEvent, Context } from "../../src/types.js";
import { makeStand, plant } from "../support/context.js";
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

// ---------------------------------------------------------------------------
// Вызовы (параметры нового интерфейса передаются как есть)
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

function done<T>(outcome: Settled<T>, fake: FakeCaldav): T {
  if (!outcome.ok) {
    assert.fail(
      `вызов отказал: ${errorText(outcome.error)}\nотказы стенда: ${JSON.stringify(fake.rejections)}\n${describeStand(fake)}`,
    );
  }
  return outcome.value;
}

function refusal(outcome: Settled<unknown>): Record<string, unknown> {
  if (outcome.ok) assert.fail(`ожидался отказ, а вызов прошёл: ${JSON.stringify(outcome.value)}`);
  return outcome.error as Record<string, unknown>;
}

function writes(fake: FakeCaldav, mark: number): string[] {
  return fake.writesSince(mark).map((entry) => entry.method);
}

// ---------------------------------------------------------------------------
// Выдача и хранимый текст
// ---------------------------------------------------------------------------

async function listAll(ctx: Context): Promise<CalendarEvent[]> {
  return readEvents(ctx, { from: DEFAULT_WINDOW.from, to: DEFAULT_WINDOW.to });
}

function slotLabel(event: CalendarEvent, zone: string): string {
  const address = event.instanceStart ?? event.start;
  return event.allDay ? address.slice(0, 10) : wallTime(address, zone);
}

/** Ровно один экземпляр uid со слотом label — из настоящей выдачи. */
async function instance(ctx: Context, uid: string, label: string, zone = DEFAULT_ZONE): Promise<CalendarEvent> {
  const events = await listAll(ctx);
  const found = events.filter((event) => event.id === uid && slotLabel(event, zone) === label);
  expect(
    found.length,
    `в выдаче ровно один экземпляр ${uid} со слотом ${label}:\n${events.map((e) => formatEvent(e, { zone })).join("\n")}`,
  ).toBe(1);
  return found[0];
}

function lines(days: string[], time: string, summary: string): string[] {
  return days.map((day) => `${day} ${time} ${summary}`);
}

function vevents(ics: string): RawComponent[] {
  const root = parseRawComponents(ics)[0];
  return root ? root.children.filter((component) => component.name === "VEVENT") : [];
}

function isOverride(component: RawComponent): boolean {
  return component.lines.some((line) => lineName(line) === "RECURRENCE-ID");
}

function masterOf(ics: string): RawComponent {
  const masters = vevents(ics).filter((component) => !isOverride(component));
  expect(masters.length, `в объекте ровно один основной компонент:\n${ics}`).toBe(1);
  return masters[0];
}

function overridesOf(ics: string): RawComponent[] {
  return vevents(ics).filter(isOverride);
}

function linesOf(component: RawComponent, name: string): string[] {
  return component.lines.filter((line) => lineName(line) === name.toUpperCase());
}

function valueColon(line: string): number {
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] === '"') quoted = !quoted;
    if (line[i] === ":" && !quoted) return i;
  }
  return -1;
}

/** Значения времени свойства по одному, с параметрами: "VALUE=DATE:20261026", "TZID=Asia/Yekaterinburg:20261029T120000". */
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

const DAYS = ["2026-10-19", "2026-10-21", "2026-10-26", "2026-10-28", "2026-11-02", "2026-11-04"];

// ---------------------------------------------------------------------------
// Цепочки
// ---------------------------------------------------------------------------

describe("З05c: встречи на весь день и время без смещения", () => {
  it("C19: серия на весь день COUNT=6 — адреса-даты; this 21.10; delete this 26.10; t&f 02.11: VALUE=DATE, COUNT 4 + 2", async () => {
    const { fake, ctx } = makeStand();
    const uid = seeds.allDayWeekly.uid;
    const path = plant(fake, seeds.allDayWeekly);

    expect(await visible(ctx), describeStand(fake)).toEqual(lines(DAYS, "весь день", "Дежурство"));
    // Р10: адрес встречи на весь день — дата, без времени и смещения (AE9).
    expect((await listAll(ctx)).filter((e) => e.id === uid).map((e) => e.instanceStart)).toEqual(DAYS);

    // update this 21.10: RECURRENCE-ID;VALUE=DATE (О4, Ж4), не DATE-TIME в UTC (AE14).
    let before = fake.ics(path);
    let mark = fake.mark();
    let target = await instance(ctx, uid, "2026-10-21");
    const s1 = await settle(update(ctx, { id: uid, scope: "this", instanceStart: target.instanceStart, patch: { summary: "Особое дежурство" } }));
    expect(await visible(ctx), describeStand(fake)).toEqual([
      "2026-10-19 весь день Дежурство",
      "2026-10-21 весь день Особое дежурство",
      ...lines(DAYS.slice(2), "весь день", "Дежурство"),
    ]);
    expect(writes(fake, mark)).toEqual(["PUT"]);
    const [moved] = overridesOf(fake.ics(path));
    expect(overridesOf(fake.ics(path))).toHaveLength(1);
    expect(timeValues(moved, "RECURRENCE-ID")).toEqual(["VALUE=DATE:20261021"]);
    expect(timeValues(moved, "DTSTART")).toEqual(["VALUE=DATE:20261021"]);
    assertStoredInvariants(fake);
    assertPropsPreserved(before, fake.ics(path));
    done(s1, fake);

    // delete this 26.10: EXDATE;VALUE=DATE (AD11).
    before = fake.ics(path);
    mark = fake.mark();
    target = await instance(ctx, uid, "2026-10-26");
    const s2 = await settle(remove(ctx, { id: uid, scope: "this", instanceStart: target.instanceStart, etag: target.etag }));
    expect(await visible(ctx), describeStand(fake)).toEqual([
      "2026-10-19 весь день Дежурство",
      "2026-10-21 весь день Особое дежурство",
      ...lines(DAYS.slice(3), "весь день", "Дежурство"),
    ]);
    expect(writes(fake, mark)).toEqual(["PUT"]);
    expect(timeValues(masterOf(fake.ics(path)), "EXDATE")).toEqual(["VALUE=DATE:20261026"]);
    assertStoredInvariants(fake);
    assertPropsPreserved(before, fake.ics(path));
    done(s2, fake);

    // update this_and_following 02.11: исходная COUNT=4 (позиции 19, 21, 26, 28),
    // продолжение с 02.11 на весь день COUNT=2 (AE9: при поясе процесса
    // Europe/Moscow прежний код давал COUNT=1 и терял 04.11).
    before = fake.ics(path);
    mark = fake.mark();
    target = await instance(ctx, uid, "2026-11-02");
    const s3 = await settle(
      update(ctx, {
        id: uid,
        scope: "this_and_following",
        instanceStart: target.instanceStart,
        patch: { summary: "Дежурство (новый график)" },
      }),
    );
    expect(await visible(ctx), describeStand(fake)).toEqual([
      "2026-10-19 весь день Дежурство",
      "2026-10-21 весь день Особое дежурство",
      "2026-10-28 весь день Дежурство",
      ...lines(DAYS.slice(4), "весь день", "Дежурство (новый график)"),
    ]);
    expect(writes(fake, mark)).toEqual(["PUT", "PUT"]);
    expect(fake.objects.size).toBe(2);
    expect(ruleOf(masterOf(fake.ics(path)))).toMatchObject({ FREQ: "WEEKLY", BYDAY: "MO,WE", COUNT: "4" });
    const [continuationPath] = [...fake.objects.keys()].filter((p) => p !== path);
    const continuation = masterOf(fake.ics(continuationPath));
    expect(timeValues(continuation, "DTSTART")).toEqual(["VALUE=DATE:20261102"]);
    expect(ruleOf(continuation)).toMatchObject({ FREQ: "WEEKLY", BYDAY: "MO,WE", COUNT: "2" });
    expect(timeValues(continuation, "EXDATE")).toEqual([]);
    assertStoredInvariants(fake);
    assertPropsPreserved(before, fake.ics(path), { except: ["RRULE"] });
    done(s3, fake);
  });

  it("C19: серия на весь день с UNTIL=DATE — all_series rename хранит UNTIL побайтово; delete t&f 02.11 пишет UNTIL датой", async () => {
    const { fake, ctx } = makeStand();
    const uid = seeds.allDayWeekly.uid;
    const path = plant(fake, {
      uid,
      about: "allDayWeekly с UNTIL=20261104 вместо COUNT=6",
      ics: seeds.allDayWeekly.ics.replace("RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6", "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20261104"),
    });

    expect(await visible(ctx), describeStand(fake)).toEqual(lines(DAYS, "весь день", "Дежурство"));
    expect((await listAll(ctx)).filter((e) => e.id === uid).map((e) => e.instanceStart)).toEqual(DAYS);

    // all_series rename: RRULE с UNTIL в форме DATE не трогается (О5; AE14 писал UNTIL=20261104T000000Z).
    let before = fake.ics(path);
    let mark = fake.mark();
    const s1 = await settle(update(ctx, { id: uid, scope: "all_series", patch: { summary: "Дежурство по отделу" } }));
    expect(await visible(ctx), describeStand(fake)).toEqual(lines(DAYS, "весь день", "Дежурство по отделу"));
    expect(writes(fake, mark)).toEqual(["PUT"]);
    const body = lastPutBody(fake, path);
    expect(body, "тело PUT").toBeDefined();
    assertPropsPreserved(before, body!, { except: ["SUMMARY"] });
    assertStoredInvariants(fake);
    done(s1, fake);

    // delete this_and_following 02.11: UNTIL — дата раньше 02.11, не позже последней оставшейся (О4).
    before = fake.ics(path);
    mark = fake.mark();
    const target = await instance(ctx, uid, "2026-11-02");
    const s2 = await settle(
      remove(ctx, { id: uid, scope: "this_and_following", instanceStart: target.instanceStart, etag: target.etag }),
    );
    expect(await visible(ctx), describeStand(fake)).toEqual(lines(DAYS.slice(0, 4), "весь день", "Дежурство по отделу"));
    expect(writes(fake, mark)).toEqual(["PUT"]);
    const rule = ruleOf(masterOf(fake.ics(path)));
    expect(rule.UNTIL).toMatch(/^\d{8}$/);
    expect(rule.UNTIL >= "20261028" && rule.UNTIL < "20261102", `UNTIL=${rule.UNTIL}`).toBe(true);
    expect(rule).not.toHaveProperty("COUNT");
    assertStoredInvariants(fake);
    assertPropsPreserved(before, fake.ics(path), { except: ["RRULE"] });
    done(s2, fake);
  });

  it("C36: create и update со start без смещения — стенное время пояса события, не пояса процесса", async () => {
    // Пояс события — не пояс ни одного из трёх прогонов test:tz (UTC,
    // Europe/Moscow, America/New_York) и не пояс календаря по умолчанию.
    const zone = "Asia/Yekaterinburg";
    const { fake, ctx } = makeStand();
    const shown = () => visible(ctx, { zone });

    // create серии: ISO без смещения — стенное время в поясе события (О8, NEW-2).
    let mark = fake.mark();
    const s1 = await settle(
      createEvent(ctx, {
        summary: "Созвон с Екатеринбургом",
        start: "2026-10-22T10:00:00",
        end: "2026-10-22T11:00:00",
        timeZone: zone,
        recurrence: { frequency: "weekly", interval: 1, byWeekday: ["TH"], count: 3 },
      }),
    );
    expect(await shown(), describeStand(fake)).toEqual(
      lines(["2026-10-22", "2026-10-29", "2026-11-05"], "10:00–11:00", "Созвон с Екатеринбургом"),
    );
    expect(writes(fake, mark)).toEqual(["PUT"]);
    const seriesPath = fake.writesSince(mark)[0].path;
    expect(timeValues(masterOf(fake.ics(seriesPath)), "DTSTART")).toEqual([`TZID=${zone}:20261022T100000`]);
    assertStoredInvariants(fake);
    const series = done(s1, fake);

    // update this 29.10 {start без смещения, без end}: 12:00 по Екатеринбургу,
    // длительность час сохранена (О8).
    mark = fake.mark();
    const target = await instance(ctx, series.id, "2026-10-29 10:00", zone);
    const s2 = await settle(
      update(ctx, { id: series.id, scope: "this", instanceStart: target.instanceStart, patch: { start: "2026-10-29T12:00:00" } }),
    );
    expect(await shown(), describeStand(fake)).toEqual([
      "2026-10-22 10:00–11:00 Созвон с Екатеринбургом",
      "2026-10-29 12:00–13:00 Созвон с Екатеринбургом [слот 2026-10-29 10:00]",
      "2026-11-05 10:00–11:00 Созвон с Екатеринбургом",
    ]);
    expect(writes(fake, mark)).toEqual(["PUT"]);
    const [moved] = overridesOf(fake.ics(seriesPath));
    expect(overridesOf(fake.ics(seriesPath))).toHaveLength(1);
    expect(timeValues(moved, "RECURRENCE-ID")).toEqual([`TZID=${zone}:20261029T100000`]);
    expect(timeValues(moved, "DTSTART")).toEqual([`TZID=${zone}:20261029T120000`]);
    assertStoredInvariants(fake);
    done(s2, fake);

    // create и update одиночной встречи: start и end без смещения.
    mark = fake.mark();
    const s3 = await settle(
      createEvent(ctx, { summary: "Обед", start: "2026-10-23T13:00:00", end: "2026-10-23T14:00:00", timeZone: zone }),
    );
    expect(writes(fake, mark)).toEqual(["PUT"]);
    const singlePath = fake.writesSince(mark)[0].path;
    expect(timeValues(masterOf(fake.ics(singlePath)), "DTSTART")).toEqual([`TZID=${zone}:20261023T130000`]);
    const single = done(s3, fake);

    mark = fake.mark();
    const s4 = await settle(update(ctx, { id: single.id, patch: { start: "2026-10-23T14:30:00", end: "2026-10-23T15:30:00" } }));
    expect(await shown(), describeStand(fake)).toEqual([
      "2026-10-22 10:00–11:00 Созвон с Екатеринбургом",
      "2026-10-23 14:30–15:30 Обед",
      "2026-10-29 12:00–13:00 Созвон с Екатеринбургом [слот 2026-10-29 10:00]",
      "2026-11-05 10:00–11:00 Созвон с Екатеринбургом",
    ]);
    expect(writes(fake, mark)).toEqual(["PUT"]);
    expect(timeValues(masterOf(fake.ics(singlePath)), "DTSTART")).toEqual([`TZID=${zone}:20261023T143000`]);
    expect(timeValues(masterOf(fake.ics(singlePath)), "DTEND")).toEqual([`TZID=${zone}:20261023T153000`]);
    assertStoredInvariants(fake);
    done(s4, fake);
  });

  it("C47: весь день — instanceStart «…T21:00:00Z» отклоняется как invalid; «…T00:00:00+00:00» — буквальная дата", async () => {
    const { fake, ctx } = makeStand();
    const uid = seeds.allDayWeekly.uid;
    const path = plant(fake, seeds.allDayWeekly);
    const all = lines(DAYS, "весь день", "Дежурство");

    expect(await visible(ctx), describeStand(fake)).toEqual(all);
    const { etag } = await instance(ctx, uid, "2026-10-21");

    // Момент 20.10 21:00 UTC — это 21.10 00:00 по Москве, но не дата: адрес
    // встречи на весь день — только YYYY-MM-DD или …T00:00:00 (Р10, J-B6).
    // Прежний код при поясе процесса Europe/Moscow удалял по нему 21.10.
    const before = fake.ics(path);
    let mark = fake.mark();
    const s1 = await settle(remove(ctx, { id: uid, scope: "this", instanceStart: "2026-10-20T21:00:00Z", etag }));
    expectNoWrites(fake, mark);
    expect(fake.ics(path)).toBe(before);
    expect(await visible(ctx)).toEqual(all);
    expect(refusal(s1)).toMatchObject({ code: "invalid" });

    mark = fake.mark();
    const s2 = await settle(
      update(ctx, { id: uid, scope: "this", instanceStart: "2026-10-20T21:00:00Z", patch: { summary: "Особое дежурство" } }),
    );
    expectNoWrites(fake, mark);
    expect(fake.ics(path)).toBe(before);
    expect(refusal(s2)).toMatchObject({ code: "invalid" });

    // Прежний формат выдачи «2026-10-21T00:00:00+00:00» — та же дата 21.10 (Р10).
    mark = fake.mark();
    const s3 = await settle(remove(ctx, { id: uid, scope: "this", instanceStart: "2026-10-21T00:00:00+00:00", etag }));
    expect(await visible(ctx), describeStand(fake)).toEqual(lines([DAYS[0], ...DAYS.slice(2)], "весь день", "Дежурство"));
    expect(writes(fake, mark)).toEqual(["PUT"]);
    expect(timeValues(masterOf(fake.ics(path)), "EXDATE")).toEqual(["VALUE=DATE:20261021"]);
    assertStoredInvariants(fake);
    assertPropsPreserved(before, fake.ics(path));
    done(s3, fake);
  });
});
