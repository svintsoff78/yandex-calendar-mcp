import ICAL from "ical.js";
import { describe, expect, it } from "vitest";
import { buildEvent } from "../../src/ical/build.js";
import { GuardError, verifyPlan, type GuardCode } from "../../src/ical/guard.js";
import { parseAddress } from "../../src/ical/instances.js";
import { isUnparsable, loadObject, serializeObject, type CalendarObject } from "../../src/ical/object.js";
import {
  applyFieldPatch,
  inheritFields,
  cloneComponent,
  newTouched,
  overrideFromMaster,
  patchRule,
  setRuleEnd,
  touchMetadata,
} from "../../src/ical/patch.js";
import type { Expectation, PatchField, Touched, WritePlan } from "../../src/ical/plan.js";
import { findSlot, positionsBefore, seriesExtent } from "../../src/ical/slots.js";
import {
  addListValue,
  compareSlotKeys,
  removeListValues,
  setTimeProperty,
  wallDateOf,
  type IcalEnv,
  type SlotKey,
} from "../../src/ical/values.js";
import * as seeds from "../support/seeds.js";

// Независимый предохранитель verifyPlan (О12 а–д плана переделки,
// docs/superpowers/plans/2026-09-19-recurring-events-rework.md, задача З11).
//
// Планы здесь собраны вручную из точечных правок patch.ts и values.ts, без
// планировщика edit.ts: предохранитель проверяет результат, а не повторяет
// логику того, кто его построил. Хорошие планы обязаны проходить, а каждая
// порча из перечня З11 — останавливаться GuardError со своим кодом.
//
// Время — ISO со смещением и секунды Unix: тесты не зависят от пояса
// процесса (npm run test:tz).

const ENV: IcalEnv = { floatingZone: "Europe/Moscow", ownerEmail: "user@yandex.ru" };
/** «Сейчас» для горизонта проверки: 01.10.2026 09:00 UTC. */
const NOW = Date.UTC(2026, 9, 1, 9, 0, 0);
const CRLF = "\r\n";
const UID = "guard-test@yandex.ru";

const MOSCOW = [
  "BEGIN:VTIMEZONE", "TZID:Europe/Moscow", "BEGIN:STANDARD", "TZNAME:MSK", "TZOFFSETFROM:+0300",
  "TZOFFSETTO:+0300", "DTSTART:19700101T000000", "END:STANDARD", "END:VTIMEZONE",
];

/** Пн и Ср 10:00–11:00 МСК с 19.10.2026, COUNT=6: 19, 21, 26, 28 окт., 2, 4 нояб. */
const SERIES = ["DTSTART;TZID=Europe/Moscow:20261019T100000", "DTEND;TZID=Europe/Moscow:20261019T110000",
  "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6", "SUMMARY:Планёрка"];

function vevent(lines: string[], uid = UID): string[] {
  return ["BEGIN:VEVENT", `UID:${uid}`, "DTSTAMP:20261001T090000Z", ...lines, "END:VEVENT"];
}

function calendar(zones: string[], ...events: string[][]): string {
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//guard//RU", ...zones, ...events.flat(), "END:VCALENDAR"]
    .join(CRLF) + CRLF;
}

/** Переопределение серии Europe/Moscow: RID, начало и конец — стенное время МСК. */
function override(rid: string, start: string, end: string, ...extra: string[]): string[] {
  return vevent([`RECURRENCE-ID;TZID=Europe/Moscow:${rid}`, `DTSTART;TZID=Europe/Moscow:${start}`,
    `DTEND;TZID=Europe/Moscow:${end}`, ...extra]);
}

/**
 * Серия SERIES с EXDATE 28.10, переносом 21.10 на 15:00 и переопределением
 * 26.10 без переноса (только заголовок). Видны: 19.10, 21.10 (в 15:00),
 * 26.10, 2.11, 4.11.
 */
const PLANNING = calendar(
  MOSCOW,
  vevent([...SERIES, "EXDATE;TZID=Europe/Moscow:20261028T100000", "SEQUENCE:0", "X-CLIENT-MARK:оставить как есть"]),
  override("20261021T100000", "20261021T150000", "20261021T160000", "SUMMARY:Планёрка (перенос)"),
  override("20261026T100000", "20261026T100000", "20261026T110000", "SUMMARY:Планёрка с гостем"),
);

function load(ics: string): CalendarObject {
  const o = loadObject(ics, ENV);
  if (isUnparsable(o)) throw new Error(`Не разобран: ${o.error}`);
  return o;
}

const key = (o: CalendarObject, instanceStart: string): SlotKey => parseAddress(o, instanceStart);

/** Отметка в touched: имена свойств и подкомпонентов, которые правка тронула. */
function mark(t: Touched, c: ICAL.Component, ...names: string[]): void {
  let set = t.names.get(c);
  if (!set) {
    set = new Set();
    t.names.set(c, set);
  }
  for (const name of names) set.add(name);
}

/** Снимает подкомпонент с отметкой в touched, как это делает правка. */
function dropComponent(t: Touched, parent: ICAL.Component, sub: ICAL.Component): void {
  parent.removeSubcomponent(sub);
  t.components.add(sub);
  mark(t, parent, sub.name);
}

type ExpectInput = Partial<Omit<Expectation, "fields">> & Pick<Expectation, "op" | "scope"> & { fields?: PatchField[] };

function expectation(input: ExpectInput): Expectation {
  const { fields = [], ...rest } = input;
  return { removed: [], ruleChanged: false, datesFixed: false, touched: newTouched(), ...rest, fields: new Set(fields) };
}

function putPlan(o: CalendarObject, input: ExpectInput): WritePlan {
  return { kind: "put", ics: serializeObject(o), expect: expectation(input), removed: [], notices: [] };
}

function deleteObjectPlan(input: ExpectInput): WritePlan {
  return { kind: "delete-object", expect: expectation(input), removed: [], notices: [] };
}

/**
 * Коды проблем, которыми предохранитель остановил план, без повторов, в
 * порядке первого появления; пусто — план прошёл.
 */
function guardCodes(beforeIcs: string, plan: WritePlan, now = NOW): GuardCode[] {
  try {
    verifyPlan(beforeIcs, plan, ENV, { now });
    return [];
  } catch (error) {
    if (!(error instanceof GuardError)) throw error;
    expect(error.problems.length).toBeGreaterThan(0);
    expect(error.code).toBe(error.problems[0].code);
    return [...new Set(error.problems.map((problem) => problem.code))];
  }
}

function guardError(beforeIcs: string, plan: WritePlan): GuardError {
  try {
    verifyPlan(beforeIcs, plan, ENV, { now: NOW });
  } catch (error) {
    if (error instanceof GuardError) return error;
    throw error;
  }
  throw new Error("Ожидался GuardError, а план прошёл.");
}

/** Значение времени, сдвинутое на `hours` стенных часов (в МСК перевода нет). */
function shifted(c: ICAL.Component, name: string, hours: number): ICAL.Time {
  const time = (c.getFirstPropertyValue(name) as ICAL.Time).clone();
  time.adjust(0, hours, 0, 0);
  return time;
}

function overridesOf(o: CalendarObject): ICAL.Component[] {
  return o.root.getAllSubcomponents("vevent").filter((event) => event.hasProperty("recurrence-id"));
}

/** Ключ T: на `seconds` позже. */
const later = (seconds: number) => (k: SlotKey): SlotKey => (k.startsWith("T:") ? `T:${Number(k.slice(2)) + seconds}` : k);

/** delete this: EXDATE на слот `k` и снятие его переопределений — как по таблице §3. */
function excludeSlot(o: CalendarObject, t: Touched, k: SlotKey): void {
  const master = o.master!;
  const slot = findSlot(o, k)!;
  t.properties.add(addListValue(master, "exdate", slot.time));
  mark(t, master, "exdate");
  for (const ref of o.overrides.get(k) ?? []) dropComponent(t, o.root, ref.component);
  touchMetadata(master, NOW, true, ENV, t);
}

// ─────────────────────────────── хорошие планы проходят ───────────────────────────────

