import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ICAL from "ical.js";
import { afterAll, afterEach, beforeAll, describe, expect, expectTypeOf, it, vi } from "vitest";
import { BuildError, buildEvent } from "../../src/ical/build.js";
import type { NewEvent } from "../../src/ical/build.js";
import { parseEvent } from "../../src/ical/parse.js";
import { registerTimeZone } from "../../src/ical/timezones.js";
import type { CalendarEvent, Recurrence } from "../../src/types.js";

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

// Серия на весь день: 23.09.2026, DTEND исключающий — 24.09.
const allDayBase = {
  ...base,
  allDay: true,
  start: "2026-09-23",
  end: "2026-09-24",
};

// Строки с разворотом продолжений (RFC 5545 §3.1): так проверки не
// зависят от того, где foldline разорвал длинную строку.
function lines(ics: string): string[] {
  return ics.replace(/\r\n[ \t]/g, "").split("\r\n");
}

// Первая строка свойства внутри VEVENT: у VTIMEZONE свои DTSTART.
function line(ics: string, name: string): string | undefined {
  const all = lines(ics);
  return all
    .slice(all.indexOf("BEGIN:VEVENT"))
    .find((entry) => entry.startsWith(`${name}:`) || entry.startsWith(`${name};`));
}

// Начала встреч серии по правилу из собранного текста: стенное время DTSTART
// (у даты — дата), по RFC 5545 §3.3.10 — от DTSTART до UNTIL включительно.
// Итератор ical.js: node_modules/ical.js/lib/ical/recur.js, iterator;
// остановка по UNTIL — recur_iterator.js, next (сравнение по моменту).
function occurrences(ics: string, limit = 500): string[] {
  const vevent = new ICAL.Component(ICAL.parse(ics)).getFirstSubcomponent("vevent");
  if (!vevent) throw new Error("нет VEVENT");
  const tzid = vevent.getFirstProperty("dtstart")?.getParameter("tzid");
  // Пояс — до чтения значения: иначе ical.js прочтёт время как плавающее.
  if (typeof tzid === "string") registerTimeZone(tzid);
  const start = vevent.getFirstPropertyValue("dtstart") as ICAL.Time;
  const rule = vevent.getFirstPropertyValue("rrule") as ICAL.Recur;
  const iterator = rule.iterator(start);
  const result: string[] = [];
  for (let next = iterator.next(); next && result.length < limit; next = iterator.next()) {
    result.push(next.toString());
  }
  return result;
}

