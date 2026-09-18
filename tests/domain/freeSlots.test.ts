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

// Полночь по местному времени процесса — так же, как считает сам findFreeSlots
// (`day.setHours(0, 0, 0, 0)`). Использование локального Date, а не строки с
// фиксированным смещением, важно: иначе граница окна поиска в разных поясах
// съезжала бы на другую календарную дату ещё до входа в findFreeSlots.
function localMidnight(year: number, month: number, day: number): string {
  return new Date(year, month - 1, day, 0, 0, 0, 0).toISOString();
}

// Рабочие часы findFreeSlots считаются через setHours в ПОЯСЕ ПРОЦЕССА
// (задокументированное упрощение брифа), поэтому тесты на содержательный
// результат пришлось бы иначе привязывать к тому, под каким TZ запущен
// `npm test` на конкретной машине. Вместо этого пояс процесса мутируется
// прямо внутри теста и восстанавливается в finally — тот же приём, что уже
// применён в tests/ical/build.test.ts (блок DTSTAMP) для той же категории
// проблемы. Так тест детерминирован на любой машине независимо от TZ по
// умолчанию.
async function withTz<T>(tz: string, run: () => Promise<T>): Promise<T> {
  const originalTz = process.env.TZ;
  process.env.TZ = tz;
  try {
    return await run();
  } finally {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  }
}

