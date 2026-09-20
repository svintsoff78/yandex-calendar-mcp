// Корпус оракула: затравки, патчи, scope (пункты 1–3 задания).
//
// Затравки — сырой текст объектов, как он лежал бы на сервере: их пишет
// Яндекс или другой клиент, не наш код. Часть взята из tests/support/seeds.ts
// (менять тот файл нельзя, только читать), остальные добавлены здесь, чтобы
// закрыть перечень из задания: одиночное событие, бесконечная серия, серия
// по COUNT, по UNTIL, из одних RDATE, с RDATE;VALUE=PERIOD, с
// переопределением на месте, с перенесённым, с перенесённым раньше начала
// серии, со скрытым под EXDATE, со скрытым за концом серии, с оторванным,
// всесуточная, с EXDATE в середине, с WKST, с BYSETPOS, испорченные чужими
// клиентами (два RRULE, два переопределения на один RECURRENCE-ID).
//
// Добавлено после ручного разбора: объекты с испорченным временем (DTEND
// вместе с DURATION, нулевая и отрицательная длительность, DTSTART в форме
// DATE при DTEND со временем), скрытое переопределение на EXDATE мимо слотов
// правила и серия с богатым напоминанием письмом.
//
// Пояса: Europe/Moscow (без перевода часов), Europe/Berlin (переход
// 25.10.2026), America/New_York (переход 01.11.2026), даты и плавающее
// время. У каждой затравки с TZID — свой VTIMEZONE внутри объекта.
import type { EventPatch } from "../../src/ical/plan.js";
import type { EditScope } from "../../src/types.js";
import {
  allDayWeekly,
  c62DurationMaster,
  detachedAtMovedStart,
  detachedOnSlotDate,
  floatingDaily,
  richMoscow,
  singleMoscow,
  weeklyMoscow,
  weeklyNewYork,
  type Seed,
} from "../support/seeds.js";

const CRLF = "\r\n";
const text = (...lines: string[]) => lines.join(CRLF) + CRLF;

// VTIMEZONE в том виде, в каком его отдаёт Яндекс (tests/fixtures/events-query.xml).
const MOSCOW = [
  "BEGIN:VTIMEZONE",
  "TZID:Europe/Moscow",
  "X-LIC-LOCATION:Europe/Moscow",
  "BEGIN:STANDARD",
  "TZNAME:MSK",
  "TZOFFSETFROM:+0300",
  "TZOFFSETTO:+0300",
  "DTSTART:19700101T000000",
  "END:STANDARD",
  "END:VTIMEZONE",
];