// Что бросила сборка. Намеренно без instanceof: на старом коде класса
// BuildError нет, и каждый тест должен падать своим сообщением.
function thrownBy(action: () => unknown): { name?: string; code?: string; message?: string } {
  try {
    action();
  } catch (error) {
    return error as { name?: string; code?: string; message?: string };
  }
  throw new Error("Сборка не отказала, хотя должна была.");
}

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
    const recurrence = { frequency: "weekly" as const, interval: 1, byWeekday: ["MO", "WE"] as ("MO" | "WE")[], count: 6 };

    const parsed = parseEvent(buildEvent({ ...base, recurrence }).ics, "work");

    expect(parsed.recurrence).toEqual(recurrence);
  });

  it("пишет событие на весь день как DATE без времени", () => {
    const { ics } = buildEvent({
      ...base,
      allDay: true,
      start: "2026-09-23T00:00:00+03:00",
      end: "2026-09-24T00:00:00+03:00",
    });

    expect(ics).toContain("DTSTART;VALUE=DATE:20260923");
    expect(ics).toContain("DTEND;VALUE=DATE:20260924");
    expect(ics).not.toContain("T000000");
    expect(ics).not.toContain("BEGIN:VTIMEZONE");
  });

  it("выдаёт свой UID, когда его не передали, и берёт переданный", () => {
    const first = buildEvent(base);
    const second = buildEvent(base);

    expect(first.uid).toBeTruthy();
    expect(first.uid).not.toBe(second.uid);

    const own = buildEvent({ ...base, id: "своё-событие-1" });
    expect(own.uid).toBe("своё-событие-1");
    expect(line(own.ics, "UID")).toBe("UID:своё-событие-1");
  });

  // Находка ревью (Important): DTSTAMP обязан быть в UTC по RFC 5545 §3.8.7.2.
  // ICAL.Time.now() внутри вызывает fromJSDate(new Date(), false) — тот же
  // баг, что был в toIcalTime, только для «текущего момента». Фиксируем
  // момент времени через фейковые таймеры и дважды пересобираем событие под
  // разными значениями TZID процесса: при правильной реализации строка
  // DTSTAMP не должна зависеть от часового пояса хоста.
  describe("DTSTAMP", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("пишется в UTC с суффиксом Z одинаково при любом поясе процесса", () => {
      const originalTz = process.env.TZ;
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-09-18T15:53:19.000Z"));

      try {
        process.env.TZ = "UTC";
        const dtstampUtc = line(buildEvent(base).ics, "DTSTAMP");

        process.env.TZ = "America/New_York";
        const dtstampNy = line(buildEvent(base).ics, "DTSTAMP");

        expect(dtstampUtc).toBe("DTSTAMP:20260918T155319Z");
        expect(dtstampNy).toBe(dtstampUtc);
      } finally {
        if (originalTz === undefined) delete process.env.TZ;
        else process.env.TZ = originalTz;
      }
    });

    it("берётся из переданных часов, если они заданы", () => {
      const { ics } = buildEvent(base, { now: new Date("2026-10-21T08:30:05.900Z") });

      expect(line(ics, "DTSTAMP")).toBe("DTSTAMP:20261021T083005Z");
    });
  });

  // Находка ревью (Important): buildEvent регистрирует пояс в глобальном
  // ICAL.TimezoneService, и если бы parseEvent (или этот тест) брал зону из
  // того же кеша, порча текста самого блока VTIMEZONE в собранной ICS-строке
  // прошла бы незамеченной. Здесь блок вытаскивается из текста и на нём
  // строится независимый ICAL.Timezone — в обход TimezoneService.
  it("сериализует блок VTIMEZONE так, что из его текста восстанавливается верное смещение", () => {
    const { ics } = buildEvent(base);
    const root = new ICAL.Component(ICAL.parse(ics));
    const vtimezone = root.getFirstSubcomponent("vtimezone");
    expect(vtimezone).toBeTruthy();

    const zoneFromText = new ICAL.Timezone(vtimezone as ICAL.Component);
    expect(zoneFromText.tzid).toBe("Europe/Moscow");

    const time = new ICAL.Time(
      { year: 2026, month: 9, day: 21, hour: 10, minute: 0, second: 0, isDate: false },
      zoneFromText,
    );
    expect(time.utcOffset()).toBe(3 * 3600);
  });

  // Находка ревью (Minor, включена в круг 1): registerTimeZone(...).component
  // — общий объект ICAL.Component, закешированный в ICAL.TimezoneService.
  // addSubcomponent() отцепляет добавляемый компонент от предыдущего
  // родителя (component.parent.removeSubcomponent(component) в
  // node_modules/ical.js/lib/ical/component.js). Сборка не должна трогать
  // этот общий объект: иначе дерево одного календаря незаметно теряло бы
  // VTIMEZONE при сборке следующего.
  it("не портит VTIMEZONE предыдущего события при повторной сборке с тем же поясом", () => {
    const sharedComponent = registerTimeZone(base.timeZone).component;
    const parentBeforeBuilds = sharedComponent.parent;

    const first = buildEvent(base);
    const second = buildEvent(base);

    for (const [label, ics] of [
      ["первое", first.ics],
      ["второе", second.ics],
    ] as const) {
      expect(ics, `${label} событие должно содержать блок VTIMEZONE`).toContain(
        "BEGIN:VTIMEZONE",
      );
      expect(ics, `${label} событие должно содержать TZID:Europe/Moscow`).toContain(
        "TZID:Europe/Moscow",
      );
    }

    expect(sharedComponent.parent).toBe(parentBeforeBuilds);
  });
});

// ─── Время без пояса процесса (З15) ──────────────────────────────────────────
//
// Каждый тест блока гоняется под тремя поясами процесса. `npm run test:tz`
// делает то же для всего набора, но обычный `npx vitest run` идёт в поясе
// машины, где часть ошибок прежнего кода не видна (в Москве стенное время
// Москвы совпадает с поясом события).
const PROCESS_ZONES = ["UTC", "Europe/Moscow", "America/New_York"] as const;

