import { describe, expect, it } from "vitest";
import { GuardError, verifyPlan, type GuardCode, type GuardOptions } from "../../src/ical/guard.js";
import { isUnparsable, loadObject, serializeObject, type CalendarObject } from "../../src/ical/object.js";
import { newTouched } from "../../src/ical/patch.js";
import type { Expectation, Loss, PatchField, Touched, WritePlan } from "../../src/ical/plan.js";
import { instantOf, parseModelTime, type IcalEnv, type SlotKey } from "../../src/ical/values.js";

// Разностный предохранитель (src/ical/guard.ts): дерево ДО и дерево ПОСЛЕ
// разворачиваются в наборы встреч, и всякое расхождение обязано быть
// оправдано планом и патчем.
//
// Планы здесь собраны из текста: «до» и «после» пишутся дословно, без
// планировщика и без точечных правок дерева. Так тесты проверяют ровно то,
// что проверяет предохранитель, — разницу наборов, а не путь, которым план
// её получил.
//
// Время — ISO со смещением: тесты не зависят от пояса процесса (npm run test:tz).

const ENV: IcalEnv = { floatingZone: "Europe/Moscow", ownerEmail: "user@yandex.ru" };
/** «Сейчас» для горизонта проверки: 01.10.2026 09:00 UTC. */
const NOW = Date.UTC(2026, 9, 1, 9, 0, 0);
const CRLF = "\r\n";
const UID = "guard2-test@yandex.ru";

const MOSCOW = [
  "BEGIN:VTIMEZONE", "TZID:Europe/Moscow", "BEGIN:STANDARD", "TZNAME:MSK", "TZOFFSETFROM:+0300",
  "TZOFFSETTO:+0300", "DTSTART:19700101T000000", "END:STANDARD", "END:VTIMEZONE",
];

function vevent(lines: string[], uid = UID): string[] {
  return ["BEGIN:VEVENT", `UID:${uid}`, "DTSTAMP:20261001T090000Z", ...lines, "END:VEVENT"];
}

function calendar(...events: string[][]): string {
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//guard2//RU", ...MOSCOW, ...events.flat(), "END:VCALENDAR"]
    .join(CRLF) + CRLF;
}

/** Переопределение серии Europe/Moscow: RID, начало и конец — стенное время МСК. */
function override(rid: string, start: string, end: string, ...extra: string[]): string[] {
  return vevent([`RECURRENCE-ID;TZID=Europe/Moscow:${rid}`, `DTSTART;TZID=Europe/Moscow:${start}`,
    `DTEND;TZID=Europe/Moscow:${end}`, ...extra]);
}

/** Пн и Ср 10:00–11:00 МСК с 19.10.2026, COUNT=6: 19, 21, 26, 28 окт., 2, 4 нояб. */
const SERIES = ["DTSTART;TZID=Europe/Moscow:20261019T100000", "DTEND;TZID=Europe/Moscow:20261019T110000",
  "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6", "SUMMARY:Планёрка"];

/**
 * Серия SERIES с EXDATE 28.10, переносом 21.10 на 15:00 и переопределением
 * 26.10 без переноса. Видны: 19.10, 21.10 (в 15:00), 26.10, 2.11, 4.11.
 */
const PLANNING = calendar(
  vevent([...SERIES, "EXDATE;TZID=Europe/Moscow:20261028T100000"]),
  override("20261021T100000", "20261021T150000", "20261021T160000", "SUMMARY:Планёрка (перенос)"),
  override("20261026T100000", "20261026T100000", "20261026T110000", "SUMMARY:Планёрка с гостем"),
);

function load(ics: string): CalendarObject {
  const o = loadObject(ics, ENV);
  if (isUnparsable(o)) throw new Error(`Не разобран: ${o.error}`);
  return o;
}

type ExpectInput = Partial<Omit<Expectation, "fields">> & Pick<Expectation, "op" | "scope"> & { fields?: PatchField[] };

/** Отметка «правка трогала этот компонент» на все компоненты записываемого дерева. */
function touchAll(ics: string): Touched {
  const touched = newTouched();
  if (ics === "") return touched; // удаление объекта ничего не трогает: записи нет
  for (const component of load(ics).root.getAllSubcomponents("vevent")) {
    const names = new Set(component.getAllProperties().map((property) => property.name.toLowerCase()));
    touched.names.set(component, names);
  }
  return touched;
}

function expectation(ics: string, input: ExpectInput): Expectation {
  const { fields = [], ...rest } = input;
  return {
    removed: [],
    ruleChanged: false,
    datesFixed: false,
    touched: touchAll(ics),
    ...rest,
    fields: new Set(fields),
  };
}

function putPlan(afterIcs: string, input: ExpectInput, losses: Loss[] = []): WritePlan {
  return { kind: "put", ics: afterIcs, expect: expectation(afterIcs, input), removed: losses, notices: [] };
}

function deleteObjectPlan(input: ExpectInput, losses: Loss[] = []): WritePlan {
  return { kind: "delete-object", expect: { ...expectation("", { ...input, touched: newTouched() }) }, removed: losses, notices: [] };
}

function splitPlan(truncatedIcs: string, continuationIcs: string, boundary: SlotKey, input: ExpectInput, losses: Loss[] = []): WritePlan {
  return {
    kind: "split",
    continuation: { uid: `${UID}-2`, ics: continuationIcs },
    truncated: { ics: truncatedIcs },
    boundary,
    expect: expectation(truncatedIcs, { target: boundary, ...input }),
    removed: losses,
    notices: [],
  };
}

