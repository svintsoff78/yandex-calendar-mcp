import ICAL from "ical.js";
import { describe, expect, it } from "vitest";
import { registerTimeZone } from "../../src/ical/timezones.js";
import {
  ModelTimeError,
  addListValue,
  compareSlotKeys,
  formOf,
  formatForModel,
  instantOf,
  listEntries,
  listKeys,
  parseModelTime,
  removeListValues,
  ruleDict,
  setRuleDict,
  setTimeProperty,
  slotKeyOf,
  timeInForm,
  untilBefore,
  wallDateOf,
  type IcalEnv,
  type SlotKey,
  type TimeForm,
} from "../../src/ical/values.js";

// Все ожидаемые моменты заданы через Date.UTC и строки со смещением, поэтому
// тесты дают один результат при любом поясе процесса (TZ=UTC, Europe/Moscow,
// America/New_York).

for (const tzid of ["Europe/Moscow", "Europe/Berlin", "America/New_York", "Asia/Kolkata"]) {
  registerTimeZone(tzid);
}

const moscowEnv: IcalEnv = { floatingZone: "Europe/Moscow" };
const newYorkEnv: IcalEnv = { floatingZone: "America/New_York" };
const CRLF = "\r\n";

function vevent(...lines: string[]): ICAL.Component {
  const ics = ["BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", "UID:values", ...lines,
    "END:VEVENT", "END:VCALENDAR"].join(CRLF);
  return new ICAL.Component(ICAL.parse(ics)).getFirstSubcomponent("vevent")!;
}

function zoned(tzid: string, year: number, month: number, day: number, hour: number, minute = 0, second = 0) {
  return ICAL.Time.fromData({ year, month, day, hour, minute, second, isDate: false }, registerTimeZone(tzid));
}
function utc(year: number, month: number, day: number, hour: number, minute = 0, second = 0) {
  return ICAL.Time.fromData({ year, month, day, hour, minute, second, isDate: false }, ICAL.Timezone.utcTimezone);
}
function floating(year: number, month: number, day: number, hour: number, minute = 0, second = 0) {
  return ICAL.Time.fromData({ year, month, day, hour, minute, second, isDate: false });
}
function date(year: number, month: number, day: number) {
  return ICAL.Time.fromData({ year, month, day, isDate: true });
}
const T = (iso: string): SlotKey => `T:${Date.parse(iso) / 1000}`;

describe("formOf", () => {
  it("определяет форму свойства по записи: DATE, UTC, TZID, плавающее", () => {
    const e = vevent("DTSTART;VALUE=DATE:20261021", "DTEND:20261021T070000Z",
      "RECURRENCE-ID;TZID=Europe/Moscow:20261021T100000", "DUE:20261021T100000");

    expect(formOf(e.getFirstProperty("dtstart")!)).toBe("date");
    expect(formOf(e.getFirstProperty("dtend")!)).toBe("utc");
    expect(formOf(e.getFirstProperty("recurrence-id")!)).toBe("zoned");
    expect(formOf(e.getFirstProperty("due")!)).toBe("floating");
  });

  it("у свойства с неизвестным TZID форма по записи — zoned, по разобранному значению — floating", () => {
    const property = vevent("DTSTART;TZID=Nowhere/Zone:20261021T100000").getFirstProperty("dtstart")!;

    expect(formOf(property)).toBe("zoned");
    expect(formOf(property.getFirstValue() as ICAL.Time)).toBe("floating");
  });

  it("у RDATE;VALUE=PERIOD форма — по началу периода", () => {
    const property = vevent("DTSTART;TZID=Europe/Moscow:20261019T100000",
      "RDATE;VALUE=PERIOD;TZID=Europe/Moscow:20261022T100000/PT1H").getFirstProperty("rdate")!;

    expect(formOf(property)).toBe("zoned");
  });

  it("определяет форму значения ICAL.Time", () => {
    expect(formOf(date(2026, 10, 21))).toBe("date");
    expect(formOf(utc(2026, 10, 21, 7))).toBe("utc");
    expect(formOf(zoned("Europe/Moscow", 2026, 10, 21, 10))).toBe("zoned");
    expect(formOf(floating(2026, 10, 21, 10))).toBe("floating");
  });
});