describe.each(PROCESS_ZONES)("buildEvent под поясом процесса %s", (processZone) => {
  let savedTz: string | undefined;

  beforeAll(() => {
    savedTz = process.env.TZ;
    process.env.TZ = processZone;
  });

  afterAll(() => {
    if (savedTz === undefined) delete process.env.TZ;
    else process.env.TZ = savedTz;
  });

  it("пояс процесса действительно сменился", () => {
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(processZone);
  });

  it("ISO без смещения — стенное время в поясе события, а не процесса", () => {
    const { ics } = buildEvent({ ...base, start: "2026-09-21T10:00:00", end: "2026-09-21T11:30:00" });

    expect(line(ics, "DTSTART")).toBe("DTSTART;TZID=Europe/Moscow:20260921T100000");
    expect(line(ics, "DTEND")).toBe("DTEND;TZID=Europe/Moscow:20260921T113000");
  });

  it.each(["Europe/Moscow", "America/New_York"])(
    "YYYY-MM-DD у события на весь день — та же дата буквально, пояс события %s",
    (timeZone) => {
      const { ics } = buildEvent({ ...allDayBase, timeZone });

      expect(line(ics, "DTSTART")).toBe("DTSTART;VALUE=DATE:20260923");
      expect(line(ics, "DTEND")).toBe("DTEND;VALUE=DATE:20260924");
    },
  );

  it("UNTIL серии на весь день пишется датой, и последняя встреча — в этот день", () => {
    const { ics } = buildEvent({
      ...allDayBase,
      recurrence: { frequency: "daily", interval: 1, until: "2026-09-30" },
    });

    expect(line(ics, "RRULE")).toMatch(/[:;]UNTIL=20260930(;|$)/);
    expect(occurrences(ics)).toEqual([
      "2026-09-23",
      "2026-09-24",
      "2026-09-25",
      "2026-09-26",
      "2026-09-27",
      "2026-09-28",
      "2026-09-29",
      "2026-09-30",
    ]);
  });

  it("UNTIL датой у серии со временем включает этот день целиком в поясе события", () => {
    const { ics } = buildEvent({
      ...base,
      recurrence: { frequency: "daily", interval: 1, until: "2026-09-30" },
    });

    // Конец 30.09 по Москве — 20:59:59 UTC (RFC 5545 §3.3.10: при TZID UNTIL в UTC).
    expect(line(ics, "RRULE")).toMatch(/[:;]UNTIL=20260930T205959Z(;|$)/);
    const starts = occurrences(ics);
    expect(starts).toHaveLength(10);
    expect(starts.at(-1)).toBe("2026-09-30T10:00:00");
  });

  it("UNTIL без смещения — стенное время в поясе события", () => {
    const { ics } = buildEvent({
      ...base,
      recurrence: { frequency: "daily", interval: 1, until: "2026-09-30T10:00:00" },
    });

    expect(line(ics, "RRULE")).toMatch(/[:;]UNTIL=20260930T070000Z(;|$)/);
    expect(occurrences(ics).at(-1)).toBe("2026-09-30T10:00:00");
  });
});

