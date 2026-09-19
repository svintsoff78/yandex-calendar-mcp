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
import { SERIES_CAP, SlotScanError, iterateSlots, type SlotBound } from "../../src/ical/slots.js";
import { formatForModel, type IcalEnv, type SlotKey } from "../../src/ical/values.js";
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

/** Серия Пн и Ср 09:00–10:00 МСК с 19.10.2026, COUNT=6. */
const SERIES09 = ["DTSTART;TZID=Europe/Moscow:20261019T090000", "DTEND;TZID=Europe/Moscow:20261019T100000",
  "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6", "SUMMARY:Планёрка"];

/** Переопределение серии Europe/Moscow на час с заголовком `summary`: RID и начало — стенное время МСК. */
function named(summary: string, rid: string, start: string): string[] {
  return vevent([`RECURRENCE-ID;TZID=Europe/Moscow:${rid}`, `DTSTART;TZID=Europe/Moscow:${start}`, "DURATION:PT1H",
    `SUMMARY:${summary}`]);
}

/**
 * Выдача серии на уровне модели, по возрастанию фактического начала:
 * «адрес → начало заголовок». Незакрытый слот — встреча слота (meetingAt)
 * или основной компонент; detached — отдельная встреча по своему
 * RECURRENCE-ID (у дублей — shownOverride); hidden не показывается.
 * `bound` ограничивает перебор слотов: у бесконечной серии без него перебор
 * бесконечен. Если перебор обрывается сбоем итератора (SlotScanError),
 * показываются пройденные слоты, а detached — в любом случае.
 */
function visible(o: CalendarObject, bound: SlotBound = {}): string[] {
  const rows: Array<[number, string]> = [];
  const show = (address: ICAL.Time, component: ICAL.Component, start: ICAL.Time) => rows.push([start.toUnixTime(),
    `${formatForModel(address, ENV, "instance")} → ${formatForModel(start, ENV, "time")} ${String(component.getFirstPropertyValue("summary"))}`]);
  try {
    for (const slot of iterateSlots(o, bound)) {
      if (slot.excluded) continue;
      const meeting = meetingAt(o, slot.key);
      if (meeting) show(slot.time, meeting.shown, meeting.shown.getFirstPropertyValue("dtstart") as ICAL.Time);
      else show(slot.time, o.master!, slot.time);
    }
  } catch (error) {
    if (!(error instanceof SlotScanError)) throw error;
  }
  for (const refs of o.overrides.values()) {
    const detached = refs.filter((ref) => o.roles.get(ref.component)?.role === "detached");
    if (detached.length === 0) continue;
    const shown = shownOverride(detached);
    show(shown.recurrenceId, shown.component, shown.component.getFirstPropertyValue("dtstart") as ICAL.Time);
  }
  return rows.sort(([a], [b]) => a - b).map(([, row]) => row);
}

