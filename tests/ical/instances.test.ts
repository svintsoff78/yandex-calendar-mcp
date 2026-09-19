import ICAL from "ical.js";
import { describe, expect, it, vi } from "vitest";
import {
  AddressError,
  hiddenOverrides,
  instanceAt,
  instancesBetween,
  parseAddress,
  resolveTarget,
  toCalendarEvent,
  visibleMap,
  type Instance,
  type Resolved,
} from "../../src/ical/instances.js";
import { loadObject, type CalendarObject, type EditOp } from "../../src/ical/object.js";
import { formatForModel, type IcalEnv, type SlotKey } from "../../src/ical/values.js";
import * as seeds from "../support/seeds.js";

// Экземпляры и адресация (Р5–Р7, Р10 плана переделки,
// docs/superpowers/plans/2026-09-19-recurring-events-rework.md, задача З07;
// роли переопределений — по поправке «без ремонта следов прежнего кода»:
// slot, hidden, detached).
// Ожидания — строки ISO со смещением: тесты не зависят от пояса процесса
// (прогон под тремя поясами — npm run test:tz).
//
// formatForModel обёрнут счётчиком: адрес (instanceStart) каждая
// построенная встреча получает через него (makeInstance), так что число
// вызовов — число построенных встреч. По нему видно, что у давней серии
// встречи слотов до окна не строятся. Остальное в values.ts — как есть.
const formatted = vi.hoisted(() => ({ count: 0 }));

vi.mock("../../src/ical/values.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/ical/values.js")>();
  return {
    ...actual,
    formatForModel: (...args: Parameters<typeof actual.formatForModel>) => {
      formatted.count += 1;
      return actual.formatForModel(...args);
    },
  };
});

const ENV: IcalEnv = { floatingZone: "Europe/Moscow", ownerEmail: "user@yandex.ru" };
const CRLF = "\r\n";
const UID = "instances-test@yandex.ru";

const MOSCOW = [
  "BEGIN:VTIMEZONE", "TZID:Europe/Moscow", "BEGIN:STANDARD", "TZNAME:MSK", "TZOFFSETFROM:+0300",
  "TZOFFSETTO:+0300", "DTSTART:19700101T000000", "END:STANDARD", "END:VTIMEZONE",
];
const BERLIN = [
  "BEGIN:VTIMEZONE", "TZID:Europe/Berlin",
  "BEGIN:DAYLIGHT", "TZOFFSETFROM:+0100", "TZOFFSETTO:+0200", "TZNAME:CEST", "DTSTART:19700329T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU", "END:DAYLIGHT",
  "BEGIN:STANDARD", "TZOFFSETFROM:+0200", "TZOFFSETTO:+0100", "TZNAME:CET", "DTSTART:19701025T030000",
  "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU", "END:STANDARD", "END:VTIMEZONE",
];

/** Пн и Ср 10:00–11:00 МСК с 19.10.2026, COUNT=6: 19, 21, 26, 28 окт., 2, 4 нояб. */
const SERIES = ["DTSTART;TZID=Europe/Moscow:20261019T100000", "DTEND;TZID=Europe/Moscow:20261019T110000",
  "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6", "SUMMARY:Планёрка"];

function vevent(lines: string[], uid = UID): string[] {
  return ["BEGIN:VEVENT", `UID:${uid}`, "DTSTAMP:20261001T090000Z", ...lines, "END:VEVENT"];
}

function calendar(zones: string[], ...events: string[][]): string {
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//instances//RU", ...zones, ...events.flat(), "END:VCALENDAR"]
    .join(CRLF) + CRLF;
}

/** Переопределение серии Europe/Moscow: RID, начало и конец — стенное время МСК. */
function moved(rid: string, start: string, end: string, ...extra: string[]): string[] {
  const summary = extra.some((line) => line.startsWith("SUMMARY:")) ? [] : ["SUMMARY:Перенос"];
  return vevent([`RECURRENCE-ID;TZID=Europe/Moscow:${rid}`, `DTSTART;TZID=Europe/Moscow:${start}`,
    `DTEND;TZID=Europe/Moscow:${end}`, ...summary, ...extra]);
}

/** Серия SERIES с дополнительными строками основного компонента и переопределениями. */
function series(masterExtra: string[], ...overrides: string[][]): CalendarObject {
  return load(calendar(MOSCOW, vevent([...SERIES, ...masterExtra]), ...overrides));
}

function load(ics: string, env: IcalEnv = ENV): CalendarObject {
  const object = loadObject(ics, env);
  if (object.kind === "unparsable") throw new Error(`не разобран: ${object.error}`);
  return object;
}

const at = (iso: string): SlotKey => `T:${Date.parse(iso) / 1000}`;
const iso = (t: ICAL.Time, env: IcalEnv = ENV) => formatForModel(t, env, "time");
const summaryOf = (c: ICAL.Component) => String(c.getFirstPropertyValue("summary") ?? "");

/** Встреча строкой: «адрес → начало/конец заголовок [вид, флаги]». */
function row(i: Instance, env: IcalEnv = ENV): string {
  const flags = [i.kind, ...(i.moved ? ["moved"] : []), ...(i.cancelled ? ["cancelled"] : [])].join(", ");
  return `${i.instanceStart} → ${iso(i.start, env)}/${iso(i.end, env)} ${summaryOf(i.shown)} [${flags}]`;
}

function between(o: CalendarObject, from: string, to: string): string[] {
  return instancesBetween(o, Date.parse(from), Date.parse(to)).map((i) => row(i, o.env));
}

const ALL = ["2026-10-01T00:00:00+03:00", "2026-12-01T00:00:00+03:00"] as const;

function refusal(run: () => unknown): AddressError {
  try {
    run();
  } catch (error) {
    if (error instanceof AddressError) return error;
    throw error;
  }
  throw new Error("ожидался отказ AddressError");
}

function resolve(o: CalendarObject, instanceStart: string, op: EditOp, confirm?: boolean): Resolved {
  return resolveTarget(o, instanceStart, op, { confirm });
}

// ─────────────────────────────── выдача ───────────────────────────────