describe("buildEvent: моменты и формы времени", () => {
  it("момент со смещением переводится в стенное время пояса события", () => {
    const { ics } = buildEvent({ ...base, start: "2026-09-21T07:00:00Z", end: "2026-09-21T08:00:00Z" });

    expect(line(ics, "DTSTART")).toBe("DTSTART;TZID=Europe/Moscow:20260921T100000");
    expect(line(ics, "DTEND")).toBe("DTEND;TZID=Europe/Moscow:20260921T110000");
  });

  it("у весеннего перехода пишет настоящее стенное время, а не время из разрыва", () => {
    // 29.03.2026 в 01:00 UTC Берлин переходит с +01:00 на +02:00: это 03:00, а не 02:00.
    const { ics } = buildEvent({
      ...base,
      timeZone: "Europe/Berlin",
      start: "2026-03-29T01:00:00Z",
      end: "2026-03-29T02:00:00Z",
    });

    expect(line(ics, "DTSTART")).toBe("DTSTART;TZID=Europe/Berlin:20260329T030000");
    expect(line(ics, "DTEND")).toBe("DTEND;TZID=Europe/Berlin:20260329T040000");
  });

  it("стенное время из разрыва перехода отклоняется", () => {
    // 08.03.2026 в Нью-Йорке часы переводятся с 02:00 сразу на 03:00.
    const error = thrownBy(() =>
      buildEvent({ ...base, timeZone: "America/New_York", start: "2026-03-08T02:30:00", end: "2026-03-08T04:00:00" }),
    );

    expect(error).toMatchObject({ name: "BuildError", code: "invalid-time" });
    expect(error.message).toContain("2026-03-08T02:30");
  });

  it("стенное время из повторного часа осеннего перехода принимается как записано", () => {
    // 01.11.2026 в Нью-Йорке час 01:00–02:00 проходит дважды; RFC 5545 §3.3.5 читает первое вхождение.
    const { ics } = buildEvent({
      ...base,
      timeZone: "America/New_York",
      start: "2026-11-01T01:30:00",
      end: "2026-11-01T03:00:00",
    });

    expect(line(ics, "DTSTART")).toBe("DTSTART;TZID=America/New_York:20261101T013000");
  });

  it("пояс UTC — время с Z, без TZID и без VTIMEZONE", () => {
    const { ics } = buildEvent({ ...base, timeZone: "UTC" });

    expect(line(ics, "DTSTART")).toBe("DTSTART:20260921T070000Z");
    expect(line(ics, "DTEND")).toBe("DTEND:20260921T110000Z");
    expect(ics).not.toContain("TZID=UTC");
    expect(ics).not.toContain("BEGIN:VTIMEZONE");

    const parsed = parseEvent(ics, "work");
    expect(parsed.timeZone).toBe("UTC");
    expect(parsed.start).toBe("2026-09-21T07:00:00+00:00");
  });

  it("текст и расчёт времени не зависят от чужого описания пояса в TimezoneService", () => {
    // Описание пояса мог зарегистрировать разбор чужого объекта. Сборка
    // считает время по тому же описанию, что вкладывает в текст, — из базы.
    const foreign = new ICAL.Component([
      "vtimezone",
      [["tzid", {}, "text", "Europe/Moscow"]],
      [
        [
          "standard",
          [
            ["tzoffsetfrom", {}, "utc-offset", "+05:00"],
            ["tzoffsetto", {}, "utc-offset", "+05:00"],
            ["dtstart", {}, "date-time", "1970-01-01T00:00:00"],
          ],
          [],
        ],
      ],
    ]);
    const previous = ICAL.TimezoneService.get("Europe/Moscow");
    ICAL.TimezoneService.register(new ICAL.Timezone({ component: foreign, tzid: "Europe/Moscow" }), "Europe/Moscow");
    try {
      // Момент со смещением.
      const { ics } = buildEvent(base);

      expect(line(ics, "DTSTART")).toBe("DTSTART;TZID=Europe/Moscow:20260921T100000");
      expect(ics).toContain("TZOFFSETTO:+0300");
      expect(ics).not.toContain("+0500");

      // Стенное время без смещения (правка по ревью): разобранное как
      // плавающее, оно досчитывалось бы через пояс календаря, то есть через
      // TimezoneService, и при фиктивном +05:00 сдвинулось бы на 08:00.
      const wall = buildEvent({
        ...base,
        start: "2026-09-21T10:00:00",
        end: "2026-09-21T11:00:00",
        recurrence: { frequency: "daily", interval: 1, until: "2026-09-30T10:00:00" },
      });

      expect(line(wall.ics, "DTSTART")).toBe("DTSTART;TZID=Europe/Moscow:20260921T100000");
      expect(line(wall.ics, "DTEND")).toBe("DTEND;TZID=Europe/Moscow:20260921T110000");
      // 10:00 по Москве (+03:00) — 07:00 UTC; при +05:00 было бы 05:00.
      expect(line(wall.ics, "RRULE")).toMatch(/[:;]UNTIL=20260930T070000Z(;|$)/);

      // UNTIL датой — конец дня по описанию из базы: 23:59:59 +03:00.
      const byDate = buildEvent({ ...base, recurrence: { frequency: "daily", interval: 1, until: "2026-09-30" } });

      expect(line(byDate.ics, "RRULE")).toMatch(/[:;]UNTIL=20260930T205959Z(;|$)/);
    } finally {
      ICAL.TimezoneService.remove("Europe/Moscow");
      if (previous) ICAL.TimezoneService.register(previous, "Europe/Moscow");
    }
  });

  it("событие со временем без времени в start отклоняется", () => {
    const error = thrownBy(() => buildEvent({ ...base, start: "2026-09-21", end: "2026-09-21T11:00:00+03:00" }));

    expect(error).toMatchObject({ name: "BuildError", code: "invalid-time" });
    expect(error.message).toContain("start");
  });

  it("у события на весь день время кроме полуночи отклоняется: дата неоднозначна", () => {
    // 21:00 UTC 22.09 — это полночь 23.09 по Москве, но 22.09 по UTC.
    const error = thrownBy(() => buildEvent({ ...allDayBase, start: "2026-09-22T21:00:00Z" }));

    expect(error).toMatchObject({ name: "BuildError", code: "invalid-time" });
    expect(error.message).toContain("YYYY-MM-DD");
  });

  it.each([
    ["со временем", { ...base, end: base.start }],
    ["на весь день", { ...allDayBase, end: allDayBase.start }],
    ["на весь день, конец раньше", { ...allDayBase, end: "2026-09-22" }],
  ])("конец не позже начала отклоняется (%s)", (_label, event) => {
    expect(thrownBy(() => buildEvent(event))).toMatchObject({ name: "BuildError", code: "invalid-time" });
  });

  it("неразбираемое время отклоняется с именем поля", () => {
    const error = thrownBy(() => buildEvent({ ...base, end: "завтра в десять" }));

    expect(error).toMatchObject({ name: "BuildError", code: "invalid-time" });
    expect(error.message).toContain("end");
  });

  // У события на весь день пояс в текст не пишется, но проверяется так же
  // (правка по ревью): неверный пояс иначе ушёл бы в ответ createEvent.
  it.each([
    ["со временем", { ...base, timeZone: "Mars/Olympus_Mons" }],
    ["на весь день", { ...allDayBase, timeZone: "Mars/Olympus_Mons" }],
  ])("неизвестный пояс отклоняется (%s)", (_label, event) => {
    const error = thrownBy(() => buildEvent(event));

    expect(error).toMatchObject({ name: "BuildError", code: "unknown-timezone" });
    expect(error.message).toContain("Mars/Olympus_Mons");
  });

  it.each(["UTC", "GMT", "Etc/UTC", "America/New_York"])(
    "у события на весь день известный пояс %s принимается и в текст не пишется",
    (timeZone) => {
      const { ics } = buildEvent({ ...allDayBase, timeZone });

      expect(line(ics, "DTSTART")).toBe("DTSTART;VALUE=DATE:20260923");
      expect(ics).not.toContain("TZID");
      expect(ics).not.toContain("BEGIN:VTIMEZONE");
    },
  );

  it("отказ — экземпляр BuildError", () => {
    expect(thrownBy(() => buildEvent({ ...base, end: base.start }))).toBeInstanceOf(BuildError);
  });
});

