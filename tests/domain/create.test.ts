// Создание событий: тот же путь записи, что у правки и удаления —
// src/domain/writes.ts (deliver). Ввод-вывод подставляется через
// `Context.io`: это единственная точка внедрения, прежних context.put и
// context.get больше нет.
import { describe, expect, it } from "vitest";
import { createEvent, createEvents } from "../../src/domain/events.js";
import type { Calendar, Context, ObjectIO, PutOutcome, RawObject, WriteCondition } from "../../src/types.js";

const calendar: Calendar = {
  id: "work",
  href: "/c/work/",
  displayName: "Работа",
  readOnly: false,
};

/** Логин владельца (Config.login): полный адрес с доменом, как требует Яндекс. */
const OWNER = "owner@yandex.ru";

interface Put {
  href: string;
  ics: string;
  condition: WriteCondition;
}

interface Stand {
  context: Context;
  puts: Put[];
}

/** Контекст с подставным вводом-выводом; `answer` — исход каждого PUT по порядку. */
function stand(answer: (index: number) => PutOutcome = () => ({ status: "applied", etag: "etag-new" })): Stand {
  const puts: Put[] = [];
  const io: ObjectIO = {
    find: async (): Promise<RawObject | undefined> => undefined,
    put: async (href, ics, condition) => {
      puts.push({ href, ics, condition });
      return answer(puts.length - 1);
    },
    remove: async () => ({ status: "applied" }),
  };
  const context = {
    client: {} as never,
    config: { defaultTimeZone: "Europe/Moscow", login: OWNER } as never,
    discover: async () => [calendar],
    calendars: async () => [calendar],
    resolveCalendar: async () => calendar,
    io,
    now: () => new Date("2026-09-01T09:00:00Z"),
  } as unknown as Context;
  return { context, puts };
}

const input = {
  calendarId: "work",
  summary: "Проект «Заря», утро",
  start: "2026-09-21T10:00:00+03:00",
  end: "2026-09-21T14:00:00+03:00",
};

describe("createEvent", () => {
  it("кладёт событие по пути календаря и ставит If-None-Match", async () => {
    const { context, puts } = stand();

    const event = await createEvent(context, input);

    expect(puts).toHaveLength(1);
    expect(puts[0].href).toMatch(/^\/c\/work\/.+\.ics$/);
    expect(puts[0].ics).toContain("SUMMARY:Проект");
    expect(puts[0].condition.ifNoneMatch).toBe("*");
    expect(event.id).toBeTruthy();
    expect(event.etag).toBe("etag-new");
  });

  it("подставляет пояс из конфигурации, если он не задан", async () => {
    const { context, puts } = stand();

    await createEvent(context, input);

    expect(puts[0].ics).toContain("TZID=Europe/Moscow");
  });

  // Получатель напоминания письмом — владелец календаря (Config.login): без
  // адреса сборка отказывает (src/ical/build.ts), поэтому домен обязан его
  // проводить.
  it("проводит адрес владельца в напоминание письмом", async () => {
    const { context, puts } = stand();

    await createEvent(context, {
      ...input,
      reminders: [{ minutesBefore: 30, method: "email" }],
    });

    expect(puts[0].ics).toContain("ACTION:EMAIL");
    expect(puts[0].ics).toContain(`ATTENDEE:mailto:${OWNER}`);
  });

  // Адрес владельца без домена не совпадёт ни с одним настоящим адресом:
  // свой участник, свой организатор и получатель письма определялись бы
  // неверно, и молча. Отказ обязан наступить до сети.
  it("отказывается работать, если логин владельца — не полный адрес", async () => {
    const { context, puts } = stand();
    (context.config as { login: string }).login = "owner";

    await expect(createEvent(context, input)).rejects.toThrow(/не полный адрес/);
    expect(puts).toHaveLength(0);
  });

  it("отказывается писать в календарь только для чтения", async () => {
    const { context } = stand();
    const readOnly = { ...calendar, readOnly: true };
    context.resolveCalendar = async () => readOnly;

    await expect(createEvent(context, input)).rejects.toThrow(/только для чтения/);
  });

  // Без проверки событие с концом раньше начала молча уходит на сервер как
  // есть: CalDAV ничего подобного не проверяет, а ical.js собирает VEVENT с
  // DTEND раньше DTSTART без единой жалобы.
  it("отказывается создавать событие, где конец раньше начала", async () => {
    const { context } = stand();

    await expect(
      createEvent(context, { ...input, start: "2026-09-21T14:00:00+03:00", end: "2026-09-21T10:00:00+03:00" }),
    ).rejects.toThrow(/конец.*начал/i);
  });

  it("отказывается создавать событие с одинаковыми началом и концом", async () => {
    const { context } = stand();

    await expect(createEvent(context, { ...input, end: input.start })).rejects.toThrow(/конец.*начал/i);
  });

  it("отказывается создавать событие с пустым заголовком", async () => {
    const { context } = stand();

    await expect(createEvent(context, { ...input, summary: "   " })).rejects.toThrow(/заголов/i);
  });

  // Р8: слепого повтора нет. Сервер не ответил — объект перечитывается по
  // UID, и, раз его нет, допустима ровно одна повторная попытка.
  it("после потерянного ответа перечитывает объект и повторяет запись ровно раз", async () => {
    const { context, puts } = stand((index) =>
      index === 0 ? { status: "unknown", error: new Error("обрыв сети") } : { status: "applied", etag: "etag-2" },
    );
    let finds = 0;
    (context.io as ObjectIO).find = async () => {
      finds += 1;
      return undefined;
    };

    const event = await createEvent(context, input);

    expect(puts).toHaveLength(2);
    expect(finds).toBe(1);
    expect(event.etag).toBe("etag-2");
  });
});

