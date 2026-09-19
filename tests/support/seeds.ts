// Затравки стенда — сырой текст объектов, как он лежит на сервере (§6 плана
// переделки, docs/superpowers/plans/2026-09-19-recurring-events-rework.md).
//
// Затравками задаются только объекты, записанные не этим сервером: Яндексом
// (веб, телефон) и другими клиентами. Всё, что производит новый код, цепочки
// получают настоящими вызовами на стенде. Следов прежнего кода среди
// затравок нет: по поправке плана «без ремонта следов прежнего кода»
// (19.09.2026) прежний код в календари пользователей не писал, и такие
// объекты не распознаются и не чинятся.
//
// Пояса: Europe/Moscow (без перехода времени), Europe/Berlin (переход
// 25.10.2026), America/New_York (переход 01.11.2026), даты (весь день) и
// плавающее время. В каждом из трёх прогонов test:tz хотя бы две затравки
// живут в поясе, отличном от пояса процесса.
//
// Группы: cleanSeeds — без нарушений инвариантов стенда; detachedSeeds — с
// переопределением мимо слотов (роль detached); unparsableSeeds — не
// разбираются ical.js. C62, C63 и detachedSeeds — объекты других клиентов.

export interface Seed {
  uid: string;
  ics: string;
  /** Что это за объект и откуда он. */
  about: string;
}

const CRLF = "\r\n";
const text = (...lines: string[]) => lines.join(CRLF) + CRLF;

// VTIMEZONE в том виде, в каком его отдаёт Яндекс (tests/fixtures/events-query.xml).
const MOSCOW = [
  "BEGIN:VTIMEZONE",
  "TZID:Europe/Moscow",
  "LAST-MODIFIED:20240422T053451Z",
  "TZURL:https://www.tzurl.org/zoneinfo-outlook/Europe/Moscow",
  "X-LIC-LOCATION:Europe/Moscow",
  "BEGIN:STANDARD",
  "TZNAME:MSK",
  "TZOFFSETFROM:+0300",
  "TZOFFSETTO:+0300",
  "DTSTART:19700101T000000",
  "END:STANDARD",
  "END:VTIMEZONE",
];

// Описания из базы IANA (@touch4it/ical-timezones), с переходом времени.
const BERLIN = [
  "BEGIN:VTIMEZONE",
  "TZID:Europe/Berlin",
  "TZURL:http://tzurl.org/zoneinfo-outlook/Europe/Berlin",
  "X-LIC-LOCATION:Europe/Berlin",
  "BEGIN:DAYLIGHT",
  "TZOFFSETFROM:+0100",
  "TZOFFSETTO:+0200",
  "TZNAME:CEST",
  "DTSTART:19700329T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
  "END:DAYLIGHT",
  "BEGIN:STANDARD",
  "TZOFFSETFROM:+0200",
  "TZOFFSETTO:+0100",
  "TZNAME:CET",
  "DTSTART:19701025T030000",
  "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
  "END:STANDARD",
  "END:VTIMEZONE",
];

const NEW_YORK = [
  "BEGIN:VTIMEZONE",
  "TZID:America/New_York",
  "TZURL:http://tzurl.org/zoneinfo-outlook/America/New_York",
  "X-LIC-LOCATION:America/New_York",
  "BEGIN:DAYLIGHT",
  "TZOFFSETFROM:-0500",
  "TZOFFSETTO:-0400",
  "TZNAME:EDT",
  "DTSTART:19700308T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU",
  "END:DAYLIGHT",
  "BEGIN:STANDARD",
  "TZOFFSETFROM:-0400",
  "TZOFFSETTO:-0500",
  "TZNAME:EST",
  "DTSTART:19701101T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU",
  "END:STANDARD",
  "END:VTIMEZONE",
];

const YANDEX_HEAD = ["BEGIN:VCALENDAR", "PRODID:-//Yandex LLC//Yandex Calendar//EN", "VERSION:2.0", "CALSCALE:GREGORIAN", "METHOD:PUBLISH"];
const YANDEX_TAIL = ["SEQUENCE:0", "CREATED:20261001T090000Z", "LAST-MODIFIED:20261001T090000Z", "TRANSP:OPAQUE", "CLASS:PUBLIC", "END:VEVENT", "END:VCALENDAR"];

