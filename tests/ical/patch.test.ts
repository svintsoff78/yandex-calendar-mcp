import ICAL from "ical.js";
import { describe, expect, it } from "vitest";
import { instancesBetween } from "../../src/ical/instances.js";
import { loadObject, serializeObject, type CalendarObject } from "../../src/ical/object.js";
import { EditRefusal, type Touched } from "../../src/ical/plan.js";
import {
  applyFieldPatch,
  cloneComponent,
  distortedParts,
  inheritFields,
  newTouched,
  overrideFromMaster,
  patchRule,
  resolveTimes,
  setRuleEnd,
  touchMetadata,
} from "../../src/ical/patch.js";
import { findSlot } from "../../src/ical/slots.js";
import { vtimezoneFor } from "../../src/ical/timezones.js";
import { formatForModel, type IcalEnv, type SlotKey } from "../../src/ical/values.js";

// Точечная правка полей и правила (О5–О10, Р4 плана переделки,
// docs/superpowers/plans/2026-09-19-recurring-events-rework.md, задача З08).
// Главное свойство: каждое поле трогает только свои ICAL.Property на месте,
// всё прочее в объекте остаётся как было. Прежний код пересобирал объект из
// доменной модели и терял исключения, организатора, участников и части правила.
//
// Тесты не зависят от пояса процесса (npm run test:tz): ожидания — строки
// iCalendar и ISO со смещением.

const ENV: IcalEnv = { floatingZone: "Europe/Moscow", ownerEmail: "user@yandex.ru" };
const CRLF = "\r\n";
const NOW = Date.parse("2026-10-05T12:34:56Z");

const MOSCOW = [
  "BEGIN:VTIMEZONE", "TZID:Europe/Moscow", "BEGIN:STANDARD", "TZNAME:MSK", "TZOFFSETFROM:+0300",
  "TZOFFSETTO:+0300", "DTSTART:19700101T000000", "END:STANDARD", "END:VTIMEZONE",
];

/**
 * Пояс, которого нет ни в базе IANA, ни в ICAL.TimezoneService: ical.js
 * найдёт его только по дереву объекта (component.js, getTimeZoneByID). Тесты
 * с ним не зависят от того, какие пояса зарегистрировали другие тесты.
 */
const PLUS5 = [
  "BEGIN:VTIMEZONE", "TZID:Custom/Plus5", "BEGIN:STANDARD", "TZNAME:P5", "TZOFFSETFROM:+0500",
  "TZOFFSETTO:+0500", "DTSTART:19700101T000000", "END:STANDARD", "END:VTIMEZONE",
];

const UID = "patch-test@yandex.ru";

function vevent(lines: string[], uid = UID): string[] {
  return ["BEGIN:VEVENT", `UID:${uid}`, "DTSTAMP:20261001T090000Z", ...lines, "END:VEVENT"];
}

function calendar(zones: string[], ...events: string[][]): string {
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//patch//RU", ...zones, ...events.flat(), "END:VCALENDAR"]
    .join(CRLF) + CRLF;
}

function load(ics: string): CalendarObject {
  const object = loadObject(ics, ENV);
  if (object.kind === "unparsable") throw new Error(`не разобран: ${object.error}`);
  return object;
}

const alarm = (...lines: string[]) => ["BEGIN:VALARM", ...lines, "END:VALARM"];

/** Серия со всем, что прежний код терял: EXDATE, RDATE, WKST, ORGANIZER, участники, X-, CATEGORIES, чужие VALARM, перенос. */
const RICH_MASTER = [
  "CREATED:20261001T080000Z",
  "LAST-MODIFIED:20261001T090000Z",
  "SEQUENCE:3",
  "DTSTART;TZID=Europe/Moscow:20261019T100000",
  "DTEND;TZID=Europe/Moscow:20261019T110000",
  "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;WKST=SU;COUNT=6",
  "EXDATE;TZID=Europe/Moscow:20261021T100000",
  "RDATE;TZID=Europe/Moscow:20261030T100000",
  "SUMMARY;LANGUAGE=ru:Планёрка",
  "DESCRIPTION:Повестка",
  "LOCATION:Переговорная 1",
  "ORGANIZER;CN=Ян Свинцов:mailto:user@yandex.ru",
  "ATTENDEE;CN=Пётр Петров;PARTSTAT=ACCEPTED;ROLE=REQ-PARTICIPANT:mailto:petrov@example.com",
  "ATTENDEE;CN=Мария Иванова;PARTSTAT=DECLINED;ROLE=OPT-PARTICIPANT:mailto:ivanova@example.com",
  "CATEGORIES:Работа",
  "X-MINE:1",
  "TRANSP:OPAQUE",
  ...alarm("ACTION:AUDIO", "TRIGGER:-PT10M"),
  ...alarm("ACTION:DISPLAY", "DESCRIPTION:Напоминание", "TRIGGER:-PT15M"),
  ...alarm("ACTION:DISPLAY", "DESCRIPTION:После", "TRIGGER;RELATED=END:-PT5M"),
  ...alarm("ACTION:EMAIL", "DESCRIPTION:Письмо", "SUMMARY:Письмо", "TRIGGER;VALUE=DATE-TIME:20261019T063000Z"),
];
const RICH_OVERRIDE = [
  "RECURRENCE-ID;TZID=Europe/Moscow:20261026T100000",
  "DTSTART;TZID=Europe/Moscow:20261026T120000",
  "DTEND;TZID=Europe/Moscow:20261026T130000",
  "SUMMARY:Планёрка (перенос)",
  "SEQUENCE:3",
];
const RICH = calendar(MOSCOW, vevent(RICH_MASTER), vevent(RICH_OVERRIDE));

type Jcal = [string, unknown[][], Jcal[]];

function jcalOf(o: CalendarObject): Jcal {
  return JSON.parse(JSON.stringify(o.root.jCal)) as Jcal;
}

/**
 * Копия jCal объекта, где у компонента `target` (номер среди подкомпонентов
 * VCALENDAR) выброшены свойства и подкомпоненты с именами из `allowed`, а у
 * VCALENDAR — подкомпоненты с именами из `rootAllowed`, добавленные после
 * `rootLength` прежних. Равенство таких копий до и после правки значит: всё,
 * кроме названного, осталось как было, до параметра и значения.
 */
function strip(jcal: Jcal, target: number, allowed: readonly string[], rootLength: number, rootAllowed: readonly string[] = []): Jcal {
  const copy = JSON.parse(JSON.stringify(jcal)) as Jcal;
  const component = copy[2][target];
  component[1] = component[1].filter((property) => !allowed.includes(String(property[0])));
  component[2] = component[2].filter((sub) => !allowed.includes(sub[0]));
  copy[2] = copy[2].filter((sub, index) => index < rootLength || !rootAllowed.includes(sub[0]));
  return copy;
}

function masterIndex(o: CalendarObject): number {
  return o.root.getAllSubcomponents().indexOf(o.master!);
}

function lines(c: ICAL.Component, name: string): string[] {
  return c.getAllProperties(name).map((property) => property.toICALString());
}

function namesOf(touched: Touched, c: ICAL.Component): string[] {
  return [...(touched.names.get(c) ?? [])].sort();
}

function refusal(action: () => unknown): EditRefusal {
  try {
    action();
  } catch (error) {
    if (error instanceof EditRefusal) return error;
    throw error;
  }
  throw new Error("ожидался отказ EditRefusal, а правка прошла");
}

function patchMaster(ics: string, patch: Parameters<typeof applyFieldPatch>[1], extra: { defaultTimeZone?: string } = {}) {
  const o = load(ics);
  const touched = newTouched();
  const before = jcalOf(o);
  const result = applyFieldPatch(o.master!, patch, { env: ENV, touched, ...extra });
  return { o, touched, before, result, master: o.master! };
}

// ─────────────────────────── каждое поле — только своё ───────────────────────────

describe("applyFieldPatch: каждое поле трогает только свои свойства (О5)", () => {
  const cases: Array<{ name: string; patch: Parameters<typeof applyFieldPatch>[1]; allowed: string[]; rootAllowed?: string[] }> = [
    { name: "summary", patch: { summary: "Ретроспектива" }, allowed: ["summary"] },
    { name: "description", patch: { description: "Новая повестка" }, allowed: ["description"] },
    { name: "description пустой строкой", patch: { description: "" }, allowed: ["description"] },
    { name: "location", patch: { location: "Зал 2" }, allowed: ["location"] },
    { name: "location пустой строкой", patch: { location: "" }, allowed: ["location"] },
    {
      name: "attendees",
      patch: { attendees: [{ email: "petrov@example.com" }, { email: "sidorov@example.com" }] },
      allowed: ["attendee"],
    },
    { name: "reminders", patch: { reminders: [{ minutesBefore: 30, method: "display" }] }, allowed: ["valarm"] },
    {
      name: "start и end",
      patch: { start: "2026-10-19T12:00:00+03:00", end: "2026-10-19T13:30:00+03:00" },
      allowed: ["dtstart", "dtend"],
    },
    { name: "start без end", patch: { start: "2026-10-19T12:00:00" }, allowed: ["dtstart", "dtend"] },
    { name: "timeZone", patch: { timeZone: "Europe/Berlin" }, allowed: ["dtstart", "dtend"], rootAllowed: ["vtimezone"] },
  ];

  it.each(cases)("$name", ({ patch, allowed, rootAllowed }) => {
    const { o, touched, before, result } = patchMaster(RICH, patch);
    const index = masterIndex(o);
    const rootLength = before[2].length;

    expect(strip(jcalOf(o), index, allowed, rootLength, rootAllowed)).toEqual(strip(before, index, allowed, rootLength));
    expect(result.changed.length, "поле действительно изменилось").toBeGreaterThan(0);
    expect(namesOf(touched, o.master!)).toEqual([...allowed].sort());
    // RRULE с WKST, EXDATE, RDATE, ORGANIZER, X-, CATEGORIES — побайтово.
    for (const name of ["rrule", "exdate", "rdate", "organizer", "x-mine", "categories", "sequence", "dtstamp"]) {
      expect(lines(o.master!, name), name).toEqual(lines(new ICAL.Component(before[2][index] as unknown[]), name));
    }
  });

  it("summary меняется на месте: параметр LANGUAGE цел", () => {
    const { master } = patchMaster(RICH, { summary: "Ретроспектива" });
    expect(lines(master, "summary")).toEqual(["SUMMARY;LANGUAGE=ru:Ретроспектива"]);
  });

  it("description и location: пустая строка снимает свойство, новое значение добавляется, если свойства не было", () => {
    const bare = calendar(MOSCOW, vevent(["DTSTART;TZID=Europe/Moscow:20261021T100000", "DTEND;TZID=Europe/Moscow:20261021T110000", "SUMMARY:Встреча"]));
    const { master, result } = patchMaster(bare, { location: "Зал 2", description: "" });
    expect(lines(master, "location")).toEqual(["LOCATION:Зал 2"]);
    expect(lines(master, "description")).toEqual([]);
    expect(result.changed).toEqual(["location"]);
  });

  it("новый текст снимает ALTREP прежнего текста, прочие параметры целы", () => {
    const withAltrep = calendar(MOSCOW, vevent([
      "DTSTART;TZID=Europe/Moscow:20261021T100000", "SUMMARY:Встреча",
      'DESCRIPTION;ALTREP="cid:old@example.com";LANGUAGE=ru:Старая повестка',
    ]));
    const { master } = patchMaster(withAltrep, { description: "Новая повестка" });
    expect(lines(master, "description")).toEqual(["DESCRIPTION;LANGUAGE=ru:Новая повестка"]);
  });

  it("значения те же — правки нет: changed пуст, touched пуст", () => {
    const { o, touched, before, result } = patchMaster(RICH, {
      summary: "Планёрка",
      description: "Повестка",
      location: "Переговорная 1",
      attendees: [
        { email: "petrov@example.com", status: "accepted" },
        { email: "ivanova@example.com" },
      ],
      reminders: [{ minutesBefore: 15, method: "display" }],
      start: "2026-10-19T10:00:00+03:00",
      end: "2026-10-19T11:00:00+03:00",
      timeZone: "Europe/Moscow",
      allDay: false,
    });
    expect(result).toEqual({ changed: [], significant: false });
    expect(jcalOf(o)).toEqual(before);
    expect(touched.properties.size + touched.components.size + touched.names.size).toBe(0);
  });

  it("пустой или пробельный summary — отказ invalid-field, объект не тронут", () => {
    for (const summary of ["", "   "]) {
      const o = load(RICH);
      const before = jcalOf(o);
      expect(refusal(() => applyFieldPatch(o.master!, { summary }, { env: ENV, touched: newTouched() })).code).toBe("invalid-field");
      expect(jcalOf(o)).toEqual(before);
    }
  });

  it("патч проверяется целиком до первой правки: отказ в одном поле не оставляет половины правки", () => {
    const o = load(RICH);
    const before = jcalOf(o);
    const error = refusal(() =>
      applyFieldPatch(o.master!, { summary: "Ретро", end: "2026-10-19T09:00:00+03:00" }, { env: ENV, touched: newTouched() }),
    );
    expect(error.code).toBe("invalid-time");
    expect(jcalOf(o)).toEqual(before);
  });

  it("recurrence applyFieldPatch не правит: это ошибка вызывающего кода, правило правит patchRule", () => {
    const o = load(RICH);
    const patch = { recurrence: { count: 3 } } as unknown as Parameters<typeof applyFieldPatch>[1];
    expect(() => applyFieldPatch(o.master!, patch, { env: ENV, touched: newTouched() })).toThrow(/patchRule/);
  });

  it("неизвестное поле патча — отказ invalid-field", () => {
    const o = load(RICH);
    const patch = { colour: "red" } as unknown as Parameters<typeof applyFieldPatch>[1];
    expect(refusal(() => applyFieldPatch(o.master!, patch, { env: ENV, touched: newTouched() })).code).toBe("invalid-field");
  });
});

