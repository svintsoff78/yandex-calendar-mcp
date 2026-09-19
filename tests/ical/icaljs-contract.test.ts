import ICAL from "ical.js";
import { describe, expect, it } from "vitest";

// Контракт ical.js 2.2.1: поведение библиотеки, на которое опирается слой
// src/ical. Каждый случай сверен с исходником node_modules/ical.js/lib/ical/
// (файл назван в заголовке). Смена версии библиотеки должна ронять этот
// файл, а не данные пользователя. Тесты не зависят от пояса процесса.

const CRLF = "\r\n";

function calendar(...veventLines: string[]): string {
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", "UID:contract", ...veventLines,
    "END:VEVENT", "END:VCALENDAR"].join(CRLF);
}

function veventOf(ics: string): ICAL.Component {
  const vevent = new ICAL.Component(ICAL.parse(ics)).getFirstSubcomponent("vevent");
  if (!vevent) throw new Error("нет VEVENT");
  return vevent;
}

function collect(next: () => ICAL.Time | null, limit = 50): string[] {
  const out: string[] = [];
  for (let t = next(); t && out.length < limit; t = next()) out.push(t.toString());
  return out;
}

const PLUS5 = ["BEGIN:VTIMEZONE", "TZID:Test/Plus5", "BEGIN:STANDARD", "TZOFFSETFROM:+0500",
  "TZOFFSETTO:+0500", "TZNAME:P5", "DTSTART:19700101T000000", "END:STANDARD", "END:VTIMEZONE"];

// Нынешние правила IANA для двух поясов по обе стороны от UTC.
const NEW_YORK = ["BEGIN:VTIMEZONE", "TZID:America/New_York",
  "BEGIN:DAYLIGHT", "TZOFFSETFROM:-0500", "TZOFFSETTO:-0400", "TZNAME:EDT", "DTSTART:20070311T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU", "END:DAYLIGHT",
  "BEGIN:STANDARD", "TZOFFSETFROM:-0400", "TZOFFSETTO:-0500", "TZNAME:EST", "DTSTART:20071104T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU", "END:STANDARD", "END:VTIMEZONE"];
const BERLIN = ["BEGIN:VTIMEZONE", "TZID:Europe/Berlin",
  "BEGIN:DAYLIGHT", "TZOFFSETFROM:+0100", "TZOFFSETTO:+0200", "TZNAME:CEST", "DTSTART:19810329T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU", "END:DAYLIGHT",
  "BEGIN:STANDARD", "TZOFFSETFROM:+0200", "TZOFFSETTO:+0100", "TZNAME:CET", "DTSTART:19961027T030000",
  "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU", "END:STANDARD", "END:VTIMEZONE"];

// Значение DTSTART;TZID=<tzid>:<value> с поясом из дерева объекта (не из сервиса).
function zonedFromTree(vtimezone: string[], tzid: string, value: string): ICAL.Time {
  const root = new ICAL.Component(ICAL.parse(["BEGIN:VCALENDAR", "VERSION:2.0", ...vtimezone, "BEGIN:VEVENT",
    "UID:tree", `DTSTART;TZID=${tzid}:${value}`, "END:VEVENT", "END:VCALENDAR"].join(CRLF)));
  const time = root.getFirstSubcomponent("vevent")!.getFirstPropertyValue("dtstart") as ICAL.Time;
  expect(time.zone!.tzid).toBe(tzid);
  return time;
}