/** Строка ответа об убранной встрече (plan.removed) с адресом по Р10. */
function lossOf(instanceStart: string): Loss {
  return { instanceStart, start: instanceStart, summary: "", reason: "убрана с подтверждением" };
}

/** Коды проблем без повторов, в порядке первого появления; пусто — план прошёл. */
function guardCodes(beforeIcs: string, plan: WritePlan, options: GuardOptions = {}): GuardCode[] {
  try {
    verifyPlan(beforeIcs, plan, ENV, { now: NOW, ...options });
    return [];
  } catch (error) {
    if (!(error instanceof GuardError)) throw error;
    expect(error.problems.length).toBeGreaterThan(0);
    expect(error.code).toBe(error.problems[0].code);
    return [...new Set(error.problems.map((problem) => problem.code))];
  }
}

/** Ключ момента в серии со временем: секунды Unix (без Date — как в src/ical). */
function timeKey(iso: string): SlotKey {
  return `T:${Math.trunc(instantOf(parseModelTime(iso).time, ENV) / 1000)}` as SlotKey;
}

/** keyMap сдвига серии: все ключи со временем — на `seconds` вперёд. */
function shiftBy(seconds: number): (key: SlotKey) => SlotKey {
  return (key) => (key.startsWith("T:") ? (`T:${Number(key.slice(2)) + seconds}` as SlotKey) : key);
}

// ─────────────────────────────── изменение встречи ───────────────────────────────

describe("изменение встречи", () => {
  it("правка названия всей серии принимается: изменено ровно названное патчем", () => {
    const after = calendar(
      vevent([...SERIES.map((line) => line.replace("SUMMARY:Планёрка", "SUMMARY:Совещание")), "EXDATE;TZID=Europe/Moscow:20261028T100000"]),
      override("20261021T100000", "20261021T150000", "20261021T160000", "SUMMARY:Планёрка (перенос)"),
      override("20261026T100000", "20261026T100000", "20261026T110000", "SUMMARY:Планёрка с гостем"),
    );
    const plan = putPlan(after, { op: "update", scope: "all_series", fields: ["summary"] });
    expect(guardCodes(PLANNING, plan, { patch: { summary: "Совещание" } })).toEqual([]);
  });

  it("правка названия, которая заодно вписала место, отвергается", () => {
    const after = calendar(
      vevent([...SERIES.map((line) => line.replace("SUMMARY:Планёрка", "SUMMARY:Совещание")), "LOCATION:Большой зал",
        "EXDATE;TZID=Europe/Moscow:20261028T100000"]),
      override("20261021T100000", "20261021T150000", "20261021T160000", "SUMMARY:Планёрка (перенос)"),
      override("20261026T100000", "20261026T100000", "20261026T110000", "SUMMARY:Планёрка с гостем"),
    );
    const plan = putPlan(after, { op: "update", scope: "all_series", fields: ["summary"] });
    expect(guardCodes(PLANNING, plan, { patch: { summary: "Совещание" } })).toEqual(["untouched-changed"]);
  });

  it("правка названия, которая заодно удлинила встречи, отвергается", () => {
    const after = calendar(
      vevent([...SERIES.map((line) => line.replace("SUMMARY:Планёрка", "SUMMARY:Совещание").replace("20261019T110000", "20261019T120000")),
        "EXDATE;TZID=Europe/Moscow:20261028T100000"]),
      override("20261021T100000", "20261021T150000", "20261021T160000", "SUMMARY:Планёрка (перенос)"),
      override("20261026T100000", "20261026T100000", "20261026T110000", "SUMMARY:Планёрка с гостем"),
    );
    const plan = putPlan(after, { op: "update", scope: "all_series", fields: ["summary"] });
    expect(guardCodes(PLANNING, plan, { patch: { summary: "Совещание" } })).toEqual(["time-changed"]);
  });

  it("правка названия, которая отняла у неперенесённого переопределения его длительность, отвергается", () => {
    const after = calendar(
      vevent([...SERIES.map((line) => line.replace("SUMMARY:Планёрка", "SUMMARY:Совещание")), "EXDATE;TZID=Europe/Moscow:20261028T100000"]),
      override("20261021T100000", "20261021T150000", "20261021T160000", "SUMMARY:Планёрка (перенос)"),
      vevent(["RECURRENCE-ID;TZID=Europe/Moscow:20261026T100000", "DTSTART;TZID=Europe/Moscow:20261026T100000",
        "SUMMARY:Планёрка с гостем"]),
    );
    const plan = putPlan(after, { op: "update", scope: "all_series", fields: ["summary"] });
    expect(guardCodes(PLANNING, plan, { patch: { summary: "Совещание" } })).toEqual(["time-changed"]);
  });

  it("правка времени всей серии принимается: перенесённая встреча стоит, где стояла", () => {
    const after = calendar(
      vevent(["DTSTART;TZID=Europe/Moscow:20261019T110000", "DTEND;TZID=Europe/Moscow:20261019T120000",
        "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6", "SUMMARY:Планёрка", "EXDATE;TZID=Europe/Moscow:20261028T110000"]),
      override("20261021T110000", "20261021T150000", "20261021T160000", "SUMMARY:Планёрка (перенос)"),
      override("20261026T110000", "20261026T110000", "20261026T120000", "SUMMARY:Планёрка с гостем"),
    );
    const plan = putPlan(after, {
      op: "update",
      scope: "all_series",
      fields: ["start"],
      keyMap: shiftBy(3600),
      datesFixed: true,
    });
    expect(guardCodes(PLANNING, plan, { patch: { start: "2026-10-19T11:00:00+03:00" } })).toEqual([]);
  });

  it("правка, которую план не отметил в touched, отвергается", () => {
    const after = calendar(
      vevent([...SERIES.map((line) => line.replace("SUMMARY:Планёрка", "SUMMARY:Совещание")), "EXDATE;TZID=Europe/Moscow:20261028T100000"]),
      override("20261021T100000", "20261021T150000", "20261021T160000", "SUMMARY:Планёрка (перенос)"),
      override("20261026T100000", "20261026T100000", "20261026T110000", "SUMMARY:Планёрка с гостем"),
    );
    const plan = putPlan(after, { op: "update", scope: "all_series", fields: ["summary"], touched: newTouched() });
    expect(guardCodes(PLANNING, plan, { patch: { summary: "Совещание" } })).toEqual(["untouched-changed"]);
  });

  it("правка названия, которая заодно отменила встречу (STATUS), отвергается: такого поля патч не называет", () => {
    const after = calendar(
      vevent([...SERIES.map((line) => line.replace("SUMMARY:Планёрка", "SUMMARY:Совещание")), "EXDATE;TZID=Europe/Moscow:20261028T100000"]),
      override("20261021T100000", "20261021T150000", "20261021T160000", "SUMMARY:Планёрка (перенос)"),
      override("20261026T100000", "20261026T100000", "20261026T110000", "SUMMARY:Планёрка с гостем", "STATUS:CANCELLED"),
    );
    const plan = putPlan(after, { op: "update", scope: "all_series", fields: ["summary"] });
    expect(guardCodes(PLANNING, plan, { patch: { summary: "Совещание" } })).toEqual(["untouched-changed"]);
  });

  it("встреча, потерявшая своё переопределение, отвергается", () => {
    const after = calendar(
      vevent([...SERIES, "EXDATE;TZID=Europe/Moscow:20261028T100000"]),
      override("20261021T100000", "20261021T150000", "20261021T160000", "SUMMARY:Планёрка (перенос)"),
      vevent(["SUMMARY:Метка правки", "DTSTART;TZID=Europe/Moscow:20261019T100000",
        "DTEND;TZID=Europe/Moscow:20261019T110000", "RECURRENCE-ID;TZID=Europe/Moscow:20261019T100000"]),
    );
    // Переопределение 26.10 снято: встреча на его месте осталась, но её
    // собственные поля вернулись к основному компоненту.
    const plan = putPlan(after, { op: "update", scope: "all_series", fields: ["summary"] });
    expect(guardCodes(PLANNING, plan, { patch: { summary: "Планёрка" } })).toContain("override-lost");
  });
});