// ─────────────────────────────── участники ───────────────────────────────

describe("участники (О9)", () => {
  it("status меняет PARTSTAT на месте; без status — прежний; новые — NEEDS-ACTION; не названные сняты; CN и ROLE целы", () => {
    const { master, result } = patchMaster(RICH, {
      attendees: [
        { email: "ivanova@example.com", status: "accepted" },
        { email: "petrov@example.com" },
        { email: "sidorov@example.com" },
        { email: "orlova@example.com", status: "tentative" },
      ],
    });
    expect(lines(master, "attendee")).toEqual([
      "ATTENDEE;CN=Пётр Петров;PARTSTAT=ACCEPTED;ROLE=REQ-PARTICIPANT:mailto:petrov@example.com",
      "ATTENDEE;CN=Мария Иванова;PARTSTAT=ACCEPTED;ROLE=OPT-PARTICIPANT:mailto:ivanova@example.com",
      "ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:sidorov@example.com",
      "ATTENDEE;PARTSTAT=TENTATIVE:mailto:orlova@example.com",
    ]);
    expect(result.changed).toEqual(["attendees"]);
    expect(result.significant).toBe(false);

    const { master: shrunk } = patchMaster(RICH, { attendees: [{ email: "ivanova@example.com" }] });
    expect(lines(shrunk, "attendee")).toEqual([
      "ATTENDEE;CN=Мария Иванова;PARTSTAT=DECLINED;ROLE=OPT-PARTICIPANT:mailto:ivanova@example.com",
    ]);
    expect(lines(shrunk, "organizer")).toEqual(["ORGANIZER;CN=Ян Свинцов:mailto:user@yandex.ru"]);
  });

  it("адрес сравнивается без регистра и без mailto:", () => {
    const { master, result } = patchMaster(RICH, {
      attendees: [{ email: "Petrov@Example.com" }, { email: "mailto:IVANOVA@example.com", status: "declined" }],
    });
    expect(result.changed).toEqual([]);
    expect(lines(master, "attendee")).toHaveLength(2);
  });

  it("пустой список снимает всех участников, ORGANIZER цел", () => {
    const { master } = patchMaster(RICH, { attendees: [] });
    expect(lines(master, "attendee")).toEqual([]);
    expect(lines(master, "organizer")).toHaveLength(1);
  });

  it("адрес дважды, пустой адрес или неизвестный status — отказ invalid-field", () => {
    const cases = [
      [{ email: "a@example.com" }, { email: "A@example.com" }],
      [{ email: "  " }],
      [{ email: "a@example.com", status: "maybe" }],
    ];
    for (const attendees of cases) {
      const o = load(RICH);
      const patch = { attendees } as unknown as Parameters<typeof applyFieldPatch>[1];
      expect(refusal(() => applyFieldPatch(o.master!, patch, { env: ENV, touched: newTouched() })).code).toBe("invalid-field");
    }
  });
});

// ─────────────────────────────── напоминания ───────────────────────────────

describe("напоминания (О9): трогаются только DISPLAY и EMAIL с относительным TRIGGER от начала", () => {
  const alarmsOf = (c: ICAL.Component) =>
    c.getAllSubcomponents("valarm").map((a) => a.getAllProperties().map((p) => p.toICALString()).join(" | "));
  const AUDIO = "ACTION:AUDIO | TRIGGER:-PT10M";
  const DISPLAY_15 = "ACTION:DISPLAY | DESCRIPTION:Напоминание | TRIGGER:-PT15M";
  const AFTER_END = "ACTION:DISPLAY | DESCRIPTION:После | TRIGGER;RELATED=END:-PT5M";
  const ABSOLUTE = "ACTION:EMAIL | DESCRIPTION:Письмо | SUMMARY:Письмо | TRIGGER;VALUE=DATE-TIME:20261019T063000Z";

  it("совпавшее напоминание цело дословно, лишнее снято, новое добавлено; AUDIO, RELATED=END и абсолютный TRIGGER не тронуты", () => {
    const { master, result, touched } = patchMaster(RICH, {
      reminders: [
        { minutesBefore: 15, method: "display" },
        { minutesBefore: 60, method: "email" },
      ],
    });
    // Письмо собирается заново по RFC 5545 §3.6.6: с темой и получателем. У
    // события писем с адресатом нет (абсолютное — без ATTENDEE), получателем
    // становится владелец календаря.
    expect(alarmsOf(master)).toEqual([
      AUDIO,
      DISPLAY_15,
      AFTER_END,
      ABSOLUTE,
      "ACTION:EMAIL | TRIGGER:-PT1H | DESCRIPTION:Планёрка | SUMMARY:Планёрка | ATTENDEE:mailto:user@yandex.ru",
    ]);
    expect(result.changed).toEqual(["reminders"]);
    expect(touched.components.size).toBe(1);
  });

  it("новое письмо берёт получателя у прежнего письма события — вместе с CN, даже если то снимается", () => {
    // Просят два письма, у события одно: одному правится сдвиг на месте (свой
    // ATTENDEE цел), второе собирается заново — и адресат у него тот же.
    const ics = calendar(MOSCOW, vevent([
      "DTSTART;TZID=Europe/Moscow:20261019T100000", "DTEND;TZID=Europe/Moscow:20261019T110000", "SUMMARY:Планёрка",
      ...alarm("ACTION:EMAIL", "TRIGGER:-PT1H", "ATTENDEE;CN=Пётр:mailto:petrov@example.com", "SUMMARY:Письмо"),
    ]));
    const { master } = patchMaster(ics, {
      reminders: [{ minutesBefore: 30, method: "email" }, { minutesBefore: 5, method: "email" }],
    });
    expect(alarmsOf(master)).toEqual([
      "ACTION:EMAIL | TRIGGER:-PT30M | ATTENDEE;CN=Пётр:mailto:petrov@example.com | SUMMARY:Письмо",
      "ACTION:EMAIL | TRIGGER:-PT5M | DESCRIPTION:Планёрка | SUMMARY:Планёрка | ATTENDEE;CN=Пётр:mailto:petrov@example.com",
    ]);
  });

  it("получателем не становится посторонний ORGANIZER: берётся владелец календаря", () => {
    const ics = calendar(MOSCOW, vevent([
      "DTSTART;TZID=Europe/Moscow:20261019T100000", "DTEND;TZID=Europe/Moscow:20261019T110000", "SUMMARY:Планёрка",
      'ORGANIZER;CN="Анна Смирнова":mailto:anna@example.com',
    ]));
    const { master } = patchMaster(ics, { reminders: [{ minutesBefore: 30, method: "email" }] });
    expect(alarmsOf(master)).toEqual([
      "ACTION:EMAIL | TRIGGER:-PT30M | DESCRIPTION:Планёрка | SUMMARY:Планёрка | ATTENDEE:mailto:user@yandex.ru",
    ]);
  });

  it("адресата взять неоткуда — отказ invalid-field, и дерево не тронуто", () => {
    const ics = calendar(MOSCOW, vevent([
      "DTSTART;TZID=Europe/Moscow:20261019T100000", "DTEND;TZID=Europe/Moscow:20261019T110000", "SUMMARY:Планёрка",
      ...alarm("ACTION:DISPLAY", "DESCRIPTION:Напоминание", "TRIGGER:-PT15M"),
    ]));
    const o = load(ics);
    const before = JSON.stringify(o.root.jCal);
    const patch = { summary: "Другое название", reminders: [{ minutesBefore: 30, method: "email" as const }] };
    const refused = refusal(() =>
      applyFieldPatch(o.master!, patch, { env: { floatingZone: "Europe/Moscow" }, touched: newTouched() }),
    );
    expect(refused.code).toBe("invalid-field");
    expect(refused.message).toContain("отправить некому");
    expect(JSON.stringify(o.root.jCal)).toBe(before);
  });

  it("без владельца календаря правка сдвига у имеющегося письма проходит: заново ничего не собирается", () => {
    const ics = calendar(MOSCOW, vevent([
      "DTSTART;TZID=Europe/Moscow:20261019T100000", "DTEND;TZID=Europe/Moscow:20261019T110000", "SUMMARY:Планёрка",
      ...alarm("ACTION:EMAIL", "TRIGGER:-PT1H", "DESCRIPTION:Письмо"),
    ]));
    const o = load(ics);
    applyFieldPatch(o.master!, { reminders: [{ minutesBefore: 30, method: "email" }] }, {
      env: { floatingZone: "Europe/Moscow" },
      touched: newTouched(),
    });
    expect(alarmsOf(o.master!)).toEqual(["ACTION:EMAIL | TRIGGER:-PT30M | DESCRIPTION:Письмо"]);
  });

  it("C45: DISPLAY за 30 минут вместо 15 — правится TRIGGER на месте; затем пустой список — чужие VALARM целы", () => {
    const o = load(RICH);
    const touched = newTouched();
    applyFieldPatch(o.master!, { reminders: [{ minutesBefore: 30, method: "display" }] }, { env: ENV, touched });
    // Напоминание то же самое: меняется только сдвиг, своё DESCRIPTION цело.
    expect(alarmsOf(o.master!)).toEqual([AUDIO, "ACTION:DISPLAY | DESCRIPTION:Напоминание | TRIGGER:-PT30M", AFTER_END, ABSOLUTE]);
    applyFieldPatch(o.master!, { reminders: [] }, { env: ENV, touched });
    expect(alarmsOf(o.master!)).toEqual([AUDIO, AFTER_END, ABSOLUTE]);
  });

  it("смена одного сдвига у ACTION:EMAIL не теряет ATTENDEE, ATTACH и свои тексты (RFC 5545 §3.6.6)", () => {
    const ics = calendar(MOSCOW, vevent([
      "DTSTART;TZID=Europe/Moscow:20261019T100000", "DTEND;TZID=Europe/Moscow:20261019T110000", "SUMMARY:Планёрка",
      ...alarm("ACTION:EMAIL", "TRIGGER:-PT1H", "ATTENDEE;CN=Пётр:mailto:petrov@example.com", "SUMMARY:Письмо",
        "DESCRIPTION:Текст письма", "ATTACH;FMTTYPE=text/plain:https://example.com/a.txt", "X-MINE:1"),
    ]));
    const { master, result } = patchMaster(ics, { reminders: [{ minutesBefore: 30, method: "email" }] });
    expect(alarmsOf(master)).toEqual([
      "ACTION:EMAIL | TRIGGER:-PT30M | ATTENDEE;CN=Пётр:mailto:petrov@example.com | SUMMARY:Письмо | " +
        "DESCRIPTION:Текст письма | ATTACH;FMTTYPE=text/plain:https://example.com/a.txt | X-MINE:1",
    ]);
    expect(result.changed).toEqual(["reminders"]);
  });

  it("подходящего напоминания нет: ACTION другой — собирается новое, чужое снимается", () => {
    const ics = calendar(MOSCOW, vevent([
      "DTSTART;TZID=Europe/Moscow:20261019T100000", "DTEND;TZID=Europe/Moscow:20261019T110000", "SUMMARY:Планёрка",
      ...alarm("ACTION:EMAIL", "TRIGGER:-PT1H", "ATTENDEE:mailto:petrov@example.com", "DESCRIPTION:Письмо"),
    ]));
    const { master } = patchMaster(ics, { reminders: [{ minutesBefore: 30, method: "display" }] });
    expect(alarmsOf(master)).toEqual(["ACTION:DISPLAY | TRIGGER:-PT30M | DESCRIPTION:Планёрка"]);
  });

  it("отрицательное minutesBefore — напоминание после начала (TRIGGER без минуса)", () => {
    const { master } = patchMaster(RICH, { reminders: [{ minutesBefore: 15, method: "display" }, { minutesBefore: -5, method: "display" }] });
    expect(alarmsOf(master)).toContain("ACTION:DISPLAY | TRIGGER:PT5M | DESCRIPTION:Планёрка");
  });

  it("minutesBefore не целое или неизвестный method — отказ invalid-field", () => {
    for (const reminders of [[{ minutesBefore: 1.5, method: "display" }], [{ minutesBefore: 5, method: "sms" }]]) {
      const o = load(RICH);
      const patch = { reminders } as unknown as Parameters<typeof applyFieldPatch>[1];
      expect(refusal(() => applyFieldPatch(o.master!, patch, { env: ENV, touched: newTouched() })).code).toBe("invalid-field");
    }
  });
});

