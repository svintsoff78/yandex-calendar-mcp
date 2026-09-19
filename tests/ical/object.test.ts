import ICAL from "ical.js";
import { describe, expect, it } from "vitest";
import {
  blockingAnomalies,
  ensureTimezones,
  formatAnomaly,
  isUnparsable,
  loadObject,
  meetingAt,
  semanticDigest,
  serializeObject,
  shownOverride,
  splitContentLine,
  type CalendarObject,
  type OverrideRoleInfo,
  type Unparsable,
} from "../../src/ical/object.js";
import type { IcalEnv, SlotKey } from "../../src/ical/values.js";
import { reorderOverridesFirst, yandexNormalize } from "../support/fakeCaldav.js";
import * as seeds from "../support/seeds.js";

// Модель календарного объекта (О1, О14, Р4, Р5, Р8 плана переделки,
// docs/superpowers/plans/2026-09-19-recurring-events-rework.md, задача З06).
// Тесты не зависят от пояса процесса: ожидаемые моменты — строки ISO со
// смещением.

const ENV: IcalEnv = { floatingZone: "Europe/Moscow", ownerEmail: "user@yandex.ru" };
const CRLF = "\r\n";

const MOSCOW = [
  "BEGIN:VTIMEZONE", "TZID:Europe/Moscow", "BEGIN:STANDARD", "TZNAME:MSK", "TZOFFSETFROM:+0300",
  "TZOFFSETTO:+0300", "DTSTART:19700101T000000", "END:STANDARD", "END:VTIMEZONE",
];
const MOSCOW_1990 = [
  "BEGIN:VTIMEZONE", "TZID:Europe/Moscow",
  "BEGIN:STANDARD", "TZNAME:MSK", "TZOFFSETFROM:+0300", "TZOFFSETTO:+0300", "DTSTART:19700101T000000", "END:STANDARD",
  "BEGIN:DAYLIGHT", "TZNAME:MSD", "TZOFFSETFROM:+0300", "TZOFFSETTO:+0400", "DTSTART:19900325T020000", "END:DAYLIGHT",
  "BEGIN:STANDARD", "TZNAME:MSK", "TZOFFSETFROM:+0400", "TZOFFSETTO:+0300", "DTSTART:19900930T030000", "END:STANDARD",
  "END:VTIMEZONE",
];

const UID = "object-test@yandex.ru";
const SERIES = ["DTSTART;TZID=Europe/Moscow:20261019T100000", "DTEND;TZID=Europe/Moscow:20261019T110000",
  "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6", "SUMMARY:Планёрка"];

function vevent(lines: string[], uid = UID): string[] {
  return ["BEGIN:VEVENT", `UID:${uid}`, "DTSTAMP:20261001T090000Z", ...lines, "END:VEVENT"];
}

function calendar(zones: string[], ...events: string[][]): string {
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//object//RU", ...zones, ...events.flat(), "END:VCALENDAR"]
    .join(CRLF) + CRLF;
}

/** Переопределение серии Europe/Moscow: RID, начало и конец — стенное время МСК. */
function moved(rid: string, start: string, end: string, ...extra: string[]): string[] {
  return vevent([`RECURRENCE-ID;TZID=Europe/Moscow:${rid}`, `DTSTART;TZID=Europe/Moscow:${start}`,
    `DTEND;TZID=Europe/Moscow:${end}`, "SUMMARY:Перенос", ...extra]);
}

function load(ics: string): CalendarObject {
  const object = loadObject(ics, ENV);
  if (object.kind === "unparsable") throw new Error(`не разобран: ${object.error}`);
  return object;
}

function unparsable(ics: string): Unparsable {
  const object = loadObject(ics, ENV);
  if (object.kind !== "unparsable") throw new Error(`разобран как ${object.kind}`);
  return object;
}

const at = (iso: string): SlotKey => `T:${Date.parse(iso) / 1000}`;
const codes = (o: CalendarObject) => o.anomalies.map((anomaly) => anomaly.code);

/** Переопределения объекта по порядку в файле. */
function overridesOf(o: CalendarObject): ICAL.Component[] {
  return o.root.getAllSubcomponents("vevent").filter((c) => c.hasProperty("recurrence-id"));
}

function roleOf(o: CalendarObject, component: ICAL.Component): OverrideRoleInfo {
  const info = o.roles.get(component);
  if (!info) throw new Error("у переопределения нет роли");
  return info;
}