describe("instancesBetween: окно и сортировка по фактическому времени", () => {
  it("серия без переопределений — слоты по порядку, адрес = начало", () => {
    expect(between(load(seeds.weeklyMoscow.ics), ...ALL)).toEqual([
      "2026-10-19T10:00:00+03:00 → 2026-10-19T10:00:00+03:00/2026-10-19T11:00:00+03:00 Планёрка [slot]",
      "2026-10-21T10:00:00+03:00 → 2026-10-21T10:00:00+03:00/2026-10-21T11:00:00+03:00 Планёрка [slot]",
      "2026-10-26T10:00:00+03:00 → 2026-10-26T10:00:00+03:00/2026-10-26T11:00:00+03:00 Планёрка [slot]",
      "2026-10-28T10:00:00+03:00 → 2026-10-28T10:00:00+03:00/2026-10-28T11:00:00+03:00 Планёрка [slot]",
      "2026-11-02T10:00:00+03:00 → 2026-11-02T10:00:00+03:00/2026-11-02T11:00:00+03:00 Планёрка [slot]",
      "2026-11-04T10:00:00+03:00 → 2026-11-04T10:00:00+03:00/2026-11-04T11:00:00+03:00 Планёрка [slot]",
    ]);
  });

  // C29, R8-F4: перенос из окна наружу, раньше соседа и в окно.
  const c29 = () => series([],
    moved("20261021T100000", "20261023T100000", "20261023T110000"),
    moved("20261028T100000", "20261025T100000", "20261025T110000"));

  it("перенесённая встреча стоит по фактическому началу, а не по слоту; адрес — слот", () => {
    expect(between(c29(), ...ALL)).toEqual([
      "2026-10-19T10:00:00+03:00 → 2026-10-19T10:00:00+03:00/2026-10-19T11:00:00+03:00 Планёрка [slot]",
      "2026-10-21T10:00:00+03:00 → 2026-10-23T10:00:00+03:00/2026-10-23T11:00:00+03:00 Перенос [override, moved]",
      "2026-10-28T10:00:00+03:00 → 2026-10-25T10:00:00+03:00/2026-10-25T11:00:00+03:00 Перенос [override, moved]",
      "2026-10-26T10:00:00+03:00 → 2026-10-26T10:00:00+03:00/2026-10-26T11:00:00+03:00 Планёрка [slot]",
      "2026-11-02T10:00:00+03:00 → 2026-11-02T10:00:00+03:00/2026-11-02T11:00:00+03:00 Планёрка [slot]",
      "2026-11-04T10:00:00+03:00 → 2026-11-04T10:00:00+03:00/2026-11-04T11:00:00+03:00 Планёрка [slot]",
    ]);
  });

  it("окно исходного слота перенесённой пусто; окно, куда её перенесли, — только она", () => {
    const o = c29();
    expect(between(o, "2026-10-21T00:00:00+03:00", "2026-10-22T00:00:00+03:00")).toEqual([]);
    expect(between(o, "2026-10-23T00:00:00+03:00", "2026-10-24T00:00:00+03:00")).toEqual([
      "2026-10-21T10:00:00+03:00 → 2026-10-23T10:00:00+03:00/2026-10-23T11:00:00+03:00 Перенос [override, moved]",
    ]);
  });

  it("встреча, перенесённая в окно со слота далеко за его концом, в выдаче есть", () => {
    const o = series([], moved("20261104T100000", "20261020T120000", "20261020T130000"));
    expect(between(o, "2026-10-20T00:00:00+03:00", "2026-10-21T00:00:00+03:00")).toEqual([
      "2026-11-04T10:00:00+03:00 → 2026-10-20T12:00:00+03:00/2026-10-20T13:00:00+03:00 Перенос [override, moved]",
    ]);
  });

  it("встреча, перенесённая со слота до окна далеко вперёд, видна в окне нового времени", () => {
    const o = series([], moved("20261019T100000", "20261103T150000", "20261103T160000"));
    expect(between(o, "2026-11-03T00:00:00+03:00", "2026-11-04T00:00:00+03:00")).toEqual([
      "2026-10-19T10:00:00+03:00 → 2026-11-03T15:00:00+03:00/2026-11-03T16:00:00+03:00 Перенос [override, moved]",
    ]);
    expect(between(o, "2026-10-19T00:00:00+03:00", "2026-10-20T00:00:00+03:00")).toEqual([]);
  });

  it("границы окна: встреча, начатая раньше, попадает; конец в начале окна и начало в конце — нет", () => {
    const o = load(seeds.weeklyMoscow.ics);
    expect(between(o, "2026-10-21T10:30:00+03:00", "2026-10-21T10:45:00+03:00")).toHaveLength(1);
    expect(between(o, "2026-10-21T11:00:00+03:00", "2026-10-21T12:00:00+03:00")).toEqual([]);
    expect(between(o, "2026-10-21T09:00:00+03:00", "2026-10-21T10:00:00+03:00")).toEqual([]);
  });

  it("встреча без длительности видна в окне, которое начинается с её начала (RFC 4791 §9.9)", () => {
    const o = load(calendar(MOSCOW, vevent(["DTSTART;TZID=Europe/Moscow:20261020T120000", "SUMMARY:Звонок"])));
    expect(between(o, "2026-10-20T12:00:00+03:00", "2026-10-20T13:00:00+03:00")).toEqual([
      "2026-10-20T12:00:00+03:00 → 2026-10-20T12:00:00+03:00/2026-10-20T12:00:00+03:00 Звонок [slot]",
    ]);
    expect(between(o, "2026-10-20T11:00:00+03:00", "2026-10-20T12:00:00+03:00")).toEqual([]);
  });

  it("EXDATE, переопределение под EXDATE и после конца серии не видны; detached виден по своему RECURRENCE-ID", () => {
    const o = load(calendar(MOSCOW,
      vevent(["DTSTART;TZID=Europe/Moscow:20261019T100000", "DTEND;TZID=Europe/Moscow:20261019T110000",
        "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20261028T235959Z", "EXDATE;TZID=Europe/Moscow:20261021T100000",
        "SUMMARY:Планёрка"]),
      moved("20261021T100000", "20261021T100000", "20261021T110000", "SUMMARY:Скрытая"),
      moved("20261102T100000", "20261102T100000", "20261102T110000", "SUMMARY:После конца"),
      moved("20261022T100000", "20261022T140000", "20261022T150000", "SUMMARY:Отдельная")));
    expect(between(o, ...ALL)).toEqual([
      "2026-10-19T10:00:00+03:00 → 2026-10-19T10:00:00+03:00/2026-10-19T11:00:00+03:00 Планёрка [slot]",
      "2026-10-22T10:00:00+03:00 → 2026-10-22T14:00:00+03:00/2026-10-22T15:00:00+03:00 Отдельная [detached, moved]",
      "2026-10-26T10:00:00+03:00 → 2026-10-26T10:00:00+03:00/2026-10-26T11:00:00+03:00 Планёрка [slot]",
      "2026-10-28T10:00:00+03:00 → 2026-10-28T10:00:00+03:00/2026-10-28T11:00:00+03:00 Планёрка [slot]",
    ]);
  });

  it("дубли одного RECURRENCE-ID — одна встреча: показывается больший SEQUENCE, компоненты — оба", () => {
    const o = series([],
      moved("20261021T100000", "20261021T120000", "20261021T130000", "SUMMARY:Старая", "SEQUENCE:1"),
      moved("20261021T100000", "20261021T150000", "20261021T160000", "SUMMARY:Новая", "SEQUENCE:2"));
    const list = instancesBetween(o, Date.parse("2026-10-21T00:00:00+03:00"), Date.parse("2026-10-22T00:00:00+03:00"));
    expect(list.map((i) => row(i))).toEqual([
      "2026-10-21T10:00:00+03:00 → 2026-10-21T15:00:00+03:00/2026-10-21T16:00:00+03:00 Новая [override, moved]",
    ]);
    expect(list[0].components.map(summaryOf)).toEqual(["Старая", "Новая"]);
  });

  it("дубли detached — одна встреча по shownOverride (не первый и не последний в файле)", () => {
    const o = series([],
      moved("20261022T100000", "20261022T120000", "20261022T130000", "SUMMARY:Первая", "SEQUENCE:1"),
      moved("20261022T100000", "20261022T100000", "20261022T110000", "SUMMARY:Вторая", "SEQUENCE:3"),
      moved("20261022T100000", "20261022T140000", "20261022T150000", "SUMMARY:Третья", "SEQUENCE:2"));
    const list = instancesBetween(o, Date.parse("2026-10-22T00:00:00+03:00"), Date.parse("2026-10-23T00:00:00+03:00"));
    expect(list.map((i) => row(i))).toEqual([
      "2026-10-22T10:00:00+03:00 → 2026-10-22T10:00:00+03:00/2026-10-22T11:00:00+03:00 Вторая [detached]",
    ]);
    expect(list[0].components.map(summaryOf)).toEqual(["Первая", "Вторая", "Третья"]);
  });

  it("отменённое переопределение (Р7) выдаётся с флагом cancelled; отменённый основной — все его встречи", () => {
    const o = series([], moved("20261021T100000", "20261021T100000", "20261021T110000", "SUMMARY:Планёрка", "STATUS:CANCELLED"));
    expect(between(o, "2026-10-21T00:00:00+03:00", "2026-10-22T00:00:00+03:00")).toEqual([
      "2026-10-21T10:00:00+03:00 → 2026-10-21T10:00:00+03:00/2026-10-21T11:00:00+03:00 Планёрка [override, cancelled]",
    ]);
    const cancelledSeries = series(["STATUS:CANCELLED"]);
    expect(instancesBetween(cancelledSeries, Date.parse(ALL[0]), Date.parse(ALL[1])).map((i) => i.cancelled))
      .toEqual([true, true, true, true, true, true]);
  });

  it("RANGE=THISANDFUTURE (Р7, C32): сдвиг действует на свой слот и все следующие", () => {
    const o = series([], vevent(["RECURRENCE-ID;RANGE=THISANDFUTURE;TZID=Europe/Moscow:20261026T100000",
      "DTSTART;TZID=Europe/Moscow:20261026T120000", "DTEND;TZID=Europe/Moscow:20261026T123000", "SUMMARY:Позже"]));
    expect(between(o, ...ALL)).toEqual([
      "2026-10-19T10:00:00+03:00 → 2026-10-19T10:00:00+03:00/2026-10-19T11:00:00+03:00 Планёрка [slot]",
      "2026-10-21T10:00:00+03:00 → 2026-10-21T10:00:00+03:00/2026-10-21T11:00:00+03:00 Планёрка [slot]",
      "2026-10-26T10:00:00+03:00 → 2026-10-26T12:00:00+03:00/2026-10-26T12:30:00+03:00 Позже [override, moved]",
      "2026-10-28T10:00:00+03:00 → 2026-10-28T12:00:00+03:00/2026-10-28T12:30:00+03:00 Позже [range, moved]",
      "2026-11-02T10:00:00+03:00 → 2026-11-02T12:00:00+03:00/2026-11-02T12:30:00+03:00 Позже [range, moved]",
      "2026-11-04T10:00:00+03:00 → 2026-11-04T12:00:00+03:00/2026-11-04T12:30:00+03:00 Позже [range, moved]",
    ]);
    // Сдвиг назад на трое суток: встреча слота 04.11, далеко за концом окна, попадает в окно 01.11.
    const earlier = series([], vevent(["RECURRENCE-ID;RANGE=THISANDFUTURE;TZID=Europe/Moscow:20261026T100000",
      "DTSTART;TZID=Europe/Moscow:20261023T100000", "DTEND;TZID=Europe/Moscow:20261023T110000", "SUMMARY:Раньше"]));
    expect(between(earlier, "2026-11-01T00:00:00+03:00", "2026-11-02T00:00:00+03:00")).toEqual([
      "2026-11-04T10:00:00+03:00 → 2026-11-01T10:00:00+03:00/2026-11-01T11:00:00+03:00 Раньше [range, moved]",
    ]);
  });

  // Ежедневно с 1990 года: до окна в октябре 2026 года больше 13 000 слотов.
  const since1990 = () => load(calendar(MOSCOW, vevent(["DTSTART;TZID=Europe/Moscow:19900101T100000",
    "DTEND;TZID=Europe/Moscow:19900101T110000", "RRULE:FREQ=DAILY", "SUMMARY:Давняя"])));

  it("давняя серия: встречи слотов, кончившихся до окна, не строятся — ни в выдаче, ни в resolveTarget", () => {
    const o = since1990();
    formatted.count = 0;
    const list = instancesBetween(o, Date.parse("2026-10-19T00:00:00+03:00"), Date.parse("2026-10-26T00:00:00+03:00"));
    const builtForWindow = formatted.count;
    expect(list.map((i) => i.instanceStart)).toEqual([
      "2026-10-19T10:00:00+03:00", "2026-10-20T10:00:00+03:00", "2026-10-21T10:00:00+03:00", "2026-10-22T10:00:00+03:00",
      "2026-10-23T10:00:00+03:00", "2026-10-24T10:00:00+03:00", "2026-10-25T10:00:00+03:00",
    ]);
    // Строятся только слоты у окна (с запасом), а не все с 1990 года.
    expect(builtForWindow).toBeLessThan(20);

    formatted.count = 0;
    expect(resolve(o, "2026-10-21T10:00:00+03:00", "update").target.kind).toBe("slot");
    expect(formatted.count).toBeLessThan(20);
  });

  it("отсечение слотов до окна не теряет встреч, дотянувшихся до окна: RANGE вперёд, долгая DURATION, долгий PERIOD, перевод часов", () => {
    // RANGE со слота 19.10 на десять суток вперёд: встреча слота 21.10 — 31.10.
    const forward = series([], vevent(["RECURRENCE-ID;RANGE=THISANDFUTURE;TZID=Europe/Moscow:20261019T100000",
      "DTSTART;TZID=Europe/Moscow:20261029T100000", "DTEND;TZID=Europe/Moscow:20261029T110000", "SUMMARY:Вперёд"]));
    expect(between(forward, "2026-10-31T00:00:00+03:00", "2026-11-01T00:00:00+03:00")).toEqual([
      "2026-10-21T10:00:00+03:00 → 2026-10-31T10:00:00+03:00/2026-10-31T11:00:00+03:00 Вперёд [range, moved]",
    ]);
    // Каждая встреча — десять суток: в окне 28.10 и встреча слота 19.10.
    const long = load(calendar(MOSCOW, vevent(["DTSTART;TZID=Europe/Moscow:20261019T100000", "DURATION:P10D",
      "RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=3", "SUMMARY:Сессия"])));
    expect(between(long, "2026-10-28T12:00:00+03:00", "2026-10-28T13:00:00+03:00")).toEqual([
      "2026-10-19T10:00:00+03:00 → 2026-10-19T10:00:00+03:00/2026-10-29T10:00:00+03:00 Сессия [slot]",
      "2026-10-26T10:00:00+03:00 → 2026-10-26T10:00:00+03:00/2026-11-05T10:00:00+03:00 Сессия [slot]",
    ]);
    // RDATE;VALUE=PERIOD на двадцать суток с 07.10: в окне 25.10 — только она.
    const period = load(calendar(MOSCOW, vevent(["DTSTART;TZID=Europe/Moscow:20261005T100000",
      "DTEND;TZID=Europe/Moscow:20261005T110000", "RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=3",
      "RDATE;VALUE=PERIOD;TZID=Europe/Moscow:20261007T100000/P20D", "SUMMARY:Выставка"])));
    expect(between(period, "2026-10-25T00:00:00+03:00", "2026-10-26T00:00:00+03:00")).toEqual([
      "2026-10-07T10:00:00+03:00 → 2026-10-07T10:00:00+03:00/2026-10-27T10:00:00+03:00 Выставка [slot]",
    ]);
    // Сутки DURATION номинальные: встреча 24.10 10:00 CEST в Берлине кончается
    // 25.10 10:00 CET, через 25 часов, — в последний свой час она ещё видна.
    const day = load(calendar(BERLIN, vevent(["DTSTART;TZID=Europe/Berlin:20261024T100000", "DURATION:P1D",
      "RRULE:FREQ=WEEKLY;COUNT=2", "SUMMARY:Сутки"])));
    expect(between(day, "2026-10-25T09:30:00+01:00", "2026-10-25T09:45:00+01:00")).toEqual([
      "2026-10-24T10:00:00+02:00 → 2026-10-24T10:00:00+02:00/2026-10-25T10:00:00+01:00 Сутки [slot]",
    ]);
  });

  it("весь день: адрес — дата, начало и конец — полночь пояса календаря; RECURRENCE-ID в DATE-TIME — та же дата (C34)", () => {
    const o = load(seeds.allDayWeekly.ics.replace("END:VCALENDAR", [
      ...vevent(["RECURRENCE-ID:20261021T000000Z", "DTSTART;VALUE=DATE:20261021", "DTEND;VALUE=DATE:20261022",
        "SUMMARY:Особое дежурство"], seeds.allDayWeekly.uid),
      "END:VCALENDAR"].join(CRLF)));
    expect(between(o, "2026-10-19T00:00:00+03:00", "2026-10-27T00:00:00+03:00")).toEqual([
      "2026-10-19 → 2026-10-19T00:00:00+03:00/2026-10-20T00:00:00+03:00 Дежурство [slot]",
      "2026-10-21 → 2026-10-21T00:00:00+03:00/2026-10-22T00:00:00+03:00 Особое дежурство [override]",
      "2026-10-26 → 2026-10-26T00:00:00+03:00/2026-10-27T00:00:00+03:00 Дежурство [slot]",
    ]);
  });

  it("весь день: переопределение, ставшее встречей со временем с полуночи, — перенесённая", () => {
    const o = load(seeds.allDayWeekly.ics.replace("END:VCALENDAR", [
      ...vevent(["RECURRENCE-ID;VALUE=DATE:20261021", "DTSTART;TZID=Europe/Moscow:20261021T000000",
        "DTEND;TZID=Europe/Moscow:20261021T010000", "SUMMARY:Ночной обход"], seeds.allDayWeekly.uid),
      "END:VCALENDAR"].join(CRLF)));
    expect(between(o, "2026-10-21T00:00:00+03:00", "2026-10-22T00:00:00+03:00")).toEqual([
      "2026-10-21 → 2026-10-21T00:00:00+03:00/2026-10-21T01:00:00+03:00 Ночной обход [override, moved]",
    ]);
  });

  it("плавающее время читается в поясе календаря", () => {
    const yekaterinburg: IcalEnv = { floatingZone: "Asia/Yekaterinburg" };
    const moscow = load(seeds.floatingDaily.ics);
    const ural = load(seeds.floatingDaily.ics, yekaterinburg);
    expect(between(moscow, "2026-10-20T00:00:00+03:00", "2026-10-21T00:00:00+03:00")).toEqual([
      "2026-10-20T08:00:00+03:00 → 2026-10-20T08:00:00+03:00/2026-10-20T08:30:00+03:00 Зарядка [slot]",
    ]);
    expect(between(ural, "2026-10-20T00:00:00+05:00", "2026-10-21T00:00:00+05:00")).toEqual([
      "2026-10-20T08:00:00+05:00 → 2026-10-20T08:00:00+05:00/2026-10-20T08:30:00+05:00 Зарядка [slot]",
    ]);
  });

  it("объект из одних переопределений (Р6): каждое — detached по своему RECURRENCE-ID", () => {
    const o = load(calendar(MOSCOW,
      moved("20261021T100000", "20261021T100000", "20261021T110000", "SUMMARY:Приглашение"),
      moved("20261028T100000", "20261028T130000", "20261028T140000", "SUMMARY:Второе")));
    expect(between(o, ...ALL)).toEqual([
      "2026-10-21T10:00:00+03:00 → 2026-10-21T10:00:00+03:00/2026-10-21T11:00:00+03:00 Приглашение [detached]",
      "2026-10-28T10:00:00+03:00 → 2026-10-28T13:00:00+03:00/2026-10-28T14:00:00+03:00 Второе [detached, moved]",
    ]);
  });

  it("DURATION основного и RDATE с PERIOD: конец каждой встречи — по своей длительности", () => {
    const o = load(calendar(MOSCOW, vevent(["DTSTART;TZID=Europe/Moscow:20261019T100000", "DURATION:PT1H30M",
      "RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=2", "RDATE;VALUE=PERIOD;TZID=Europe/Moscow:20261022T150000/PT20M",
      "SUMMARY:Разбор"])));
    expect(between(o, ...ALL)).toEqual([
      "2026-10-19T10:00:00+03:00 → 2026-10-19T10:00:00+03:00/2026-10-19T11:30:00+03:00 Разбор [slot]",
      "2026-10-22T15:00:00+03:00 → 2026-10-22T15:00:00+03:00/2026-10-22T15:20:00+03:00 Разбор [slot]",
      "2026-10-26T10:00:00+03:00 → 2026-10-26T10:00:00+03:00/2026-10-26T11:30:00+03:00 Разбор [slot]",
    ]);
  });

  it("длительность по DTEND — точная: в ночь весеннего перевода встреча 01:30–02:30 длится час (RFC 5545 §3.8.5.3)", () => {
    const o = load(calendar(BERLIN, vevent(["DTSTART;TZID=Europe/Berlin:20260328T013000",
      "DTEND;TZID=Europe/Berlin:20260328T023000", "RRULE:FREQ=DAILY;COUNT=3", "SUMMARY:Ночная"])));
    const list = instancesBetween(o, Date.parse("2026-03-28T00:00:00+01:00"), Date.parse("2026-03-31T00:00:00+02:00"));
    expect(list.map((i) => row(i))).toEqual([
      "2026-03-28T01:30:00+01:00 → 2026-03-28T01:30:00+01:00/2026-03-28T02:30:00+01:00 Ночная [slot]",
      "2026-03-29T01:30:00+01:00 → 2026-03-29T01:30:00+01:00/2026-03-29T03:30:00+02:00 Ночная [slot]",
      "2026-03-30T01:30:00+02:00 → 2026-03-30T01:30:00+02:00/2026-03-30T02:30:00+02:00 Ночная [slot]",
    ]);
    expect(list.map((i) => i.endMs - i.startMs)).toEqual([3_600_000, 3_600_000, 3_600_000]);
  });

  it("DURATION в днях — номинальная: через осенний перевод конец в то же стенное время следующего дня", () => {
    const o = load(calendar(BERLIN, vevent(["DTSTART;TZID=Europe/Berlin:20261024T100000", "DURATION:P1D",
      "SUMMARY:Сутки"])));
    const [only] = instancesBetween(o, Date.parse(ALL[0]), Date.parse(ALL[1]));
    expect(iso(only.end)).toBe("2026-10-25T10:00:00+01:00");
    expect(only.endMs - only.startMs).toBe(25 * 3_600_000);
  });

  // Объекты вида затравок C55 и C56 (прежде — «следы прежнего кода»): теперь
  // это обычные чужие объекты, их переопределения — slot и detached.
  // Показывается каждый компонент, ни один не прячется и не двоится.
  it.each([
    ["перенос и второе переопределение с RECURRENCE-ID на новом времени первого",
      series([],
        moved("20261021T100000", "20261021T150000", "20261021T160000", "SUMMARY:Перенесена"),
        moved("20261021T150000", "20261021T150000", "20261021T160000", "SUMMARY:Второе")),
      ["slot", "override", "slot", "slot", "slot", "slot", "detached"]],
    ["RECURRENCE-ID мимо слотов серии в ту же дату",
      load(calendar(MOSCOW,
        vevent(["DTSTART;TZID=Europe/Moscow:20261019T090000", "DTEND;TZID=Europe/Moscow:20261019T100000",
          "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6", "SUMMARY:Планёрка"]),
        moved("20261021T100000", "20261021T113000", "20261021T123000"))),
      ["slot", "slot", "slot", "slot", "slot", "slot", "detached"]],
  ])("%s: каждый компонент показан ровно в одной встрече", (_name, o, kinds) => {
    const list = instancesBetween(o, Date.parse(ALL[0]), Date.parse(ALL[1]));
    const components = o.root.getAllSubcomponents("vevent").filter((c) => c.hasProperty("recurrence-id"));
    for (const component of components) {
      expect(list.filter((i) => i.shown === component || i.components.includes(component))).toHaveLength(1);
    }
    expect(list.map((i) => i.kind).sort()).toEqual([...kinds].sort());
  });
});