describe("verifyPlan: верные планы проходят", () => {
  it("noop ничего не пишет и проходит", () => {
    const plan: WritePlan = { kind: "noop", expect: expectation({ op: "update", scope: "all_series" }), removed: [], notices: [] };
    expect(guardCodes(PLANNING, plan)).toEqual([]);
  });

  it("update this: клон основного на слоте 19.10 с новым заголовком", () => {
    const o = load(PLANNING);
    const t = newTouched();
    const k = key(o, "2026-10-19T10:00:00+03:00");
    const clone = overrideFromMaster(o, findSlot(o, k)!, t);
    applyFieldPatch(clone, { summary: "Планёрка у директора" }, { env: ENV, touched: t });
    touchMetadata(clone, NOW, false, ENV, t);
    expect(guardCodes(PLANNING, putPlan(o, { op: "update", scope: "this", target: k, fields: ["summary"], touched: t }))).toEqual([]);
  });

  it("update this: перенос имеющегося переопределения 26.10 на 17:00", () => {
    const o = load(PLANNING);
    const t = newTouched();
    const k = key(o, "2026-10-26T10:00:00+03:00");
    const own = o.overrides.get(k)![0].component;
    applyFieldPatch(own, { start: "2026-10-26T17:00:00+03:00" }, { env: ENV, touched: t });
    touchMetadata(own, NOW, true, ENV, t);
    expect(guardCodes(PLANNING, putPlan(o, { op: "update", scope: "this", target: k, fields: ["start"], touched: t }))).toEqual([]);
  });

  it("update all_series: заголовок основного и по О7 — у переопределений с прежним заголовком", () => {
    const ics = calendar(
      MOSCOW,
      vevent([...SERIES]),
      override("20261021T100000", "20261021T150000", "20261021T160000", "SUMMARY:Планёрка"),
      override("20261026T100000", "20261026T100000", "20261026T110000", "SUMMARY:Своя тема"),
    );
    const o = load(ics);
    const t = newTouched();
    const master = o.master!;
    const old = cloneComponent(master);
    applyFieldPatch(master, { summary: "Синк" }, { env: ENV, touched: t });
    touchMetadata(master, NOW, false, ENV, t);
    for (const own of overridesOf(o)) {
      if (inheritFields(own, old, master, ["summary"], t).length > 0) touchMetadata(own, NOW, false, ENV, t);
    }
    expect(guardCodes(ics, putPlan(o, { op: "update", scope: "all_series", fields: ["summary"], touched: t }))).toEqual([]);
  });

  it("update all_series: сдвиг на 11:00 по позициям — EXDATE и RID сдвинуты, перенесённая осталась", () => {
    const o = load(PLANNING);
    const t = allSeriesShift(o);
    const plan = putPlan(o, {
      op: "update", scope: "all_series", fields: ["start", "end"], keyMap: later(3600),
      ruleChanged: true, datesFixed: true, tail: { count: 6, lastDate: "2026-11-04" }, touched: t,
    });
    expect(guardCodes(PLANNING, plan)).toEqual([]);
  });

  it("delete this: EXDATE на 2.11", () => {
    const o = load(PLANNING);
    const t = newTouched();
    const k = key(o, "2026-11-02T10:00:00+03:00");
    excludeSlot(o, t, k);
    expect(guardCodes(PLANNING, putPlan(o, { op: "delete", scope: "this", target: k, removed: [k], touched: t }))).toEqual([]);
  });

  it("delete this: встреча с переопределением — EXDATE и снятый компонент", () => {
    const o = load(PLANNING);
    const t = newTouched();
    const k = key(o, "2026-10-21T10:00:00+03:00");
    excludeSlot(o, t, k);
    expect(guardCodes(PLANNING, putPlan(o, { op: "delete", scope: "this", target: k, removed: [k], touched: t }))).toEqual([]);
  });

  it("delete this у серии на весь день и у плавающей серии", () => {
    for (const [seed, address] of [[seeds.allDayWeekly, "2026-10-21"], [seeds.floatingDaily, "2026-10-20T08:00:00+03:00"]] as const) {
      const o = load(seed.ics);
      const t = newTouched();
      const k = key(o, address);
      excludeSlot(o, t, k);
      expect(guardCodes(seed.ics, putPlan(o, { op: "delete", scope: "this", target: k, removed: [k], touched: t }))).toEqual([]);
    }
  });

  it("delete this_and_following 26.10: COUNT по позициям, хвост снят", () => {
    const o = load(PLANNING);
    const b = key(o, "2026-10-26T10:00:00+03:00");
    const t = truncate(o, b);
    expect(guardCodes(PLANNING, putPlan(o, { op: "delete", scope: "this_and_following", target: b, ruleChanged: true,
      tail: { count: 2, lastDate: "2026-10-21" }, touched: t }))).toEqual([]);
  });

  it("delete-object: delete this последней живой встречи; скрытое переопределение пустоте не мешает", () => {
    const ics = calendar(
      MOSCOW,
      vevent(["DTSTART;TZID=Europe/Moscow:20261019T100000", "DTEND;TZID=Europe/Moscow:20261019T110000",
        "RRULE:FREQ=DAILY;COUNT=3", "EXDATE;TZID=Europe/Moscow:20261019T100000,20261020T100000", "SUMMARY:Три дня"]),
      override("20261020T100000", "20261020T120000", "20261020T130000", "SUMMARY:След прошлого удаления"),
    );
    const o = load(ics);
    const k = key(o, "2026-10-21T10:00:00+03:00");
    expect(guardCodes(ics, deleteObjectPlan({ op: "delete", scope: "this", target: k, removed: [k] }))).toEqual([]);
  });

  it("delete-object: delete this_and_following с первой встречи и delete all_series", () => {
    const o = load(PLANNING);
    const first = key(o, "2026-10-19T10:00:00+03:00");
    expect(guardCodes(PLANNING, deleteObjectPlan({ op: "delete", scope: "this_and_following", target: first }))).toEqual([]);
    expect(guardCodes(PLANNING, deleteObjectPlan({ op: "delete", scope: "all_series" }))).toEqual([]);
  });

  it("delete all_series неразбираемого объекта проходит, остальное — отказ unparsable", () => {
    const ics = seeds.c63BadFreq.ics;
    expect(guardCodes(ics, deleteObjectPlan({ op: "delete", scope: "all_series" }))).toEqual([]);
    const plan: WritePlan = { kind: "put", ics, expect: expectation({ op: "update", scope: "all_series" }), removed: [], notices: [] };
    expect(guardCodes(ics, plan)).toEqual(["unparsable"]);
  });

  it("разрез update this_and_following 26.10 с новым заголовком", () => {
    const plan = splitAt26({ summary: "Новый формат" });
    expect(guardCodes(PLANNING, plan)).toEqual([]);
  });

  it("правило из recurrence: протяжённость сверяется с tail", () => {
    const o = load(seeds.weeklyMoscow.ics);
    const t = newTouched();
    patchRule(o.master!.getFirstProperty("rrule")!, { count: 4 }, { env: ENV, touched: t });
    touchMetadata(o.master!, NOW, true, ENV, t);
    const input: ExpectInput = { op: "update", scope: "all_series", fields: ["recurrence"], ruleChanged: true, touched: t };
    expect(guardCodes(seeds.weeklyMoscow.ics, putPlan(o, { ...input, tail: { count: 4, lastDate: "2026-10-28" } }))).toEqual([]);
    expect(guardCodes(seeds.weeklyMoscow.ics, putPlan(o, { ...input, tail: { count: 5, lastDate: "2026-11-02" } })))
      .toContain("extent-mismatch");
    expect(guardCodes(seeds.weeklyMoscow.ics, putPlan(o, input))).toContain("extent-mismatch");
  });

  it("напоминания: управляемые VALARM меняются, чужой AUDIO цел", () => {
    const ics = seeds.richMoscow.ics;
    const o = load(ics);
    const t = newTouched();
    applyFieldPatch(o.master!, { reminders: [{ minutesBefore: 30, method: "display" }] }, { env: ENV, touched: t });
    touchMetadata(o.master!, NOW, false, ENV, t);
    expect(guardCodes(ics, putPlan(o, { op: "update", scope: "all_series", fields: ["reminders"], touched: t }))).toEqual([]);
  });

  it("{timeZone} с теми же моментами: даты в новом поясе другие, но встречи не сдвинулись", () => {
    // 01:00 МСК = 17:00 в Боготе накануне: ключи-моменты прежние.
    const ics = calendar(MOSCOW, vevent(["DTSTART;TZID=Europe/Moscow:20261019T010000",
      "DTEND;TZID=Europe/Moscow:20261019T020000", "RRULE:FREQ=DAILY;COUNT=5", "SUMMARY:Ночной созвон"]));
    const o = load(ics);
    const t = newTouched();
    applyFieldPatch(o.master!, { timeZone: "America/Bogota" }, { env: ENV, touched: t });
    touchMetadata(o.master!, NOW, true, ENV, t);
    expect(String(o.master!.getFirstProperty("dtstart")!.jCal[3])).toBe("2026-10-18T17:00:00");
    expect(guardCodes(ics, putPlan(o, { op: "update", scope: "all_series", fields: ["timeZone"], ruleChanged: true,
      datesFixed: true, touched: t }))).toEqual([]);
  });

  it("сдвиг бесконечной серии на 11:00 по позициям", () => {
    const ics = calendar(MOSCOW, vevent(["DTSTART;TZID=Europe/Moscow:20261019T100000",
      "DTEND;TZID=Europe/Moscow:20261019T110000", "RRULE:FREQ=DAILY", "SUMMARY:Каждый день"]));
    const o = load(ics);
    const t = newTouched();
    applyFieldPatch(o.master!, { start: "2026-10-19T11:00:00", end: "2026-10-19T12:00:00" }, { env: ENV, touched: t });
    touchMetadata(o.master!, NOW, true, ENV, t);
    expect(guardCodes(ics, putPlan(o, { op: "update", scope: "all_series", fields: ["start", "end"], keyMap: later(3600),
      ruleChanged: true, datesFixed: true, touched: t }))).toEqual([]);
  });

  it("чужой объект: прежние аномалии и нарушения форм, которых план не касается, терпятся", () => {
    const ics = calendar(
      MOSCOW,
      vevent([...SERIES, "DURATION:PT1H"]), // DTEND вместе с DURATION у основного
      vevent(["RECURRENCE-ID:20261021T070000Z", "DTSTART;TZID=Europe/Berlin:20261021T090000",
        "DTEND;TZID=Europe/Berlin:20261021T100000", "SUMMARY:RID в UTC, время в поясе без VTIMEZONE"]),
      override("20261026T100000", "20261026T120000", "20261026T130000", "SUMMARY:Дубль 1", "SEQUENCE:1"),
      override("20261026T100000", "20261026T123000", "20261026T133000", "SUMMARY:Дубль 2", "SEQUENCE:2"),
    );
    const o = load(ics);
    expect(o.anomalies.map((anomaly) => anomaly.code)).toContain("duplicate-override");
    const t = newTouched();
    const k = key(o, "2026-11-02T10:00:00+03:00");
    excludeSlot(o, t, k);
    expect(guardCodes(ics, putPlan(o, { op: "delete", scope: "this", target: k, removed: [k], touched: t }))).toEqual([]);
  });

  it("чужой пустой объект (все встречи удалены): правка заголовка не считается опустошением", () => {
    const ics = calendar(MOSCOW, vevent(["DTSTART;TZID=Europe/Moscow:20261019T100000", "DTEND;TZID=Europe/Moscow:20261019T110000",
      "RRULE:FREQ=DAILY;COUNT=2", "EXDATE;TZID=Europe/Moscow:20261019T100000,20261020T100000", "SUMMARY:Зомби"]));
    const o = load(ics);
    const t = newTouched();
    applyFieldPatch(o.master!, { summary: "Всё ещё зомби" }, { env: ENV, touched: t });
    expect(guardCodes(ics, putPlan(o, { op: "update", scope: "all_series", fields: ["summary"], touched: t }))).toEqual([]);
  });
});