describe("loadObject: основной компонент по отсутствию RECURRENCE-ID (О1)", () => {
  it("переопределение первым в файле не становится основным (C56, записано прежним кодом)", () => {
    const o = load(seeds.c56StaleShift.ics);

    expect(o.kind).toBe("series");
    expect(o.uid).toBe(seeds.c56StaleShift.uid);
    expect(o.master?.hasProperty("recurrence-id")).toBe(false);
    expect(o.master?.getFirstPropertyValue("dtstart")?.toString()).toBe("2026-10-19T09:00:00");
    expect(o.form).toBe("zoned");
    expect(o.tzid).toBe("Europe/Moscow");
  });

  it("виды объектов: одиночное, серия, объект из одних переопределений", () => {
    expect(load(seeds.singleMoscow.ics).kind).toBe("single");
    expect(load(seeds.weeklyMoscow.ics).kind).toBe("series");
    const detached = load(calendar(MOSCOW, moved("20261021T100000", "20261021T150000", "20261021T160000")));

    expect(detached.kind).toBe("detached");
    expect(detached.master).toBeNull();
    expect(detached.form).toBe("zoned");
    expect([...detached.roles.values()].map((info) => info.role)).toEqual(["detached"]);
  });

  it("формы серий: дата, UTC, плавающее время", () => {
    expect(load(seeds.allDayWeekly.ics).form).toBe("date");
    expect(load(seeds.floatingDaily.ics).form).toBe("floating");
    const utc = load(calendar([], vevent(["DTSTART:20261019T070000Z", "DURATION:PT1H", "RRULE:FREQ=DAILY;COUNT=2"])));
    expect(utc.form).toBe("utc");
    expect(utc.tzid).toBeUndefined();
  });

  it("два основных компонента — аномалия multiple-masters, основным считается первый", () => {
    const o = load(calendar(MOSCOW, vevent(SERIES), vevent(["DTSTART;TZID=Europe/Moscow:20261020T100000",
      "DURATION:PT1H", "SUMMARY:Второй"])));

    expect(codes(o)).toContain("multiple-masters");
    expect(o.master?.getFirstPropertyValue("summary")).toBe("Планёрка");
  });

  it("чужой UID в объекте — аномалия mixed-uids", () => {
    const foreign = moved("20261021T100000", "20261021T150000", "20261021T160000").map((line) =>
      line.startsWith("UID:") ? "UID:other@yandex.ru" : line);
    const o = load(calendar(MOSCOW, vevent(SERIES), foreign));

    expect(codes(o)).toContain("mixed-uids");
    expect(o.uid).toBe(UID);
  });

  it("TZID без VTIMEZONE в объекте регистрируется из базы IANA до чтения значений", () => {
    // time.js, fromDateTimeString: пояс, которого нет ни в дереве, ни в сервисе,
    // даёт плавающее время, а значение кешируется (property.js, _hydrateValue).
    const o = load(calendar([], vevent(["DTSTART;TZID=Asia/Kathmandu:20261019T100000", "DURATION:PT1H",
      "RRULE:FREQ=DAILY;COUNT=2"])));
    const dtstart = o.master!.getFirstPropertyValue("dtstart") as ICAL.Time;

    expect(dtstart.zone?.tzid).toBe("Asia/Kathmandu");
    expect(dtstart.toUnixTime()).toBe(Date.parse("2026-10-19T04:15:00Z") / 1000);
    expect(o.anomalies).toEqual([]);
  });

  it("неизвестный TZID — аномалия unknown-tzid, момент — стенное время в поясе календаря", () => {
    const o = load(calendar([], vevent(["DTSTART;TZID=Nowhere/Zone:20261019T100000", "DURATION:PT1H",
      "RRULE:FREQ=DAILY;COUNT=2"])));

    expect(codes(o)).toEqual(["unknown-tzid"]);
    expect(o.anomalies[0].tzid).toBe("Nowhere/Zone");
    expect(o.form).toBe("zoned");
    expect(formatAnomaly(o.anomalies[0])).toMatch(/^unknown-tzid: .*Nowhere\/Zone/);
  });

  it("пояс из VTIMEZONE объекта предпочитается базе: DTSTART в 1990 году", () => {
    // Яндекс вкладывает полное историческое описание пояса (Ж10); в базе у
    // Москвы только +03 с 1970 года.
    const o = load(calendar(MOSCOW_1990, vevent(["DTSTART;TZID=Europe/Moscow:19900604T100000", "DURATION:PT1H",
      "RRULE:FREQ=WEEKLY;BYDAY=MO"]), moved("19900611T100000", "19900611T120000", "19900611T130000")));
    const [override] = overridesOf(o);

    expect((o.master!.getFirstPropertyValue("dtstart") as ICAL.Time).toUnixTime())
      .toBe(Date.parse("1990-06-04T06:00:00Z") / 1000);
    expect(roleOf(o, override)).toMatchObject({ role: "slot", slot: at("1990-06-11T06:00:00Z") });
  });

  it("индекс переопределений по ключу RECURRENCE-ID, с RANGE и отменой", () => {
    const o = load(calendar(MOSCOW, vevent(SERIES),
      moved("20261021T100000", "20261021T150000", "20261021T160000", "STATUS:CANCELLED"),
      vevent(["RECURRENCE-ID;RANGE=THISANDFUTURE;TZID=Europe/Moscow:20261028T100000",
        "DTSTART;TZID=Europe/Moscow:20261028T120000", "DTEND;TZID=Europe/Moscow:20261028T130000"])));

    expect([...o.overrides.keys()]).toEqual([at("2026-10-21T07:00:00Z"), at("2026-10-28T07:00:00Z")]);
    expect(o.overrides.get(at("2026-10-21T07:00:00Z"))?.[0]).toMatchObject({ cancelled: true, range: undefined });
    expect(o.overrides.get(at("2026-10-28T07:00:00Z"))?.[0]).toMatchObject({ cancelled: false, range: "thisandfuture" });
    expect(codes(o)).toEqual(["range-override"]);
  });

  it("информационные аномалии: EXRULE, несколько RRULE, DTSTART вне правила", () => {
    const o = load(calendar(MOSCOW, vevent(["DTSTART;TZID=Europe/Moscow:20261020T100000", "DURATION:PT1H",
      "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=4", "RRULE:FREQ=MONTHLY;COUNT=2", "EXRULE:FREQ=WEEKLY;BYDAY=WE;COUNT=1"])));

    expect(codes(o).sort()).toEqual(["exrule", "multiple-rrules", "unsynced-dtstart"]);
  });
});