// ─────────────────────────────── пропажа и появление ───────────────────────────────

describe("пропажа встречи", () => {
  it("удаление одной встречи принимается: цель адресована этим scope", () => {
    const after = calendar(
      vevent([...SERIES, "EXDATE;TZID=Europe/Moscow:20261028T100000", "EXDATE;TZID=Europe/Moscow:20261026T100000"]),
      override("20261021T100000", "20261021T150000", "20261021T160000", "SUMMARY:Планёрка (перенос)"),
    );
    const plan = putPlan(after, { op: "delete", scope: "this", target: timeKey("2026-10-26T10:00:00+03:00") });
    expect(guardCodes(PLANNING, plan)).toEqual([]);
  });

  it("удаление, которое заодно закрыло чужую встречу, отвергается", () => {
    const after = calendar(
      vevent([...SERIES, "EXDATE;TZID=Europe/Moscow:20261028T100000", "EXDATE;TZID=Europe/Moscow:20261026T100000",
        "EXDATE;TZID=Europe/Moscow:20261102T100000"]),
      override("20261021T100000", "20261021T150000", "20261021T160000", "SUMMARY:Планёрка (перенос)"),
    );
    const plan = putPlan(after, { op: "delete", scope: "this", target: timeKey("2026-10-26T10:00:00+03:00") });
    expect(guardCodes(PLANNING, plan)).toEqual(["meeting-lost"]);
  });

  it("удаление, которое не удалило, отвергается: встреча названа убранной и осталась", () => {
    const after = calendar(
      vevent([...SERIES, "EXDATE;TZID=Europe/Moscow:20261028T100000"]),
      override("20261021T100000", "20261021T150000", "20261021T160000", "SUMMARY:Планёрка (перенос)"),
    );
    const plan = putPlan(after, { op: "delete", scope: "this", target: timeKey("2026-10-26T10:00:00+03:00") });
    expect(guardCodes(PLANNING, plan)).toContain("meeting-added");
  });

  it("усечение «эта и следующие» принимается", () => {
    const after = calendar(
      vevent(["DTSTART;TZID=Europe/Moscow:20261019T100000", "DTEND;TZID=Europe/Moscow:20261019T110000",
        "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=4", "SUMMARY:Планёрка", "EXDATE;TZID=Europe/Moscow:20261028T100000"]),
      override("20261021T100000", "20261021T150000", "20261021T160000", "SUMMARY:Планёрка (перенос)"),
      override("20261026T100000", "20261026T100000", "20261026T110000", "SUMMARY:Планёрка с гостем"),
    );
    const plan = putPlan(after, { op: "delete", scope: "this_and_following", target: timeKey("2026-11-02T10:00:00+03:00") });
    expect(guardCodes(PLANNING, plan)).toEqual([]);
  });

  it("усечение, срезавшее встречу до границы, отвергается", () => {
    const after = calendar(
      vevent(["DTSTART;TZID=Europe/Moscow:20261019T100000", "DTEND;TZID=Europe/Moscow:20261019T110000",
        "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=2", "SUMMARY:Планёрка"]),
      override("20261021T100000", "20261021T150000", "20261021T160000", "SUMMARY:Планёрка (перенос)"),
    );
    const plan = putPlan(after, { op: "delete", scope: "this_and_following", target: timeKey("2026-11-02T10:00:00+03:00") });
    // У встречи 26.10 своё переопределение, поэтому её пропажа — override-lost.
    expect(guardCodes(PLANNING, plan)).toContain("override-lost");
  });
});