// ---------------------------------------------------------------------------
// Чистые серии
// ---------------------------------------------------------------------------

/** Серия по умолчанию цепочек: Пн и Ср 10:00–11:00 МСК с 19.10.2026, COUNT=6. */
export const weeklyMoscow: Seed = {
  uid: "7f3c9a1be2d4@yandex.ru",
  about: "Пн и Ср 10:00–11:00 Europe/Moscow с 19.10.2026, COUNT=6: 19, 21, 26, 28 окт., 2, 4 нояб.",
  ics: text(
    ...YANDEX_HEAD,
    ...MOSCOW,
    "BEGIN:VEVENT",
    "UID:7f3c9a1be2d4@yandex.ru",
    "DTSTAMP:20261001T090000Z",
    "DTSTART;TZID=Europe/Moscow:20261019T100000",
    "DTEND;TZID=Europe/Moscow:20261019T110000",
    "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6",
    "SUMMARY:Планёрка",
    ...YANDEX_TAIL,
  ),
};

/** DAILY через переход на зимнее время в Германии 25.10.2026 (C14d). */
export const dailyBerlin: Seed = {
  uid: "b3e1d2c4a5f6@yandex.ru",
  about: "Ежедневно 10:00–11:00 Europe/Berlin с 21.10.2026, COUNT=10: через переход CEST→CET 25.10",
  ics: text(
    ...YANDEX_HEAD,
    ...BERLIN,
    "BEGIN:VEVENT",
    "UID:b3e1d2c4a5f6@yandex.ru",
    "DTSTAMP:20261001T090000Z",
    "DTSTART;TZID=Europe/Berlin:20261021T100000",
    "DTEND;TZID=Europe/Berlin:20261021T110000",
    "RRULE:FREQ=DAILY;COUNT=10",
    "SUMMARY:Стендап Берлин",
    ...YANDEX_TAIL,
  ),
};

/** Серия через переход в США 01.11.2026. */
export const weeklyNewYork: Seed = {
  uid: "a9f8e7d6c5b4@yandex.ru",
  about: "Пн и Ср 09:00–10:00 America/New_York с 19.10.2026, COUNT=6: через переход EDT→EST 01.11",
  ics: text(
    ...YANDEX_HEAD,
    ...NEW_YORK,
    "BEGIN:VEVENT",
    "UID:a9f8e7d6c5b4@yandex.ru",
    "DTSTAMP:20261001T090000Z",
    "DTSTART;TZID=America/New_York:20261019T090000",
    "DTEND;TZID=America/New_York:20261019T100000",
    "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6",
    "SUMMARY:Созвон с Нью-Йорком",
    ...YANDEX_TAIL,
  ),
};

/** Серия на весь день (C19). */
export const allDayWeekly: Seed = {
  uid: "d1a2b3c4e5f6@yandex.ru",
  about: "Весь день, Пн и Ср с 19.10.2026, COUNT=6: даты 19, 21, 26, 28 окт., 2, 4 нояб.",
  ics: text(
    ...YANDEX_HEAD,
    "BEGIN:VEVENT",
    "UID:d1a2b3c4e5f6@yandex.ru",
    "DTSTAMP:20261001T090000Z",
    "DTSTART;VALUE=DATE:20261019",
    "DTEND;VALUE=DATE:20261020",
    "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6",
    "SUMMARY:Дежурство",
    "SEQUENCE:0",
    "TRANSP:TRANSPARENT",
    "CLASS:PUBLIC",
    "END:VEVENT",
    "END:VCALENDAR",
  ),
};

/** Плавающее время: без TZID и без Z, пояс берётся из календаря. */
export const floatingDaily: Seed = {
  uid: "f10a7e1d2c3b@example.com",
  about: "Ежедневно 08:00–08:30 плавающего времени с 19.10.2026, COUNT=5 (чужой клиент)",
  ics: text(
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Example Corp.//Other Client//EN",
    "BEGIN:VEVENT",
    "UID:f10a7e1d2c3b@example.com",
    "DTSTAMP:20261001T090000Z",
    "DTSTART:20261019T080000",
    "DTEND:20261019T083000",
    "RRULE:FREQ=DAILY;COUNT=5",
    "SUMMARY:Зарядка",
    "END:VEVENT",
    "END:VCALENDAR",
  ),
};