describe("instantOf", () => {
  it("даёт момент в миллисекундах для времени с поясом и в UTC", () => {
    expect(instantOf(zoned("Europe/Moscow", 2026, 10, 21, 10), moscowEnv)).toBe(Date.UTC(2026, 9, 21, 7));
    expect(instantOf(utc(2026, 10, 21, 7), newYorkEnv)).toBe(Date.UTC(2026, 9, 21, 7));
  });

  it("учитывает переход на зимнее время в поясе значения", () => {
    expect(instantOf(zoned("Europe/Berlin", 2026, 10, 20, 10), moscowEnv)).toBe(Date.UTC(2026, 9, 20, 8));
    expect(instantOf(zoned("Europe/Berlin", 2026, 11, 3, 10), moscowEnv)).toBe(Date.UTC(2026, 10, 3, 9));
  });

  it("плавающее время читает в поясе календаря, а не процесса", () => {
    expect(instantOf(floating(2026, 10, 21, 10), moscowEnv)).toBe(Date.UTC(2026, 9, 21, 7));
    expect(instantOf(floating(2026, 10, 21, 10), newYorkEnv)).toBe(Date.UTC(2026, 9, 21, 14));
  });

  it("дату читает как полночь в поясе календаря", () => {
    expect(instantOf(date(2026, 10, 21), moscowEnv)).toBe(Date.UTC(2026, 9, 20, 21));
    expect(instantOf(date(2026, 10, 21), newYorkEnv)).toBe(Date.UTC(2026, 9, 21, 4));
  });

  it("не меняет переданное значение", () => {
    const value = floating(2026, 10, 21, 10);
    instantOf(value, moscowEnv);

    expect(value.zone).toBe(ICAL.Timezone.localTimezone);
    expect(value.toString()).toBe("2026-10-21T10:00:00");
  });
});

describe("slotKeyOf (О3)", () => {
  it("серия на весь день: D: и дата; у унаследованного DATE-TIME — буквальная дата записи", () => {
    expect(slotKeyOf(date(2026, 10, 21), "date", moscowEnv)).toBe("D:2026-10-21");
    expect(slotKeyOf(utc(2026, 10, 21, 0), "date", moscowEnv)).toBe("D:2026-10-21");
    expect(slotKeyOf(utc(2026, 10, 20, 21), "date", moscowEnv)).toBe("D:2026-10-20");
    expect(slotKeyOf(zoned("America/New_York", 2026, 10, 21, 0), "date", moscowEnv)).toBe("D:2026-10-21");
  });

  it("серия с TZID или в UTC: T: и момент; RID в чужом TZID сопоставляется по моменту", () => {
    const key = T("2026-10-21T07:00:00Z");

    expect(slotKeyOf(zoned("Europe/Moscow", 2026, 10, 21, 10), "zoned", moscowEnv)).toBe(key);
    expect(slotKeyOf(utc(2026, 10, 21, 7), "zoned", moscowEnv)).toBe(key);
    expect(slotKeyOf(zoned("Europe/Berlin", 2026, 10, 21, 9), "zoned", moscowEnv)).toBe(key);
    expect(slotKeyOf(zoned("Europe/Moscow", 2026, 10, 21, 10), "utc", newYorkEnv)).toBe(key);
  });

  it("плавающая серия: F: и стенное время; значение с поясом — стенное время в поясе календаря", () => {
    expect(slotKeyOf(floating(2026, 10, 21, 10), "floating", moscowEnv)).toBe("F:2026-10-21T10:00:00");
    expect(slotKeyOf(floating(2026, 10, 21, 10), "floating", newYorkEnv)).toBe("F:2026-10-21T10:00:00");
    expect(slotKeyOf(utc(2026, 10, 21, 7), "floating", moscowEnv)).toBe("F:2026-10-21T10:00:00");
    expect(slotKeyOf(date(2026, 10, 21), "floating", moscowEnv)).toBe("F:2026-10-21T00:00:00");
  });
});

describe("compareSlotKeys", () => {
  it("сравнивает D: и F: как строки, T: — как числа", () => {
    expect((["D:2026-10-26", "D:2026-10-21", "D:2027-01-01"] as SlotKey[]).sort(compareSlotKeys))
      .toEqual(["D:2026-10-21", "D:2026-10-26", "D:2027-01-01"]);
    expect((["T:1000", "T:999", "T:-5"] as SlotKey[]).sort(compareSlotKeys)).toEqual(["T:-5", "T:999", "T:1000"]);
    expect(compareSlotKeys("F:2026-10-21T10:00:00", "F:2026-10-21T09:30:00")).toBeGreaterThan(0);
    expect(compareSlotKeys("T:5", "T:5")).toBe(0);
  });
});