describe("buildEvent: правило повтора", () => {
  // Ж6 (docs/yandex-caldav-capabilities.md): BYSETPOS Яндекс молча
  // заменяет другим правилом, WKST выбрасывает.
  it.each([
    ["BYSETPOS", "BYSETPOS=-1"],
    ["WKST", "WKST=SU"],
    ["BYSETPOS", "WKST=SU;BYSETPOS=-1"],
  ])("правило с %s отклоняется с объяснением про Яндекс", (part, unmodeled) => {
    // Повтор прочитанной серии: тип Recurrence несёт unmodeled, NewRecurrence — нет.
    const recurrence: Recurrence = {
      frequency: "monthly",
      interval: 1,
      byWeekday: ["MO", "TU", "WE", "TH", "FR"],
      unmodeled,
    };
    const error = thrownBy(() => buildEvent({ ...base, recurrence }));

    expect(error).toMatchObject({ name: "BuildError", code: "unsupported-rule" });
    expect(error.message).toContain(part);
    expect(error.message).toContain("Яндекс");
  });

  it("прочие части правила вне модели тоже отклоняются, а не теряются молча", () => {
    const recurrence: Recurrence = { frequency: "monthly", interval: 1, unmodeled: "BYMONTHDAY=1,15" };
    const error = thrownBy(() => buildEvent({ ...base, recurrence }));

    expect(error).toMatchObject({ name: "BuildError", code: "unsupported-rule" });
    expect(error.message).toContain("BYMONTHDAY=1,15");
  });

  it("части правила не протаскиваются через byWeekday", () => {
    const error = thrownBy(() =>
      buildEvent({
        ...base,
        recurrence: { frequency: "monthly", interval: 1, byWeekday: ["MO;BYSETPOS=-1"] as unknown as ["MO"] },
      }),
    );

    expect(error).toMatchObject({ name: "BuildError", code: "invalid-rule" });
  });

  it.each([
    ["порядковый номер при WEEKLY", { frequency: "weekly", interval: 1, byWeekday: ["2MO"] }],
    ["порядковый номер при DAILY", { frequency: "daily", interval: 1, byWeekday: ["-1FR"] }],
    ["номер больше 5 при MONTHLY", { frequency: "monthly", interval: 1, byWeekday: ["6MO"] }],
    ["номер 0", { frequency: "yearly", interval: 1, byWeekday: ["0MO"] }],
    ["номер больше 53 при YEARLY", { frequency: "yearly", interval: 1, byWeekday: ["54MO"] }],
    // ical.js читает у номера одну цифру (см. тест «основание предела» ниже).
    ["двузначный номер 20MO при YEARLY", { frequency: "yearly", interval: 1, byWeekday: ["20MO"] }],
    ["двузначный номер -12FR при YEARLY", { frequency: "yearly", interval: 1, byWeekday: ["-12FR"] }],
    ["номер 10MO при YEARLY — первый за пределом", { frequency: "yearly", interval: 1, byWeekday: ["10MO"] }],
    // «05MO» грамматика RFC 5545 не допускает, и ICAL.parse такой текст не читает.
    ["номер с ведущим нулём", { frequency: "monthly", interval: 1, byWeekday: ["05MO"] }],
    ["номер с ведущим нулём и знаком", { frequency: "yearly", interval: 1, byWeekday: ["-01FR"] }],
    ["COUNT вместе с UNTIL", { frequency: "daily", interval: 1, count: 3, until: "2026-09-30" }],
    ["COUNT ноль", { frequency: "daily", interval: 1, count: 0 }],
    ["дробный COUNT", { frequency: "daily", interval: 1, count: 2.5 }],
    ["INTERVAL ноль", { frequency: "daily", interval: 0 }],
    ["частота вне модели", { frequency: "hourly", interval: 1 }],
    ["UNTIL раньше начала", { frequency: "daily", interval: 1, until: "2026-09-20" }],
  ])("отклоняется: %s", (_label, recurrence) => {
    const error = thrownBy(() => buildEvent({ ...base, recurrence: recurrence as unknown as NewEvent["recurrence"] }));

    expect(error).toMatchObject({ name: "BuildError", code: "invalid-rule" });
  });

  it("UNTIL раньше начала у серии на весь день отклоняется", () => {
    const error = thrownBy(() =>
      buildEvent({ ...allDayBase, recurrence: { frequency: "daily", interval: 1, until: "2026-09-22" } }),
    );

    expect(error).toMatchObject({ name: "BuildError", code: "invalid-rule" });
  });

  it("порядковые номера BYDAY при MONTHLY принимаются", () => {
    const monthly = buildEvent({
      ...base,
      recurrence: { frequency: "monthly", interval: 1, byWeekday: ["2MO", "-1FR"], count: 4 },
    });

    expect(line(monthly.ics, "RRULE")).toBe("RRULE:FREQ=MONTHLY;INTERVAL=1;BYDAY=2MO,-1FR;COUNT=4");
    expect(occurrences(monthly.ics)).toHaveLength(4);
  });

  // Даты посчитаны вручную по RFC 5545 §3.3.10 (n-й день недели года, с
  // конца — при минусе): 1 января 2026 — четверг, 2027 — пятница, 2028 — суббота.
  it.each([
    ["2MO", "2026-01-12", ["2026-01-12", "2027-01-11", "2028-01-10"]],
    ["9MO", "2026-03-02", ["2026-03-02", "2027-03-01", "2028-02-28"]],
    ["-1FR", "2026-12-25", ["2026-12-25", "2027-12-31", "2028-12-29"]],
    ["-9SU", "2026-11-01", ["2026-11-01", "2027-10-31", "2028-11-05"]],
  ])("YEARLY с номером %s: встречи раз в год, в нужный день", (byday, date, dates) => {
    const { ics } = buildEvent({
      ...base,
      start: `${date}T10:00:00+03:00`,
      end: `${date}T11:00:00+03:00`,
      recurrence: { frequency: "yearly", interval: 1, byWeekday: [byday as "MO"], count: 3 },
    });

    expect(line(ics, "RRULE")).toBe(`RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=${byday};COUNT=3`);
    expect(occurrences(ics)).toEqual(dates.map((day) => `${day}T10:00:00`));
  });

  it("двузначный номер при YEARLY отклоняется с объяснением ограничения ical.js", () => {
    const error = thrownBy(() =>
      buildEvent({ ...base, recurrence: { frequency: "yearly", interval: 1, byWeekday: ["20MO"] } }),
    );

    expect(error).toMatchObject({ name: "BuildError", code: "invalid-rule" });
    expect(error.message).toContain("20MO");
    expect(error.message).toContain("от 1 до 9");
    expect(error.message).toContain("ical.js");
  });

  // Основание предела ±1…9 при YEARLY: ical.js 2.2.1 разбирает номер BYDAY
  // регулярным выражением /([+-]?[0-9])?(MO|…)/ без привязки к началу строки
  // (node_modules/ical.js/lib/ical/recur_iterator.js, ruleDayOfWeek), поэтому
  // «20MO» читает как «0MO» — каждый понедельник. Если этот тест упадёт после
  // обновления ical.js, предел в build.ts (checkedByday) можно расширить до 53.
  it("основание предела: ical.js раскрывает BYDAY=20MO как каждый понедельник", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//test//RU",
      "BEGIN:VEVENT",
      "UID:byday-20mo",
      "DTSTAMP:20260919T000000Z",
      "DTSTART:20260518T070000Z",
      "RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=20MO;COUNT=3",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    // По RFC 5545 — двадцатый понедельник года: 18.05.2026, 17.05.2027, 22.05.2028.
    expect(occurrences(ics)).toEqual(["2026-05-18T07:00:00Z", "2026-05-25T07:00:00Z", "2026-06-01T07:00:00Z"]);
  });

  // О12а плана: UNTIL ≥ DTSTART; UNTIL включителен (RFC 5545 §3.3.10).
  it.each([
    ["со временем", { ...base, recurrence: { frequency: "daily", interval: 1, until: base.start } }, "UNTIL=20260921T070000Z", ["2026-09-21T10:00:00"]],
    ["на весь день", { ...allDayBase, recurrence: { frequency: "daily", interval: 1, until: allDayBase.start } }, "UNTIL=20260923", ["2026-09-23"]],
  ] as const)("UNTIL, равный началу, принимается: одна встреча (%s)", (_label, event, until, starts) => {
    const { ics } = buildEvent(event);

    expect(line(ics, "RRULE")).toMatch(new RegExp(`[:;]${until}(;|$)`));
    expect(occurrences(ics)).toEqual(starts);
  });

  it("UNTIL из разрыва весеннего перевода отклоняется", () => {
    // 08.03.2026 в Нью-Йорке часы переводятся с 02:00 сразу на 03:00.
    const error = thrownBy(() =>
      buildEvent({
        ...base,
        timeZone: "America/New_York",
        start: "2026-03-01T10:00:00",
        end: "2026-03-01T11:00:00",
        recurrence: { frequency: "daily", interval: 1, until: "2026-03-08T02:30:00" },
      }),
    );

    expect(error).toMatchObject({ name: "BuildError", code: "invalid-time" });
    expect(error.message).toContain("recurrence.until");
  });
});