/** Одиночная встреча. */
export const singleMoscow: Seed = {
  uid: "0a1b2c3d4e5f@yandex.ru",
  about: "Одиночная встреча 20.10.2026 15:00–16:00 Europe/Moscow",
  ics: text(
    ...YANDEX_HEAD,
    ...MOSCOW,
    "BEGIN:VEVENT",
    "UID:0a1b2c3d4e5f@yandex.ru",
    "DTSTAMP:20261001T090000Z",
    "DTSTART;TZID=Europe/Moscow:20261020T150000",
    "DTEND;TZID=Europe/Moscow:20261020T160000",
    "SUMMARY:Обед с командой",
    ...YANDEX_TAIL,
  ),
};

/**
 * Серия со всем, что правка обязана сохранить (C15): EXDATE, RDATE,
 * ORGANIZER с CN в кавычках, ATTENDEE с CN и ROLE, CATEGORIES,
 * X-TELEMOST-CONFERENCE, SEQUENCE, два VALARM (AUDIO и DISPLAY), свёрнутая
 * длинная строка. Слоты: 21.10, 4.11, 11.11, 18.11 (28.10 закрыт EXDATE) и
 * 30.10 по RDATE.
 */
export const richMoscow: Seed = {
  uid: "5e6f7a8b9c0d@yandex.ru",
  about: "Ср 12:00–13:00 Europe/Moscow с 21.10.2026, COUNT=5, EXDATE 28.10, RDATE 30.10, участники, напоминания",
  ics: text(
    ...YANDEX_HEAD,
    ...MOSCOW,
    "BEGIN:VEVENT",
    "UID:5e6f7a8b9c0d@yandex.ru",
    "DTSTAMP:20261001T090000Z",
    "DTSTART;TZID=Europe/Moscow:20261021T120000",
    "DTEND;TZID=Europe/Moscow:20261021T130000",
    "RRULE:FREQ=WEEKLY;BYDAY=WE;COUNT=5",
    "EXDATE;TZID=Europe/Moscow:20261028T120000",
    "RDATE;TZID=Europe/Moscow:20261030T120000",
    "SUMMARY:Созвон по проекту",
    "DESCRIPTION:Повестка: смета\\, сроки и риски ",
    " проекта. Ссылка на документ — в ",
    " приглашении.",
    'ORGANIZER;CN="Анна Смирнова":mailto:anna@example.com',
    "ATTENDEE;CN=Пётр Петров;PARTSTAT=ACCEPTED;ROLE=REQ-PARTICIPANT:mailto:petrov@example.com",
    "ATTENDEE;CN=Анна Смирнова;PARTSTAT=ACCEPTED;ROLE=CHAIR:mailto:anna@example.com",
    "CATEGORIES:Проект,Важное",
    "X-TELEMOST-CONFERENCE:https://telemost.yandex.ru/j/00000000000000",
    "SEQUENCE:2",
    "CREATED:20261001T090000Z",
    "LAST-MODIFIED:20261001T090000Z",
    "TRANSP:OPAQUE",
    "CLASS:PUBLIC",
    "BEGIN:VALARM",
    "ACTION:AUDIO",
    "TRIGGER:-PT10M",
    "END:VALARM",
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    "DESCRIPTION:Напоминание",
    "TRIGGER:-PT15M",
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ),
};

// ---------------------------------------------------------------------------
// Объекты других клиентов
// ---------------------------------------------------------------------------

const OTHER_CLIENT_HEAD = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Example Corp.//Other Client//EN"];

// Переопределение, чей RECURRENCE-ID не попадает ни на один слот серии, не
// закрыт EXDATE и лежит внутри серии, в модели получает роль detached (Р5 в
// редакции поправки «без ремонта следов прежнего кода»): это отдельная
// встреча с адресом `instanceStart` = RECURRENCE-ID, она занимает время,
// правится и удаляется по этому адресу. Аномалией модели оно не считается.
// Инварианты стенда (invariants.ts) видят в нём вид orphan-override —
// переопределение мимо слотов. В затравке стенд его терпит, а записи клиента
// не прощает новой сироты сверх прежних (О12а: аномалий не больше, чем было).