describe("появление встречи", () => {
  it("правка названия, которая заодно добавила встречу, отвергается", () => {
    const after = calendar(
      vevent([...SERIES, "EXDATE;TZID=Europe/Moscow:20261028T100000", "RDATE;TZID=Europe/Moscow:20261030T100000"]),
      override("20261021T100000", "20261021T150000", "20261021T160000", "SUMMARY:Планёрка (перенос)"),
      override("20261026T100000", "20261026T100000", "20261026T110000", "SUMMARY:Планёрка с гостем"),
    );
    const plan = putPlan(after, { op: "update", scope: "all_series", fields: ["summary"] });
    expect(guardCodes(PLANNING, plan, { patch: { summary: "Планёрка" } })).toContain("meeting-added");
  });

  it("смена повтора вправе назначить другие встречи", () => {
    const after = calendar(
      vevent(["DTSTART;TZID=Europe/Moscow:20261019T100000", "DTEND;TZID=Europe/Moscow:20261019T110000",
        "RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=6", "SUMMARY:Планёрка", "EXDATE;TZID=Europe/Moscow:20261028T100000"]),
      override("20261026T100000", "20261026T100000", "20261026T110000", "SUMMARY:Планёрка с гостем"),
    );
    const plan = putPlan(
      after,
      { op: "update", scope: "all_series", fields: ["recurrence"], ruleChanged: true, removed: [timeKey("2026-10-21T10:00:00+03:00")] },
      [lossOf("2026-10-21T10:00:00+03:00")],
    );
    expect(guardCodes(PLANNING, plan, { patch: { recurrence: { byWeekday: ["MO"] } } })).toEqual([]);
  });

  it("смена повтора не воскрешает встречу, названную убранной", () => {
    const after = calendar(
      vevent(["DTSTART;TZID=Europe/Moscow:20261019T100000", "DTEND;TZID=Europe/Moscow:20261019T110000",
        "RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=6", "SUMMARY:Планёрка", "EXDATE;TZID=Europe/Moscow:20261028T100000"]),
      override("20261021T100000", "20261021T150000", "20261021T160000", "SUMMARY:Планёрка (перенос)"),
      override("20261026T100000", "20261026T100000", "20261026T110000", "SUMMARY:Планёрка с гостем"),
    );
    const plan = putPlan(
      after,
      { op: "update", scope: "all_series", fields: ["recurrence"], ruleChanged: true, removed: [timeKey("2026-10-21T10:00:00+03:00")] },
      [lossOf("2026-10-21T10:00:00+03:00")],
    );
    expect(guardCodes(PLANNING, plan, { patch: { recurrence: { byWeekday: ["MO"] } } })).toContain("meeting-added");
  });
});

// ─────────────────────────────── скрытые переопределения ───────────────────────────────

/** PLANNING и скрытое переопределение под EXDATE 28.10 — след прошлого удаления. */
const WITH_HIDDEN = calendar(
  vevent([...SERIES, "EXDATE;TZID=Europe/Moscow:20261028T100000"]),
  override("20261021T100000", "20261021T150000", "20261021T160000", "SUMMARY:Планёрка (перенос)"),
  override("20261026T100000", "20261026T100000", "20261026T110000", "SUMMARY:Планёрка с гостем"),
  override("20261028T100000", "20261028T100000", "20261028T110000", "SUMMARY:Планёрка (отменена)"),
);

