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
// Добавлено после разбора корпуса: серии с испорченной формой UNTIL (UNTIL в
// форме DATE при DTSTART со временем и UNTIL без Z при DTSTART с TZID), края
// значений в патчах (год 0001 и 9999, INTERVAL=1000000) и патчи, называющие
// повтор и время разом: поодиночке эти оси уже перебирались, вместе — нет.
//
// Добавлено после перепроверки: края корпуса, которых в нём не было вовсе, —
// сам ОБЪЕКТ у края года (не значение в патче, а затравка), шаг повтора чуть
// выше предела (1001 против предела 1000) и скрытый след, которого разрез
// лишает прячущего EXDATE. Прежний корпус брал у объектов только 2026 год, а
// у шага — либо единицы, либо миллион: между «проходит» и «отказывает»
// граница как раз у края, и ни один случай её не задевал.
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

/**
 * UNTIL в форме DATE при DTSTART со временем. RFC 5545 §3.3.10: форма UNTIL
 * обязана совпадать с формой DTSTART, то есть здесь нужна форма UTC. Так
 * пишут серии несколько чужих клиентов; ical.js такое правило разбирает и
 * раскрывает, а вот что с ним делает правка — и проверяется.
 */
export const untilDateFormMoscow: Seed = {
  uid: "or-until-date-form@example.com",
  about: "Пн 10:00–11:00 Europe/Moscow с 19.10.2026, UNTIL=20261116 в форме DATE при DTSTART со временем",
  ics: object(
    OTHER_HEAD,
    MOSCOW,
    vevent(
      "or-until-date-form@example.com",
      "DTSTART;TZID=Europe/Moscow:20261019T100000",
      "DTEND;TZID=Europe/Moscow:20261019T110000",
      "RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20261116",
      "SUMMARY:Серия с UNTIL в форме даты",
    ),
  ),
};

/**
 * UNTIL без Z при DTSTART с TZID. RFC 5545 §3.3.10 требует у такой серии
 * UNTIL в UTC; здесь он записан стенным временем и читается плавающим, то
 * есть конец серии смещён на величину смещения пояса.
 */
export const untilFloatingBerlin: Seed = {
  uid: "or-until-floating@example.com",
  about: "Чт 09:00–10:00 Europe/Berlin с 22.10.2026, UNTIL=20261119T090000 без Z при DTSTART с TZID",
  ics: object(
    OTHER_HEAD,
    BERLIN,
    vevent(
      "or-until-floating@example.com",
      "DTSTART;TZID=Europe/Berlin:20261022T090000",
      "DTEND;TZID=Europe/Berlin:20261022T100000",
      "RRULE:FREQ=WEEKLY;BYDAY=TH;UNTIL=20261119T090000",
      "SUMMARY:Серия с UNTIL без Z",
    ),
  ),
};

// ---------------------------------------------------------------------------
// Края корпуса: сам объект у края года и след без прячущего EXDATE
// ---------------------------------------------------------------------------

/**
 * Серия у ВЕРХНЕГО КРАЯ ГОДА: DTSTART 02.03.9999 (вторник), правило конечное
 * и целиком внутри 9999 года — три встречи, последняя 16.03.9999.
 *
 * Значение 9999 года в корпусе было только в патче (`start:9999-12-31`), а
 * сам объект всегда стоял в 2026-м. Между этими двумя случаями разница
 * существенная: патч проверяется разбором значения, а объект идёт через
 * пределы разворота, которые считаются по началу серии и шагу правила.
 *
 * Серия нарочно короткая и конечная: развернуть её нечего мешает — от первой
 * встречи до последней две недели, все три внутри одного года, за край
 * календаря (RFC 5545 §3.3.5) не уходит ни одна. Значит, ЛЮБАЯ правка на ней
 * обязана идти своим чередом: пройти или отказать по существу патча. Отказ со
 * ссылкой на длину серии или на дальний конец («не развернуть», «дальше
 * предела») здесь незаконен — это и записано в `bannedRefusals` затравки.
 *
 * Пояс взят без перевода часов (Europe/Moscow, одно STANDARD без правила):
 * VTIMEZONE с YEARLY-правилами ical.js разворачивает от 1970-го до года
 * запроса, и на 9999-м это восемь тысяч переходов на каждое чтение смещения.
 */