describe("loadObject: Unparsable (Р4)", () => {
  const badRule = (rule: string) => calendar(MOSCOW,
    ["BEGIN:VEVENT", "UID:bad-", " rule@yandex.ru", "DTSTAMP:20261001T090000Z",
      "DTSTART;TZID=Europe/Moscow:20261019T100000", "DTEND;TZID=Europe/Moscow:20261019T110000",
      `RRULE:${rule}`, "SUMMARY:Правило с неизвестной ", " частотой\\, увы", "END:VEVENT"]);

  it.each([
    ["FREQ=FOO;COUNT=6"],
    ["FREQ=WEEKLY;BYDAY=0MO;COUNT=6"],
    ["FREQ=MONTHLY;BYMONTHDAY=32"],
    ["FREQ=DAILY;COUNT=x"],
  ])("плохое правило %s — заглушка с UID, SUMMARY и DTSTART из построчного разбора", (rule) => {
    const result = unparsable(badRule(rule));

    expect(result).toMatchObject({
      kind: "unparsable",
      uid: "bad-rule@yandex.ru",
      summary: "Правило с неизвестной частотой, увы",
      dtstartRaw: "DTSTART;TZID=Europe/Moscow:20261019T100000",
    });
    expect(result.error.length).toBeGreaterThan(0);
  });

  it("затравки C63 не разбираются", () => {
    for (const seed of seeds.unparsableSeeds) {
      expect(unparsable(seed.ics)).toMatchObject({ uid: seed.uid, dtstartRaw: "DTSTART;TZID=Europe/Moscow:20261019T100000" });
    }
  });

  it("поля берутся у основного компонента, даже если переопределение идёт первым", () => {
    const text = calendar(MOSCOW,
      ["BEGIN:VEVENT", "UID:x@yandex.ru", "RECURRENCE-ID;TZID=Europe/Moscow:20261021T100000",
        "DTSTART;TZID=Europe/Moscow:20261021T150000", "SUMMARY:Перенос", "END:VEVENT"],
      ["BEGIN:VEVENT", "UID:x@yandex.ru", "DTSTART;TZID=Europe/Moscow:20261019T100000", "RRULE:FREQ=FOO",
        'ORGANIZER;CN="Анна: главная":mailto:anna@example.com', "SUMMARY:Основной", "END:VEVENT"]);

    expect(unparsable(text)).toMatchObject({ uid: "x@yandex.ru", summary: "Основной",
      dtstartRaw: "DTSTART;TZID=Europe/Moscow:20261019T100000" });
  });

  it("isUnparsable и splitContentLine: двоеточие в кавычках параметра — не разделитель", () => {
    expect(isUnparsable(loadObject(seeds.c63BadFreq.ics, ENV))).toBe(true);
    expect(isUnparsable(loadObject(seeds.weeklyMoscow.ics, ENV))).toBe(false);
    expect(splitContentLine('ORGANIZER;CN="Анна: главная":mailto:anna@example.com'))
      .toEqual({ name: "ORGANIZER", value: "mailto:anna@example.com" });
    expect(splitContentLine("dtstart;tzid=Europe/Moscow:20261019T100000"))
      .toEqual({ name: "DTSTART", value: "20261019T100000" });
    expect(splitContentLine("без двоеточия")).toBeUndefined();
  });

  it("мусор, объект без VEVENT и VEVENT без DTSTART — тоже заглушки, чтение не падает", () => {
    expect(unparsable("это не календарь").uid).toBeUndefined();
    expect(unparsable(calendar([], ["BEGIN:VTODO", "UID:todo", "END:VTODO"])).error).toMatch(/VEVENT/);
    expect(unparsable(calendar([], vevent(["SUMMARY:Без начала"]))).uid).toBe(UID);
  });
});

