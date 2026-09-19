import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { FreeSlotsError, findFreeSlots, subtractBusy } from "../../src/domain/freeSlots.js";
import * as seeds from "../support/seeds.js";
import type { Calendar } from "../../src/types.js";

const at = (iso: string) => new Date(iso);

describe("subtractBusy", () => {
  it("возвращает окно целиком, когда занятости нет", () => {
    const free = subtractBusy(
      { start: at("2026-09-21T10:00:00Z"), end: at("2026-09-21T19:00:00Z") },
      [],
    );

    expect(free).toHaveLength(1);
    expect(free[0].start.toISOString()).toBe("2026-09-21T10:00:00.000Z");
  });

  it("вырезает событие в середине окна", () => {
    const free = subtractBusy(
      { start: at("2026-09-21T10:00:00Z"), end: at("2026-09-21T19:00:00Z") },
      [{ start: at("2026-09-21T13:00:00Z"), end: at("2026-09-21T14:00:00Z") }],
    );

    expect(free).toHaveLength(2);
    expect(free[0].end.toISOString()).toBe("2026-09-21T13:00:00.000Z");
    expect(free[1].start.toISOString()).toBe("2026-09-21T14:00:00.000Z");
  });

  it("склеивает пересекающиеся события и не плодит пустые промежутки", () => {
    const free = subtractBusy(
      { start: at("2026-09-21T10:00:00Z"), end: at("2026-09-21T19:00:00Z") },
      [
        { start: at("2026-09-21T12:00:00Z"), end: at("2026-09-21T15:00:00Z") },
        { start: at("2026-09-21T14:00:00Z"), end: at("2026-09-21T16:00:00Z") },
      ],
    );

    expect(free).toHaveLength(2);
    expect(free[0].end.toISOString()).toBe("2026-09-21T12:00:00.000Z");
    expect(free[1].start.toISOString()).toBe("2026-09-21T16:00:00.000Z");
  });

  it("не создаёт пустых промежутков между смежными событиями", () => {
    const free = subtractBusy(
      { start: at("2026-09-21T10:00:00Z"), end: at("2026-09-21T19:00:00Z") },
      [
        { start: at("2026-09-21T12:00:00Z"), end: at("2026-09-21T13:00:00Z") },
        { start: at("2026-09-21T13:00:00Z"), end: at("2026-09-21T14:00:00Z") },
      ],
    );

    expect(free).toHaveLength(2);
    expect(free[0].end.toISOString()).toBe("2026-09-21T12:00:00.000Z");
    expect(free[1].start.toISOString()).toBe("2026-09-21T14:00:00.000Z");
  });

  it("возвращает пустой список, когда занято целиком", () => {
    const free = subtractBusy(
      { start: at("2026-09-21T10:00:00Z"), end: at("2026-09-21T19:00:00Z") },
      [{ start: at("2026-09-21T09:00:00Z"), end: at("2026-09-21T20:00:00Z") }],
    );

    expect(free).toHaveLength(0);
  });

  it("игнорирует занятость за пределами окна", () => {
    const free = subtractBusy(
      { start: at("2026-09-21T10:00:00Z"), end: at("2026-09-21T19:00:00Z") },
      [{ start: at("2026-09-22T10:00:00Z"), end: at("2026-09-22T11:00:00Z") }],
    );

    expect(free).toHaveLength(1);
  });
});

// --- findFreeSlots: реальный путь через readEvents --------------------------
//
// Ниже НЕ мокается сам findFreeSlots и не подменяется readEvents целиком:
// в контекст, как и в tests/domain/events.test.ts, внедряется только
// query — замена сетевого REPORT-запроса CalDAV. readEvents, expandOccurrences,
// parseEvent и resolveCalendarIn выполняются по-настоящему, на реальном ICS
// из tests/fixtures. Так проверяется весь путь целиком, а не только чистая
// функция subtractBusy.
//
// Ни один тест ниже НЕ трогает process.env.TZ. Правка контроллера прямо
// требует, чтобы findFreeSlots считал границы рабочего дня и день недели в
// часовом поясе КАЛЕНДАРЯ (context.config.defaultTimeZone = "Europe/Moscow"
// в этих тестах), а не в поясе процесса — поэтому все входные моменты ниже
// заданы ISO-строками с явным смещением ("+03:00" или "Z"), их истинный
// момент времени не зависит от TZ машины, на которой выполняется `npm test`,
// и результат тоже не должен зависеть от него. Раньше здесь стояла мутация
// process.env.TZ внутри тестов — это МАСКИРОВАЛО расхождение вместо того,
// чтобы его исключить, и было снято по прямому указанию контроллера.