describe("контракт ical.js: сериализация (stringify.js, component.js, helpers.js)", () => {
  it("свойства выводятся перед подкомпонентами, исходный порядок вперемешку теряется", () => {
    // stringify.js, stringify.component: сначала все component[1], потом component[2].
    const ics = calendar("DTSTART:20261021T070000Z", "BEGIN:VALARM", "ACTION:DISPLAY",
      "TRIGGER:-PT15M", "END:VALARM", "SUMMARY:После напоминания");
    const out = new ICAL.Component(ICAL.parse(ics)).toString();

    expect(out.indexOf("SUMMARY:")).toBeLessThan(out.indexOf("BEGIN:VALARM"));
  });

  it("addProperty дописывает свойство в конец списка свойств, всё равно до подкомпонентов", () => {
    // component.js, addProperty: push в jCal[1].
    const vevent = veventOf(calendar("DTSTART:20261021T070000Z", "BEGIN:VALARM",
      "ACTION:DISPLAY", "TRIGGER:-PT15M", "END:VALARM"));
    vevent.addPropertyWithValue("location", "Переговорная");
    const out = vevent.toString();

    expect(out.indexOf("LOCATION:")).toBeGreaterThan(out.indexOf("DTSTART:"));
    expect(out.indexOf("LOCATION:")).toBeLessThan(out.indexOf("BEGIN:VALARM"));
  });

  it("addSubcomponent дописывает компонент в конец и отцепляет его от прежнего родителя", () => {
    // component.js, addSubcomponent: parent.removeSubcomponent(component), затем push.
    const first = new ICAL.Component(ICAL.parse(calendar("DTSTART:20261021T070000Z")));
    const second = new ICAL.Component(["vcalendar", [], []]);
    const vevent = first.getFirstSubcomponent("vevent")!;

    second.addSubcomponent(vevent);

    expect(first.getAllSubcomponents("vevent")).toHaveLength(0);
    expect(second.getAllSubcomponents()).toEqual([vevent]);
  });

  it("foldline считает октеты UTF-8 и не рвёт многобайтовые символы", () => {
    // helpers.js:235, foldline: line_length копит байты UTF-8, граница — foldLength (75).
    const line = "SUMMARY:" + "Жёлтая встреча 🙂 ".repeat(12);
    const folded = ICAL.helpers.foldline(line);
    const physical = folded.split(CRLF);

    expect(physical.length).toBeGreaterThan(1);
    expect(Buffer.byteLength(physical[0], "utf8")).toBeLessThanOrEqual(75);
    for (const next of physical.slice(1)) {
      expect(next.startsWith(" ")).toBe(true);
      // Содержимое продолжения — до 75 октетов; вместе с ведущим пробелом
      // строка бывает 76 октетов (так устроен foldline, RFC 5545 §3.1 — SHOULD).
      expect(Buffer.byteLength(next.slice(1), "utf8")).toBeLessThanOrEqual(75);
    }
    // Ни одна физическая строка не кончается и не начинается обрывком символа.
    for (const part of physical) {
      expect(Buffer.from(part, "utf8").toString("utf8")).toBe(part);
      expect(part).not.toMatch(/[\uD800-\uDBFF]$|^ ?[\uDC00-\uDFFF]/);
    }
    expect(physical.map((part, i) => (i === 0 ? part : part.slice(1))).join("")).toBe(line);
  });

  it("toString компонента складывает длинные строки по октетам", () => {
    // stringify.js:210 — stringify.property вызывает foldline, если не noFold.
    const vevent = veventOf(calendar("DTSTART:20261021T070000Z"));
    vevent.addPropertyWithValue("summary", "Ж".repeat(100));
    const lines = vevent.toString().split(CRLF);

    for (const line of lines) {
      expect(Buffer.byteLength(line.replace(/^ /, ""), "utf8")).toBeLessThanOrEqual(75);
    }
  });
});