describe("роли переопределений (Р5) — строго по порядку правил", () => {
  it("RECURRENCE-ID на слоте — slot", () => {
    const o = load(calendar(MOSCOW, vevent(SERIES), moved("20261021T100000", "20261021T150000", "20261021T160000")));
    const [override] = overridesOf(o);

    expect(roleOf(o, override)).toMatchObject({ role: "slot", slot: at("2026-10-21T07:00:00Z") });
    expect(o.anomalies).toEqual([]);
  });

  it.each([
    ["под EXDATE", "20261021T100000", ["EXDATE;TZID=Europe/Moscow:20261021T100000"]],
    ["после конца конечной серии", "20261109T100000", []],
    ["раньше первого слота", "20261012T100000", []],
  ])("RECURRENCE-ID %s — hidden", (_label, rid, extra) => {
    const o = load(calendar(MOSCOW, vevent([...SERIES, ...extra]), moved(rid, "20261021T150000", "20261021T160000")));
    const [override] = overridesOf(o);

    expect(roleOf(o, override).role).toBe("hidden");
    expect(codes(o)).not.toContain("legacy-override");
  });

  it("C56: RECURRENCE-ID 10:00 после сдвига серии на 09:00 — stale-shift на слоте 09:00 той же даты", () => {
    const o = load(seeds.c56StaleShift.ics);
    const [override] = overridesOf(o);

    expect(roleOf(o, override)).toMatchObject({ role: "stale-shift", slot: at("2026-10-21T06:00:00Z") });
    expect(codes(o)).toEqual(["legacy-override"]);
    expect(o.anomalies[0].key).toBe(at("2026-10-21T07:00:00Z"));
  });

  it("правило 2 раньше правила 3: RECURRENCE-ID под «пустым» EXDATE — hidden, а не stale-shift", () => {
    const shifted = ["DTSTART;TZID=Europe/Moscow:20261019T090000", "DTEND;TZID=Europe/Moscow:20261019T100000",
      "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6", "EXDATE;TZID=Europe/Moscow:20261021T100000"];
    const o = load(calendar(MOSCOW, vevent(shifted), moved("20261021T100000", "20261021T113000", "20261021T123000")));

    expect(roleOf(o, overridesOf(o)[0]).role).toBe("hidden");
  });

  it("stale-shift не назначается, если дату заявляют два переопределения или у слота своё переопределение", () => {
    const shifted = ["DTSTART;TZID=Europe/Moscow:20261019T090000", "DTEND;TZID=Europe/Moscow:20261019T100000",
      "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6", "SUMMARY:Сдвинута"];
    const twoClaims = load(calendar(MOSCOW, vevent(shifted),
      moved("20261021T100000", "20261021T120000", "20261021T130000"),
      moved("20261021T110000", "20261021T140000", "20261021T150000")));
    const ownOverride = load(calendar(MOSCOW, vevent(shifted),
      moved("20261021T090000", "20261021T093000", "20261021T103000"),
      moved("20261021T100000", "20261021T120000", "20261021T130000")));

    expect(overridesOf(twoClaims).map((c) => roleOf(twoClaims, c).role)).toEqual(["detached", "detached"]);
    expect(overridesOf(ownOverride).map((c) => roleOf(ownOverride, c).role)).toEqual(["slot", "detached"]);
  });

  it("C55: второе переопределение с RID, равным новому времени первого, — echo на слоте первого", () => {
    const o = load(seeds.c55EchoOverride.ics);
    const [first, echo] = overridesOf(o);

    expect(roleOf(o, first)).toMatchObject({ role: "slot", slot: at("2026-10-21T07:00:00Z") });
    expect(roleOf(o, echo)).toMatchObject({ role: "echo", slot: at("2026-10-21T07:00:00Z"), via: first, root: first });
    expect(codes(o)).toEqual(["legacy-override"]);
    expect(o.anomalies[0].key).toBe(at("2026-10-21T12:00:00Z"));
    expect(o.anomalies[0].components).toEqual([echo, first]);
  });

  it("цепочка эха сводится к слоту первого переопределения", () => {
    const o = load(calendar(MOSCOW, vevent(SERIES),
      moved("20261021T100000", "20261021T150000", "20261021T160000"),
      moved("20261021T150000", "20261021T170000", "20261021T180000"),
      moved("20261021T170000", "20261021T180000", "20261021T190000")));
    const [first, echo1, echo2] = overridesOf(o);

    expect(roleOf(o, echo1)).toMatchObject({ role: "echo", slot: at("2026-10-21T07:00:00Z"), via: first, root: first });
    expect(roleOf(o, echo2)).toMatchObject({ role: "echo", slot: at("2026-10-21T07:00:00Z"), via: echo1, root: first });
  });

  it("эхо удалённой встречи скрыто вместе с ней", () => {
    const o = load(calendar(MOSCOW, vevent([...SERIES, "EXDATE;TZID=Europe/Moscow:20261021T100000"]),
      moved("20261021T100000", "20261021T150000", "20261021T160000"),
      moved("20261021T150000", "20261021T150000", "20261021T160000")));

    expect(overridesOf(o).map((c) => roleOf(o, c).role)).toEqual(["hidden", "hidden"]);
  });

  it("эхо встречи, перенесённой на другой день со слотом, — echo, а не stale-shift (прямое свидетельство эха)", () => {
    // Серия Пн и Ср 10:00. O1 перенёс среду 21.10 на понедельник 26.10 15:00,
    // затем прежний код правил её ещё раз и записал эхо с RID 26.10 15:00. В
    // дате 26.10 ровно один слот (10:00), но RID эха равен DTSTART O1 — это
    // правило 4, а не правило 3: иначе встреча понедельника пропала бы под
    // эхом, а перенесённая среда показалась бы дважды.
    const o = load(calendar(MOSCOW, vevent(SERIES),
      moved("20261021T100000", "20261026T150000", "20261026T160000"),
      vevent(["RECURRENCE-ID;TZID=Europe/Moscow:20261026T150000", "DTSTART;TZID=Europe/Moscow:20261026T160000",
        "DTEND;TZID=Europe/Moscow:20261026T170000", "SUMMARY:Последняя правка"])));
    const [first, echo] = overridesOf(o);

    expect(roleOf(o, first)).toMatchObject({ role: "slot", slot: at("2026-10-21T07:00:00Z") });
    expect(roleOf(o, echo)).toMatchObject({ role: "echo", slot: at("2026-10-21T07:00:00Z"), via: first, root: first });
    expect(meetingAt(o, at("2026-10-21T07:00:00Z"))).toEqual({ shown: echo, components: [first, echo] });
    expect(meetingAt(o, at("2026-10-26T07:00:00Z"))).toBeUndefined();
    expect(codes(o)).toEqual(["legacy-override"]);
  });

  it("эхо скрытого переопределения (RID после конца серии) с RID на дату без слотов — hidden", () => {
    // O1: RID 09.11 после конца серии (последняя — 04.11), перенесён на
    // вторник 27.10 — в этой дате слотов нет. Эхо с RID 27.10 15:00 скрыто
    // вместе с O1 (правило 4), правило 3 его не касается.
    const o = load(calendar(MOSCOW, vevent(SERIES),
      moved("20261109T100000", "20261027T150000", "20261027T160000"),
      moved("20261027T150000", "20261027T160000", "20261027T170000")));

    expect(overridesOf(o).map((c) => roleOf(o, c).role)).toEqual(["hidden", "hidden"]);
    expect(codes(o)).not.toContain("legacy-override");
  });

  it("след сдвига серии на дату, единственный слот которой закрыт EXDATE, — hidden (правило 3, без эха)", () => {
    const shifted = ["DTSTART;TZID=Europe/Moscow:20261019T090000", "DTEND;TZID=Europe/Moscow:20261019T100000",
      "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6", "EXDATE;TZID=Europe/Moscow:20261021T090000"];
    const o = load(calendar(MOSCOW, vevent(shifted), moved("20261021T100000", "20261021T113000", "20261021T123000")));

    expect(roleOf(o, overridesOf(o)[0]).role).toBe("hidden");
    expect(codes(o)).not.toContain("legacy-override");
  });

  it("stale-shift у серии в America/New_York при поясе календаря Europe/Moscow: дата — в поясе DTSTART", () => {
    // Пн и Ср 20:00 по Нью-Йорку — это вторник и четверг 03:00 по Москве.
    // Прежний код сдвинул серию с 21:00 на 20:00; RID 21.10 21:00 NY по
    // Москве — уже 22.10, где у серии слотов нет.
    const o = load(calendar([],
      vevent(["DTSTART;TZID=America/New_York:20261019T200000", "DURATION:PT1H", "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6"]),
      vevent(["RECURRENCE-ID;TZID=America/New_York:20261021T210000", "DTSTART;TZID=America/New_York:20261021T223000",
        "DURATION:PT1H"])));

    expect(roleOf(o, overridesOf(o)[0])).toMatchObject({ role: "stale-shift", slot: at("2026-10-22T00:00:00Z") });
  });

  it("настоящее оторванное переопределение — detached, без аномалии legacy-override", () => {
    // Вторник 20.10: у серии Пн и Ср в эту дату слотов нет.
    const o = load(calendar(MOSCOW, vevent(SERIES), moved("20261020T100000", "20261020T120000", "20261020T130000")));

    expect(roleOf(o, overridesOf(o)[0]).role).toBe("detached");
    expect(o.anomalies).toEqual([]);
  });

  it("RECURRENCE-ID в поясе Berlin, в UTC и в чужом TZID совпадает со слотом по моменту, и после перехода часов", () => {
    const berlinSeries = seeds.dailyBerlin.ics.replace("END:VCALENDAR", [
      ...vevent(["RECURRENCE-ID;TZID=Europe/Berlin:20261027T100000", "DTSTART;TZID=Europe/Berlin:20261027T120000",
        "DTEND;TZID=Europe/Berlin:20261027T130000"], seeds.dailyBerlin.uid),
      ...vevent(["RECURRENCE-ID:20261023T080000Z", "DTSTART:20261023T100000Z", "DTEND:20261023T110000Z"], seeds.dailyBerlin.uid),
      ...vevent(["RECURRENCE-ID;TZID=Europe/Moscow:20261028T120000", "DTSTART;TZID=Europe/Moscow:20261028T150000",
        "DTEND;TZID=Europe/Moscow:20261028T160000"], seeds.dailyBerlin.uid),
      "END:VCALENDAR"].join(CRLF));
    const o = load(berlinSeries);

    expect(overridesOf(o).map((c) => roleOf(o, c))).toMatchObject([
      { role: "slot", slot: at("2026-10-27T09:00:00Z") },
      { role: "slot", slot: at("2026-10-23T08:00:00Z") },
      { role: "slot", slot: at("2026-10-28T09:00:00Z") },
    ]);
  });

  it("дубли одного RECURRENCE-ID — duplicate-override; показывается больший SEQUENCE", () => {
    const o = load(calendar(MOSCOW, vevent(SERIES),
      moved("20261021T100000", "20261021T150000", "20261021T160000", "SEQUENCE:2"),
      moved("20261021T100000", "20261021T170000", "20261021T180000", "SEQUENCE:1")));
    const refs = o.overrides.get(at("2026-10-21T07:00:00Z"))!;

    expect(refs).toHaveLength(2);
    expect(overridesOf(o).map((c) => roleOf(o, c).role)).toEqual(["slot", "slot"]);
    expect(codes(o)).toEqual(["duplicate-override"]);
    expect(shownOverride(refs).component).toBe(overridesOf(o)[0]);
  });

  it("выбор среди дублей: больший SEQUENCE, затем поздний DTSTAMP, затем последний в файле", () => {
    const stamp = (value: string) => (lines: string[]) =>
      lines.map((line) => (line.startsWith("DTSTAMP:") ? `DTSTAMP:${value}` : line));
    const later = load(calendar(MOSCOW, vevent(SERIES),
      stamp("20261003T090000Z")(moved("20261021T100000", "20261021T150000", "20261021T160000")),
      stamp("20261002T090000Z")(moved("20261021T100000", "20261021T170000", "20261021T180000"))));
    const last = load(calendar(MOSCOW, vevent(SERIES),
      moved("20261021T100000", "20261021T150000", "20261021T160000"),
      moved("20261021T100000", "20261021T170000", "20261021T180000")));

    expect(shownOverride(later.overrides.get(at("2026-10-21T07:00:00Z"))!).component).toBe(overridesOf(later)[0]);
    expect(shownOverride(last.overrides.get(at("2026-10-21T07:00:00Z"))!).component).toBe(overridesOf(last)[1]);
  });

  it("meetingAt: одна встреча слота — у эха показывается последнее в цепочке, у дублей — по SEQUENCE", () => {
    const echo = load(calendar(MOSCOW, vevent(SERIES),
      moved("20261021T100000", "20261021T150000", "20261021T160000"),
      moved("20261021T150000", "20261021T170000", "20261021T180000"),
      moved("20261021T170000", "20261021T180000", "20261021T190000")));
    const [first, echo1, echo2] = overridesOf(echo);
    const stale = load(seeds.c56StaleShift.ics);
    const duplicates = load(calendar(MOSCOW, vevent(SERIES),
      moved("20261021T100000", "20261021T150000", "20261021T160000", "SEQUENCE:1"),
      moved("20261021T100000", "20261021T170000", "20261021T180000", "SEQUENCE:3")));

    expect(meetingAt(echo, at("2026-10-21T07:00:00Z"))).toEqual({ shown: echo2, components: [first, echo1, echo2] });
    expect(meetingAt(echo, at("2026-10-26T07:00:00Z"))).toBeUndefined();
    expect(meetingAt(stale, at("2026-10-21T06:00:00Z"))?.shown).toBe(overridesOf(stale)[0]);
    expect(meetingAt(duplicates, at("2026-10-21T07:00:00Z"))?.shown).toBe(overridesOf(duplicates)[1]);
  });

  it("повторный осенний час: RECURRENCE-ID в UTC по RFC 5545 (первое вхождение) не теряется и не двоится", () => {
    // ical.js читает стенное 02:30 25.10 в Берлине как второе вхождение (CET,
    // 01:30Z), RFC 5545 §3.3.5 — как первое (CEST, 00:30Z); контракт — в
    // tests/ical/icaljs-contract.test.ts. RECURRENCE-ID другого клиента в UTC
    // (00:30Z) мимо ключа слота, но в его стенной дате ровно один слот:
    // встреча показывается один раз на своём слоте, с аномалией legacy-override.
    const text = calendar([], vevent(["DTSTART;TZID=Europe/Berlin:20261023T023000", "DURATION:PT30M",
      "RRULE:FREQ=DAILY;COUNT=5", "SUMMARY:Ночная"]),
    vevent(["RECURRENCE-ID:20261025T003000Z", "DTSTART:20261025T013000Z", "DURATION:PT30M", "SUMMARY:Перенос"]),
    vevent(["RECURRENCE-ID;TZID=Europe/Berlin:20261026T023000", "DTSTART;TZID=Europe/Berlin:20261026T040000",
      "DURATION:PT30M"]));
    const o = load(text);
    const [fold, regular] = overridesOf(o);

    expect(roleOf(o, fold)).toMatchObject({ role: "stale-shift", slot: at("2026-10-25T01:30:00Z") });
    expect(roleOf(o, regular)).toMatchObject({ role: "slot", slot: at("2026-10-26T01:30:00Z") });
  });

  it("у серии на весь день унаследованный RECURRENCE-ID в DATE-TIME попадает в слот своей даты", () => {
    const text = seeds.allDayWeekly.ics.replace("END:VCALENDAR", [
      ...vevent(["RECURRENCE-ID:20261021T000000Z", "DTSTART;VALUE=DATE:20261022", "DTEND;VALUE=DATE:20261023"],
        seeds.allDayWeekly.uid), "END:VCALENDAR"].join(CRLF));
    const o = load(text);

    expect(roleOf(o, overridesOf(o)[0])).toMatchObject({ role: "slot", slot: "D:2026-10-21" });
  });
});