describe("buildEvent: на вход — только новое событие", () => {
  const readEvent: CalendarEvent = {
    ...base,
    id: "series-1",
    recurrence: { frequency: "weekly", interval: 1, byWeekday: ["MO"] },
    etag: "1789383239000",
    href: "/calendars/user/events-1/series-1.ics",
    recurring: true,
    status: "confirmed",
  };

  it.each([
    ["recurrenceRule", { recurrenceRule: "RRULE:FREQ=HOURLY;INTERVAL=2" }, "unsupported-rule"],
    ["exceptions", { exceptions: [{ instanceStart: "2026-09-28T10:00:00+03:00", state: "excluded" }] }, "read-only-field"],
    ["anomalies", { anomalies: ["duplicate-override: два компонента с одним RECURRENCE-ID"] }, "read-only-field"],
  ] as const)("прочитанное событие с %s отклоняется: сборка это состояние не пишет", (field, extra, code) => {
    const error = thrownBy(() => buildEvent({ ...readEvent, ...extra }));

    expect(error).toMatchObject({ name: "BuildError", code });
    expect(error.message).toContain(field);
  });

  it("служебные поля чтения без состояния серии в текст не попадают", () => {
    const { ics, uid } = buildEvent(readEvent);

    expect(uid).toBe("series-1");
    expect(ics).not.toContain("1789383239000");
    expect(ics).not.toContain("STATUS");
  });

  it.each([
    ["пустой заголовок", { ...base, summary: "  " }],
    ["пустой UID", { ...base, id: "" }],
    ["дробное напоминание", { ...base, reminders: [{ minutesBefore: 1.5, method: "display" as const }] }],
  ])("отклоняется: %s", (_label, event) => {
    expect(thrownBy(() => buildEvent(event))).toMatchObject({ name: "BuildError", code: "invalid-field" });
  });

  // NewEvent — только поля, которые сборка пишет (замечание З04). Типов во
  // время выполнения нет, а tsconfig.json проекта проверяет только src/,
  // поэтому этот файл проверяется tsc отдельно: утверждения функции
  // newEventTypeContract (ниже) проверяет компилятор, сама она не вызывается.
  it("NewEvent сужен до записываемых полей (проверка tsc)", async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const root = join(here, "..", "..");
    const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
    const args = [
      tsc,
      "--ignoreConfig",
      "--noEmit",
      "--pretty",
      "false",
      "--strict",
      "--target",
      "ES2022",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--esModuleInterop",
      "--skipLibCheck",
      "--types",
      "node",
      fileURLToPath(import.meta.url),
    ];
    const { code, output } = await new Promise<{ code: number; output: string }>((resolve) => {
      execFile(process.execPath, args, { cwd: root }, (error, stdout, stderr) => {
        resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, output: `${stdout}${stderr}` });
      });
    });

    expect(output).toBe("");
    expect(code).toBe(0);
  }, 60_000);
});