// ─────────────────────────────── порча из перечня З11 ───────────────────────────────

describe("verifyPlan: порча останавливается", () => {
  it("пересборка объекта из доменной модели через buildEvent", () => {
    const ics = seeds.richMoscow.ics;
    const rebuilt = buildEvent({
      id: seeds.richMoscow.uid,
      summary: "Созвон по проекту (новое имя)",
      start: "2026-10-21T12:00:00+03:00",
      end: "2026-10-21T13:00:00+03:00",
      timeZone: "Europe/Moscow",
      allDay: false,
      recurrence: { frequency: "weekly", interval: 1, byWeekday: ["WE"], count: 5 },
      reminders: [{ minutesBefore: 15, method: "display" }],
      attendees: [{ email: "petrov@example.com", status: "accepted" }, { email: "anna@example.com", status: "accepted" }],
    }, { now: new Date(NOW) });
    const plan: WritePlan = {
      kind: "put",
      ics: rebuilt.ics,
      expect: expectation({ op: "update", scope: "all_series", fields: ["summary"] }),
      removed: [],
      notices: [],
    };
    const codes = guardCodes(ics, plan);
    expect(codes).toContain("untouched-changed");
    expect(codes).toContain("exdate-lifted"); // 28.10 воскресла
    expect(codes).toContain("meeting-lost"); // RDATE 30.10 пропала
    expect(codes).toContain("alarm-lost"); // AUDIO пропал
  });

  it("снятый EXDATE: удаление 4.11 заодно сняло EXDATE 28.10", () => {
    const o = load(PLANNING);
    const t = newTouched();
    const k = key(o, "2026-11-04T10:00:00+03:00");
    removeListValues(o.master!, "exdate", new Set([key(o, "2026-10-28T10:00:00+03:00")]), o);
    excludeSlot(o, t, k);
    const error = guardError(PLANNING, putPlan(o, { op: "delete", scope: "this", target: k, removed: [k], touched: t }));
    expect([...new Set(error.problems.map((p) => p.code))]).toEqual(["exdate-lifted"]);
    expect(error.message).toContain("2026-10-28T10:00:00+03:00");
  });

  it("лишний ключ: удаление 4.11 заодно добавило RDATE 5.11", () => {
    const o = load(PLANNING);
    const t = newTouched();
    const k = key(o, "2026-11-04T10:00:00+03:00");
    excludeSlot(o, t, k);
    const extra = (o.master!.getFirstPropertyValue("dtstart") as ICAL.Time).clone();
    extra.adjust(17, 0, 0, 0); // 5.11
    t.properties.add(addListValue(o.master!, "rdate", extra));
    mark(t, o.master!, "rdate");
    expect(guardCodes(PLANNING, putPlan(o, { op: "delete", scope: "this", target: k, removed: [k], touched: t })))
      .toEqual(["meeting-added"]);
  });

  it("убранная встреча осталась: removed называет 2.11, а EXDATE не поставлен", () => {
    const o = load(PLANNING);
    const t = newTouched();
    touchMetadata(o.master!, NOW, false, ENV, t);
    const k = key(o, "2026-11-02T10:00:00+03:00");
    expect(guardCodes(PLANNING, putPlan(o, { op: "delete", scope: "this", target: k, removed: [k], touched: t })))
      .toEqual(["meeting-added"]);
  });

  it("встреча пропала без removed: EXDATE не на тот слот", () => {
    const o = load(PLANNING);
    const t = newTouched();
    excludeSlot(o, t, key(o, "2026-11-04T10:00:00+03:00"));
    const k = key(o, "2026-11-02T10:00:00+03:00");
    const codes = guardCodes(PLANNING, putPlan(o, { op: "delete", scope: "this", target: k, removed: [k], touched: t }));
    expect(codes).toContain("meeting-lost");
    expect(codes).toContain("meeting-added");
  });

  it("сдвиг даты при datesFixed: ключи согласованы, но встречи уехали на день", () => {
    const ics = calendar(MOSCOW, vevent(["DTSTART;TZID=Europe/Moscow:20261019T100000",
      "DTEND;TZID=Europe/Moscow:20261019T110000", "RRULE:FREQ=DAILY;COUNT=5", "SUMMARY:Утро"]));
    const o = load(ics);
    const t = newTouched();
    applyFieldPatch(o.master!, { start: "2026-10-20T11:00:00", end: "2026-10-20T12:00:00" }, { env: ENV, touched: t });
    touchMetadata(o.master!, NOW, true, ENV, t);
    const plan = putPlan(o, { op: "update", scope: "all_series", fields: ["start", "end"], keyMap: later(86_400 + 3600),
      ruleChanged: true, datesFixed: true, tail: { count: 5, lastDate: "2026-10-24" }, touched: t });
    expect(guardCodes(ics, plan)).toEqual(["date-shifted"]);
  });

  it("без recurrence даты стоят и без флага datesFixed", () => {
    const ics = calendar(MOSCOW, vevent(["DTSTART;TZID=Europe/Moscow:20261019T100000",
      "DTEND;TZID=Europe/Moscow:20261019T110000", "RRULE:FREQ=DAILY;COUNT=5", "SUMMARY:Утро"]));
    const o = load(ics);
    const t = newTouched();
    applyFieldPatch(o.master!, { start: "2026-10-20T11:00:00", end: "2026-10-20T12:00:00" }, { env: ENV, touched: t });
    touchMetadata(o.master!, NOW, true, ENV, t);
    const plan = putPlan(o, { op: "update", scope: "all_series", fields: ["start", "end"], keyMap: later(86_400 + 3600),
      ruleChanged: true, datesFixed: false, tail: { count: 5, lastDate: "2026-10-24" }, touched: t });
    expect(guardCodes(ics, plan)).toContain("date-shifted");
  });

  it("delete-object при живой оторванной встрече", () => {
    const ics = calendar(
      MOSCOW,
      vevent(["DTSTART;TZID=Europe/Moscow:20261019T100000", "DTEND;TZID=Europe/Moscow:20261019T110000",
        "RRULE:FREQ=DAILY;COUNT=3", "EXDATE;TZID=Europe/Moscow:20261019T100000,20261020T100000", "SUMMARY:Три дня"]),
      override("20261020T120000", "20261020T120000", "20261020T130000", "SUMMARY:Отдельная встреча"),
    );
    const o = load(ics);
    const k = key(o, "2026-10-21T10:00:00+03:00");
    const error = guardError(ics, deleteObjectPlan({ op: "delete", scope: "this", target: k, removed: [k] }));
    expect([...new Set(error.problems.map((p) => p.code))]).toEqual(["not-empty"]);
    expect(error.message).toContain("2026-10-20T12:00:00+03:00");
  });

  it("delete-object у YEARLY;INTERVAL=2 и у YEARLY 29.02 после delete this ближайшей встречи", () => {
    for (const [start, address] of [["20261019T100000", "2026-10-19T10:00:00+03:00"], ["20280229T100000", "2028-02-29T10:00:00+03:00"]]) {
      const rule = start.startsWith("2026") ? "RRULE:FREQ=YEARLY;INTERVAL=2" : "RRULE:FREQ=YEARLY";
      const ics = calendar(MOSCOW, vevent([`DTSTART;TZID=Europe/Moscow:${start}`, `DTEND;TZID=Europe/Moscow:${start.replace("T10", "T11")}`,
        rule, "SUMMARY:Редкая"]));
      const o = load(ics);
      const k = key(o, address);
      expect(guardCodes(ics, deleteObjectPlan({ op: "delete", scope: "this", target: k, removed: [k] }))).toEqual(["not-empty"]);
    }
  });

  it("delete-object при живых встречах: t&f не с первой встречи, update", () => {
    const o = load(PLANNING);
    const b = key(o, "2026-10-26T10:00:00+03:00");
    expect(guardCodes(PLANNING, deleteObjectPlan({ op: "delete", scope: "this_and_following", target: b }))).toEqual(["not-empty"]);
    expect(guardCodes(PLANNING, deleteObjectPlan({ op: "update", scope: "all_series" }))).toEqual(["plan-shape"]);
  });

  it("потеря последней встречи за горизонтом: UNTIL не пересчитан при сдвиге на 11:00", () => {
    // Пн 10:00 МСК, последняя — 30.10.2028 10:00 (07:00Z), далеко за горизонтом NOW + 400 дней.
    const ics = calendar(MOSCOW, vevent(["DTSTART;TZID=Europe/Moscow:20261019T100000",
      "DTEND;TZID=Europe/Moscow:20261019T110000", "RRULE:FREQ=WEEKLY;UNTIL=20281030T070000Z", "SUMMARY:Понедельник"]));
    const shift = (recalculate: boolean) => {
      const o = load(ics);
      const t = newTouched();
      applyFieldPatch(o.master!, { start: "2026-10-19T11:00:00", end: "2026-10-19T12:00:00" }, { env: ENV, touched: t });
      if (recalculate) setRuleEnd(o.master!.getFirstProperty("rrule")!, { until: "2028-10-30T08:00:00Z" }, t);
      touchMetadata(o.master!, NOW, true, ENV, t);
      return putPlan(o, { op: "update", scope: "all_series", fields: ["start", "end"], keyMap: later(3600),
        ruleChanged: true, datesFixed: true, tail: { count: 107, lastDate: "2028-10-30" }, touched: t });
    };
    expect(guardCodes(ics, shift(true))).toEqual([]);
    expect(guardCodes(ics, shift(false))).toEqual(["extent-mismatch"]);
  });

  it("расхождение числа позиций конечной серии: сдвиг времени заодно поменял COUNT", () => {
    const o = load(PLANNING);
    const t = allSeriesShift(o);
    setRuleEnd(o.master!.getFirstProperty("rrule")!, { count: 7 }, t);
    const plan = putPlan(o, { op: "update", scope: "all_series", fields: ["start", "end"], keyMap: later(3600),
      ruleChanged: true, datesFixed: true, tail: { count: 7, lastDate: "2026-11-09" }, touched: t });
    const codes = guardCodes(PLANNING, plan);
    expect(codes).toContain("extent-mismatch");
    expect(codes).toContain("meeting-added"); // 9.11 внутри горизонта
  });

  it("DTEND вместе с DURATION у клона", () => {
    const ics = seeds.c62DurationMaster.ics;
    const o = load(ics);
    const t = newTouched();
    const k = key(o, "2026-10-21T10:00:00+03:00");
    const clone = overrideFromMaster(o, findSlot(o, k)!, t);
    applyFieldPatch(clone, { summary: "Особый разбор" }, { env: ENV, touched: t });
    const end = (clone.getFirstPropertyValue("dtstart") as ICAL.Time).clone();
    end.adjust(0, 1, 0, 0);
    setTimeProperty(clone, "dtend", end);
    touchMetadata(clone, NOW, false, ENV, t);
    expect(guardCodes(ics, putPlan(o, { op: "update", scope: "this", target: k, fields: ["summary"], touched: t })))
      .toEqual(["invariant"]);
  });

  it("снятый чужой VALARM: правка напоминаний заодно сняла AUDIO", () => {
    const ics = seeds.richMoscow.ics;
    const o = load(ics);
    const t = newTouched();
    applyFieldPatch(o.master!, { reminders: [{ minutesBefore: 30, method: "display" }] }, { env: ENV, touched: t });
    const audio = o.master!.getAllSubcomponents("valarm").find((alarm) => alarm.getFirstPropertyValue("action") === "AUDIO")!;
    dropComponent(t, o.master!, audio);
    touchMetadata(o.master!, NOW, false, ENV, t);
    expect(guardCodes(ics, putPlan(o, { op: "update", scope: "all_series", fields: ["reminders"], touched: t })))
      .toEqual(["alarm-lost"]);
  });

  it("потеря переопределения: правка серии сняла перенос 21.10", () => {
    const o = load(PLANNING);
    const t = newTouched();
    applyFieldPatch(o.master!, { summary: "Синк" }, { env: ENV, touched: t });
    touchMetadata(o.master!, NOW, false, ENV, t);
    dropComponent(t, o.root, o.overrides.get(key(o, "2026-10-21T10:00:00+03:00"))![0].component);
    const codes = guardCodes(PLANNING, putPlan(o, { op: "update", scope: "all_series", fields: ["summary"], touched: t }));
    expect(codes).toContain("override-lost");
  });

  it("потеря переопределения при сдвиге: RID 26.10 не сдвинут", () => {
    const o = load(PLANNING);
    const t = allSeriesShift(o, { skipRid: "20261026T100000" });
    const plan = putPlan(o, { op: "update", scope: "all_series", fields: ["start", "end"], keyMap: later(3600),
      ruleChanged: true, datesFixed: true, tail: { count: 6, lastDate: "2026-11-04" }, touched: t });
    expect(guardCodes(PLANNING, plan)).toContain("override-lost");
  });

  it("перенесённая встреча сдвинута вместе с серией", () => {
    const o = load(PLANNING);
    const t = allSeriesShift(o, { moveMoved: true });
    const plan = putPlan(o, { op: "update", scope: "all_series", fields: ["start", "end"], keyMap: later(3600),
      ruleChanged: true, datesFixed: true, tail: { count: 6, lastDate: "2026-11-04" }, touched: t });
    expect(guardCodes(PLANNING, plan)).toEqual(["moved-shifted"]);
  });

  it("неперенесённая встреча отстала от серии", () => {
    const o = load(PLANNING);
    const t = allSeriesShift(o, { keepStart: "20261026T100000" });
    const plan = putPlan(o, { op: "update", scope: "all_series", fields: ["start", "end"], keyMap: later(3600),
      ruleChanged: true, datesFixed: true, tail: { count: 6, lastDate: "2026-11-04" }, touched: t });
    expect(guardCodes(PLANNING, plan)).toEqual(["moved-shifted"]);
  });

  it("EXDATE не сдвинут вместе с серией — встреча 28.10 воскресла", () => {
    const o = load(PLANNING);
    const t = allSeriesShift(o, { keepExdate: true });
    const plan = putPlan(o, { op: "update", scope: "all_series", fields: ["start", "end"], keyMap: later(3600),
      ruleChanged: true, datesFixed: true, tail: { count: 6, lastDate: "2026-11-04" }, touched: t });
    expect(guardCodes(PLANNING, plan)).toContain("exdate-lifted");
  });

  it("keyMap сливает встречи: две прежние — в один ключ", () => {
    const o = load(PLANNING);
    const t = allSeriesShift(o);
    const plan = putPlan(o, { op: "update", scope: "all_series", fields: ["start", "end"],
      keyMap: () => key(o, "2026-10-19T11:00:00+03:00"), ruleChanged: true, datesFixed: true, touched: t });
    expect(guardCodes(PLANNING, plan)).toContain("meeting-lost");
  });

  it("keyMap бросает — план не проверить", () => {
    const o = load(PLANNING);
    const t = allSeriesShift(o);
    const plan = putPlan(o, { op: "update", scope: "all_series", fields: ["start", "end"],
      keyMap: () => {
        throw new Error("нет такого ключа");
      }, ruleChanged: true, datesFixed: true, touched: t });
    expect(guardCodes(PLANNING, plan)).toContain("plan-shape");
  });

  it("UNTIL не пересчитан, а tail план посчитал по испорченному дереву — ловит своя протяжённость", () => {
    const ics = calendar(MOSCOW, vevent(["DTSTART;TZID=Europe/Moscow:20261019T100000",
      "DTEND;TZID=Europe/Moscow:20261019T110000", "RRULE:FREQ=WEEKLY;UNTIL=20281030T070000Z", "SUMMARY:Понедельник"]));
    const o = load(ics);
    const t = newTouched();
    applyFieldPatch(o.master!, { start: "2026-10-19T11:00:00", end: "2026-10-19T12:00:00" }, { env: ENV, touched: t });
    touchMetadata(o.master!, NOW, true, ENV, t);
    const plan = putPlan(o, { op: "update", scope: "all_series", fields: ["start", "end"], keyMap: later(3600),
      ruleChanged: true, datesFixed: true, tail: { count: 106, lastDate: "2028-10-23" }, touched: t });
    expect(guardCodes(ics, plan)).toEqual(["extent-mismatch"]);
  });

  it("бесконечная серия стала конечной за горизонтом при сдвиге времени", () => {
    const ics = calendar(MOSCOW, vevent(["DTSTART;TZID=Europe/Moscow:20261019T100000",
      "DTEND;TZID=Europe/Moscow:20261019T110000", "RRULE:FREQ=DAILY", "SUMMARY:Каждый день"]));
    const o = load(ics);
    const t = newTouched();
    applyFieldPatch(o.master!, { start: "2026-10-19T11:00:00", end: "2026-10-19T12:00:00" }, { env: ENV, touched: t });
    setRuleEnd(o.master!.getFirstProperty("rrule")!, { count: 1000 }, t); // до 2029 года — за горизонтом
    touchMetadata(o.master!, NOW, true, ENV, t);
    expect(guardCodes(ics, putPlan(o, { op: "update", scope: "all_series", fields: ["start", "end"], keyMap: later(3600),
      ruleChanged: true, datesFixed: true, touched: t }))).toEqual(["extent-mismatch"]);
  });

  it("снятый EXDATE далеко за «сейчас + 400 дней» виден: горизонт идёт от последнего явного ключа", () => {
    const ics = calendar(MOSCOW, vevent(["DTSTART;TZID=Europe/Moscow:20261019T100000",
      "DTEND;TZID=Europe/Moscow:20261019T110000", "RRULE:FREQ=DAILY", "EXDATE;TZID=Europe/Moscow:20290110T100000",
      "SUMMARY:Каждый день"]));
    const o = load(ics);
    const t = newTouched();
    removeListValues(o.master!, "exdate", () => true, o);
    const k = key(o, "2026-10-20T10:00:00+03:00");
    excludeSlot(o, t, k);
    expect(guardCodes(ics, putPlan(o, { op: "delete", scope: "this", target: k, removed: [k], touched: t }))).toEqual(["exdate-lifted"]);
  });

  it("редкая серия: 5 слотов за горизонтом ловят испорченный INTERVAL", () => {
    const ics = calendar(MOSCOW, vevent(["DTSTART;TZID=Europe/Moscow:20261019T100000",
      "DTEND;TZID=Europe/Moscow:20261019T110000", "RRULE:FREQ=YEARLY;INTERVAL=2", "SUMMARY:Раз в два года"]));
    const o = load(ics);
    const t = newTouched();
    applyFieldPatch(o.master!, { start: "2026-10-19T11:00:00", end: "2026-10-19T12:00:00" }, { env: ENV, touched: t });
    patchRule(o.master!.getFirstProperty("rrule")!, { interval: 4 }, { env: ENV, touched: t });
    touchMetadata(o.master!, NOW, true, ENV, t);
    expect(guardCodes(ics, putPlan(o, { op: "update", scope: "all_series", fields: ["start", "end"], keyMap: later(3600),
      ruleChanged: true, datesFixed: true, touched: t }))).toEqual(["meeting-lost"]);
  });

  it("правка серии сняла скрытое переопределение (след прошлого удаления)", () => {
    const o = load(PLANNING);
    const t = newTouched();
    applyFieldPatch(o.master!, { summary: "Синк" }, { env: ENV, touched: t });
    touchMetadata(o.master!, NOW, false, ENV, t);
    // PLANNING + скрытое переопределение под EXDATE 28.10: его снимает только delete this по его адресу.
    const ics = PLANNING.replace("END:VCALENDAR", [...override("20261028T100000", "20261028T120000", "20261028T130000",
      "SUMMARY:След"), "END:VCALENDAR"].join(CRLF));
    const p = load(ics);
    const u = newTouched();
    applyFieldPatch(p.master!, { summary: "Синк" }, { env: ENV, touched: u });
    const hidden = p.overrides.get(key(p, "2026-10-28T10:00:00+03:00"))![0].component;
    expect(p.roles.get(hidden)?.role).toBe("hidden");
    dropComponent(u, p.root, hidden);
    expect(guardCodes(ics, putPlan(p, { op: "update", scope: "all_series", fields: ["summary"], touched: u }))).toEqual(["override-lost"]);
    expect(guardCodes(PLANNING, putPlan(o, { op: "update", scope: "all_series", fields: ["summary"], touched: t }))).toEqual([]);
  });

  it("снятие компонента без отметки в touched.components", () => {
    const o = load(PLANNING);
    const t = newTouched();
    const k = key(o, "2026-10-21T10:00:00+03:00");
    const own = o.overrides.get(k)![0].component;
    t.properties.add(addListValue(o.master!, "exdate", findSlot(o, k)!.time));
    mark(t, o.master!, "exdate");
    o.root.removeSubcomponent(own); // без отметки
    expect(guardCodes(PLANNING, putPlan(o, { op: "delete", scope: "this", target: k, removed: [k], touched: t })))
      .toEqual(["untouched-changed"]);
  });

  it("новый дубль RECURRENCE-ID на месте снятого: число аномалий то же, но дубль новый", () => {
    const ics = calendar(
      MOSCOW,
      vevent([...SERIES]),
      override("20261026T100000", "20261026T120000", "20261026T130000", "SUMMARY:Дубль 1"),
      override("20261026T100000", "20261026T123000", "20261026T133000", "SUMMARY:Дубль 2"),
    );
    const o = load(ics);
    const t = newTouched();
    const k = key(o, "2026-10-26T10:00:00+03:00");
    excludeSlot(o, t, k); // delete this снимает оба компонента дубля
    const k2 = key(o, "2026-11-02T10:00:00+03:00");
    overrideFromMaster(o, findSlot(o, k2)!, t);
    overrideFromMaster(o, findSlot(o, k2)!, t);
    const codes = guardCodes(ics, putPlan(o, { op: "delete", scope: "this", target: k, removed: [k], touched: t }));
    expect(codes).toContain("invariant");
  });

  it("клон основного потерял свойство вне модели", () => {
    const o = load(PLANNING);
    const t = newTouched();
    const k = key(o, "2026-10-19T10:00:00+03:00");
    const clone = overrideFromMaster(o, findSlot(o, k)!, t);
    applyFieldPatch(clone, { summary: "Особая" }, { env: ENV, touched: t });
    clone.removeProperty("x-client-mark");
    const error = guardError(PLANNING, putPlan(o, { op: "update", scope: "this", target: k, fields: ["summary"], touched: t }));
    expect([...new Set(error.problems.map((p) => p.code))]).toEqual(["untouched-changed"]);
    expect(error.message).toContain("X-CLIENT-MARK");
  });
});