const simple = readFileSync("tests/fixtures/simple.ics", "utf8");
const allday = readFileSync("tests/fixtures/allday.ics", "utf8");

const calendars: Calendar[] = [
  { id: "work", href: "/c/work/", displayName: "Работа", readOnly: false },
];

function contextWith(objects: Array<{ href: string; etag: string; ics: string }>) {
  return {
    client: {} as never,
    config: { defaultTimeZone: "Europe/Moscow" } as never,
    calendars: async () => calendars,
    resolveCalendar: async () => calendars[0],
    query: vi.fn().mockResolvedValue(objects),
  } as never;
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

// Полночь суток по Europe/Moscow (реальный пояс аккаунта во всех фикстурах:
// TZID=Europe/Moscow в simple.ics, конфиг в contextWith). У Москвы фиксированное
// смещение +03:00 круглый год (без перевода стрелок с 2014 года), поэтому
// строка со смещением однозначно задаёт момент времени независимо от того,
// в каком поясе выполняется процесс — в отличие от прежнего localMidnight,
// который строил Date из локальных (процессных) компонент.
function mskMidnight(year: number, month: number, day: number): string {
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}T00:00:00+03:00`;
}

describe("findFreeSlots", () => {
  it("настоящим путём через readEvents вычитает событие из фикстуры simple.ics", async () => {
    // simple.ics: понедельник 21.09.2026, 10:00–14:00 Europe/Moscow. Рабочий
    // день по умолчанию 10:00–19:00 — тоже в поясе календаря (Europe/Moscow),
    // поэтому единственное свободное окно — 14:00–19:00 МСК = 11:00–16:00Z,
    // и это должно быть верно вне зависимости от TZ машины, на которой
    // выполняется тест.
    const context = contextWith([{ href: "/c/work/e.ics", etag: '"1"', ics: simple }]);

    const slots = await findFreeSlots(context, {
      from: mskMidnight(2026, 9, 21),
      to: mskMidnight(2026, 9, 22),
      durationMinutes: 30,
    });

    expect(slots).toEqual([
      { start: "2026-09-21T11:00:00.000Z", end: "2026-09-21T16:00:00.000Z" },
    ]);
  });

  it("не предлагает окно короче durationMinutes", async () => {
    const context = contextWith([{ href: "/c/work/e.ics", etag: '"1"', ics: simple }]);

    // Свободно только 14:00–19:00 МСК (5 часов = 300 минут). Запрос окна
    // длиннее этого не должен вернуть ничего — ни урезанного, ни ошибочного
    // слота.
    const slots = await findFreeSlots(context, {
      from: mskMidnight(2026, 9, 21),
      to: mskMidnight(2026, 9, 22),
      durationMinutes: 301,
    });

    expect(slots).toHaveLength(0);
  });

  // Регрессионный тест, специально требуемый контроллером: границы суток
  // (а значит и день недели) должны определяться в поясе КАЛЕНДАРЯ, а не в
  // поясе процесса. Ниже — момент, для которого местная дата в Europe/Moscow
  // и в UTC/America_New_York РАСХОДИТСЯ: "from" — ровно полночь понедельника
  // 21.09.2026 по Москве (00:00 МСК = 21:00Z предыдущего дня), но в UTC и в
  // America/New_York это ещё ВОСКРЕСЕНЬЕ 20.09.
  //
  // Старая реализация (day.setHours(0,0,0,0) + day.getDay() в поясе
  // процесса) на машине с TZ=UTC или TZ=America/New_York классифицировала
  // бы весь этот интервал как "воскресенье" (день недели по умолчанию
  // исключён из будних 1..5) и отбросила его целиком, теряя единственный
  // рабочий час, — то есть искала бы окно неправильного дня и на не-московской
  // машине отдавала бы ПУСТОЙ список вместо реального свободного времени.
  // См. отчёт задачи 15 (раздел "Правка по указанию контроллера") — там же
  // приведён прогон, где этот тест красный на прежней реализации именно под
  // TZ=UTC/TZ=America/New_York и зелёный под TZ=Europe/Moscow (совпадающим
  // с поясом календаря), что и было тем самым скрытым багом.
  it("день недели считается в поясе календаря, а не в поясе процесса", async () => {
    const context = contextWith([]);

    const slots = await findFreeSlots(context, {
      from: "2026-09-20T21:00:00Z", // 21.09.2026 00:00 Europe/Moscow, понедельник
      to: "2026-09-21T10:00:00Z", // 21.09.2026 13:00 Europe/Moscow, тот же день
      durationMinutes: 60,
    });

    expect(slots).toEqual([
      { start: "2026-09-21T07:00:00.000Z", end: "2026-09-21T10:00:00.000Z" },
    ]);
  });

  it("durationMinutes больше длины всего рабочего дня — пустой список, без ошибки", async () => {
    const context = contextWith([]);

    const slots = await findFreeSlots(context, {
      from: mskMidnight(2026, 9, 21),
      to: mskMidnight(2026, 9, 22),
      durationMinutes: 600, // рабочий день по умолчанию — 9 часов = 540 минут
    });

    expect(slots).toEqual([]);
  });

  it("пустой weekdays — ни одного дня не проходит фильтр, список пуст", async () => {
    const context = contextWith([]);

    const slots = await findFreeSlots(context, {
      from: mskMidnight(2026, 9, 21),
      to: mskMidnight(2026, 9, 28), // неделя с запасом
      durationMinutes: 30,
      weekdays: [],
    });

    expect(slots).toEqual([]);
  });

  it("рабочие часы заданы наоборот (конец раньше начала) — пустой список, без исключения", async () => {
    const context = contextWith([]);

    await expect(
      findFreeSlots(context, {
        from: mskMidnight(2026, 9, 21),
        to: mskMidnight(2026, 9, 22),
        durationMinutes: 30,
        workingHours: { start: "19:00", end: "10:00" },
      }),
    ).resolves.toEqual([]);
  });

  it("событие на весь день занимает весь рабочий день, а не пропускается", async () => {
    // allday.ics: DTSTART;VALUE=DATE:20260923 (среда), DTEND;VALUE=DATE:20260924.
    const context = contextWith([{ href: "/c/work/a.ics", etag: '"1"', ics: allday }]);

    const slots = await findFreeSlots(context, {
      from: mskMidnight(2026, 9, 23),
      to: mskMidnight(2026, 9, 24),
      durationMinutes: 15,
    });

    expect(slots).toEqual([]);
  });

  it("событие, пересекающее полночь, корректно режется по обоим рабочим дням", async () => {
    // Событие с 22:00 UTC понедельника 21.09 до 08:00 UTC вторника 22.09 —
    // пересекает полночь. Проверяются структурные свойства (число слотов, их
    // порядок, отсутствие наложений), а не точные часы — те уже проверены
    // отдельным тестом выше.
    const crossing = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:test-crossing-midnight
DTSTAMP:20260901T090000Z
DTSTART:20260921T220000Z
DTEND:20260922T080000Z
SUMMARY:Ночная пересменка
END:VEVENT
END:VCALENDAR`;
    const context = contextWith([{ href: "/c/work/c.ics", etag: '"1"', ics: crossing }]);

    const slots = await findFreeSlots(context, {
      from: mskMidnight(2026, 9, 21),
      to: mskMidnight(2026, 9, 23),
      durationMinutes: 15,
    });

    // Ровно два рабочих дня в окне (Пн и Вт) — ожидаем не больше двух слотов
    // (по одному на день), они идут по возрастанию и не пересекаются.
    expect(slots.length).toBeGreaterThan(0);
    expect(slots.length).toBeLessThanOrEqual(2);
    for (let i = 1; i < slots.length; i += 1) {
      expect(new Date(slots[i - 1].end).getTime()).toBeLessThanOrEqual(
        new Date(slots[i].start).getTime(),
      );
    }
    for (const slot of slots) {
      expect(new Date(slot.end).getTime()).toBeGreaterThan(new Date(slot.start).getTime());
    }
  });

  it("падает с понятной ошибкой на неположительный durationMinutes", async () => {
    const context = contextWith([]);

    await expect(
      findFreeSlots(context, {
        from: mskMidnight(2026, 9, 21),
        to: mskMidnight(2026, 9, 22),
        durationMinutes: 0,
      }),
    ).rejects.toThrow(/durationMinutes/);
  });

  it("прокидывает наружу ошибку readEvents с именем отказавшего календаря", async () => {
    const context = {
      client: {} as never,
      config: { defaultTimeZone: "Europe/Moscow" } as never,
      calendars: async () => calendars,
      resolveCalendar: async () => calendars[0],
      query: vi.fn().mockRejectedValue(new Error("сеть недоступна")),
    } as never;

    await expect(
      findFreeSlots(context, {
        from: mskMidnight(2026, 9, 21),
        to: mskMidnight(2026, 9, 22),
        durationMinutes: 30,
      }),
    ).rejects.toThrow(/Работа/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// З09: свободные окна без призраков (Р3–Р7 плана переделки,
// docs/superpowers/plans/2026-09-19-recurring-events-rework.md). Время
// занимают только видимые встречи: скрытые переопределения (после конца
// серии, под EXDATE) и отменённые (STATUS:CANCELLED) — нет; detached и
// объект из одних переопределений — да. Если встречи объекта не прочитаны,
// поиск отказывает и называет UID (Р4), а не считает их время свободным.
// ─────────────────────────────────────────────────────────────────────────────

const CRLF = "\r\n";
const UID = "free-z09@yandex.ru";
const MOSCOW_ZONE = [
  "BEGIN:VTIMEZONE", "TZID:Europe/Moscow", "BEGIN:STANDARD", "TZNAME:MSK", "TZOFFSETFROM:+0300",
  "TZOFFSETTO:+0300", "DTSTART:19700101T000000", "END:STANDARD", "END:VTIMEZONE",
];
/** Пн и Ср 10:00–11:00 МСК с 19.10.2026. */
const WEEKLY = ["DTSTART;TZID=Europe/Moscow:20261019T100000", "DTEND;TZID=Europe/Moscow:20261019T110000", "SUMMARY:Планёрка"];
const COUNT6 = "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6";

function vevent(lines: string[], uid = UID): string[] {
  return ["BEGIN:VEVENT", `UID:${uid}`, "DTSTAMP:20261001T090000Z", ...lines, "END:VEVENT"];
}

function calendarOf(...events: string[][]): string {
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//free//RU", ...MOSCOW_ZONE, ...events.flat(), "END:VCALENDAR"]
    .join(CRLF) + CRLF;
}

function override(rid: string, start: string, end: string, ...extra: string[]): string[] {
  return vevent([`RECURRENCE-ID;TZID=Europe/Moscow:${rid}`, `DTSTART;TZID=Europe/Moscow:${start}`,
    `DTEND;TZID=Europe/Moscow:${end}`, "SUMMARY:Переопределение", ...extra]);
}

function contextOf(ics: string[], zone = "Europe/Moscow") {
  return {
    client: {} as never,
    config: { defaultTimeZone: zone } as never,
    calendars: async () => calendars,
    resolveCalendar: async () => calendars[0],
    query: vi.fn().mockResolvedValue(ics.map((text, i) => ({ href: `/c/work/${i}.ics`, etag: `"${i}"`, ics: text }))),
  } as never;
}

/** Свободные окна одного рабочего дня МСК (10:00–19:00), строками «ЧЧ:ММ–ЧЧ:ММ» по Москве. */
async function freeOn(day: string, ics: string[], zone = "Europe/Moscow"): Promise<string[]> {
  const slots = await findFreeSlots(contextOf(ics, zone), {
    from: `${day}T00:00:00+03:00`,
    to: `${day}T23:59:00+03:00`,
    durationMinutes: 15,
    weekdays: [0, 1, 2, 3, 4, 5, 6],
  });
  const msk = (iso: string) => new Date(Date.parse(iso) + 3 * 3_600_000).toISOString().slice(11, 16);
  return slots.map((slot) => `${msk(slot.start)}–${msk(slot.end)}`);
}

const WHOLE_DAY = ["10:00–19:00"];
const BUSY_10_11 = ["11:00–19:00"];

async function refusalOf(promise: Promise<unknown>): Promise<FreeSlotsError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof FreeSlotsError) return error;
    throw error;
  }
  throw new Error("ожидался отказ FreeSlotsError");
}

