import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseEvent } from "../../src/ical/parse.js";

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
});