/**
 * Пн и Ср 10:00–11:00 МСК с 19.10.2026, COUNT=6. Встреча 21.10 перенесена на
 * 15:00–16:00 — переопределение слота. Второе переопределение, «Планёрка
 * (перенесена)», — с RECURRENCE-ID 21.10 15:00 мимо слотов: detached, тоже
 * 15:00–16:00. В выдаче 21.10 две встречи в 15:00. То, что RECURRENCE-ID
 * одного переопределения равен DTSTART другого, роли не меняет: так
 * выглядят и законные переносы.
 */
export const detachedAtMovedStart: Seed = {
  uid: "a7ed31f3-0a95-49c7-945d-c0c3c213e1ad",
  about: "Пн и Ср 10:00 МСК с 19.10.2026, COUNT=6; перенос 21.10 на 15:00 и detached с RECURRENCE-ID 21.10 15:00",
  ics: text(
    ...OTHER_CLIENT_HEAD,
    ...MOSCOW,
    "BEGIN:VEVENT",
    "UID:a7ed31f3-0a95-49c7-945d-c0c3c213e1ad",
    "DTSTAMP:20261001T090000Z",
    "DTSTART;TZID=Europe/Moscow:20261019T100000",
    "DTEND;TZID=Europe/Moscow:20261019T110000",
    "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6",
    "SUMMARY:Планёрка",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:a7ed31f3-0a95-49c7-945d-c0c3c213e1ad",
    "DTSTAMP:20261001T090000Z",
    "RECURRENCE-ID;TZID=Europe/Moscow:20261021T100000",
    "DTSTART;TZID=Europe/Moscow:20261021T150000",
    "DTEND;TZID=Europe/Moscow:20261021T160000",
    "SUMMARY:Планёрка",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:a7ed31f3-0a95-49c7-945d-c0c3c213e1ad",
    "DTSTAMP:20261001T090000Z",
    "RECURRENCE-ID;TZID=Europe/Moscow:20261021T150000",
    "DTSTART;TZID=Europe/Moscow:20261021T150000",
    "DTEND;TZID=Europe/Moscow:20261021T160000",
    "SUMMARY:Планёрка (перенесена)",
    "END:VEVENT",
    "END:VCALENDAR",
  ),
};

/**
 * Пн и Ср 09:00–10:00 МСК с 19.10.2026, COUNT=6, и переопределение с
 * RECURRENCE-ID 21.10 10:00 → 11:30–12:30: в дату слота 21.10 09:00, но не в
 * его время. Это detached, а не встреча слота: 21.10 видны две встречи, в
 * 09:00 и в 11:30, и удаление одной не трогает другую. Цепочка — в
 * tests/chains/foreign.test.ts.
 */
export const detachedOnSlotDate: Seed = {
  uid: "ebf1c8d4-ab9d-4d4b-b591-d391db117aab",
  about: "Пн и Ср 09:00 МСК с 19.10.2026, COUNT=6; detached с RECURRENCE-ID 21.10 10:00 → 11:30, в дату слота 09:00",
  ics: text(
    ...OTHER_CLIENT_HEAD,
    ...MOSCOW,
    "BEGIN:VEVENT",
    "UID:ebf1c8d4-ab9d-4d4b-b591-d391db117aab",
    "DTSTAMP:20261001T090000Z",
    "DTSTART;TZID=Europe/Moscow:20261019T090000",
    "DTEND;TZID=Europe/Moscow:20261019T100000",
    "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6",
    "SUMMARY:Планёрка",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:ebf1c8d4-ab9d-4d4b-b591-d391db117aab",
    "DTSTAMP:20261001T090000Z",
    "RECURRENCE-ID;TZID=Europe/Moscow:20261021T100000",
    "DTSTART;TZID=Europe/Moscow:20261021T113000",
    "DTEND;TZID=Europe/Moscow:20261021T123000",
    "SUMMARY:Планёрка",
    "END:VEVENT",
    "END:VCALENDAR",
  ),
};