// Не вызывается: только для tsc (см. тест выше).
export function newEventTypeContract(read: CalendarEvent): void {
  expectTypeOf<keyof NewEvent>().toEqualTypeOf<
    | "id"
    | "summary"
    | "description"
    | "location"
    | "start"
    | "end"
    | "timeZone"
    | "allDay"
    | "recurrence"
    | "reminders"
    | "attendees"
  >();
  expectTypeOf<keyof NonNullable<NewEvent["recurrence"]>>().toEqualTypeOf<
    "frequency" | "interval" | "byWeekday" | "until" | "count"
  >();

  // Прочитанное событие годится как вход: лишние поля не мешают, а то
  // состояние серии, которое сборка не пишет, отсекается при выполнении.
  buildEvent(read);

  const minimal: NewEvent = {
    summary: "Встреча",
    start: "2026-09-21T10:00:00+03:00",
    end: "2026-09-21T11:00:00+03:00",
    timeZone: "Europe/Moscow",
    allDay: false,
    reminders: [],
    attendees: [],
  };
  // @ts-expect-error — поля чтения в новом событии не объявлены.
  const withExceptions: NewEvent = { ...minimal, exceptions: [] };
  // @ts-expect-error — STATUS сборка не пишет.
  const withStatus: NewEvent = { ...minimal, status: "cancelled" };
  // @ts-expect-error — части правила вне модели сборка не пишет.
  const withUnmodeled: NewEvent = { ...minimal, recurrence: { frequency: "monthly", interval: 1, unmodeled: "BYSETPOS=-1" } };
  void withExceptions;
  void withStatus;
  void withUnmodeled;
}