export const yearEdge9999: Seed = {
  uid: "or-year-edge-9999@example.com",
  about: "Вт 10:00–11:00 Europe/Moscow с 02.03.9999, COUNT=3 — конечная серия целиком внутри 9999 года",
  ics: object(
    HEAD,
    MOSCOW,
    vevent(
      "or-year-edge-9999@example.com",
      "DTSTART;TZID=Europe/Moscow:99990302T100000",
      "DTEND;TZID=Europe/Moscow:99990302T110000",
      "RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=3",
      "SUMMARY:Планёрка у края календаря",
    ),
  ),
};

/**
 * Скрытый след, которого разрез лишает прячущего EXDATE.
 *
 * Серия по вторникам из шести встреч; пятая (17.11) закрыта EXDATE, а её
 * переопределение осталось — это след прошлых правок: встречи по этому адресу
 * нет, а компонент есть. EXDATE и след стоят В ХВОСТЕ серии, и до них есть
 * ещё три слота: 20.10, 27.10 и 03.11.
 *
 * Тем и отличается от `hidden-under-exdate-moscow`, где EXDATE закрывает
 * ВТОРОЙ слот из четырёх: там граница разреза, какую ни возьми из адресов
 * затравки, приходится либо на само начало серии, либо уже после EXDATE, и
 * EXDATE со следом всегда остаются по одну сторону границы. Здесь граница
 * ложится между началом серии и EXDATE — усечение снимает EXDATE вместе с
 * хвостом правила (`truncate`, dropListValues), а сам след в продолжение не
 * переходит (роль hidden, не slot) и остаётся в усечённом объекте уже без
 * того, что его прятало: RECURRENCE-ID мимо всех слотов усечённой серии.
 *
 * Случай давний, не этого круга: разрезом хвоста серии он достаётся с самого
 * начала. Обходом он не был покрыт только потому, что в корпусе не было
 * затравки с таким расположением EXDATE.
 */
export const hiddenExdateTailMoscow: Seed = {
  uid: "or-hidden-exdate-tail@example.com",
  about:
    "Вт 15:00–16:00 Europe/Moscow с 20.10.2026, COUNT=6; 17.11 (пятый слот) закрыт EXDATE, " +
    "его переопределение осталось скрытым следом — и EXDATE, и след в хвосте серии",
  ics: object(
    HEAD,
    MOSCOW,
    vevent(
      "or-hidden-exdate-tail@example.com",
      "DTSTART;TZID=Europe/Moscow:20261020T150000",
      "DTEND;TZID=Europe/Moscow:20261020T160000",
      "RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=6",
      "EXDATE;TZID=Europe/Moscow:20261117T150000",
      "SUMMARY:Вторничная серия",
    ),
    vevent(
      "or-hidden-exdate-tail@example.com",
      "RECURRENCE-ID;TZID=Europe/Moscow:20261117T150000",
      "DTSTART;TZID=Europe/Moscow:20261117T190000",
      "DTEND;TZID=Europe/Moscow:20261117T200000",
      "SUMMARY:Вторничная серия (скрытый след под EXDATE)",
    ),
  ),
};

// ---------------------------------------------------------------------------
// Перечень затравок
// ---------------------------------------------------------------------------

/**
 * Отказ, незаконный в этом случае: правка обязана либо пройти, либо отказать
 * по другому поводу. Исход «отказ с таким кодом» обход считает нарушением
 * вида `over-strict` — отдельно от прочих, потому что чинится он там, где
 * стоит предел, а не там, где ломается запись.
 *
 * Запрет всегда ИМЕННОЙ: он называет код, а не запрещает отказ вообще. Так
 * запрет не задевает законных отказов по другому поводу — и снимается сам,
 * когда предел починен и правка отказывает (или не отказывает) по существу.
 */
export interface RefusalBan {
  /** Код отказа (`EditRefusal.code`), незаконный здесь. */
  code: string;
  /** Затравки, на которых он незаконен; без предиката — все. */
  where?: (seed: OracleSeed) => boolean;
  /** Почему правка обязана была пройти: строка попадает в findings.json. */
  why: string;
}