// ─────────────────────────────── адрес (Р10) ───────────────────────────────

describe("parseAddress: приём instanceStart (Р10)", () => {
  it("серия со временем: момент со смещением, Z или стенное время серии — один ключ", () => {
    const o = load(seeds.weeklyMoscow.ics);
    for (const input of ["2026-10-21T10:00:00+03:00", "2026-10-21T07:00:00Z", "2026-10-21T10:00:00",
      "2026-10-21T10:00+03:00", "2026-10-21T09:00:00+02:00"]) {
      expect(parseAddress(o, input)).toBe(at("2026-10-21T10:00:00+03:00"));
    }
  });

  it("серия на весь день: дата или полночь с любым смещением — буквальная дата (прежний «…T00:00:00+00:00» тоже)", () => {
    const o = load(seeds.allDayWeekly.ics);
    for (const input of ["2026-10-21", "2026-10-21T00:00:00+00:00", "2026-10-21T00:00:00+03:00",
      "2026-10-21T00:00:00Z", "2026-10-21T00:00:00", "2026-10-21T00:00-05:00"]) {
      expect(parseAddress(o, input)).toBe("D:2026-10-21");
    }
  });

  // J-B6, AE9, AE14: дата — буквальная, а не дата момента в поясе календаря.
  // Ошибка видна только там, где полночь по UTC — в календаре ещё вчера.
  it("серия на весь день в календаре западнее UTC: полночь по UTC и восточнее — та же дата, а не предыдущая", () => {
    const west = load(seeds.allDayWeekly.ics, { floatingZone: "America/New_York" });
    for (const input of ["2026-10-21T00:00:00+00:00", "2026-10-21T00:00:00Z", "2026-10-21T00:00:00+03:00", "2026-10-21"]) {
      expect(parseAddress(west, input), input).toBe("D:2026-10-21");
    }
    // Восточнее пояса календаря: полночь +05:00 — это 22:00 МСК накануне, а дата та же.
    expect(parseAddress(load(seeds.allDayWeekly.ics), "2026-10-21T00:00:00+05:00")).toBe("D:2026-10-21");
  });

  it("серия со временем без смещения — стенное время пояса серии, а не пояса календаря (Берлин в календаре Москвы)", () => {
    const o = load(seeds.dailyBerlin.ics);
    expect(parseAddress(o, "2026-10-21T10:00:00")).toBe(at("2026-10-21T10:00:00+02:00"));
    expect(parseAddress(o, "2026-10-26T10:00:00")).toBe(at("2026-10-26T10:00:00+01:00"));
    expect(resolve(o, "2026-10-26T10:00:00", "update").target).toMatchObject({ kind: "slot", key: at("2026-10-26T10:00:00+01:00") });
  });

  it("плавающая серия: момент — стенное время пояса календаря", () => {
    const o = load(seeds.floatingDaily.ics);
    for (const input of ["2026-10-20T08:00:00+03:00", "2026-10-20T05:00:00Z", "2026-10-20T08:00:00"]) {
      expect(parseAddress(o, input)).toBe("F:2026-10-20T08:00:00");
    }
  });

  it("invalid: не время, дата у серии со временем, не полночь или момент у серии на весь день (C47, J-B6)", () => {
    const timed = load(seeds.weeklyMoscow.ics);
    const allDay = load(seeds.allDayWeekly.ics);
    for (const [o, input] of [
      [timed, "завтра"], [timed, "2026-10-21"], [timed, "2026-13-01T10:00:00+03:00"], [timed, ""],
      [allDay, "2026-10-20T21:00:00Z"], [allDay, "2026-10-21T10:00:00+03:00"], [allDay, "21.10.2026"],
    ] as const) {
      const error = refusal(() => parseAddress(o, input));
      expect(error.code, input).toBe("invalid");
      expect(error.name).toBe("AddressError");
    }
  });
});

