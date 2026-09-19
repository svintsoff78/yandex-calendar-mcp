import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { expandOccurrences, occurrencesOf } from "../../src/ical/expand.js";
import { loadObject } from "../../src/ical/object.js";
import { UnparsableEventError } from "../../src/ical/parse.js";
import type { IcalEnv } from "../../src/ical/values.js";
import type { CalendarEvent } from "../../src/types.js";
import * as seeds from "../support/seeds.js";

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

  // Правка по ревью задачи 8 (Critical, найдено ревью задачи 13):
  // expandOccurrences игнорировал переопределения экземпляров — компоненты
  // VEVENT с тем же UID и свойством RECURRENCE-ID, которыми задача 13
  // записывает правку одного экземпляра серии ("this"). Раскрытие всегда
  // показывало данные основного компонента, то есть старое время/название,
  // даже когда экземпляр был перенесён или переименован на сервере.
  //
  // Сопоставление переопределений сделано через встроенный в ical.js
  // механизм исключений (ICAL.Event сам находит VEVENT-соседей с
  // RECURRENCE-ID через component.parent и связывает их — см.
  // node_modules/ical.js/lib/ical/event.js, конструктор и
  // getOccurrenceDetails()), а не через ручное сопоставление строк.
  it("отдаёт перенесённый экземпляр с новым временем, не трогая остальные", () => {
    const moved = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:series-moved-1
DTSTAMP:20260101T090000Z
DTSTART;TZID=Europe/Moscow:20260105T100000
DTEND;TZID=Europe/Moscow:20260105T110000
RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=4
SUMMARY:Еженедельная планёрка
END:VEVENT
BEGIN:VEVENT
UID:series-moved-1
DTSTAMP:20260101T090000Z
RECURRENCE-ID;TZID=Europe/Moscow:20260112T100000
DTSTART;TZID=Europe/Moscow:20260112T150000
DTEND;TZID=Europe/Moscow:20260112T160000
SUMMARY:Еженедельная планёрка
END:VEVENT
END:VCALENDAR`;

    const occurrences = expandOccurrences(
      moved,
      "work",
      new Date("2026-01-01T00:00:00Z"),
      new Date("2026-02-01T00:00:00Z"),
    );

    expect(occurrences).toHaveLength(4);
    expect(occurrences.every((item) => item.seriesId === "series-moved-1")).toBe(true);

    // Обычные экземпляры: instanceStart и start совпадают.
    expect(occurrences[0].instanceStart).toBe("2026-01-05T10:00:00+03:00");
    expect(occurrences[0].start).toBe("2026-01-05T10:00:00+03:00");
    expect(occurrences[2].instanceStart).toBe("2026-01-19T10:00:00+03:00");
    expect(occurrences[3].instanceStart).toBe("2026-01-26T10:00:00+03:00");

    // Перенесённый экземпляр: instanceStart остаётся исходным RECURRENCE-ID
    // (по нему задачи 13/14 адресуют экземпляр), а start/end — новое время
    // из переопределения.
    expect(occurrences[1].instanceStart).toBe("2026-01-12T10:00:00+03:00");
    expect(occurrences[1].start).toBe("2026-01-12T15:00:00+03:00");
    expect(occurrences[1].end).toBe("2026-01-12T16:00:00+03:00");
  });

  it("отдаёт новый заголовок у переопределённого экземпляра и старый у прочих", () => {
    const retitled = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:series-retitled-1
DTSTAMP:20260101T090000Z
DTSTART;TZID=Europe/Moscow:20260105T100000
DTEND;TZID=Europe/Moscow:20260105T110000
RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=3
SUMMARY:Обычное имя
END:VEVENT
BEGIN:VEVENT
UID:series-retitled-1
DTSTAMP:20260101T090000Z
RECURRENCE-ID;TZID=Europe/Moscow:20260112T100000
DTSTART;TZID=Europe/Moscow:20260112T100000
DTEND;TZID=Europe/Moscow:20260112T110000
SUMMARY:Особое имя для этого дня
END:VEVENT
END:VCALENDAR`;

    const occurrences = expandOccurrences(
      retitled,
      "work",
      new Date("2026-01-01T00:00:00Z"),
      new Date("2026-02-01T00:00:00Z"),
    );

    expect(occurrences).toHaveLength(3);
    expect(occurrences[0].summary).toBe("Обычное имя");
    expect(occurrences[1].summary).toBe("Особое имя для этого дня");
    // Время экземпляра не менялось — RECURRENCE-ID и DTSTART переопределения совпадают.
    expect(occurrences[1].instanceStart).toBe("2026-01-12T10:00:00+03:00");
    expect(occurrences[1].start).toBe("2026-01-12T10:00:00+03:00");
    expect(occurrences[2].summary).toBe("Обычное имя");
  });

  // Требование 5 из ревью: переопределение, чей RECURRENCE-ID указывает на
  // позицию ВНЕ запрошенного окна (поэтому основной проход по курсору до
  // неё не доходит — либо она ещё впереди после точки `to`, либо основной
  // цикл прерывается на ней же), но чей собственный DTSTART/DTEND
  // пересекается с окном, обязано попасть в выдачу. Без отдельного прохода
  // по всем известным переопределениям (см. src/ical/expand.ts) это
  // невозможно в принципе: основной цикл прерывается, едва дойдя до
  // ОРИГИНАЛЬНОЙ позиции 2026-01-19, ни разу не заглянув в её переопределение.
  it("отдаёт экземпляр, перенесённый из-за пределов окна внутрь него", () => {
    const movedIn = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:series-moved-in-1
DTSTAMP:20260101T090000Z
DTSTART;TZID=Europe/Moscow:20260105T100000
DTEND;TZID=Europe/Moscow:20260105T110000
RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=3
SUMMARY:Еженедельная встреча
END:VEVENT
BEGIN:VEVENT
UID:series-moved-in-1
DTSTAMP:20260101T090000Z
RECURRENCE-ID;TZID=Europe/Moscow:20260119T100000
DTSTART;TZID=Europe/Moscow:20260114T090000
DTEND;TZID=Europe/Moscow:20260114T100000
SUMMARY:Перенесли пораньше
END:VEVENT
END:VCALENDAR`;

    // Узкое окно: без переопределения в него попал бы только экземпляр за
    // 2026-01-12 (2026-01-05 раньше окна, 2026-01-19 позже окна). Но
    // переопределение переносит "экземпляр за 2026-01-19" на 2026-01-14 —
    // внутрь окна.
    const occurrences = expandOccurrences(
      movedIn,
      "work",
      new Date("2026-01-08T00:00:00Z"),
      new Date("2026-01-16T00:00:00Z"),
    );

    expect(occurrences).toHaveLength(2);
    expect(occurrences[0].instanceStart).toBe("2026-01-12T10:00:00+03:00");
    expect(occurrences[0].start).toBe("2026-01-12T10:00:00+03:00");
    expect(occurrences[1].instanceStart).toBe("2026-01-19T10:00:00+03:00");
    expect(occurrences[1].start).toBe("2026-01-14T09:00:00+03:00");
    expect(occurrences[1].summary).toBe("Перенесли пораньше");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// З09: чтение без призраков (Р3–Р7, Р10 плана переделки,
// docs/superpowers/plans/2026-09-19-recurring-events-rework.md). Роли
// переопределений — ровно три, по поправке «без ремонта следов прежнего
// кода»: slot, hidden, detached. Ожидания — строки ISO со смещением, так что
// тесты не зависят от пояса процесса (npm run test:tz).
// ─────────────────────────────────────────────────────────────────────────────

const CRLF = "\r\n";
const UID = "expand-z09@yandex.ru";
const MSK: IcalEnv = { floatingZone: "Europe/Moscow" };

const MOSCOW_ZONE = [
  "BEGIN:VTIMEZONE", "TZID:Europe/Moscow", "BEGIN:STANDARD", "TZNAME:MSK", "TZOFFSETFROM:+0300",
  "TZOFFSETTO:+0300", "DTSTART:19700101T000000", "END:STANDARD", "END:VTIMEZONE",
];
const BERLIN_ZONE = [
  "BEGIN:VTIMEZONE", "TZID:Europe/Berlin",
  "BEGIN:DAYLIGHT", "TZOFFSETFROM:+0100", "TZOFFSETTO:+0200", "TZNAME:CEST", "DTSTART:19700329T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU", "END:DAYLIGHT",
  "BEGIN:STANDARD", "TZOFFSETFROM:+0200", "TZOFFSETTO:+0100", "TZNAME:CET", "DTSTART:19701025T030000",
  "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU", "END:STANDARD", "END:VTIMEZONE",
];

/** Пн и Ср 10:00–11:00 МСК с 19.10.2026: 19, 21, 26, 28 окт., 2, 4 нояб. при COUNT=6. */
const WEEKLY = ["DTSTART;TZID=Europe/Moscow:20261019T100000", "DTEND;TZID=Europe/Moscow:20261019T110000",
  "SUMMARY:Планёрка"];
const COUNT6 = "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6";

function vevent(lines: string[], uid = UID): string[] {
  return ["BEGIN:VEVENT", `UID:${uid}`, "DTSTAMP:20261001T090000Z", ...lines, "END:VEVENT"];
}

function calendarOf(zones: string[], ...events: string[][]): string {
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//expand//RU", ...zones, ...events.flat(), "END:VCALENDAR"]
    .join(CRLF) + CRLF;
}

/** Переопределение в поясе Москвы: RID, начало и конец — стенное время МСК. */
function override(rid: string, start: string, end: string, ...extra: string[]): string[] {
  return vevent([`RECURRENCE-ID;TZID=Europe/Moscow:${rid}`, `DTSTART;TZID=Europe/Moscow:${start}`,
    `DTEND;TZID=Europe/Moscow:${end}`, ...extra]);
}

/** Встреча строкой: «адрес → начало/конец заголовок [флаги]»; стенное время — как в выдаче. */
function line(event: CalendarEvent): string {
  const flags = [
    ...(event.moved ? ["moved"] : []),
    ...(event.detached ? ["detached"] : []),
    ...(event.status ? [event.status] : []),
  ];
  return `${event.instanceStart ?? "-"} → ${event.start}/${event.end} ${event.summary}${flags.length ? ` [${flags.join(", ")}]` : ""}`;
}

function expand(ics: string, from: string, to: string, env: IcalEnv = MSK): CalendarEvent[] {
  return expandOccurrences(ics, "work", new Date(from), new Date(to), '"etag-z09"', env);
}

function lines(ics: string, from = "2026-10-01T00:00:00+03:00", to = "2026-12-01T00:00:00+03:00", env: IcalEnv = MSK): string[] {
  return expand(ics, from, to, env).map(line);
}

const slot = (day: string, summary = "Планёрка") => `${day}T10:00:00+03:00 → ${day}T10:00:00+03:00/${day}T11:00:00+03:00 ${summary}`;
const SIX = ["2026-10-19", "2026-10-21", "2026-10-26", "2026-10-28", "2026-11-02", "2026-11-04"];

describe("expandOccurrences: переопределения по ролям slot, hidden, detached (Р5, Р6)", () => {
  // R8-N1 (вид C): так остаётся после «delete t&f» у серии с переопределением
  // дальше границы. Прежний проход «по всем исключениям» показывал сироту.
  it("переопределение после конца серии (UNTIL) не показывается", () => {
    const ics = calendarOf(MOSCOW_ZONE,
      vevent([...WEEKLY, "RRULE:FREQ=WEEKLY;UNTIL=20261026T065959Z;BYDAY=MO,WE"]),
      override("20261102T100000", "20261102T100000", "20261102T110000", "SUMMARY:Итоговая встреча"));

    expect(lines(ics)).toEqual([slot("2026-10-19"), slot("2026-10-21")]);
  });

  // R8-N1 (вид B): EXDATE поставлен, а переопределение того же слота осталось.
  it("переопределение под EXDATE (и под дублем EXDATE) не показывается", () => {
    const ics = calendarOf(MOSCOW_ZONE,
      vevent([...WEEKLY, COUNT6, "EXDATE;TZID=Europe/Moscow:20261021T100000", "EXDATE;TZID=Europe/Moscow:20261021T100000"]),
      override("20261021T100000", "20261021T100000", "20261021T110000", "SUMMARY:Особая планёрка"));

    expect(lines(ics)).toEqual(SIX.filter((day) => day !== "2026-10-21").map((day) => slot(day)));
  });

  it("переопределение раньше первой встречи серии не показывается", () => {
    const ics = calendarOf(MOSCOW_ZONE,
      vevent([...WEEKLY, COUNT6]),
      override("20261012T100000", "20261023T100000", "20261023T110000", "SUMMARY:До начала серии"));

    expect(lines(ics)).toEqual(SIX.map((day) => slot(day)));
  });

  // R8-N3, Р6, Ж3: приглашение на одну встречу чужой серии — объект без основного компонента.
  it("объект из одних переопределений виден: каждая встреча — detached по своему RECURRENCE-ID", () => {
    const ics = calendarOf(MOSCOW_ZONE,
      override("20261021T100000", "20261021T100000", "20261021T110000", "SUMMARY:Приглашение"),
      override("20261028T100000", "20261028T150000", "20261028T160000", "SUMMARY:Приглашение (перенесено)"));

    const events = expand(ics, "2026-10-01T00:00:00+03:00", "2026-12-01T00:00:00+03:00");
    expect(events.map(line)).toEqual([
      "2026-10-21T10:00:00+03:00 → 2026-10-21T10:00:00+03:00/2026-10-21T11:00:00+03:00 Приглашение [detached]",
      "2026-10-28T10:00:00+03:00 → 2026-10-28T15:00:00+03:00/2026-10-28T16:00:00+03:00 Приглашение (перенесено) [moved, detached]",
    ]);
    expect(events.every((event) => event.id === UID && event.seriesId === UID && event.recurring === true)).toBe(true);
  });

  // C64: RECURRENCE-ID в дату слота, но не в его время, — detached; в этот день две встречи.
  it("detached в дату слота показывается отдельной встречей рядом со слотом, с detached: true", () => {
    const events = expand(seeds.detachedOnSlotDate.ics, "2026-10-21T00:00:00+03:00", "2026-10-22T00:00:00+03:00");

    expect(events.map(line)).toEqual([
      "2026-10-21T09:00:00+03:00 → 2026-10-21T09:00:00+03:00/2026-10-21T10:00:00+03:00 Планёрка",
      "2026-10-21T10:00:00+03:00 → 2026-10-21T11:30:00+03:00/2026-10-21T12:30:00+03:00 Планёрка [moved, detached]",
    ]);
  });

  it("переопределение, чей RECURRENCE-ID равен началу другого, показывается один раз, без дублей", () => {
    // Законный цикл переносов: 21.10 перенесена на 15:00, отдельно есть
    // detached с RECURRENCE-ID 21.10 15:00. Каждый компонент — ровно одна встреча.
    const events = expand(seeds.detachedAtMovedStart.ics, "2026-10-21T00:00:00+03:00", "2026-10-22T00:00:00+03:00");

    expect(events.map(line)).toEqual([
      "2026-10-21T10:00:00+03:00 → 2026-10-21T15:00:00+03:00/2026-10-21T16:00:00+03:00 Планёрка [moved]",
      "2026-10-21T15:00:00+03:00 → 2026-10-21T15:00:00+03:00/2026-10-21T16:00:00+03:00 Планёрка (перенесена) [detached]",
    ]);
  });

  // R8-N5, C33: сопоставление RECURRENCE-ID со слотом — по моменту (О3), а не по строке.
  it("RECURRENCE-ID в поясе Berlin у серии в Москве — одна встреча по адресу слота +03:00", () => {
    const ics = calendarOf([...MOSCOW_ZONE, ...BERLIN_ZONE],
      vevent([...WEEKLY, COUNT6]),
      vevent(["RECURRENCE-ID;TZID=Europe/Berlin:20261021T090000", "DTSTART;TZID=Europe/Moscow:20261021T113000",
        "DTEND;TZID=Europe/Moscow:20261021T123000", "SUMMARY:Планёрка (перенесена)"]));

    expect(lines(ics, "2026-10-21T00:00:00+03:00", "2026-10-22T00:00:00+03:00")).toEqual([
      "2026-10-21T10:00:00+03:00 → 2026-10-21T11:30:00+03:00/2026-10-21T12:30:00+03:00 Планёрка (перенесена) [moved]",
    ]);
  });

  it("из дублей одного RECURRENCE-ID показывается один — с большим SEQUENCE", () => {
    const ics = calendarOf(MOSCOW_ZONE,
      vevent([...WEEKLY, COUNT6]),
      override("20261021T100000", "20261021T120000", "20261021T130000", "SUMMARY:Вторая правка", "SEQUENCE:2"),
      override("20261021T100000", "20261021T110000", "20261021T120000", "SUMMARY:Первая правка", "SEQUENCE:1"));

    expect(lines(ics, "2026-10-21T00:00:00+03:00", "2026-10-22T00:00:00+03:00")).toEqual([
      "2026-10-21T10:00:00+03:00 → 2026-10-21T12:00:00+03:00/2026-10-21T13:00:00+03:00 Вторая правка [moved]",
    ]);
  });
});

describe("expandOccurrences: окно и порядок по фактическому времени (R8, мутанты M1 и M2)", () => {
  const movedOut = calendarOf(MOSCOW_ZONE,
    vevent([...WEEKLY, COUNT6]),
    override("20261021T100000", "20261105T130000", "20261105T140000", "SUMMARY:Перенесена наружу"),
    override("20261028T100000", "20261020T120000", "20261020T130000", "SUMMARY:Перенесена раньше соседа"));

  // M1: окно по слоту, а не по фактическому началу.
  it("слот в окне, фактическое начало вне окна — встречи в выдаче нет, призрака слота тоже", () => {
    expect(lines(movedOut, "2026-10-21T00:00:00+03:00", "2026-10-22T00:00:00+03:00")).toEqual([]);
  });

  // M2: сортировка по слоту.
  it("встреча, перенесённая раньше соседа, стоит по фактическому началу; адрес — прежний слот", () => {
    expect(lines(movedOut)).toEqual([
      slot("2026-10-19"),
      "2026-10-28T10:00:00+03:00 → 2026-10-20T12:00:00+03:00/2026-10-20T13:00:00+03:00 Перенесена раньше соседа [moved]",
      slot("2026-10-26"),
      slot("2026-11-02"),
      slot("2026-11-04"),
      "2026-10-21T10:00:00+03:00 → 2026-11-05T13:00:00+03:00/2026-11-05T14:00:00+03:00 Перенесена наружу [moved]",
    ]);
  });
});

describe("expandOccurrences: отмена, RANGE, RDATE (Р7, О2)", () => {
  it("отменённое переопределение показывается со status: cancelled", () => {
    const ics = calendarOf(MOSCOW_ZONE,
      vevent([...WEEKLY, COUNT6]),
      override("20261021T100000", "20261021T100000", "20261021T110000", "SUMMARY:Планёрка", "STATUS:CANCELLED"));

    expect(lines(ics, "2026-10-19T00:00:00+03:00", "2026-10-22T00:00:00+03:00")).toEqual([
      slot("2026-10-19"),
      `${slot("2026-10-21")} [cancelled]`,
    ]);
  });

  it("отменённое одиночное событие показывается со status: cancelled", () => {
    const ics = calendarOf(MOSCOW_ZONE, vevent([...WEEKLY, "STATUS:CANCELLED"]));

    expect(lines(ics)).toEqual(["- → 2026-10-19T10:00:00+03:00/2026-10-19T11:00:00+03:00 Планёрка [cancelled]"]);
  });

  // R8-N (Minor, сценарий F), C32: у следующих встреч прежний код показывал начало самого переопределения.
  it("RANGE=THISANDFUTURE сдвигает свою встречу и все следующие, у каждой — свой адрес", () => {
    const ics = calendarOf(MOSCOW_ZONE,
      vevent([...WEEKLY, "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=4"]),
      vevent(["RECURRENCE-ID;RANGE=THISANDFUTURE;TZID=Europe/Moscow:20261021T100000",
        "DTSTART;TZID=Europe/Moscow:20261021T120000", "DTEND;TZID=Europe/Moscow:20261021T130000", "SUMMARY:Позже"]));

    expect(lines(ics)).toEqual([
      slot("2026-10-19"),
      "2026-10-21T10:00:00+03:00 → 2026-10-21T12:00:00+03:00/2026-10-21T13:00:00+03:00 Позже [moved]",
      "2026-10-26T10:00:00+03:00 → 2026-10-26T12:00:00+03:00/2026-10-26T13:00:00+03:00 Позже [moved]",
      "2026-10-28T10:00:00+03:00 → 2026-10-28T12:00:00+03:00/2026-10-28T13:00:00+03:00 Позже [moved]",
    ]);
  });

  // О2: слоты = DTSTART ∪ RDATE; прежний код (RecurExpansion) терял встречу DTSTART.
  it("серия из RDATE: встреча DTSTART и встречи RDATE, с адресами", () => {
    const ics = calendarOf(MOSCOW_ZONE,
      vevent([...WEEKLY, "RDATE;TZID=Europe/Moscow:20261022T100000,20261027T100000"]));

    const events = expand(ics, "2026-10-01T00:00:00+03:00", "2026-12-01T00:00:00+03:00");
    expect(events.map(line)).toEqual([slot("2026-10-19"), slot("2026-10-22"), slot("2026-10-27")]);
    expect(events.every((event) => event.recurring === true && event.seriesId === UID)).toBe(true);
    expect(events[0].recurrenceRule).toBe("RDATE;TZID=Europe/Moscow:20261022T100000,20261027T100000");
  });

  it("RDATE;VALUE=PERIOD — встреча со своим концом, прежний код падал", () => {
    const ics = calendarOf(MOSCOW_ZONE,
      vevent([...WEEKLY, "RDATE;VALUE=PERIOD;TZID=Europe/Moscow:20261022T100000/PT3H"]));

    expect(lines(ics)).toEqual([
      slot("2026-10-19"),
      "2026-10-22T10:00:00+03:00 → 2026-10-22T10:00:00+03:00/2026-10-22T13:00:00+03:00 Планёрка",
    ]);
  });
});

describe("expandOccurrences: неразбираемое не роняет чтение (Р4)", () => {
  it.each([seeds.c63BadFreq, seeds.c63BadByday])("$about — заглушка с UID, SUMMARY, DTSTART и аномалией unparsable", (seed) => {
    const events = expand(seed.ics, "2026-10-01T00:00:00+03:00", "2026-12-01T00:00:00+03:00");

    expect(events).toHaveLength(1);
    const [stub] = events;
    expect(stub).toMatchObject({
      id: seed.uid,
      calendarId: "work",
      start: "2026-10-19T10:00:00+03:00",
      timeZone: "Europe/Moscow",
      allDay: false,
      etag: '"etag-z09"',
      reminders: [],
      attendees: [],
    });
    expect(stub.summary).toBe(seed.ics.match(/SUMMARY:(.*)\r\n/)![1]);
    expect(stub.anomalies?.[0]).toMatch(/^unparsable: /);
    expect(stub.instanceStart).toBeUndefined();
  });

  it("заглушка не зависит от окна: встреч в окне не перебрать, прятать объект нельзя", () => {
    const events = expand(seeds.c63BadFreq.ics, "2028-01-01T00:00:00Z", "2028-02-01T00:00:00Z");

    expect(events.map((event) => event.id)).toEqual([seeds.c63BadFreq.uid]);
  });

  it("DTSTART заглушки: дата — весь день в поясе календаря, UTC, плавающее — в поясе календаря", () => {
    const bad = (dtstart: string) => calendarOf([], vevent([dtstart, "RRULE:FREQ=FOO", "SUMMARY:Плохое правило"]));

    expect(expand(bad("DTSTART;VALUE=DATE:20261021"), "2026-10-01T00:00:00Z", "2026-11-01T00:00:00Z")[0]).toMatchObject({
      start: "2026-10-21T00:00:00+03:00",
      end: "2026-10-22T00:00:00+03:00",
      allDay: true,
      timeZone: "Europe/Moscow",
    });
    expect(expand(bad("DTSTART:20261021T070000Z"), "2026-10-01T00:00:00Z", "2026-11-01T00:00:00Z")[0]).toMatchObject({
      start: "2026-10-21T07:00:00+00:00",
      allDay: false,
      timeZone: "UTC",
    });
    expect(expand(bad("DTSTART:20261021T100000"), "2026-10-01T00:00:00Z", "2026-11-01T00:00:00Z")[0]).toMatchObject({
      start: "2026-10-21T10:00:00+03:00",
      timeZone: "Europe/Moscow",
    });
    expect(expand(bad("DTSTART;TZID=Europe/Berlin:20261021T100000"), "2026-10-01T00:00:00Z", "2026-11-01T00:00:00Z")[0]).toMatchObject({
      start: "2026-10-21T10:00:00+02:00",
      end: "2026-10-21T10:00:00+02:00",
      timeZone: "Europe/Berlin",
    });
    expect(expand(bad('DTSTART;TZID="Europe/Berlin":20261026T100000'), "2026-10-01T00:00:00Z", "2026-11-01T00:00:00Z")[0].start)
      .toBe("2026-10-26T10:00:00+01:00");
    const unknownZone = expand(bad("DTSTART;TZID=Mars/Olympus:20261021T100000"), "2026-10-01T00:00:00Z", "2026-11-01T00:00:00Z")[0];
    expect(unknownZone.start).toBe("2026-10-21T10:00:00+03:00");
    expect(unknownZone.anomalies?.some((a) => a.startsWith("unknown-tzid: ") && a.includes("Mars/Olympus"))).toBe(true);
  });

  it("нечитаемый DTSTART — отказ с кодом unparsable и UID, а не встреча с выдуманным временем", () => {
    const ics = calendarOf([], vevent(["DTSTART;TZID=Europe/Moscow:вчера", "RRULE:FREQ=FOO", "SUMMARY:Совсем плохо"], "broken-z09@yandex.ru"));

    let caught: unknown;
    try {
      expand(ics, "2026-10-01T00:00:00Z", "2026-11-01T00:00:00Z");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UnparsableEventError);
    expect(caught).toMatchObject({ code: "unparsable", uid: "broken-z09@yandex.ru" });
    expect((caught as Error).message).toContain("broken-z09@yandex.ru");
  });

  it("правило, которое ical.js не перебирает (bad-rrule), — одна встреча DTSTART с аномалией", () => {
    const ics = calendarOf(MOSCOW_ZONE, vevent([...WEEKLY, "RRULE:FREQ=MONTHLY;BYWEEKNO=2"]));

    const events = expand(ics, "2026-10-01T00:00:00+03:00", "2027-12-01T00:00:00+03:00");
    expect(events.map(line)).toEqual([slot("2026-10-19")]);
    expect(events[0].anomalies?.[0]).toMatch(/^bad-rrule: /);
  });

  // Ревью З09: окно через месяц после DTSTART. Встречи DTSTART в окне нет, а
  // какие встречи назначило правило, неизвестно. Прежде выдача была пустой:
  // list_events молча не показывал объект, find_free_slots считал время
  // свободным.
  describe("bad-rrule, окно позже DTSTART — заглушка основного компонента, а не пустая выдача", () => {
    const badRule = calendarOf(MOSCOW_ZONE, vevent([...WEEKLY, "RRULE:FREQ=MONTHLY;BYWEEKNO=2"]));

    it("окно через месяц после DTSTART: заглушка с DTSTART, bad-rrule и unexpanded, без адреса", () => {
      const events = expand(badRule, "2026-11-01T00:00:00+03:00", "2026-12-01T00:00:00+03:00");

      expect(events).toHaveLength(1);
      const [stub] = events;
      expect(stub).toMatchObject({
        id: UID,
        calendarId: "work",
        summary: "Планёрка",
        start: "2026-10-19T10:00:00+03:00",
        end: "2026-10-19T11:00:00+03:00",
        etag: '"etag-z09"',
        recurring: true,
      });
      expect(stub.instanceStart).toBeUndefined();
      expect(stub.exceptions).toBeUndefined();
      expect(stub.anomalies?.[0]).toMatch(/^bad-rrule: /);
      expect(stub.anomalies?.some((a) => a.startsWith("unexpanded: "))).toBe(true);
    });

    it("окно раньше DTSTART — пусто: правило встреч раньше DTSTART не назначает", () => {
      expect(expand(badRule, "2026-09-01T00:00:00+03:00", "2026-10-19T10:00:00+03:00")).toEqual([]);
    });

    it("встреча DTSTART закрыта EXDATE — заглушка и в окне с DTSTART: объект не пропадает", () => {
      const excluded = calendarOf(MOSCOW_ZONE,
        vevent([...WEEKLY, "RRULE:FREQ=MONTHLY;BYWEEKNO=2", "EXDATE;TZID=Europe/Moscow:20261019T100000"]));

      const events = expand(excluded, "2026-10-01T00:00:00+03:00", "2026-12-01T00:00:00+03:00");
      expect(events.map((event) => [event.start, event.instanceStart])).toEqual([["2026-10-19T10:00:00+03:00", undefined]]);
      expect(events[0].anomalies?.some((a) => a.startsWith("bad-rrule: "))).toBe(true);
    });

    // object.ts помечает сломанный EXRULE как bad-rrule, и тогда не читается и
    // RRULE (slots.ts, specOf): встречи 02.11 и 04.11 неизвестны.
    it("сломанный EXRULE: окно после DTSTART — тоже заглушка, а не пустая выдача", () => {
      const brokenExrule = calendarOf(MOSCOW_ZONE, vevent([...WEEKLY, COUNT6, "EXRULE:FREQ=MONTHLY;BYWEEKNO=2"]));

      const events = expand(brokenExrule, "2026-11-01T00:00:00+03:00", "2026-12-01T00:00:00+03:00");
      expect(events.map((event) => [event.start, event.instanceStart])).toEqual([["2026-10-19T10:00:00+03:00", undefined]]);
      expect(events[0].anomalies?.some((a) => a.startsWith("bad-rrule: "))).toBe(true);
    });
  });

  // Перепроверка ревью З09. При bad-rrule серия выглядит конечной из одной
  // встречи DTSTART, и assignRoles (object.ts) прячет переопределение с
  // RECURRENCE-ID позже DTSTART как «вне серии», хотя протяжённость серии
  // неизвестна. Если такое переопределение перенесено раньше DTSTART, прежде
  // выдача окна раньше DTSTART была пустой: list_events молча не показывал
  // объект, а find_free_slots отдавал занятое время как свободное. Саму
  // встречу показать нельзя — роль ей назначает object.ts (чужой файл); здесь
  // объект виден заглушкой, и время по нему не считается свободным.
  describe("bad-rrule: скрытое «вне серии» переопределение раньше DTSTART — заглушка и в окне раньше DTSTART", () => {
    /** Серия с плохим правилом (DTSTART 19.10 10:00 МСК) и переопределением с RID `rid`, перенесённым на `start`–`end` 15.10. */
    const withMoved = (rid: string, start = "20261015T120000", end = "20261015T130000") =>
      calendarOf(MOSCOW_ZONE,
        vevent([...WEEKLY, "RRULE:FREQ=MONTHLY;BYWEEKNO=2"]),
        override(rid, start, end, "SUMMARY:Перенесена раньше начала"));

    it("окно 15.10, раньше DTSTART: заглушка основного компонента с bad-rrule, а не пустая выдача", () => {
      const events = expand(withMoved("20261021T100000"), "2026-10-15T00:00:00+03:00", "2026-10-16T00:00:00+03:00");

      expect(events.map(line)).toEqual([
        "- → 2026-10-19T10:00:00+03:00/2026-10-19T11:00:00+03:00 Планёрка",
      ]);
      expect(events[0].anomalies?.[0]).toMatch(/^bad-rrule: /);
      expect(events[0].anomalies?.some((a) => a.startsWith("unexpanded: "))).toBe(true);
    });

    it("окно кончается раньше собственного начала перенесённой — пусто: неизвестного в нём нет", () => {
      expect(expand(withMoved("20261021T100000"), "2026-10-14T00:00:00+03:00", "2026-10-15T00:00:00+03:00")).toEqual([]);
    });

    it("RECURRENCE-ID раньше DTSTART скрыт надёжно: правило встреч раньше DTSTART не назначает", () => {
      // RID 12.10 раньше DTSTART 19.10 — скрыт как «раньше первой встречи»,
      // и это от правила не зависит; собственное время 15.10 встречей не стало.
      expect(expand(withMoved("20261012T100000"), "2026-10-15T00:00:00+03:00", "2026-10-16T00:00:00+03:00")).toEqual([]);
    });

    it("скрытое под EXDATE окна раньше DTSTART не открывает: EXDATE от правила не зависит", () => {
      const excluded = calendarOf(MOSCOW_ZONE,
        vevent([...WEEKLY, "RRULE:FREQ=MONTHLY;BYWEEKNO=2", "EXDATE;TZID=Europe/Moscow:20261021T100000"]),
        override("20261021T100000", "20261015T120000", "20261015T130000", "SUMMARY:Под EXDATE"));

      expect(expand(excluded, "2026-10-15T00:00:00+03:00", "2026-10-16T00:00:00+03:00")).toEqual([]);
    });
  });

  it("серия длиннее предела перебора до окна — заглушка основного компонента с аномалией unexpanded, а не пустая выдача", () => {
    // SECONDLY с 01.10: до окна 06.10 больше 200 000 слотов (SERIES_CAP, slots.ts).
    const ics = calendarOf([], vevent(["DTSTART:20261001T000000Z", "DURATION:PT1S", "RRULE:FREQ=SECONDLY", "SUMMARY:Датчик"], "secondly-z09@yandex.ru"));

    const events = expand(ics, "2026-10-06T00:00:00Z", "2026-10-06T00:00:10Z");
    expect(events).toHaveLength(1);
    const [stub] = events;
    expect(stub).toMatchObject({ id: "secondly-z09@yandex.ru", start: "2026-10-01T00:00:00+00:00", summary: "Датчик", recurring: true });
    expect(stub.instanceStart).toBeUndefined();
    expect(stub.exceptions).toBeUndefined();
    expect(stub.anomalies?.some((a) => a.startsWith("unexpanded: "))).toBe(true);
  }, 30_000);

  // Ревью З09: при SlotScanError встречи со своим компонентом известны точно —
  // их время записано в компоненте. Прежде выдавалась одна заглушка, и
  // перенесённая в окно встреча пропадала из list_events.
  it("unexpanded: вместе с заглушкой — встречи переопределений, чьё время в окне; скрытое — нет", () => {
    // HOURLY с 2000 года: до окна 21.10.2026 больше 200 000 слотов (SERIES_CAP).
    const hourly = "hourly-z09@yandex.ru";
    const ics = calendarOf([],
      vevent(["DTSTART:20000101T000000Z", "DURATION:PT30M", "RRULE:FREQ=HOURLY", "EXDATE:20261021T110000Z",
        "SUMMARY:Каждый час"], hourly),
      vevent(["RECURRENCE-ID:20261021T100000Z", "DTSTART:20261021T123000Z", "DTEND:20261021T130000Z",
        "SUMMARY:Перенесена в окно"], hourly),
      // Под EXDATE — hidden: время в окне, но встречи нет.
      vevent(["RECURRENCE-ID:20261021T110000Z", "DTSTART:20261021T124000Z", "DTEND:20261021T125000Z",
        "SUMMARY:Под EXDATE"], hourly),
      vevent(["RECURRENCE-ID:20261022T100000Z", "DTSTART:20261022T100000Z", "DTEND:20261022T103000Z",
        "SUMMARY:Вне окна"], hourly));

    const events = expand(ics, "2026-10-21T12:00:00Z", "2026-10-21T13:00:00Z");
    expect(events.map((event) => `${event.instanceStart ?? "-"} → ${event.start}/${event.end} ${event.summary}`)).toEqual([
      "- → 2000-01-01T00:00:00+00:00/2000-01-01T00:30:00+00:00 Каждый час",
      "2026-10-21T10:00:00+00:00 → 2026-10-21T12:30:00+00:00/2026-10-21T13:00:00+00:00 Перенесена в окно",
    ]);
    expect(events[0].anomalies?.some((a) => a.startsWith("unexpanded: "))).toBe(true);
    expect(events[1]).toMatchObject({ moved: true, seriesId: hourly });
  }, 30_000);
});

describe("expandOccurrences: напоминания — только те, что модель умеет вернуть (О9)", () => {
  it("DISPLAY и EMAIL с TRIGGER от начала видны; от конца, AUDIO и абсолютный TRIGGER — нет", () => {
    const alarm = (...lines: string[]) => ["BEGIN:VALARM", ...lines, "DESCRIPTION:Напоминание", "END:VALARM"];
    const ics = calendarOf(MOSCOW_ZONE, vevent([...WEEKLY,
      ...alarm("ACTION:DISPLAY", "TRIGGER:-PT15M"),
      ...alarm("ACTION:EMAIL", "TRIGGER;RELATED=START:-PT1H"),
      ...alarm("ACTION:DISPLAY", "TRIGGER;RELATED=END:-PT5M"),
      ...alarm("ACTION:AUDIO", "TRIGGER:-PT10M"),
      ...alarm("ACTION:EMAIL", "TRIGGER;VALUE=DATE-TIME:20261019T063000Z"),
    ]));

    const [event] = expand(ics, "2026-10-01T00:00:00+03:00", "2026-12-01T00:00:00+03:00");
    expect(event.reminders).toEqual([
      { minutesBefore: 15, method: "display" },
      { minutesBefore: 60, method: "email" },
    ]);
  });

  it("у переопределения — его собственные напоминания по тем же правилам", () => {
    const ics = calendarOf(MOSCOW_ZONE,
      vevent([...WEEKLY, COUNT6, "BEGIN:VALARM", "ACTION:DISPLAY", "TRIGGER:-PT15M", "END:VALARM"]),
      override("20261021T100000", "20261021T100000", "20261021T110000", "SUMMARY:Планёрка",
        "BEGIN:VALARM", "ACTION:DISPLAY", "TRIGGER;RELATED=END:PT0S", "END:VALARM",
        "BEGIN:VALARM", "ACTION:EMAIL", "TRIGGER:-PT30M", "END:VALARM"));

    const events = expand(ics, "2026-10-19T00:00:00+03:00", "2026-10-22T00:00:00+03:00");
    expect(events.map((event) => event.reminders)).toEqual([
      [{ minutesBefore: 15, method: "display" }],
      [{ minutesBefore: 30, method: "email" }],
    ]);
  });
});

describe("expandOccurrences: пояс календаря для дат и плавающего времени (env)", () => {
  const allDay = readFileSync("tests/fixtures/allday.ics", "utf8");
  const floating = calendarOf([], vevent(["DTSTART:20261019T100000", "DTEND:20261019T110000", "SUMMARY:Плавающее"]));

  it("весь день: полночь пояса календаря; без env — прежнее чтение в UTC", () => {
    expect(expand(allDay, "2026-09-01T00:00:00Z", "2026-10-01T00:00:00Z")[0]).toMatchObject({
      start: "2026-09-23T00:00:00+03:00",
      end: "2026-09-24T00:00:00+03:00",
      timeZone: "Europe/Moscow",
      allDay: true,
    });
    expect(expandOccurrences(allDay, "work", new Date("2026-09-01T00:00:00Z"), new Date("2026-10-01T00:00:00Z"))[0]).toMatchObject({
      start: "2026-09-23T00:00:00+00:00",
      timeZone: "UTC",
    });
  });

  it("плавающее время — стенное время пояса календаря", () => {
    expect(expand(floating, "2026-10-01T00:00:00Z", "2026-11-01T00:00:00Z")[0]).toMatchObject({
      start: "2026-10-19T10:00:00+03:00",
      end: "2026-10-19T11:00:00+03:00",
      timeZone: "Europe/Moscow",
    });
  });

  it("окно для встречи на весь день — по суткам пояса календаря", () => {
    // 23.09 в Москве — [22.09 21:00Z, 23.09 21:00Z). Окно с 23.09 21:30Z его не задевает.
    expect(expand(allDay, "2026-09-23T21:30:00Z", "2026-09-24T12:00:00Z")).toEqual([]);
    expect(expand(allDay, "2026-09-22T21:30:00Z", "2026-09-22T22:00:00Z")).toHaveLength(1);
  });
});

describe("occurrencesOf: уже загруженный объект (для readEvents, З13)", () => {
  it("встречи окна с href и etag из meta; неразбираемый объект — заглушка", () => {
    const loaded = loadObject(seeds.weeklyMoscow.ics, MSK);
    const meta = { calendarId: "work", etag: "7", href: "/calendars/u/events/w.ics" };

    const events = occurrencesOf(loaded, Date.parse("2026-10-19T00:00:00+03:00"), Date.parse("2026-10-22T00:00:00+03:00"), meta, MSK);
    expect(events.map((event) => [event.instanceStart, event.href, event.etag])).toEqual([
      ["2026-10-19T10:00:00+03:00", meta.href, "7"],
      ["2026-10-21T10:00:00+03:00", meta.href, "7"],
    ]);

    const stub = occurrencesOf(loadObject(seeds.c63BadByday.ics, MSK), 0, 1, meta, MSK);
    expect(stub.map((event) => [event.id, event.href])).toEqual([[seeds.c63BadByday.uid, meta.href]]);
  });
});
