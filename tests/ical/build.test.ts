import ICAL from "ical.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildEvent } from "../../src/ical/build.js";
import { parseEvent } from "../../src/ical/parse.js";
import { registerTimeZone } from "../../src/ical/timezones.js";

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

      const dtstampOf = (ics: string) =>
        ics.split("\r\n").find((line) => line.startsWith("DTSTAMP:"));

      try {
        process.env.TZ = "UTC";
        const dtstampUtc = dtstampOf(buildEvent(base).ics);

        process.env.TZ = "America/New_York";
        const dtstampNy = dtstampOf(buildEvent(base).ics);

        expect(dtstampUtc).toBe("DTSTAMP:20260918T155319Z");
        expect(dtstampNy).toBe(dtstampUtc);
      } finally {
        if (originalTz === undefined) delete process.env.TZ;
        else process.env.TZ = originalTz;
      }
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
  // node_modules/ical.js/lib/ical/component.js). Собираем два события с
  // одним и тем же поясом ПОДРЯД, ничего не сериализуя вручную между
  // вызовами (сериализацию делает сам buildEvent), и проверяем обе
  // получившиеся строки — по рецепту ревью.
  //
  // Уточнение по факту проверки (важно для честности теста): сама по себе
  // пара «собрать → собрать» НЕ портит уже ВОЗВРАЩЁННУЮ строку первого
  // события — buildEvent вызывает calendar.toString() синхронно и
  // возвращает готовую неизменяемую строку ДО того, как начнётся второй
  // вызов, так что более поздняя мутация общего объекта эту строку не
  // затрагивает. Проверено прогоном: проверка «обе строки содержат
  // VTIMEZONE» зелёная даже БЕЗ cloneComponent (то есть сама по себе не
  // ловит баг из находки 3). Реальный разрыв — на уровне общего объекта из
  // кеша TimezoneService: без cloneComponent его `.parent` после каждого
  // вызова buildEvent переключается на календарь ПОСЛЕДНЕГО собранного
  // события, а не остаётся стабильным. Это станет наблюдаемой порчей
  // данных, если что-то (например, пакетная сборка в задаче 12) станет
  // держать VCALENDAR как дерево компонентов до отложенной сериализации,
  // а не как уже готовую строку. Поэтому ниже, вместе с проверкой обеих
  // строк по рецепту, добавлена проверка самого инварианта — что
  // buildEvent не трогает `.parent` общего объекта из сервиса.
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

    // Настоящая точка разрыва находки 3: общий компонент из кеша сервиса
    // не должен быть переприсвоен новому родителю ни одним из вызовов.
    expect(sharedComponent.parent).toBe(parentBeforeBuilds);
  });
});