describe("resolveTarget: слот, detached, скрытое, фактическое начало", () => {
  it("слот без переопределения и слот с переопределением — по адресу слота", () => {
    const o = series([], moved("20261021T100000", "20261021T113000", "20261021T123000"));
    const plain = resolve(o, "2026-10-19T10:00:00+03:00", "update");
    expect(plain.target).toMatchObject({ kind: "slot", key: at("2026-10-19T10:00:00+03:00") });
    expect(plain.target.kind === "slot" && plain.target.instance.kind).toBe("slot");
    expect(plain.ambiguousWith).toBeUndefined();

    const movedTarget = resolve(o, "2026-10-21T10:00:00+03:00", "delete").target;
    expect(movedTarget).toMatchObject({ kind: "slot", key: at("2026-10-21T10:00:00+03:00") });
    if (movedTarget.kind !== "slot") throw new Error("ожидался слот");
    expect(movedTarget.instance).toMatchObject({ kind: "override", moved: true });
    expect(movedTarget.slot.key).toBe(at("2026-10-21T10:00:00+03:00"));
  });

  it("адрес по моменту: RECURRENCE-ID в поясе Berlin у серии в Москве — та же встреча, адрес +03:00 (C33)", () => {
    const o = load(calendar([...MOSCOW, ...BERLIN], vevent(SERIES),
      vevent(["RECURRENCE-ID;TZID=Europe/Berlin:20261021T090000", "DTSTART;TZID=Europe/Moscow:20261021T113000",
        "DTEND;TZID=Europe/Moscow:20261021T123000", "SUMMARY:Перенос"])));
    const { target } = resolve(o, "2026-10-21T10:00:00+03:00", "delete");
    if (target.kind !== "slot") throw new Error("ожидался слот");
    expect(target.instance.instanceStart).toBe("2026-10-21T10:00:00+03:00");
    expect(target.instance.components).toHaveLength(1);
    expect(between(o, "2026-10-21T00:00:00+03:00", "2026-10-22T00:00:00+03:00")).toEqual([
      "2026-10-21T10:00:00+03:00 → 2026-10-21T11:30:00+03:00/2026-10-21T12:30:00+03:00 Перенос [override, moved]",
    ]);
  });

  it("одиночное событие: адрес — его начало (single); иной адрес — mismatch (C18)", () => {
    const o = load(seeds.singleMoscow.ics);
    expect(resolve(o, "2026-10-20T15:00:00+03:00", "delete").target.kind).toBe("single");
    for (const op of ["delete", "update"] as const) {
      const error = refusal(() => resolve(o, "2026-10-27T15:00:00+03:00", op));
      expect(error.code).toBe("mismatch");
      expect(`${error.hint ?? ""} ${error.message}`).toContain("2026-10-20T15:00:00+03:00");
    }
  });

  it("not-found: вне слотов серии (C46)", () => {
    const o = load(seeds.weeklyMoscow.ics);
    for (const input of ["2026-10-20T10:00:00+03:00", "2026-10-21T10:30:00+03:00", "2026-12-02T10:00:00+03:00"]) {
      expect(refusal(() => resolve(o, input, "delete")).code).toBe("not-found");
    }
  });

  it("excluded: слот закрыт EXDATE", () => {
    const o = series(["EXDATE;TZID=Europe/Moscow:20261021T100000"]);
    for (const op of ["delete", "update"] as const) {
      expect(refusal(() => resolve(o, "2026-10-21T10:00:00+03:00", op)).code).toBe("excluded");
    }
  });

  it("actual-start: фактическое начало перенесённой — отказ с её адресом (C06, C07)", () => {
    const o = series([], moved("20261021T100000", "20261021T113000", "20261021T123000"));
    for (const op of ["delete", "update"] as const) {
      const error = refusal(() => resolve(o, "2026-10-21T11:30:00+03:00", op));
      expect(error.code).toBe("actual-start");
      expect(error.alternatives).toEqual(["2026-10-21T10:00:00+03:00"]);
      expect(`${error.hint ?? ""} ${error.message}`).toContain("2026-10-21T10:00:00+03:00");
    }
  });

  it("actual-start важнее excluded: слот удалён, а на его время перенесли другую встречу", () => {
    const o = series(["EXDATE;TZID=Europe/Moscow:20261028T100000"],
      moved("20261026T100000", "20261028T100000", "20261028T110000"));
    const error = refusal(() => resolve(o, "2026-10-28T10:00:00+03:00", "delete"));
    expect(error.code).toBe("actual-start");
    expect(error.alternatives).toEqual(["2026-10-26T10:00:00+03:00"]);
  });

  describe("ambiguous (S5c, C08, C53, C61): слот совпал с фактическим началом другой, перенесённой", () => {
    // 26.10 перенесена на 28.10 10:00 — в то же время, что обычная 28.10.
    const s5c = () => series([], moved("20261026T100000", "20261028T100000", "20261028T110000"));

    it.each(["delete", "update"] as const)("%s без confirm — отказ с обоими адресами", (op) => {
      const error = refusal(() => resolve(s5c(), "2026-10-28T10:00:00+03:00", op));
      expect(error.code).toBe("ambiguous");
      expect(error.alternatives).toEqual(["2026-10-28T10:00:00+03:00", "2026-10-26T10:00:00+03:00"]);
      const text = `${error.hint ?? ""} ${error.message}`;
      expect(text).toContain("2026-10-26T10:00:00+03:00");
      expect(text).toContain("confirm");
    });

    it.each(["delete", "update"] as const)("%s с confirm — слот 28.10, перенесённая названа в ambiguousWith", (op) => {
      const resolved = resolve(s5c(), "2026-10-28T10:00:00+03:00", op, true);
      expect(resolved.target).toMatchObject({ kind: "slot", key: at("2026-10-28T10:00:00+03:00") });
      if (resolved.target.kind !== "slot") throw new Error("ожидался слот");
      expect(resolved.target.instance.kind).toBe("slot");
      expect(resolved.ambiguousWith?.map((i) => i.instanceStart)).toEqual(["2026-10-26T10:00:00+03:00"]);
    });

    it("серия на весь день: перенос 26.10 на 28.10 — адрес 28.10 неоднозначен", () => {
      const o = load(seeds.allDayWeekly.ics.replace("END:VCALENDAR", [
        ...vevent(["RECURRENCE-ID;VALUE=DATE:20261026", "DTSTART;VALUE=DATE:20261028", "DTEND;VALUE=DATE:20261029",
          "SUMMARY:Дежурство"], seeds.allDayWeekly.uid),
        "END:VCALENDAR"].join(CRLF)));
      const error = refusal(() => resolve(o, "2026-10-28", "delete"));
      expect(error.code).toBe("ambiguous");
      expect(error.alternatives).toEqual(["2026-10-28", "2026-10-26"]);
      expect(resolve(o, "2026-10-28T00:00:00+00:00", "delete", true).ambiguousWith?.map((i) => i.instanceStart)).toEqual(["2026-10-26"]);
    });

    it("плавающая серия: перенос 20.10 на 21.10 08:00 — адрес 21.10 08:00 неоднозначен", () => {
      const o = load(seeds.floatingDaily.ics.replace("END:VCALENDAR", [
        ...vevent(["RECURRENCE-ID:20261020T080000", "DTSTART:20261021T080000", "DTEND:20261021T083000",
          "SUMMARY:Зарядка"], seeds.floatingDaily.uid),
        "END:VCALENDAR"].join(CRLF)));
      const error = refusal(() => resolve(o, "2026-10-21T08:00:00", "update"));
      expect(error.code).toBe("ambiguous");
      expect(error.alternatives).toEqual(["2026-10-21T08:00:00+03:00", "2026-10-20T08:00:00+03:00"]);
    });

    // Отменённая встреча видна в list_events со своим временем (Р7), так что
    // её фактическое начало модель может передать как адрес.
    it("отменённая перенесённая встреча тоже участвует: адрес 28.10 — ambiguous, её начало — actual-start", () => {
      const o = series([], moved("20261026T100000", "20261028T100000", "20261028T110000", "STATUS:CANCELLED"));
      for (const op of ["delete", "update"] as const) {
        const error = refusal(() => resolve(o, "2026-10-28T10:00:00+03:00", op));
        expect(error.code).toBe("ambiguous");
        expect(error.alternatives).toEqual(["2026-10-28T10:00:00+03:00", "2026-10-26T10:00:00+03:00"]);
      }
      const off = series([], moved("20261021T100000", "20261021T113000", "20261021T123000", "STATUS:CANCELLED"));
      const error = refusal(() => resolve(off, "2026-10-21T11:30:00+03:00", "delete"));
      expect(error.code).toBe("actual-start");
      expect(error.alternatives).toEqual(["2026-10-21T10:00:00+03:00"]);
    });

    it("адрес перенесённой (26.10) неоднозначности не даёт", () => {
      const resolved = resolve(s5c(), "2026-10-26T10:00:00+03:00", "delete");
      expect(resolved.target).toMatchObject({ kind: "slot", key: at("2026-10-26T10:00:00+03:00") });
      expect(resolved.ambiguousWith).toBeUndefined();
    });

    it("detached на время, куда перенесли другую встречу, — тоже ambiguous", () => {
      const o = series([],
        moved("20261021T120000", "20261021T120000", "20261021T130000", "SUMMARY:Отдельная"),
        moved("20261026T100000", "20261021T120000", "20261021T130000"));
      expect(refusal(() => resolve(o, "2026-10-21T12:00:00+03:00", "update")).code).toBe("ambiguous");
      const resolved = resolve(o, "2026-10-21T12:00:00+03:00", "update", true);
      expect(resolved.target.kind).toBe("detached");
      expect(resolved.ambiguousWith?.map((i) => i.instanceStart)).toEqual(["2026-10-26T10:00:00+03:00"]);
    });
  });

  it("detached: адрес — его RECURRENCE-ID; фактическое начало — actual-start", () => {
    const o = series([], moved("20261021T120000", "20261021T140000", "20261021T150000", "SUMMARY:Отдельная"));
    for (const op of ["delete", "update"] as const) {
      const { target } = resolve(o, "2026-10-21T12:00:00+03:00", op);
      expect(target).toMatchObject({ kind: "detached", key: at("2026-10-21T12:00:00+03:00") });
      if (target.kind !== "detached") throw new Error("ожидался detached");
      expect(target.refs).toHaveLength(1);
      expect(target.instance).toMatchObject({ kind: "detached", moved: true });
      const error = refusal(() => resolve(o, "2026-10-21T14:00:00+03:00", op));
      expect(error.code).toBe("actual-start");
      expect(error.alternatives).toEqual(["2026-10-21T12:00:00+03:00"]);
    }
  });

  it("объект из одних переопределений (Р6): адрес — RECURRENCE-ID", () => {
    const o = load(calendar(MOSCOW, moved("20261021T100000", "20261021T100000", "20261021T110000")));
    expect(resolve(o, "2026-10-21T10:00:00+03:00", "update").target.kind).toBe("detached");
    expect(refusal(() => resolve(o, "2026-10-22T10:00:00+03:00", "delete")).code).toBe("not-found");
  });

  it("скрытое под EXDATE: delete — по своему RECURRENCE-ID (C34); update — excluded", () => {
    const o = series(["EXDATE;TZID=Europe/Moscow:20261021T100000"],
      moved("20261021T100000", "20261021T100000", "20261021T110000", "SUMMARY:Особая планёрка"));
    const { target } = resolve(o, "2026-10-21T10:00:00+03:00", "delete");
    expect(target).toMatchObject({ kind: "hidden", key: at("2026-10-21T10:00:00+03:00") });
    if (target.kind !== "hidden") throw new Error("ожидалось скрытое");
    expect(target.hidden.reason).toBe("excluded");
    expect(target.refs.map((ref) => summaryOf(ref.component))).toEqual(["Особая планёрка"]);

    const error = refusal(() => resolve(o, "2026-10-21T10:00:00+03:00", "update"));
    expect(error.code).toBe("excluded");
    expect(error.hint).toMatch(/только удалить/);
  });

  it("скрытое после конца серии: delete — по RECURRENCE-ID; update — not-found", () => {
    const o = load(calendar(MOSCOW,
      vevent(["DTSTART;TZID=Europe/Moscow:20261019T100000", "DTEND;TZID=Europe/Moscow:20261019T110000",
        "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20261026T065959Z", "SUMMARY:Планёрка"]),
      moved("20261102T100000", "20261102T100000", "20261102T110000", "SUMMARY:Итоговая")));
    const { target } = resolve(o, "2026-11-02T10:00:00+03:00", "delete");
    expect(target.kind === "hidden" && target.hidden.reason).toBe("outside-series");
    expect(refusal(() => resolve(o, "2026-11-02T10:00:00+03:00", "update")).code).toBe("not-found");
  });

  it("скрытое и перенесённая на то же время: delete — ambiguous, с confirm — скрытое; update — actual-start", () => {
    const o = series(["EXDATE;TZID=Europe/Moscow:20261028T100000"],
      moved("20261028T100000", "20261028T100000", "20261028T110000", "SUMMARY:След удаления"),
      moved("20261026T100000", "20261028T100000", "20261028T110000"));
    expect(refusal(() => resolve(o, "2026-10-28T10:00:00+03:00", "delete")).code).toBe("ambiguous");
    const resolved = resolve(o, "2026-10-28T10:00:00+03:00", "delete", true);
    expect(resolved.target.kind).toBe("hidden");
    expect(resolved.ambiguousWith?.map((i) => i.instanceStart)).toEqual(["2026-10-26T10:00:00+03:00"]);
    expect(refusal(() => resolve(o, "2026-10-28T10:00:00+03:00", "update")).code).toBe("actual-start");
  });

  it("весь день: «…T00:00:00+00:00» и дата — одна встреча; момент 21:00Z накануне — invalid (C47)", () => {
    const o = load(seeds.allDayWeekly.ics);
    const byDate = resolve(o, "2026-10-21", "delete").target;
    const byLegacy = resolve(o, "2026-10-21T00:00:00+00:00", "delete").target;
    expect(byDate).toMatchObject({ kind: "slot", key: "D:2026-10-21" });
    expect(byLegacy).toMatchObject({ kind: "slot", key: "D:2026-10-21" });
    expect(refusal(() => resolve(o, "2026-10-20T21:00:00Z", "delete")).code).toBe("invalid");
    expect(refusal(() => resolve(o, "2026-10-20", "update")).code).toBe("not-found");
  });

  it("весь день в календаре западнее UTC: прежний «…T00:00:00+00:00» — встреча той же даты (J-B6)", () => {
    const o = load(seeds.allDayWeekly.ics, { floatingZone: "America/New_York" });
    for (const op of ["delete", "update"] as const) {
      const { target } = resolve(o, "2026-10-21T00:00:00+00:00", op);
      expect(target).toMatchObject({ kind: "slot", key: "D:2026-10-21" });
      if (target.kind !== "slot") throw new Error("ожидался слот");
      expect(target.instance.instanceStart).toBe("2026-10-21");
    }
  });

  it("instanceAt: встреча по адресу или undefined", () => {
    const o = series(["EXDATE;TZID=Europe/Moscow:20261026T100000"],
      moved("20261021T100000", "20261021T113000", "20261021T123000"));
    expect(instanceAt(o, at("2026-10-21T10:00:00+03:00"))?.kind).toBe("override");
    expect(instanceAt(o, at("2026-10-19T10:00:00+03:00"))?.kind).toBe("slot");
    expect(instanceAt(o, at("2026-10-26T10:00:00+03:00"))).toBeUndefined();
    expect(instanceAt(o, at("2026-10-21T11:30:00+03:00"))).toBeUndefined();
  });
});