export interface OracleSeed extends Seed {
  /** Короткое имя для findings.json и таблиц. */
  name: string;
  /** Объект испорчен другим клиентом: в учёте отказов такие не считаются. */
  corrupted?: boolean;
  /** Отказы, незаконные на этой затравке при любой операции (в том числе delete). */
  bannedRefusals?: readonly RefusalBan[];
}

const named = (name: string, seed: Seed, corrupted = false): OracleSeed => ({ name, ...seed, corrupted });

/**
 * Отказы, незаконные у края года (затравка `year-edge-9999`). Оба кода — про
 * длину серии и про дальний конец: у серии из трёх встреч, уложившихся в две
 * недели, ни того ни другого нет. Отказ по существу патча — `invalid-time` на
 * значении за краем календаря, `invalid-scope` на повторе одной встречи,
 * `confirm-required` на потерях — запретами не задет.
 */
const HORIZON_BANS: readonly RefusalBan[] = [
  {
    code: "series-too-long",
    why:
      "серия конечная и вся внутри 9999 года: три встречи с 02.03 по 16.03, дальше края календаря " +
      "(RFC 5545 §3.3.5) не уходит ни одна. Длина серии поводом для отказа здесь быть не может.",
  },
  {
    code: "until-too-far",
    why: "конец серии задан COUNT=3 и приходится на 16.03.9999 — на второй неделе от начала, а не за пределом перебора.",
  },
];

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
  // Испорченная форма UNTIL (RFC 5545 §3.3.10). Тоже в конец и тоже без
  // пометки corrupted: правка такой серии обязана либо отказать внятно, либо
  // записать правило, которое читается обратно, — отдельных проверок для
  // этого не нужно, строгий стенд отвечает на негодную запись 400 сам.
  named("until-date-form-moscow", untilDateFormMoscow),
  named("until-floating-berlin", untilFloatingBerlin),
  // Края корпуса. Тоже в конец: порядковый номер затравки — часть зерна, от
  // которого зависит выбор адресов, и вставка в середину сдвинула бы выбор у
  // всех последующих.
  { ...named("year-edge-9999", yearEdge9999), bannedRefusals: HORIZON_BANS },
  named("hidden-exdate-tail-moscow", hiddenExdateTailMoscow),
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
  /** Отказы, незаконные у этого патча (на затравках, которые называет `where`). */
  bannedRefusals?: readonly RefusalBan[];
  note?: string;
}

/**
 * Затравки, на которых шаг повтора 1001 обязан записаться: у серии свой конец
 * (COUNT или UNTIL), и от шага число её встреч не зависит — сколько было,
 * столько и останется, а последняя при шаге в 1001 неделю приходится на XXII
 * век, задолго до края календаря.
 *
 * Перечень именной, а не выведенный признаком: он — часть ожидания, и новая
 * затравка должна попадать в него решением, а не сама собой. Чего в нём нет и
 * почему:
 * - бесконечных серий: у них конца нет вовсе, и шаг определяет, куда уйдёт
 *   вторая встреча, — отказ там законен (ради этой разницы патч и заведён);
 * - `wkst-berlin` и `bysetpos-moscow`: правку их правила Яндекс исказит (Ж6),
 *   и отказ приходит по этому поводу, а не по пределу шага;
 * - испорченных чужими клиентами (`corrupted`): у них законен любой отказ;
 * - `rdate-only-moscow`: правила у серии нет, менять шаг не у чего;
 * - `year-edge-9999`: там шаг в 1001 неделю и правда уводит вторую встречу за
 *   9999 год — единственная затравка, где предел по существу.
 */