// ─────────────────────────────── О12б: вне touched — прежнее ───────────────────────────────

describe("verifyPlan: всё вне touched и вне операции прежнее (О12б)", () => {
  it("изменение без отметки в touched", () => {
    const o = load(PLANNING);
    applyFieldPatch(o.master!, { summary: "Синк" }, { env: ENV });
    const codes = guardCodes(PLANNING, putPlan(o, { op: "update", scope: "all_series", fields: ["summary"] }));
    expect(codes).toEqual(["untouched-changed"]);
  });

  it("свойство вне модели и вне патча изменено, хоть и отмечено", () => {
    const o = load(PLANNING);
    const t = newTouched();
    applyFieldPatch(o.master!, { summary: "Синк" }, { env: ENV, touched: t });
    o.master!.getFirstProperty("x-client-mark")!.setValue("испорчено");
    mark(t, o.master!, "x-client-mark");
    const error = guardError(PLANNING, putPlan(o, { op: "update", scope: "all_series", fields: ["summary"], touched: t }));
    expect([...new Set(error.problems.map((p) => p.code))]).toEqual(["untouched-changed"]);
    expect(error.message).toContain("X-CLIENT-MARK");
  });

  it("update this меняет основной компонент", () => {
    const o = load(PLANNING);
    const t = newTouched();
    const k = key(o, "2026-10-19T10:00:00+03:00");
    applyFieldPatch(o.master!, { summary: "Вся серия" }, { env: ENV, touched: t });
    expect(guardCodes(PLANNING, putPlan(o, { op: "update", scope: "this", target: k, fields: ["summary"], touched: t })))
      .toEqual(["untouched-changed"]);
  });

  it("свойство календаря и VTIMEZONE неизменны", () => {
    const o = load(PLANNING);
    const t = newTouched();
    o.root.getFirstProperty("prodid")!.setValue("-//другой//RU");
    mark(t, o.root, "prodid");
    expect(guardCodes(PLANNING, putPlan(o, { op: "update", scope: "all_series", touched: t }))).toEqual(["untouched-changed"]);

    const p = load(PLANNING);
    const zone = p.root.getFirstSubcomponent("vtimezone")!;
    dropComponent(t, p.root, zone);
    const codes = guardCodes(PLANNING, putPlan(p, { op: "update", scope: "all_series", touched: t }));
    expect(codes).toContain("untouched-changed");
    expect(codes).toContain("invariant"); // TZID без VTIMEZONE
  });

  it("клон без отметки в touched.components и клон не на слоте", () => {
    const o = load(PLANNING);
    const t = newTouched();
    const k = key(o, "2026-10-19T10:00:00+03:00");
    const clone = overrideFromMaster(o, findSlot(o, k)!); // без touched
    applyFieldPatch(clone, { summary: "Особая" }, { env: ENV, touched: t });
    expect(guardCodes(PLANNING, putPlan(o, { op: "update", scope: "this", target: k, fields: ["summary"], touched: t })))
      .toContain("untouched-changed");

    const p = load(PLANNING);
    const u = newTouched();
    const wrong = overrideFromMaster(p, findSlot(p, key(p, "2026-11-02T10:00:00+03:00"))!, u);
    applyFieldPatch(wrong, { summary: "Не та встреча" }, { env: ENV, touched: u });
    expect(guardCodes(PLANNING, putPlan(p, { op: "update", scope: "this", target: k, fields: ["summary"], touched: u })))
      .toContain("untouched-changed");
  });
});