describe("wallDateOf", () => {
  it("без пояса — дата записи значения", () => {
    expect(wallDateOf(date(2026, 10, 21), moscowEnv)).toBe("2026-10-21");
    expect(wallDateOf(zoned("Europe/Moscow", 2026, 10, 21, 0, 30), moscowEnv)).toBe("2026-10-21");
    expect(wallDateOf(utc(2026, 10, 20, 21, 30), moscowEnv)).toBe("2026-10-20");
    expect(wallDateOf(floating(2026, 10, 21, 23, 30), newYorkEnv)).toBe("2026-10-21");
  });

  it("с поясом — дата момента в этом поясе; дата остаётся буквальной", () => {
    expect(wallDateOf(utc(2026, 10, 20, 21, 30), moscowEnv, "Europe/Moscow")).toBe("2026-10-21");
    expect(wallDateOf(zoned("Europe/Moscow", 2026, 10, 21, 2), moscowEnv, "America/New_York")).toBe("2026-10-20");
    expect(wallDateOf(floating(2026, 10, 21, 2), moscowEnv, "America/New_York")).toBe("2026-10-20");
    expect(wallDateOf(date(2026, 10, 21), moscowEnv, "America/New_York")).toBe("2026-10-21");
  });
});

describe("parseModelTime", () => {
  it("YYYY-MM-DD — дата", () => {
    const parsed = parseModelTime("2026-10-21", "Europe/Moscow");

    expect(parsed.kind).toBe("date");
    expect(parsed.date).toBe("2026-10-21");
    expect(parsed.time.isDate).toBe(true);
    expect(parsed.time.toString()).toBe("2026-10-21");
  });

  it("ISO со смещением или Z — момент", () => {
    const moscow = parseModelTime("2026-10-21T10:00:00+03:00", "America/New_York");
    expect(moscow.kind).toBe("instant");
    if (moscow.kind !== "instant") throw new Error("ожидался момент");
    expect(moscow.ms).toBe(Date.UTC(2026, 9, 21, 7));
    expect(moscow.offsetSeconds).toBe(3 * 3600);
    expect(moscow.wall).toEqual({ year: 2026, month: 10, day: 21, hour: 10, minute: 0, second: 0 });
    expect(moscow.date).toBe("2026-10-21");
    expect(moscow.time.toString()).toBe("2026-10-21T07:00:00Z");

    const zulu = parseModelTime("2026-10-21T07:00:00Z");
    expect(zulu.kind === "instant" && zulu.ms).toBe(Date.UTC(2026, 9, 21, 7));
  });

  it("принимает время без секунд, дробные секунды и смещение без двоеточия", () => {
    const noSeconds = parseModelTime("2026-10-22T11:00+03:00");
    expect(noSeconds.kind === "instant" && noSeconds.ms).toBe(Date.UTC(2026, 9, 22, 8));
    const fraction = parseModelTime("2026-10-21T07:00:00.000Z");
    expect(fraction.kind === "instant" && fraction.ms).toBe(Date.UTC(2026, 9, 21, 7));
    const compact = parseModelTime("2026-10-21T10:00:00-0400");
    expect(compact.kind === "instant" && compact.offsetSeconds).toBe(-4 * 3600);
    expect(compact.kind === "instant" && compact.ms).toBe(Date.UTC(2026, 9, 21, 14));
  });

  it("ISO без смещения — стенное время в поясе события, а не процесса", () => {
    const berlin = parseModelTime("2026-10-21T10:00:00", "Europe/Berlin");
    expect(berlin.kind).toBe("wall");
    expect(berlin.time.zone!.tzid).toBe("Europe/Berlin");
    expect(berlin.time.toString()).toBe("2026-10-21T10:00:00");
    expect(instantOf(berlin.time, moscowEnv)).toBe(Date.UTC(2026, 9, 21, 8));

    const bare = parseModelTime("2026-10-21T10:00:00");
    expect(bare.kind).toBe("wall");
    expect(bare.time.zone).toBe(ICAL.Timezone.localTimezone);
    expect(instantOf(bare.time, newYorkEnv)).toBe(Date.UTC(2026, 9, 21, 14));
  });

  it("принимает пояс-объект ICAL.Timezone", () => {
    const zone = registerTimeZone("Asia/Kolkata");
    const parsed = parseModelTime("2026-10-21T10:00:00", zone);

    expect(parsed.time.zone).toBe(zone);
    expect(instantOf(parsed.time, moscowEnv)).toBe(Date.UTC(2026, 9, 21, 4, 30));
  });

  it("29 февраля — только в високосный год", () => {
    expect(parseModelTime("2028-02-29").date).toBe("2028-02-29");
    expect(() => parseModelTime("2027-02-29")).toThrow(ModelTimeError);
  });

  it.each([
    "", "2026-13-01", "2026-02-30", "2026-10-21T25:00:00", "2026-10-21T10:60:00Z", "2026-10-21T10:00:60Z",
    "21.10.2026", "2026-10-21T10:00:00+03:00 x", "2026-10-21 10:00:00", "2026-1-21", "20261021T100000Z",
    "2026-10-21T10:00:00+25:00", "2026-10-21T10", "2026-10-21T",
  ])("отвергает %j", (input) => {
    expect(() => parseModelTime(input, "Europe/Moscow")).toThrow(ModelTimeError);
  });
});