describe("скрытые переопределения", () => {
  it("молчаливый выброс скрытого компонента отвергается", () => {
    const plan = putPlan(PLANNING, { op: "update", scope: "all_series", fields: ["summary"] });
    expect(guardCodes(WITH_HIDDEN, plan, { patch: { summary: "Планёрка" } })).toContain("override-lost");
  });

  it("снятие скрытого, названного в ответе, принимается", () => {
    const plan = putPlan(
      PLANNING,
      { op: "update", scope: "all_series", fields: ["summary"] },
      [lossOf("2026-10-28T10:00:00+03:00")],
    );
    expect(guardCodes(WITH_HIDDEN, plan, { patch: { summary: "Планёрка" } })).toEqual([]);
  });

  it("снятие переопределения, чей RECURRENCE-ID правка времени успела переписать, принимается", () => {
    // Сдвиг серии на час переписывает и EXDATE, и RECURRENCE-ID, а скрытый
    // компонент снимается — назван он прежним адресом, как его видел
    // пользователь до записи.
    const after = calendar(
      vevent(["DTSTART;TZID=Europe/Moscow:20261019T110000", "DTEND;TZID=Europe/Moscow:20261019T120000",
        "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6", "SUMMARY:Планёрка", "EXDATE;TZID=Europe/Moscow:20261028T110000"]),
      override("20261021T110000", "20261021T150000", "20261021T160000", "SUMMARY:Планёрка (перенос)"),
      override("20261026T110000", "20261026T110000", "20261026T120000", "SUMMARY:Планёрка с гостем"),
    );
    const plan = putPlan(
      after,
      { op: "update", scope: "all_series", fields: ["start"], keyMap: shiftBy(3600), datesFixed: true },
      [lossOf("2026-10-28T10:00:00+03:00")],
    );
    expect(guardCodes(WITH_HIDDEN, plan, { patch: { start: "2026-10-19T11:00:00+03:00" } })).toEqual([]);
  });

  it("снятый EXDATE, от которого скрытое стало встречей, отвергается", () => {
    const after = calendar(
      vevent([...SERIES]),
      override("20261021T100000", "20261021T150000", "20261021T160000", "SUMMARY:Планёрка (перенос)"),
      override("20261026T100000", "20261026T100000", "20261026T110000", "SUMMARY:Планёрка с гостем"),
      override("20261028T100000", "20261028T100000", "20261028T110000", "SUMMARY:Планёрка (отменена)"),
    );
    const plan = putPlan(after, { op: "update", scope: "all_series", fields: ["summary"] });
    expect(guardCodes(WITH_HIDDEN, plan, { patch: { summary: "Планёрка" } })).toEqual(["meeting-added"]);
  });

  it("новый EXDATE, от которого встреча стала скрытой, отвергается", () => {
    const after = calendar(
      vevent([...SERIES, "EXDATE;TZID=Europe/Moscow:20261028T100000", "EXDATE;TZID=Europe/Moscow:20261026T100000"]),
      override("20261021T100000", "20261021T150000", "20261021T160000", "SUMMARY:Планёрка (перенос)"),
      override("20261026T100000", "20261026T100000", "20261026T110000", "SUMMARY:Планёрка с гостем"),
      override("20261028T100000", "20261028T100000", "20261028T110000", "SUMMARY:Планёрка (отменена)"),
    );
    const plan = putPlan(after, { op: "update", scope: "all_series", fields: ["summary"] });
    expect(guardCodes(WITH_HIDDEN, plan, { patch: { summary: "Планёрка" } })).toEqual(["meeting-lost"]);
  });

  it("тот же сдвиг времени, но скрытое снято молча, отвергается", () => {
    const after = calendar(
      vevent(["DTSTART;TZID=Europe/Moscow:20261019T110000", "DTEND;TZID=Europe/Moscow:20261019T120000",
        "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6", "SUMMARY:Планёрка", "EXDATE;TZID=Europe/Moscow:20261028T110000"]),
      override("20261021T110000", "20261021T150000", "20261021T160000", "SUMMARY:Планёрка (перенос)"),
      override("20261026T110000", "20261026T110000", "20261026T120000", "SUMMARY:Планёрка с гостем"),
    );
    const plan = putPlan(after, { op: "update", scope: "all_series", fields: ["start"], keyMap: shiftBy(3600), datesFixed: true });
    expect(guardCodes(WITH_HIDDEN, plan, { patch: { start: "2026-10-19T11:00:00+03:00" } })).toContain("override-lost");
  });
});

// ─────────────────────────────── оторванные встречи ───────────────────────────────

/** PLANNING и оторванная встреча 27.10 (вторник — не слот серии). */
const WITH_DETACHED = calendar(
  vevent([...SERIES, "EXDATE;TZID=Europe/Moscow:20261028T100000"]),
  override("20261021T100000", "20261021T150000", "20261021T160000", "SUMMARY:Планёрка (перенос)"),
  override("20261026T100000", "20261026T100000", "20261026T110000", "SUMMARY:Планёрка с гостем"),
  override("20261027T100000", "20261027T100000", "20261027T110000", "SUMMARY:Разбор отдельно"),
);

describe("оторванные встречи", () => {
  it("удаление оторванной встречи принимается", () => {
    const plan = putPlan(PLANNING, { op: "delete", scope: "this", target: timeKey("2026-10-27T10:00:00+03:00") });
    expect(guardCodes(WITH_DETACHED, plan)).toEqual([]);
  });

  it("воскрешение удалённой встречи оторванным переопределением на её ключе отвергается", () => {
    const after = calendar(
      vevent([...SERIES, "EXDATE;TZID=Europe/Moscow:20261028T100000"]),
      override("20261021T100000", "20261021T150000", "20261021T160000", "SUMMARY:Планёрка (перенос)"),
      override("20261026T100000", "20261026T100000", "20261026T110000", "SUMMARY:Планёрка с гостем"),
      override("20261027T100000", "20261027T140000", "20261027T150000", "SUMMARY:Разбор отдельно (заново)"),
    );
    const plan = putPlan(
      after,
      { op: "delete", scope: "this", target: timeKey("2026-10-27T10:00:00+03:00") },
      [lossOf("2026-10-27T10:00:00+03:00")],
    );
    expect(guardCodes(WITH_DETACHED, plan)).toContain("meeting-added");
  });
});

// ─────────────────────────────── конец серии ───────────────────────────────