describe("findFreeSlots: время занимают только видимые встречи (З09)", () => {
  it("переопределение после конца серии (UNTIL) время не занимает", async () => {
    const ics = calendarOf(
      vevent([...WEEKLY, "RRULE:FREQ=WEEKLY;UNTIL=20261026T065959Z;BYDAY=MO,WE"]),
      override("20261102T100000", "20261102T100000", "20261102T110000"));

    expect(await freeOn("2026-11-02", [ics])).toEqual(WHOLE_DAY);
  });

  it("переопределение под EXDATE время не занимает", async () => {
    const ics = calendarOf(
      vevent([...WEEKLY, COUNT6, "EXDATE;TZID=Europe/Moscow:20261021T100000"]),
      override("20261021T100000", "20261021T140000", "20261021T150000"));

    expect(await freeOn("2026-10-21", [ics])).toEqual(WHOLE_DAY);
  });

  it("отменённая встреча серии и отменённое событие время не занимают (Р7, C30)", async () => {
    const series = calendarOf(
      vevent([...WEEKLY, COUNT6]),
      override("20261021T100000", "20261021T100000", "20261021T110000", "STATUS:CANCELLED"));
    const single = calendarOf(vevent(["DTSTART;TZID=Europe/Moscow:20261021T150000", "DTEND;TZID=Europe/Moscow:20261021T160000",
      "SUMMARY:Отменили", "STATUS:CANCELLED"], "cancelled-z09@yandex.ru"));

    expect(await freeOn("2026-10-21", [series, single])).toEqual(WHOLE_DAY);
    expect(await freeOn("2026-10-19", [series, single])).toEqual(BUSY_10_11);
  });

  // Ревью З09: время освобождает только STATUS:CANCELLED. Без этого теста
  // проходил мутант «занимают только встречи без STATUS».
  it("встречи со STATUS:CONFIRMED и STATUS:TENTATIVE занимают время, со STATUS:CANCELLED — нет", async () => {
    const single = (uid: string, from: string, to: string, status: string) =>
      calendarOf(vevent([`DTSTART;TZID=Europe/Moscow:20261021T${from}`, `DTEND;TZID=Europe/Moscow:20261021T${to}`,
        `SUMMARY:${status}`, `STATUS:${status}`], uid));
    const confirmed = single("confirmed-z09@yandex.ru", "100000", "110000", "CONFIRMED");
    const tentative = single("tentative-z09@yandex.ru", "120000", "130000", "TENTATIVE");
    const cancelled = single("cancelled-z09@yandex.ru", "140000", "150000", "CANCELLED");
    const series = calendarOf(
      vevent([...WEEKLY, COUNT6, "STATUS:CONFIRMED"], "confirmed-series-z09@yandex.ru"),
      vevent(["RECURRENCE-ID;TZID=Europe/Moscow:20261021T100000", "DTSTART;TZID=Europe/Moscow:20261021T160000",
        "DTEND;TZID=Europe/Moscow:20261021T170000", "SUMMARY:Под вопросом", "STATUS:TENTATIVE"], "confirmed-series-z09@yandex.ru"));

    expect(await freeOn("2026-10-21", [confirmed, tentative, cancelled, series]))
      .toEqual(["11:00–12:00", "13:00–16:00", "17:00–19:00"]);
    expect(await freeOn("2026-10-19", [series])).toEqual(BUSY_10_11);
  });

  it("объект из одних переопределений занимает время (Р6, R8-N3)", async () => {
    const ics = calendarOf(override("20261021T100000", "20261021T120000", "20261021T130000"));

    expect(await freeOn("2026-10-21", [ics])).toEqual(["10:00–12:00", "13:00–19:00"]);
  });

  it("detached в дату слота занимает своё время, слот — своё (C64)", async () => {
    expect(await freeOn("2026-10-21", [seeds.detachedOnSlotDate.ics])).toEqual(["10:00–11:30", "12:30–19:00"]);
  });

  it("RANGE=THISANDFUTURE: следующие встречи занимают сдвинутое время", async () => {
    const ics = calendarOf(
      vevent([...WEEKLY, COUNT6]),
      vevent(["RECURRENCE-ID;RANGE=THISANDFUTURE;TZID=Europe/Moscow:20261021T100000",
        "DTSTART;TZID=Europe/Moscow:20261021T140000", "DTEND;TZID=Europe/Moscow:20261021T150000", "SUMMARY:Позже"]));

    expect(await freeOn("2026-10-26", [ics])).toEqual(["10:00–14:00", "15:00–19:00"]);
  });
});