describe("findFreeSlots", () => {
  it("настоящим путём через readEvents вычитает событие из фикстуры simple.ics", async () => {
    // simple.ics: понедельник 21.09.2026, 10:00–14:00 Europe/Moscow — реальный
    // пояс аккаунта и самой фикстуры (TZID в ICS). Пояс процесса зафиксирован
    // тем же значением, чтобы проверить содержательный результат независимо
    // от TZ машины, на которой реально выполняется `npm test`.
    const slots = await withTz("Europe/Moscow", () => {
      const context = contextWith([{ href: "/c/work/e.ics", etag: '"1"', ics: simple }]);
      return findFreeSlots(context, {
        from: localMidnight(2026, 9, 21),
        to: localMidnight(2026, 9, 22),
        durationMinutes: 30,
      });
    });

    expect(slots).toEqual([
      { start: "2026-09-21T11:00:00.000Z", end: "2026-09-21T16:00:00.000Z" },
    ]);
  });

  it("не предлагает окно короче durationMinutes", async () => {
    // Свободно только 14:00–19:00 МСК (5 часов = 300 минут). Запрос окна
    // длиннее этого не должен вернуть ничего — ни урезанного, ни ошибочного
    // слота. Пояс процесса зафиксирован в Europe/Moscow по той же причине,
    // что и в тесте выше.
    const slots = await withTz("Europe/Moscow", () => {
      const context = contextWith([{ href: "/c/work/e.ics", etag: '"1"', ics: simple }]);
      return findFreeSlots(context, {
        from: localMidnight(2026, 9, 21),
        to: localMidnight(2026, 9, 22),
        durationMinutes: 301,
      });
    });

    expect(slots).toHaveLength(0);
  });

  // Диагностика, которую отдельно потребовал контроллер (см. отчёт задачи
  // 15): findFreeSlots считает рабочие часы через setHours в ПОЯСЕ ПРОЦЕССА,
  // а не в поясе события (Europe/Moscow, зафиксированном TZID в simple.ics).
  // Это тот же класс бага, что уже дважды находили и чинили в этом проекте —
  // DTSTAMP и RECURRENCE-ID тоже сперва читали час/минуту из геттеров JS
  // Date без учёта смещения ISO-строки (см. подробный разбор в комментариях
  // toIcalTime в src/ical/build.ts и icalTimeOf в src/domain/events.ts,
  // починенный через `ICAL.Time.fromJSDate(date, true).convertToZone(zone)`).
  // Здесь тот же приём НЕ применён: бриф задаёт рабочие часы через голый
  // setHours, а дисп это решение оставляет контроллеру, не мне. Тест не
  // проверяет "правильное" поведение — фиксирует ФАКТ зависимости результата
  // от TZ процесса, чтобы будущий рефакторинг не потерял эту находку молча.
  it("часовой пояс процесса меняет результат — известное упрощение брифа, см. отчёт", async () => {
    const runFor = (tz: string) =>
      withTz(tz, () => {
        const context = contextWith([{ href: "/c/work/e.ics", etag: '"1"', ics: simple }]);
        return findFreeSlots(context, {
          from: localMidnight(2026, 9, 21),
          to: localMidnight(2026, 9, 22),
          durationMinutes: 30,
        });
      });

    // Europe/Moscow — реальный пояс аккаунта и фикстуры: рабочий день
    // 10:00–19:00 минус занятость 10:00–14:00 (МСК) даёт одно окно
    // 14:00–19:00 МСК = 11:00–16:00Z.
    const moscow = await runFor("Europe/Moscow");
    expect(moscow).toEqual([
      { start: "2026-09-21T11:00:00.000Z", end: "2026-09-21T16:00:00.000Z" },
    ]);

    // Под TZ=UTC «10:00–19:00» читается как 10:00Z–19:00Z — событие
    // (абсолютно, 07:00–11:00Z) перекрывает только первый час окна вместо
    // первых четырёх. Итог не совпадает с московским.
    const utc = await runFor("UTC");
    expect(utc).toEqual([{ start: "2026-09-21T11:00:00.000Z", end: "2026-09-21T19:00:00.000Z" }]);
    expect(utc).not.toEqual(moscow);

    // Под TZ=America/New_York (UTC-4, конец сентября — летнее время) окно
    // «10:00–19:00» — это 14:00–23:00Z, событие (07:00–11:00Z) в него вообще
    // не попадает: занятость исчезает, отдаётся окно целиком.
    const newYork = await runFor("America/New_York");
    expect(newYork).toEqual([
      { start: "2026-09-21T14:00:00.000Z", end: "2026-09-21T23:00:00.000Z" },
    ]);
    expect(newYork).not.toEqual(moscow);
  });

  it("durationMinutes больше длины всего рабочего дня — пустой список, без ошибки", async () => {
    const slots = await withTz("Europe/Moscow", () => {
      const context = contextWith([]);
      return findFreeSlots(context, {
        from: localMidnight(2026, 9, 21),
        to: localMidnight(2026, 9, 22),
        durationMinutes: 600, // рабочий день по умолчанию — 9 часов = 540 минут
      });
    });

    expect(slots).toEqual([]);
  });

  it("пустой weekdays — ни одного дня не проходит фильтр, список пуст", async () => {
    const slots = await withTz("Europe/Moscow", () => {
      const context = contextWith([]);
      return findFreeSlots(context, {
        from: localMidnight(2026, 9, 21),
        to: localMidnight(2026, 9, 28), // неделя с запасом
        durationMinutes: 30,
        weekdays: [],
      });
    });

    expect(slots).toEqual([]);
  });

  it("рабочие часы заданы наоборот (конец раньше начала) — пустой список, без исключения", async () => {
    await withTz("Europe/Moscow", async () => {
      const context = contextWith([]);
      await expect(
        findFreeSlots(context, {
          from: localMidnight(2026, 9, 21),
          to: localMidnight(2026, 9, 22),
          durationMinutes: 30,
          workingHours: { start: "19:00", end: "10:00" },
        }),
      ).resolves.toEqual([]);
    });
  });

  it("событие на весь день занимает весь рабочий день, а не пропускается", async () => {
    // allday.ics: DTSTART;VALUE=DATE:20260923 (среда), DTEND;VALUE=DATE:20260924.
    const slots = await withTz("Europe/Moscow", () => {
      const context = contextWith([{ href: "/c/work/a.ics", etag: '"1"', ics: allday }]);
      return findFreeSlots(context, {
        from: localMidnight(2026, 9, 23),
        to: localMidnight(2026, 9, 24),
        durationMinutes: 15,
      });
    });

    expect(slots).toEqual([]);
  });

  it("событие, пересекающее полночь, корректно режется по обоим рабочим дням", async () => {
    // Событие с 22:00 UTC понедельника 21.09 до 08:00 UTC вторника 22.09 —
    // пересекает полночь по UTC и по большинству поясов процесса. Пояс
    // процесса всё равно зафиксирован в Europe/Moscow, чтобы граница дня
    // (day.setHours(0,0,0,0)) была детерминирована; проверяются структурные
    // свойства (число слотов, их порядок, отсутствие наложений), а не точные
    // часы — те уже проверены отдельной канарейкой выше.
    const slots = await withTz("Europe/Moscow", () => {
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
      return findFreeSlots(context, {
        from: localMidnight(2026, 9, 21),
        to: localMidnight(2026, 9, 23),
        durationMinutes: 15,
      });
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
        from: localMidnight(2026, 9, 21),
        to: localMidnight(2026, 9, 22),
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
        from: localMidnight(2026, 9, 21),
        to: localMidnight(2026, 9, 22),
        durationMinutes: 30,
      }),
    ).rejects.toThrow(/Работа/);
  });
});