describe("конец серии", () => {
  it("снятие COUNT без просьбы отвергается", () => {
    const after = calendar(
      vevent(["DTSTART;TZID=Europe/Moscow:20261019T100000", "DTEND;TZID=Europe/Moscow:20261019T110000",
        "RRULE:FREQ=WEEKLY;BYDAY=MO,WE", "SUMMARY:Совещание", "EXDATE;TZID=Europe/Moscow:20261028T100000"]),
      override("20261021T100000", "20261021T150000", "20261021T160000", "SUMMARY:Планёрка (перенос)"),
      override("20261026T100000", "20261026T100000", "20261026T110000", "SUMMARY:Планёрка с гостем"),
    );
    const plan = putPlan(after, { op: "update", scope: "all_series", fields: ["summary"] });
    expect(guardCodes(PLANNING, plan, { patch: { summary: "Совещание" } })).toContain("extent-mismatch");
  });

  it("снятие COUNT по просьбе принимается", () => {
    const after = calendar(
      vevent(["DTSTART;TZID=Europe/Moscow:20261019T100000", "DTEND;TZID=Europe/Moscow:20261019T110000",
        "RRULE:FREQ=WEEKLY;BYDAY=MO,WE", "SUMMARY:Планёрка", "EXDATE;TZID=Europe/Moscow:20261028T100000"]),
      override("20261021T100000", "20261021T150000", "20261021T160000", "SUMMARY:Планёрка (перенос)"),
      override("20261026T100000", "20261026T100000", "20261026T110000", "SUMMARY:Планёрка с гостем"),
    );
    const plan = putPlan(after, { op: "update", scope: "all_series", fields: ["recurrence"], ruleChanged: true });
    expect(guardCodes(PLANNING, plan, { patch: { recurrence: { count: null } } })).toEqual([]);
  });

  it("появление конца у бесконечной серии без просьбы отвергается", () => {
    const endless = calendar(vevent(["DTSTART;TZID=Europe/Moscow:20261019T100000", "DTEND;TZID=Europe/Moscow:20261019T110000",
      "RRULE:FREQ=WEEKLY;BYDAY=MO", "SUMMARY:Планёрка"]));
    const after = calendar(vevent(["DTSTART;TZID=Europe/Moscow:20261019T100000", "DTEND;TZID=Europe/Moscow:20261019T110000",
      "RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20281201T070000Z", "SUMMARY:Совещание"]));
    const plan = putPlan(after, { op: "update", scope: "all_series", fields: ["summary"] });
    expect(guardCodes(endless, plan, { patch: { summary: "Совещание" } })).toContain("extent-mismatch");
  });
});

// ─────────────────────────────── первое правило (Critical прежнего круга) ───────────────────────────────

/** Одиночное событие 19.10.2026 10:00–11:00 МСК. */
const SINGLE = calendar(vevent(["DTSTART;TZID=Europe/Moscow:20261019T100000",
  "DTEND;TZID=Europe/Moscow:20261019T110000", "SUMMARY:Планёрка"]));

/** То же с первым — бесконечным — правилом. */
const SINGLE_WITH_RULE = calendar(vevent(["DTSTART;TZID=Europe/Moscow:20261019T100000",
  "DTEND;TZID=Europe/Moscow:20261019T110000", "SUMMARY:Планёрка", "RRULE:FREQ=WEEKLY;BYDAY=MO"]));

/** Серия из одних RDATE: 19.10 и 21.10, правила нет. */
const RDATE_ONLY = calendar(vevent(["DTSTART;TZID=Europe/Moscow:20261019T100000",
  "DTEND;TZID=Europe/Moscow:20261019T110000", "SUMMARY:Планёрка",
  "RDATE;TZID=Europe/Moscow:20261021T100000", "RDATE;TZID=Europe/Moscow:20261026T100000"]));

describe("первое правило", () => {
  const firstRule = { recurrence: { frequency: "weekly" as const, byWeekday: ["MO" as const] } };

  for (const scope of ["this", "all_series", "this_and_following"] as const) {
    it(`одиночное событие получает первое бесконечное правило (scope ${scope})`, () => {
      const plan = putPlan(SINGLE_WITH_RULE, {
        op: "update",
        scope,
        fields: ["recurrence"],
        ruleChanged: true,
        target: scope === "this" || scope === "this_and_following" ? timeKey("2026-10-19T10:00:00+03:00") : undefined,
      });
      expect(guardCodes(SINGLE, plan, { patch: firstRule })).toEqual([]);
    });
  }

  it("серия из одних RDATE получает первое правило", () => {
    const after = calendar(vevent(["DTSTART;TZID=Europe/Moscow:20261019T100000",
      "DTEND;TZID=Europe/Moscow:20261019T110000", "SUMMARY:Планёрка", "RRULE:FREQ=WEEKLY;BYDAY=MO",
      "RDATE;TZID=Europe/Moscow:20261021T100000", "RDATE;TZID=Europe/Moscow:20261026T100000"]));
    const plan = putPlan(after, { op: "update", scope: "all_series", fields: ["recurrence"], ruleChanged: true });
    expect(guardCodes(RDATE_ONLY, plan, { patch: firstRule })).toEqual([]);
  });
});

// ─────────────────────────────── разрез ───────────────────────────────