// ─────────────────────── видимые по адресу и скрытые ───────────────────────

describe("visibleMap и hiddenOverrides", () => {
  const o = () => series(["EXDATE;TZID=Europe/Moscow:20261026T100000"],
    moved("20261021T100000", "20261023T100000", "20261023T110000"),
    moved("20261022T100000", "20261022T100000", "20261022T110000", "SUMMARY:Отдельная"),
    moved("20261026T100000", "20261026T100000", "20261026T110000", "SUMMARY:Скрытая"));

  it("видимые по адресу до горизонта: перенесённая — под своим слотом, detached — под RECURRENCE-ID", () => {
    const map = visibleMap(o(), { until: at("2026-11-04T10:00:00+03:00") });
    expect([...map.values()].map((i) => `${i.instanceStart} ${i.kind}`)).toEqual([
      "2026-10-19T10:00:00+03:00 slot",
      "2026-10-21T10:00:00+03:00 override",
      "2026-10-22T10:00:00+03:00 detached",
      "2026-10-28T10:00:00+03:00 slot",
      "2026-11-02T10:00:00+03:00 slot",
      "2026-11-04T10:00:00+03:00 slot",
    ]);
    expect([...map.keys()][1]).toBe(at("2026-10-21T10:00:00+03:00"));
  });

  it("горизонт продлевается до minSlots видимых слотов", () => {
    const map = visibleMap(o(), { until: at("2026-10-21T10:00:00+03:00"), minSlots: 3 });
    expect([...map.values()].map((i) => i.instanceStart)).toEqual([
      "2026-10-19T10:00:00+03:00", "2026-10-21T10:00:00+03:00", "2026-10-22T10:00:00+03:00", "2026-10-28T10:00:00+03:00",
    ]);
  });

  it("переопределения за горизонтом в карту не попадают: ни встреча слота, ни detached", () => {
    const beyond = series([],
      moved("20261028T100000", "20261028T120000", "20261028T130000"),
      moved("20261029T100000", "20261029T100000", "20261029T110000", "SUMMARY:Отдельная"));
    const map = visibleMap(beyond, { until: at("2026-10-21T10:00:00+03:00") });
    expect([...map.values()].map((i) => `${i.instanceStart} ${i.kind}`)).toEqual([
      "2026-10-19T10:00:00+03:00 slot",
      "2026-10-21T10:00:00+03:00 slot",
    ]);
  });

  it("hiddenOverrides: под EXDATE и вне серии, с причиной", () => {
    expect(hiddenOverrides(o()).map((h) => `${formatForModel(h.address, ENV, "instance")} ${h.reason} ${h.refs.length}`))
      .toEqual(["2026-10-26T10:00:00+03:00 excluded 1"]);
    const outside = load(calendar(MOSCOW, vevent(SERIES), moved("20261018T100000", "20261018T100000", "20261018T110000")));
    expect(hiddenOverrides(outside).map((h) => h.reason)).toEqual(["outside-series"]);
  });
});