describe("timeInForm (О4)", () => {
  it("в форму DATE — буквальная дата записи", () => {
    const fromZoned = timeInForm(zoned("Europe/Moscow", 2026, 10, 21, 10), "date", undefined, moscowEnv);
    expect(fromZoned.isDate).toBe(true);
    expect(fromZoned.toString()).toBe("2026-10-21");
    expect(timeInForm(utc(2026, 10, 21, 0), "date", undefined, moscowEnv).toString()).toBe("2026-10-21");
  });

  it("в форму с TZID — тот же момент в стенном времени этого пояса", () => {
    const moved = timeInForm(utc(2026, 10, 21, 7), "zoned", "Europe/Moscow", moscowEnv);
    expect(moved.zone!.tzid).toBe("Europe/Moscow");
    expect(moved.toString()).toBe("2026-10-21T10:00:00");

    expect(timeInForm(zoned("Europe/Moscow", 2026, 10, 21, 10), "zoned", "Europe/Berlin", moscowEnv).toString())
      .toBe("2026-10-21T09:00:00");
    expect(timeInForm(floating(2026, 10, 21, 10), "zoned", "Europe/Berlin", moscowEnv).toString())
      .toBe("2026-10-21T09:00:00");
  });

  it("в форму с TZID при том же TZID сохраняет стенное время и берёт переданный пояс-объект", () => {
    const own = new ICAL.Timezone({ component: registerTimeZone("Europe/Moscow").component, tzid: "Europe/Moscow" });
    const moved = timeInForm(zoned("Europe/Moscow", 2026, 10, 21, 10), "zoned", own, moscowEnv);

    expect(moved.zone).toBe(own);
    expect(moved.toString()).toBe("2026-10-21T10:00:00");
  });

  it("в форму UTC — момент с Z; плавающее — через пояс календаря", () => {
    expect(timeInForm(zoned("Europe/Moscow", 2026, 10, 21, 10), "utc", undefined, moscowEnv).toString())
      .toBe("2026-10-21T07:00:00Z");
    expect(timeInForm(floating(2026, 10, 21, 10), "utc", undefined, newYorkEnv).toString())
      .toBe("2026-10-21T14:00:00Z");
  });

  it("в плавающую форму — стенное время в поясе календаря, пояс значения — floating", () => {
    const wall = timeInForm(utc(2026, 10, 21, 7), "floating", undefined, moscowEnv);
    expect(wall.zone).toBe(ICAL.Timezone.localTimezone);
    expect(wall.toString()).toBe("2026-10-21T10:00:00");
    expect(timeInForm(date(2026, 10, 21), "floating", undefined, moscowEnv).toString()).toBe("2026-10-21T00:00:00");
  });

  it("у перехода часов выбирает стенное время, которое ical.js читает обратно в тот же момент", () => {
    // Весна: 01:00Z = 03:00 CEST (convertToZone из UTC дал бы несуществующее 02:00).
    const spring = timeInForm(utc(2026, 3, 29, 1), "zoned", "Europe/Berlin", moscowEnv);
    expect(spring.toString()).toBe("2026-03-29T03:00:00");
    expect(instantOf(spring, moscowEnv)).toBe(Date.UTC(2026, 2, 29, 1));

    // Осень: 01:00Z = 02:00 CET, второе вхождение повторного часа (convertToZone дал бы 03:00).
    const autumn = timeInForm(utc(2026, 10, 25, 1), "zoned", "Europe/Berlin", moscowEnv);
    expect(autumn.toString()).toBe("2026-10-25T02:00:00");
    expect(instantOf(autumn, moscowEnv)).toBe(Date.UTC(2026, 9, 25, 1));
  });

  it("сохраняет момент на всём протяжении дней перехода, кроме первого вхождения повторного часа", () => {
    const lost: string[] = [];
    for (const [month, day] of [[3, 29], [10, 25]]) {
      for (let minutes = -120; minutes < 24 * 60; minutes += 30) {
        const source = utc(2026, month, day, 0);
        source.adjust(0, 0, minutes, 0);
        const wall = timeInForm(source, "zoned", "Europe/Berlin", moscowEnv);
        if (instantOf(wall, moscowEnv) !== instantOf(source, moscowEnv)) lost.push(source.toString());
      }
    }
    // 02:00–02:59 CEST 25.10 ical.js в стенном времени с TZID не выражает:
    // неоднозначное время он читает как второе вхождение (CET).
    expect(lost).toEqual(["2026-10-25T00:00:00Z", "2026-10-25T00:30:00Z"]);
  });

  it("форма zoned без пояса — ошибка", () => {
    expect(() => timeInForm(utc(2026, 10, 21, 7), "zoned", undefined, moscowEnv)).toThrow();
  });

  it("возвращает новый объект и не трогает исходный", () => {
    const source = zoned("Europe/Moscow", 2026, 10, 21, 10);
    const result = timeInForm(source, "zoned", "Europe/Moscow", moscowEnv);
    result.hour = 12;

    expect(source.hour).toBe(10);
  });

  it("сохраняет ключ слота при любом переводе в форму серии", () => {
    const values = [zoned("Europe/Moscow", 2026, 10, 21, 10), zoned("Europe/Berlin", 2026, 11, 3, 10),
      utc(2026, 10, 20, 21, 30), floating(2026, 10, 21, 10), date(2026, 10, 21)];
    const forms: Array<[TimeForm, string | undefined]> =
      [["date", undefined], ["utc", undefined], ["zoned", "Europe/Moscow"], ["zoned", "America/New_York"],
        ["floating", undefined]];

    for (const env of [moscowEnv, newYorkEnv]) {
      for (const value of values) {
        for (const [form, tzid] of forms) {
          const converted = timeInForm(value, form, tzid, env);
          expect(formOf(converted)).toBe(form);
          expect(slotKeyOf(converted, form, env)).toBe(slotKeyOf(value, form, env));
        }
      }
    }
  });
});

