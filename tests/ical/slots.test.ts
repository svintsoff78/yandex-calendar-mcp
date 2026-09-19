import ICAL from "ical.js";
import { describe, expect, it } from "vitest";
import { loadObject, type CalendarObject } from "../../src/ical/object.js";
import {
  SlotScanError,
  findSlot,
  firstSlot,
  isDtstartSynced,
  isEmpty,
  iterateSlots,
  lastSlotUpTo,
  positionsBefore,
  sameTail,
  seriesExtent,
  type Slot,
} from "../../src/ical/slots.js";
import type { IcalEnv, SlotKey } from "../../src/ical/values.js";
import * as seeds from "../support/seeds.js";

// Слоты серии (О2, Р3 плана переделки,
// docs/superpowers/plans/2026-09-19-recurring-events-rework.md, задача З06).
// Ожидания заданы строками ISO со смещением и Date.UTC: тесты не зависят от
// пояса процесса (прогон под тремя поясами — npm run test:tz).

const ENV: IcalEnv = { floatingZone: "Europe/Moscow", ownerEmail: "user@yandex.ru" };
const CRLF = "\r\n";

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
/**
 * Москва с историей 1990 года, как её отдаёт Яндекс (Ж10): летом 1990 — MSD
 * +04, с 30.09.1990 — +03. В базе поясов @touch4it у Москвы только +03 с
 * 1970 года, так что слот 04.06.1990 10:00 по базе был бы 07:00Z, а по
 * описанию из объекта — 06:00Z.
 */
const MOSCOW_1990 = [
  "BEGIN:VTIMEZONE", "TZID:Europe/Moscow",
  "BEGIN:STANDARD", "TZNAME:MSK", "TZOFFSETFROM:+0300", "TZOFFSETTO:+0300", "DTSTART:19700101T000000", "END:STANDARD",
  "BEGIN:DAYLIGHT", "TZNAME:MSD", "TZOFFSETFROM:+0300", "TZOFFSETTO:+0400", "DTSTART:19900325T020000", "END:DAYLIGHT",
  "BEGIN:STANDARD", "TZNAME:MSK", "TZOFFSETFROM:+0400", "TZOFFSETTO:+0300", "DTSTART:19900930T030000", "END:STANDARD",
  "END:VTIMEZONE",
];

/** Календарь из одного основного компонента и, при желании, переопределений. */
function calendar(zones: string[], master: string[], ...overrides: string[][]): string {
  const vevent = (uid: string, lines: string[]) => ["BEGIN:VEVENT", `UID:${uid}`, "DTSTAMP:20261001T090000Z", ...lines, "END:VEVENT"];
  return [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//slots//RU", ...zones,
    ...vevent("slots-test", master), ...overrides.flatMap((lines) => vevent("slots-test", lines)),
    "END:VCALENDAR",
  ].join(CRLF) + CRLF;
}

function load(ics: string): CalendarObject {
  const object = loadObject(ics, ENV);
  if (object.kind === "unparsable") throw new Error(`не разобран: ${object.error}`);
  return object;
}

/** Серия Europe/Moscow по правилу; DTSTART по умолчанию — Пн 19.10.2026 10:00. */
function moscow(rule: string | undefined, ...extra: string[]): CalendarObject {
  const start = extra.find((line) => line.startsWith("DTSTART")) ?? "DTSTART;TZID=Europe/Moscow:20261019T100000";
  const rest = extra.filter((line) => !line.startsWith("DTSTART"));
  return load(calendar(MOSCOW, [start, "DURATION:PT1H", ...(rule ? [`RRULE:${rule}`] : []), "SUMMARY:Серия", ...rest]));
}

/** Ключ слота серии с поясом: момент в секундах Unix. */
const at = (iso: string): SlotKey => `T:${Date.parse(iso) / 1000}`;
const keys = (slots: Iterable<Slot>) => [...slots].map((slot) => slot.key);
const collect = (o: CalendarObject, bound?: Parameters<typeof iterateSlots>[1]) => [...iterateSlots(o, bound)];
const weekly = () => load(seeds.weeklyMoscow.ics);
const WEEKLY_KEYS = ["2026-10-19", "2026-10-21", "2026-10-26", "2026-10-28", "2026-11-02", "2026-11-04"]
  .map((day) => at(`${day}T07:00:00Z`));

