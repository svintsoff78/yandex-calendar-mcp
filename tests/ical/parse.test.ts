import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadObject } from "../../src/ical/object.js";
import { eventOfObject, parseEvent, UnparsableEventError } from "../../src/ical/parse.js";
import type { IcalEnv } from "../../src/ical/values.js";
import * as seeds from "../support/seeds.js";

const fixture = (name: string) => readFileSync(`tests/fixtures/${name}`, "utf8");

describe("parseEvent", () => {
  it("читает обычное событие с поясом", () => {
    const event = parseEvent(fixture("simple.ics"), "work", '"etag-1"');

    expect(event.id).toBe("test-simple-1");
    expect(event.calendarId).toBe("work");
    expect(event.etag).toBe('"etag-1"');
    expect(event.allDay).toBe(false);
    expect(event.timeZone).toBe("Europe/Moscow");
    expect(event.start).toBe("2026-09-21T10:00:00+03:00");
    expect(event.end).toBe("2026-09-21T14:00:00+03:00");
  });

  it("снимает экранирование запятых и переносов строк", () => {
    const event = parseEvent(fixture("simple.ics"), "work");

    expect(event.summary).toBe("Проект «Заря», первая половина дня");
    expect(event.description).toBe("Строка один\nСтрока два");
  });

  it("читает напоминание из VALARM", () => {
    const event = parseEvent(fixture("simple.ics"), "work");

    expect(event.reminders).toEqual([{ minutesBefore: 15, method: "display" }]);
  });

  it("распознаёт событие на весь день", () => {
    const event = parseEvent(fixture("allday.ics"), "personal");

    expect(event.allDay).toBe(true);
    expect(event.start.slice(0, 10)).toBe("2026-09-23");
  });

  it("переводит RRULE в читаемое правило", () => {
    const event = parseEvent(fixture("weekly.ics"), "work");

    expect(event.recurrence).toEqual({
      frequency: "weekly",
      interval: 1,
      byWeekday: ["MO", "WE"],
      count: 6,
    });
  });

  it("не выдумывает правило у события без повтора", () => {
    expect(parseEvent(fixture("simple.ics"), "work").recurrence).toBeUndefined();
  });

  it("сохраняет порядковый префикс BYDAY (второй понедельник, последняя пятница)", () => {
    const event = parseEvent(fixture("monthly-ordinal.ics"), "work");

    expect(event.recurrence).toEqual({
      frequency: "monthly",
      interval: 1,
      byWeekday: ["2MO", "-1FR"],
    });
  });

  it("учитывает знак триггера-длительности: TRIGGER:-PT15M — до начала, TRIGGER:PT10M — после", () => {
    const event = parseEvent(fixture("reminders.ics"), "work");

    expect(event.reminders[0]).toEqual({ minutesBefore: 15, method: "display" });
    expect(event.reminders[1]).toEqual({ minutesBefore: -10, method: "display" });
  });

  // З09, О9: напоминания модели — только VALARM DISPLAY и EMAIL с TRIGGER от
  // начала (ими и управляет правка, src/ical/patch.ts, managedAlarmKey).
  // Абсолютный TRIGGER модель не выражает: показанный минутами, он вернулся
  // бы при правке относительным и лёг бы вторым напоминанием рядом с прежним.
  // Прежде здесь ждали { minutesBefore: 20, method: "email" }.
  it("не показывает абсолютный триггер (TRIGGER;VALUE=DATE-TIME): модель его не выражает", () => {
    const event = parseEvent(fixture("reminders.ics"), "work");

    expect(event.reminders).toEqual([
      { minutesBefore: 15, method: "display" },
      { minutesBefore: -10, method: "display" },
    ]);
  });

  it("для события на весь день timeZone равен UTC, а не внутреннему floating ical.js", () => {
    const event = parseEvent(fixture("allday.ics"), "personal");

    expect(event.timeZone).toBe("UTC");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// З09: разбор объекта целиком для get_event — через основной компонент, с
// отступлениями серии (exceptions) и аномалиями (Р4–Р7, О14 плана переделки,
// docs/superpowers/plans/2026-09-19-recurring-events-rework.md).
// ─────────────────────────────────────────────────────────────────────────────

const CRLF = "\r\n";
const UID = "parse-z09@yandex.ru";
const MSK: IcalEnv = { floatingZone: "Europe/Moscow" };
const MOSCOW_ZONE = [
  "BEGIN:VTIMEZONE", "TZID:Europe/Moscow", "BEGIN:STANDARD", "TZNAME:MSK", "TZOFFSETFROM:+0300",
  "TZOFFSETTO:+0300", "DTSTART:19700101T000000", "END:STANDARD", "END:VTIMEZONE",
];
const WEEKLY = ["DTSTART;TZID=Europe/Moscow:20261019T100000", "DTEND;TZID=Europe/Moscow:20261019T110000",
  "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6", "SUMMARY:Планёрка"];

function vevent(lines: string[], uid = UID): string[] {
  return ["BEGIN:VEVENT", `UID:${uid}`, "DTSTAMP:20261001T090000Z", ...lines, "END:VEVENT"];
}

function calendarOf(zones: string[], ...events: string[][]): string {
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//parse//RU", ...zones, ...events.flat(), "END:VCALENDAR"]
    .join(CRLF) + CRLF;
}

function override(rid: string, start: string, end: string, ...extra: string[]): string[] {
  return vevent([`RECURRENCE-ID;TZID=Europe/Moscow:${rid}`, `DTSTART;TZID=Europe/Moscow:${start}`,
    `DTEND;TZID=Europe/Moscow:${end}`, ...extra]);
}

describe("parseEvent: объект целиком через основной компонент (З09)", () => {
  // C04: Яндекс ставит основной первым (Ж2), другие клиенты — не обязательно.
  it("основной компонент — VEVENT без RECURRENCE-ID, даже если переопределение стоит первым", () => {
    const ics = calendarOf(MOSCOW_ZONE,
      override("20261021T100000", "20261021T150000", "20261021T160000", "SUMMARY:Перенесённая"),
      vevent(WEEKLY));

    const event = parseEvent(ics, "work", "1", MSK);
    expect(event).toMatchObject({
      id: UID,
      summary: "Планёрка",
      start: "2026-10-19T10:00:00+03:00",
      end: "2026-10-19T11:00:00+03:00",
      recurring: true,
      recurrence: { frequency: "weekly", interval: 1, byWeekday: ["MO", "WE"], count: 6 },
    });
    expect(event.instanceStart).toBeUndefined();
  });

  it("отступления серии — в exceptions: перенос, EXDATE, скрытое, detached (Р5–Р7)", () => {
    const ics = calendarOf(MOSCOW_ZONE,
      vevent([...WEEKLY, "EXDATE;TZID=Europe/Moscow:20261026T100000"]),
      override("20261021T100000", "20261021T150000", "20261021T160000", "SUMMARY:Перенесена"),
      override("20261026T100000", "20261026T100000", "20261026T110000", "SUMMARY:Под EXDATE"),
      override("20261028T120000", "20261028T120000", "20261028T130000", "SUMMARY:Мимо слотов"));

    const event = parseEvent(ics, "work", "1", MSK);
    expect(event.exceptions?.map((e) => `${e.instanceStart} ${e.state} ${e.summary ?? ""}`.trim())).toEqual([
      "2026-10-21T10:00:00+03:00 moved Перенесена",
      "2026-10-26T10:00:00+03:00 excluded",
      "2026-10-26T10:00:00+03:00 hidden Под EXDATE",
      "2026-10-28T12:00:00+03:00 detached Мимо слотов",
    ]);
  });

  it("аномалии объекта — в anomalies строками «код: пояснение»", () => {
    const ics = calendarOf(MOSCOW_ZONE, vevent(WEEKLY), vevent(WEEKLY));

    expect(parseEvent(ics, "work", "1", MSK).anomalies?.some((a) => a.startsWith("multiple-masters: "))).toBe(true);
  });

  it("объект из одних переопределений — первая встреча, detached, с адресом и exceptions (Р6)", () => {
    const ics = calendarOf(MOSCOW_ZONE,
      override("20261028T100000", "20261028T100000", "20261028T110000", "SUMMARY:Вторая",
        "BEGIN:VALARM", "ACTION:EMAIL", "TRIGGER:-PT1H", "END:VALARM"),
      override("20261021T100000", "20261021T120000", "20261021T130000", "SUMMARY:Первая",
        "BEGIN:VALARM", "ACTION:DISPLAY", "TRIGGER:-PT5M", "END:VALARM"));

    const event = parseEvent(ics, "work", "1", MSK);
    expect(event.reminders).toEqual([{ minutesBefore: 5, method: "display" }]);
    expect(event).toMatchObject({
      summary: "Первая",
      start: "2026-10-21T12:00:00+03:00",
      instanceStart: "2026-10-21T10:00:00+03:00",
      detached: true,
      moved: true,
      recurring: true,
    });
    expect(event.exceptions?.map((e) => e.state)).toEqual(["detached", "detached"]);
  });

  it("STATUS:CANCELLED основного компонента — status: cancelled", () => {
    const ics = calendarOf(MOSCOW_ZONE, vevent([...WEEKLY.filter((l) => !l.startsWith("RRULE")), "STATUS:CANCELLED"]));

    expect(parseEvent(ics, "work", undefined, MSK).status).toBe("cancelled");
  });

  it("серия из RDATE: recurrence нет, правило — дословно в recurrenceRule", () => {
    const ics = calendarOf(MOSCOW_ZONE, vevent([...WEEKLY.filter((l) => !l.startsWith("RRULE")),
      "RDATE;TZID=Europe/Moscow:20261022T100000,20261027T100000"]));

    const event = parseEvent(ics, "work", undefined, MSK);
    expect(event.recurrence).toBeUndefined();
    expect(event).toMatchObject({ recurring: true, recurrenceRule: "RDATE;TZID=Europe/Moscow:20261022T100000,20261027T100000" });
  });

  it("неизвестный TZID без VTIMEZONE — читается стенным временем календаря с аномалией unknown-tzid", () => {
    const ics = calendarOf([], vevent(["DTSTART;TZID=Mars/Olympus:20261019T100000", "DTEND;TZID=Mars/Olympus:20261019T110000",
      "SUMMARY:С Марса"]));

    const event = parseEvent(ics, "work", undefined, MSK);
    expect(event.start).toBe("2026-10-19T10:00:00+03:00");
    expect(event.anomalies?.some((a) => a.startsWith("unknown-tzid: ") && a.includes("Mars/Olympus"))).toBe(true);
  });

  it("весь день и плавающее время — в поясе календаря из env; без env — в UTC, как прежде", () => {
    expect(parseEvent(fixture("allday.ics"), "personal", undefined, MSK)).toMatchObject({
      start: "2026-09-23T00:00:00+03:00",
      end: "2026-09-24T00:00:00+03:00",
      timeZone: "Europe/Moscow",
    });
    const floating = calendarOf([], vevent(["DTSTART:20261019T100000", "DTEND:20261019T110000", "SUMMARY:Плавающее"]));
    expect(parseEvent(floating, "work", undefined, MSK).start).toBe("2026-10-19T10:00:00+03:00");
    expect(parseEvent(floating, "work").start).toBe("2026-10-19T10:00:00+00:00");
  });

  it("напоминания: от конца, AUDIO и абсолютные не показываются — модель вернула бы их вторыми (О9)", () => {
    const ics = calendarOf(MOSCOW_ZONE, vevent([...WEEKLY,
      "BEGIN:VALARM", "ACTION:DISPLAY", "TRIGGER;RELATED=END:-PT5M", "END:VALARM",
      "BEGIN:VALARM", "ACTION:AUDIO", "TRIGGER:-PT10M", "END:VALARM",
      "BEGIN:VALARM", "ACTION:EMAIL", "TRIGGER;VALUE=DURATION;RELATED=START:-P1D", "END:VALARM"]));

    expect(parseEvent(ics, "work", undefined, MSK).reminders).toEqual([{ minutesBefore: 1440, method: "email" }]);
  });
});

describe("неразбираемый объект (Р4)", () => {
  it.each([seeds.c63BadFreq, seeds.c63BadByday])("$about: parseEvent отказывает с кодом unparsable и UID", (seed) => {
    let caught: unknown;
    try {
      parseEvent(seed.ics, "work", "1", MSK);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UnparsableEventError);
    expect(caught).toMatchObject({ code: "unparsable", uid: seed.uid });
    expect((caught as Error).message).toContain(seed.uid);
  });

  it("eventOfObject (get_event): заглушка с UID, SUMMARY, DTSTART и аномалией unparsable", () => {
    const event = eventOfObject(loadObject(seeds.c63BadFreq.ics, MSK), { calendarId: "work", etag: "5", href: "/c/w/bad.ics" }, MSK);

    expect(event).toMatchObject({
      id: seeds.c63BadFreq.uid,
      calendarId: "work",
      summary: "Правило с неизвестной частотой",
      start: "2026-10-19T10:00:00+03:00",
      etag: "5",
      href: "/c/w/bad.ics",
    });
    expect(event.anomalies?.[0]).toMatch(/^unparsable: /);
  });

  it("eventOfObject у разобранного объекта — то же, что parseEvent", () => {
    const meta = { calendarId: "work", etag: "5" };
    expect(eventOfObject(loadObject(seeds.weeklyMoscow.ics, MSK), meta, MSK)).toEqual(
      parseEvent(seeds.weeklyMoscow.ics, "work", "5", MSK),
    );
  });
});
