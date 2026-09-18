import { describe, expect, it, vi } from "vitest";
import { createEvent, createEvents } from "../../src/domain/events.js";
import type { Calendar } from "../../src/types.js";

const calendar: Calendar = {
  id: "work",
  href: "/c/work/",
  displayName: "Работа",
  readOnly: false,
};

function contextWith(put = vi.fn().mockResolvedValue('"etag-new"')) {
  return {
    context: {
      client: {} as never,
      config: { defaultTimeZone: "Europe/Moscow" } as never,
      calendars: async () => [calendar],
      resolveCalendar: async () => calendar,
      put,
    },
    put,
  };
}

const input = {
  calendarId: "work",
  summary: "Проект «Заря», утро",
  start: "2026-09-21T10:00:00+03:00",
  end: "2026-09-21T14:00:00+03:00",
};

describe("createEvent", () => {
  it("кладёт событие по пути календаря и ставит If-None-Match", async () => {
    const { context, put } = contextWith();

    const event = await createEvent(context as never, input);

    const [href, ics, options] = put.mock.calls[0];
    expect(href).toMatch(/^\/c\/work\/.+\.ics$/);
    expect(ics).toContain("SUMMARY:Проект");
    expect(options.ifNoneMatch).toBe(true);
    expect(event.id).toBeTruthy();
    expect(event.etag).toBe('"etag-new"');
  });

  it("подставляет пояс из конфигурации, если он не задан", async () => {
    const { context, put } = contextWith();

    await createEvent(context as never, input);

    expect(put.mock.calls[0][1]).toContain("TZID=Europe/Moscow");
  });

  it("отказывается писать в календарь только для чтения", async () => {
    const readOnly = { ...calendar, readOnly: true };
    const { context } = contextWith();
    context.resolveCalendar = async () => readOnly;

    await expect(createEvent(context as never, input)).rejects.toThrow(/только для чтения/);
  });

  // Самопроверка задачи 12: брифом эта проверка не предусмотрена, но без неё
  // событие с концом раньше начала молча уходит на сервер как есть — CalDAV
  // ничего подобного не проверяет, а ical.js собирает VEVENT с DTEND раньше
  // DTSTART без единой жалобы. Ошибку дешевле поймать до сети.
  it("отказывается создавать событие, где конец раньше начала", async () => {
    const { context } = contextWith();

    await expect(
      createEvent(context as never, { ...input, start: "2026-09-21T14:00:00+03:00", end: "2026-09-21T10:00:00+03:00" }),
    ).rejects.toThrow(/конец.*начал/i);
  });

  it("отказывается создавать событие с одинаковыми началом и концом", async () => {
    const { context } = contextWith();

    await expect(
      createEvent(context as never, { ...input, start: input.start, end: input.start }),
    ).rejects.toThrow(/конец.*начал/i);
  });

  // Самопроверка задачи 12: пустой заголовок брифом не рассмотрен. Без
  // проверки createEvent молча создал бы событие с "SUMMARY:" — валидным по
  // RFC 5545, но бесполезным для пользователя, который наверняка совершил
  // опечатку или забыл поле.
  it("отказывается создавать событие с пустым заголовком", async () => {
    const { context } = contextWith();

    await expect(createEvent(context as never, { ...input, summary: "   " })).rejects.toThrow(
      /заголов/i,
    );
  });
});

describe("createEvents", () => {
  it("создаёт все события и отчитывается по каждому", async () => {
    const { context } = contextWith();

    const results = await createEvents(context as never, [
      { ...input, summary: "Первое" },
      { ...input, summary: "Второе" },
    ]);

    expect(results).toHaveLength(2);
    expect(results.every((result) => result.ok)).toBe(true);
  });

  it("продолжает работу после отказа по одному событию", async () => {
    const put = vi
      .fn()
      .mockResolvedValueOnce('"etag-1"')
      .mockRejectedValueOnce(new Error("Доступ запрещён"))
      .mockResolvedValueOnce('"etag-3"');
    const { context } = contextWith(put);

    const results = await createEvents(context as never, [
      { ...input, summary: "Первое" },
      { ...input, summary: "Второе" },
      { ...input, summary: "Третье" },
    ]);

    expect(results.map((result) => result.ok)).toEqual([true, false, true]);
    expect(results[1].error).toContain("Доступ запрещён");
  });

  // Задание отдельно требует проверить это: buildEvent кладёт в VCALENDAR
  // клон общего компонента VTIMEZONE из ICAL.TimezoneService (правка по
  // ревью задачи 7), а не сам общий объект. createEvents вызывает buildEvent
  // в цикле — если бы клонирования не было, addSubcomponent у второго и
  // последующих событий отцепил бы VTIMEZONE от календаря предыдущего, ещё
  // не отправленного объекта. Здесь три события подряд с одним и тем же
  // часовым поясом, и у КАЖДОГО ics, ушедшего в put, проверяется свой
  // непустой блок VTIMEZONE.
  it("у каждого события в пачке с общим часовым поясом — свой независимый блок VTIMEZONE", async () => {
    const { context, put } = contextWith();

    await createEvents(context as never, [
      { ...input, summary: "Первое" },
      { ...input, summary: "Второе" },
      { ...input, summary: "Третье" },
    ]);

    expect(put.mock.calls).toHaveLength(3);
    for (const [, ics] of put.mock.calls) {
      expect(ics).toContain("BEGIN:VTIMEZONE");
      expect(ics).toContain("TZID:Europe/Moscow");
      expect(ics).toContain("END:VTIMEZONE");
    }
  });

  // Самопроверка задачи 12: пачка без верхнего предела размера в проекте не
  // рассматривалась. CalDAV не пакетирует запросы — каждое событие уходит
  // отдельным PUT последовательно (см. комментарий у createEvents), поэтому
  // случайно огромная пачка не сломается, но будет линейно долгой и рискует
  // упереться в таймаут вызывающей стороны. Предел защищает от такой пачки,
  // а не от обычного использования.
  it("отказывается обрабатывать пачку, превышающую предел размера", async () => {
    const { context } = contextWith();
    const huge = Array.from({ length: 51 }, (_, index) => ({ ...input, summary: `Событие ${index}` }));

    await expect(createEvents(context as never, huge)).rejects.toThrow(/предел|размер/i);
  });
});