describe("blockingAnomalies (О14)", () => {
  it("delete all_series не блокируется ничем", () => {
    const o = load(calendar(MOSCOW, vevent(SERIES), vevent(SERIES)));

    expect(codes(o)).toContain("multiple-masters");
    expect(blockingAnomalies(o, "delete", "all_series")).toEqual([]);
    expect(blockingAnomalies(o, "delete", "this", { key: at("2026-10-21T07:00:00Z") }).map((a) => a.code))
      .toEqual(["multiple-masters"]);
  });

  it("bad-rrule и no-positions блокируют всё, кроме delete all_series", () => {
    const o = load(calendar(MOSCOW, vevent(["DTSTART;TZID=Europe/Moscow:20261019T100000", "DURATION:PT1H",
      "RRULE:FREQ=WEEKLY;BYMONTHDAY=1"])));

    expect(blockingAnomalies(o, "update", "this", { key: at("2026-10-19T07:00:00Z") }).map((a) => a.code))
      .toEqual(["bad-rrule"]);
    expect(blockingAnomalies(o, "delete", "all_series")).toEqual([]);
  });

  it("legacy-override: t&f и all_series — отказ; update this встречи — только без confirm; delete this — можно", () => {
    const o = load(seeds.c55EchoOverride.ics);
    const slot = at("2026-10-21T07:00:00Z");

    expect(blockingAnomalies(o, "update", "all_series").map((a) => a.code)).toEqual(["legacy-override"]);
    expect(blockingAnomalies(o, "delete", "this_and_following", { key: slot, split: true }).map((a) => a.code))
      .toEqual(["legacy-override"]);
    expect(blockingAnomalies(o, "update", "this", { key: slot }).map((a) => a.code)).toEqual(["legacy-override"]);
    expect(blockingAnomalies(o, "update", "this", { key: slot, confirm: true })).toEqual([]);
    expect(blockingAnomalies(o, "update", "this", { key: at("2026-10-26T07:00:00Z") })).toEqual([]);
    expect(blockingAnomalies(o, "delete", "this", { key: slot })).toEqual([]);
  });

  it("duplicate-override блокирует только цель в своём слоте и не блокирует delete this", () => {
    const o = load(calendar(MOSCOW, vevent(SERIES),
      moved("20261021T100000", "20261021T150000", "20261021T160000"),
      moved("20261021T100000", "20261021T170000", "20261021T180000")));
    const slot = at("2026-10-21T07:00:00Z");

    expect(blockingAnomalies(o, "update", "this", { key: slot }).map((a) => a.code)).toEqual(["duplicate-override"]);
    expect(blockingAnomalies(o, "update", "this", { key: at("2026-10-26T07:00:00Z") })).toEqual([]);
    expect(blockingAnomalies(o, "delete", "this", { key: slot })).toEqual([]);
  });

  it("разрез: EXRULE, несколько RRULE, DTSTART вне правила при COUNT, граница из RDATE", () => {
    const unsynced = load(calendar(MOSCOW, vevent(["DTSTART;TZID=Europe/Moscow:20261020T100000", "DURATION:PT1H",
      "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=4"])));
    const rdate = load(calendar(MOSCOW, vevent([...SERIES, "RDATE;TZID=Europe/Moscow:20261023T100000"])));
    const B = at("2026-10-26T07:00:00Z");

    expect(blockingAnomalies(unsynced, "update", "this_and_following", { key: B, split: true }).map((a) => a.code))
      .toEqual(["unsynced-dtstart"]);
    expect(blockingAnomalies(unsynced, "update", "this_and_following", { key: B, split: false })).toEqual([]);
    expect(blockingAnomalies(unsynced, "update", "this", { key: B })).toEqual([]);
    expect(blockingAnomalies(rdate, "delete", "this_and_following", { key: at("2026-10-23T07:00:00Z"), split: true })
      .map((a) => a.code)).toEqual(["rdate-boundary"]);
    expect(blockingAnomalies(rdate, "delete", "this_and_following", { key: B, split: true })).toEqual([]);
  });

  it("DTSTART вне правила с UNTIL разрез не блокирует: COUNT не пересчитывается", () => {
    const unsynced = load(calendar(MOSCOW, vevent(["DTSTART;TZID=Europe/Moscow:20261020T100000", "DURATION:PT1H",
      "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20261105T000000Z"])));

    expect(codes(unsynced)).toEqual(["unsynced-dtstart"]);
    expect(blockingAnomalies(unsynced, "update", "this_and_following", { key: at("2026-10-26T07:00:00Z"), split: true }))
      .toEqual([]);
  });

  it("unknown-tzid блокирует запись, которая трогает значения в этом поясе", () => {
    const o = load(calendar(MOSCOW, vevent(SERIES), vevent(["RECURRENCE-ID;TZID=Europe/Moscow:20261021T100000",
      "DTSTART;TZID=Nowhere/Zone:20261021T150000", "DURATION:PT1H"])));

    expect(blockingAnomalies(o, "update", "this", { key: at("2026-10-21T07:00:00Z") }).map((a) => a.code))
      .toEqual(["unknown-tzid"]);
    expect(blockingAnomalies(o, "update", "this", { key: at("2026-10-26T07:00:00Z") })).toEqual([]);
    expect(blockingAnomalies(o, "update", "all_series").map((a) => a.code)).toEqual(["unknown-tzid"]);
  });
});