describe("createEvents", () => {
  it("создаёт все события и отчитывается по каждому", async () => {
    const { context } = stand();

    const results = await createEvents(context, [
      { ...input, summary: "Первое" },
      { ...input, summary: "Второе" },
    ]);

    expect(results).toHaveLength(2);
    expect(results.every((result) => result.ok)).toBe(true);
  });

  it("продолжает работу после отказа по одному событию", async () => {
    const { context } = stand((index) =>
      index === 1 ? { status: "rejected", error: new Error("Доступ запрещён") } : { status: "applied", etag: "etag" },
    );

    const results = await createEvents(context, [
      { ...input, summary: "Первое" },
      { ...input, summary: "Второе" },
      { ...input, summary: "Третье" },
    ]);

    expect(results.map((result) => result.ok)).toEqual([true, false, true]);
    expect(results[1].error).toContain("Доступ запрещён");
  });

  // buildEvent кладёт в VCALENDAR клон общего компонента VTIMEZONE из
  // ICAL.TimezoneService, а не сам общий объект. createEvents вызывает
  // buildEvent в цикле — без клонирования addSubcomponent у второго события
  // отцепил бы VTIMEZONE от календаря предыдущего, ещё не отправленного.
  it("у каждого события в пачке с общим часовым поясом — свой независимый блок VTIMEZONE", async () => {
    const { context, puts } = stand();

    await createEvents(context, [
      { ...input, summary: "Первое" },
      { ...input, summary: "Второе" },
      { ...input, summary: "Третье" },
    ]);

    expect(puts).toHaveLength(3);
    for (const put of puts) {
      expect(put.ics).toContain("BEGIN:VTIMEZONE");
      expect(put.ics).toContain("TZID:Europe/Moscow");
      expect(put.ics).toContain("END:VTIMEZONE");
    }
  });

  // CalDAV не пакетирует запросы — каждое событие уходит отдельным PUT
  // последовательно, поэтому случайно огромная пачка не сломается, но будет
  // линейно долгой и рискует упереться в таймаут вызывающей стороны.
  it("отказывается обрабатывать пачку, превышающую предел размера", async () => {
    const { context } = stand();
    const huge = Array.from({ length: 51 }, (_, index) => ({ ...input, summary: `Событие ${index}` }));

    await expect(createEvents(context, huge)).rejects.toThrow(/предел|размер/i);
  });
});