// ─────────────────────────────── время (О8) ───────────────────────────────

describe("время (О8)", () => {
  const single = (...extra: string[]) =>
    calendar(MOSCOW, vevent(["DTSTART;TZID=Europe/Moscow:20261021T100000", ...extra, "SUMMARY:Встреча"]));
  const withEnd = single("DTEND;TZID=Europe/Moscow:20261021T110000");
  const withDuration = single("DURATION:PT1H30M");

  it("start без смещения — стенное время пояса события, не процесса; end сдвигается с сохранением длительности", () => {
    const { master, result } = patchMaster(withEnd, { start: "2026-10-21T15:00:00" });
    expect(lines(master, "dtstart")).toEqual(["DTSTART;TZID=Europe/Moscow:20261021T150000"]);
    expect(lines(master, "dtend")).toEqual(["DTEND;TZID=Europe/Moscow:20261021T160000"]);
    expect(result).toEqual({ changed: ["start", "end"], significant: true });
  });

  it("start со смещением другого пояса — тот же момент стенным временем пояса события", () => {
    const { master } = patchMaster(withEnd, { start: "2026-10-21T12:00:00+05:00" });
    expect(lines(master, "dtstart")).toEqual(["DTSTART;TZID=Europe/Moscow:20261021T100000"]);
    expect(lines(master, "dtend")).toEqual(["DTEND;TZID=Europe/Moscow:20261021T110000"]);
  });

  it("при DURATION: start не трогает DURATION и не добавляет DTEND", () => {
    const { master, result, touched } = patchMaster(withDuration, { start: "2026-10-21T15:00:00+03:00" });
    expect(lines(master, "dtstart")).toEqual(["DTSTART;TZID=Europe/Moscow:20261021T150000"]);
    expect(lines(master, "duration")).toEqual(["DURATION:PT1H30M"]);
    expect(lines(master, "dtend")).toEqual([]);
    expect(result.changed).toEqual(["start"]);
    expect(namesOf(touched, master)).toEqual(["dtstart"]);
  });

  it("при DURATION: end пересчитывает DURATION, DTEND не появляется", () => {
    const { master } = patchMaster(withDuration, { end: "2026-10-21T13:00:00+03:00" });
    expect(lines(master, "duration")).toEqual(["DURATION:PT3H"]);
    expect(lines(master, "dtend")).toEqual([]);
  });

  it("без DTEND и DURATION: end добавляет DTEND в форме начала", () => {
    const { master } = patchMaster(single(), { end: "2026-10-21T12:00:00" });
    expect(lines(master, "dtend")).toEqual(["DTEND;TZID=Europe/Moscow:20261021T120000"]);
  });

  it("конец не позже начала — отказ invalid-time", () => {
    const cases: Array<Parameters<typeof applyFieldPatch>[1]> = [
      { end: "2026-10-21T09:00:00+03:00" },
      { end: "2026-10-21T10:00:00+03:00" },
      { start: "2026-10-21T12:00:00", end: "2026-10-21T12:00:00" },
    ];
    for (const patch of cases) {
      for (const ics of [withEnd, withDuration]) {
        const o = load(ics);
        const before = jcalOf(o);
        expect(refusal(() => applyFieldPatch(o.master!, patch, { env: ENV, touched: newTouched() })).code).toBe("invalid-time");
        expect(jcalOf(o)).toEqual(before);
      }
    }
  });

  it("timeZone без start сохраняет моменты: DTSTART и DTEND в новом поясе, VTIMEZONE добавлен", () => {
    const { o, master, result, touched } = patchMaster(withEnd, { timeZone: "Europe/Berlin" });
    expect(lines(master, "dtstart")).toEqual(["DTSTART;TZID=Europe/Berlin:20261021T090000"]);
    expect(lines(master, "dtend")).toEqual(["DTEND;TZID=Europe/Berlin:20261021T100000"]);
    expect(o.root.getAllSubcomponents("vtimezone").map((zone) => zone.getFirstPropertyValue("tzid"))).toEqual([
      "Europe/Moscow",
      "Europe/Berlin",
    ]);
    expect(result).toEqual({ changed: ["start", "end", "timeZone"], significant: true });
    expect(namesOf(touched, o.root)).toEqual(["vtimezone"]);
  });

  it("timeZone UTC — форма UTC: значения с Z и без TZID", () => {
    const { master } = patchMaster(withEnd, { timeZone: "UTC" });
    expect(lines(master, "dtstart")).toEqual(["DTSTART:20261021T070000Z"]);
    expect(lines(master, "dtend")).toEqual(["DTEND:20261021T080000Z"]);
  });

  it("неизвестный timeZone — отказ unknown-timezone", () => {
    const o = load(withEnd);
    expect(refusal(() => applyFieldPatch(o.master!, { timeZone: "Nowhere/Land" }, { env: ENV, touched: newTouched() })).code).toBe(
      "unknown-timezone",
    );
  });

  it("неизвестный TZID события: новое время в нём не записать и момент не сохранить — отказ; start и end с timeZone — запись", () => {
    const unknown = calendar([], vevent(["DTSTART;TZID=Foo/Bar:20261021T100000", "DTEND;TZID=Foo/Bar:20261021T110000", "SUMMARY:Встреча"]));
    for (const patch of [{ start: "2026-10-21T12:00:00" }, { timeZone: "Europe/Berlin" }, { timeZone: "UTC" }] as const) {
      const o = load(unknown);
      const before = jcalOf(o);
      const error = refusal(() => applyFieldPatch(o.master!, patch, { env: ENV, touched: newTouched() }));
      expect(error.code, JSON.stringify(patch)).toBe("unknown-timezone");
      expect(error.hint, JSON.stringify(patch)).toMatch(/timeZone/);
      expect(jcalOf(o)).toEqual(before);
    }
    // Момент в неизвестном поясе никто не знает: смена пояса без start его
    // угадывала бы стенным временем календаря. С start и end — новое время целиком.
    const { master } = patchMaster(unknown, { timeZone: "Europe/Berlin", start: "2026-10-21T09:00:00", end: "2026-10-21T10:00:00" });
    expect(lines(master, "dtstart")).toEqual(["DTSTART;TZID=Europe/Berlin:20261021T090000"]);
    expect(lines(master, "dtend")).toEqual(["DTEND;TZID=Europe/Berlin:20261021T100000"]);
  });

  it("правка времени в поясе без VTIMEZONE в объекте добавляет VTIMEZONE этого пояса (О12а)", () => {
    const berlin = calendar([], vevent(["DTSTART;TZID=Europe/Berlin:20261021T100000", "DTEND;TZID=Europe/Berlin:20261021T110000", "SUMMARY:Встреча"]));
    const { o, master, touched } = patchMaster(berlin, { start: "2026-10-21T12:00:00" });
    expect(lines(master, "dtstart")).toEqual(["DTSTART;TZID=Europe/Berlin:20261021T120000"]);
    expect(o.root.getAllSubcomponents("vtimezone").map((zone) => zone.getFirstPropertyValue("tzid"))).toEqual(["Europe/Berlin"]);
    expect(namesOf(touched, o.root)).toEqual(["vtimezone"]);

    // Только summary — время не записывается, VTIMEZONE не добавляется.
    const { o: untouched } = patchMaster(berlin, { summary: "Другая" });
    expect(untouched.root.getAllSubcomponents("vtimezone")).toEqual([]);
  });

  it("у события с DTEND и DURATION сразу end оставляет только DURATION (RFC 5545 §3.6.1)", () => {
    const both = single("DTEND;TZID=Europe/Moscow:20261021T110000", "DURATION:PT1H");
    const { master, touched } = patchMaster(both, { end: "2026-10-21T12:30:00+03:00" });
    expect(lines(master, "duration")).toEqual(["DURATION:PT2H30M"]);
    expect(lines(master, "dtend")).toEqual([]);
    expect(namesOf(touched, master)).toEqual(["dtend", "duration"]);
  });

  it("start у события, где DTEND в своём поясе: конец сдвигается и остаётся в поясе DTEND", () => {
    // 10:00 MSK – 10:00 CEST (11:00 MSK): час.
    const mixed = calendar(MOSCOW, vevent(["DTSTART;TZID=Europe/Moscow:20261021T100000", "DTEND;TZID=Europe/Berlin:20261021T100000", "SUMMARY:Встреча"]));
    const { master } = patchMaster(mixed, { start: "2026-10-21T12:00:00" });
    expect(lines(master, "dtstart")).toEqual(["DTSTART;TZID=Europe/Moscow:20261021T120000"]);
    expect(lines(master, "dtend")).toEqual(["DTEND;TZID=Europe/Berlin:20261021T120000"]);
  });

  it("timeZone на пояс, описанный в дереве объекта иначе, чем в базе IANA, — время по описанию из дерева (Ж10)", () => {
    // В объекте Europe/Berlin описан как постоянные +05:00 (в базе — CEST +02:00 в октябре).
    const ownBerlin = [
      "BEGIN:VTIMEZONE", "TZID:Europe/Berlin", "BEGIN:STANDARD", "TZOFFSETFROM:+0500", "TZOFFSETTO:+0500",
      "DTSTART:19700101T000000", "END:STANDARD", "END:VTIMEZONE",
    ];
    const ics = calendar([...MOSCOW, ...ownBerlin], vevent(["DTSTART;TZID=Europe/Moscow:20261021T100000", "DTEND;TZID=Europe/Moscow:20261021T110000", "SUMMARY:Встреча"]));
    const { o, master } = patchMaster(ics, { timeZone: "Europe/Berlin" });
    expect(lines(master, "dtstart")).toEqual(["DTSTART;TZID=Europe/Berlin:20261021T120000"]);
    expect(lines(master, "dtend")).toEqual(["DTEND;TZID=Europe/Berlin:20261021T130000"]);
    expect(o.root.getAllSubcomponents("vtimezone")).toHaveLength(2);
  });

  it("стенное время из разрыва весеннего перевода — отказ invalid-time", () => {
    const berlin = calendar([], vevent(["DTSTART;TZID=Europe/Berlin:20270327T100000", "DTEND;TZID=Europe/Berlin:20270327T110000", "SUMMARY:Встреча"]));
    const o = load(berlin);
    expect(refusal(() => applyFieldPatch(o.master!, { start: "2027-03-28T02:30:00" }, { env: ENV, touched: newTouched() })).code).toBe(
      "invalid-time",
    );
  });

  it("у события со временем start без времени — отказ invalid-time", () => {
    const o = load(withEnd);
    expect(refusal(() => applyFieldPatch(o.master!, { start: "2026-10-22" }, { env: ENV, touched: newTouched() })).code).toBe("invalid-time");
  });

  it("allDay: true без start — дата начала события, конец — следующий день", () => {
    const { master, result } = patchMaster(withEnd, { allDay: true });
    expect(lines(master, "dtstart")).toEqual(["DTSTART;VALUE=DATE:20261021"]);
    expect(lines(master, "dtend")).toEqual(["DTEND;VALUE=DATE:20261022"]);
    expect(result.changed).toEqual(["start", "end", "allDay"]);
  });

  it("allDay: true и start без end — число затронутых дней сохраняется (О8), как и без start", () => {
    // 21.10 23:00 – 23.10 01:00 затрагивает три дня: 21, 22 и 23 октября.
    const long = single("DTEND;TZID=Europe/Moscow:20261023T010000").replace("20261021T100000", "20261021T230000");
    const { master: same } = patchMaster(long, { allDay: true });
    expect(lines(same, "dtstart")).toEqual(["DTSTART;VALUE=DATE:20261021"]);
    expect(lines(same, "dtend")).toEqual(["DTEND;VALUE=DATE:20261024"]);

    const { master: moved } = patchMaster(long, { allDay: true, start: "2026-10-25" });
    expect(lines(moved, "dtstart")).toEqual(["DTSTART;VALUE=DATE:20261025"]);
    expect(lines(moved, "dtend")).toEqual(["DTEND;VALUE=DATE:20261028"]);

    // Встреча до полуночи — один день и при переносе.
    const { master: short } = patchMaster(withEnd, { allDay: true, start: "2026-10-25" });
    expect(lines(short, "dtend")).toEqual(["DTEND;VALUE=DATE:20261026"]);
  });

  it("allDay: false у события на весь день — нужны start и end; с ними — пояс по умолчанию", () => {
    const allDay = calendar([], vevent(["DTSTART;VALUE=DATE:20261021", "DTEND;VALUE=DATE:20261022", "SUMMARY:Отпуск"]));
    const o = load(allDay);
    expect(refusal(() => applyFieldPatch(o.master!, { allDay: false }, { env: ENV, touched: newTouched() })).code).toBe("invalid-time");

    const { o: timed, master } = patchMaster(
      allDay,
      { allDay: false, start: "2026-10-21T10:00:00", end: "2026-10-21T11:00:00" },
      { defaultTimeZone: "Europe/Moscow" },
    );
    expect(lines(master, "dtstart")).toEqual(["DTSTART;TZID=Europe/Moscow:20261021T100000"]);
    expect(lines(master, "dtend")).toEqual(["DTEND;TZID=Europe/Moscow:20261021T110000"]);
    expect(timed.root.getAllSubcomponents("vtimezone").map((zone) => zone.getFirstPropertyValue("tzid"))).toEqual(["Europe/Moscow"]);
  });

  it("событие на весь день: start — дата буквально, длительность в днях сохраняется; время кроме полуночи — отказ", () => {
    const allDay = calendar([], vevent(["DTSTART;VALUE=DATE:20261021", "DTEND;VALUE=DATE:20261023", "SUMMARY:Выезд"]));
    const { master } = patchMaster(allDay, { start: "2026-10-25" });
    expect(lines(master, "dtstart")).toEqual(["DTSTART;VALUE=DATE:20261025"]);
    expect(lines(master, "dtend")).toEqual(["DTEND;VALUE=DATE:20261027"]);

    const { master: midnight } = patchMaster(allDay, { start: "2026-10-25T00:00:00-05:00" });
    expect(lines(midnight, "dtstart")).toEqual(["DTSTART;VALUE=DATE:20261025"]);

    const o = load(allDay);
    expect(refusal(() => applyFieldPatch(o.master!, { start: "2026-10-25T21:00:00Z" }, { env: ENV, touched: newTouched() })).code).toBe(
      "invalid-time",
    );
  });

  it("плавающее время остаётся плавающим; момент со смещением — стенным временем пояса календаря", () => {
    const floating = calendar([], vevent(["DTSTART:20261021T100000", "DTEND:20261021T110000", "SUMMARY:Встреча"]));
    const { master } = patchMaster(floating, { start: "2026-10-21T12:00:00+05:00" });
    expect(lines(master, "dtstart")).toEqual(["DTSTART:20261021T100000"]);
    const { master: wall } = patchMaster(floating, { start: "2026-10-21T12:00:00" });
    expect(lines(wall, "dtstart")).toEqual(["DTSTART:20261021T120000"]);
    expect(lines(wall, "dtend")).toEqual(["DTEND:20261021T130000"]);
  });
});

