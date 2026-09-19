import ICAL from "ical.js";
import { describe, expect, it } from "vitest";
import { registerTimeZone, vtimezoneFor } from "../../src/ical/timezones.js";

// Сырое (без обёртки BEGIN:VCALENDAR) описание пояса, как оно приходит вложенным
// в calendar-data события с сервера Яндекса.
const RAW_VTIMEZONE = `BEGIN:VTIMEZONE
TZID:Test/Fixed-Plus-Two
X-LIC-LOCATION:Test/Fixed-Plus-Two
BEGIN:STANDARD
TZOFFSETFROM:+0200
TZOFFSETTO:+0200
TZNAME:T2
DTSTART:19700101T000000
END:STANDARD
END:VTIMEZONE`;

describe("registerTimeZone", () => {
  it("регистрирует Europe/Moscow из базы IANA и даёт смещение +03:00", () => {
    const zone = registerTimeZone("Europe/Moscow");
    const time = new ICAL.Time(
      { year: 2026, month: 9, day: 21, hour: 10, minute: 0, second: 0, isDate: false },
      zone,
    );

    expect(zone.tzid).toBe("Europe/Moscow");
    expect(time.utcOffset()).toBe(3 * 3600);
  });

  it("повторный вызов отдаёт уже зарегистрированную зону, а не создаёт новую", () => {
    const first = registerTimeZone("Europe/Moscow");
    const second = registerTimeZone("Europe/Moscow");

    expect(second).toBe(first);
  });

  it("регистрирует пояс из переданного вложенного VTIMEZONE (без обёртки VCALENDAR)", () => {
    const zone = registerTimeZone("Test/Fixed-Plus-Two", RAW_VTIMEZONE);
    const time = new ICAL.Time(
      { year: 2026, month: 1, day: 1, hour: 0, minute: 0, second: 0, isDate: false },
      zone,
    );

    expect(zone.tzid).toBe("Test/Fixed-Plus-Two");
    expect(time.utcOffset()).toBe(2 * 3600);
  });

  it("бросает понятную ошибку для неизвестного пояса без базы и без явного VTIMEZONE", () => {
    expect(() => registerTimeZone("Mars/Olympus_Mons")).toThrow(/Неизвестный часовой пояс/);
  });

  it("у пояса-синонима tzid совпадает с запрошенным именем, а не с каноническим из базы", () => {
    // База отдаёт для US/Eastern описание с TZID:America/New_York. Если tzid
    // зоны взять из описания, RECURRENCE-ID и EXDATE, записанные по её tzid,
    // получат другой TZID, чем DTSTART (нарушение О4 плана).
    const zone = registerTimeZone("US/Eastern");
    const time = new ICAL.Time(
      { year: 2026, month: 10, day: 21, hour: 10, minute: 0, second: 0, isDate: false },
      zone,
    );

    expect(zone.tzid).toBe("US/Eastern");
    expect(time.utcOffset()).toBe(-4 * 3600);
  });
});

describe("vtimezoneFor", () => {
  function tzidOf(component: ICAL.Component): unknown {
    return component.getFirstPropertyValue("tzid");
  }

  it("отдаёт VTIMEZONE из базы IANA с запрошенным TZID", () => {
    const component = vtimezoneFor("Europe/Berlin");
    const zone = new ICAL.Timezone({ component, tzid: "Europe/Berlin" });

    expect(component.name).toBe("vtimezone");
    expect(tzidOf(component)).toBe("Europe/Berlin");
    expect(new ICAL.Time({ year: 2026, month: 7, day: 1, hour: 12, minute: 0, second: 0, isDate: false }, zone)
      .utcOffset()).toBe(2 * 3600);
    expect(new ICAL.Time({ year: 2026, month: 12, day: 1, hour: 12, minute: 0, second: 0, isDate: false }, zone)
      .utcOffset()).toBe(1 * 3600);
  });

  it("каждый вызов даёт независимую копию без родителя, общий пояс сервиса не трогается", () => {
    const service = registerTimeZone("Europe/Moscow").component;
    const before = service.toString();
    const first = vtimezoneFor("Europe/Moscow");
    const second = vtimezoneFor("Europe/Moscow");

    expect(first).not.toBe(second);
    expect(first).not.toBe(service);
    expect(first.jCal).not.toBe(second.jCal);
    expect(first.parent).toBeNull();

    const calendar = new ICAL.Component(["vcalendar", [], []]);
    calendar.addSubcomponent(first);
    first.updatePropertyWithValue("x-lic-location", "изменено");

    expect(second.toString()).toBe(service.toString());
    expect(service.toString()).toBe(before);
    expect(registerTimeZone("Europe/Moscow").component).toBe(service);
  });

  it("у синонима ставит в TZID запрошенное имя", () => {
    expect(tzidOf(vtimezoneFor("US/Eastern"))).toBe("US/Eastern");
    expect(tzidOf(vtimezoneFor("UTC"))).toBe("UTC");
  });

  it("пояс вне базы берёт из уже зарегистрированного описания", () => {
    registerTimeZone("Test/Fixed-Plus-Two", RAW_VTIMEZONE);
    const component = vtimezoneFor("Test/Fixed-Plus-Two");

    expect(tzidOf(component)).toBe("Test/Fixed-Plus-Two");
    expect(component).not.toBe(registerTimeZone("Test/Fixed-Plus-Two").component);
  });

  it("копия пояса вне базы не делит jCal с описанием в сервисе: её правка описание не меняет", () => {
    const service = registerTimeZone("Test/Out-Of-Base-Copy", RAW_VTIMEZONE).component;
    const before = service.toString();
    const copy = vtimezoneFor("Test/Out-Of-Base-Copy");

    copy.updatePropertyWithValue("x-lic-location", "изменено");
    copy.addPropertyWithValue("x-ycm-mark", "копия");
    new ICAL.Component(["vcalendar", [], []]).addSubcomponent(copy);

    expect(copy.jCal).not.toBe(service.jCal);
    expect(service.toString()).toBe(before);
    expect(copy.toString()).toContain("X-LIC-LOCATION:изменено");
  });

  it("у пояса вне базы, зарегистрированного под другим именем, в TZID копии — это имя, описание в сервисе цело", () => {
    // Описание с TZID:Test/Fixed-Plus-Two зарегистрировано прямо в сервисе под
    // именем Test/Alias-Plus-Two (так делает любой код, минуя registerTimeZone).
    const described = new ICAL.Component(ICAL.parse(`BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${RAW_VTIMEZONE}\r\nEND:VCALENDAR`))
      .getFirstSubcomponent("vtimezone")!;
    ICAL.TimezoneService.register(new ICAL.Timezone({ component: described, tzid: "Test/Alias-Plus-Two" }),
      "Test/Alias-Plus-Two");

    const copy = vtimezoneFor("Test/Alias-Plus-Two");

    expect(tzidOf(copy)).toBe("Test/Alias-Plus-Two");
    expect(tzidOf(described)).toBe("Test/Fixed-Plus-Two");
  });

  it("бросает понятную ошибку для неизвестного пояса", () => {
    expect(() => vtimezoneFor("Mars/Olympus_Mons")).toThrow(/Неизвестный часовой пояс/);
  });
});