// ─────────────────────────────── О12а: инварианты ───────────────────────────────

describe("verifyPlan: инварианты объекта (О12а)", () => {
  it("EXDATE не в форме DTSTART (в UTC у серии с TZID)", () => {
    const o = load(PLANNING);
    const t = newTouched();
    const k = key(o, "2026-11-02T10:00:00+03:00");
    const utc = ICAL.Time.fromData({ year: 2026, month: 11, day: 2, hour: 7, minute: 0, second: 0, isDate: false }, ICAL.Timezone.utcTimezone);
    t.properties.add(addListValue(o.master!, "exdate", utc));
    mark(t, o.master!, "exdate");
    touchMetadata(o.master!, NOW, true, ENV, t);
    expect(guardCodes(PLANNING, putPlan(o, { op: "delete", scope: "this", target: k, removed: [k], touched: t })))
      .toEqual(["invariant"]);
  });

  it("новый дубль EXDATE и новый дубль RECURRENCE-ID", () => {
    const o = load(PLANNING);
    const t = newTouched();
    const k = key(o, "2026-10-28T10:00:00+03:00");
    t.properties.add(addListValue(o.master!, "exdate", findSlot(o, k)!.time));
    mark(t, o.master!, "exdate");
    expect(guardCodes(PLANNING, putPlan(o, { op: "delete", scope: "this", target: k, touched: t }))).toContain("invariant");

    const p = load(PLANNING);
    const u = newTouched();
    const k26 = key(p, "2026-10-26T10:00:00+03:00");
    overrideFromMaster(p, findSlot(p, k26)!, u);
    expect(guardCodes(PLANNING, putPlan(p, { op: "update", scope: "this", target: k26, fields: ["summary"], touched: u })))
      .toContain("invariant");
  });

  it("UNTIL раньше DTSTART и DTEND не позже DTSTART", () => {
    const o = load(seeds.weeklyMoscow.ics);
    const t = newTouched();
    setRuleEnd(o.master!.getFirstProperty("rrule")!, { until: "2026-10-18T00:00:00Z" }, t);
    touchMetadata(o.master!, NOW, true, ENV, t);
    expect(guardCodes(seeds.weeklyMoscow.ics, putPlan(o, { op: "update", scope: "all_series", fields: ["recurrence"],
      ruleChanged: true, touched: t }))).toContain("invariant");

    const p = load(seeds.singleMoscow.ics);
    const u = newTouched();
    setTimeProperty(p.master!, "dtend", p.master!.getFirstPropertyValue("dtstart") as ICAL.Time);
    mark(u, p.master!, "dtend");
    expect(guardCodes(seeds.singleMoscow.ics, putPlan(p, { op: "update", scope: "all_series", fields: ["end"], touched: u })))
      .toEqual(["invariant"]);
  });

  it("два основных компонента и чужой UID", () => {
    const o = load(seeds.singleMoscow.ics);
    const t = newTouched();
    const copy = cloneComponent(o.master!);
    o.root.addSubcomponent(copy);
    t.components.add(copy);
    mark(t, o.root, "vevent");
    expect(guardCodes(seeds.singleMoscow.ics, putPlan(o, { op: "update", scope: "all_series", touched: t }))).toContain("invariant");

    const p = load(seeds.singleMoscow.ics);
    const u = newTouched();
    p.master!.getFirstProperty("uid")!.setValue("другой@yandex.ru");
    mark(u, p.master!, "uid");
    expect(guardCodes(seeds.singleMoscow.ics, putPlan(p, { op: "update", scope: "all_series", touched: u }))).toContain("invariant");
  });

  it("запись в объект с блокирующей аномалией (два основных) — отказ blocked", () => {
    const ics = calendar(MOSCOW, vevent([...SERIES]), vevent(["DTSTART;TZID=Europe/Moscow:20261020T100000",
      "DTEND;TZID=Europe/Moscow:20261020T110000", "SUMMARY:Второй основной"]));
    const o = load(ics);
    const t = newTouched();
    applyFieldPatch(o.master!, { summary: "Синк" }, { env: ENV, touched: t });
    expect(guardCodes(ics, putPlan(o, { op: "update", scope: "all_series", fields: ["summary"], touched: t }))).toEqual(["blocked"]);
  });
});