// ───────────────────── конец при DURATION — как в выдаче (RFC 5545) ─────────────────────

// Правка и выдача обязаны одинаково понимать конец встречи с DURATION (RFC
// 5545 §3.3.6, §3.8.2.5): дни и недели — номинальные, до того же стенного
// времени; часы, минуты и секунды — точные, реального времени. Прежняя
// правка прибавляла часы к стенному времени: в ночь весеннего перевода конец
// выходил на час раньше, а у часовой встречи совпадал с началом — и
// корректная встреча получала отказ invalid-time.
//
// Берлин, 28.03.2027: в 02:00 CET часы переводятся на 03:00 CEST.
describe("края значений года (RFC 5545 §3.3.4, §3.3.5)", () => {
  const timed = calendar(MOSCOW, vevent(["DTSTART;TZID=Europe/Moscow:20261021T100000",
    "DTEND;TZID=Europe/Moscow:20261021T110000", "SUMMARY:Встреча"]));
  const allDay = calendar([], vevent(["DTSTART;VALUE=DATE:20261021", "DTEND;VALUE=DATE:20261022", "SUMMARY:Дела"]));

  it("год меньше 1000 — отказ invalid-time: ical.js записал бы его без дополнения до четырёх цифр", () => {
    // Без проверки выходило DTSTART;VALUE=DATE:1-01-01 вместо 00010101 — значение,
    // которого не прочтёт ни сервер, ни следующее чтение объекта.
    for (const patch of [{ start: "0001-01-01" }, { start: "0999-12-31" }] as const) {
      const error = refusal(() => patchMaster(allDay, patch));
      expect(error.code).toBe("invalid-time");
      expect(error.message).toContain("вне 1000–9999");
    }
    const timedError = refusal(() => patchMaster(timed, { start: "0001-01-01T10:00:00", end: "0001-01-01T11:00:00" }));
    expect(timedError.code).toBe("invalid-time");
  });

  it("верхний край: перенос длительности за 9999 год — отказ, а не месяц 0 в DTEND", () => {
    // Прежде выходило DTEND;TZID=Europe/Moscow:1000-0-01T0:0:0, и переполнение не ловилось нигде.
    const error = refusal(() => patchMaster(timed, { start: "9999-12-31T23:30:00" }));
    expect(error.code).toBe("invalid-time");
    expect(error.message).toContain("вне 1000–9999");
    // У события на весь день конец — день после последнего затронутого: он тоже переполняется.
    expect(refusal(() => patchMaster(allDay, { start: "9999-12-31" })).code).toBe("invalid-time");
  });

  it("края внутри диапазона правка пишет как есть: год всегда четырьмя цифрами", () => {
    const { master } = patchMaster(timed, { start: "9999-12-31T22:00:00", end: "9999-12-31T23:00:00" });
    expect(lines(master, "dtstart")).toEqual(["DTSTART;TZID=Europe/Moscow:99991231T220000"]);
    expect(lines(master, "dtend")).toEqual(["DTEND;TZID=Europe/Moscow:99991231T230000"]);
    const { master: low } = patchMaster(allDay, { start: "1000-01-01", end: "1000-01-02" });
    expect(lines(low, "dtstart")).toEqual(["DTSTART;VALUE=DATE:10000101"]);
  });

  it("патч, который время не двигает, у объекта с годом за краем не отказывает", () => {
    // Порча чужого клиента — не повод отказывать правке, которая её не читает.
    const ancient = calendar([], vevent(["DTSTART;VALUE=DATE:10000101", "DTEND;VALUE=DATE:10000102", "SUMMARY:Дела"]));
    const { result } = patchMaster(ancient, { summary: "Другое" });
    expect(result.changed).toEqual(["summary"]);
  });
});