describe("iterateSlots: DTSTART, позиции правила и RDATE минус EXDATE (О2)", () => {
  it("выдаёт DTSTART и позиции правила по порядку, с номерами позиций и временем в поясе DTSTART", () => {
    const slots = collect(weekly());

    expect(keys(slots)).toEqual(WEEKLY_KEYS);
    expect(slots.map((slot) => slot.position)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(slots.every((slot) => !slot.excluded)).toBe(true);
    expect(slots[0].origin).toBe("dtstart");
    expect(slots[0].sources).toEqual(["dtstart", "rrule"]);
    expect(slots[1].origin).toBe("rrule");
    expect(slots[1].time.toString()).toBe("2026-10-21T10:00:00");
    expect(slots[1].time.zone?.tzid).toBe("Europe/Moscow");
  });

  it("каждая выдача — независимая копия: итератор ical.js отдаёт один и тот же объект", () => {
    // recur_iterator.js, next: `return this.last` — без клонирования все слоты были бы одним временем.
    const [first, second] = collect(weekly(), { limit: 2 });

    expect(first.time).not.toBe(second.time);
    first.time.adjust(1, 0, 0, 0);
    expect(keys(collect(weekly(), { limit: 2 }))).toEqual(WEEKLY_KEYS.slice(0, 2));
  });

  it("DTSTART вне правила — отдельный слот без номера позиции; позиции считает только правило", () => {
    // recur_iterator.js:386-467: DTSTART во вторник при BYDAY=MO,WE не выдаётся и не считается в COUNT.
    const o = moscow("FREQ=WEEKLY;BYDAY=MO,WE;COUNT=4", "DTSTART;TZID=Europe/Moscow:20261020T100000");
    const slots = collect(o);

    expect(keys(slots)).toEqual(
      ["2026-10-20", "2026-10-21", "2026-10-26", "2026-10-28", "2026-11-02"].map((d) => at(`${d}T07:00:00Z`)),
    );
    expect(slots.map((slot) => slot.position)).toEqual([undefined, 1, 2, 3, 4]);
    expect(slots[0].sources).toEqual(["dtstart"]);
    expect(isDtstartSynced(o)).toBe(false);
    expect(isDtstartSynced(weekly())).toBe(true);
  });

  it("RDATE добавляет слоты, EXDATE закрывает слот, но не убирает его из набора", () => {
    // richMoscow: Ср 12:00 с 21.10 COUNT=5, EXDATE 28.10, RDATE Пт 30.10.
    const slots = collect(load(seeds.richMoscow.ics));

    expect(keys(slots)).toEqual(
      ["2026-10-21", "2026-10-28", "2026-10-30", "2026-11-04", "2026-11-11", "2026-11-18"].map((d) => at(`${d}T09:00:00Z`)),
    );
    expect(slots.map((slot) => slot.excluded)).toEqual([false, true, false, false, false, false]);
    expect(slots[2]).toMatchObject({ origin: "rdate", sources: ["rdate"], position: undefined });
    expect(slots[3].position).toBe(3); // закрытая EXDATE позиция 28.10 считается
  });

  it("RDATE в чужом TZID и в UTC совпадает с позицией по моменту; PERIOD даёт конец", () => {
    const o = moscow(
      "FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6",
      "RDATE:20261021T070000Z",
      "RDATE;TZID=Europe/Berlin:20261023T090000",
      "RDATE;VALUE=PERIOD:20261024T070000Z/PT2H",
    );
    const slots = collect(o);
    const byKey = new Map(slots.map((slot) => [slot.key, slot]));

    expect(slots).toHaveLength(8);
    expect(byKey.get(at("2026-10-21T07:00:00Z"))?.sources).toEqual(["rrule", "rdate"]);
    const friday = byKey.get(at("2026-10-23T07:00:00Z"))!;
    expect(friday.origin).toBe("rdate");
    // Время RDATE приведено к форме и поясу DTSTART (О4): 09:00 CEST — это 10:00 МСК.
    expect(friday.time.toString()).toBe("2026-10-23T10:00:00");
    expect(byKey.get(at("2026-10-24T07:00:00Z"))?.periodEnd?.toString()).toBe("2026-10-24T09:00:00Z");
  });

  it("дубль EXDATE и «пустой» EXDATE мимо слотов не сбивают перебор (в отличие от RecurExpansion)", () => {
    // tests/ical/icaljs-contract.test.ts: RecurExpansion.next на дубле EXDATE пропускает исключение.
    const o = moscow(
      "FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6",
      "EXDATE;TZID=Europe/Moscow:20261021T100000",
      "EXDATE;TZID=Europe/Moscow:20261021T100000",
      "EXDATE;TZID=Europe/Moscow:20261021T113000",
      "EXDATE;TZID=Europe/Moscow:20261026T100000",
    );
    const slots = collect(o);

    expect(keys(slots)).toEqual(WEEKLY_KEYS);
    expect(slots.map((slot) => slot.excluded)).toEqual([false, true, true, false, false, false]);
  });

  it("EXDATE в UTC и в чужом TZID закрывает слот по моменту", () => {
    const o = moscow("FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6", "EXDATE:20261021T070000Z", "EXDATE;TZID=Europe/Berlin:20261028T080000");

    expect(collect(o).filter((slot) => slot.excluded).map((slot) => slot.key)).toEqual(
      [at("2026-10-21T07:00:00Z"), at("2026-10-28T07:00:00Z")],
    );
  });

  it("HOURLY: слоты через час, позиции по порядку", () => {
    const o = moscow("FREQ=HOURLY;INTERVAL=2;COUNT=4", "EXDATE;TZID=Europe/Moscow:20261019T120000");
    const slots = collect(o);

    expect(keys(slots)).toEqual(["07", "09", "11", "13"].map((h) => at(`2026-10-19T${h}:00:00Z`)));
    expect(slots.map((slot) => slot.excluded)).toEqual([false, true, false, false]);
    expect(positionsBefore(o, at("2026-10-19T13:00:00Z"))).toBe(3);
    expect(seriesExtent(o)).toMatchObject({ kind: "finite", count: 4, live: 3 });
  });

  it.each([
    ["осенний переход (повторный час)", "20261025T000000", 5],
    ["весенний переход (разрыв)", "20260329T000000", 4],
  ])("HOURLY у перехода часов в Берлине, %s: ключи строго растут и не двоятся", (_label, start, count) => {
    const o = load(calendar(BERLIN, [`DTSTART;TZID=Europe/Berlin:${start}`, "DURATION:PT30M",
      `RRULE:FREQ=HOURLY;COUNT=${count}`, "SUMMARY:Каждый час"]));
    const numbers = keys(collect(o)).map((key) => Number(key.slice(2)));

    expect(numbers.length).toBeGreaterThanOrEqual(count - 1);
    for (let i = 1; i < numbers.length; i++) expect(numbers[i]).toBeGreaterThan(numbers[i - 1]);
  });

  it("BYSETPOS: последний рабочий день месяца", () => {
    const o = moscow("FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;COUNT=4", "DTSTART;TZID=Europe/Moscow:20261030T100000");

    expect(keys(collect(o))).toEqual(
      ["2026-10-30", "2026-11-30", "2026-12-31", "2027-01-29"].map((d) => at(`${d}T07:00:00Z`)),
    );
    expect(isDtstartSynced(o)).toBe(true);
  });

  it("серия на весь день: ключи D:, унаследованный EXDATE в DATE-TIME закрывает свою дату", () => {
    const text = seeds.allDayWeekly.ics.replace("RRULE:", "EXDATE:20261021T000000Z\r\nRRULE:");
    const slots = collect(load(text));

    expect(keys(slots)).toEqual(["2026-10-19", "2026-10-21", "2026-10-26", "2026-10-28", "2026-11-02", "2026-11-04"]
      .map((d) => `D:${d}`));
    expect(slots[1].excluded).toBe(true);
    expect(slots[0].time.isDate).toBe(true);
  });

  it("плавающая серия: ключи F: — стенное время", () => {
    expect(keys(collect(load(seeds.floatingDaily.ics)))).toEqual(
      ["19", "20", "21", "22", "23"].map((d) => `F:2026-10-${d}T08:00:00`),
    );
  });

  it("серия из одних RDATE: DTSTART и даты RDATE", () => {
    const o = moscow(undefined, "RDATE;TZID=Europe/Moscow:20261022T100000,20261027T100000");

    expect(o.kind).toBe("series");
    expect(keys(collect(o))).toEqual(["2026-10-19", "2026-10-22", "2026-10-27"].map((d) => at(`${d}T07:00:00Z`)));
  });

  it("одиночное событие — один слот DTSTART", () => {
    const o = load(seeds.singleMoscow.ics);

    expect(keys(collect(o))).toEqual([at("2026-10-20T12:00:00Z")]);
    expect(seriesExtent(o)).toMatchObject({ kind: "finite", count: 1 });
  });

  it("границы перебора: until включительно и limit", () => {
    expect(keys(collect(weekly(), { until: at("2026-10-26T07:00:00Z") }))).toEqual(WEEKLY_KEYS.slice(0, 3));
    expect(keys(collect(weekly(), { until: at("2026-10-26T06:59:59Z") }))).toEqual(WEEKLY_KEYS.slice(0, 2));
    expect(keys(collect(weekly(), { limit: 4 }))).toEqual(WEEKLY_KEYS.slice(0, 4));
  });

  it("EXRULE закрывает свои позиции", () => {
    const o = moscow("FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6", "EXRULE:FREQ=WEEKLY;BYDAY=WE;COUNT=2");

    expect(collect(o).filter((slot) => slot.excluded).map((slot) => slot.key)).toEqual(
      [at("2026-10-21T07:00:00Z"), at("2026-10-28T07:00:00Z")],
    );
  });

  it("findSlot и firstSlot", () => {
    const o = load(seeds.richMoscow.ics);

    expect(findSlot(o, at("2026-10-30T09:00:00Z"))?.origin).toBe("rdate");
    expect(findSlot(o, at("2026-10-28T09:00:00Z"))?.excluded).toBe(true);
    expect(findSlot(o, at("2026-10-29T09:00:00Z"))).toBeUndefined();
    expect(findSlot(o, at("2026-12-30T09:00:00Z"))).toBeUndefined();
    expect(firstSlot(o)?.key).toBe(at("2026-10-21T09:00:00Z"));
  });
});

describe("годовые серии с несуществующей датой (RFC 5545 §3.3.10: такие позиции не считаются)", () => {
  it("YEARLY с 29 февраля — только високосные годы, а не 1 марта, как отдаёт итератор ical.js", () => {
    // Итератор ical.js 2.2.1 без BYMONTHDAY даёт 2029-03-01 и 2030-03-01
    // (recur_iterator.js, expand_year_days: dayOfYear от несуществующей даты).
    const o = moscow("FREQ=YEARLY;COUNT=3", "DTSTART;TZID=Europe/Moscow:20280229T100000");

    expect(keys(collect(o))).toEqual(["2028-02-29", "2032-02-29", "2036-02-29"].map((d) => at(`${d}T07:00:00Z`)));
    expect(collect(o).map((slot) => slot.position)).toEqual([1, 2, 3]);
    expect(positionsBefore(o, at("2036-02-29T07:00:00Z"))).toBe(2);
  });

  it("YEARLY;INTERVAL=2 с 29 февраля — 2028, 2032, 2036", () => {
    const o = moscow("FREQ=YEARLY;INTERVAL=2", "DTSTART;TZID=Europe/Moscow:20280229T100000");

    expect(keys(collect(o, { limit: 3 }))).toEqual(["2028-02-29", "2032-02-29", "2036-02-29"].map((d) => at(`${d}T07:00:00Z`)));
  });

  it("YEARLY;BYMONTH=1,2,3 с 31-го — февраль пропускается", () => {
    const o = moscow("FREQ=YEARLY;BYMONTH=1,2,3;COUNT=4", "DTSTART;TZID=Europe/Moscow:20260131T100000");

    expect(keys(collect(o))).toEqual(["2026-01-31", "2026-03-31", "2027-01-31", "2027-03-31"].map((d) => at(`${d}T07:00:00Z`)));
  });
});

describe("правила без позиций и ошибки итератора (Р4)", () => {
  it("правило, которое после DTSTART не находит позиций, не вешает перебор: no-positions, читается DTSTART", () => {
    // DAILY;BYMONTH=2;BYMONTHDAY=30: внутренний цикл next() ical.js
    // (recur_iterator.js:451) не кончается никогда — нужен предохранитель.
    const o = moscow("FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30");

    expect(o.anomalies.map((a) => a.code)).toContain("no-positions");
    expect(keys(collect(o))).toEqual([at("2026-10-19T07:00:00Z")]);
    expect(seriesExtent(o)).toMatchObject({ kind: "finite", count: 1 });
    expect(isEmpty(o)).toBe(false);
  });

  it("ошибка инициализации итератора — bad-rrule, читается DTSTART", () => {
    // recur_iterator.js, init: «For WEEKLY recurrences neither BYMONTHDAY nor BYYEARDAY may appear».
    const o = moscow("FREQ=WEEKLY;BYMONTHDAY=1");

    expect(o.anomalies.map((a) => a.code)).toContain("bad-rrule");
    expect(keys(collect(o))).toEqual([at("2026-10-19T07:00:00Z")]);
  });

  it("UNTIL раньше DTSTART — no-positions, DTSTART остаётся слотом", () => {
    const o = moscow("FREQ=DAILY;UNTIL=20261001T000000Z");

    expect(o.anomalies.map((a) => a.code)).toContain("no-positions");
    expect(keys(collect(o))).toEqual([at("2026-10-19T07:00:00Z")]);
  });
});

describe("seriesExtent: конец серии полным проходом, без горизонта", () => {
  it("бесконечное правило", () => {
    expect(seriesExtent(moscow("FREQ=DAILY"))).toEqual({ kind: "infinite" });
  });

  it("конечная серия: число слотов и последний слот", () => {
    const extent = seriesExtent(weekly());

    expect(extent).toMatchObject({ kind: "finite", count: 6, live: 6 });
    if (extent.kind !== "finite") throw new Error(extent.kind);
    expect(extent.last?.key).toBe(WEEKLY_KEYS[5]);
    expect(extent.lastLive?.key).toBe(WEEKLY_KEYS[5]);
  });

  it("COUNT при EXDATE: закрытые слоты в count входят, в live — нет", () => {
    const o = moscow("FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6", "EXDATE;TZID=Europe/Moscow:20261104T100000",
      "EXDATE;TZID=Europe/Moscow:20261021T100000");
    const extent = seriesExtent(o);

    expect(extent).toMatchObject({ kind: "finite", count: 6, live: 4 });
    if (extent.kind !== "finite") throw new Error(extent.kind);
    expect(extent.last).toMatchObject({ key: WEEKLY_KEYS[5], excluded: true });
    expect(extent.lastLive?.key).toBe(WEEKLY_KEYS[4]);
    expect(positionsBefore(o, WEEKLY_KEYS[5])).toBe(5); // EXDATE не влияет на позиции
  });

  it("UNTIL через два года (C58): последняя встреча 30.10.2028 в наборе, лишних нет", () => {
    const o = moscow("FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20281030T070000Z");
    const extent = seriesExtent(o);

    const day = 86_400_000;
    const expected: string[] = [];
    for (let ms = Date.UTC(2026, 9, 19, 7); ms <= Date.UTC(2028, 9, 30, 7); ms += day) {
      const weekday = new Date(ms).getUTCDay();
      if (weekday === 1 || weekday === 3) expected.push(`T:${ms / 1000}`);
    }
    expect(extent).toMatchObject({ kind: "finite", count: expected.length });
    if (extent.kind !== "finite") throw new Error(extent.kind);
    expect(extent.last?.key).toBe(at("2028-10-30T07:00:00Z"));
    expect(keys(collect(o))).toEqual(expected);
  });

  it("серия длиннее предела — too-long, а не конец серии", () => {
    const o = moscow("FREQ=DAILY;COUNT=100");

    expect(seriesExtent(o, 50)).toEqual({ kind: "too-long" });
    expect(seriesExtent(o, 100)).toMatchObject({ kind: "finite", count: 100 });
  });

  it("предел по умолчанию — 200 000 слотов", () => {
    expect(seriesExtent(moscow("FREQ=HOURLY;COUNT=200001"))).toEqual({ kind: "too-long" });
  }, 60_000);
});

describe("DTSTART в 1990 году: пояс — из описания в объекте, а не из базы", () => {
  const text = calendar(MOSCOW_1990, ["DTSTART;TZID=Europe/Moscow:19900604T100000", "DURATION:PT1H",
    "RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20261019T070000Z", "SUMMARY:С девяностого"]);
  const weeks = (Date.UTC(2026, 9, 19) - Date.UTC(1990, 5, 4)) / (7 * 86_400_000);

  it("первый слот — по летнему времени 1990 года (+04), последний — по нынешнему (+03)", () => {
    const o = load(text);
    const extent = seriesExtent(o);

    expect(firstSlot(o)?.key).toBe(at("1990-06-04T06:00:00Z"));
    expect(findSlot(o, at("1990-10-01T07:00:00Z"))).toBeDefined(); // после 30.09.1990 — снова +03
    expect(extent).toMatchObject({ kind: "finite", count: weeks + 1 });
    if (extent.kind !== "finite") throw new Error(extent.kind);
    expect(extent.last?.key).toBe(at("2026-10-19T07:00:00Z"));
    expect(positionsBefore(o, at("2026-10-19T07:00:00Z"))).toBe(weeks);
  });

  it("lastSlotUpTo находит последнюю встречу под UNTIL без горизонта", () => {
    const o = load(text);
    const until = ICAL.Time.fromDateTimeString("2026-10-19T07:00:00Z");

    const last = lastSlotUpTo(o, until);
    expect(last.kind).toBe("slot");
    if (last.kind === "slot") expect(last.slot.key).toBe(at("2026-10-19T07:00:00Z"));
  });
});

describe("isEmpty (Р3): полным проходом, без горизонта", () => {
  it("YEARLY;INTERVAL=2 после удаления ближайшей встречи не пуст — следующая через два года", () => {
    const o = moscow("FREQ=YEARLY;INTERVAL=2", "EXDATE;TZID=Europe/Moscow:20261019T100000");

    expect(isEmpty(o)).toBe(false);
  });

  it("YEARLY с 29 февраля после удаления ближайшей не пуст — следующая через четыре года", () => {
    const infinite = moscow("FREQ=YEARLY", "DTSTART;TZID=Europe/Moscow:20280229T100000",
      "EXDATE;TZID=Europe/Moscow:20280229T100000");
    const finite = moscow("FREQ=YEARLY;COUNT=2", "DTSTART;TZID=Europe/Moscow:20280229T100000",
      "EXDATE;TZID=Europe/Moscow:20280229T100000");

    expect(isEmpty(infinite)).toBe(false);
    expect(isEmpty(finite)).toBe(false);
  });

  it("конечная серия, у которой закрыты все слоты, пуста", () => {
    const finite = moscow("FREQ=YEARLY;COUNT=2", "DTSTART;TZID=Europe/Moscow:20280229T100000",
      "EXDATE;TZID=Europe/Moscow:20280229T100000", "EXDATE;TZID=Europe/Moscow:20320229T100000");
    const all = moscow("FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6",
      ...WEEKLY_KEYS.map((key) => `EXDATE:${new Date(Number(key.slice(2)) * 1000).toISOString().replace(/[-:]|\.000/g, "")}`));

    expect(isEmpty(finite)).toBe(true);
    expect(isEmpty(all)).toBe(true);
  });

  it("бесконечная серия с закрытыми первыми встречами не пуста", () => {
    expect(isEmpty(moscow("FREQ=DAILY", "EXDATE;TZID=Europe/Moscow:20261019T100000,20261020T100000"))).toBe(false);
  });

  it("серия длиннее предела считается непустой", () => {
    const o = moscow("FREQ=DAILY;COUNT=100", "EXDATE;TZID=Europe/Moscow:20261019T100000,20261020T100000,20261021T100000");

    expect(isEmpty(o, 2)).toBe(false);
  });

  it("живое оторванное переопределение делает объект непустым, скрытое — нет", () => {
    const allExcluded = [...WEEKLY_KEYS.map((key) => `EXDATE:${new Date(Number(key.slice(2)) * 1000).toISOString().replace(/[-:]|\.000/g, "")}`)];
    const detached = load(calendar(MOSCOW,
      ["DTSTART;TZID=Europe/Moscow:20261019T100000", "DURATION:PT1H", "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6", ...allExcluded],
      ["RECURRENCE-ID;TZID=Europe/Moscow:20261020T100000", "DTSTART;TZID=Europe/Moscow:20261020T120000", "DURATION:PT1H"]));
    const hidden = load(calendar(MOSCOW,
      ["DTSTART;TZID=Europe/Moscow:20261019T100000", "DURATION:PT1H", "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6", ...allExcluded],
      ["RECURRENCE-ID;TZID=Europe/Moscow:20261021T100000", "DTSTART;TZID=Europe/Moscow:20261021T150000", "DURATION:PT1H"]));

    expect(isEmpty(detached)).toBe(false);
    expect(isEmpty(hidden)).toBe(true);
  });
});

describe("lastSlotUpTo: последний слот не позже момента, проходом правила", () => {
  it("UNTIL в UTC — последняя позиция под ним, даже закрытая EXDATE", () => {
    const o = moscow("FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20281030T070000Z", "EXDATE;TZID=Europe/Moscow:20281030T100000");
    const until = (o.master!.getFirstPropertyValue("rrule") as ICAL.Recur).until!;

    const last = lastSlotUpTo(o, until);
    expect(last.kind).toBe("slot");
    if (last.kind === "slot") expect(last.slot).toMatchObject({ key: at("2028-10-30T07:00:00Z"), excluded: true });
  });

  it("момент между слотами — предыдущий слот; ключ тоже принимается", () => {
    const last = lastSlotUpTo(weekly(), at("2026-10-27T00:00:00Z"));

    expect(last.kind === "slot" && last.slot.key).toBe(WEEKLY_KEYS[2]);
  });

  it("RDATE после последней позиции не считается: UNTIL ограничивает правило", () => {
    const o = moscow("FREQ=WEEKLY;BYDAY=MO;COUNT=2", "RDATE;TZID=Europe/Moscow:20261028T100000");

    const last = lastSlotUpTo(o, at("2026-11-30T00:00:00Z"));
    expect(last.kind === "slot" && last.slot.key).toBe(at("2026-10-26T07:00:00Z"));
  });

  it("раньше DTSTART — none; дальше предела — too-far", () => {
    expect(lastSlotUpTo(weekly(), at("2026-10-01T00:00:00Z"))).toEqual({ kind: "none" });
    expect(lastSlotUpTo(moscow("FREQ=DAILY"), at("2027-10-01T00:00:00Z"), 100)).toEqual({ kind: "too-far" });
  });
});

describe("positionsBefore: позиции правила до слота, EXDATE и RDATE не влияют", () => {
  it("позиции weeklyMoscow", () => {
    const o = weekly();

    expect(positionsBefore(o, WEEKLY_KEYS[0])).toBe(0);
    expect(positionsBefore(o, WEEKLY_KEYS[2])).toBe(2);
    expect(positionsBefore(o, at("2026-12-01T00:00:00Z"))).toBe(6);
  });

  it("EXDATE и RDATE позиций не меняют; DTSTART вне правила — не позиция", () => {
    const withLists = moscow("FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6", "EXDATE;TZID=Europe/Moscow:20261021T100000",
      "RDATE;TZID=Europe/Moscow:20261022T100000");
    const unsynced = moscow("FREQ=WEEKLY;BYDAY=MO,WE;COUNT=4", "DTSTART;TZID=Europe/Moscow:20261020T100000");

    expect(positionsBefore(withLists, WEEKLY_KEYS[2])).toBe(2);
    expect(positionsBefore(unsynced, at("2026-10-26T07:00:00Z"))).toBe(1);
  });

  it("серия без RRULE — ноль позиций; предел — SlotScanError", () => {
    expect(positionsBefore(load(seeds.singleMoscow.ics), at("2027-01-01T00:00:00Z"))).toBe(0);
    expect(() => positionsBefore(moscow("FREQ=DAILY"), at("2027-10-01T00:00:00Z"), 100)).toThrow(SlotScanError);
  });
});

describe("sameTail: хвост исходной серии совпадает с продолжением", () => {
  const original = weekly(); // Пн и Ср 10:00 с 19.10, COUNT=6
  const B = WEEKLY_KEYS[2]; // 26.10
  const identity = (key: SlotKey) => key;
  const plusHour = (key: SlotKey): SlotKey => `T:${Number(key.slice(2)) + 3600}`;

  it("продолжение с B и остатком COUNT совпадает; со сдвигом на час — через отображение", () => {
    const continuation = moscow("FREQ=WEEKLY;BYDAY=MO,WE;COUNT=4", "DTSTART;TZID=Europe/Moscow:20261026T100000");
    const shifted = moscow("FREQ=WEEKLY;BYDAY=MO,WE;COUNT=4", "DTSTART;TZID=Europe/Moscow:20261026T110000");

    expect(sameTail(original, B, continuation, identity)).toEqual({ same: true, compared: 4 });
    expect(sameTail(original, B, shifted, plusHour)).toEqual({ same: true, compared: 4 });
    expect(sameTail(original, B, shifted, identity).same).toBe(false);
  });

  it("продолжение короче, длиннее или с другой EXDATE — не совпадает", () => {
    const shorter = moscow("FREQ=WEEKLY;BYDAY=MO,WE;COUNT=3", "DTSTART;TZID=Europe/Moscow:20261026T100000");
    const longer = moscow("FREQ=WEEKLY;BYDAY=MO,WE;COUNT=5", "DTSTART;TZID=Europe/Moscow:20261026T100000");
    const excluded = moscow("FREQ=WEEKLY;BYDAY=MO,WE;COUNT=4", "DTSTART;TZID=Europe/Moscow:20261026T100000",
      "EXDATE;TZID=Europe/Moscow:20261102T100000");
    const earlier = moscow("FREQ=WEEKLY;BYDAY=MO,WE;COUNT=5", "DTSTART;TZID=Europe/Moscow:20261021T100000");

    for (const other of [shorter, longer, excluded, earlier]) {
      expect(sameTail(original, B, other, identity).same).toBe(false);
    }
  });

  it("бесконечная серия сравнивается на 500 слотах", () => {
    const daily = moscow("FREQ=DAILY");
    const from = at("2026-10-20T07:00:00Z");
    const tail = (count: number) => moscow(`FREQ=DAILY;COUNT=${count}`, "DTSTART;TZID=Europe/Moscow:20261020T100000");

    expect(sameTail(daily, from, tail(500), identity)).toEqual({ same: true, compared: 500 });
    expect(sameTail(daily, from, tail(499), identity).same).toBe(false);
    expect(sameTail(daily, from, moscow("FREQ=DAILY;INTERVAL=2", "DTSTART;TZID=Europe/Moscow:20261020T100000"), identity).same)
      .toBe(false);
  });

  it("окно — пять лет, у YEARLY — двадцать", () => {
    const weeklyInfinite = moscow("FREQ=WEEKLY;BYDAY=MO");
    const fiveYears = moscow("FREQ=WEEKLY;BYDAY=MO;UNTIL=20311020T000000Z");
    const fourYears = moscow("FREQ=WEEKLY;BYDAY=MO;UNTIL=20301020T000000Z");
    const yearly = moscow("FREQ=YEARLY");

    expect(sameTail(weeklyInfinite, WEEKLY_KEYS[0], fiveYears, identity).same).toBe(true);
    expect(sameTail(weeklyInfinite, WEEKLY_KEYS[0], fourYears, identity).same).toBe(false);
    expect(sameTail(yearly, WEEKLY_KEYS[0], moscow("FREQ=YEARLY;COUNT=21"), identity)).toEqual({ same: true, compared: 21 });
    expect(sameTail(yearly, WEEKLY_KEYS[0], moscow("FREQ=YEARLY;COUNT=19"), identity).same).toBe(false);
  });

  it("явный предел заменяет умолчания", () => {
    const daily = moscow("FREQ=DAILY");

    expect(sameTail(daily, WEEKLY_KEYS[0], moscow("FREQ=DAILY;COUNT=10"), identity, { slots: 10 }))
      .toEqual({ same: true, compared: 10 });
  });
});