describe("разрез серии", () => {
  /** Усечённая исходная серия из одних RDATE: осталась только встреча 19.10. */
  const truncated = calendar(vevent(["DTSTART;TZID=Europe/Moscow:20261019T100000",
    "DTEND;TZID=Europe/Moscow:20261019T110000", "SUMMARY:Планёрка"]));
  /** Продолжение: граница стала DTSTART, прочие RDATE перешли в него. */
  const continuation = calendar(vevent(["DTSTART;TZID=Europe/Moscow:20261021T100000",
    "DTEND;TZID=Europe/Moscow:20261021T110000", "SUMMARY:Разбор",
    "RDATE;TZID=Europe/Moscow:20261026T100000"], `${UID}-2`));

  it("разрез серии из одних RDATE, где граница стала DTSTART продолжения, принимается", () => {
    const plan = splitPlan(truncated, continuation, timeKey("2026-10-21T10:00:00+03:00"), {
      op: "update",
      scope: "this_and_following",
      fields: ["summary"],
      ruleChanged: true,
    });
    expect(guardCodes(RDATE_ONLY, plan, { patch: { summary: "Разбор" } })).toEqual([]);
  });

  it("разрез, потерявший встречу хвоста, отвергается", () => {
    const lost = calendar(vevent(["DTSTART;TZID=Europe/Moscow:20261021T100000",
      "DTEND;TZID=Europe/Moscow:20261021T110000", "SUMMARY:Разбор"], `${UID}-2`));
    const plan = splitPlan(truncated, lost, timeKey("2026-10-21T10:00:00+03:00"), {
      op: "update",
      scope: "this_and_following",
      fields: ["summary"],
      ruleChanged: true,
    });
    expect(guardCodes(RDATE_ONLY, plan, { patch: { summary: "Разбор" } })).toContain("meeting-lost");
  });

  it("продолжение с UID исходной серии отвергается", () => {
    const sameUid = calendar(vevent(["DTSTART;TZID=Europe/Moscow:20261021T100000",
      "DTEND;TZID=Europe/Moscow:20261021T110000", "SUMMARY:Разбор",
      "RDATE;TZID=Europe/Moscow:20261026T100000"]));
    const plan: WritePlan = {
      kind: "split",
      continuation: { uid: UID, ics: sameUid },
      truncated: { ics: truncated },
      boundary: timeKey("2026-10-21T10:00:00+03:00"),
      expect: expectation(truncated, {
        op: "update",
        scope: "this_and_following",
        fields: ["summary"],
        target: timeKey("2026-10-21T10:00:00+03:00"),
        ruleChanged: true,
      }),
      removed: [],
      notices: [],
    };
    expect(guardCodes(RDATE_ONLY, plan, { patch: { summary: "Разбор" } })).toContain("invariant");
  });
});

// ─────────────────────────────── RDATE;VALUE=PERIOD ───────────────────────────────

describe("RDATE;VALUE=PERIOD", () => {
  /** Серия с добавочной встречей 30.10 12:00 на два часа — своим концом. */
  const withPeriod = calendar(vevent(["DTSTART;TZID=Europe/Moscow:20261019T100000",
    "DTEND;TZID=Europe/Moscow:20261019T110000", "SUMMARY:Планёрка",
    "RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=3",
    "RDATE;TZID=Europe/Moscow;VALUE=PERIOD:20261030T120000/PT2H"]));

  it("потеря собственного конца у RDATE;VALUE=PERIOD отвергается", () => {
    const after = calendar(vevent(["DTSTART;TZID=Europe/Moscow:20261019T100000",
      "DTEND;TZID=Europe/Moscow:20261019T110000", "SUMMARY:Совещание",
      "RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=3",
      "RDATE;TZID=Europe/Moscow:20261030T120000"]));
    const plan = putPlan(after, { op: "update", scope: "all_series", fields: ["summary"] });
    expect(guardCodes(withPeriod, plan, { patch: { summary: "Совещание" } })).toContain("time-changed");
  });

  it("правка названия при сохранённом периоде принимается", () => {
    const after = calendar(vevent(["DTSTART;TZID=Europe/Moscow:20261019T100000",
      "DTEND;TZID=Europe/Moscow:20261019T110000", "SUMMARY:Совещание",
      "RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=3",
      "RDATE;TZID=Europe/Moscow;VALUE=PERIOD:20261030T120000/PT2H"]));
    const plan = putPlan(after, { op: "update", scope: "all_series", fields: ["summary"] });
    expect(guardCodes(withPeriod, plan, { patch: { summary: "Совещание" } })).toEqual([]);
  });
});

// ─────────────────────────────── объект целиком ───────────────────────────────