// ─────────────────────────────── форма плана, пустота, усечение ───────────────────────────────

describe("verifyPlan: форма плана, пустой объект, усечение", () => {
  it("noop с убранными встречами и разрез у удаления — plan-shape", () => {
    const noop: WritePlan = { kind: "noop", expect: expectation({ op: "delete", scope: "this", removed: ["T:1"] }), removed: [], notices: [] };
    expect(guardCodes(PLANNING, noop)).toEqual(["plan-shape"]);
    const plan = splitAt26({ summary: "Новый формат" });
    const wrong: WritePlan = { ...plan, expect: { ...plan.expect, op: "delete" } };
    expect(guardCodes(PLANNING, wrong)).toEqual(["plan-shape"]);
    const put: WritePlan = { kind: "put", ics: PLANNING, expect: expectation({ op: "delete", scope: "all_series" }), removed: [], notices: [] };
    expect(guardCodes(PLANNING, put)).toEqual(["plan-shape"]);
  });

  it("update this_and_following одним put при встречах до границы — plan-shape", () => {
    const o = load(PLANNING);
    const t = newTouched();
    applyFieldPatch(o.master!, { summary: "Синк" }, { env: ENV, touched: t });
    const b = key(o, "2026-10-26T10:00:00+03:00");
    expect(guardCodes(PLANNING, putPlan(o, { op: "update", scope: "this_and_following", target: b, fields: ["summary"], touched: t })))
      .toEqual(["plan-shape"]);
  });

  it("запись оставила пустой объект — empty-left", () => {
    const ics = calendar(MOSCOW, vevent(["DTSTART;TZID=Europe/Moscow:20261019T100000", "DTEND;TZID=Europe/Moscow:20261019T110000",
      "RRULE:FREQ=DAILY;COUNT=2", "EXDATE;TZID=Europe/Moscow:20261019T100000", "SUMMARY:Два дня"]));
    const o = load(ics);
    const t = newTouched();
    const k = key(o, "2026-10-20T10:00:00+03:00");
    excludeSlot(o, t, k);
    expect(guardCodes(ics, putPlan(o, { op: "delete", scope: "this", target: k, removed: [k], touched: t }))).toEqual(["empty-left"]);
  });

  it("усечение на позицию дальше — truncation-mismatch; переопределение за границей осталось — тоже", () => {
    const o = load(PLANNING);
    const b = key(o, "2026-10-26T10:00:00+03:00");
    const t = truncate(o, b, { count: 3 });
    expect(guardCodes(PLANNING, putPlan(o, { op: "delete", scope: "this_and_following", target: b, ruleChanged: true, touched: t })))
      .toContain("truncation-mismatch");

    const p = load(PLANNING);
    const u = truncate(p, b, { keepOverrides: true });
    expect(guardCodes(PLANNING, putPlan(p, { op: "delete", scope: "this_and_following", target: b, ruleChanged: true, touched: u })))
      .toContain("truncation-mismatch");
  });

  it("разрез: продолжение короче хвоста и без переопределения 26.10", () => {
    expect(guardCodes(PLANNING, splitAt26({ summary: "Новый формат" }, { count: 3 }))).toContain("extent-mismatch");
    expect(guardCodes(PLANNING, splitAt26({ summary: "Новый формат" }, { dropOverride: true }))).toContain("override-lost");
    expect(guardCodes(PLANNING, splitAt26({ summary: "Новый формат" }, { sameUid: true }))).toContain("invariant");
  });

  it("разрез: основной продолжения потерял свойство вне модели; граница не та", () => {
    expect(guardCodes(PLANNING, splitAt26({ summary: "Новый формат" }, { dropMark: true }))).toEqual(["untouched-changed"]);
    const plan = splitAt26({ summary: "Новый формат" });
    if (plan.kind !== "split") throw new Error("ожидался разрез");
    expect(guardCodes(PLANNING, { ...plan, boundary: "T:1" })).toEqual(["plan-shape"]);
  });

  it("разрез: продолжение в новом VCALENDAR — можно; чужое описание общего пояса — нет", () => {
    const plan = splitAt26({ summary: "Новый формат" });
    if (plan.kind !== "split") throw new Error("ожидался разрез");
    const fresh = plan.continuation.ics.replace("PRODID:-//test//guard//RU", "PRODID:-//yandex-calendar-mcp//RU");
    expect(guardCodes(PLANNING, { ...plan, continuation: { ...plan.continuation, ics: fresh } })).toEqual([]);
    const otherZone = plan.continuation.ics.replace("TZNAME:MSK", "TZNAME:+03");
    expect(guardCodes(PLANNING, { ...plan, continuation: { ...plan.continuation, ics: otherZone } })).toEqual(["untouched-changed"]);
  });

  it("delete this: цель убирается и без removed", () => {
    const o = load(PLANNING);
    const t = newTouched();
    const k = key(o, "2026-11-02T10:00:00+03:00");
    excludeSlot(o, t, k);
    expect(guardCodes(PLANNING, putPlan(o, { op: "delete", scope: "this", target: k, touched: t }))).toEqual([]);
    const p = load(PLANNING);
    const u = newTouched();
    touchMetadata(p.master!, NOW, false, ENV, u);
    expect(guardCodes(PLANNING, putPlan(p, { op: "delete", scope: "this", target: k, touched: u }))).toEqual(["meeting-added"]);
  });

  it("прочие компоненты календаря неизменны", () => {
    const ics = calendar(MOSCOW, vevent([...SERIES]), ["BEGIN:VJOURNAL", "UID:journal@yandex.ru", "DTSTAMP:20261001T090000Z",
      "SUMMARY:Заметка", "END:VJOURNAL"]);
    const o = load(ics);
    const t = newTouched();
    applyFieldPatch(o.master!, { summary: "Синк" }, { env: ENV, touched: t });
    expect(guardCodes(ics, putPlan(o, { op: "update", scope: "all_series", fields: ["summary"], touched: t }))).toEqual([]);
    dropComponent(t, o.root, o.root.getFirstSubcomponent("vjournal")!);
    expect(guardCodes(ics, putPlan(o, { op: "update", scope: "all_series", fields: ["summary"], touched: t }))).toEqual(["untouched-changed"]);
  });

  it("серия длиннее предела прохода — series-too-long", () => {
    // Ежеминутная серия с 01.01.2026: до горизонта — больше 200 000 слотов.
    const ics = calendar(MOSCOW, vevent(["DTSTART;TZID=Europe/Moscow:20260101T000000", "DURATION:PT1M",
      "RRULE:FREQ=MINUTELY", "SUMMARY:Тик"]));
    const o = load(ics);
    const t = newTouched();
    applyFieldPatch(o.master!, { summary: "Так" }, { env: ENV, touched: t });
    expect(guardCodes(ics, putPlan(o, { op: "update", scope: "all_series", fields: ["summary"], touched: t }))).toEqual(["series-too-long"]);
  }, 60_000);
});

