import ICAL from "ical.js";
import { describe, expect, it } from "vitest";
import { registerTimeZone } from "../../src/ical/timezones.js";

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
});