describe("untilBefore", () => {
  it("DATE: накануне границы", () => {
    expect(untilBefore(date(2026, 10, 26), "date")).toBe("2026-10-25");
    expect(untilBefore(date(2028, 3, 1), "date")).toBe("2028-02-29");
    expect(untilBefore(date(2027, 1, 1), "date")).toBe("2026-12-31");
  });

  it("TZID и UTC: момент на секунду раньше границы, в UTC", () => {
    expect(untilBefore(zoned("Europe/Moscow", 2026, 10, 26, 10), "zoned")).toBe("2026-10-26T06:59:59Z");
    expect(untilBefore(utc(2026, 10, 26, 7), "utc")).toBe("2026-10-26T06:59:59Z");
    expect(untilBefore(zoned("Europe/Berlin", 2026, 10, 26, 0), "zoned")).toBe("2026-10-25T22:59:59Z");
  });

  it("плавающее: стенное время на секунду раньше, без Z", () => {
    expect(untilBefore(floating(2026, 10, 26, 10), "floating")).toBe("2026-10-26T09:59:59");
    expect(untilBefore(floating(2027, 1, 1, 0), "floating")).toBe("2026-12-31T23:59:59");
  });

  it("отказывается считать момент по плавающей границе в форме с поясом", () => {
    expect(() => untilBefore(floating(2026, 10, 26, 10), "zoned")).toThrow();
    expect(() => untilBefore(date(2026, 10, 26), "utc")).toThrow();
  });

  it.each([
    ["zoned", "DTSTART;TZID=Europe/Moscow:20261019T100000", () => zoned("Europe/Moscow", 2026, 10, 26, 10),
      "UNTIL=20261026T065959Z", ["2026-10-19T10:00:00", "2026-10-21T10:00:00"]],
    ["date", "DTSTART;VALUE=DATE:20261019", () => date(2026, 10, 26),
      "UNTIL=20261025", ["2026-10-19", "2026-10-21"]],
    ["floating", "DTSTART:20261019T100000", () => floating(2026, 10, 26, 10),
      "UNTIL=20261026T095959", ["2026-10-19T10:00:00", "2026-10-21T10:00:00"]],
  ] as const)("форма %s: правило с таким UNTIL кончается перед границей", (form, dtstartLine, boundary, text, slots) => {
    const e = vevent(dtstartLine, "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6");
    const rrule = e.getFirstProperty("rrule")!;
    const dict = ruleDict(rrule);
    delete dict.count;
    dict.until = untilBefore(boundary(), form);
    setRuleDict(rrule, dict);

    expect(rrule.toICALString()).toBe(`RRULE:FREQ=WEEKLY;BYDAY=MO,WE;${text}`);
    const iterator = (rrule.getFirstValue() as ICAL.Recur).iterator(e.getFirstPropertyValue("dtstart") as ICAL.Time);
    const seen: string[] = [];
    for (let t = iterator.next(); t && seen.length < 10; t = iterator.next()) seen.push(t.toString());
    expect(seen).toEqual(slots);
  });
});