// ─────────────────────────────── бюджет ───────────────────────────────

describe("verifyPlan: бюджет", () => {
  it("5 объектов по 20 000 позиций проверяются за разумное время", () => {
    const rules = [
      ["19900101T100000", "RRULE:FREQ=DAILY;COUNT=20000"],
      ["19900101T100000", "RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=20000"],
      ["20000103T100000", "RRULE:FREQ=DAILY;INTERVAL=2;COUNT=20000"],
      ["19800101T100000", "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;COUNT=20000"],
      ["20260101T100000", "RRULE:FREQ=HOURLY;INTERVAL=3;COUNT=20000"],
    ];
    const started = performance.now();
    for (const [start, rule] of rules) {
      const ics = calendar(MOSCOW, vevent([`DTSTART;TZID=Europe/Moscow:${start}`, "DURATION:PT30M", rule,
        "EXDATE;TZID=Europe/Moscow:20261019T100000", "SUMMARY:Долгая серия"]));
      const o = load(ics);
      // tail заставляет пройти обе серии целиком (О12д): 20 000 позиций до и после.
      const extent = seriesExtent(o);
      if (extent.kind !== "finite" || !extent.last) throw new Error("ожидалась конечная серия");
      const tail = { count: extent.count, lastDate: wallDateOf(extent.last.time, ENV) };
      expect(tail.count).toBe(20_000);
      const t = newTouched();
      applyFieldPatch(o.master!, { summary: "Долгая серия, новое имя" }, { env: ENV, touched: t });
      touchMetadata(o.master!, NOW, false, ENV, t);
      expect(guardCodes(ics, putPlan(o, { op: "update", scope: "all_series", fields: ["summary"], tail, touched: t }))).toEqual([]);
    }
    // Проход линейный: квадратичный перебор 20 000 позиций занял бы минуты.
    expect(performance.now() - started).toBeLessThan(30_000);
  }, 120_000);
});