// Берлин с переводом часов: CEST → CET 25.10.2026.
const BERLIN = [
  "BEGIN:VTIMEZONE",
  "TZID:Europe/Berlin",
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

const HEAD = ["BEGIN:VCALENDAR", "PRODID:-//Yandex LLC//Yandex Calendar//EN", "VERSION:2.0", "CALSCALE:GREGORIAN"];
const OTHER_HEAD = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Example Corp.//Other Client//EN"];

function object(head: string[], zone: string[], ...events: string[][]): string {
  return text(...head, ...zone, ...events.flat(), "END:VCALENDAR");
}

function vevent(uid: string, ...lines: string[]): string[] {
  return ["BEGIN:VEVENT", `UID:${uid}`, "DTSTAMP:20261001T090000Z", ...lines, "SEQUENCE:0", "END:VEVENT"];
}

// ---------------------------------------------------------------------------
// Свои затравки
// ---------------------------------------------------------------------------

/** Одиночное событие в поясе с переводом часов, в день после перехода. */
export const singleBerlin: Seed = {
  uid: "or-single-berlin@example.com",
  about: "Одиночная встреча 27.10.2026 18:00–19:00 Europe/Berlin (после перехода на CET)",
  ics: object(
    HEAD,
    BERLIN,
    vevent(
      "or-single-berlin@example.com",
      "DTSTART;TZID=Europe/Berlin:20261027T180000",
      "DTEND;TZID=Europe/Berlin:20261027T190000",
      "SUMMARY:Ужин с партнёрами",
      "LOCATION:Берлин, Митте",
    ),
  ),
};

/** Бесконечная серия: RRULE без COUNT и UNTIL. */
export const infiniteWeeklyMoscow: Seed = {
  uid: "or-infinite-weekly@example.com",
  about: "Вт 09:00–09:30 Europe/Moscow с 20.10.2026, RRULE без конца",
  ics: object(
    HEAD,
    MOSCOW,
    vevent(
      "or-infinite-weekly@example.com",
      "DTSTART;TZID=Europe/Moscow:20261020T090000",
      "DTEND;TZID=Europe/Moscow:20261020T093000",
      "RRULE:FREQ=WEEKLY;BYDAY=TU",
      "SUMMARY:Бесконечная планёрка",
    ),
  ),
};

/** Бесконечная ежедневная серия через перевод часов. */
export const infiniteDailyBerlin: Seed = {
  uid: "or-infinite-daily@example.com",
  about: "Ежедневно 08:00–08:45 Europe/Berlin с 21.10.2026, RRULE без конца (через переход 25.10)",
  ics: object(
    HEAD,
    BERLIN,
    vevent(
      "or-infinite-daily@example.com",
      "DTSTART;TZID=Europe/Berlin:20261021T080000",
      "DTEND;TZID=Europe/Berlin:20261021T084500",
      "RRULE:FREQ=DAILY",
      "SUMMARY:Бесконечный стендап",
    ),
  ),
};

/** Серия, конечная по UNTIL, с переводом часов внутри. */
export const untilBerlin: Seed = {
  uid: "or-until-berlin@example.com",
  about: "Ср 11:00–12:00 Europe/Berlin с 21.10.2026, UNTIL 18.11.2026 09:00Z (через переход 25.10)",
  ics: object(
    HEAD,
    BERLIN,
    vevent(
      "or-until-berlin@example.com",
      "DTSTART;TZID=Europe/Berlin:20261021T110000",
      "DTEND;TZID=Europe/Berlin:20261021T120000",
      "RRULE:FREQ=WEEKLY;BYDAY=WE;UNTIL=20261118T090000Z",
      "SUMMARY:Серия до UNTIL",
    ),
  ),
};

/** Серия из одних RDATE, без RRULE. */
export const rdateOnlyMoscow: Seed = {
  uid: "or-rdate-only@example.com",
  about: "Три встречи 14:00–15:00 Europe/Moscow: 19.10 (DTSTART) и RDATE 26.10, 02.11; RRULE нет",
  ics: object(
    HEAD,
    MOSCOW,
    vevent(
      "or-rdate-only@example.com",
      "DTSTART;TZID=Europe/Moscow:20261019T140000",
      "DTEND;TZID=Europe/Moscow:20261019T150000",
      "RDATE;TZID=Europe/Moscow:20261026T140000,20261102T140000",
      "SUMMARY:Серия без правила",
    ),
  ),
};

/** RDATE;VALUE=PERIOD со своей длительностью. */
export const rdatePeriodMoscow: Seed = {
  uid: "or-rdate-period@example.com",
  about: "Пн 14:00–15:00 Europe/Moscow с 19.10.2026, COUNT=3, плюс RDATE;VALUE=PERIOD 23.10 16:00/PT2H",
  ics: object(
    HEAD,
    MOSCOW,
    vevent(
      "or-rdate-period@example.com",
      "DTSTART;TZID=Europe/Moscow:20261019T140000",
      "DTEND;TZID=Europe/Moscow:20261019T150000",
      "RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=3",
      "RDATE;TZID=Europe/Moscow;VALUE=PERIOD:20261023T160000/PT2H",
      "SUMMARY:Серия с периодом",
    ),
  ),
};

/** Переопределение на месте: то же время слота, свои поля. */
export const slotOverrideMoscow: Seed = {
  uid: "or-slot-override@example.com",
  about: "Пн и Ср 10:00–11:00 Europe/Moscow с 19.10.2026, COUNT=6; у 21.10 свои заголовок и место, время слота",
  ics: object(
    HEAD,
    MOSCOW,
    vevent(
      "or-slot-override@example.com",
      "DTSTART;TZID=Europe/Moscow:20261019T100000",
      "DTEND;TZID=Europe/Moscow:20261019T110000",
      "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6",
      "SUMMARY:Планёрка",
      "LOCATION:Переговорная 1",
    ),
    vevent(
      "or-slot-override@example.com",
      "RECURRENCE-ID;TZID=Europe/Moscow:20261021T100000",
      "DTSTART;TZID=Europe/Moscow:20261021T100000",
      "DTEND;TZID=Europe/Moscow:20261021T110000",
      "SUMMARY:Планёрка с гостями",
      "LOCATION:Большой зал",
    ),
  ),
};

/** Перенесённое переопределение в поясе с переводом часов, за переходом. */
export const movedOverrideBerlin: Seed = {
  uid: "or-moved-override@example.com",
  about: "Пн и Ср 10:00–11:00 Europe/Berlin с 19.10.2026, COUNT=6; 28.10 перенесена на 15:00 (уже CET)",
  ics: object(
    HEAD,
    BERLIN,
    vevent(
      "or-moved-override@example.com",
      "DTSTART;TZID=Europe/Berlin:20261019T100000",
      "DTEND;TZID=Europe/Berlin:20261019T110000",
      "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6",
      "SUMMARY:Планёрка Берлин",
    ),
    vevent(
      "or-moved-override@example.com",
      "RECURRENCE-ID;TZID=Europe/Berlin:20261028T100000",
      "DTSTART;TZID=Europe/Berlin:20261028T150000",
      "DTEND;TZID=Europe/Berlin:20261028T161500",
      "SUMMARY:Планёрка Берлин",
    ),
  ),
};

/** Переопределение, перенесённое раньше начала серии. */
export const movedBeforeStartMoscow: Seed = {
  uid: "or-moved-before-start@example.com",
  about: "Пн и Ср 10:00–11:00 Europe/Moscow с 19.10.2026, COUNT=6; 26.10 перенесена на 16.10 10:00 — раньше начала серии",
  ics: object(
    HEAD,
    MOSCOW,
    vevent(
      "or-moved-before-start@example.com",
      "DTSTART;TZID=Europe/Moscow:20261019T100000",
      "DTEND;TZID=Europe/Moscow:20261019T110000",
      "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6",
      "SUMMARY:Планёрка",
    ),
    vevent(
      "or-moved-before-start@example.com",
      "RECURRENCE-ID;TZID=Europe/Moscow:20261026T100000",
      "DTSTART;TZID=Europe/Moscow:20261016T100000",
      "DTEND;TZID=Europe/Moscow:20261016T110000",
      "SUMMARY:Планёрка (перенесена раньше серии)",
    ),
  ),
};

/** Скрытое переопределение: RECURRENCE-ID под EXDATE. */
export const hiddenUnderExdateMoscow: Seed = {
  uid: "or-hidden-exdate@example.com",
  about: "Ср 12:00–13:00 Europe/Moscow с 21.10.2026, COUNT=4; 28.10 закрыт EXDATE, а его переопределение осталось (скрытое)",
  ics: object(
    HEAD,
    MOSCOW,
    vevent(
      "or-hidden-exdate@example.com",
      "DTSTART;TZID=Europe/Moscow:20261021T120000",
      "DTEND;TZID=Europe/Moscow:20261021T130000",
      "RRULE:FREQ=WEEKLY;BYDAY=WE;COUNT=4",
      "EXDATE;TZID=Europe/Moscow:20261028T120000",
      "SUMMARY:Созвон",
    ),
    vevent(
      "or-hidden-exdate@example.com",
      "RECURRENCE-ID;TZID=Europe/Moscow:20261028T120000",
      "DTSTART;TZID=Europe/Moscow:20261028T160000",
      "DTEND;TZID=Europe/Moscow:20261028T170000",
      "SUMMARY:Созвон (скрытый под EXDATE)",
    ),
  ),
};

/** Скрытое переопределение за концом серии. */
export const hiddenPastEndMoscow: Seed = {
  uid: "or-hidden-past-end@example.com",
  about: "Ср 12:00–13:00 Europe/Moscow с 21.10.2026, COUNT=3 (по 04.11); переопределение с RECURRENCE-ID 18.11 — за концом серии",
  ics: object(
    HEAD,
    MOSCOW,
    vevent(
      "or-hidden-past-end@example.com",
      "DTSTART;TZID=Europe/Moscow:20261021T120000",
      "DTEND;TZID=Europe/Moscow:20261021T130000",
      "RRULE:FREQ=WEEKLY;BYDAY=WE;COUNT=3",
      "SUMMARY:Короткая серия",
    ),
    vevent(
      "or-hidden-past-end@example.com",
      "RECURRENCE-ID;TZID=Europe/Moscow:20261118T120000",
      "DTSTART;TZID=Europe/Moscow:20261118T120000",
      "DTEND;TZID=Europe/Moscow:20261118T130000",
      "SUMMARY:Короткая серия (за концом)",
    ),
  ),
};

/** EXDATE в середине серии, пояс с переводом часов. */
export const exdateMiddleBerlin: Seed = {
  uid: "or-exdate-middle@example.com",
  about: "Пн и Ср 10:00–11:00 Europe/Berlin с 19.10.2026, COUNT=6; EXDATE 26.10 (первый слот после перехода)",
  ics: object(
    HEAD,
    BERLIN,
    vevent(
      "or-exdate-middle@example.com",
      "DTSTART;TZID=Europe/Berlin:20261019T100000",
      "DTEND;TZID=Europe/Berlin:20261019T110000",
      "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6",
      "EXDATE;TZID=Europe/Berlin:20261026T100000",
      "SUMMARY:Планёрка с пропуском",
    ),
  ),
};

/** Правило с WKST (Ж6: Яндекс такое правило искажает при записи). */
export const wkstBerlin: Seed = {
  uid: "or-wkst@example.com",
  about: "Через неделю Пн и Чт 10:00–11:00 Europe/Berlin с 19.10.2026, COUNT=6, WKST=SU",
  ics: object(
    HEAD,
    BERLIN,
    vevent(
      "or-wkst@example.com",
      "DTSTART;TZID=Europe/Berlin:20261019T100000",
      "DTEND;TZID=Europe/Berlin:20261019T110000",
      "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH;WKST=SU;COUNT=6",
      "SUMMARY:Через неделю",
    ),
  ),
};

/** Правило с BYSETPOS (Ж6). */
export const bysetposMoscow: Seed = {
  uid: "or-bysetpos@example.com",
  about: "Последний рабочий день месяца 10:00–11:00 Europe/Moscow с 30.10.2026, COUNT=4",
  ics: object(
    HEAD,
    MOSCOW,
    vevent(
      "or-bysetpos@example.com",
      "DTSTART;TZID=Europe/Moscow:20261030T100000",
      "DTEND;TZID=Europe/Moscow:20261030T110000",
      "RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;COUNT=4",
      "SUMMARY:Итоги месяца",
    ),
  ),
};

/** Испорчено чужим клиентом: два RRULE у основного компонента. */
export const twoRrulesMoscow: Seed = {
  uid: "or-two-rrules@example.com",
  about: "Испорчено чужим клиентом: два RRULE у основного компонента (Пн,Ср COUNT=6 и Пт COUNT=3)",
  ics: object(
    OTHER_HEAD,
    MOSCOW,
    vevent(
      "or-two-rrules@example.com",
      "DTSTART;TZID=Europe/Moscow:20261019T100000",
      "DTEND;TZID=Europe/Moscow:20261019T110000",
      "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6",
      "RRULE:FREQ=WEEKLY;BYDAY=FR;COUNT=3",
      "SUMMARY:Две повторяемости",
    ),
  ),
};

/** Испорчено чужим клиентом: два переопределения на один RECURRENCE-ID. */
export const duplicateOverrideMoscow: Seed = {
  uid: "or-duplicate-override@example.com",
  about: "Испорчено чужим клиентом: два переопределения с RECURRENCE-ID 21.10 10:00, разные время и заголовок",
  ics: object(
    OTHER_HEAD,
    MOSCOW,
    vevent(
      "or-duplicate-override@example.com",
      "DTSTART;TZID=Europe/Moscow:20261019T100000",
      "DTEND;TZID=Europe/Moscow:20261019T110000",
      "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6",
      "SUMMARY:Планёрка",
    ),
    vevent(
      "or-duplicate-override@example.com",
      "RECURRENCE-ID;TZID=Europe/Moscow:20261021T100000",
      "DTSTART;TZID=Europe/Moscow:20261021T140000",
      "DTEND;TZID=Europe/Moscow:20261021T150000",
      "SUMMARY:Планёрка (правка телефона)",
    ),
    vevent(
      "or-duplicate-override@example.com",
      "RECURRENCE-ID;TZID=Europe/Moscow:20261021T100000",
      "DTSTART;TZID=Europe/Moscow:20261021T160000",
      "DTEND;TZID=Europe/Moscow:20261021T170000",
      "SUMMARY:Планёрка (правка веба)",
    ),
  ),
};

// ---------------------------------------------------------------------------
// Испорченное время, записанное чужими клиентами
// ---------------------------------------------------------------------------
//
// Эти четыре объекта нарушают RFC 5545 в самом времени основного компонента.
// Правка обязана поступить с ними одним из двух законных способов: либо
// отказать внятно, либо записать нечто, что сервер примет. Молчаливое
// тиражирование порчи (перенос DTEND вместе с DURATION в новое
// переопределение, нулевая или отрицательная длительность у новой встречи) —
// дефект, и строгий режим подставного сервера отвечает на такую запись 400.
//
// Поэтому в перечне они идут БЕЗ пометки corrupted: их отказы считаются
// наравне с прочими, а записи проверяются по общим правилам.

/** У основного компонента разом DTEND и DURATION (RFC 5545 §3.6.1 такого не допускает). */
export const dtendWithDurationMoscow: Seed = {
  uid: "or-dtend-duration@example.com",
  about: "Испорчено чужим клиентом: Пн и Ср с 19.10.2026 МСК, COUNT=6, у основного компонента и DTEND 11:00, и DURATION PT30M",
  ics: object(
    OTHER_HEAD,
    MOSCOW,
    vevent(
      "or-dtend-duration@example.com",
      "DTSTART;TZID=Europe/Moscow:20261019T100000",
      "DTEND;TZID=Europe/Moscow:20261019T110000",
      "DURATION:PT30M",
      "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6",
      "SUMMARY:Конец задан дважды",
    ),
  ),
};

/** DTEND равен DTSTART: встречи нулевой длительности. */
export const zeroLengthMoscow: Seed = {
  uid: "or-zero-length@example.com",
  about: "Испорчено чужим клиентом: Пн и Ср 10:00 МСК с 19.10.2026, COUNT=6, DTEND равен DTSTART (нулевая длительность)",
  ics: object(
    OTHER_HEAD,
    MOSCOW,
    vevent(
      "or-zero-length@example.com",
      "DTSTART;TZID=Europe/Moscow:20261019T100000",
      "DTEND;TZID=Europe/Moscow:20261019T100000",
      "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6",
      "SUMMARY:Нулевая длительность",
    ),
  ),
};

/** DTEND раньше DTSTART: встречи отрицательной длительности. */
export const endBeforeStartMoscow: Seed = {
  uid: "or-end-before-start@example.com",
  about: "Испорчено чужим клиентом: Пн и Ср 10:00 МСК с 19.10.2026, COUNT=6, DTEND 09:30 — раньше DTSTART",
  ics: object(
    OTHER_HEAD,
    MOSCOW,
    vevent(
      "or-end-before-start@example.com",
      "DTSTART;TZID=Europe/Moscow:20261019T100000",
      "DTEND;TZID=Europe/Moscow:20261019T093000",
      "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6",
      "SUMMARY:Конец раньше начала",
    ),
  ),
};

/** DTSTART в форме DATE, DTEND со временем: формы концов не совпадают (О4). */
export const dateStartTimeEndMoscow: Seed = {
  uid: "or-date-start-time-end@example.com",
  about: "Испорчено чужим клиентом: Пн и Ср с 19.10.2026, COUNT=6, DTSTART в форме DATE, а DTEND со временем 11:00 МСК",
  ics: object(
    OTHER_HEAD,
    MOSCOW,
    vevent(
      "or-date-start-time-end@example.com",
      "DTSTART;VALUE=DATE:20261019",
      "DTEND;TZID=Europe/Moscow:20261019T110000",
      "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6",
      "SUMMARY:Дата и время вперемешку",
    ),
  ),
};

/**
 * Скрытое переопределение на EXDATE, который не попал ни на одну позицию
 * правила. У серии по средам EXDATE стоит на четверг: слота он не закрывает,
 * а переопределение с тем же RECURRENCE-ID оказывается и мимо слотов, и под
 * EXDATE разом. В корпусе такого случая не было: `hidden-under-exdate-moscow`
 * прячет настоящий слот, а не позицию мимо правила.
 */
export const exdateOffSlotMoscow: Seed = {
  uid: "or-exdate-off-slot@example.com",
  about: "Ср 12:00–13:00 МСК с 21.10.2026, COUNT=4; EXDATE 29.10 (четверг, мимо слотов) и переопределение по тому же адресу",
  ics: object(
    OTHER_HEAD,
    MOSCOW,
    vevent(
      "or-exdate-off-slot@example.com",
      "DTSTART;TZID=Europe/Moscow:20261021T120000",
      "DTEND;TZID=Europe/Moscow:20261021T130000",
      "RRULE:FREQ=WEEKLY;BYDAY=WE;COUNT=4",
      "EXDATE;TZID=Europe/Moscow:20261029T120000",
      "SUMMARY:Созвон",
    ),
    vevent(
      "or-exdate-off-slot@example.com",
      "RECURRENCE-ID;TZID=Europe/Moscow:20261029T120000",
      "DTSTART;TZID=Europe/Moscow:20261029T160000",
      "DTEND;TZID=Europe/Moscow:20261029T170000",
      "SUMMARY:Созвон (EXDATE мимо слотов)",
    ),
  ),
};

// ---------------------------------------------------------------------------
// Богатое напоминание
// ---------------------------------------------------------------------------

/**
 * Серия с напоминанием письмом, у которого есть всё своё: адресат
 * (ATTENDEE), вложение (ATTACH), заголовок и текст письма, X-свойство
 * клиента. Второе напоминание — показом, на том же сдвиге, что и в патче
 * напоминаний: оно обязано остаться дословно, а письмо — не потерять
 * адресата при смене сдвига.
 */
export const emailAlarmMoscow: Seed = {
  uid: "or-email-alarm@example.com",
  about: "Ср 12:00–13:00 Europe/Moscow с 21.10.2026, COUNT=4; напоминание показом за 10 минут и письмом за 30 с ATTENDEE, ATTACH, SUMMARY и X-свойством",
  ics: object(
    OTHER_HEAD,
    MOSCOW,
    vevent(
      "or-email-alarm@example.com",
      "DTSTART;TZID=Europe/Moscow:20261021T120000",
      "DTEND;TZID=Europe/Moscow:20261021T130000",
      "RRULE:FREQ=WEEKLY;BYDAY=WE;COUNT=4",
      "SUMMARY:Совет директоров",
      "DESCRIPTION:Повестка в приложении.",
      'ORGANIZER;CN="Анна Смирнова":mailto:anna@example.com',
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      "DESCRIPTION:Напоминание",
      "TRIGGER:-PT10M",
      "END:VALARM",
      "BEGIN:VALARM",
      "ACTION:EMAIL",
      "TRIGGER:-PT30M",
      "ATTENDEE;CN=Пётр Петров:mailto:petrov@example.com",
      "ATTACH;FMTTYPE=application/pdf:https://files.example.com/agenda.pdf",
      "SUMMARY:Напоминание о совете директоров",
      "DESCRIPTION:Через полчаса начинается совет директоров. Повестка во вложении.",
      "X-EXAMPLE-ALARM-ID:a1b2c3",
      "END:VALARM",
    ),
  ),
};

// ---------------------------------------------------------------------------
// Перечень затравок
// ---------------------------------------------------------------------------

export interface OracleSeed extends Seed {
  /** Короткое имя для findings.json и таблиц. */
  name: string;
  /** Объект испорчен другим клиентом: в учёте отказов такие не считаются. */
  corrupted?: boolean;
}

const named = (name: string, seed: Seed, corrupted = false): OracleSeed => ({ name, ...seed, corrupted });

/**
 * Затравки оракула в фиксированном порядке (детерминированность, пункт 7).
 * Порядок не менять: от него зависят порядок записей в findings.json и
 * выбор адресов.
 */
export const ORACLE_SEEDS: readonly OracleSeed[] = [
  named("single-moscow", singleMoscow),
  named("single-berlin", singleBerlin),
  named("weekly-count-moscow", weeklyMoscow),
  named("weekly-newyork", weeklyNewYork),
  named("until-berlin", untilBerlin),
  named("infinite-weekly-moscow", infiniteWeeklyMoscow),
  named("infinite-daily-berlin", infiniteDailyBerlin),
  named("rdate-only-moscow", rdateOnlyMoscow),
  named("rdate-period-moscow", rdatePeriodMoscow),
  named("slot-override-moscow", slotOverrideMoscow),
  named("moved-override-berlin", movedOverrideBerlin),
  named("moved-before-start-moscow", movedBeforeStartMoscow),
  named("hidden-under-exdate-moscow", hiddenUnderExdateMoscow),
  named("hidden-past-end-moscow", hiddenPastEndMoscow),
  named("detached-on-slot-date", detachedOnSlotDate),
  named("detached-at-moved-start", detachedAtMovedStart),
  named("all-day-weekly", allDayWeekly),
  named("exdate-middle-berlin", exdateMiddleBerlin),
  named("rich-moscow", richMoscow),
  named("wkst-berlin", wkstBerlin),
  named("bysetpos-moscow", bysetposMoscow),
  named("floating-daily", floatingDaily),
  named("duration-master", c62DurationMaster),
  named("two-rrules-moscow", twoRrulesMoscow, true),
  named("duplicate-override-moscow", duplicateOverrideMoscow, true),
  // Добавлены после ручного разбора; ставятся в конец, чтобы у прежних
  // затравок не сменился порядковый номер, а с ним и выбор адресов по зерну.
  // Пометки corrupted у них нет нарочно: см. заголовок раздела выше.
  named("dtend-with-duration-moscow", dtendWithDurationMoscow),
  named("zero-length-moscow", zeroLengthMoscow),
  named("end-before-start-moscow", endBeforeStartMoscow),
  named("date-start-time-end-moscow", dateStartTimeEndMoscow),
  named("exdate-off-slot-moscow", exdateOffSlotMoscow),
  named("email-alarm-moscow", emailAlarmMoscow),
];

// ---------------------------------------------------------------------------
// Патчи
// ---------------------------------------------------------------------------

/**
 * Патч корпуса. `kind` говорит, насколько точно оракул умеет посчитать
 * ожидание своими силами:
 * - "field" — поле, которое видно в выдаче: ожидание считается целиком;
 * - "time" — правка времени: ожидание считается целиком для неперенесённых
 *   встреч;
 * - "invariant" — правка, у которой проверяются только инварианты области
 *   (вне области ничего не изменилось, встреч не прибавилось и не убавилось,
 *   конец серии оправдан патчем).
 */
export type PatchKind = "field" | "time" | "invariant";

export interface OraclePatch {
  name: string;
  patch: EventPatch;
  kind: PatchKind;
  /**
   * Поле выдачи, которое патч меняет (для kind "field"): по нему считается
   * ожидание с наследованием О7.
   */
  field?: "summary" | "description" | "location" | "attendees";
  /** Патч заведомо вне языка правки: отказ на всём корпусе — не ложная строгость. */
  outsideLanguage?: boolean;
  note?: string;
}

// Времена в патчах — стенные, без смещения: «время пояса события»
// (src/ical/plan.ts, FieldPatch). Так ожидание считается без догадок о том,
// какой пояс подставит планировщик.
export const ORACLE_PATCHES: readonly OraclePatch[] = [
  { name: "summary", patch: { summary: "Оракул: новое название" }, kind: "field", field: "summary" },
  { name: "description", patch: { description: "Оракул: новое описание" }, kind: "field", field: "description" },
  { name: "location", patch: { location: "Оракул: Переговорная 5" }, kind: "field", field: "location" },
  {
    name: "status",
    patch: { status: "cancelled" } as unknown as EventPatch,
    kind: "invariant",
    outsideLanguage: true,
    note: "В языке правки (FieldPatch) поля status нет: ожидается типизированный отказ invalid-field, а не голая ошибка.",
  },
  {
    name: "participants",
    patch: { attendees: [{ email: "oracle@example.com", status: "needs-action" }] },
    kind: "field",
    field: "attendees",
  },
  {
    name: "reminders",
    patch: {
      reminders: [
        { method: "display", minutesBefore: 10 },
        { method: "email", minutesBefore: 20 },
      ],
    },
    kind: "invariant",
    note:
      "Напоминания в выдачу встречи не попадают, поэтому точного ожидания по ним нет: сверяются инварианты " +
      "области (встречи не сдвинулись, их не прибавилось и не убавилось) и отдельное требование — " +
      "напоминание письмом не остаётся без адресата.",
  },
  { name: "start", patch: { start: "2026-11-05T14:30:00" }, kind: "time" },
  { name: "end", patch: { end: "2026-11-05T16:45:00" }, kind: "time" },
  { name: "start+end", patch: { start: "2026-11-05T14:30:00", end: "2026-11-05T15:30:00" }, kind: "time" },
  {
    name: "timeZone",
    patch: { timeZone: "Europe/Berlin" },
    kind: "invariant",
    note:
      "«timeZone без start сохраняет моменты» (plan.ts) буквально выполнимо только для начала серии: " +
      "в поясе с переводом часов стенное время правит остальными встречами. Оракул сверяет якорь — " +
      "момент первой встречи области — и общие инварианты области.",
  },
  { name: "allDay:true", patch: { allDay: true }, kind: "invariant" },
  { name: "allDay:false", patch: { allDay: false }, kind: "invariant" },
  {
    name: "allDay:true+start+end",
    patch: { allDay: true, start: "2026-11-05", end: "2026-11-06" },
    kind: "invariant",
  },
  {
    name: "allDay:false+start+end",
    patch: { allDay: false, start: "2026-11-05T09:00:00", end: "2026-11-05T10:00:00" },
    kind: "invariant",
  },
  { name: "recurrence:frequency", patch: { recurrence: { frequency: "daily" } }, kind: "invariant" },
  { name: "recurrence:count", patch: { recurrence: { count: 3 } }, kind: "invariant" },
  { name: "recurrence:until", patch: { recurrence: { until: "2026-11-18" } }, kind: "invariant" },
  { name: "recurrence:count=null", patch: { recurrence: { count: null } }, kind: "invariant" },
  { name: "recurrence:until=null", patch: { recurrence: { until: null } }, kind: "invariant" },
  {
    name: "recurrence:replace",
    patch: { recurrence: { frequency: "weekly", interval: 2, replace: true } },
    kind: "invariant",
  },
  {
    name: "summary+start",
    patch: { summary: "Оракул: смешанный патч", start: "2026-11-05T14:30:00" },
    kind: "time",
  },
];

// ---------------------------------------------------------------------------
// Области правки
// ---------------------------------------------------------------------------

export const ORACLE_SCOPES: readonly EditScope[] = ["this", "this_and_following", "all_series"];

/**
 * Роль адреса (пункт 3 задания). "none" — вызов без instanceStart: так
 * оркестрация обращается к одиночному событию и ко всей серии.
 */
export type AddressRole =
  | "none"
  | "first"
  | "middle"
  | "last"
  | "slot-override"
  | "moved-override"
  | "detached"
  | "excluded"
  | "hidden"
  | "past-end";

/** Порядок ролей — приоритет отбора, когда адресов больше предела. */
export const ADDRESS_ROLES: readonly AddressRole[] = [
  "none",
  "first",
  "slot-override",
  "moved-override",
  "detached",
  "excluded",
  "hidden",
  "past-end",
  "middle",
  "last",
];