// ─────────────────────────────── CalendarEvent ───────────────────────────────

describe("toCalendarEvent: форматы Р10", () => {
  const META = { calendarId: "cal-1", etag: '"7"', href: "/calendars/user/cal-1/x.ics" };

  it("встреча серии: адрес, фактическое время, повтор, id серии", () => {
    const o = load(seeds.weeklyMoscow.ics);
    const [second] = instancesBetween(o, Date.parse("2026-10-21T00:00:00+03:00"), Date.parse("2026-10-22T00:00:00+03:00"));
    expect(toCalendarEvent(o, second, META)).toEqual({
      id: seeds.weeklyMoscow.uid,
      calendarId: "cal-1",
      summary: "Планёрка",
      start: "2026-10-21T10:00:00+03:00",
      end: "2026-10-21T11:00:00+03:00",
      timeZone: "Europe/Moscow",
      allDay: false,
      recurrence: { frequency: "weekly", interval: 1, byWeekday: ["MO", "WE"], count: 6 },
      reminders: [],
      attendees: [],
      etag: '"7"',
      href: "/calendars/user/cal-1/x.ics",
      instanceStart: "2026-10-21T10:00:00+03:00",
      seriesId: seeds.weeklyMoscow.uid,
      recurring: true,
    });
  });

  it("перенесённая: moved, поля переопределения; detached с RECURRENCE-ID в UTC — адрес в поясе серии", () => {
    const o = series([],
      moved("20261021T100000", "20261021T113000", "20261021T123000", "LOCATION:Переговорная 5"),
      vevent(["RECURRENCE-ID:20261022T090000Z", "DTSTART:20261022T090000Z", "DTEND:20261022T100000Z", "SUMMARY:Отдельная"]));
    const [movedOne, detached] = instancesBetween(o, Date.parse("2026-10-21T00:00:00+03:00"), Date.parse("2026-10-23T00:00:00+03:00"));
    expect(toCalendarEvent(o, movedOne, META)).toMatchObject({
      summary: "Перенос", location: "Переговорная 5", start: "2026-10-21T11:30:00+03:00", end: "2026-10-21T12:30:00+03:00",
      instanceStart: "2026-10-21T10:00:00+03:00", moved: true, recurring: true,
    });
    expect(toCalendarEvent(o, movedOne, META).detached).toBeUndefined();
    expect(toCalendarEvent(o, detached, META)).toMatchObject({
      summary: "Отдельная", start: "2026-10-22T09:00:00+00:00", timeZone: "UTC",
      instanceStart: "2026-10-22T12:00:00+03:00", detached: true,
    });
    expect(toCalendarEvent(o, detached, META).moved).toBeUndefined();
  });

  it("весь день: адрес — дата, start и end — полночь пояса календаря", () => {
    const o = load(seeds.allDayWeekly.ics);
    const [first] = instancesBetween(o, Date.parse("2026-10-19T00:00:00+03:00"), Date.parse("2026-10-20T00:00:00+03:00"));
    expect(toCalendarEvent(o, first, META)).toMatchObject({
      instanceStart: "2026-10-19", start: "2026-10-19T00:00:00+03:00", end: "2026-10-20T00:00:00+03:00",
      allDay: true, timeZone: "Europe/Moscow",
    });
  });

  it("одиночное: не часть серии — без instanceStart и seriesId; STATUS:CANCELLED — status", () => {
    const o = load(seeds.singleMoscow.ics.replace("SUMMARY:", "STATUS:CANCELLED\r\nSUMMARY:"));
    const event = toCalendarEvent(o, "object", META);
    expect(event).toMatchObject({ summary: "Обед с командой", start: "2026-10-20T15:00:00+03:00", recurring: false, status: "cancelled" });
    expect(event.instanceStart).toBeUndefined();
    expect(event.seriesId).toBeUndefined();
    expect(event.recurrence).toBeUndefined();
    const [only] = instancesBetween(o, Date.parse(ALL[0]), Date.parse(ALL[1]));
    expect(only.cancelled).toBe(true);
    expect(toCalendarEvent(o, only, META)).toMatchObject({ recurring: false, status: "cancelled" });
  });

  it("напоминания и участники — из показываемого компонента", () => {
    const o = load(seeds.richMoscow.ics);
    const event = toCalendarEvent(o, "object", META);
    expect(event.reminders).toEqual([{ minutesBefore: 10, method: "display" }, { minutesBefore: 15, method: "display" }]);
    expect(event.attendees).toEqual([
      { email: "petrov@example.com", status: "accepted" },
      { email: "anna@example.com", status: "accepted" },
    ]);
  });

  it("повтор: невыразимые части — unmodeled; RDATE — ещё и recurrenceRule; UNTIL — в поясе серии или датой", () => {
    const setpos = load(calendar(MOSCOW, vevent(["DTSTART;TZID=Europe/Moscow:20261030T100000", "DTEND;TZID=Europe/Moscow:20261030T110000",
      "RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;WKST=SU", "SUMMARY:Отчёт"])));
    expect(toCalendarEvent(setpos, "object", META).recurrence).toEqual({
      frequency: "monthly", interval: 1, byWeekday: ["MO", "TU", "WE", "TH", "FR"], unmodeled: "BYSETPOS=-1;WKST=SU",
    });
    expect(toCalendarEvent(setpos, "object", META).recurrenceRule).toBeUndefined();

    const rich = toCalendarEvent(load(seeds.richMoscow.ics), "object", META);
    expect(rich.recurrence).toEqual({ frequency: "weekly", interval: 1, byWeekday: ["WE"], count: 5 });
    expect(rich.recurrenceRule).toBe("RRULE:FREQ=WEEKLY;BYDAY=WE;COUNT=5\nRDATE;TZID=Europe/Moscow:20261030T120000");

    const until = load(calendar(MOSCOW, vevent(["DTSTART;TZID=Europe/Moscow:20261019T100000", "DTEND;TZID=Europe/Moscow:20261019T110000",
      "RRULE:FREQ=WEEKLY;INTERVAL=2;UNTIL=20261102T065959Z", "SUMMARY:Раз в две недели"])));
    expect(toCalendarEvent(until, "object", META).recurrence).toEqual({ frequency: "weekly", interval: 2, until: "2026-11-02T09:59:59+03:00" });

    const allDayUntil = load(seeds.allDayWeekly.ics.replace("COUNT=6", "UNTIL=20261102"));
    expect(toCalendarEvent(allDayUntil, "object", META).recurrence?.until).toBe("2026-11-02");
  });

  it("HOURLY — recurrence нет, правило дословно в recurrenceRule", () => {
    const o = load(calendar(MOSCOW, vevent(["DTSTART;TZID=Europe/Moscow:20261019T100000", "DURATION:PT15M",
      "RRULE:FREQ=HOURLY;COUNT=3", "SUMMARY:Проверка"])));
    const event = toCalendarEvent(o, "object", META);
    expect(event.recurrence).toBeUndefined();
    expect(event.recurrenceRule).toBe("RRULE:FREQ=HOURLY;COUNT=3");
    expect(event.recurring).toBe(true);
  });

  it("объект целиком (get_event): exceptions со всеми состояниями и anomalies", () => {
    const o = series(["EXDATE;TZID=Europe/Moscow:20261026T100000"],
      moved("20261021T100000", "20261021T100000", "20261021T110000", "SUMMARY:Особая"),
      moved("20261022T100000", "20261022T100000", "20261022T110000", "SUMMARY:Отдельная"),
      moved("20261026T100000", "20261026T100000", "20261026T110000", "SUMMARY:Скрытая"),
      moved("20261028T100000", "20261029T100000", "20261029T110000"),
      moved("20261102T100000", "20261102T100000", "20261102T110000", "SUMMARY:Планёрка", "STATUS:CANCELLED"),
      moved("20261104T100000", "20261104T100000", "20261104T110000", "SUMMARY:Черновик", "SEQUENCE:0"),
      moved("20261104T100000", "20261104T100000", "20261104T110000", "SUMMARY:Итог", "SEQUENCE:1"));
    const event = toCalendarEvent(o, "object", META);
    expect(event).toMatchObject({ start: "2026-10-19T10:00:00+03:00", end: "2026-10-19T11:00:00+03:00", summary: "Планёрка", recurring: true });
    expect(event.instanceStart).toBeUndefined();
    expect(event.exceptions?.map((e) => `${e.instanceStart} ${e.state} ${e.start ?? "-"} ${e.summary ?? "-"}`)).toEqual([
      "2026-10-21T10:00:00+03:00 changed 2026-10-21T10:00:00+03:00 Особая",
      "2026-10-22T10:00:00+03:00 detached 2026-10-22T10:00:00+03:00 Отдельная",
      "2026-10-26T10:00:00+03:00 excluded - -",
      "2026-10-26T10:00:00+03:00 hidden 2026-10-26T10:00:00+03:00 Скрытая",
      "2026-10-28T10:00:00+03:00 moved 2026-10-29T10:00:00+03:00 Перенос",
      "2026-11-02T10:00:00+03:00 cancelled 2026-11-02T10:00:00+03:00 Планёрка",
      "2026-11-04T10:00:00+03:00 changed 2026-11-04T10:00:00+03:00 Итог",
      "2026-11-04T10:00:00+03:00 duplicate 2026-11-04T10:00:00+03:00 Черновик",
    ]);
    expect(event.exceptions?.every((e) => typeof e.reason === "string" && e.reason.length > 0)).toBe(true);
    expect(event.anomalies).toEqual([expect.stringMatching(/^duplicate-override: /)]);
  });

  it("exceptions: EXDATE мимо слотов серии не выдаётся — он ничего не закрывает", () => {
    const o = series(["EXDATE;TZID=Europe/Moscow:20261020T100000,20261021T100000", "EXDATE;TZID=Europe/Moscow:20261026T113000"]);
    expect(toCalendarEvent(o, "object", META).exceptions?.map((e) => `${e.instanceStart} ${e.state}`)).toEqual([
      "2026-10-21T10:00:00+03:00 excluded",
    ]);
  });

  it("объект из одних переопределений (Р6) целиком: первая встреча, detached, адрес — RECURRENCE-ID", () => {
    const o = load(calendar(MOSCOW,
      moved("20261028T100000", "20261028T100000", "20261028T110000", "SUMMARY:Второе"),
      moved("20261021T100000", "20261021T100000", "20261021T110000", "SUMMARY:Первое")));
    const event = toCalendarEvent(o, "object", META);
    expect(event).toMatchObject({ summary: "Первое", instanceStart: "2026-10-21T10:00:00+03:00", detached: true, recurring: true, seriesId: UID });
    expect(event.exceptions?.map((e) => `${e.instanceStart} ${e.state}`)).toEqual([
      "2026-10-21T10:00:00+03:00 detached",
      "2026-10-28T10:00:00+03:00 detached",
    ]);
  });
});