// ─────────────────────────────── построители планов ───────────────────────────────

interface ShiftOptions {
  /** Не сдвигать RID переопределения с этим стенным RECURRENCE-ID. */
  skipRid?: string;
  /** Сдвинуть и перенесённую встречу (ошибка). */
  moveMoved?: boolean;
  /** Не сдвигать начало неперенесённой встречи с этим RID (ошибка). */
  keepStart?: string;
  /** Не сдвигать EXDATE (ошибка). */
  keepExdate?: boolean;
}

/**
 * all_series `{start: 11:00, end: 12:00}` у PLANNING по Р1: основной — на
 * 11:00, EXDATE и RID — на час по позиции, неперенесённые встречи — за
 * серией, перенесённая 21.10 15:00 остаётся.
 */
function allSeriesShift(o: CalendarObject, options: ShiftOptions = {}): Touched {
  const t = newTouched();
  const master = o.master!;
  const oldExdates = removeExdates(o, options.keepExdate === true);
  applyFieldPatch(master, { start: "2026-10-19T11:00:00", end: "2026-10-19T12:00:00" }, { env: ENV, touched: t });
  for (const time of oldExdates) {
    time.adjust(0, 1, 0, 0);
    t.properties.add(addListValue(master, "exdate", time));
  }
  if (oldExdates.length > 0) mark(t, master, "exdate");
  touchMetadata(master, NOW, true, ENV, t);

  for (const own of overridesOf(o)) {
    const ridRaw = String(own.getFirstProperty("recurrence-id")!.jCal[3]).replace(/[-:]/g, "");
    const ridStart = (own.getFirstPropertyValue("recurrence-id") as ICAL.Time).toString();
    const start = (own.getFirstPropertyValue("dtstart") as ICAL.Time).toString();
    const moved = ridStart !== start;
    if (options.skipRid !== ridRaw) {
      setTimeProperty(own, "recurrence-id", shifted(own, "recurrence-id", 1));
      mark(t, own, "recurrence-id");
    }
    if ((!moved || options.moveMoved) && options.keepStart !== ridRaw) {
      setTimeProperty(own, "dtstart", shifted(own, "dtstart", 1));
      setTimeProperty(own, "dtend", shifted(own, "dtend", 1));
      mark(t, own, "dtstart", "dtend");
    }
    touchMetadata(own, NOW, true, ENV, t);
  }
  return t;
}

// EXDATE основного снимаются (их копии возвращаются для записи со сдвигом);
// keep — оставить как есть и ничего не возвращать.
function removeExdates(o: CalendarObject, keep: boolean): ICAL.Time[] {
  if (keep) return [];
  const master = o.master!;
  const times = master.getAllProperties("exdate").flatMap((p) => (p.getValues() as ICAL.Time[]).map((v) => v.clone()));
  removeListValues(master, "exdate", () => true, o);
  return times;
}

interface TruncateOptions {
  count?: number;
  keepOverrides?: boolean;
}

/** Усечение серии перед границей `b` (таблица §3, t&f): COUNT по позициям, хвост снят. */
function truncate(o: CalendarObject, b: SlotKey, options: TruncateOptions = {}): Touched {
  const t = newTouched();
  const master = o.master!;
  setRuleEnd(master.getFirstProperty("rrule")!, { count: options.count ?? positionsBefore(o, b) }, t);
  const dropped = removeListValues(master, "exdate", (k) => compareSlotKeys(k, b) >= 0, o);
  if (dropped.length > 0) mark(t, master, "exdate");
  if (!options.keepOverrides) {
    for (const [k, refs] of o.overrides) {
      if (compareSlotKeys(k, b) >= 0) for (const ref of refs) dropComponent(t, o.root, ref.component);
    }
  }
  touchMetadata(master, NOW, true, ENV, t);
  return t;
}

interface SplitOptions {
  count?: number;
  dropOverride?: boolean;
  sameUid?: boolean;
  /** Снять у основного продолжения свойство вне модели (ошибка). */
  dropMark?: boolean;
}

/**
 * Разрез PLANNING на 26.10 (update this_and_following с полями `patch`):
 * усечённый исходный объект и продолжение с новым UID — клон исходного с
 * DTSTART = 26.10, COUNT = 6 − 2, EXDATE 28.10 и переопределением 26.10.
 */
function splitAt26(patch: { summary: string }, options: SplitOptions = {}): WritePlan {
  const o = load(PLANNING);
  const b = key(o, "2026-10-26T10:00:00+03:00");
  const t = truncate(o, b);

  const uid = options.sameUid ? UID : "ycm-0123456789abcdef0123456789abcdef";
  const c = load(PLANNING);
  const cm = c.master!;
  for (const [k, refs] of c.overrides) {
    for (const ref of refs) {
      if (compareSlotKeys(k, b) < 0 || (options.dropOverride && k === b)) c.root.removeSubcomponent(ref.component);
      else ref.component.getFirstProperty("uid")!.setValue(uid);
    }
  }
  cm.getFirstProperty("uid")!.setValue(uid);
  const slot = findSlot(c, b)!;
  const start = slot.time.clone();
  const end = start.clone();
  end.adjust(0, 1, 0, 0);
  setTimeProperty(cm, "dtstart", start);
  setTimeProperty(cm, "dtend", end);
  setRuleEnd(cm.getFirstProperty("rrule")!, { count: options.count ?? 4 });
  for (const name of ["sequence", "created"]) {
    for (const p of cm.getAllProperties(name)) cm.removeProperty(p);
  }
  applyFieldPatch(cm, patch, { env: ENV });
  if (options.dropMark) cm.removeProperty("x-client-mark");
  touchMetadata(cm, NOW, false, ENV);

  return {
    kind: "split",
    continuation: { uid, ics: serializeObject(c) },
    truncated: { ics: serializeObject(o) },
    boundary: b,
    expect: expectation({ op: "update", scope: "this_and_following", target: b, fields: ["summary"], ruleChanged: true,
      tail: { count: 4, lastDate: "2026-11-04" }, touched: t }),
    removed: [],
    notices: [],
  };
}