describe("контракт ical.js: RRULE как jCal-словарь (design.js, recur.js, property.js)", () => {
  const RULE = "FREQ=MONTHLY;INTERVAL=1;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;WKST=SU;RSCALE=GREGORIAN;X-YCM=keep";

  it("неизвестные части RRULE остаются в jCal и сериализуются, toJSON и toString их теряют", () => {
    // recur.js, _stringToData: «Don't swallow unknown values» — dict[lcname] = value;
    // design.js, recur.toICAL: обходит Object.entries(data) по порядку.
    // recur.js, toJSON/toString: только freq, count, interval>1, parts, until, wkst.
    const rrule = veventOf(calendar("DTSTART:20261030T140000Z", `RRULE:${RULE}`))
      .getFirstProperty("rrule")!;
    const dict = rrule.jCal[3] as Record<string, unknown>;

    expect(Object.keys(dict)).toEqual(["freq", "interval", "byday", "bysetpos", "wkst", "rscale", "x-ycm"]);
    expect(rrule.toICALString()).toBe(`RRULE:${RULE}`);

    const recur = rrule.getFirstValue() as ICAL.Recur;
    const json = recur.toJSON() as Record<string, unknown>;
    expect(json).not.toHaveProperty("rscale");
    expect(json).not.toHaveProperty("x-ycm");
    expect(json).not.toHaveProperty("interval"); // INTERVAL=1 тоже пропадает (interval > 1)
    expect(recur.toString()).not.toContain("RSCALE");
    expect(recur.toString()).not.toContain("X-YCM");
  });

  it("getFirstValue кеширует разобранное значение: правка jCal не видна в нём, но видна в тексте", () => {
    // property.js, _hydrateValue: this._values[index] кешируется; сериализация идёт из jCal.
    const rrule = veventOf(calendar("DTSTART:20261019T070000Z", "RRULE:FREQ=DAILY;COUNT=10"))
      .getFirstProperty("rrule")!;
    const cached = rrule.getFirstValue() as ICAL.Recur;

    (rrule.jCal[3] as Record<string, unknown>).count = 3;

    expect(rrule.getFirstValue()).toBe(cached);
    expect(cached.count).toBe(10);
    expect(rrule.toICALString()).toBe("RRULE:FREQ=DAILY;COUNT=3");

    // property.js, removeAllValues: обнуляет _values — после него значение разбирается заново.
    const dict = rrule.jCal[3];
    rrule.removeAllValues();
    rrule.jCal.push(dict);
    expect((rrule.getFirstValue() as ICAL.Recur).count).toBe(3);
  });

  it("UNTIL в jCal — строка; toICAL выбирает DATE или DATE-TIME по длине строки больше 10", () => {
    // design.js, recur.toICAL: `if (val.length > 10)` → date-time.toICAL, иначе date.toICAL.
    const rrule = veventOf(calendar("DTSTART:20261019T070000Z", "RRULE:FREQ=DAILY"))
      .getFirstProperty("rrule")!;
    const dict = rrule.jCal[3] as Record<string, unknown>;

    dict.until = "2026-10-30";
    expect(rrule.toICALString()).toBe("RRULE:FREQ=DAILY;UNTIL=20261030");
    dict.until = "2026-10-30T06:59:59Z";
    expect(rrule.toICALString()).toBe("RRULE:FREQ=DAILY;UNTIL=20261030T065959Z");
    dict.until = "2026-10-30T09:59:59";
    expect(rrule.toICALString()).toBe("RRULE:FREQ=DAILY;UNTIL=20261030T095959");
  });

  it.each([
    ["FREQ=FOO"],
    ["FREQ=WEEKLY;BYDAY=0MO"],
    ["FREQ=MONTHLY;BYMONTHDAY=32"],
    ["FREQ=DAILY;COUNT=x"],
  ])("ICAL.parse бросает на плохом RRULE %s — дерева нет", (rule) => {
    // parse.js:288/310 → design.js:469 recur.fromICAL → recur.js _stringToData:
    // optionDesign.FREQ, partDesign.BYDAY (VALID_BYDAY_PART), parseNumericValue, strictParseInt.
    expect(() => ICAL.parse(calendar("DTSTART:20261019T070000Z", `RRULE:${rule}`))).toThrow();
  });
});