describe("ruleDict и setRuleDict", () => {
  const RULE = "FREQ=MONTHLY;INTERVAL=1;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;WKST=SU;RSCALE=GREGORIAN;X-YCM=keep";

  it("ruleDict отдаёт живой jCal-словарь свойства", () => {
    const rrule = vevent("DTSTART:20261030T140000Z", `RRULE:${RULE}`).getFirstProperty("rrule")!;

    expect(ruleDict(rrule)).toBe(rrule.jCal[3]);
    expect(ruleDict(rrule)).toMatchObject({ freq: "MONTHLY", bysetpos: -1, rscale: "GREGORIAN", "x-ycm": "keep" });
  });

  it("setRuleDict меняет только названные части, порядок и неизвестные части целы, кеш значения сброшен", () => {
    const rrule = vevent("DTSTART:20261030T140000Z", `RRULE:${RULE}`).getFirstProperty("rrule")!;
    const before = rrule.getFirstValue() as ICAL.Recur;
    const dict = ruleDict(rrule);
    dict.count = 3;
    setRuleDict(rrule, dict);

    expect(rrule.toICALString()).toBe(`RRULE:${RULE};COUNT=3`);
    const after = rrule.getFirstValue() as ICAL.Recur;
    expect(after).not.toBe(before);
    expect(after.count).toBe(3);
  });

  it("setRuleDict снимает части со значением null или undefined", () => {
    const rrule = vevent("DTSTART:20261019T070000Z", "RRULE:FREQ=DAILY;COUNT=10;INTERVAL=2")
      .getFirstProperty("rrule")!;
    const dict = ruleDict(rrule);
    setRuleDict(rrule, { ...dict, count: null, interval: undefined, until: "2026-10-30T06:59:59Z" });

    expect(rrule.toICALString()).toBe("RRULE:FREQ=DAILY;UNTIL=20261030T065959Z");
    expect((rrule.getFirstValue() as ICAL.Recur).count).toBeNull();
  });

  it("setRuleDict приводит UNTIL-объект ICAL.Time к jCal-строке и отвергает кривую строку", () => {
    const rrule = vevent("DTSTART:20261019T070000Z", "RRULE:FREQ=DAILY").getFirstProperty("rrule")!;
    setRuleDict(rrule, { ...ruleDict(rrule), until: utc(2026, 10, 30, 6, 59, 59) });
    expect(rrule.toICALString()).toBe("RRULE:FREQ=DAILY;UNTIL=20261030T065959Z");

    expect(() => setRuleDict(rrule, { ...ruleDict(rrule), until: "20261030T065959Z" })).toThrow();
  });

  it("ruleDict отвергает свойство не типа recur", () => {
    expect(() => ruleDict(vevent("DTSTART:20261019T070000Z").getFirstProperty("dtstart")!)).toThrow();
  });
});

describe("listKeys и listEntries", () => {
  const zonedCtx = { form: "zoned" as const, env: moscowEnv };

  it("собирает ключи EXDATE всех строк и значений, дубли сохраняет", () => {
    const e = vevent("DTSTART;TZID=Europe/Moscow:20261019T100000", "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6",
      "EXDATE;TZID=Europe/Moscow:20261021T100000,20261026T100000", "EXDATE:20261021T070000Z",
      "EXDATE;TZID=Europe/Berlin:20261028T080000");

    expect(listKeys(e, "exdate", zonedCtx)).toEqual([T("2026-10-21T07:00:00Z"), T("2026-10-26T07:00:00Z"),
      T("2026-10-21T07:00:00Z"), T("2026-10-28T07:00:00Z")]);
  });

  it("у серии на весь день унаследованный DATE-TIME в EXDATE даёт ключ по буквальной дате", () => {
    const e = vevent("DTSTART;VALUE=DATE:20261019", "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6",
      "EXDATE:20261021T000000Z", "EXDATE;VALUE=DATE:20261026,20261028");

    expect(listKeys(e, "exdate", { form: "date", env: moscowEnv }))
      .toEqual(["D:2026-10-21", "D:2026-10-26", "D:2026-10-28"]);
  });

  it("у RDATE;VALUE=PERIOD отдаёт начало как ключ и конец периода", () => {
    const e = vevent("DTSTART;TZID=Europe/Moscow:20261019T100000",
      "RDATE;VALUE=PERIOD;TZID=Europe/Moscow:20261022T100000/20261022T113000,20261023T100000/PT2H");
    const entries = listEntries(e, "rdate", zonedCtx);

    expect(entries.map((entry) => entry.key)).toEqual([T("2026-10-22T07:00:00Z"), T("2026-10-23T07:00:00Z")]);
    expect(entries.map((entry) => entry.periodEnd?.toString()))
      .toEqual(["2026-10-22T11:30:00", "2026-10-23T12:00:00"]);
    expect(entries[0].property).toBe(e.getFirstProperty("rdate"));
  });

  it("отдаёт копии значений: их правка не меняет свойство", () => {
    const e = vevent("DTSTART;TZID=Europe/Moscow:20261019T100000", "EXDATE;TZID=Europe/Moscow:20261021T100000");
    const [entry] = listEntries(e, "exdate", zonedCtx);
    entry.time.hour = 12;

    expect(e.getFirstProperty("exdate")!.toICALString()).toBe("EXDATE;TZID=Europe/Moscow:20261021T100000");
    expect(listKeys(e, "exdate", zonedCtx)).toEqual([T("2026-10-21T07:00:00Z")]);
  });

  it("у компонента без свойства — пустой список", () => {
    expect(listKeys(vevent("DTSTART:20261019T070000Z"), "rdate", zonedCtx)).toEqual([]);
  });
});

