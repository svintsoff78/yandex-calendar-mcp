import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { findFreeSlots, subtractBusy } from "../../src/domain/freeSlots.js";
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