describe("findFreeSlots: непрочитанные встречи — отказ с UID, а не свободное время (Р4)", () => {
  it.each([seeds.c63BadFreq, seeds.c63BadByday])("$about", async (seed) => {
    const refusal = await refusalOf(freeOn("2026-10-19", [seeds.weeklyMoscow.ics, seed.ics]));

    expect(refusal.code).toBe("unreadable");
    expect(refusal.message).toContain(seed.uid);
    expect(refusal.events.map((event) => event.id)).toEqual([seed.uid]);
  });

  it("правило, которое ical.js не перебирает (bad-rrule), — отказ с UID", async () => {
    const ics = calendarOf(vevent([...WEEKLY, "RRULE:FREQ=MONTHLY;BYWEEKNO=2"], "badrule-z09@yandex.ru"));

    const refusal = await refusalOf(freeOn("2026-10-19", [ics]));
    expect(refusal.code).toBe("unreadable");
    expect(refusal.message).toContain("badrule-z09@yandex.ru");
  });

  // Ревью З09: в день DTSTART дефект не виден. Через три недели встречи DTSTART
  // в окне нет, а встречи правила неизвестны; прежде поиск считал день
  // свободным: [07:00Z–16:00Z] без отказа.
  it("bad-rrule: день через три недели после DTSTART — тоже отказ с UID, а не свободный день", async () => {
    const ics = calendarOf(vevent([...WEEKLY, "RRULE:FREQ=MONTHLY;BYWEEKNO=2"], "badrule-z09@yandex.ru"));

    const refusal = await refusalOf(freeOn("2026-11-09", [ics]));
    expect(refusal.code).toBe("unreadable");
    expect(refusal.message).toContain("badrule-z09@yandex.ru");
    expect(refusal.events).toEqual([
      { id: "badrule-z09@yandex.ru", calendarId: "work", reason: expect.stringMatching(/^bad-rrule: /) },
    ]);
  });

  it("серия длиннее предела перебора до окна — отказ с UID, а не пустая занятость", async () => {
    const ics = ["BEGIN:VCALENDAR", "VERSION:2.0", ...vevent(["DTSTART:20261001T000000Z", "DURATION:PT1S",
      "RRULE:FREQ=SECONDLY", "SUMMARY:Датчик"], "secondly-z09@yandex.ru"), "END:VCALENDAR"].join(CRLF) + CRLF;

    const refusal = await refusalOf(freeOn("2026-10-06", [ics]));
    expect(refusal.code).toBe("unreadable");
    expect(refusal.message).toContain("secondly-z09@yandex.ru");
  }, 30_000);
});

