import ICAL from "ical.js";
import { describe, expect, it } from "vitest";
import { buildEvent } from "../../src/ical/build.js";
import { GuardError, verifyPlan, type GuardCode, type GuardOptions } from "../../src/ical/guard.js";
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
import type { EventPatch, Expectation, Loss, PatchField, RecurrencePatch, Touched, WritePlan } from "../../src/ical/plan.js";
import { findSlot, iterateSlots, positionsBefore, seriesExtent } from "../../src/ical/slots.js";
import {
  addListValue,
  compareSlotKeys,
  removeListValues,
  setRuleDict,
  setTimeProperty,
  wallDateOf,
  type IcalEnv,
  type RuleValue,
  type SlotKey,
} from "../../src/ical/values.js";
import * as seeds from "../support/seeds.js";

// Предохранитель записи verifyPlan (src/ical/guard.ts) на планах, собранных
// вручную из точечных правок patch.ts и values.ts, без планировщика edit.ts:
// предохранитель проверяет результат, а не повторяет логику того, кто план
// построил. Хорошие планы обязаны проходить, каждая порча — останавливаться
// GuardError.
//
// Набор пережил замену перечня разрешений разностной проверкой: здесь
// осталось то, что разностный предохранитель ловит (часто другим кодом —
// он говорит о встречах, а не о свойствах). Проверки, которые новый замысел
// сознательно не делает, — точная арифметика времени клонов и
// переопределений (О6–О8), наследование их полей (О7), сверка RRULE по
// частям (Р4), инварианты формы объекта (О12а) и данные вне модели — сняты
// вместе с их тестами; разбор снятого — в сообщении коммита замены.
// Собственный набор разностной проверки — tests/ical/guard.diff.test.ts.
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

/** План put; `losses` — убранные встречи в ответе (plan.removed). */
function putPlan(o: CalendarObject, input: ExpectInput, losses: Loss[] = []): WritePlan {
  return { kind: "put", ics: serializeObject(o), expect: expectation(input), removed: losses, notices: [] };
}

function deleteObjectPlan(input: ExpectInput, losses: Loss[] = []): WritePlan {
  return { kind: "delete-object", expect: expectation(input), removed: losses, notices: [] };
}

/** Строка ответа об убранной встрече (plan.removed) с адресом по Р10. */
function lossOf(instanceStart: string): Loss {
  return { instanceStart, start: instanceStart, summary: "", reason: "убрана с подтверждением" };
}

/**
 * Коды проблем, которыми предохранитель остановил план, без повторов, в
 * порядке первого появления; пусто — план прошёл.
 */
function guardCodes(beforeIcs: string, plan: WritePlan, now = NOW): GuardCode[] {
  return guardCodesWith(beforeIcs, plan, { now });
}