describe("объект целиком", () => {
  it("удаление всей серии принимается без разбора текста", () => {
    const plan = deleteObjectPlan({ op: "delete", scope: "all_series" });
    expect(guardCodes(PLANNING, plan)).toEqual([]);
    expect(guardCodes("это вообще не iCalendar", plan)).toEqual([]);
  });

  it("удаление объекта ради одной встречи, когда остальные живы, отвергается", () => {
    const plan = deleteObjectPlan({ op: "delete", scope: "this", target: timeKey("2026-10-26T10:00:00+03:00") });
    expect(guardCodes(PLANNING, plan)).toContain("not-empty");
  });

  it("удаление объекта, в котором после цели не осталось встреч, принимается", () => {
    const plan = deleteObjectPlan({ op: "delete", scope: "this", target: timeKey("2026-10-19T10:00:00+03:00") });
    expect(guardCodes(SINGLE, plan)).toEqual([]);
  });

  it("запись, оставляющая объект без встреч, отвергается: это удаление, а не put", () => {
    const empty = calendar(vevent(["DTSTART;TZID=Europe/Moscow:20261019T100000",
      "DTEND;TZID=Europe/Moscow:20261019T110000", "SUMMARY:Планёрка",
      "RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=1", "EXDATE;TZID=Europe/Moscow:20261019T100000"]));
    const plan = putPlan(empty, { op: "delete", scope: "this", target: timeKey("2026-10-19T10:00:00+03:00") });
    expect(guardCodes(SINGLE, plan)).toContain("empty-left");
  });

  it("запись с чужим UID отвергается", () => {
    const alien = calendar(vevent(["DTSTART;TZID=Europe/Moscow:20261019T100000",
      "DTEND;TZID=Europe/Moscow:20261019T110000", "SUMMARY:Планёрка"], "другой-объект@yandex.ru"));
    const plan = putPlan(alien, { op: "update", scope: "all_series", fields: ["summary"] });
    expect(guardCodes(SINGLE, plan, { patch: { summary: "Планёрка" } })).toContain("invariant");
  });

  it("лишний компонент с чужим UID отвергается", () => {
    const mixed = calendar(
      vevent(["DTSTART;TZID=Europe/Moscow:20261019T100000", "DTEND;TZID=Europe/Moscow:20261019T110000", "SUMMARY:Совещание"]),
      vevent(["DTSTART;TZID=Europe/Moscow:20261020T100000", "DTEND;TZID=Europe/Moscow:20261020T110000", "SUMMARY:Чужое"],
        "чужой@yandex.ru"),
    );
    const plan = putPlan(mixed, { op: "update", scope: "all_series", fields: ["summary"] });
    expect(guardCodes(SINGLE, plan, { patch: { summary: "Совещание" } })).toContain("invariant");
  });
});

// ─────────────────────────────── длинная серия ───────────────────────────────

describe("длинная серия", () => {
  /** Бесконечная ежедневная серия: до горизонта её встреч больше упора набора. */
  const daily = calendar(vevent(["DTSTART;TZID=Europe/Moscow:20261019T100000",
    "DTEND;TZID=Europe/Moscow:20261019T110000", "SUMMARY:Планёрка", "RRULE:FREQ=DAILY"]));

  it("правка названия принимается, хотя встреч до горизонта больше упора", () => {
    const after = calendar(vevent(["DTSTART;TZID=Europe/Moscow:20261019T100000",
      "DTEND;TZID=Europe/Moscow:20261019T110000", "SUMMARY:Совещание", "RRULE:FREQ=DAILY"]));
    const plan = putPlan(after, { op: "update", scope: "all_series", fields: ["summary"] });
    expect(guardCodes(daily, plan, { patch: { summary: "Совещание" } })).toEqual([]);
  });

  it("встреча, закрытая под видом правки названия, отвергается и в длинной серии", () => {
    const after = calendar(vevent(["DTSTART;TZID=Europe/Moscow:20261019T100000",
      "DTEND;TZID=Europe/Moscow:20261019T110000", "SUMMARY:Совещание", "RRULE:FREQ=DAILY",
      "EXDATE;TZID=Europe/Moscow:20261021T100000"]));
    const plan = putPlan(after, { op: "update", scope: "all_series", fields: ["summary"] });
    expect(guardCodes(daily, plan, { patch: { summary: "Совещание" } })).toEqual(["meeting-lost"]);
  });
});

// ─────────────────────────────── форма плана ───────────────────────────────

describe("форма плана", () => {
  it("запись, тождественная прочитанному тексту, отвергается", () => {
    const same = serializeObject(load(PLANNING));
    const plan = putPlan(same, { op: "update", scope: "all_series", fields: ["summary"] });
    expect(guardCodes(PLANNING, plan, { patch: { summary: "Совещание" } })).toEqual(["plan-shape"]);
  });

  it("пустой план, называющий убранные встречи, отвергается", () => {
    const plan: WritePlan = {
      kind: "noop",
      expect: expectation(PLANNING, { op: "update", scope: "all_series" }),
      removed: [lossOf("2026-10-26T10:00:00+03:00")],
      notices: [],
    };
    expect(guardCodes(PLANNING, plan)).toEqual(["plan-shape"]);
  });

  it("правка, удаляющая объект целиком, отвергается", () => {
    const plan = deleteObjectPlan({ op: "update", scope: "all_series" });
    expect(guardCodes(PLANNING, plan)).toEqual(["plan-shape"]);
  });

  it("неразобранный прочитанный объект — отказ у всего, кроме удаления всей серии", () => {
    const plan = putPlan(PLANNING, { op: "update", scope: "all_series", fields: ["summary"] });
    expect(guardCodes("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n", plan)).toEqual(["unparsable"]);
  });

  it("поле, которого нет в патче, проверку не ослабляет", () => {
    // План заявил start, но патч его не называет: время остаётся под охраной.
    const after = calendar(vevent(["DTSTART;TZID=Europe/Moscow:20261019T120000",
      "DTEND;TZID=Europe/Moscow:20261019T130000", "SUMMARY:Планёрка"]));
    const plan = putPlan(after, {
      op: "update",
      scope: "all_series",
      fields: ["start", "summary"],
      keyMap: shiftBy(2 * 3600),
    });
    expect(guardCodes(SINGLE, plan, { patch: { summary: "Планёрка" } })).toContain("time-changed");
  });
});