describe("loadObject: основной компонент по отсутствию RECURRENCE-ID (О1)", () => {
  it("переопределение первым в файле не становится основным", () => {
    const o = load(calendar(MOSCOW, named("Перенос", "20261021T090000", "20261021T113000"), vevent(SERIES09)));

    expect(o.kind).toBe("series");
    expect(o.uid).toBe(UID);
    expect(o.master?.hasProperty("recurrence-id")).toBe(false);
    expect(o.master?.getFirstPropertyValue("dtstart")?.toString()).toBe("2026-10-19T09:00:00");
    expect(o.form).toBe("zoned");
    expect(o.tzid).toBe("Europe/Moscow");
    expect(roleOf(o, overridesOf(o)[0])).toMatchObject({ role: "slot", slot: at("2026-10-21T06:00:00Z") });
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

describe("роли переопределений (Р5) — ровно три, строго по порядку: slot, hidden, detached", () => {
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

    expect(roleOf(o, override)).toEqual({ role: "hidden", ref: expect.anything() });
    expect(o.anomalies).toEqual([]);
  });

  it("правило 2 раньше правила 3: RECURRENCE-ID под «пустым» EXDATE мимо слотов — hidden, а не detached", () => {
    const o = load(calendar(MOSCOW, vevent([...SERIES09, "EXDATE;TZID=Europe/Moscow:20261021T100000"]),
      moved("20261021T100000", "20261021T113000", "20261021T123000")));

    expect(roleOf(o, overridesOf(o)[0]).role).toBe("hidden");
  });

  it("RECURRENCE-ID мимо слотов внутри серии — detached, без аномалий; адрес — его RECURRENCE-ID", () => {
    // Вторник 20.10: у серии Пн и Ср в эту дату слотов нет.
    const o = load(calendar(MOSCOW, vevent(SERIES), moved("20261020T100000", "20261020T120000", "20261020T130000")));
    const info = roleOf(o, overridesOf(o)[0]);

    expect(info).toEqual({ role: "detached", ref: expect.anything() });
    expect(info.ref.key).toBe(at("2026-10-20T07:00:00Z"));
    expect(o.anomalies).toEqual([]);
  });

  it("затравки стенда с detached-переопределением читаются как описаны: без аномалий, встречи не пропадают", () => {
    const movedStart = load(seeds.detachedAtMovedStart.ics);
    const slotDate = load(seeds.detachedOnSlotDate.ics);

    expect(overridesOf(movedStart).map((c) => roleOf(movedStart, c).role)).toEqual(["slot", "detached"]);
    expect(movedStart.anomalies).toEqual([]);
    expect(visible(movedStart).filter((row) => row.startsWith("2026-10-21"))).toEqual([
      "2026-10-21T10:00:00+03:00 → 2026-10-21T15:00:00+03:00 Планёрка",
      "2026-10-21T15:00:00+03:00 → 2026-10-21T15:00:00+03:00 Планёрка (перенесена)",
    ]);
    expect(overridesOf(slotDate).map((c) => roleOf(slotDate, c).role)).toEqual(["detached"]);
    expect(slotDate.anomalies).toEqual([]);
    expect(visible(slotDate).filter((row) => row.startsWith("2026-10-21"))).toEqual([
      "2026-10-21T09:00:00+03:00 → 2026-10-21T09:00:00+03:00 Планёрка",
      "2026-10-21T10:00:00+03:00 → 2026-10-21T11:30:00+03:00 Планёрка",
    ]);
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

  it("meetingAt: встреча слота — его переопределения (у дублей показывается по SEQUENCE); hidden и detached — не встречи слота", () => {
    const duplicates = load(calendar(MOSCOW, vevent(SERIES),
      moved("20261021T100000", "20261021T150000", "20261021T160000", "SEQUENCE:1"),
      moved("20261021T100000", "20261021T170000", "20261021T180000", "SEQUENCE:3")));
    const [low, high] = overridesOf(duplicates);
    const other = load(calendar(MOSCOW, vevent([...SERIES, "EXDATE;TZID=Europe/Moscow:20261026T100000"]),
      moved("20261026T100000", "20261026T150000", "20261026T160000"),
      moved("20261020T100000", "20261020T120000", "20261020T130000")));

    expect(meetingAt(duplicates, at("2026-10-21T07:00:00Z"))).toEqual({ shown: high, components: [low, high] });
    expect(meetingAt(duplicates, at("2026-10-26T07:00:00Z"))).toBeUndefined();
    expect(overridesOf(other).map((c) => roleOf(other, c).role)).toEqual(["hidden", "detached"]);
    expect(meetingAt(other, at("2026-10-26T07:00:00Z"))).toBeUndefined();
    expect(meetingAt(other, at("2026-10-20T07:00:00Z"))).toBeUndefined();
  });

  describe("повторный осенний час — известный дефект ключей слотов", () => {
    // Серия в Берлине, ежедневно в 02:30 с 23.10.2026, COUNT=5. 25.10 стенное
    // 02:30 бывает дважды: в 00:30Z (CEST) и в 01:30Z (CET). RFC 5545 §3.3.5
    // велит читать его как первое вхождение, ical.js читает как второе
    // (контракт — в tests/ical/icaljs-contract.test.ts), и ключ слота 25.10 —
    // 01:30Z. Другой клиент записал RECURRENCE-ID этой встречи в UTC по RFC —
    // 00:30Z. Ключи не совпадают, переопределение получает роль detached, и
    // встреча 25.10 видна дважды: слотом серии и отдельной встречей. Данные
    // не теряются. Чинить — в ключах (values.ts, З03): RECURRENCE-ID и EXDATE
    // в повторный час сверять по правилу RFC, а не эвристикой ролей. Дефект
    // решено пока не чинить: у Europe/Moscow переводов часов нет с 2014 года,
    // и в календаре пользователя он не проявляется.
    // Первый тест держит нынешнее поведение, чтобы его изменение не прошло
    // незамеченным, второй (it.fails) — желаемый итог. Когда ключи починят,
    // первый тест удаляется, а со второго снимается .fails.
    const fallBack = calendar([], vevent(["DTSTART;TZID=Europe/Berlin:20261023T023000", "DURATION:PT30M",
      "RRULE:FREQ=DAILY;COUNT=5", "SUMMARY:Ночная"]),
    vevent(["RECURRENCE-ID:20261025T003000Z", "DTSTART:20261025T013000Z", "DURATION:PT30M", "SUMMARY:Перенос"]),
    vevent(["RECURRENCE-ID;TZID=Europe/Berlin:20261026T023000", "DTSTART;TZID=Europe/Berlin:20261026T040000",
      "DURATION:PT30M"]));
    const on25 = (rows: string[]) => rows.filter((row) => row.startsWith("2026-10-25"));

    it("дефект: RECURRENCE-ID первого вхождения в UTC мимо ключа слота — detached, встреча 25.10 видна дважды", () => {
      const o = load(fallBack);
      const [fold, regular] = overridesOf(o);

      expect(roleOf(o, fold)).toEqual({ role: "detached", ref: expect.anything() });
      expect(roleOf(o, regular)).toMatchObject({ role: "slot", slot: at("2026-10-26T01:30:00Z") });
      expect(o.anomalies).toEqual([]);
      // Двойной показ — дефект, а не норма: слот серии «Ночная» и та же встреча «Перенос».
      expect(visible(o)).toHaveLength(6);
      expect(on25(visible(o))).toEqual([
        "2026-10-25T02:30:00+01:00 → 2026-10-25T02:30:00+01:00 Ночная",
        "2026-10-25T00:30:00+00:00 → 2026-10-25T01:30:00+00:00 Перенос",
      ]);
    });

    it.fails("желаемое: RECURRENCE-ID первого вхождения — slot, на слоте 25.10 одна встреча", () => {
      const o = load(fallBack);
      const [fold] = overridesOf(o);
      const slot25 = [...iterateSlots(o)][2]; // слоты 23, 24, 25, 26 и 27.10

      expect(roleOf(o, fold)).toMatchObject({ role: "slot", slot: slot25.key });
      expect(meetingAt(o, slot25.key)).toEqual({ shown: fold, components: [fold] });
      expect(visible(o)).toHaveLength(5);
      expect(on25(visible(o))).toEqual([expect.stringMatching(/ Перенос$/)]);
    });
  });

  it("у серии на весь день унаследованный RECURRENCE-ID в DATE-TIME попадает в слот своей даты", () => {
    const text = seeds.allDayWeekly.ics.replace("END:VCALENDAR", [
      ...vevent(["RECURRENCE-ID:20261021T000000Z", "DTSTART;VALUE=DATE:20261022", "DTEND;VALUE=DATE:20261023"],
        seeds.allDayWeekly.uid), "END:VCALENDAR"].join(CRLF));
    const o = load(text);

    expect(roleOf(o, overridesOf(o)[0])).toMatchObject({ role: "slot", slot: "D:2026-10-21" });
  });
});

describe("роли при оборванном проходе слотов: конец серии неизвестен — detached, а не hidden", () => {
  // assignRoles проходит слоты до последнего RECURRENCE-ID. Если проход
  // оборван сбоем итератора (SlotScanError) или пределом SERIES_CAP,
  // последний пройденный слот — не конец серии. RECURRENCE-ID дальше него
  // нельзя считать «после конца конечной серии» (hidden): так пропала бы
  // законная встреча. Он получает detached и показывается. Оба теста —
  // настоящие позиции правила, до которых проход не доходит.

  it("правило застревает посреди серии (SlotScanError): RECURRENCE-ID после места застревания — detached, встреча показывается", () => {
    // Позиции 29.02.2028 10:00:00 и 10:00:01 UTC, следующие — 29.02.2032:
    // итератор ical.js ищет их посекундно и упирается в предохранитель
    // STALL_STEPS (slots.ts, guardedIterator), перебор обрывается SlotScanError.
    const o = load(calendar([], vevent(["DTSTART:20280229T100000Z", "DURATION:PT1S",
      "RRULE:FREQ=SECONDLY;BYMONTH=2;BYMONTHDAY=29;BYHOUR=10;BYMINUTE=0;BYSECOND=0,1", "SUMMARY:Две секунды"]),
    vevent(["RECURRENCE-ID:20320229T100000Z", "DTSTART:20320229T120000Z", "DURATION:PT1S", "SUMMARY:Перенос"])));

    expect(o.anomalies).toEqual([]); // первые позиции есть — правило пригодно
    expect(() => [...iterateSlots(o)]).toThrow(SlotScanError);
    expect(roleOf(o, overridesOf(o)[0])).toEqual({ role: "detached", ref: expect.anything() });
    expect(roleOf(o, overridesOf(o)[0]).ref.key).toBe(at("2032-02-29T10:00:00Z"));
    expect(meetingAt(o, at("2032-02-29T10:00:00Z"))).toBeUndefined();
    // Сколько слотов перебор успевает выдать до сбоя, здесь не проверяется.
    expect(visible(o)).toContain("2032-02-29T10:00:00+00:00 → 2032-02-29T12:00:00+00:00 Перенос");
  }, 60_000);

  it("проход упирается в предел SERIES_CAP: RECURRENCE-ID дальше предела — detached, встреча показывается", () => {
    // HOURLY с 01.01.2000: до 21.10.2026 больше 200 000 слотов, и проход до
    // RECURRENCE-ID обрывается пределом. Проход до предела занимает около
    // секунды.
    const rid = at("2026-10-21T07:00:00Z");
    const o = load(calendar(MOSCOW, vevent(["DTSTART;TZID=Europe/Moscow:20000101T100000", "DURATION:PT30M",
      "RRULE:FREQ=HOURLY", "SUMMARY:Ежечасная с 2000 года"]),
    moved("20261021T100000", "20261021T150000", "20261021T160000")));

    expect((Date.parse("2026-10-21T07:00:00Z") - Date.parse("2000-01-01T07:00:00Z")) / 3_600_000).toBeGreaterThan(SERIES_CAP);
    expect(o.anomalies).toEqual([]);
    expect(roleOf(o, overridesOf(o)[0])).toEqual({ role: "detached", ref: expect.anything() });
    expect(roleOf(o, overridesOf(o)[0]).ref.key).toBe(rid);
    expect(meetingAt(o, rid)).toBeUndefined();
    expect(visible(o, { limit: 2 })).toEqual([
      "2000-01-01T10:00:00+03:00 → 2000-01-01T10:00:00+03:00 Ежечасная с 2000 года",
      "2000-01-01T11:00:00+03:00 → 2000-01-01T11:00:00+03:00 Ежечасная с 2000 года",
      "2026-10-21T10:00:00+03:00 → 2026-10-21T15:00:00+03:00 Перенос",
    ]);
  }, 60_000);
});

describe("законные переносы, которые эвристика следов прежнего кода путала: ни одна встреча не пропадает, фантомов нет", () => {
  // Серия Пн и Ср 09:00 МСК с 19.10.2026, COUNT=6: слоты 19.10, 21.10, 26.10,
  // 28.10, 02.11, 04.11. Выдача — «адрес → фактическое начало, заголовок».
  const plain = ["2026-10-19", "2026-10-21", "2026-10-26", "2026-10-28", "2026-11-02", "2026-11-04"]
    .map((day) => `${day}T09:00:00+03:00 → ${day}T09:00:00+03:00 Планёрка`);
  const row = (address: string, start: string, summary: string) => `2026-${address}:00+03:00 → 2026-${start}:00+03:00 ${summary}`;

  it("P1: A — понедельник 26.10 перенесён на среду 28.10 10:00, B — среда 28.10 на четверг 29.10 10:00: обе slot", () => {
    const o = load(calendar(MOSCOW, vevent(SERIES09),
      named("A", "20261026T090000", "20261028T100000"),
      named("B", "20261028T090000", "20261029T100000")));
    const [a, b] = overridesOf(o);

    expect(roleOf(o, a)).toMatchObject({ role: "slot", slot: at("2026-10-26T06:00:00Z") });
    expect(roleOf(o, b)).toMatchObject({ role: "slot", slot: at("2026-10-28T06:00:00Z") });
    expect(meetingAt(o, at("2026-10-26T06:00:00Z"))).toEqual({ shown: a, components: [a] });
    expect(meetingAt(o, at("2026-10-28T06:00:00Z"))).toEqual({ shown: b, components: [b] });
    expect(o.anomalies).toEqual([]);
    expect(visible(o)).toEqual([
      plain[0], plain[1],
      row("10-26T09:00", "10-28T10:00", "A"),
      row("10-28T09:00", "10-29T10:00", "B"),
      plain[4], plain[5],
    ]);
  });

  it.each([
    ["в то же время", "20261028T090000", "20261026T090000", ["10-26T09:00", "10-28T09:00"]],
    ["в другое время суток", "20261028T150000", "20261026T150000", ["10-26T15:00", "10-28T15:00"]],
  ])("цикл: A — понедельник 26.10 на среду, B — среда 28.10 на понедельник (%s): обе slot, встречи поменялись местами", (
    _label, startA, startB, [shownB, shownA],
  ) => {
    const o = load(calendar(MOSCOW, vevent(SERIES09),
      named("A", "20261026T090000", startA),
      named("B", "20261028T090000", startB)));
    const [a, b] = overridesOf(o);

    expect(overridesOf(o).map((c) => roleOf(o, c).role)).toEqual(["slot", "slot"]);
    expect(meetingAt(o, at("2026-10-26T06:00:00Z"))).toEqual({ shown: a, components: [a] });
    expect(meetingAt(o, at("2026-10-28T06:00:00Z"))).toEqual({ shown: b, components: [b] });
    expect(o.anomalies).toEqual([]);
    expect(visible(o)).toEqual([
      plain[0], plain[1],
      row("10-28T09:00", shownB, "B"),
      row("10-26T09:00", shownA, "A"),
      plain[4], plain[5],
    ]);
  });

  it("RECURRENCE-ID B равен новому началу A, и оба на слотах: обе slot", () => {
    // A: понедельник 26.10 перенесён ровно на время среды 28.10 09:00; B:
    // среда 28.10 перенесена на четверг. RID B = DTSTART A.
    const o = load(calendar(MOSCOW, vevent(SERIES09),
      named("A", "20261026T090000", "20261028T090000"),
      named("B", "20261028T090000", "20261029T100000")));
    const [a, b] = overridesOf(o);

    expect(overridesOf(o).map((c) => roleOf(o, c).role)).toEqual(["slot", "slot"]);
    expect(meetingAt(o, at("2026-10-26T06:00:00Z"))?.shown).toBe(a);
    expect(meetingAt(o, at("2026-10-28T06:00:00Z"))?.shown).toBe(b);
    expect(visible(o)).toEqual([
      plain[0], plain[1],
      row("10-26T09:00", "10-28T09:00", "A"),
      row("10-28T09:00", "10-29T10:00", "B"),
      plain[4], plain[5],
    ]);
  });

  it("RECURRENCE-ID одного равен новому началу другого, и оба мимо слотов: обе detached, показаны обе", () => {
    // Похоже на след сдвига серии с 10:00 на 09:00: A — RID 26.10 10:00 →
    // 28.10 10:00, B — RID 28.10 10:00 (= DTSTART A) → 29.10 10:00. Прежняя
    // эвристика прятала A и ставила на слот среды фантом основного компонента.
    const o = load(calendar(MOSCOW, vevent(SERIES09),
      named("A", "20261026T100000", "20261028T100000"),
      named("B", "20261028T100000", "20261029T100000")));

    expect(overridesOf(o).map((c) => roleOf(o, c).role)).toEqual(["detached", "detached"]);
    expect(meetingAt(o, at("2026-10-26T06:00:00Z"))).toBeUndefined();
    expect(meetingAt(o, at("2026-10-28T06:00:00Z"))).toBeUndefined();
    expect(o.anomalies).toEqual([]);
    expect(visible(o)).toEqual([
      plain[0], plain[1], plain[2], plain[3],
      row("10-26T10:00", "10-28T10:00", "A"),
      row("10-28T10:00", "10-29T10:00", "B"),
      plain[4], plain[5],
    ]);
  });

  it("цикл мимо слотов (A: Пн 10:00 → Ср 10:00, B: Ср 10:00 → Пн 10:00): обе detached, фантомов на слотах нет", () => {
    const o = load(calendar(MOSCOW, vevent(SERIES09),
      named("A", "20261026T100000", "20261028T100000"),
      named("B", "20261028T100000", "20261026T100000")));

    expect(overridesOf(o).map((c) => roleOf(o, c).role)).toEqual(["detached", "detached"]);
    expect(visible(o)).toEqual([
      plain[0], plain[1], plain[2],
      row("10-28T10:00", "10-26T10:00", "B"),
      plain[3],
      row("10-26T10:00", "10-28T10:00", "A"),
      plain[4], plain[5],
    ]);
  });

  it("RECURRENCE-ID detached равен новому началу переопределения слота: показаны обе, встреча понедельника на месте", () => {
    // O1: среда 21.10 перенесена на понедельник 26.10 15:00; O2 — RID 26.10
    // 15:00 (= DTSTART O1) → 16:00. Прежняя эвристика принимала O2 за эхо O1
    // (а до того — за сдвиг серии на слот понедельника, прятавший его встречу).
    const o = load(calendar(MOSCOW, vevent(SERIES09),
      named("O1", "20261021T090000", "20261026T150000"),
      named("O2", "20261026T150000", "20261026T160000")));
    const [o1, o2] = overridesOf(o);

    expect(roleOf(o, o1)).toMatchObject({ role: "slot", slot: at("2026-10-21T06:00:00Z") });
    expect(roleOf(o, o2).role).toBe("detached");
    expect(meetingAt(o, at("2026-10-21T06:00:00Z"))).toEqual({ shown: o1, components: [o1] });
    expect(meetingAt(o, at("2026-10-26T06:00:00Z"))).toBeUndefined();
    expect(visible(o)).toEqual([
      plain[0], plain[2],
      row("10-21T09:00", "10-26T15:00", "O1"),
      row("10-26T15:00", "10-26T16:00", "O2"),
      plain[3], plain[4], plain[5],
    ]);
  });

  it("два переопределения мимо слотов в одну дату и переопределение слота рядом со «сдвинутым» RID — всё показывается как есть", () => {
    const twoOnDate = load(calendar(MOSCOW, vevent(SERIES09),
      named("X", "20261021T100000", "20261021T120000"),
      named("Y", "20261021T110000", "20261021T140000")));
    const withOwn = load(calendar(MOSCOW, vevent(SERIES09),
      named("S", "20261021T090000", "20261021T093000"),
      named("D", "20261021T100000", "20261021T120000")));

    expect(overridesOf(twoOnDate).map((c) => roleOf(twoOnDate, c).role)).toEqual(["detached", "detached"]);
    expect(visible(twoOnDate)).toEqual([
      plain[0], plain[1],
      row("10-21T10:00", "10-21T12:00", "X"),
      row("10-21T11:00", "10-21T14:00", "Y"),
      plain[2], plain[3], plain[4], plain[5],
    ]);
    expect(overridesOf(withOwn).map((c) => roleOf(withOwn, c).role)).toEqual(["slot", "detached"]);
    expect(visible(withOwn)).toEqual([
      plain[0],
      row("10-21T09:00", "10-21T09:30", "S"),
      row("10-21T10:00", "10-21T12:00", "D"),
      plain[2], plain[3], plain[4], plain[5],
    ]);
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

  it("detached и hidden запись не блокируют: аномалии «след прежнего кода» больше нет", () => {
    const o = load(calendar(MOSCOW, vevent([...SERIES09, "EXDATE;TZID=Europe/Moscow:20261028T090000"]),
      named("D", "20261021T100000", "20261021T113000"),
      named("H", "20261028T090000", "20261028T120000")));
    const rid = at("2026-10-21T07:00:00Z");

    expect(overridesOf(o).map((c) => roleOf(o, c).role)).toEqual(["detached", "hidden"]);
    expect(o.anomalies).toEqual([]);
    expect(blockingAnomalies(o, "update", "all_series")).toEqual([]);
    expect(blockingAnomalies(o, "update", "this", { key: rid })).toEqual([]);
    expect(blockingAnomalies(o, "delete", "this", { key: rid })).toEqual([]);
    expect(blockingAnomalies(o, "delete", "this_and_following", { key: at("2026-10-26T06:00:00Z"), split: true })).toEqual([]);
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

  const withOverrides: Array<[string, string]> = [
    ["переносы P1: обе slot", calendar(MOSCOW, vevent(SERIES09),
      named("A", "20261026T090000", "20261028T100000"), named("B", "20261028T090000", "20261029T100000"))],
    ["цикл переносов понедельник ↔ среда", calendar(MOSCOW, vevent(SERIES09),
      named("A", "20261026T090000", "20261028T090000"), named("B", "20261028T090000", "20261026T090000"))],
    ["detached и hidden", calendar(MOSCOW, vevent([...SERIES09, "EXDATE;TZID=Europe/Moscow:20261028T090000"]),
      named("D", "20261021T100000", "20261021T113000"), named("H", "20261028T090000", "20261028T120000"))],
  ];

  it.each([...seeds.cleanSeeds.map((seed): [string, string] => [seed.about, seed.ics]), ...withOverrides])(
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

  describe("EXDATE дальше предела прохода и после сбоя перебора (ветка unscanned)", () => {
    // HOURLY с 01.01.2000: до 21.10.2026 больше 200 000 слотов (SERIES_CAP).
    // Проход до EXDATE обрывается пределом, и EXDATE входит в дайджест как
    // есть, приведённым к форме серии. Дайджест такого объекта считается
    // около секунды, поэтому одинаковые тексты считаются один раз.
    const since2000 = (...extra: string[]) => calendar(MOSCOW, vevent(["DTSTART;TZID=Europe/Moscow:20000101T100000",
      "DURATION:PT30M", "RRULE:FREQ=HOURLY", "SUMMARY:Ежечасная с 2000 года", ...extra]));
    const known = new Map<string, string>();
    const digest = (ics: string) => {
      const found = known.get(ics) ?? semanticDigest(ics, ENV);
      known.set(ics, found);
      return found;
    };
    const exdate = since2000("EXDATE;TZID=Europe/Moscow:20261021T100000");

    it("EXDATE 21.10.2026 у HOURLY с 2000 года меняет дайджест; другой EXDATE — другой дайджест", () => {
      expect(digest(exdate)).not.toBe(digest(since2000()));
      expect(digest(since2000("EXDATE;TZID=Europe/Moscow:20261022T100000"))).not.toBe(digest(exdate));
    }, 60_000);

    it("EXDATE в UTC и в TZID серии — один дайджест", () => {
      expect(digest(since2000("EXDATE:20261021T070000Z"))).toBe(digest(exdate));
    }, 60_000);

    it("нормализация «как Яндекс» дайджест не меняет", () => {
      expect(digest(normalize(exdate))).toBe(digest(exdate));
    }, 60_000);

    it("правило застревает посреди серии: EXDATE после места застревания меняет дайджест, форма EXDATE — нет", () => {
      // Позиции 29.02.2028 10:00:00 и 10:00:01 UTC, следующая — через четыре
      // года: итератор ical.js ищет её посекундно и упирается в
      // предохранитель, перебор обрывается SlotScanError посреди прохода.
      const stalled = (...extra: string[]) => calendar([], vevent(["DTSTART:20280229T100000Z", "DURATION:PT1S",
        "RRULE:FREQ=SECONDLY;BYMONTH=2;BYMONTHDAY=29;BYHOUR=10;BYMINUTE=0;BYSECOND=0,1", "SUMMARY:Две секунды", ...extra]));
      const utc = digest(stalled("EXDATE:20320229T100000Z"));

      expect(load(stalled()).anomalies).toEqual([]); // первые две позиции есть — правило пригодно
      expect(utc).not.toBe(digest(stalled()));
      expect(digest(stalled("EXDATE;TZID=Europe/Moscow:20320229T130000"))).toBe(utc);
      expect(digest(stalled("EXDATE:20360229T100000Z"))).not.toBe(utc);
    }, 60_000);
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
