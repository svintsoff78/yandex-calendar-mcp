import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { expandOccurrences } from "../../src/ical/expand.js";

const fixture = (name: string) => readFileSync(`tests/fixtures/${name}`, "utf8");

describe("expandOccurrences", () => {
  it("раскрывает еженедельную серию в отдельные экземпляры", () => {
    const occurrences = expandOccurrences(
      fixture("weekly.ics"),
      "work",
      new Date("2026-10-01T00:00:00Z"),
      new Date("2026-11-30T00:00:00Z"),
    );

    expect(occurrences).toHaveLength(6);
    expect(occurrences[0].instanceStart).toBe("2026-10-19T10:00:00+03:00");
    expect(occurrences[1].instanceStart).toBe("2026-10-21T10:00:00+03:00");
    expect(occurrences.every((item) => item.seriesId === "test-weekly-1")).toBe(true);
  });

  it("отдаёт только экземпляры внутри запрошенного окна", () => {
    const occurrences = expandOccurrences(
      fixture("weekly.ics"),
      "work",
      new Date("2026-10-19T00:00:00Z"),
      new Date("2026-10-22T00:00:00Z"),
    );

    expect(occurrences).toHaveLength(2);
  });

  it("держит одно и то же местное время через перевод часов", () => {
    const dst = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:dst-1
DTSTAMP:20261001T090000Z
DTSTART;TZID=Europe/Berlin:20261020T100000
DTEND;TZID=Europe/Berlin:20261020T110000
RRULE:FREQ=WEEKLY;COUNT=3
SUMMARY:Еженедельная встреча
END:VEVENT
END:VCALENDAR`;

    const occurrences = expandOccurrences(
      dst,
      "work",
      new Date("2026-10-01T00:00:00Z"),
      new Date("2026-11-30T00:00:00Z"),
    );

    expect(occurrences[0].instanceStart).toBe("2026-10-20T10:00:00+02:00");
    expect(occurrences[2].instanceStart).toBe("2026-11-03T10:00:00+01:00");
  });

  it("возвращает одиночное событие как один экземпляр", () => {
    const occurrences = expandOccurrences(
      fixture("simple.ics"),
      "work",
      new Date("2026-09-01T00:00:00Z"),
      new Date("2026-10-01T00:00:00Z"),
    );

    expect(occurrences).toHaveLength(1);
    expect(occurrences[0].seriesId).toBeUndefined();
  });

  it("не зацикливается на бесконечной серии", () => {
    const endless = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:endless-1
DTSTAMP:20260101T090000Z
DTSTART;TZID=Europe/Moscow:20260105T100000
DTEND;TZID=Europe/Moscow:20260105T110000
RRULE:FREQ=DAILY
SUMMARY:Каждый день
END:VEVENT
END:VCALENDAR`;

    const occurrences = expandOccurrences(
      endless,
      "work",
      new Date("2026-01-01T00:00:00Z"),
      new Date("2026-01-11T00:00:00Z"),
    );

    expect(occurrences).toHaveLength(6);
  });

  // Дополнительный тест сверх брифа (самопроверка задачи 8): ограничение
  // MAX_OCCURRENCES не должно молча срезать законную длинную серию раньше
  // конца запрошенного окна. На прежнем значении 1000 эта ежедневная серия на
  // трёхлетнем окне обрывалась на 1000-м экземпляре (2022-09-26), не доходя
  // до конца окна — тест это ловит.
  it("не срезает длинную ежедневную серию раньше конца окна", () => {
    const daily = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:long-daily-1
DTSTAMP:20200101T090000Z
DTSTART;TZID=Europe/Moscow:20200101T100000
DTEND;TZID=Europe/Moscow:20200101T110000
RRULE:FREQ=DAILY
SUMMARY:Каждый день, долгое окно
END:VEVENT
END:VCALENDAR`;

    const occurrences = expandOccurrences(
      daily,
      "work",
      new Date("2020-01-01T00:00:00Z"),
      new Date("2023-01-01T00:00:00Z"),
    );

    expect(occurrences).toHaveLength(1096);
    expect(occurrences[0].instanceStart).toBe("2020-01-01T10:00:00+03:00");
    expect(occurrences.at(-1)?.instanceStart).toBe("2022-12-31T10:00:00+03:00");
  });

  // Дополнительный тест сверх брифа (самопроверка задачи 8): у события есть
  // повтор, но ни один экземпляр не попадает в запрошенное окно — функция
  // должна вернуть пустой массив, а не бросать исключение и не возвращать
  // исходное (нераскрытое) событие.
  it("возвращает пустой массив, если ни один экземпляр не попадает в окно", () => {
    const threeWeeks = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:no-match-1
DTSTAMP:20260101T090000Z
DTSTART;TZID=Europe/Moscow:20260105T100000
DTEND;TZID=Europe/Moscow:20260105T110000
RRULE:FREQ=WEEKLY;COUNT=3
SUMMARY:Три недели в январе
END:VEVENT
END:VCALENDAR`;

    const occurrences = expandOccurrences(
      threeWeeks,
      "work",
      new Date("2026-06-01T00:00:00Z"),
      new Date("2026-07-01T00:00:00Z"),
    );

    expect(occurrences).toEqual([]);
  });

  // Правка по ревью задачи 8 (Important): счётчик MAX_OCCURRENCES считал
  // КАЖДУЮ итерацию курсора, включая те, что отброшены как лежащие до
  // `from`. У серии, начавшейся задолго до окна (обычная старая еженедельная
  // встреча без UNTIL/COUNT — совершенно рядовой случай), весь бюджет уходил
  // на прокрутку мимо прошлого, и до окна цикл не доходил вовсе. Ревьюер
  // воспроизвёл это на ежедневной бессрочной серии с DTSTART=1990-01-01 и
  // окном "сегодня плюс месяц": функция возвращала ноль экземпляров, хотя
  // событие повторяется каждый день внутри окна.
  it("раскрывает старую бессрочную серию, даже если DTSTART на десятилетия раньше окна", () => {
    const veryOld = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:very-old-daily-1
DTSTAMP:19900101T090000Z
DTSTART;TZID=Europe/Moscow:19900101T100000
DTEND;TZID=Europe/Moscow:19900101T110000
RRULE:FREQ=DAILY
SUMMARY:Ежедневная встреча с 1990 года
END:VEVENT
END:VCALENDAR`;

    // Окно — 30 дней, "сегодня плюс месяц", как в воспроизведении ревьюера.
    const occurrences = expandOccurrences(
      veryOld,
      "work",
      new Date("2026-09-18T00:00:00Z"),
      new Date("2026-10-18T00:00:00Z"),
    );

    expect(occurrences).toHaveLength(30);
    expect(occurrences[0].instanceStart).toBe("2026-09-18T10:00:00+03:00");
    expect(occurrences.at(-1)?.instanceStart).toBe("2026-10-17T10:00:00+03:00");
  });

  // Правка по ревью задачи 8: экземпляр, начавшийся до начала окна, но
  // закончившийся внутри него, обязан попадать в выдачу — эта проверка
  // (`endTime <= from` → continue) должна остаться верной и после починки
  // счётчика итераций выше. DTSTART события — 2015 год (одиннадцать лет до
  // окна), чтобы заодно пройти через тот же длинный путь "прокрутки" вперёд.
  it("отдаёт экземпляр, начавшийся до окна, но закончившийся внутри него", () => {
    const overnightWeekly = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:overnight-weekly-1
DTSTAMP:20150101T090000Z
DTSTART;TZID=Europe/Moscow:20150105T220000
DTEND;TZID=Europe/Moscow:20150106T010000
RRULE:FREQ=WEEKLY;BYDAY=MO
SUMMARY:Ночной созвон по понедельникам
END:VEVENT
END:VCALENDAR`;

    // Экземпляр за 2026-09-14 (понедельник) занимает [19:00Z, 22:00Z).
    // Окно начинается в 20:00Z — уже после старта экземпляра, но до его
    // конца — и заканчивается до следующего понедельника.
    const occurrences = expandOccurrences(
      overnightWeekly,
      "work",
      new Date("2026-09-14T20:00:00Z"),
      new Date("2026-09-15T00:00:00Z"),
    );

    expect(occurrences).toHaveLength(1);
    expect(occurrences[0].instanceStart).toBe("2026-09-14T22:00:00+03:00");
  });

  // Дополнительный тест сверх брифа (см. дисклеймер задачи 8): доказывает, что
  // запасной путь регистрации пояса из вложенного VTIMEZONE действительно
  // срабатывает. TZID "X-Custom/Zone" заведомо отсутствует в базе IANA
  // (@touch4it/ical-timezones отдаёт null), поэтому parseEvent, вызванный до
  // регистрации вложенного VTIMEZONE, бросил бы исключение из registerTimeZone.
  // Раскрытие обязано сначала пройти по вложенным VTIMEZONE и зарегистрировать
  // их, и только потом разбирать событие.
  it("раскрывает событие с нестандартным TZID благодаря вложенному VTIMEZONE", () => {
    const customTz = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VTIMEZONE
TZID:X-Custom/Zone
X-LIC-LOCATION:X-Custom/Zone
BEGIN:STANDARD
TZOFFSETFROM:+0500
TZOFFSETTO:+0500
TZNAME:XCZ
DTSTART:19700101T000000
END:STANDARD
END:VTIMEZONE
BEGIN:VEVENT
UID:custom-tz-1
DTSTAMP:20260101T090000Z
DTSTART;TZID=X-Custom/Zone:20260105T100000
DTEND;TZID=X-Custom/Zone:20260105T110000
RRULE:FREQ=WEEKLY;COUNT=3
SUMMARY:Кастомный пояс
END:VEVENT
END:VCALENDAR`;

    const occurrences = expandOccurrences(
      customTz,
      "work",
      new Date("2026-01-01T00:00:00Z"),
      new Date("2026-02-01T00:00:00Z"),
    );

    expect(occurrences).toHaveLength(3);
    expect(occurrences[0].instanceStart).toBe("2026-01-05T10:00:00+05:00");
    expect(occurrences.every((item) => item.timeZone === "X-Custom/Zone")).toBe(true);
  });
});