describe("addListValue", () => {
  it.each([
    ["с TZID", () => zoned("Europe/Moscow", 2026, 10, 21, 10), "EXDATE;TZID=Europe/Moscow:20261021T100000"],
    ["DATE", () => date(2026, 10, 21), "EXDATE;VALUE=DATE:20261021"],
    ["UTC", () => utc(2026, 10, 21, 7), "EXDATE:20261021T070000Z"],
    ["плавающее", () => floating(2026, 10, 21, 10), "EXDATE:20261021T100000"],
  ])("пишет значение %s отдельной строкой в его форме", (_name, value, line) => {
    const e = vevent("DTSTART;TZID=Europe/Moscow:20261019T100000", "EXDATE;TZID=Europe/Moscow:20261026T100000");
    const untouched = e.getFirstProperty("exdate")!.jCal;
    const snapshot = structuredClone(untouched);

    const added = addListValue(e, "exdate", value());

    expect(added.toICALString()).toBe(line);
    expect(e.getAllProperties("exdate")).toHaveLength(2);
    expect(e.getAllProperties("exdate")[1]).toBe(added);
    expect(e.getFirstProperty("exdate")!.jCal).toBe(untouched);
    expect(untouched).toEqual(snapshot);
  });

  it("пишет период RDATE и новое свойство оказывается до подкомпонентов", () => {
    const e = vevent("DTSTART;TZID=Europe/Moscow:20261019T100000", "BEGIN:VALARM", "ACTION:DISPLAY",
      "TRIGGER:-PT15M", "END:VALARM");
    const period = new ICAL.Period({ start: zoned("Europe/Moscow", 2026, 10, 22, 10),
      end: zoned("Europe/Moscow", 2026, 10, 22, 11, 30) });

    addListValue(e, "rdate", period);
    const text = e.toString();

    // stringify.js, stringify.property: параметры выводятся до `;VALUE=`.
    expect(text).toContain("RDATE;TZID=Europe/Moscow;VALUE=PERIOD:20261022T100000/20261022T113000");
    expect(text.indexOf("RDATE")).toBeLessThan(text.indexOf("BEGIN:VALARM"));
    expect(listEntries(e, "rdate", { form: "zoned", env: moscowEnv })[0].periodEnd?.toString())
      .toBe("2026-10-22T11:30:00");
  });

  it("не держит ссылку на переданный объект", () => {
    const e = vevent("DTSTART;TZID=Europe/Moscow:20261019T100000");
    const value = zoned("Europe/Moscow", 2026, 10, 21, 10);
    const added = addListValue(e, "exdate", value);
    value.hour = 12;

    expect(added.toICALString()).toBe("EXDATE;TZID=Europe/Moscow:20261021T100000");
    expect((added.getFirstValue() as ICAL.Time).hour).toBe(10);
  });
});

describe("removeListValues", () => {
  const zonedCtx = { form: "zoned" as const, env: moscowEnv };

  it("снимает значения по множеству ключей: дубли все, прочие значения и строки не тронуты", () => {
    const e = vevent("DTSTART;TZID=Europe/Moscow:20261019T100000",
      "EXDATE;TZID=Europe/Moscow:20261021T100000,20261026T100000", "EXDATE:20261021T070000Z",
      "EXDATE;TZID=Europe/Moscow:20261102T100000");
    const third = e.getAllProperties("exdate")[2].jCal;

    const removed = removeListValues(e, "exdate", new Set([T("2026-10-21T07:00:00Z")]), zonedCtx);

    expect(removed).toEqual([T("2026-10-21T07:00:00Z"), T("2026-10-21T07:00:00Z")]);
    const lines = e.getAllProperties("exdate").map((property) => property.toICALString());
    expect(lines).toEqual(["EXDATE;TZID=Europe/Moscow:20261026T100000", "EXDATE;TZID=Europe/Moscow:20261102T100000"]);
    expect(e.getAllProperties("exdate")[1].jCal).toBe(third);
    expect(listKeys(e, "exdate", zonedCtx)).toEqual([T("2026-10-26T07:00:00Z"), T("2026-11-02T07:00:00Z")]);
  });

  it("принимает предикат и у серии на весь день снимает унаследованный DATE-TIME по дате", () => {
    const e = vevent("DTSTART;VALUE=DATE:20261019", "EXDATE:20261021T000000Z",
      "EXDATE;VALUE=DATE:20261026,20261028");

    const removed = removeListValues(e, "exdate", (key) => key !== "D:2026-10-28", { form: "date", env: moscowEnv });

    expect(removed).toEqual(["D:2026-10-21", "D:2026-10-26"]);
    expect(e.getAllProperties("exdate").map((property) => property.toICALString()))
      .toEqual(["EXDATE;VALUE=DATE:20261028"]);
  });

  it("без совпадений ничего не меняет", () => {
    const e = vevent("DTSTART;TZID=Europe/Moscow:20261019T100000", "EXDATE;TZID=Europe/Moscow:20261021T100000");
    const before = e.toString();

    expect(removeListValues(e, "exdate", new Set<SlotKey>(["T:1"]), zonedCtx)).toEqual([]);
    expect(e.toString()).toBe(before);
  });
});