/** C62: основной компонент с DURATION вместо DTEND (другой клиент, RFC 5545 §3.6.1). */
export const c62DurationMaster: Seed = {
  uid: "C62D0A7E-4F1B-4E8B-9C35-2D1F6A0B7E62",
  about: "C62: Пн и Ср 10:00 + PT45M Europe/Moscow с 19.10.2026, COUNT=6; конец задан DURATION",
  ics: text(
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Apple Inc.//macOS 16.0//EN",
    "CALSCALE:GREGORIAN",
    ...MOSCOW,
    "BEGIN:VEVENT",
    "UID:C62D0A7E-4F1B-4E8B-9C35-2D1F6A0B7E62",
    "DTSTAMP:20261001T090000Z",
    "DTSTART;TZID=Europe/Moscow:20261019T100000",
    "DURATION:PT45M",
    "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6",
    "SUMMARY:Разбор задач",
    "SEQUENCE:0",
    "CREATED:20261001T090000Z",
    "END:VEVENT",
    "END:VCALENDAR",
  ),
};

const badRule = (uid: string, rule: string, summary: string) =>
  text(
    ...YANDEX_HEAD,
    ...MOSCOW,
    "BEGIN:VEVENT",
    `UID:${uid}`,
    "DTSTAMP:20261001T090000Z",
    "DTSTART;TZID=Europe/Moscow:20261019T100000",
    "DTEND;TZID=Europe/Moscow:20261019T110000",
    `RRULE:${rule}`,
    `SUMMARY:${summary}`,
    ...YANDEX_TAIL,
  );

/** C63: неизвестная частота — ICAL.parse бросает (lib/ical/recur.js, _stringToData). */
export const c63BadFreq: Seed = {
  uid: "c63freqfoo01@yandex.ru",
  about: "C63: RRULE FREQ=FOO — объект не разбирается ical.js; класть через seedRaw",
  ics: badRule("c63freqfoo01@yandex.ru", "FREQ=FOO;COUNT=6", "Правило с неизвестной частотой"),
};

/** C63: BYDAY=0MO — ICAL.parse бросает «invalid BYDAY value». */
export const c63BadByday: Seed = {
  uid: "c63byday0mo1@yandex.ru",
  about: "C63: RRULE BYDAY=0MO — объект не разбирается ical.js; класть через seedRaw",
  ics: badRule("c63byday0mo1@yandex.ru", "FREQ=WEEKLY;BYDAY=0MO;COUNT=6", "Правило с нулевым днём"),
};

/** Затравки без нарушений инвариантов. */
export const cleanSeeds: readonly Seed[] = [
  weeklyMoscow,
  dailyBerlin,
  weeklyNewYork,
  allDayWeekly,
  floatingDaily,
  singleMoscow,
  richMoscow,
  c62DurationMaster,
];

/**
 * Чужие объекты с detached-переопределением. В модели нарушений нет, для
 * инвариантов стенда у каждого одно — orphan-override (переопределение мимо
 * слотов), которое стенд терпит в затравке.
 */
export const detachedSeeds: readonly Seed[] = [detachedAtMovedStart, detachedOnSlotDate];

/** Не разбираются ical.js. */
export const unparsableSeeds: readonly Seed[] = [c63BadFreq, c63BadByday];

// ---------------------------------------------------------------------------
// Прежние имена
// ---------------------------------------------------------------------------
//
// Синонимы тех же объектов под именами, которые затравки носили, пока
// считались следами прежнего кода. Оставлены на время волны 3, чтобы не
// сломать код, написанный параллельно; новых ссылок на них не добавлять.

/** @deprecated Прежнее имя затравки detachedAtMovedStart. */
export const c55EchoOverride: Seed = detachedAtMovedStart;
/** @deprecated Прежнее имя затравки detachedOnSlotDate. */
export const c56StaleShift: Seed = detachedOnSlotDate;
/** @deprecated Прежнее имя группы detachedSeeds. */
export const legacySeeds: readonly Seed[] = detachedSeeds;
