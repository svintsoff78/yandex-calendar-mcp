import { describe, expect, it } from "vitest";
import { buildEvent } from "../../src/ical/build.js";
import { parseEvent } from "../../src/ical/parse.js";

const base = {
  calendarId: "work",
  summary: "Проект «Заря», утро",
  description: "Строка один\nСтрока два",
  location: "Дома",
  start: "2026-09-21T10:00:00+03:00",
  end: "2026-09-21T14:00:00+03:00",
  timeZone: "Europe/Moscow",
  allDay: false,
  reminders: [{ minutesBefore: 15, method: "display" as const }],
  attendees: [],
};

describe("buildEvent", () => {
  it("пишет время с TZID, а не в UTC", () => {
    const { ics } = buildEvent(base);

    expect(ics).toContain("DTSTART;TZID=Europe/Moscow:20260921T100000");
    expect(ics).not.toContain("DTSTART:20260921T070000Z");
  });

  it("вкладывает описание пояса в календарь", () => {
    const { ics } = buildEvent(base);

    expect(ics).toContain("BEGIN:VTIMEZONE");
    expect(ics).toContain("TZID:Europe/Moscow");
  });

  it("переживает круговое преобразование без потерь", () => {
    const { ics } = buildEvent(base);
    const parsed = parseEvent(ics, "work");

    expect(parsed.summary).toBe(base.summary);
    expect(parsed.description).toBe(base.description);
    expect(parsed.start).toBe(base.start);
    expect(parsed.end).toBe(base.end);
    expect(parsed.reminders).toEqual(base.reminders);
  });

  it("сохраняет правило повтора при круговом преобразовании", () => {
    const recurring = {
      ...base,
      recurrence: { frequency: "weekly" as const, interval: 1, byWeekday: ["MO", "WE"] as const, count: 6 },
    };

    const parsed = parseEvent(buildEvent(recurring).ics, "work");

    expect(parsed.recurrence).toEqual(recurring.recurrence);
  });

  it("пишет событие на весь день как DATE без времени", () => {
    const { ics } = buildEvent({
      ...base,
      allDay: true,
      start: "2026-09-23T00:00:00+03:00",
      end: "2026-09-24T00:00:00+03:00",
    });

    expect(ics).toContain("DTSTART;VALUE=DATE:20260923");
    expect(ics).not.toContain("T000000");
  });

  it("выдаёт свой UID, когда его не передали", () => {
    const first = buildEvent(base);
    const second = buildEvent(base);

    expect(first.uid).toBeTruthy();
    expect(first.uid).not.toBe(second.uid);
  });
});