describe("конец при DURATION — как в выдаче (RFC 5545 §3.3.6, §3.8.2.5)", () => {
  const berlin = (start: string, duration: string, ...extra: string[]) =>
    calendar([], vevent([`DTSTART;TZID=Europe/Berlin:${start}`, `DURATION:${duration}`, ...extra, "SUMMARY:Встреча"]));
  const iso = (t: ICAL.Time | undefined) => {
    if (!t) throw new Error("правка не назвала конец встречи");
    return formatForModel(t, ENV, "time");
  };

  /** Встречи объекта так, как их показывает выдача (instances.ts). */
  function shownAll(ics: string) {
    return instancesBetween(load(ics), 0, Date.parse("2100-01-01T00:00:00Z")).map((i) => ({
      start: iso(i.start),
      end: iso(i.end),
      hours: (i.endMs - i.startMs) / 3_600_000,
    }));
  }

  /** Первая встреча объекта так, как её показывает выдача. */
  function shown(ics: string) {
    return shownAll(ics)[0];
  }

  function planOf(ics: string, patch: Parameters<typeof resolveTimes>[1]) {
    const plan = resolveTimes(load(ics).master!, patch, { env: ENV });
    if (!plan) throw new Error("в патче нет времени");
    return plan;
  }

  it("DURATION:PT2H в ночь перевода: конец ровно через два часа реального времени и совпадает с концом из выдачи", () => {
    // 01:00 CET + 2 ч = 04:00 CEST; стенное прибавление давало 03:00 CEST — один час.
    const night = berlin("20270328T010000", "PT2H");
    expect(shown(night)).toEqual({ start: "2027-03-28T01:00:00+01:00", end: "2027-03-28T04:00:00+02:00", hours: 2 });
    expect(iso(planOf(night, { start: "2027-03-28T01:00:00" }).end)).toBe("2027-03-28T04:00:00+02:00");

    // Смена пояса сохраняет оба момента, 00:00Z – 02:00Z: DURATION прежняя.
    // Прежний конец (01:00Z) укоротил бы её до PT1H.
    expect(iso(planOf(night, { timeZone: "Europe/Moscow" }).end)).toBe("2027-03-28T05:00:00+03:00");
    const { o: moscow, master: inMoscow } = patchMaster(night, { timeZone: "Europe/Moscow" });
    expect(lines(inMoscow, "duration")).toEqual(["DURATION:PT2H"]);
    expect(shown(serializeObject(moscow))).toEqual({ start: "2027-03-28T03:00:00+03:00", end: "2027-03-28T05:00:00+03:00", hours: 2 });

    // Перенос с ночи перевода на обычный день: встреча остаётся двухчасовой.
    expect(iso(planOf(night, { start: "2027-03-29T10:00:00" }).end)).toBe("2027-03-29T12:00:00+02:00");
    const { o, master, result } = patchMaster(night, { start: "2027-03-29T10:00:00" });
    expect(lines(master, "duration")).toEqual(["DURATION:PT2H"]);
    expect(result.changed).toEqual(["start"]);
    expect(shown(serializeObject(o))).toEqual({ start: "2027-03-29T10:00:00+02:00", end: "2027-03-29T12:00:00+02:00", hours: 2 });

    // Перенос на ночь перевода — те же два часа по выдаче и по правке.
    const day = berlin("20270321T010000", "PT2H");
    expect(iso(planOf(day, { start: "2027-03-28T01:00:00" }).end)).toBe("2027-03-28T04:00:00+02:00");
    const { o: onNight } = patchMaster(day, { start: "2027-03-28T01:00:00" });
    expect(shown(serializeObject(onNight))).toEqual({ start: "2027-03-28T01:00:00+01:00", end: "2027-03-28T04:00:00+02:00", hours: 2 });
  });

  it("DURATION:P1D — номинальные сутки: до того же стенного времени, в ночь перевода — 23 часа, как в выдаче", () => {
    const week = berlin("20270320T100000", "P1D");
    // Перенос на 27.03: сутки кончаются 28.03 в 10:00 CEST. Прежняя правка
    // переносила точные 24 часа прежней встречи — 11:00.
    expect(iso(planOf(week, { start: "2027-03-27T10:00:00" }).end)).toBe("2027-03-28T10:00:00+02:00");
    const { o, master } = patchMaster(week, { start: "2027-03-27T10:00:00" });
    expect(lines(master, "duration")).toEqual(["DURATION:P1D"]);
    const onNight = serializeObject(o);
    expect(shown(onNight)).toEqual({ start: "2027-03-27T10:00:00+01:00", end: "2027-03-28T10:00:00+02:00", hours: 23 });

    // И обратно, с ночи перевода на обычный день: снова 24 часа, а не 23.
    expect(iso(planOf(onNight, { start: "2027-03-30T10:00:00" }).end)).toBe("2027-03-31T10:00:00+02:00");
    const { o: back } = patchMaster(onNight, { start: "2027-03-30T10:00:00" });
    expect(shown(serializeObject(back))).toEqual({ start: "2027-03-30T10:00:00+02:00", end: "2027-03-31T10:00:00+02:00", hours: 24 });
  });

  it("часовая встреча 01:30 CET в ночь перевода не нулевая: перенос и смена пояса — без отказа invalid-time", () => {
    // 01:30 CET + 1 ч = 03:30 CEST. Стенное прибавление давало 02:30 — время
    // из разрыва, которое ical.js читает как 01:30 CET: конец = начало.
    const night = berlin("20270328T013000", "PT1H");
    expect(shown(night)).toEqual({ start: "2027-03-28T01:30:00+01:00", end: "2027-03-28T03:30:00+02:00", hours: 1 });

    const { o, master, result } = patchMaster(night, { start: "2027-03-29T10:00:00" });
    expect(result.changed).toEqual(["start"]);
    expect(lines(master, "dtstart")).toEqual(["DTSTART;TZID=Europe/Berlin:20270329T100000"]);
    expect(lines(master, "duration")).toEqual(["DURATION:PT1H"]);
    expect(shown(serializeObject(o)).hours).toBe(1);

    // Смена пояса сохраняет моменты: 00:30Z – 01:30Z, DURATION та же.
    const { o: moscow, master: inMoscow } = patchMaster(night, { timeZone: "Europe/Moscow" });
    expect(lines(inMoscow, "dtstart")).toEqual(["DTSTART;TZID=Europe/Moscow:20270328T033000"]);
    expect(lines(inMoscow, "duration")).toEqual(["DURATION:PT1H"]);
    expect(shown(serializeObject(moscow))).toEqual({ start: "2027-03-28T03:30:00+03:00", end: "2027-03-28T04:30:00+03:00", hours: 1 });
  });

  it("timeZone у одиночной встречи с DURATION в сутках через перевод сохраняет и момент конца: DURATION пересчитана", () => {
    // 27.03 10:00 CET – 28.03 10:00 CEST — 23 часа. В Москве сутки — 24 часа:
    // прежняя DURATION:P1D сдвинула бы конец на час.
    const { o, master } = patchMaster(berlin("20270327T100000", "P1D"), { timeZone: "Europe/Moscow" });
    expect(lines(master, "dtstart")).toEqual(["DTSTART;TZID=Europe/Moscow:20270327T120000"]);
    expect(lines(master, "duration")).toEqual(["DURATION:PT23H"]);
    expect(shown(serializeObject(o))).toEqual({ start: "2027-03-27T12:00:00+03:00", end: "2027-03-28T11:00:00+03:00", hours: 23 });
  });

  it("timeZone у серии с DURATION: DURATION действует на все встречи и по первой не пересчитывается (О5)", () => {
    // Серия от 27.03 10:00 CET по P1D: первая встреча — 23 часа (перевод
    // 28.03), остальные — по 24. Пересчёт по первой встрече записал бы
    // PT23H, и в Москве все встречи шли бы по 23 часа.
    const series = berlin("20270327T100000", "P1D", "RRULE:FREQ=WEEKLY;COUNT=4");
    const plan = planOf(series, { timeZone: "Europe/Moscow" });
    expect(plan.duration).toBeUndefined();
    expect(iso(plan.end)).toBe("2027-03-28T12:00:00+03:00");
    const { o, master } = patchMaster(series, { timeZone: "Europe/Moscow" });
    expect(lines(master, "dtstart")).toEqual(["DTSTART;TZID=Europe/Moscow:20270327T120000"]);
    expect(lines(master, "duration")).toEqual(["DURATION:P1D"]);
    const inMoscow = shownAll(serializeObject(o));
    expect(inMoscow.map((i) => i.hours)).toEqual([24, 24, 24, 24]);
    expect(inMoscow[1]).toEqual({ start: "2027-04-03T12:00:00+03:00", end: "2027-04-04T12:00:00+03:00", hours: 24 });

    // Обратно, из Москвы в Берлин: пересчёт по первой встрече дал бы
    // P1DT1H — 25 часов у каждой встречи после перевода.
    const moscow = calendar([], vevent([
      "DTSTART;TZID=Europe/Moscow:20270327T100000", "DURATION:P1D", "RRULE:FREQ=WEEKLY;COUNT=4", "SUMMARY:Встреча",
    ]));
    const { o: toBerlin, master: inBerlin } = patchMaster(moscow, { timeZone: "Europe/Berlin" });
    expect(lines(inBerlin, "dtstart")).toEqual(["DTSTART;TZID=Europe/Berlin:20270327T080000"]);
    expect(lines(inBerlin, "duration")).toEqual(["DURATION:P1D"]);
    const berlinSeries = shownAll(serializeObject(toBerlin));
    expect(berlinSeries.map((i) => i.hours)).toEqual([23, 24, 24, 24]);
    expect(berlinSeries[1]).toEqual({ start: "2027-04-03T08:00:00+02:00", end: "2027-04-04T08:00:00+02:00", hours: 24 });

    // Серия из RDATE — тоже серия.
    const rdates = berlin("20270327T100000", "P1D", "RDATE;TZID=Europe/Berlin:20270403T100000");
    const { o: byDates, master: byDatesMaster } = patchMaster(rdates, { timeZone: "Europe/Moscow" });
    expect(lines(byDatesMaster, "duration")).toEqual(["DURATION:P1D"]);
    expect(shownAll(serializeObject(byDates)).map((i) => i.hours)).toEqual([24, 24]);

    // Переопределение — одна встреча: как у одиночной, момент конца сохраняется.
    const withOverride = calendar([],
      vevent(["DTSTART;TZID=Europe/Berlin:20270320T100000", "DURATION:P1D", "RRULE:FREQ=WEEKLY;COUNT=4", "SUMMARY:Встреча"]),
      vevent(["RECURRENCE-ID;TZID=Europe/Berlin:20270327T100000", "DTSTART;TZID=Europe/Berlin:20270327T100000", "DURATION:P1D",
        "SUMMARY:Встреча"]));
    const override = load(withOverride).root.getAllSubcomponents("vevent").find((c) => c.hasProperty("recurrence-id"))!;
    expect(resolveTimes(override, { timeZone: "Europe/Moscow" }, { env: ENV })?.duration?.toString()).toBe("PT23H");
  });

  it("end у события с DURATION через перевод: записанная DURATION даёт в выдаче ровно этот конец", () => {
    // ical.js сворачивает секунды в сутки (duration.js, fromSeconds): 24 часа
    // — P1D, а P1D через перевод — 23 часа. Сутки берутся по стенному
    // календарю, остаток — точный.
    const cases: Array<[string, string, number]> = [
      ["2027-03-28T13:00:00", "DURATION:P1DT3H", 26],
      ["2027-03-28T11:00:00", "DURATION:P1DT1H", 24],
      ["2027-03-28T10:00:00", "DURATION:P1D", 23],
      ["2027-03-28T09:00:00", "DURATION:PT22H", 22],
    ];
    for (const [end, duration, hours] of cases) {
      const { o, master } = patchMaster(berlin("20270327T100000", "PT1H"), { end });
      expect(lines(master, "duration"), end).toEqual([duration]);
      expect(shown(serializeObject(o)), end).toEqual({ start: "2027-03-27T10:00:00+01:00", end: `${end}+02:00`, hours });
    }

    // Осенний перевод, 25.10.2026 в 03:00 CEST на 02:00 CET: сутки — 25 часов.
    // 24,5 часа не дотягивают до стенных суток — точные часы без суток.
    const autumn: Array<[string, string, number]> = [
      ["2026-10-25T10:00:00", "DURATION:P1D", 25],
      ["2026-10-25T09:30:00", "DURATION:PT24H30M", 24.5],
    ];
    for (const [end, duration, hours] of autumn) {
      const { o, master } = patchMaster(berlin("20261024T100000", "PT1H"), { end });
      expect(lines(master, "duration"), end).toEqual([duration]);
      expect(shown(serializeObject(o)), end).toEqual({ start: "2026-10-24T10:00:00+02:00", end: `${end}+01:00`, hours });
    }
  });

  it("end у события с DURATION: сутки DURATION не кончаются в разрыве весеннего перевода и в повторном часе осеннего", () => {
    // Такое стенное время ical.js и RFC 5545 §3.3.5 читают разными моментами.
    // Разрыв: RFC — со смещением до разрыва (28.03 02:30 — это 03:30 CEST),
    // ical.js — после (01:30 CET). Повторный час: RFC — первое вхождение
    // (25.10 02:30 CEST), ical.js — второе (CET; timezone.js:346-356,
    // want_daylight). Выдача и правка читают как ical.js, а другой клиент
    // показал бы конец на час иначе. Точные часы все читают одинаково.
    const cases: Array<[string, string, string, number]> = [
      // Прежде P1D: сутки от 27.03 02:00 кончаются в 28.03 02:00 — в разрыве;
      // по RFC это 03:00 CEST, на час позже 01:00 CET.
      ["20270327T020000", "2027-03-28T01:00:00+01:00", "DURATION:PT23H", 23],
      // Прежде P1DT1H: сутки кончаются в 28.03 02:30 — в разрыве; по RFC
      // конец — 04:30 CEST, на час позже.
      ["20270327T023000", "2027-03-28T03:30:00+02:00", "DURATION:PT24H", 24],
      // Прежде P1DT30M: сутки кончаются в 25.10.2026 02:30 — в повторном
      // часе; по RFC конец — 02:00 CET, на час раньше.
      ["20261024T023000", "2026-10-25T03:00:00+01:00", "DURATION:PT25H30M", 25.5],
    ];
    for (const [start, end, duration, hours] of cases) {
      const ics = berlin(start, "PT1H");
      expect(iso(planOf(ics, { end }).end), end).toBe(end);
      const { o, master } = patchMaster(ics, { end });
      expect(lines(master, "duration"), end).toEqual([duration]);
      const after = shown(serializeObject(o));
      expect(after.end, end).toBe(end);
      expect(after.hours, end).toBe(hours);
    }

    // Сутки, которые кончаются в обычном времени, остаются сутками.
    const { master: plain } = patchMaster(berlin("20270327T030000", "PT1H"), { end: "2027-03-28T04:00:00+02:00" });
    expect(lines(plain, "duration")).toEqual(["DURATION:P1DT1H"]);
  });

  it("DURATION с той же суммой секунд, но другим концом, переписывается; с тем же концом — нет (О13)", () => {
    // PT24H от 27.03 10:00 CET — 28.03 11:00 CEST; P1D — 10:00 CEST.
    const exact = berlin("20270327T100000", "PT24H");
    const { o, master, result } = patchMaster(exact, { end: "2027-03-28T10:00:00" });
    expect(lines(master, "duration")).toEqual(["DURATION:P1D"]);
    expect(result.changed).toEqual(["end"]);
    expect(shown(serializeObject(o)).end).toBe("2027-03-28T10:00:00+02:00");

    // Без перевода часов PT24H и P1D — один и тот же конец: запись не нужна.
    const plain = berlin("20271020T100000", "PT24H");
    const { master: same, result: nothing, before, o: untouched } = patchMaster(plain, { end: "2027-10-21T10:00:00" });
    expect(lines(same, "duration")).toEqual(["DURATION:PT24H"]);
    expect(nothing).toEqual({ changed: [], significant: false });
    expect(jcalOf(untouched)).toEqual(before);
  });

  it("клон слота RDATE;VALUE=PERIOD через перевод: DURATION клона даёт конец периода, как у слота в выдаче", () => {
    const ics = berlin("20270320T100000", "PT1H", "RRULE:FREQ=WEEKLY;COUNT=1",
      "RDATE;VALUE=PERIOD;TZID=Europe/Berlin:20270327T100000/20270328T130000");
    const slotKey: SlotKey = `T:${Date.parse("2027-03-27T10:00:00+01:00") / 1000}`;
    const before = instancesBetween(load(ics), 0, Date.parse("2100-01-01T00:00:00Z")).find((i) => i.key === slotKey)!;
    expect(iso(before.end)).toBe("2027-03-28T13:00:00+02:00");

    const o = load(ics);
    const clone = overrideFromMaster(o, findSlot(o, slotKey)!);
    expect(lines(clone, "duration")).toEqual(["DURATION:P1DT3H"]);
    const after = instancesBetween(load(serializeObject(o)), 0, Date.parse("2100-01-01T00:00:00Z")).find((i) => i.key === slotKey)!;
    expect(after.kind).toBe("override");
    expect(iso(after.end)).toBe("2027-03-28T13:00:00+02:00");
  });
});