const FINITE_RULE_SEEDS: ReadonlySet<string> = new Set([
  "weekly-count-moscow",
  "weekly-newyork",
  "until-berlin",
  "rdate-period-moscow",
  "slot-override-moscow",
  "moved-override-berlin",
  "moved-before-start-moscow",
  "hidden-under-exdate-moscow",
  "hidden-past-end-moscow",
  "detached-on-slot-date",
  "detached-at-moved-start",
  "all-day-weekly",
  "exdate-middle-berlin",
  "rich-moscow",
  "duration-master",
  "dtend-with-duration-moscow",
  "zero-length-moscow",
  "end-before-start-moscow",
  "date-start-time-end-moscow",
  "exdate-off-slot-moscow",
  "email-alarm-moscow",
  "until-date-form-moscow",
  "until-floating-berlin",
  "hidden-exdate-tail-moscow",
]);

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
  // ---------------------------------------------------------------------
  // Края значений: то же поле, но с краю допустимого
  // ---------------------------------------------------------------------
  // Прежний корпус брал у каждой оси только середину — время в 2026 году,
  // INTERVAL из одной цифры. Между серединой и краем кода нет: край
  // проходит теми же ветками, и если у них нет границы, она не видна.
  {
    name: "start:0001-01-01",
    patch: { start: "0001-01-01T00:00:00" },
    kind: "time",
    note:
      "Нижний край года по RFC 5545 §3.3.5 (DATE-TIME начинается с четырёх цифр года). Правка обязана " +
      "либо отказать, либо записать значение, которое читается обратно: 0001 — это 00010101T000000, а не 1-01-01.",
  },
  {
    name: "start:9999-12-31",
    patch: { start: "9999-12-31T23:00:00" },
    kind: "time",
    note:
      "Верхний край года. Час до полуночи взят нарочно: сохранение длительности и «весь день» переносят " +
      "конец за 9999 год, и видно, что с ним будет.",
  },
  {
    name: "recurrence:interval=1000000",
    patch: { recurrence: { interval: 1000000 } },
    kind: "invariant",
    note:
      "Край INTERVAL. Разворот такого правила уходит за пределы календаря; случай выполняется под " +
      "сторожевым временем (isolate.ts), потому что без него зависание или обвал кучи уносят весь прогон.",
  },
  {
    name: "recurrence:interval=1001",
    patch: { recurrence: { interval: 1001 } },
    kind: "invariant",
    bannedRefusals: [
      {
        code: "invalid-rule",
        where: (seed) => FINITE_RULE_SEEDS.has(seed.name),
        why:
          "у конечной серии (COUNT или UNTIL) шаг повтора числа встреч не меняет: сколько их было, столько и " +
          "останется, а последняя при шаге в 1001 неделю приходится на XXII век — до края календаря (9999 год) " +
          "остаётся почти восемь тысяч лет. Разворачивать такую серию не дольше и не дальше, чем прежнюю; " +
          "отказ по правилу здесь — предел ради предела.",
      },
    ],
    note:
      "Шаг повтора ЧУТЬ ВЫШЕ предела (1000). Прежний корпус брал у этой оси либо единицы, либо миллион — то " +
      "есть заведомо годное и заведомо негодное; сама граница не проверялась ни разу. Исхода здесь два, и они " +
      "разные: у КОНЕЧНОЙ серии правка обязана пройти (число встреч задано COUNT или UNTIL и от шага не " +
      "зависит), у БЕСКОНЕЧНОЙ отказ законен — там шаг решает, куда уйдёт вторая встреча, и при 1001 неделе " +
      "она уходит за пределы, где серию уже не проверить.",
  },
  // ---------------------------------------------------------------------
  // Сочетание осей: повтор вместе со временем
  // ---------------------------------------------------------------------
  // Прежний корпус перебирал оси поодиночке: патч называл либо recurrence,
  // либо время. Смена правила и смена времени идут в планировщике разными
  // ветками и встречаются только вместе — поодиночке это сочетание не
  // проверяется вовсе.
  {
    name: "recurrence:frequency+start+end",
    patch: { recurrence: { frequency: "daily" }, start: "2026-11-05T14:30:00", end: "2026-11-05T15:30:00" },
    kind: "invariant",
  },
  {
    name: "recurrence:frequency+timeZone",
    patch: { recurrence: { frequency: "weekly" }, timeZone: "Europe/Berlin" },
    kind: "invariant",
    note: "Смена правила вместе со сменой пояса: у правила новые позиции, у значений — новое стенное время.",
  },
  {
    name: "start+end:через полночь",
    patch: { start: "2026-11-05T23:00:00", end: "2026-11-06T01:00:00" },
    kind: "time",
    note:
      "Конец на следующие сутки после начала: у серии из патча берутся время суток и длительность (Р1), " +
      "и разница дат start и end — часть длительности, а не описка.",
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