function guardCodesWith(beforeIcs: string, plan: WritePlan, options: GuardOptions, env: IcalEnv = ENV): GuardCode[] {
  try {
    verifyPlan(beforeIcs, plan, env, { now: NOW, ...options });
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

// ─────────────────────────────── порча останавливается ───────────────────────────────

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
    expect(codes).toContain("meeting-added"); // 28.10 воскресла: снятый EXDATE виден как лишняя встреча
    expect(codes).toContain("meeting-lost"); // RDATE 30.10 пропала
  });

  it("снятый EXDATE: удаление 4.11 заодно сняло EXDATE 28.10", () => {
    const o = load(PLANNING);
    const t = newTouched();
    const k = key(o, "2026-11-04T10:00:00+03:00");
    removeListValues(o.master!, "exdate", new Set([key(o, "2026-10-28T10:00:00+03:00")]), o);
    excludeSlot(o, t, k);
    const error = guardError(PLANNING, putPlan(o, { op: "delete", scope: "this", target: k, removed: [k], touched: t }));
    // Снятый EXDATE виден как встреча, которой не было: своего кода у него нет.
    expect([...new Set(error.problems.map((p) => p.code))]).toEqual(["meeting-added"]);
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
      .toContain("meeting-added");
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
    // Непересчитанный UNTIL срезает последние встречи серии: они и пропали.
    expect(guardCodes(ics, shift(false))).toEqual(["meeting-lost"]);
  });

  it("расхождение числа позиций конечной серии: сдвиг времени заодно поменял COUNT", () => {
    const o = load(PLANNING);
    const t = allSeriesShift(o);
    setRuleEnd(o.master!.getFirstProperty("rrule")!, { count: 7 }, t);
    const plan = putPlan(o, { op: "update", scope: "all_series", fields: ["start", "end"], keyMap: later(3600),
      ruleChanged: true, datesFixed: true, tail: { count: 7, lastDate: "2026-11-09" }, touched: t });
    const codes = guardCodes(PLANNING, plan);
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
    // Нарушение формы видно по встрече: её конец стал другим, а патч времени не называл.
    expect(guardCodes(ics, putPlan(o, { op: "update", scope: "this", target: k, fields: ["summary"], touched: t })))
      .toEqual(["time-changed"]);
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

  it("EXDATE не сдвинут вместе с серией — встреча 28.10 воскресла", () => {
    const o = load(PLANNING);
    const t = allSeriesShift(o, { keepExdate: true });
    const plan = putPlan(o, { op: "update", scope: "all_series", fields: ["start", "end"], keyMap: later(3600),
      ruleChanged: true, datesFixed: true, tail: { count: 6, lastDate: "2026-11-04" }, touched: t });
    expect(guardCodes(PLANNING, plan)).toContain("meeting-added");
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
    // Пары по ключу не находится ни у одной встречи: сдвинутая серия целиком
    // читается как пропажа и появление — план отвергается.
    expect(guardCodes(PLANNING, plan)).toContain("meeting-lost");
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
    expect(guardCodes(ics, plan)).toEqual(["meeting-lost"]);
  });

  it("редкая серия: 5 слотов за горизонтом ловят испорченный INTERVAL", () => {
    const ics = calendar(MOSCOW, vevent(["DTSTART;TZID=Europe/Moscow:20261019T100000",
      "DTEND;TZID=Europe/Moscow:20261019T110000", "RRULE:FREQ=YEARLY;INTERVAL=2", "SUMMARY:Раз в два года"]));
    const o = load(ics);
    const t = newTouched();
    applyFieldPatch(o.master!, { start: "2026-10-19T11:00:00", end: "2026-10-19T12:00:00" }, { env: ENV, touched: t });
    patchRule(o.master!.getFirstProperty("rrule")!, { interval: 4 }, { env: ENV, touched: t });
    touchMetadata(o.master!, NOW, true, ENV, t);
    const codes = guardCodes(ics, putPlan(o, { op: "update", scope: "all_series", fields: ["start", "end"], keyMap: later(3600),
      ruleChanged: true, datesFixed: true, touched: t }));
    expect(codes).toContain("meeting-lost");
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

});

// ─────────────────────────────── О12б: вне touched — прежнее ───────────────────────────────

describe("verifyPlan: всё вне touched и вне операции прежнее (О12б)", () => {
  it("изменение без отметки в touched", () => {
    const o = load(PLANNING);
    applyFieldPatch(o.master!, { summary: "Синк" }, { env: ENV });
    const codes = guardCodes(PLANNING, putPlan(o, { op: "update", scope: "all_series", fields: ["summary"] }));
    expect(codes).toEqual(["untouched-changed"]);
  });

  it("update this меняет основной компонент", () => {
    const o = load(PLANNING);
    const t = newTouched();
    const k = key(o, "2026-10-19T10:00:00+03:00");
    applyFieldPatch(o.master!, { summary: "Вся серия" }, { env: ENV, touched: t });
    expect(guardCodes(PLANNING, putPlan(o, { op: "update", scope: "this", target: k, fields: ["summary"], touched: t })))
      .toEqual(["untouched-changed"]);
  });

  it("клон не на слоте: правка одной встречи изменила другую", () => {
    const k = key(load(PLANNING), "2026-10-19T10:00:00+03:00");
    const p = load(PLANNING);
    const u = newTouched();
    const wrong = overrideFromMaster(p, findSlot(p, key(p, "2026-11-02T10:00:00+03:00"))!, u);
    applyFieldPatch(wrong, { summary: "Не та встреча" }, { env: ENV, touched: u });
    expect(guardCodes(PLANNING, putPlan(p, { op: "update", scope: "this", target: k, fields: ["summary"], touched: u })))
      .toContain("untouched-changed");
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
    // Запись слово в слово прочитанным текстом — тоже не та форма плана;
    // заодно видно, что ни одна встреча delete all_series не убрана.
    expect(guardCodes(PLANNING, put)).toContain("plan-shape");
  });

  it("update this_and_following одним put меняет и встречи до границы — untouched-changed", () => {
    const o = load(PLANNING);
    const t = newTouched();
    applyFieldPatch(o.master!, { summary: "Синк" }, { env: ENV, touched: t });
    const b = key(o, "2026-10-26T10:00:00+03:00");
    // Правка хвоста одним put задевает голову серии: её встречи не в области правки.
    expect(guardCodes(PLANNING, putPlan(o, { op: "update", scope: "this_and_following", target: b, fields: ["summary"], touched: t })))
      .toEqual(["untouched-changed"]);
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

  it("усечение на позицию дальше: встреча, которую убирали, осталась", () => {
    const o = load(PLANNING);
    const b = key(o, "2026-10-26T10:00:00+03:00");
    const t = truncate(o, b, { count: 3 });
    expect(guardCodes(PLANNING, putPlan(o, { op: "delete", scope: "this_and_following", target: b, ruleChanged: true, touched: t })))
      .toContain("meeting-added");

    // А переопределение, оставшееся за концом усечённой серии, встречей быть
    // перестало: это след удаления, как EXDATE, и усечение его вправе оставить.
    const p = load(PLANNING);
    const u = truncate(p, b, { keepOverrides: true });
    expect(guardCodes(PLANNING, putPlan(p, { op: "delete", scope: "this_and_following", target: b, ruleChanged: true, touched: u })))
      .toEqual([]);
  });

  it("разрез: продолжение короче хвоста и без переопределения 26.10", () => {
    expect(guardCodes(PLANNING, splitAt26({ summary: "Новый формат" }, { count: 3 }))).toContain("meeting-lost");
    expect(guardCodes(PLANNING, splitAt26({ summary: "Новый формат" }, { dropOverride: true }))).toContain("override-lost");
    expect(guardCodes(PLANNING, splitAt26({ summary: "Новый формат" }, { sameUid: true }))).toContain("invariant");
  });

  it("разрез: продолжение в новом VCALENDAR — можно", () => {
    const plan = splitAt26({ summary: "Новый формат" });
    if (plan.kind !== "split") throw new Error("ожидался разрез");
    const fresh = plan.continuation.ics.replace("PRODID:-//test//guard//RU", "PRODID:-//yandex-calendar-mcp//RU");
    expect(guardCodes(PLANNING, { ...plan, continuation: { ...plan.continuation, ics: fresh } })).toEqual([]);
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
    expect(guardCodes(PLANNING, putPlan(p, { op: "delete", scope: "this", target: k, touched: u }))).toContain("meeting-added");
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

  it("густая серия: и правка заголовка, и удаление встречи сверяются — окно подрезано упором", () => {
    // Ежеминутная серия с 01.01.2026: до горизонта — больше 200 000 слотов,
    // поэтому окно кончается на первой встрече сверх упора.
    const ics = calendar(MOSCOW, vevent(["DTSTART;TZID=Europe/Moscow:20260101T000000", "DURATION:PT1M",
      "RRULE:FREQ=MINUTELY", "SUMMARY:Тик"]));
    const o = load(ics);
    const t = newTouched();
    applyFieldPatch(o.master!, { summary: "Так" }, { env: ENV, touched: t });
    expect(guardCodes(ics, putPlan(o, { op: "update", scope: "all_series", fields: ["summary"], touched: t }))).toEqual([]);
    const p = load(ics);
    const u = newTouched();
    const k = key(p, "2026-01-01T00:05:00+03:00");
    excludeSlot(p, u, k);
    expect(guardCodes(ics, putPlan(p, { op: "delete", scope: "this", target: k, removed: [k], touched: u }))).toEqual([]);
    // А закрытая сверх цели встреча видна и в такой серии.
    const q = load(ics);
    const w = newTouched();
    excludeSlot(q, w, k);
    excludeSlot(q, w, key(q, "2026-01-01T00:06:00+03:00"));
    expect(guardCodes(ics, putPlan(q, { op: "delete", scope: "this", target: k, removed: [k], touched: w }))).toEqual(["meeting-lost"]);
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

// ─────────────────────────────── правка по ревью ───────────────────────────────

/** Видимые встречи PLANNING (адреса по Р10): 21.10 перенесена на 15:00, 28.10 закрыта. */
const PLANNING_DATES = ["2026-10-19", "2026-10-21", "2026-10-26", "2026-11-02", "2026-11-04"];

describe("verifyPlan: removed ограничен операцией, а не словом планировщика", () => {
  it("delete this 2.11 удалением объекта со всеми живыми встречами в removed — not-empty", () => {
    const o = load(PLANNING);
    const all = PLANNING_DATES.map((date) => key(o, `${date}T10:00:00+03:00`));
    // Внутреннее removed пропажу не оправдывает: пользователю о ней не сказали.
    const codes = guardCodes(PLANNING, deleteObjectPlan({ op: "delete", scope: "this", target: all[3], removed: all }));
    expect(codes).toContain("not-empty");
  });

  it("delete this 2.11 заодно закрыл 4.11 и назвал её только в removed — meeting-lost", () => {
    const o = load(PLANNING);
    const t = newTouched();
    const k2 = key(o, "2026-11-02T10:00:00+03:00");
    const k4 = key(o, "2026-11-04T10:00:00+03:00");
    excludeSlot(o, t, k2);
    excludeSlot(o, t, k4);
    const codes = guardCodes(PLANNING, putPlan(o, { op: "delete", scope: "this", target: k2, removed: [k2, k4], touched: t }));
    expect(codes).toContain("meeting-lost");
  });

  it("сдвиг all_series на 11:00 заодно закрыл 2.11 и назвал её только в removed — meeting-lost", () => {
    const o = load(PLANNING);
    const t = allSeriesShift(o);
    const extra = (o.master!.getFirstPropertyValue("dtstart") as ICAL.Time).clone();
    extra.adjust(14, 0, 0, 0); // 2.11 11:00
    t.properties.add(addListValue(o.master!, "exdate", extra));
    const k2 = key(o, "2026-11-02T10:00:00+03:00");
    const codes = guardCodes(PLANNING, putPlan(o, { op: "update", scope: "all_series", fields: ["start", "end"], keyMap: later(3600),
      ruleChanged: true, datesFixed: true, removed: [k2], tail: { count: 6, lastDate: "2026-11-04" }, touched: t }));
    expect(codes).toContain("meeting-lost");
  });

  it("delete-object для t&f 26.10 с removed [19.10, 21.10] — not-empty", () => {
    const o = load(PLANNING);
    const b = key(o, "2026-10-26T10:00:00+03:00");
    const removed = [key(o, "2026-10-19T10:00:00+03:00"), key(o, "2026-10-21T10:00:00+03:00")];
    const codes = guardCodes(PLANNING, deleteObjectPlan({ op: "delete", scope: "this_and_following", target: b, removed }));
    expect(codes).toContain("not-empty");
  });

  it("delete this удалением объекта: цель и скрытые переопределения в removed допустимы", () => {
    const ics = calendar(
      MOSCOW,
      vevent(["DTSTART;TZID=Europe/Moscow:20261019T100000", "DTEND;TZID=Europe/Moscow:20261019T110000",
        "RRULE:FREQ=DAILY;COUNT=3", "EXDATE;TZID=Europe/Moscow:20261019T100000,20261020T100000", "SUMMARY:Три дня"]),
      override("20261020T100000", "20261020T120000", "20261020T130000", "SUMMARY:След прошлого удаления"),
    );
    const o = load(ics);
    const k = key(o, "2026-10-21T10:00:00+03:00");
    const hidden = key(o, "2026-10-20T10:00:00+03:00");
    expect(guardCodes(ics, deleteObjectPlan({ op: "delete", scope: "this", target: k, removed: [k, hidden] }))).toEqual([]);
  });

  it("fields у удаления не ослабляют проверку: delete this с fields [recurrence] и лишним EXDATE 4.11 — meeting-lost", () => {
    const o = load(PLANNING);
    const t = newTouched();
    const k2 = key(o, "2026-11-02T10:00:00+03:00");
    excludeSlot(o, t, k2);
    excludeSlot(o, t, key(o, "2026-11-04T10:00:00+03:00"));
    const codes = guardCodes(PLANNING, putPlan(o, { op: "delete", scope: "this", target: k2, removed: [k2], fields: ["recurrence"], touched: t }));
    expect(codes).toContain("meeting-lost");
  });

  it("delete this одиночного события записью put не убирает встречу; удаление объекта проходит", () => {
    const ics = seeds.singleMoscow.ics;
    const o = load(ics);
    const t = newTouched();
    touchMetadata(o.master!, NOW, false, ENV, t);
    const k = key(o, "2026-10-20T15:00:00+03:00");
    // Записью такое удаление не делается: встреча осталась бы стоять.
    expect(guardCodes(ics, putPlan(o, { op: "delete", scope: "this", target: k, removed: [k], touched: t }))).toContain("meeting-added");
    expect(guardCodes(ics, deleteObjectPlan({ op: "delete", scope: "this", target: k, removed: [k] }))).toEqual([]);
  });
});

describe("verifyPlan: delete this_and_following и встречи, перенесённые раньше границы", () => {
  it("delete-object t&f с 19.10 при оторванной встрече RID 22.10, перенесённой на 16.10 — not-empty", () => {
    const ics = calendar(MOSCOW, vevent([...SERIES]), override("20261022T100000", "20261016T100000", "20261016T110000", "SUMMARY:Отдельная"));
    const o = load(ics);
    const b = key(o, "2026-10-19T10:00:00+03:00");
    const k22 = key(o, "2026-10-22T10:00:00+03:00");
    expect(guardCodes(ics, deleteObjectPlan({ op: "delete", scope: "this_and_following", target: b }))).toEqual(["not-empty"]);
    // С подтверждением: встреча названа в removed и в ответе.
    expect(guardCodes(ics, deleteObjectPlan({ op: "delete", scope: "this_and_following", target: b, removed: [k22] },
      [lossOf("2026-10-22T10:00:00+03:00")]))).toEqual([]);
    // Названа в removed, но ответ о потере молчит: встреча живая, объект не пуст.
    expect(guardCodes(ics, deleteObjectPlan({ op: "delete", scope: "this_and_following", target: b, removed: [k22] })))
      .toEqual(["not-empty"]);
  });

  it("delete-object t&f с 19.10 при переопределении слота 4.11, перенесённом на 16.10 — not-empty", () => {
    const ics = calendar(MOSCOW, vevent([...SERIES]), override("20261104T100000", "20261016T100000", "20261016T110000", "SUMMARY:Раньше"));
    const o = load(ics);
    const b = key(o, "2026-10-19T10:00:00+03:00");
    expect(guardCodes(ics, deleteObjectPlan({ op: "delete", scope: "this_and_following", target: b }))).toEqual(["not-empty"]);
  });

  it("усечение с 26.10 снимает встречу 4.11, перенесённую на 20.10, не назвав её в ответе — override-lost", () => {
    const ics = calendar(MOSCOW, vevent([...SERIES]), override("20261104T100000", "20261020T100000", "20261020T110000", "SUMMARY:Вперёд"));
    const p = load(ics);
    const b = key(p, "2026-10-26T10:00:00+03:00");
    const k4 = key(p, "2026-11-04T10:00:00+03:00");
    const t = truncate(p, b);
    const input: ExpectInput = { op: "delete", scope: "this_and_following", target: b, ruleChanged: true,
      tail: { count: 2, lastDate: "2026-10-21" }, touched: t };
    // У встречи 4.11 свой компонент, поэтому её пропажа — override-lost.
    expect(guardCodes(ics, putPlan(p, input))).toEqual(["override-lost"]);
    expect(guardCodes(ics, putPlan(p, { ...input, removed: [k4] }, [lossOf("2026-11-04T10:00:00+03:00")]))).toEqual([]);
    expect(guardCodes(ics, putPlan(p, { ...input, removed: [k4] }))).toEqual(["override-lost"]);
  });

  it("усечение с 26.10 прячет оторванную 23.10 за конец серии: только названной в ответе", () => {
    // 23.10 (пятница) — после последнего слота до B (21.10): усечённая серия
    // кончается раньше, и встреча становится скрытой. 20.10 остаётся видимой.
    const ics = calendar(MOSCOW, vevent([...SERIES]),
      override("20261023T100000", "20261023T100000", "20261023T110000", "SUMMARY:Пятница"),
      override("20261020T100000", "20261020T100000", "20261020T110000", "SUMMARY:Вторник"));
    const p = load(ics);
    const b = key(p, "2026-10-26T10:00:00+03:00");
    const k23 = key(p, "2026-10-23T10:00:00+03:00");
    const k20 = key(p, "2026-10-20T10:00:00+03:00");
    const t = truncate(p, b);
    const input: ExpectInput = { op: "delete", scope: "this_and_following", target: b, ruleChanged: true,
      tail: { count: 2, lastDate: "2026-10-21" }, touched: t };
    // Встреча спрятана за конец усечённой серии: её нет, а план о ней молчит.
    expect(guardCodes(ics, putPlan(p, input))).toEqual(["meeting-lost"]);
    expect(guardCodes(ics, putPlan(p, { ...input, removed: [k23] }, [lossOf("2026-10-23T10:00:00+03:00")]))).toEqual([]);
    expect(guardCodes(ics, putPlan(p, { ...input, removed: [k23] }))).toEqual(["meeting-lost"]);
  });
});

describe("verifyPlan: время клона и продолжения, когда патч время не трогает (О6, О8)", () => {
  /** update this на слоте 2.11: клон основного, патч `patch`, затем порча `mutate`. */
  function cloneAt2Nov(patch: { summary?: string; start?: string }, mutate: (clone: ICAL.Component, o: CalendarObject) => void = () => {}) {
    const o = load(PLANNING);
    const t = newTouched();
    const k = key(o, "2026-11-02T10:00:00+03:00");
    const clone = overrideFromMaster(o, findSlot(o, k)!, t);
    applyFieldPatch(clone, patch, { env: ENV, touched: t });
    mutate(clone, o);
    touchMetadata(clone, NOW, patch.start !== undefined, ENV, t);
    return putPlan(o, { op: "update", scope: "this", target: k, fields: Object.keys(patch) as PatchField[], touched: t });
  }

  it("update this {summary}: клон 2.11 с началом и концом основного (19.10) — time-changed", () => {
    const plan = cloneAt2Nov({ summary: "Особая" }, (clone, o) => {
      setTimeProperty(clone, "dtstart", o.master!.getFirstPropertyValue("dtstart") as ICAL.Time);
      setTimeProperty(clone, "dtend", o.master!.getFirstPropertyValue("dtend") as ICAL.Time);
    });
    expect(guardCodes(PLANNING, plan)).toContain("time-changed");
  });

  it("update this {summary}: клон с концом на 2 часа позже — time-changed", () => {
    expect(guardCodes(PLANNING, cloneAt2Nov({ summary: "Особая" }))).toEqual([]);
    const plan = cloneAt2Nov({ summary: "Особая" }, (clone) => setTimeProperty(clone, "dtend", shifted(clone, "dtend", 2)));
    expect(guardCodes(PLANNING, plan)).toEqual(["time-changed"]);
  });

  it("серия на весь день: клон на 21.10 — те же сутки; клон на двое суток — time-changed", () => {
    const ics = seeds.allDayWeekly.ics;
    const plan = (days: number) => {
      const o = load(ics);
      const t = newTouched();
      const k = key(o, "2026-10-21");
      const clone = overrideFromMaster(o, findSlot(o, k)!, t);
      applyFieldPatch(clone, { summary: "Особый день" }, { env: ENV, touched: t });
      if (days > 0) {
        const end = (clone.getFirstPropertyValue("dtend") as ICAL.Time).clone();
        end.adjust(days, 0, 0, 0);
        setTimeProperty(clone, "dtend", end);
      }
      touchMetadata(clone, NOW, false, ENV, t);
      return putPlan(o, { op: "update", scope: "this", target: k, fields: ["summary"], touched: t });
    };
    expect(guardCodes(ics, plan(0))).toEqual([]);
    expect(guardCodes(ics, plan(1))).toEqual(["time-changed"]);
  });

  it("разрез {summary}: у основного продолжения конец 13:00 вместо 11:00 — time-changed", () => {
    const plan = splitAt26({ summary: "Новый формат" }, {
      mutate: (c) => setTimeProperty(c.master!, "dtend", shifted(c.master!, "dtend", 2)),
    });
    expect(guardCodes(PLANNING, plan)).toEqual(["time-changed"]);
  });
});
describe("verifyPlan: смена повтора не трогает RDATE и не закрывает встреч", () => {
  const MONDAYS = calendar(MOSCOW, vevent(["DTSTART;TZID=Europe/Moscow:20261019T100000", "DTEND;TZID=Europe/Moscow:20261019T110000",
    "RRULE:FREQ=WEEKLY;BYDAY=MO", "RDATE;TZID=Europe/Moscow:20261030T100000", "SUMMARY:Пн"]));

  it("лишний recurrence в fields не разрешает снять RDATE: с патчем из оркестрации — meeting-lost", () => {
    const o = load(MONDAYS);
    const t = newTouched();
    applyFieldPatch(o.master!, { summary: "Синк" }, { env: ENV, touched: t });
    removeListValues(o.master!, "rdate", () => true, o);
    mark(t, o.master!, "rdate");
    touchMetadata(o.master!, NOW, true, ENV, t);
    const plan = putPlan(o, { op: "update", scope: "all_series", fields: ["summary", "recurrence"], touched: t });
    // С патчем из оркестрации лишний recurrence в fields не считается: слоты
    // сверяются, и снятая встреча 30.10 видна.
    expect(guardCodesWith(MONDAYS, plan, { patch: { summary: "Синк" } })).toContain("meeting-lost");
  });

  it("смена правила на одни понедельники снимает перенесённую 21.10: названа в ответе — проходит, нет — override-lost", () => {
    const o = load(PLANNING);
    const t = newTouched();
    patchRule(o.master!.getFirstProperty("rrule")!, { byWeekday: ["MO"] }, { env: ENV, touched: t });
    removeListValues(o.master!, "exdate", () => true, o); // EXDATE 28.10 без пары в новом правиле
    mark(t, o.master!, "exdate");
    touchMetadata(o.master!, NOW, true, ENV, t);
    const k21 = key(o, "2026-10-21T10:00:00+03:00");
    dropComponent(t, o.root, o.overrides.get(k21)![0].component);
    const input: ExpectInput = { op: "update", scope: "all_series", fields: ["recurrence"], ruleChanged: true, removed: [k21],
      tail: { count: 6, lastDate: "2026-11-23" }, touched: t };
    expect(guardCodes(PLANNING, putPlan(o, input, [lossOf("2026-10-21T10:00:00+03:00")]))).toEqual([]);
    // Без строки ответа потеря молчалива: внутреннего removed для неё мало (О11).
    expect(guardCodes(PLANNING, putPlan(o, input))).toEqual(["override-lost"]);
  });
});
describe("verifyPlan: keyMap знает только слоты", () => {
  it("сдвиг серии с оторванной встречей и EXDATE мимо слотов: keyMap для них не вызывается", () => {
    const ics = calendar(MOSCOW, vevent([...SERIES, "EXDATE;TZID=Europe/Moscow:20261022T100000"]),
      override("20261022T120000", "20261022T150000", "20261022T160000", "SUMMARY:Отдельная"));
    const o = load(ics);
    const slots = new Set(PLANNING_DATES.concat("2026-10-28").map((date) => key(o, `${date}T10:00:00+03:00`)));
    const t = newTouched();
    applyFieldPatch(o.master!, { start: "2026-10-19T11:00:00", end: "2026-10-19T12:00:00" }, { env: ENV, touched: t });
    touchMetadata(o.master!, NOW, true, ENV, t);
    const keyMap = (k: SlotKey): SlotKey => {
      if (!slots.has(k)) throw new Error(`${k} — не слот`);
      return later(3600)(k);
    };
    expect(guardCodes(ics, putPlan(o, { op: "update", scope: "all_series", fields: ["start", "end"], keyMap, ruleChanged: true,
      datesFixed: true, tail: { count: 6, lastDate: "2026-11-04" }, touched: t }))).toEqual([]);
  });
});

// ─────────────────────────────── правка по перепроверке ───────────────────────────────

describe("verifyPlan: скрытое переопределение полей не наследует (О7)", () => {
  /** Серия с EXDATE 28.10 и следом прошлого удаления — скрытым переопределением 28.10. */
  const withHidden = (summary: string) =>
    calendar(
      MOSCOW,
      vevent([...SERIES, "EXDATE;TZID=Europe/Moscow:20261028T100000"]),
      override("20261028T100000", "20261028T100000", "20261028T110000", `SUMMARY:${summary}`),
    );

  /** Правка всей серии одним полем: патч ложится на основной, скрытое не трогается. */
  function masterOnly(ics: string, patch: { summary?: string; reminders?: { method: "display"; minutesBefore: number }[] },
    fields: PatchField[]): WritePlan {
    const o = load(ics);
    const t = newTouched();
    applyFieldPatch(o.master!, patch, { env: ENV, touched: t });
    touchMetadata(o.master!, NOW, false, ENV, t);
    return putPlan(o, { op: "update", scope: "all_series", fields, touched: t });
  }

  it("all_series {summary}: скрытое 28.10 с прежним заголовком серии за новым не пошло — план проходит", () => {
    const ics = withHidden("Планёрка");
    expect(guardCodes(ics, masterOnly(ics, { summary: "Синк" }, ["summary"]))).toEqual([]);
  });

  it("all_series {reminders}: у скрытого 28.10 и у прежнего основного нет своих напоминаний — план проходит", () => {
    const ics = withHidden("След прошлого удаления");
    expect(guardCodes(ics, masterOnly(ics, { reminders: [{ method: "display", minutesBefore: 15 }] }, ["reminders"]))).toEqual([]);
  });

  it("разрез 26.10 {summary}: скрытое 28.10 в продолжении заголовок серии не наследует — план проходит", () => {
    const base = PLANNING.replace("END:VCALENDAR", [...override("20261028T100000", "20261028T100000",
      "20261028T110000", "SUMMARY:Планёрка"), "END:VCALENDAR"].join(CRLF));
    expect(guardCodes(base, splitAt26({ summary: "Новый формат" }, { base }))).toEqual([]);
  });
});
describe("verifyPlan: ответ не называет убранной встречу, которая остаётся (О11)", () => {
  it("delete this 2.11: строка ответа про целую 4.11 — plan-shape", () => {
    const o = load(PLANNING);
    const t = newTouched();
    const k2 = key(o, "2026-11-02T10:00:00+03:00");
    excludeSlot(o, t, k2);
    const input: ExpectInput = { op: "delete", scope: "this", target: k2, removed: [k2], touched: t };
    expect(guardCodes(PLANNING, putPlan(o, input, [lossOf("2026-11-02T10:00:00+03:00")]))).toEqual([]);
    const error = guardError(PLANNING, putPlan(o, input,
      [lossOf("2026-11-02T10:00:00+03:00"), lossOf("2026-11-04T10:00:00+03:00")]));
    expect([...new Set(error.problems.map((p) => p.code))]).toEqual(["plan-shape"]);
    expect(error.message).toContain("2026-11-04T10:00:00+03:00");
  });

  it("строка ответа без видимой встречи по адресу (20.10 — не слот серии) ничего не называет", () => {
    const o = load(PLANNING);
    const t = newTouched();
    const k2 = key(o, "2026-11-02T10:00:00+03:00");
    excludeSlot(o, t, k2);
    const input: ExpectInput = { op: "delete", scope: "this", target: k2, removed: [k2], touched: t };
    expect(guardCodes(PLANNING, putPlan(o, input, [lossOf("2026-11-02T10:00:00+03:00"), lossOf("2026-10-20T10:00:00+03:00"),
      { instanceStart: "не адрес", start: "", summary: "", reason: "" }]))).toEqual([]);
  });

  it("delete t&f 26.10: строки ответа про встречи от границы — не лишние", () => {
    const o = load(PLANNING);
    const b = key(o, "2026-10-26T10:00:00+03:00");
    const t = truncate(o, b);
    const input: ExpectInput = { op: "delete", scope: "this_and_following", target: b, ruleChanged: true,
      tail: { count: 2, lastDate: "2026-10-21" }, touched: t };
    expect(guardCodes(PLANNING, putPlan(o, input, ["2026-10-26", "2026-11-02", "2026-11-04"]
      .map((date) => lossOf(`${date}T10:00:00+03:00`))))).toEqual([]);
  });
});
describe("verifyPlan: клон на слоте RDATE;VALUE=PERIOD (О6)", () => {
  /** Пн 10:00–11:00 и отдельная встреча 23.10 периодом в 3 часа. */
  const PERIODIC = calendar(MOSCOW, vevent(["DTSTART;TZID=Europe/Moscow:20261019T100000",
    "DTEND;TZID=Europe/Moscow:20261019T110000", "RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=3",
    "RDATE;TZID=Europe/Moscow;VALUE=PERIOD:20261023T100000/PT3H", "SUMMARY:Пн"]));

  it("update this {summary} на слоте периода: у клона длительность периода, час вместо трёх — time-changed", () => {
    const plan = (hours: number) => {
      const o = load(PERIODIC);
      const t = newTouched();
      const k = key(o, "2026-10-23T10:00:00+03:00");
      const clone = overrideFromMaster(o, findSlot(o, k)!, t);
      applyFieldPatch(clone, { summary: "Особая" }, { env: ENV, touched: t });
      if (hours !== 0) setTimeProperty(clone, "dtend", shifted(clone, "dtend", hours));
      touchMetadata(clone, NOW, false, ENV, t);
      return putPlan(o, { op: "update", scope: "this", target: k, fields: ["summary"], touched: t });
    };
    expect(guardCodes(PERIODIC, plan(0))).toEqual([]);
    expect(guardCodes(PERIODIC, plan(-2))).toEqual(["time-changed"]);
  });
});

// ─────────────────────────────── правка по разрушителю ───────────────────────────────

describe("verifyPlan: правило повтора сверяется и при смене повтора (Р4)", () => {
  /** Серия с одним RRULE: Пн 10:00–11:00 МСК с 19.10 (19, 26 окт., 2 нояб. при COUNT=3). */
  const withRule = (...rules: string[]) =>
    calendar(MOSCOW, vevent(["DTSTART;TZID=Europe/Moscow:20261019T100000", "DTEND;TZID=Europe/Moscow:20261019T110000",
      ...rules, "SUMMARY:Планёрка"]));

  /**
   * Правка всей серии, в которой планировщик записал правило `dict` целиком.
   * `tail` — честный, посчитанный по записанному объекту: своим числом план
   * себя не опровергнет, и без сверки правила ошибку не видит никто.
   */
  function ruleRewrite(ics: string, dict: Record<string, RuleValue>, keep: number[] = [0]): WritePlan {
    const o = load(ics);
    const t = newTouched();
    const rules = o.master!.getAllProperties("rrule");
    rules.forEach((property, index) => {
      if (keep.includes(index)) setRuleDict(property, dict);
      else o.master!.removeProperty(property);
    });
    mark(t, o.master!, "rrule");
    touchMetadata(o.master!, NOW, true, ENV, t);
    return putPlan(o, { op: "update", scope: "all_series", fields: ["recurrence"], ruleChanged: true, tail: tailOf(o), touched: t });
  }

  it("replace задаёт правило заново (потери — с confirm), а без патча оркестрации сверять не с чем", () => {
    const ics = withRule("RRULE:FREQ=MONTHLY;BYMONTHDAY=19;COUNT=3");
    const plan = ruleRewrite(ics, { freq: "DAILY", count: 6 });
    expect(guardCodesWith(ics, plan, { patch: { recurrence: { frequency: "daily", count: 6, replace: true } } })).toEqual([]);
    expect(guardCodes(ics, plan)).toEqual([]);
  });
});
describe("verifyPlan: скрытое переопределение, которому новое правило даёт встречу (О11)", () => {
  /**
   * Пн 10:00 с 19.10, COUNT=3 (19, 26 окт., 2 нояб.) и переопределение с
   * RECURRENCE-ID 9.11 — за концом серии, роль hidden: встречи у него нет, но
   * данные настоящие (get_event.exceptions). COUNT=6 доводит серию до 9.11, и
   * на его ключе появляется слот.
   */
  const WITH_TRACE = calendar(
    MOSCOW,
    vevent(["DTSTART;TZID=Europe/Moscow:20261019T100000", "DTEND;TZID=Europe/Moscow:20261019T110000",
      "RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=3", "SUMMARY:Планёрка"]),
    override("20261109T100000", "20261109T140000", "20261109T150000", "SUMMARY:Разбор года"),
  );
  const TRACE = "2026-11-09T10:00:00+03:00";

  /** Смена повтора с патчем `rp`; `drop` — выбросить скрытое переопределение. */
  function rulePlan(rp: RecurrencePatch, drop: boolean, losses: Loss[] = []): WritePlan {
    const o = load(WITH_TRACE);
    const t = newTouched();
    patchRule(o.master!.getFirstProperty("rrule")!, rp, { env: ENV, touched: t });
    if (drop) for (const ref of o.overrides.get(key(o, TRACE))!) dropComponent(t, o.root, ref.component);
    touchMetadata(o.master!, NOW, true, ENV, t);
    return putPlan(o, { op: "update", scope: "all_series", fields: ["recurrence"], ruleChanged: true, tail: tailOf(o), touched: t }, losses);
  }

  it("роль переопределения 9.11 — hidden", () => {
    const o = load(WITH_TRACE);
    expect(o.roles.get(o.overrides.get(key(o, TRACE))![0].component)?.role).toBe("hidden");
  });

  it("{count:6} выбросил его молча — override-lost; названное в ответе снимается, сохранённое проходит", () => {
    expect(guardCodes(WITH_TRACE, rulePlan({ count: 6 }, true))).toEqual(["override-lost"]);
    expect(guardCodes(WITH_TRACE, rulePlan({ count: 6 }, true, [lossOf(TRACE)]))).toEqual([]);
    expect(guardCodes(WITH_TRACE, rulePlan({ count: 6 }, false))).toEqual([]);
  });

  it("{interval:2}: слота на 9.11 новое правило не даёт, но и такое скрытое снимается только названным", () => {
    expect(guardCodes(WITH_TRACE, rulePlan({ interval: 2 }, true))).toEqual(["override-lost"]);
    expect(guardCodes(WITH_TRACE, rulePlan({ interval: 2 }, true, [lossOf(TRACE)]))).toEqual([]);
    expect(guardCodes(WITH_TRACE, rulePlan({ interval: 2 }, false))).toEqual([]);
  });
});

describe("verifyPlan: расхождения с планировщиком, решённые на стороне предохранителя", () => {
  it("delete this скрытого компонента одиночного события — запись, а не удаление объекта", () => {
    const ics = calendar(
      MOSCOW,
      vevent(["DTSTART;TZID=Europe/Moscow:20261019T100000", "DTEND;TZID=Europe/Moscow:20261019T110000", "SUMMARY:Встреча"]),
      override("20261109T100000", "20261109T140000", "20261109T150000", "SUMMARY:След прошлого удаления"),
    );
    const o = load(ics);
    const t = newTouched();
    const k = key(o, "2026-11-09T10:00:00+03:00");
    expect(o.roles.get(o.overrides.get(k)![0].component)?.role).toBe("hidden");
    for (const ref of o.overrides.get(k)!) dropComponent(t, o.root, ref.component);
    // Событие остаётся: снят лишний компонент, а не одиночная встреча.
    expect(guardCodes(ics, putPlan(o, { op: "delete", scope: "this", target: k, removed: [k], touched: t }))).toEqual([]);

    // Само событие записью не удаляется (таблица §3: одиночное — DELETE).
    const self = load(ics);
    const st = newTouched();
    const selfKey = key(self, "2026-10-19T10:00:00+03:00");
    excludeSlot(self, st, selfKey);
    expect(guardCodes(ics, putPlan(self, { op: "delete", scope: "this", target: selfKey, removed: [selfKey], touched: st })))
      .toContain("empty-left");
  });

  it("переход на «весь день» в календаре западнее UTC: дата — по поясу календаря", () => {
    const NY: IcalEnv = { floatingZone: "America/New_York", ownerEmail: ENV.ownerEmail };
    // 01:00 UTC — это ещё 18 октября в Нью-Йорке: дату серии на весь день
    // планировщик берёт по поясу календаря (patch.ts, dateOfTimed).
    const ics = calendar([], vevent(["DTSTART:20261019T010000Z", "DTEND:20261019T020000Z",
      "RRULE:FREQ=WEEKLY;COUNT=3", "SUMMARY:Ночной созвон"]));
    const before = loadObject(ics, NY);
    if (isUnparsable(before)) throw new Error(before.error);
    const o = loadObject(ics, NY);
    if (isUnparsable(o)) throw new Error(o.error);
    const t = newTouched();
    applyFieldPatch(o.master!, { allDay: true }, { env: NY, touched: t });
    touchMetadata(o.master!, NOW, true, NY, t);
    expect(String(o.master!.getFirstProperty("dtstart")!.jCal[3])).toBe("2026-10-18");

    const keysOf = (x: CalendarObject) => [...iterateSlots(x)].map((slot) => slot.key);
    const images = new Map(keysOf(before).map((k, index) => [k, keysOf(o)[index]]));
    const plan = putPlan(o, { op: "update", scope: "all_series", fields: ["allDay"],
      keyMap: (k) => images.get(k) ?? k, ruleChanged: true, datesFixed: true, touched: t });
    expect(guardCodesWith(ics, plan, {}, NY)).toEqual([]);
  });
});

// ─────────────────────── правка по разрушителю: инварианты вместо разрешений ───────────────────────

describe("verifyPlan: конец правила сверяется при любом патче повтора (Р4, §3)", () => {
  /** Серия 10:00–11:00 МСК с 19.10 (понедельник) с правилом `rule`. */
  const withRule = (rule: string) =>
    calendar(MOSCOW, vevent(["DTSTART;TZID=Europe/Moscow:20261019T100000", "DTEND;TZID=Europe/Moscow:20261019T110000",
      `RRULE:${rule}`, "SUMMARY:Планёрка"]));

  /**
   * Правка всей серии, в которой планировщик записал правило `dict` целиком.
   * `tail` — честный, посчитанный по записанному объекту (у бесконечной серии
   * его нет): своим числом план себя не опровергнет, и конец правила без
   * сверки самого правила не проверяет никто.
   */
  function ruleWritten(ics: string, dict: Record<string, RuleValue>): WritePlan {
    const o = load(ics);
    const t = newTouched();
    setRuleDict(o.master!.getFirstProperty("rrule")!, dict);
    mark(t, o.master!, "rrule");
    touchMetadata(o.master!, NOW, true, ENV, t);
    const extent = seriesExtent(o);
    const tail = extent.kind === "finite" && extent.last
      ? { count: extent.count, lastDate: wallDateOf(extent.last.time, ENV) }
      : undefined;
    return putPlan(o, { op: "update", scope: "all_series", fields: ["recurrence"], ruleChanged: true, tail, touched: t });
  }

  const codes = (ics: string, dict: Record<string, RuleValue>, recurrence: RecurrencePatch): GuardCode[] =>
    guardCodesWith(ics, ruleWritten(ics, dict), { patch: { recurrence } });

  it("снятый COUNT делает конечную серию бесконечной; {count: null} снимает его законно", () => {
    const ics = withRule("FREQ=WEEKLY;BYDAY=MO;COUNT=3");
    expect(codes(ics, { freq: "WEEKLY", byday: "MO" }, { byWeekday: ["MO"] })).toEqual(["extent-mismatch"]);
    expect(codes(ics, { freq: "WEEKLY", byday: "MO" }, { count: null })).toEqual([]);
  });

  it("{count} и {until} заменяют друг друга: прежний конец не считается потерянным", () => {
    const counted = withRule("FREQ=WEEKLY;BYDAY=MO;COUNT=3");
    expect(codes(counted, { freq: "WEEKLY", byday: "MO", until: "2026-11-16T20:59:59Z" }, { until: "2026-11-16" })).toEqual([]);
    const dated = withRule("FREQ=WEEKLY;BYDAY=MO;UNTIL=20261116T205959Z");
    expect(codes(dated, { freq: "WEEKLY", byday: "MO", count: 3 }, { count: 3 })).toEqual([]);
  });

  it("патч времени и повтора сразу: UNTIL пересчитывается (Р1), но не появляется и не пропадает", () => {
    const ics = calendar(MOSCOW, vevent(["DTSTART;TZID=Europe/Moscow:20261019T100000",
      "DTEND;TZID=Europe/Moscow:20261019T110000", "RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20261116T205959Z", "SUMMARY:Планёрка"]));
    const patch: EventPatch = { start: "2026-10-19T11:00:00+03:00", recurrence: { interval: 2 } };
    /** Сдвиг на 11:00 с шагом в две недели; `until` — что планировщик записал концом правила. */
    const plan = (until: string | undefined): WritePlan => {
      const o = load(ics);
      const t = newTouched();
      applyFieldPatch(o.master!, { start: patch.start }, { env: ENV, touched: t });
      const rule = o.master!.getFirstProperty("rrule")!;
      setRuleDict(rule, until === undefined ? { freq: "WEEKLY", byday: "MO", interval: 2 } : { freq: "WEEKLY", byday: "MO", interval: 2, until });
      mark(t, o.master!, "rrule");
      touchMetadata(o.master!, NOW, true, ENV, t);
      const extent = seriesExtent(o);
      return putPlan(o, {
        op: "update", scope: "all_series", fields: ["start", "recurrence"], keyMap: later(3600), ruleChanged: true,
        datesFixed: true, touched: t,
        tail: extent.kind === "finite" && extent.last ? { count: extent.count, lastDate: wallDateOf(extent.last.time, ENV) } : undefined,
      });
    };
    // Р1: U' — новое время на дате последнего прежнего слота (16.11 11:00 МСК = 08:00Z).
    expect(guardCodesWith(ics, plan("2026-11-16T08:00:00Z"), { patch })).toEqual([]);
    // Конец правила выброшен вовсе — серия стала бесконечной.
    expect(guardCodesWith(ics, plan(undefined), { patch })).toEqual(["extent-mismatch"]);
  });
});
describe("verifyPlan: скрытое переопределение под EXDATE — настоящие данные (О11)", () => {
  /**
   * Пн 10:00 с 19.10, COUNT=4 (19, 26 окт., 2, 9 нояб.), EXDATE на 2.11 и
   * компонент с RECURRENCE-ID 2.11: роль hidden, своё время 14:00 и свой
   * заголовок. Пользователь видит его в get_event.exceptions.
   */
  const HIDDEN = calendar(
    MOSCOW,
    vevent(["DTSTART;TZID=Europe/Moscow:20261019T100000", "DTEND;TZID=Europe/Moscow:20261019T110000",
      "RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=4", "EXDATE;TZID=Europe/Moscow:20261102T100000", "SUMMARY:Планёрка"]),
    override("20261102T100000", "20261102T140000", "20261102T150000", "SUMMARY:Разбор года"),
  );
  const TRACE = "2026-11-02T10:00:00+03:00";

  function rulePlan(rp: RecurrencePatch, drop: boolean, losses: Loss[] = []): WritePlan {
    const o = load(HIDDEN);
    const t = newTouched();
    patchRule(o.master!.getFirstProperty("rrule")!, rp, { env: ENV, touched: t });
    if (drop) for (const ref of o.overrides.get(key(o, TRACE))!) dropComponent(t, o.root, ref.component);
    touchMetadata(o.master!, NOW, true, ENV, t);
    return putPlan(o, { op: "update", scope: "all_series", fields: ["recurrence"], ruleChanged: true, tail: tailOf(o), touched: t }, losses);
  }

  it("роль переопределения 2.11 (под EXDATE) — hidden", () => {
    const o = load(HIDDEN);
    expect(o.roles.get(o.overrides.get(key(o, TRACE))![0].component)?.role).toBe("hidden");
  });

  it("{count:6} выбросил скрытое под EXDATE молча — override-lost; названное в ответе снимается", () => {
    expect(guardCodes(HIDDEN, rulePlan({ count: 6 }, true))).toEqual(["override-lost"]);
    expect(guardCodes(HIDDEN, rulePlan({ count: 6 }, true, [lossOf(TRACE)]))).toEqual([]);
    expect(guardCodes(HIDDEN, rulePlan({ count: 6 }, false))).toEqual([]);
  });

  it("{interval:2}: слота на 2.11 новое правило не даёт, но и такое скрытое молча не выбрасывается", () => {
    expect(guardCodes(HIDDEN, rulePlan({ interval: 2 }, true))).toEqual(["override-lost"]);
    expect(guardCodes(HIDDEN, rulePlan({ interval: 2 }, true, [lossOf(TRACE)]))).toEqual([]);
    expect(guardCodes(HIDDEN, rulePlan({ interval: 2 }, false))).toEqual([]);
  });
});
describe("verifyPlan: своя длительность неперенесённого переопределения (О8)", () => {
  /** Пн 10:00–11:00 МСК, COUNT=3, и встреча 26.10 на свои два часа (не перенесена). */
  const own = (masterStart: string, masterEnd: string, rule: string, rid: string, start: string, end: string) =>
    calendar(MOSCOW,
      vevent([`DTSTART;TZID=Europe/Moscow:${masterStart}`, `DTEND;TZID=Europe/Moscow:${masterEnd}`, `RRULE:${rule}`, "SUMMARY:Планёрка"]),
      override(rid, start, end, "SUMMARY:Планёрка с гостем"));

  const BEFORE = own("20261019T100000", "20261019T110000", "FREQ=WEEKLY;BYDAY=MO;COUNT=3",
    "20261026T100000", "20261026T100000", "20261026T120000");

  it("правка правила времени не трогает, а конец встречи 26.10 уехал", () => {
    const plan = (end: string): WritePlan => {
      const a = load(own("20261019T100000", "20261019T110000", "FREQ=WEEKLY;BYDAY=MO;COUNT=4",
        "20261026T100000", "20261026T100000", end));
      const t = newTouched();
      mark(t, a.master!, "rrule");
      for (const c of overridesOf(a)) mark(t, c, "dtend");
      return putPlan(a, { op: "update", scope: "all_series", fields: ["recurrence"], ruleChanged: true, tail: tailOf(a), touched: t });
    };
    const patch: EventPatch = { recurrence: { count: 4 } };
    expect(guardCodesWith(BEFORE, plan("20261026T120000"), { patch })).toEqual([]);
    expect(guardCodesWith(BEFORE, plan("20261026T100500"), { patch })).toEqual(["time-changed"]);
  });
});

describe("verifyPlan: разрез — конец правила, период RDATE и скрытое в продолжении", () => {
  /** Пн и Ср 10:00–11:00 МСК с 19.10, COUNT=6: 19, 21, 26, 28 окт., 2, 4 нояб. */
  const PLAIN = calendar(MOSCOW, vevent([...SERIES]));
  const CONT_UID = "ycm-0123456789abcdef0123456789abcdef";

  /** Продолжение разреза: клон `base` с новым UID, началом на B и правкой `edit`. */
  function continuation(base: string, b: SlotKey, edit: (c: CalendarObject) => void): { uid: string; ics: string } {
    const c = load(base);
    const cm = c.master!;
    for (const [k, refs] of c.overrides) {
      for (const ref of refs) {
        if (compareSlotKeys(k, b) < 0) c.root.removeSubcomponent(ref.component);
        else ref.component.getFirstProperty("uid")!.setValue(CONT_UID);
      }
    }
    cm.getFirstProperty("uid")!.setValue(CONT_UID);
    const start = findSlot(c, b)!.time.clone();
    const end = start.clone();
    end.adjust(0, 1, 0, 0);
    setTimeProperty(cm, "dtstart", start);
    setTimeProperty(cm, "dtend", end);
    for (const name of ["sequence", "created"]) {
      for (const p of cm.getAllProperties(name)) cm.removeProperty(p);
    }
    edit(c);
    touchMetadata(cm, NOW, false, ENV);
    return { uid: CONT_UID, ics: serializeObject(c) };
  }

  it("смена повтора: COUNT продолжения пересчитан по построению — план проходит", () => {
    const o = load(PLAIN);
    const b = key(o, "2026-10-26T10:00:00+03:00");
    const t = truncate(o, b);
    const cont = continuation(PLAIN, b, (c) => {
      const rule = c.master!.getFirstProperty("rrule")!;
      patchRule(rule, { interval: 2 }, { env: ENV });
      setRuleEnd(rule, { count: 4 });
    });
    const plan: WritePlan = {
      kind: "split", continuation: cont, truncated: { ics: serializeObject(o) }, boundary: b,
      expect: expectation({ op: "update", scope: "this_and_following", target: b, fields: ["recurrence"], ruleChanged: true,
        tail: tailOf(load(cont.ics)), touched: t }),
      removed: [], notices: [],
    };
    expect(guardCodesWith(PLAIN, plan, { patch: { recurrence: { interval: 2 } } })).toEqual([]);
  });

  it("периоды RDATE: свой конец цел и в усечённой серии, и в продолжении", () => {
    // Слоты: 19.10, 20.10 (период), 26.10, 1.11 (период), 2.11; граница — 26.10.
    const base = calendar(MOSCOW, vevent(["DTSTART;TZID=Europe/Moscow:20261019T100000", "DTEND;TZID=Europe/Moscow:20261019T110000",
      "RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=3", "RDATE;TZID=Europe/Moscow;VALUE=PERIOD:20261020T140000/PT3H",
      "RDATE;TZID=Europe/Moscow;VALUE=PERIOD:20261101T140000/PT3H", "SUMMARY:Планёрка"]));
    /** Укорачивает единственный оставшийся период на `hours` часов — ошибка планировщика. */
    const shorten = (x: CalendarObject, hours: number) => {
      const period = x.master!.getAllProperties("rdate")[0].getFirstValue() as ICAL.Period;
      const end = period.getEnd().clone();
      end.adjust(0, hours, 0, 0);
      removeListValues(x.master!, "rdate", () => true, x);
      addListValue(x.master!, "rdate", new ICAL.Period({ start: period.start.clone(), end }));
    };
    const plan = (truncHours: number, contHours: number): WritePlan => {
      const o = load(base);
      const b = key(o, "2026-10-26T10:00:00+03:00");
      const t = newTouched();
      setRuleEnd(o.master!.getFirstProperty("rrule")!, { count: positionsBefore(o, b) }, t);
      removeListValues(o.master!, "rdate", (k) => compareSlotKeys(k, b) >= 0, o);
      if (truncHours !== 0) shorten(o, truncHours);
      mark(t, o.master!, "rdate");
      touchMetadata(o.master!, NOW, true, ENV, t);
      const cont = continuation(base, b, (c) => {
        setRuleEnd(c.master!.getFirstProperty("rrule")!, { count: 2 });
        removeListValues(c.master!, "rdate", (k) => compareSlotKeys(k, b) < 0, c);
        if (contHours !== 0) shorten(c, contHours);
      });
      return {
        kind: "split", continuation: cont, truncated: { ics: serializeObject(o) }, boundary: b,
        expect: expectation({ op: "update", scope: "this_and_following", target: b, fields: ["summary"], ruleChanged: true,
          tail: tailOf(load(cont.ics)), touched: t }),
        removed: [], notices: [],
      };
    };
    expect(guardCodes(base, plan(0, 0))).toEqual([]);
    expect(guardCodes(base, plan(0, -2))).toEqual(["time-changed"]);
    // Укороченный период в усечённой серии — ещё и встреча до границы, которой
    // правка «эта и следующие» не касалась.
    expect(guardCodes(base, plan(-2, 0))).toEqual(["time-changed", "untouched-changed"]);
  });

  it("скрытое переопределение за концом серии не теряется в продолжении молча", () => {
    const base = calendar(MOSCOW, vevent([...SERIES]), override("20261109T100000", "20261109T140000", "20261109T150000", "SUMMARY:Разбор года"));
    const trace = "2026-11-09T10:00:00+03:00";
    const plan = (drop: boolean, losses: Loss[] = []): WritePlan => {
      const o = load(base);
      const b = key(o, "2026-10-26T10:00:00+03:00");
      const t = truncate(o, b);
      const cont = continuation(base, b, (c) => {
        setRuleEnd(c.master!.getFirstProperty("rrule")!, { count: 4 });
        if (drop) for (const ref of c.overrides.get(key(c, trace)) ?? []) c.root.removeSubcomponent(ref.component);
      });
      return {
        kind: "split", continuation: cont, truncated: { ics: serializeObject(o) }, boundary: b,
        expect: expectation({ op: "update", scope: "this_and_following", target: b, fields: ["summary"], ruleChanged: true,
          tail: tailOf(load(cont.ics)), touched: t }),
        removed: losses, notices: [],
      };
    };
    const loaded = load(base);
    expect(loaded.roles.get(loaded.overrides.get(key(loaded, trace))![0].component)?.role).toBe("hidden");
    expect(guardCodes(base, plan(false))).toEqual([]);
    expect(guardCodes(base, plan(true))).toEqual(["override-lost"]);
    expect(guardCodes(base, plan(true, [lossOf(trace)]))).toEqual([]);
  });
});

// ─────────────────────────────── построители планов ───────────────────────────────

/** Честная протяжённость записанного объекта — то самое число, которое планировщик кладёт в `expect.tail`. */
function tailOf(o: CalendarObject): { count: number; lastDate: string } {
  const extent = seriesExtent(o);
  if (extent.kind !== "finite" || !extent.last) throw new Error(`ожидалась конечная серия, получено ${extent.kind}`);
  return { count: extent.count, lastDate: wallDateOf(extent.last.time, ENV) };
}

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
  /** Исходный объект вместо PLANNING (с теми же слотами). */
  base?: string;
  /** Порча продолжения после сборки. */
  mutate?: (c: CalendarObject) => void;
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
  const base = options.base ?? PLANNING;
  const o = load(base);
  const b = key(o, "2026-10-26T10:00:00+03:00");
  const t = truncate(o, b);

  const uid = options.sameUid ? UID : "ycm-0123456789abcdef0123456789abcdef";
  const c = load(base);
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
  options.mutate?.(c);

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