describe("setTimeProperty", () => {
  it("пишет RECURRENCE-ID в форме значения: TZID, UTC, DATE", () => {
    const e = vevent("DTSTART;TZID=Europe/Moscow:20261019T100000");

    expect(setTimeProperty(e, "recurrence-id", zoned("Europe/Moscow", 2026, 10, 21, 10)).toICALString())
      .toBe("RECURRENCE-ID;TZID=Europe/Moscow:20261021T100000");
    expect(setTimeProperty(e, "recurrence-id", utc(2026, 10, 21, 7)).toICALString())
      .toBe("RECURRENCE-ID:20261021T070000Z");
    expect(setTimeProperty(e, "recurrence-id", date(2026, 10, 21)).toICALString())
      .toBe("RECURRENCE-ID;VALUE=DATE:20261021");
    expect(e.getAllProperties("recurrence-id")).toHaveLength(1);
  });

  it("правит имеющееся свойство на месте, прочие параметры сохраняет", () => {
    const e = vevent("DTSTART;X-KEEP=yes;TZID=Europe/Moscow:20261019T100000", "SUMMARY:Встреча");
    const property = e.getFirstProperty("dtstart")!;

    const result = setTimeProperty(e, "dtstart", floating(2026, 10, 20, 9, 30));

    expect(result).toBe(property);
    expect(property.toICALString()).toBe("DTSTART;X-KEEP=yes:20261020T093000");
    expect((property.getFirstValue() as ICAL.Time).toString()).toBe("2026-10-20T09:30:00");
  });
});

describe("formatForModel (Р10)", () => {
  it("время с поясом — ISO со смещением пояса значения, в том числе через переход", () => {
    expect(formatForModel(zoned("Europe/Moscow", 2026, 10, 21, 10), moscowEnv, "time"))
      .toBe("2026-10-21T10:00:00+03:00");
    expect(formatForModel(zoned("Europe/Berlin", 2026, 11, 3, 10), moscowEnv, "instance"))
      .toBe("2026-11-03T10:00:00+01:00");
    expect(formatForModel(zoned("Asia/Kolkata", 2026, 10, 21, 10), moscowEnv, "time"))
      .toBe("2026-10-21T10:00:00+05:30");
  });

  it("UTC — со смещением +00:00", () => {
    expect(formatForModel(utc(2026, 10, 21, 7), moscowEnv, "instance")).toBe("2026-10-21T07:00:00+00:00");
  });

  it("плавающее — со смещением пояса календаря, не процесса", () => {
    expect(formatForModel(floating(2026, 10, 21, 10), moscowEnv, "time")).toBe("2026-10-21T10:00:00+03:00");
    expect(formatForModel(floating(2026, 10, 21, 10), newYorkEnv, "instance")).toBe("2026-10-21T10:00:00-04:00");
  });

  it("дата: instanceStart — YYYY-MM-DD, начало — полночь пояса календаря", () => {
    expect(formatForModel(date(2026, 10, 21), moscowEnv, "instance")).toBe("2026-10-21");
    expect(formatForModel(date(2026, 10, 21), moscowEnv, "time")).toBe("2026-10-21T00:00:00+03:00");
    expect(formatForModel(date(2026, 10, 21), newYorkEnv, "time")).toBe("2026-10-21T00:00:00-04:00");
  });

  it("выданный instanceStart разбирается обратно в тот же ключ слота", () => {
    const cases: Array<[ICAL.Time, TimeForm]> = [[zoned("Europe/Berlin", 2026, 11, 3, 10), "zoned"],
      [utc(2026, 10, 21, 7), "utc"], [floating(2026, 10, 21, 10), "floating"], [date(2026, 10, 21), "date"]];

    for (const env of [moscowEnv, newYorkEnv]) {
      for (const [value, form] of cases) {
        const parsed = parseModelTime(formatForModel(value, env, "instance"), env.floatingZone);
        expect(slotKeyOf(parsed.time, form, env)).toBe(slotKeyOf(value, form, env));
      }
    }
  });
});