describe("контракт ical.js: итератор правила и RecurExpansion (recur_iterator.js, recur_expansion.js)", () => {
  it("occurrence_number считает только позиции правила; DTSTART вне BYDAY не выдаётся", () => {
    // recur_iterator.js:386-467, next: первой выдаётся init-позиция, только если last >= dtstart;
    // occurrence_number растёт на каждой выдаче; COUNT сравнивается с ним.
    const dtstart = ICAL.Time.fromData({ year: 2026, month: 10, day: 20, hour: 10, minute: 0, second: 0 },
      ICAL.Timezone.utcTimezone); // вторник
    const iterator = ICAL.Recur.fromString("FREQ=WEEKLY;BYDAY=MO,WE;COUNT=4").iterator(dtstart);

    const first = iterator.next()!;
    expect(first.toString()).toBe("2026-10-21T10:00:00Z"); // среда
    expect(iterator.occurrence_number).toBe(1);

    const rest = collect(() => iterator.next());
    expect(rest).toEqual(["2026-10-26T10:00:00Z", "2026-10-28T10:00:00Z", "2026-11-02T10:00:00Z"]);
    expect(iterator.occurrence_number).toBe(4);
  });

  it("итератор не знает EXDATE компонента: исключённая позиция выдаётся и считается в COUNT", () => {
    // recur.js, iterator(aStart) → new RecurIterator({rule, dtstart}): компонента нет вовсе.
    const vevent = veventOf(calendar("DTSTART:20261019T070000Z", "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=3",
      "EXDATE:20261021T070000Z"));
    const dtstart = vevent.getFirstPropertyValue("dtstart") as ICAL.Time;
    const iterator = (vevent.getFirstPropertyValue("rrule") as ICAL.Recur).iterator(dtstart);

    expect(collect(() => iterator.next())).toEqual(
      ["2026-10-19T07:00:00Z", "2026-10-21T07:00:00Z", "2026-10-26T07:00:00Z"]);
  });

  it("итератор возвращает один и тот же объект времени — выдачу нужно клонировать", () => {
    // recur_iterator.js, next: `return this.last`; this.last присваивается только в init.
    const dtstart = ICAL.Time.fromData({ year: 2026, month: 10, day: 19, hour: 7, minute: 0, second: 0 },
      ICAL.Timezone.utcTimezone);
    const iterator = ICAL.Recur.fromString("FREQ=DAILY;COUNT=3").iterator(dtstart);

    const first = iterator.next();
    const second = iterator.next();
    expect(second).toBe(first);
    expect(first!.toString()).toBe("2026-10-20T07:00:00Z");
  });

  it("RecurExpansion.next на дубле EXDATE сдвигает один EXDATE за экземпляр и пропускает исключение", () => {
    // recur_expansion.js:263-277: при compare > 0 — один _nextExDay без повторной проверки.
    const vevent = veventOf(calendar("DTSTART:20261019T070000Z", "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6",
      "EXDATE:20261021T070000Z", "EXDATE:20261021T070000Z", "EXDATE:20261026T070000Z"));
    const expansion = new ICAL.RecurExpansion({
      component: vevent, dtstart: vevent.getFirstPropertyValue("dtstart") as ICAL.Time });

    // 26.10 закрыт EXDATE, но выдан: это ошибка библиотеки, поэтому слоты
    // считаются множеством ключей, а RecurExpansion не используется (план, О2).
    expect(collect(() => expansion.next())).toEqual(["2026-10-19T07:00:00Z", "2026-10-26T07:00:00Z",
      "2026-10-28T07:00:00Z", "2026-11-02T07:00:00Z", "2026-11-04T07:00:00Z"]);
  });

  it("RecurExpansion.next пропускает исключение и после «пустого» EXDATE, не попавшего в слот", () => {
    const vevent = veventOf(calendar("DTSTART:20261019T070000Z", "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6",
      "EXDATE:20261021T083000Z", "EXDATE:20261026T070000Z"));
    const expansion = new ICAL.RecurExpansion({
      component: vevent, dtstart: vevent.getFirstPropertyValue("dtstart") as ICAL.Time });

    expect(collect(() => expansion.next())).toContain("2026-10-26T07:00:00Z");
  });

  it("RecurExpansion у серии из одних RDATE не выдаёт DTSTART", () => {
    // recur_expansion.js:361-390, _init: ruleDate = первая RDATE не раньше DTSTART,
    // сам DTSTART в выдачу не попадает.
    const vevent = veventOf(calendar("DTSTART:20261019T070000Z", "RDATE:20261022T070000Z,20261027T070000Z"));
    const expansion = new ICAL.RecurExpansion({
      component: vevent, dtstart: vevent.getFirstPropertyValue("dtstart") as ICAL.Time });

    expect(collect(() => expansion.next())).toEqual(["2026-10-22T07:00:00Z", "2026-10-27T07:00:00Z"]);
  });
});