// ─────────────────────────────── метаданные (О10) ───────────────────────────────

describe("touchMetadata (О10)", () => {
  const event = (...extra: string[]) =>
    calendar(MOSCOW, vevent(["DTSTART;TZID=Europe/Moscow:20261021T100000", "DTEND;TZID=Europe/Moscow:20261021T110000", "SUMMARY:Встреча", ...extra]));

  function touch(ics: string, significant: boolean) {
    const o = load(ics);
    const touched = newTouched();
    touchMetadata(o.master!, NOW, significant, ENV, touched);
    return { master: o.master!, touched };
  }

  it("свой ORGANIZER и значимая правка: SEQUENCE +1, DTSTAMP и LAST-MODIFIED — сейчас в UTC", () => {
    const { master, touched } = touch(event("SEQUENCE:3", "LAST-MODIFIED:20261001T090000Z", "ORGANIZER:mailto:User@Yandex.ru"), true);
    expect(lines(master, "sequence")).toEqual(["SEQUENCE:4"]);
    expect(lines(master, "dtstamp")).toEqual(["DTSTAMP:20261005T123456Z"]);
    expect(lines(master, "last-modified")).toEqual(["LAST-MODIFIED:20261005T123456Z"]);
    expect(namesOf(touched, master)).toEqual(["dtstamp", "last-modified", "sequence"]);
  });

  it("ORGANIZER нет — SEQUENCE растёт", () => {
    expect(lines(touch(event("SEQUENCE:0"), true).master, "sequence")).toEqual(["SEQUENCE:1"]);
  });

  it("C54: чужой ORGANIZER — SEQUENCE не трогается, DTSTAMP обновляется", () => {
    const { master } = touch(event("SEQUENCE:2", 'ORGANIZER;CN="Анна Смирнова":mailto:anna@example.com'), true);
    expect(lines(master, "sequence")).toEqual(["SEQUENCE:2"]);
    expect(lines(master, "dtstamp")).toEqual(["DTSTAMP:20261005T123456Z"]);
  });

  it("C54: SEQUENCE нет — не добавляется; LAST-MODIFIED нет — не добавляется", () => {
    const { master } = touch(event(), true);
    expect(lines(master, "sequence")).toEqual([]);
    expect(lines(master, "last-modified")).toEqual([]);
  });

  it("правка не меняла время и правило — SEQUENCE прежний, DTSTAMP и LAST-MODIFIED обновлены", () => {
    const { master, touched } = touch(event("SEQUENCE:3", "LAST-MODIFIED:20261001T090000Z", "ORGANIZER:mailto:user@yandex.ru"), false);
    expect(lines(master, "sequence")).toEqual(["SEQUENCE:3"]);
    expect(lines(master, "dtstamp")).toEqual(["DTSTAMP:20261005T123456Z"]);
    expect(lines(master, "last-modified")).toEqual(["LAST-MODIFIED:20261005T123456Z"]);
    expect(namesOf(touched, master)).toEqual(["dtstamp", "last-modified"]);
  });

  it("без ownerEmail любой ORGANIZER считается чужим", () => {
    const o = load(event("SEQUENCE:3", "ORGANIZER:mailto:user@yandex.ru"));
    touchMetadata(o.master!, NOW, true, { floatingZone: "Europe/Moscow" });
    expect(lines(o.master!, "sequence")).toEqual(["SEQUENCE:3"]);
  });
});

// ─────────────────────────────── правило (Р4) ───────────────────────────────