describe("ensureTimezones и serializeObject", () => {
  it("ensureTimezones только добавляет недостающие VTIMEZONE", () => {
    const o = load(seeds.weeklyMoscow.ics);
    const before = o.root.getFirstSubcomponent("vtimezone")!.toString();

    expect(ensureTimezones(o.root, ["Europe/Moscow", "Europe/Berlin", "Europe/Berlin"])).toEqual(["Europe/Berlin"]);
    const zones = o.root.getAllSubcomponents("vtimezone");
    expect(zones.map((zone) => zone.getFirstPropertyValue("tzid"))).toEqual(["Europe/Moscow", "Europe/Berlin"]);
    expect(zones[0].toString()).toBe(before);
    expect(ensureTimezones(o.root, ["Europe/Berlin"])).toEqual([]);
  });

  it("serializeObject даёт текст, который разбирается в тот же смысл, со строками через CRLF", () => {
    const o = load(seeds.richMoscow.ics);
    const text = serializeObject(o);

    expect(text.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(text.split("\r\n").every((line) => !line.includes("\n"))).toBe(true);
    expect(semanticDigest(text, ENV)).toBe(semanticDigest(seeds.richMoscow.ics, ENV));
  });
});

describe("semanticDigest (Р8): по смыслу, а не по тексту", () => {
  const normalize = (ics: string) => yandexNormalize(ics, {
    owner: "user@yandex.ru", calendarName: "Мои события", stamp: "20261002T100000Z", countToUntil: true });

  it.each([...seeds.cleanSeeds, ...seeds.legacySeeds].map((seed) => [seed.about, seed.ics]))(
    "не меняется от нормализации «как Яндекс»: %s",
    (_about, ics) => {
      expect(semanticDigest(normalize(ics), ENV)).toBe(semanticDigest(ics, ENV));
      expect(semanticDigest(reorderOverridesFirst(ics), ENV)).toBe(semanticDigest(ics, ENV));
    },
  );

  it("не зависит от служебных полей, X-свойств, CATEGORIES, ORGANIZER и сворачивания строк", () => {
    const base = seeds.richMoscow.ics;
    const noisy = base
      .replace("DTSTAMP:20261001T090000Z", "DTSTAMP:20270101T000000Z")
      .replace("SEQUENCE:2", "SEQUENCE:7")
      .replace("LAST-MODIFIED:20261001T090000Z", "LAST-MODIFIED:20270101T000000Z")
      .replace("CATEGORIES:Проект,Важное", "CATEGORIES:Мои события")
      .replace(/X-TELEMOST-CONFERENCE:[^\r]*\r\n/, "")
      .replace(/ORGANIZER;[^\r]*\r\n/, "")
      .replace("Повестка: смета\\, сроки и риски \r\n проекта.", "Повестка: смета\\, сроки и риски проекта.");

    expect(semanticDigest(noisy, ENV)).toBe(semanticDigest(base, ENV));
  });

  it("правило сравнивается по слотам: COUNT и равный UNTIL, порядок частей, INTERVAL=1, BYDAY из DTSTART", () => {
    const rule = (text: string) => seeds.weeklyMoscow.ics.replace("RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6", `RRULE:${text}`);
    const base = semanticDigest(rule("FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6"), ENV);

    expect(semanticDigest(rule("FREQ=WEEKLY;UNTIL=20261104T070000Z;INTERVAL=1;BYDAY=MO,WE"), ENV)).toBe(base);
    expect(semanticDigest(rule("COUNT=6;BYDAY=WE,MO;FREQ=WEEKLY"), ENV)).toBe(base);
    expect(semanticDigest(rule("FREQ=WEEKLY;BYDAY=MO,WE;COUNT=5"), ENV)).not.toBe(base);
    expect(semanticDigest(rule("FREQ=WEEKLY;BYDAY=MO,WE"), ENV)).not.toBe(base);
  });

  it("различает смену пояса при тех же моментах ({timeZone})", () => {
    // Минск, как и Москва, круглый год +03: все моменты те же, другой только TZID.
    const minsk = seeds.weeklyMoscow.ics.replaceAll("Europe/Moscow", "Europe/Minsk");

    expect(semanticDigest(minsk, ENV)).not.toBe(semanticDigest(seeds.weeklyMoscow.ics, ENV));
  });

  it("различает правку полей, участников, напоминаний, EXDATE и переопределений", () => {
    const base = seeds.richMoscow.ics;
    const digest = semanticDigest(base, ENV);
    const variants = [
      base.replace("SUMMARY:Созвон по проекту", "SUMMARY:Созвон"),
      base.replace("DTEND;TZID=Europe/Moscow:20261021T130000", "DTEND;TZID=Europe/Moscow:20261021T133000"),
      base.replace("PARTSTAT=ACCEPTED;ROLE=REQ", "PARTSTAT=DECLINED;ROLE=REQ"),
      base.replace("TRIGGER:-PT15M", "TRIGGER:-PT30M"),
      base.replace("EXDATE;TZID=Europe/Moscow:20261028T120000", "EXDATE;TZID=Europe/Moscow:20261104T120000"),
      base.replace("END:VCALENDAR", [...vevent(["RECURRENCE-ID;TZID=Europe/Moscow:20261104T120000",
        "DTSTART;TZID=Europe/Moscow:20261104T150000", "DTEND;TZID=Europe/Moscow:20261104T160000"],
      seeds.richMoscow.uid), "END:VCALENDAR"].join(CRLF)),
    ];

    for (const variant of variants) expect(semanticDigest(variant, ENV)).not.toBe(digest);
  });

  describe("EXDATE и RDATE бесконечной серии — и за окном первых 500 слотов", () => {
    const since2024 = (...extra: string[]) => calendar(MOSCOW, vevent(["DTSTART;TZID=Europe/Moscow:20240101T100000",
      "DTEND;TZID=Europe/Moscow:20240101T110000", "RRULE:FREQ=DAILY", "SUMMARY:Ежедневная", ...extra]));
    const hourly = (...extra: string[]) => calendar(MOSCOW, vevent(["DTSTART;TZID=Europe/Moscow:20261001T100000",
      "DURATION:PT30M", "RRULE:FREQ=HOURLY", "SUMMARY:Ежечасная", ...extra]));
    const variants: Array<[string, string, string]> = [
      ["delete this 21.10.2026 у DAILY с 2024 года", since2024(), since2024("EXDATE;TZID=Europe/Moscow:20261021T100000")],
      ["RDATE 21.10.2026 у DAILY с 2024 года", since2024(), since2024("RDATE;TZID=Europe/Moscow:20261021T150000")],
      ["EXDATE у HOURLY через три недели", hourly(), hourly("EXDATE;TZID=Europe/Moscow:20261022T100000")],
    ];

    it.each(variants)("%s — дайджест меняется", (_label, before, after) => {
      expect(semanticDigest(after, ENV)).not.toBe(semanticDigest(before, ENV));
    });

    it.each(variants)("%s — нормализация «как Яндекс» дайджест не меняет", (_label, _before, after) => {
      expect(semanticDigest(normalize(after), ENV)).toBe(semanticDigest(after, ENV));
      expect(semanticDigest(reorderOverridesFirst(after), ENV)).toBe(semanticDigest(after, ENV));
    });

    it("EXDATE в UTC равен EXDATE в поясе серии; EXDATE мимо слотов смысла не несёт", () => {
      const inZone = semanticDigest(since2024("EXDATE;TZID=Europe/Moscow:20261021T100000"), ENV);

      expect(semanticDigest(since2024("EXDATE:20261021T070000Z"), ENV)).toBe(inZone);
      expect(semanticDigest(since2024("EXDATE;TZID=Europe/Moscow:20261021T113000"), ENV)).toBe(semanticDigest(since2024(), ENV));
    });
  });

  it("RECURRENCE-ID в UTC и в TZID серии — один дайджест", () => {
    const zoned = calendar(MOSCOW, vevent(SERIES), moved("20261021T100000", "20261021T150000", "20261021T160000"));
    const utc = zoned.replace("RECURRENCE-ID;TZID=Europe/Moscow:20261021T100000", "RECURRENCE-ID:20261021T070000Z");

    expect(utc).not.toBe(zoned);
    expect(semanticDigest(utc, ENV)).toBe(semanticDigest(zoned, ENV));
  });

  it("различает перенос переопределения", () => {
    const moved15 = calendar(MOSCOW, vevent(SERIES), moved("20261021T100000", "20261021T150000", "20261021T160000"));
    const moved16 = calendar(MOSCOW, vevent(SERIES), moved("20261021T100000", "20261021T160000", "20261021T170000"));

    expect(semanticDigest(moved16, ENV)).not.toBe(semanticDigest(moved15, ENV));
  });

  it("VTIMEZONE, заменённый историческим описанием, дайджест не меняет (Ж10)", () => {
    const body = [vevent(["DTSTART;TZID=Europe/Moscow:19900604T100000", "DURATION:PT1H",
      "RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=30", "EXDATE;TZID=Europe/Moscow:19900611T100000"])];

    expect(semanticDigest(calendar(MOSCOW_1990, ...body), ENV)).toBe(semanticDigest(calendar(MOSCOW, ...body), ENV));
  });

  it("неразбираемый объект тоже получает дайджест, без служебных строк", () => {
    const [first, second] = seeds.unparsableSeeds;

    expect(semanticDigest(first.ics, ENV)).not.toBe(semanticDigest(second.ics, ENV));
    expect(semanticDigest(first.ics.replace("DTSTAMP:20261001T090000Z", "DTSTAMP:20270101T000000Z"), ENV))
      .toBe(semanticDigest(first.ics, ENV));
  });
});