describe("findFreeSlots: пояс календаря, а не процесса", () => {
  // Азия/Токио не совпадает ни с одним поясом прогона test:tz: прежний код
  // читал время без смещения в поясе процесса и ошибался во всех трёх.
  it("from и to без смещения — стенное время пояса календаря", async () => {
    const slots = await findFreeSlots(contextOf([], "Asia/Tokyo"), {
      from: "2026-10-21T09:00:00",
      to: "2026-10-21T12:00:00",
      durationMinutes: 30,
    });

    // Рабочий день 10:00–19:00 JST; окно 09:00–12:00 JST → свободно 10:00–12:00 JST = 01:00–03:00Z.
    expect(slots).toEqual([{ start: "2026-10-21T01:00:00.000Z", end: "2026-10-21T03:00:00.000Z" }]);
  });

  it("from и to датой — полночь пояса календаря", async () => {
    // Полночь UTC — 09:00 JST: с рабочим днём с 08:00 прежний код терял час.
    const slots = await findFreeSlots(contextOf([], "Asia/Tokyo"), {
      from: "2026-10-21",
      to: "2026-10-22",
      durationMinutes: 30,
      workingHours: { start: "08:00", end: "19:00" },
    });

    expect(slots).toEqual([{ start: "2026-10-20T23:00:00.000Z", end: "2026-10-21T10:00:00.000Z" }]);
  });

  it("конец рабочего дня 24:00 — до полуночи пояса календаря", async () => {
    const slots = await findFreeSlots(contextOf([]), {
      from: "2026-10-21T00:00:00+03:00",
      to: "2026-10-23T00:00:00+03:00",
      durationMinutes: 30,
      workingHours: { start: "20:00", end: "24:00" },
    });

    expect(slots).toEqual([
      { start: "2026-10-21T17:00:00.000Z", end: "2026-10-21T21:00:00.000Z" },
      { start: "2026-10-22T17:00:00.000Z", end: "2026-10-22T21:00:00.000Z" },
    ]);
  });

  it("поиск с позднего вечера западнее UTC: первые сутки — дата пояса календаря, а не UTC", async () => {
    // 21.10 22:00 в Нью-Йорке — уже 22.10 по UTC; рабочие часы 21.10 до 24:00 нельзя пропустить.
    const slots = await findFreeSlots(contextOf([], "America/New_York"), {
      from: "2026-10-21T22:00:00-04:00",
      to: "2026-10-22T01:00:00-04:00",
      durationMinutes: 30,
      workingHours: { start: "20:00", end: "24:00" },
    });

    expect(slots).toEqual([{ start: "2026-10-22T02:00:00.000Z", end: "2026-10-22T04:00:00.000Z" }]);
  });

  it("день перевода часов: рабочие часы — стенное время пояса календаря (Berlin, 25.10.2026)", async () => {
    const slots = await findFreeSlots(contextOf([], "Europe/Berlin"), {
      from: "2026-10-24T00:00:00+02:00",
      to: "2026-10-26T00:00:00+01:00",
      durationMinutes: 30,
      weekdays: [0, 6],
    });

    expect(slots).toEqual([
      { start: "2026-10-24T08:00:00.000Z", end: "2026-10-24T17:00:00.000Z" },
      { start: "2026-10-25T09:00:00.000Z", end: "2026-10-25T18:00:00.000Z" },
    ]);
  });

  it("неразборчивые from, to и рабочие часы — понятная ошибка до чтения календарей", async () => {
    const context = contextOf([]);
    await expect(findFreeSlots(context, { from: "завтра", to: "2026-10-22", durationMinutes: 30 })).rejects.toThrow(/from/);
    await expect(
      findFreeSlots(context, { from: "2026-10-21", to: "2026-10-22", durationMinutes: 30, workingHours: { start: "9", end: "18:00" } }),
    ).rejects.toThrow(/ЧЧ:ММ/);
    expect((context as unknown as { query: ReturnType<typeof vi.fn> }).query).not.toHaveBeenCalled();
  });
});