describe("patchRule (Р4): меняются только переданные части", () => {
  const series = (rule: string, start = "DTSTART;TZID=Europe/Moscow:20261019T100000") =>
    calendar(MOSCOW, vevent([start, "DURATION:PT1H", rule, "SUMMARY:Серия"]));

  function patch(rule: string, rp: Parameters<typeof patchRule>[1], start?: string) {
    const o = load(series(rule, start));
    const property = o.master!.getFirstProperty("rrule")!;
    const touched = newTouched();
    const result = patchRule(property, rp, { env: ENV, touched });
    return { o, rule: property.toICALString(), result, touched, master: o.master! };
  }

  it("C43: INTERVAL=2 → {frequency, interval, count} и затем {count} — INTERVAL и BYDAY целы, порядок частей прежний", () => {
    const first = patch("RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=6", { frequency: "weekly", interval: 2, count: 4 });
    expect(first.rule).toBe("RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=4");
    expect(first.result).toEqual({ changed: true, lostParts: [] });
    expect(namesOf(first.touched, first.master)).toEqual(["rrule"]);
    expect(patch("RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=4", { count: 5 }).rule).toBe("RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=5");
  });

  it("шаг повтора ограничен: INTERVAL=1000000 — отказ invalid-rule, а не разворот за пределы календаря", () => {
    // Без предела план строился, а разворот (и у планировщика, и у
    // предохранителя) уходил в район миллионного года: ical.js разворачивал
    // YEARLY-правила самого VTIMEZONE от 1970-го до него, и процесс кончался
    // нехваткой памяти, не оставив ни отказа, ни сообщения.
    const error = refusal(() => patch("RRULE:FREQ=DAILY", { interval: 1_000_000 }));
    expect(error.code).toBe("invalid-rule");
    expect(error.message).toContain("не больше 1000");
    expect(refusal(() => patch("RRULE:FREQ=WEEKLY;COUNT=4", { interval: 1001 })).code).toBe("invalid-rule");
    // Предел не мешает разумному шагу.
    expect(patch("RRULE:FREQ=DAILY;COUNT=4", { interval: 1000 }).rule).toBe("RRULE:FREQ=DAILY;COUNT=4;INTERVAL=1000");
  });

  it("неизвестные модели части (BYMONTHDAY, BYMONTH, RSCALE, X-) целы", () => {
    const { rule } = patch("RRULE:FREQ=MONTHLY;BYMONTHDAY=1,15;BYMONTH=1,4,7,10;RSCALE=GREGORIAN;X-YCM=keep;COUNT=8", { count: 10 });
    expect(rule).toBe("RRULE:FREQ=MONTHLY;BYMONTHDAY=1,15;BYMONTH=1,4,7,10;RSCALE=GREGORIAN;X-YCM=keep;COUNT=10");
  });

  it("until встаёт на место COUNT; count — на место UNTIL", () => {
    expect(patch("RRULE:FREQ=WEEKLY;COUNT=6;BYDAY=MO", { until: "2026-12-31" }).rule).toBe(
      "RRULE:FREQ=WEEKLY;UNTIL=20261231T205959Z;BYDAY=MO",
    );
    expect(patch("RRULE:FREQ=WEEKLY;UNTIL=20261231T205959Z;BYDAY=MO", { count: 3 }).rule).toBe("RRULE:FREQ=WEEKLY;COUNT=3;BYDAY=MO");
  });

  it("null снимает часть; частота меняется на месте, прочие части целы", () => {
    expect(patch("RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=6", { interval: null, byWeekday: null, count: null }).rule).toBe(
      "RRULE:FREQ=WEEKLY",
    );
    expect(patch("RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO;BYMONTH=1,2", { frequency: "monthly", byWeekday: ["1MO", "-1FR"] }).rule).toBe(
      "RRULE:FREQ=MONTHLY;INTERVAL=2;BYDAY=1MO,-1FR;BYMONTH=1,2",
    );
  });

  it("тот же смысл — правки нет: interval 1 при отсутствующем INTERVAL, те же BYDAY и COUNT", () => {
    const { result, rule, touched } = patch("RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6", {
      frequency: "weekly",
      interval: 1,
      byWeekday: ["MO", "WE"],
      count: 6,
    });
    expect(result).toEqual({ changed: false, lostParts: [] });
    expect(rule).toBe("RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6");
    expect(touched.properties.size).toBe(0);
  });

  it("UNTIL в форме DTSTART (О4): дата у серии на весь день, UTC у серии с поясом, плавающее у плавающей", () => {
    expect(patch("RRULE:FREQ=DAILY", { until: "2026-12-31" }, "DTSTART;VALUE=DATE:20261019").rule).toBe("RRULE:FREQ=DAILY;UNTIL=20261231");
    expect(patch("RRULE:FREQ=DAILY", { until: "2026-12-31T00:00:00+03:00" }, "DTSTART;VALUE=DATE:20261019").rule).toBe(
      "RRULE:FREQ=DAILY;UNTIL=20261231",
    );
    expect(patch("RRULE:FREQ=DAILY", { until: "2026-12-31T10:00:00" }).rule).toBe("RRULE:FREQ=DAILY;UNTIL=20261231T070000Z");
    expect(patch("RRULE:FREQ=DAILY", { until: "2026-12-31T10:00:00+05:00" }).rule).toBe("RRULE:FREQ=DAILY;UNTIL=20261231T050000Z");
    expect(patch("RRULE:FREQ=DAILY", { until: "2026-12-31" }, "DTSTART:20261019T100000").rule).toBe("RRULE:FREQ=DAILY;UNTIL=20261231T235959");
    expect(patch("RRULE:FREQ=DAILY", { until: "2026-12-31T10:00:00+05:00" }, "DTSTART:20261019T100000").rule).toBe(
      "RRULE:FREQ=DAILY;UNTIL=20261231T080000",
    );
    expect(patch("RRULE:FREQ=DAILY", { until: "2026-12-31" }, "DTSTART:20261019T100000Z").rule).toBe(
      "RRULE:FREQ=DAILY;UNTIL=20261231T235959Z",
    );
  });

  it("неверные значения — отказ invalid-rule, правило не тронуто", () => {
    const rule = "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6";
    const cases: unknown[] = [
      { count: 3, until: "2026-12-31" },
      { count: 0 },
      { count: 2.5 },
      { interval: 0 },
      { interval: 1.5 },
      { frequency: "hourly" },
      { byWeekday: ["2MO"] },
      { byWeekday: ["XX"] },
      { frequency: "monthly", byWeekday: ["6MO"] },
      { frequency: "yearly", byWeekday: ["12MO"] },
      { frequency: "monthly", byWeekday: ["05MO"] },
      { until: "2026-10-01" },
    ];
    for (const rp of cases) {
      const o = load(series(rule));
      const property = o.master!.getFirstProperty("rrule")!;
      const error = refusal(() => patchRule(property, rp as Parameters<typeof patchRule>[1], { env: ENV }));
      expect(error.code, JSON.stringify(rp)).toBe("invalid-rule");
      expect(property.toICALString()).toBe(rule);
    }
  });

  it("части правила, несовместимые с новой частотой (RFC 5545 §3.3.10), — отказ invalid-rule, правило не тронуто", () => {
    const cases: Array<[string, Parameters<typeof patchRule>[1], RegExp]> = [
      ["RRULE:FREQ=MONTHLY;BYMONTHDAY=1,15;COUNT=6", { frequency: "weekly" }, /BYMONTHDAY/],
      ["RRULE:FREQ=MONTHLY;BYMONTHDAY=1,15;COUNT=6", { frequency: "weekly", byWeekday: ["MO"] }, /BYMONTHDAY/],
      ["RRULE:FREQ=YEARLY;BYYEARDAY=1,100;COUNT=6", { frequency: "monthly" }, /BYYEARDAY/],
      ["RRULE:FREQ=YEARLY;BYYEARDAY=1,100;COUNT=6", { frequency: "daily" }, /BYYEARDAY/],
      ["RRULE:FREQ=YEARLY;BYWEEKNO=20;BYDAY=MO;COUNT=6", { frequency: "monthly" }, /BYWEEKNO/],
      ["RRULE:FREQ=YEARLY;BYWEEKNO=20;BYDAY=MO;COUNT=6", { byWeekday: ["1MO"] }, /BYWEEKNO/],
    ];
    for (const [rule, rp, part] of cases) {
      const o = load(series(rule));
      const property = o.master!.getFirstProperty("rrule")!;
      const error = refusal(() => patchRule(property, rp, { env: ENV, touched: newTouched() }));
      expect(error.code, `${rule} ${JSON.stringify(rp)}`).toBe("invalid-rule");
      expect(error.message).toMatch(part);
      expect(error.hint).toMatch(/replace/);
      expect(property.toICALString()).toBe(rule);
    }
    // Та же смена частоты с заменой правила целиком — можно.
    const { rule, result } = patch("RRULE:FREQ=MONTHLY;BYMONTHDAY=1,15;COUNT=6", { frequency: "weekly", byWeekday: ["MO"], replace: true });
    expect(rule).toBe("RRULE:FREQ=WEEKLY;BYDAY=MO");
    expect(result.lostParts).toEqual(["BYMONTHDAY=1,15", "COUNT=6"]);
  });

  it("правило, у которого после правки нет ни одной позиции, — отказ invalid-rule", () => {
    // Серия с понедельника 19.10 по вторникам: UNTIL в тот же понедельник не
    // оставляет правилу ни одного вторника, loadObject отметил бы no-positions.
    const rule = "RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=6";
    const o = load(series(rule));
    const property = o.master!.getFirstProperty("rrule")!;
    const error = refusal(() => patchRule(property, { until: "2026-10-19T10:00:00" }, { env: ENV }));
    expect(error.code).toBe("invalid-rule");
    expect(property.toICALString()).toBe(rule);
  });

  it("неразборчивый until — отказ invalid-time, как у сборки нового события", () => {
    const o = load(series("RRULE:FREQ=WEEKLY;COUNT=6"));
    const property = o.master!.getFirstProperty("rrule")!;
    expect(refusal(() => patchRule(property, { until: "вчера" }, { env: ENV })).code).toBe("invalid-time");
  });

  it("ordinal BYDAY у имеющегося правила при смене частоты на weekly — отказ invalid-rule", () => {
    const o = load(series("RRULE:FREQ=MONTHLY;BYDAY=2MO;COUNT=6"));
    const property = o.master!.getFirstProperty("rrule")!;
    expect(refusal(() => patchRule(property, { frequency: "weekly" }, { env: ENV })).code).toBe("invalid-rule");
  });

  it("Ж6: BYSETPOS и WKST в правило при правке не вводятся — отказ unsupported-rule с объяснением", () => {
    for (const unmodeled of ["BYSETPOS=-1", "WKST=SU", "BYMONTHDAY=1"]) {
      const o = load(series("RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;COUNT=3"));
      const property = o.master!.getFirstProperty("rrule")!;
      const rp = { count: 4, unmodeled } as unknown as Parameters<typeof patchRule>[1];
      const error = refusal(() => patchRule(property, rp, { env: ENV }));
      expect(error.code).toBe("unsupported-rule");
      if (unmodeled !== "BYMONTHDAY=1") expect(error.message).toMatch(/Яндекс/);
    }
    const o = load(series("RRULE:FREQ=MONTHLY;COUNT=3"));
    const rp = { bySetPos: [-1] } as unknown as Parameters<typeof patchRule>[1];
    expect(refusal(() => patchRule(o.master!.getFirstProperty("rrule")!, rp, { env: ENV })).code).toBe("unsupported-rule");
  });

  it("Ж6: правка правила, в котором уже есть BYSETPOS или WKST, — отказ с подсказкой про replace; без правки правила — ничего", () => {
    for (const rule of ["RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;COUNT=3", "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,SU;WKST=SU;COUNT=8"]) {
      const o = load(series(rule));
      const property = o.master!.getFirstProperty("rrule")!;
      const error = refusal(() => patchRule(property, { count: 2 }, { env: ENV }));
      expect(error.code).toBe("unsupported-rule");
      expect(error.message).toMatch(/replace/);
      expect(property.toICALString()).toBe(rule);
      const same = rule.match(/COUNT=(\d+)/)![1];
      expect(patchRule(property, { count: Number(same) }, { env: ENV })).toEqual({ changed: false, lostParts: [] });
    }
  });

  it("C38: replace собирает правило только из патча и перечисляет потерянные части", () => {
    const { rule, result } = patch("RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;WKST=SU;COUNT=3", {
      frequency: "monthly",
      byWeekday: ["-1FR"],
      count: 3,
      replace: true,
    });
    expect(rule).toBe("RRULE:FREQ=MONTHLY;BYDAY=-1FR;COUNT=3");
    expect(result).toEqual({ changed: true, lostParts: ["BYSETPOS=-1", "WKST=SU"] });
  });

  it("replace без frequency берёт прежнюю частоту; INTERVAL без патча теряется", () => {
    const { rule, result } = patch("RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO;COUNT=6", { byWeekday: ["TU"], replace: true });
    expect(rule).toBe("RRULE:FREQ=WEEKLY;BYDAY=TU");
    expect(result.lostParts).toEqual(["INTERVAL=2", "COUNT=6"]);
  });

  it("distortedParts называет BYSETPOS и WKST правила", () => {
    const o = load(series("RRULE:FREQ=MONTHLY;BYDAY=MO;BYSETPOS=-1;WKST=SU"));
    expect(distortedParts(o.master!.getFirstProperty("rrule")!)).toEqual(["BYSETPOS", "WKST"]);
    const plain = load(series("RRULE:FREQ=MONTHLY;BYDAY=MO"));
    expect(distortedParts(plain.master!.getFirstProperty("rrule")!)).toEqual([]);
  });

  it("правка summary не трогает RRULE с WKST и неизвестными частями — побайтово", () => {
    const rule = "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,SU;WKST=SU;RSCALE=GREGORIAN;X-YCM=keep;COUNT=8";
    const o = load(series(rule));
    applyFieldPatch(o.master!, { summary: "Новое" }, { env: ENV, touched: newTouched() });
    expect(serializeObject(o).replace(/\r\n[ \t]/g, "")).toContain(`${CRLF}${rule}${CRLF}`);
  });
});

describe("setRuleEnd", () => {
  const master = (rule: string) =>
    load(calendar(MOSCOW, vevent(["DTSTART;TZID=Europe/Moscow:20261019T100000", "DURATION:PT1H", rule, "SUMMARY:Серия"]))).master!;

  it("COUNT и UNTIL заменяют друг друга на том же месте, прочие части целы", () => {
    const a = master("RRULE:FREQ=WEEKLY;COUNT=6;BYDAY=MO;X-YCM=keep").getFirstProperty("rrule")!;
    expect(setRuleEnd(a, { until: "2026-11-02T06:59:59Z" })).toBe(true);
    expect(a.toICALString()).toBe("RRULE:FREQ=WEEKLY;UNTIL=20261102T065959Z;BYDAY=MO;X-YCM=keep");
    expect(setRuleEnd(a, { count: 2 })).toBe(true);
    expect(a.toICALString()).toBe("RRULE:FREQ=WEEKLY;COUNT=2;BYDAY=MO;X-YCM=keep");
    expect(setRuleEnd(a, { count: 2 })).toBe(false);
  });

  it("у бесконечного правила конец добавляется в конец частей; ICAL.Time с поясом — в UTC", () => {
    const m = master("RRULE:FREQ=WEEKLY;BYDAY=MO");
    const rule = m.getFirstProperty("rrule")!;
    const until = (m.getFirstPropertyValue("dtstart") as ICAL.Time).clone();
    const touched = newTouched();
    setRuleEnd(rule, { until }, touched);
    expect(rule.toICALString()).toBe("RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20261019T070000Z");
    expect(namesOf(touched, m)).toEqual(["rrule"]);
  });

  it("COUNT меньше 1 — ошибка", () => {
    expect(() => setRuleEnd(master("RRULE:FREQ=WEEKLY").getFirstProperty("rrule")!, { count: 0 })).toThrow();
  });
});

// ─────────────────────────────── клон основного (О6) ───────────────────────────────