describe("контракт ical.js: пояса и моменты (time.js, timezone.js, component.js)", () => {
  it("неизвестный TZID, которого нет ни в дереве, ни в сервисе, даёт плавающее время", () => {
    // time.js, fromDateTimeString → fromData({timezone}): TimezoneService.get(...) || localTimezone.
    const dtstart = veventOf(calendar("DTSTART;TZID=Nowhere/Zone:20261021T100000"))
      .getFirstPropertyValue("dtstart") as ICAL.Time;

    expect(dtstart.zone).toBe(ICAL.Timezone.localTimezone);
    expect(dtstart.zone!.tzid).toBe("floating");
    expect(dtstart.toUnixTime()).toBe(Date.UTC(2026, 9, 21, 10, 0, 0) / 1000);
  });

  it("разобранное значение кешируется: пояс, зарегистрированный позже чтения, не подхватывается", () => {
    // property.js, _hydrateValue: кеш _values; поэтому TZID регистрируются до первого чтения.
    const ics = calendar("DTSTART;TZID=Test/Late-Plus4:20261021T100000");
    const property = veventOf(ics).getFirstProperty("dtstart")!;
    expect((property.getFirstValue() as ICAL.Time).zone).toBe(ICAL.Timezone.localTimezone);

    const late = new ICAL.Component(ICAL.parse(["BEGIN:VCALENDAR", "BEGIN:VTIMEZONE", "TZID:Test/Late-Plus4",
      "BEGIN:STANDARD", "TZOFFSETFROM:+0400", "TZOFFSETTO:+0400", "DTSTART:19700101T000000",
      "END:STANDARD", "END:VTIMEZONE", "END:VCALENDAR"].join(CRLF))).getFirstSubcomponent("vtimezone")!;
    ICAL.TimezoneService.register(new ICAL.Timezone({ component: late, tzid: "Test/Late-Plus4" }), "Test/Late-Plus4");

    expect((property.getFirstValue() as ICAL.Time).zone).toBe(ICAL.Timezone.localTimezone);
    const fresh = veventOf(ics).getFirstPropertyValue("dtstart") as ICAL.Time;
    expect(fresh.zone!.tzid).toBe("Test/Late-Plus4");
    expect(fresh.utcOffset()).toBe(4 * 3600);
  });

  it("getTimeZoneByID ищет VTIMEZONE по дереву от корня, без глобального сервиса", () => {
    // component.js:597, getTimeZoneByID: поднимается к корню и гидрирует VTIMEZONE по TZID;
    // time.js, fromDateTimeString: определение из дерева предпочитается сервису.
    const root = new ICAL.Component(ICAL.parse(["BEGIN:VCALENDAR", "VERSION:2.0", ...PLUS5, "BEGIN:VEVENT",
      "UID:tree", "DTSTART;TZID=Test/Plus5:20261021T100000", "END:VEVENT", "END:VCALENDAR"].join(CRLF)));
    const vevent = root.getFirstSubcomponent("vevent")!;
    const dtstart = vevent.getFirstPropertyValue("dtstart") as ICAL.Time;

    expect(ICAL.TimezoneService.has("Test/Plus5")).toBe(false);
    expect(vevent.getTimeZoneByID("Test/Plus5")).toBe(root.getTimeZoneByID("Test/Plus5"));
    expect(dtstart.zone!.tzid).toBe("Test/Plus5");
    expect(dtstart.toUnixTime()).toBe(Date.UTC(2026, 9, 21, 5, 0, 0) / 1000);
    expect(root.getTimeZoneByID("Nowhere/Zone")).toBeNull();
  });

  it("у плавающего времени toUnixTime берёт смещение 0, а toJSDate строит дату в поясе процесса", () => {
    // time.js:1340 toUnixTime → Date.UTC(..., second - utcOffset()), utcOffset() = 0 для localTimezone;
    // time.js:1187 toJSDate для localTimezone → конструктор Date с местными полями процесса.
    // Отсюда запрет toJSDate в src/ical и src/domain.
    const floating = ICAL.Time.fromData({ year: 2026, month: 10, day: 21, hour: 10, minute: 0, second: 0 });

    expect(floating.zone).toBe(ICAL.Timezone.localTimezone);
    expect(floating.toUnixTime() * 1000).toBe(Date.UTC(2026, 9, 21, 10, 0, 0));
    expect(floating.toJSDate().getTime()).toBe(new Date(2026, 9, 21, 10, 0, 0).getTime());
  });

  it("convertToZone у плавающего времени только переклеивает пояс, не пересчитывая часы", () => {
    // timezone.js:59-66, convert_time: при from_zone == localTimezone — tt.zone = to_zone без сдвига.
    const floating = ICAL.Time.fromData({ year: 2026, month: 10, day: 21, hour: 10, minute: 0, second: 0 });
    const plus5 = new ICAL.Timezone({ component: new ICAL.Component(ICAL.parse(["BEGIN:VCALENDAR", ...PLUS5,
      "END:VCALENDAR"].join(CRLF))).getFirstSubcomponent("vtimezone")!, tzid: "Test/Plus5" });

    const relabelled = floating.convertToZone(plus5);
    expect(relabelled.hour).toBe(10);
    expect(relabelled.toUnixTime()).toBe(Date.UTC(2026, 9, 21, 5, 0, 0) / 1000);
    expect(floating.zone).toBe(ICAL.Timezone.localTimezone);
  });

  it("несуществующее время из весеннего разрыва читается со смещением после разрыва, а RFC 5545 — до него", () => {
    // timezone.js:287-364, utcOffset: у перехода с ростом смещения граница
    // сравнивается в стенном времени до перехода (change + prevUtcOffset), и
    // всё начиная с 02:00 получает новое смещение. RFC 5545 §3.3.5: время из
    // разрыва читается со смещением до разрыва, 02:30 → 07:30Z.
    const gap = zonedFromTree(NEW_YORK, "America/New_York", "20260308T023000");
    expect(gap.utcOffset()).toBe(-4 * 3600);
    expect(gap.toUnixTime() * 1000).toBe(Date.UTC(2026, 2, 8, 6, 30));

    // Настоящее время того же момента — 01:30 EST; ical.js читает и его в 06:30Z.
    const real = zonedFromTree(NEW_YORK, "America/New_York", "20260308T013000");
    expect(real.toUnixTime()).toBe(gap.toUnixTime());
  });

  it("неоднозначное время повторного часа читается как второе вхождение, а RFC 5545 — как первое", () => {
    // timezone.js:287-364, utcOffset: у перехода с падением смещения граница —
    // change + utcOffset (стенное время после перехода), а ветка с
    // `want_daylight = false` оставляет стандартное смещение. RFC 5545 §3.3.5:
    // 02:30 25.10 в Берлине — первое вхождение, CEST, 00:30Z.
    const ambiguous = zonedFromTree(BERLIN, "Europe/Berlin", "20261025T023000");
    expect(ambiguous.utcOffset()).toBe(1 * 3600);
    expect(ambiguous.toUnixTime() * 1000).toBe(Date.UTC(2026, 9, 25, 1, 30));

    const ambiguousNewYork = zonedFromTree(NEW_YORK, "America/New_York", "20261101T013000");
    expect(ambiguousNewYork.toUnixTime() * 1000).toBe(Date.UTC(2026, 10, 1, 6, 30));
  });

  it("секунды в TZOFFSETTO (исторические LMT) отбрасываются: смещение всегда в целых минутах", () => {
    // utc_offset.js:25-33, fromString — «TODO: support seconds per rfc5545»;
    // timezone.js, _expandComponent, convert_tzoffset — только часы и минуты.
    const lmt = ["BEGIN:VTIMEZONE", "TZID:Test/LMT", "BEGIN:STANDARD", "TZOFFSETFROM:+023017",
      "TZOFFSETTO:+023017", "TZNAME:LMT", "DTSTART:18000101T000000", "END:STANDARD", "END:VTIMEZONE"];
    const time = zonedFromTree(lmt, "Test/LMT", "20261021T100000");

    expect(time.utcOffset()).toBe(2 * 3600 + 30 * 60);
    expect(time.toUnixTime() * 1000).toBe(Date.UTC(2026, 9, 21, 7, 30));
  });

  it("toString даёт jCal-строку: Z только у utcTimezone, у даты — без времени", () => {
    // time.js:1165, toString: 'Z' добавляется при zone === Timezone.utcTimezone.
    expect(ICAL.Time.fromData({ year: 2026, month: 10, day: 21, hour: 7, minute: 0, second: 0 },
      ICAL.Timezone.utcTimezone).toString()).toBe("2026-10-21T07:00:00Z");
    expect(ICAL.Time.fromData({ year: 2026, month: 10, day: 21, hour: 7, minute: 0, second: 0 })
      .toString()).toBe("2026-10-21T07:00:00");
    expect(ICAL.Time.fromData({ year: 2026, month: 10, day: 21, isDate: true }).toString()).toBe("2026-10-21");
  });
});