describe("overrideFromMaster (О6)", () => {
  const key = (iso: string): SlotKey => `T:${Date.parse(iso) / 1000}`;

  function cloneAt(ics: string, slotKey: SlotKey) {
    const o = load(ics);
    const slot = findSlot(o, slotKey);
    if (!slot) throw new Error(`нет слота ${slotKey}`);
    const touched = newTouched();
    const clone = overrideFromMaster(o, slot, touched);
    return { o, clone, touched };
  }

  it("всё, кроме RRULE, RDATE, EXDATE, EXRULE; DTSTART = RECURRENCE-ID = слот; DTEND = слот + длительность", () => {
    const { o, clone, touched } = cloneAt(RICH, key("2026-10-28T10:00:00+03:00"));
    expect(lines(clone, "recurrence-id")).toEqual(["RECURRENCE-ID;TZID=Europe/Moscow:20261028T100000"]);
    expect(lines(clone, "dtstart")).toEqual(["DTSTART;TZID=Europe/Moscow:20261028T100000"]);
    expect(lines(clone, "dtend")).toEqual(["DTEND;TZID=Europe/Moscow:20261028T110000"]);
    for (const name of ["rrule", "rdate", "exdate", "exrule", "duration"]) expect(lines(clone, name), name).toEqual([]);
    for (const name of ["uid", "summary", "description", "location", "organizer", "attendee", "categories", "x-mine", "transp", "sequence", "created"]) {
      expect(lines(clone, name), name).toEqual(lines(o.master!, name));
    }
    expect(clone.getAllSubcomponents("valarm").map((a) => a.toString())).toEqual(o.master!.getAllSubcomponents("valarm").map((a) => a.toString()));
    expect(clone.parent).toBe(o.root);
    expect(touched.components.has(clone)).toBe(true);
    expect(namesOf(touched, o.root)).toEqual(["vevent"]);
    // Основной компонент не тронут.
    expect(lines(o.master!, "rrule")).toEqual(["RRULE:FREQ=WEEKLY;BYDAY=MO,WE;WKST=SU;COUNT=6"]);
  });

  it("основной с DURATION — у клона только DURATION, DTEND не появляется", () => {
    const ics = calendar(MOSCOW, vevent(["DTSTART;TZID=Europe/Moscow:20261019T100000", "DURATION:PT1H30M", "RRULE:FREQ=DAILY;COUNT=5", "SUMMARY:Серия"]));
    const { clone } = cloneAt(ics, key("2026-10-21T10:00:00+03:00"));
    expect(lines(clone, "duration")).toEqual(["DURATION:PT1H30M"]);
    expect(lines(clone, "dtend")).toEqual([]);
  });

  it("основной с DTEND и DURATION сразу — у клона только DURATION (RFC 5545 §3.6.1)", () => {
    const ics = calendar(MOSCOW, vevent([
      "DTSTART;TZID=Europe/Moscow:20261019T100000", "DTEND;TZID=Europe/Moscow:20261019T110000", "DURATION:PT1H",
      "RRULE:FREQ=DAILY;COUNT=5", "SUMMARY:Серия",
    ]));
    const { clone } = cloneAt(ics, key("2026-10-21T10:00:00+03:00"));
    expect(lines(clone, "duration")).toEqual(["DURATION:PT1H"]);
    expect(lines(clone, "dtend")).toEqual([]);
  });

  it("слот из RDATE;VALUE=PERIOD: конец — конец периода, в форме конца основного", () => {
    const period = "RDATE;VALUE=PERIOD;TZID=Europe/Moscow:20261030T140000/20261030T163000";
    const withEnd = calendar(MOSCOW, vevent([
      "DTSTART;TZID=Europe/Moscow:20261019T100000", "DTEND;TZID=Europe/Moscow:20261019T110000",
      "RRULE:FREQ=WEEKLY;COUNT=2", period, "SUMMARY:Серия",
    ]));
    const a = cloneAt(withEnd, key("2026-10-30T14:00:00+03:00")).clone;
    expect(lines(a, "recurrence-id")).toEqual(["RECURRENCE-ID;TZID=Europe/Moscow:20261030T140000"]);
    expect(lines(a, "dtend")).toEqual(["DTEND;TZID=Europe/Moscow:20261030T163000"]);

    const withDuration = withEnd.replace("DTEND;TZID=Europe/Moscow:20261019T110000", "DURATION:PT1H");
    const b = cloneAt(withDuration, key("2026-10-30T14:00:00+03:00")).clone;
    expect(lines(b, "duration")).toEqual(["DURATION:PT2H30M"]);
    expect(lines(b, "dtend")).toEqual([]);
  });

  it("серия на весь день: RECURRENCE-ID;VALUE=DATE, DTEND — через столько же дней", () => {
    const ics = calendar([], vevent(["DTSTART;VALUE=DATE:20261019", "DTEND;VALUE=DATE:20261021", "RRULE:FREQ=WEEKLY;COUNT=4", "SUMMARY:Выезд"]));
    const { clone } = cloneAt(ics, "D:2026-10-26");
    expect(lines(clone, "recurrence-id")).toEqual(["RECURRENCE-ID;VALUE=DATE:20261026"]);
    expect(lines(clone, "dtstart")).toEqual(["DTSTART;VALUE=DATE:20261026"]);
    expect(lines(clone, "dtend")).toEqual(["DTEND;VALUE=DATE:20261028"]);
  });

  it("длительность по DTEND — точная (RFC 5545 §3.8.5.3): у встречи через осенний перевод конец по моменту", () => {
    // Берлин, по воскресеньям 01:00–04:00 CEST (3 часа). 25.10.2026 в 03:00
    // CEST часы переводятся на 02:00 CET: три часа от 01:00 CEST — это 03:00 CET.
    const ics = calendar([], vevent(["DTSTART;TZID=Europe/Berlin:20261018T010000", "DTEND;TZID=Europe/Berlin:20261018T040000", "RRULE:FREQ=WEEKLY;COUNT=3", "SUMMARY:Ночная"]));
    const { clone } = cloneAt(ics, key("2026-10-25T01:00:00+02:00"));
    expect(lines(clone, "dtend")).toEqual(["DTEND;TZID=Europe/Berlin:20261025T030000"]);
  });

  it("пояс серии описан только в VTIMEZONE объекта: DTEND клона — в поясе основного, с его длительностью", () => {
    // Клон до вставки в VCALENDAR ищет пояс в ICAL.TimezoneService, а не в
    // дереве (time.js, fromDateTimeString; component.js, getTimeZoneByID):
    // Custom/Plus5 там нет, и DTEND клона читался бы плавающим временем.
    const ics = calendar(PLUS5, vevent([
      "DTSTART;TZID=Custom/Plus5:20261019T100000", "DTEND;TZID=Custom/Plus5:20261019T110000",
      "RRULE:FREQ=WEEKLY;COUNT=3", "SUMMARY:Серия",
    ]));
    const { clone } = cloneAt(ics, key("2026-10-26T10:00:00+05:00"));
    expect(lines(clone, "dtstart")).toEqual(["DTSTART;TZID=Custom/Plus5:20261026T100000"]);
    expect(lines(clone, "recurrence-id")).toEqual(["RECURRENCE-ID;TZID=Custom/Plus5:20261026T100000"]);
    expect(lines(clone, "dtend")).toEqual(["DTEND;TZID=Custom/Plus5:20261026T110000"]);
  });

  it("серия в поясе, отличном от пояса календаря, с VTIMEZONE в объекте: DTEND клона в том же поясе", () => {
    const newYork = vtimezoneFor("America/New_York").toString().split(CRLF);
    const ics = calendar(newYork, vevent([
      "DTSTART;TZID=America/New_York:20261019T100000", "DTEND;TZID=America/New_York:20261019T110000",
      "RRULE:FREQ=WEEKLY;COUNT=3", "SUMMARY:Серия",
    ]));
    const { clone } = cloneAt(ics, key("2026-10-26T10:00:00-04:00"));
    expect(lines(clone, "dtstart")).toEqual(["DTSTART;TZID=America/New_York:20261026T100000"]);
    expect(lines(clone, "dtend")).toEqual(["DTEND;TZID=America/New_York:20261026T110000"]);
  });

  it("клон и затем правка summary: у клона меняется только SUMMARY", () => {
    const { clone, o } = cloneAt(RICH, key("2026-10-28T10:00:00+03:00"));
    const before = JSON.parse(JSON.stringify(clone.jCal)) as Jcal;
    const touched = newTouched();
    applyFieldPatch(clone, { summary: "Разовая" }, { env: ENV, touched });
    const index = o.root.getAllSubcomponents().indexOf(clone);
    const wrap = (c: Jcal): Jcal => ["vcalendar", [], [c]];
    expect(strip(wrap(JSON.parse(JSON.stringify(clone.jCal)) as Jcal), 0, ["summary"], 1)).toEqual(strip(wrap(before), 0, ["summary"], 1));
    expect(index).toBeGreaterThan(0);
  });

  it("у объекта без основного компонента — ошибка", () => {
    const orphan = calendar(MOSCOW, vevent(RICH_OVERRIDE));
    const o = load(orphan);
    const fakeSlot = { key: key("2026-10-26T10:00:00+03:00"), time: ICAL.Time.fromDateTimeString("2026-10-26T10:00:00"), origin: "dtstart", sources: ["dtstart"], excluded: false } as const;
    expect(() => overrideFromMaster(o, fakeSlot)).toThrow();
  });
});

// ─────────────────────────────── наследование (О7) ───────────────────────────────

describe("inheritFields (О7): поле переопределения меняется, только если совпадало со старым основным", () => {
  const team = [
    "ATTENDEE;CN=Пётр Петров;PARTSTAT=ACCEPTED:mailto:petrov@example.com",
    "ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:ivanova@example.com",
  ];
  const ics = calendar(
    MOSCOW,
    vevent([
      "DTSTART;TZID=Europe/Moscow:20261019T100000", "DTEND;TZID=Europe/Moscow:20261019T110000",
      "RRULE:FREQ=WEEKLY;COUNT=6", "SUMMARY:Планёрка", "LOCATION:Зал 1", ...team,
      ...alarm("ACTION:DISPLAY", "DESCRIPTION:Планёрка", "TRIGGER:-PT15M"),
    ]),
    vevent([
      "RECURRENCE-ID;TZID=Europe/Moscow:20261026T100000", "DTSTART;TZID=Europe/Moscow:20261026T120000",
      "DTEND;TZID=Europe/Moscow:20261026T130000", "SUMMARY:Планёрка", "LOCATION:Зал 7", ...team,
      ...alarm("ACTION:DISPLAY", "DESCRIPTION:Планёрка", "TRIGGER:-PT15M"),
      ...alarm("ACTION:AUDIO", "TRIGGER:-PT1M"),
    ]),
    vevent([
      "RECURRENCE-ID;TZID=Europe/Moscow:20261102T100000", "DTSTART;TZID=Europe/Moscow:20261102T100000",
      "DTEND;TZID=Europe/Moscow:20261102T110000", "SUMMARY:Разбор инцидента", "LOCATION:Зал 1",
      "ATTENDEE;CN=Пётр Петров;PARTSTAT=DECLINED:mailto:petrov@example.com",
      "ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:ivanova@example.com",
    ]),
  );

  it("совпавшие поля следуют за основным, свои — остаются; чужие VALARM целы", () => {
    const o = load(ics);
    const [moved, incident] = o.root.getAllSubcomponents("vevent").filter((c) => c.hasProperty("recurrence-id"));
    const oldMaster = cloneComponent(o.master!);
    const patch = {
      summary: "Планёрка команды",
      location: "Зал 2",
      attendees: [{ email: "petrov@example.com" }, { email: "sidorov@example.com" }],
      reminders: [{ minutesBefore: 30, method: "display" as const }],
    };
    applyFieldPatch(o.master!, patch, { env: ENV, touched: newTouched() });
    const fields = ["summary", "location", "attendees", "reminders"] as const;

    const touched = newTouched();
    expect(inheritFields(moved, oldMaster, o.master!, fields, touched)).toEqual(["summary", "attendees", "reminders"]);
    expect(lines(moved, "summary")).toEqual(["SUMMARY:Планёрка команды"]);
    expect(lines(moved, "location")).toEqual(["LOCATION:Зал 7"]);
    expect(lines(moved, "attendee")).toEqual([
      "ATTENDEE;CN=Пётр Петров;PARTSTAT=ACCEPTED:mailto:petrov@example.com",
      "ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:sidorov@example.com",
    ]);
    // Сдвиг правится у имеющегося напоминания на месте: оно остаётся на своём
    // месте в списке со своими свойствами, чужое AUDIO цело.
    expect(moved.getAllSubcomponents("valarm").map((a) => a.getFirstPropertyValue("action") + " " + String(a.getFirstPropertyValue("trigger")))).toEqual([
      "DISPLAY -PT30M",
      "AUDIO -PT1M",
    ]);
    // Время переопределения inheritFields не трогает.
    expect(lines(moved, "dtstart")).toEqual(["DTSTART;TZID=Europe/Moscow:20261026T120000"]);
    expect(namesOf(touched, moved)).toEqual(["attendee", "summary", "valarm"]);

    // У второго свой заголовок и свой ответ участника: меняется только LOCATION.
    expect(inheritFields(incident, oldMaster, o.master!, fields, touched)).toEqual(["location"]);
    expect(lines(incident, "summary")).toEqual(["SUMMARY:Разбор инцидента"]);
    expect(lines(incident, "location")).toEqual(["LOCATION:Зал 2"]);
    expect(lines(incident, "attendee")).toHaveLength(2);
  });

  it("снятое у основного описание снимается и у совпавшего переопределения", () => {
    const withDescription = ics.replaceAll("SUMMARY:Планёрка\r\n", "SUMMARY:Планёрка\r\nDESCRIPTION:Повестка\r\n");
    const o = load(withDescription);
    const [moved] = o.root.getAllSubcomponents("vevent").filter((c) => c.hasProperty("recurrence-id"));
    const oldMaster = cloneComponent(o.master!);
    applyFieldPatch(o.master!, { description: "" }, { env: ENV, touched: newTouched() });
    expect(inheritFields(moved, oldMaster, o.master!, ["description"])).toEqual(["description"]);
    expect(lines(moved, "description")).toEqual([]);
  });
});
