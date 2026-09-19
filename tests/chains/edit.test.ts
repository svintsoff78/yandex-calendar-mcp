// Цепочки правки повторяющихся встреч на изменяемом стенде — задача З05a
// плана переделки (docs/superpowers/plans/2026-09-19-recurring-events-rework.md,
// §6 и §7). Сценарии C01–C38 — из §6.2 проекта A
// (.superpowers/sdd/2026-09-18-yandex-calendar-mcp/wave-b/проект-сырое-дерево.recovered.md),
// C39–C63 — из §6 плана; поломки — из каталога
// .superpowers/sdd/2026-09-18-yandex-calendar-mcp/wave-a-results.json
// (AE — adversaryEdit, AD — adversaryDelete, R13 — review13).
//
// Цепочка — последовательность публичных вызовов updateEvent, deleteEvent,
// readEvents, readEvent (свои серии — через createEvent) на FakeCaldav из
// tests/support: что записал шаг, то следующий шаг читает с сервера.
// instanceStart и etag берутся только из выдачи readEvents.
//
// После каждого пишущего шага, пока объект жив:
// - точный видимый список readEvents;
// - инварианты О12а всех объектов стенда (строгий стенд к тому же отвергает
//   запись, добавляющую нарушение, кодом 400);
// - сохранность (assertPropsPreserved, §6 плана) через expectKept: у шага
//   названо, что он вправе менять (свойства основного компонента и
//   переопределений, снятые переопределения, сдвиг RECURRENCE-ID при сдвиге
//   или смене пояса серии), всё прочее — свойства и вложенные компоненты
//   основного VEVENT, каждого оставшегося переопределения и VTIMEZONE —
//   сверяется с состоянием до шага;
// - форма хранимого объекта, где шаг её меняет.
// Отказ сверяется по `code` и обязан ничего не записать.
//
// Цепочки помечены it.fails: на прежнем коде (dd99d80; домен
// src/domain/events.ts не менялся до З13) каждая падает на утверждении о
// порче данных. Какое утверждение падает первым и с каким сообщением —
// в строке «Прежний код» у цепочки и в отчёте З05a
// (.superpowers/sdd/2026-09-18-yandex-calendar-mcp/rework-З05a-report.md).
// Задача З13 снимает .fails, когда цепочки станут зелёными.
import { describe, expect, it } from "vitest";
import { createEvent, readEvent, readEvents, updateEvent, deleteEvent } from "../../src/domain/events.js";
import type { CalendarEvent, EditScope } from "../../src/types.js";
import { calendarA, makeStand, plant, type Stand } from "../support/context.js";
import { lineName, parseRawComponents, unfold, type RawComponent } from "../support/invariants.js";
import {
  assertPropsPreserved,
  assertStoredInvariants,
  DEFAULT_WINDOW,
  describeStand,
  formatEvent,
  visible,
  wallTime,
  type PreserveOptions,
} from "../support/observe.js";
import { weeklyMoscow, type Seed } from "../support/seeds.js";

// ---------------------------------------------------------------------------
// Стенд цепочки
// ---------------------------------------------------------------------------

const ZONE = "Europe/Moscow";

interface Chain extends Stand {
  /** Путь объекта серии на стенде. */
  path: string;
  uid: string;
}

function standWith(seed: Seed): Chain {
  const stand = makeStand();
  return { ...stand, path: plant(stand.fake, seed), uid: seed.uid };
}

/** Своя серия: объект получается настоящим createEvent, путь — из хранилища стенда. */
async function standWithCreated(input: Record<string, unknown>): Promise<Chain> {
  const stand = makeStand();
  const created = await createEvent(stand.ctx, input as unknown as Parameters<typeof createEvent>[1]);
  const found = stand.fake.findByUid(created.id);
  if (found.length !== 1) throw new Error(`createEvent: объектов с UID ${created.id} на стенде ${found.length}`);
  return { ...stand, path: found[0].path, uid: created.id };
}

/** Серия по умолчанию, созданная нашим createEvent: Пн и Ср 10:00–11:00 МСК с 19.10.2026, COUNT=6. */
const OWN_WEEKLY = {
  summary: "Планёрка",
  start: "2026-10-19T10:00:00+03:00",
  end: "2026-10-19T11:00:00+03:00",
  timeZone: ZONE,
  recurrence: { frequency: "weekly", interval: 1, byWeekday: ["MO", "WE"], count: 6 },
};

// Параметры вызовов — в новом виде (§2 плана): etag, confirm, частичный
// recurrence, участники без status. Приведение типа — чтобы файл одинаково
// запускался и на прежних, и на новых сигнатурах домена.
interface UpdateCall {
  scope?: EditScope;
  instanceStart?: string;
  patch: Record<string, unknown>;
  etag?: string;
  confirm?: boolean;
}

interface DeleteCall {
  scope?: EditScope;
  instanceStart?: string;
  etag?: string;
  confirm?: boolean;
}

function update(chain: Chain, call: UpdateCall): Promise<unknown> {
  return updateEvent(chain.ctx, { id: chain.uid, ...call } as unknown as Parameters<typeof updateEvent>[1]);
}

function remove(chain: Chain, call: DeleteCall): Promise<unknown> {
  return deleteEvent(chain.ctx, { id: chain.uid, ...call } as unknown as Parameters<typeof deleteEvent>[1]);
}

// ---------------------------------------------------------------------------
// Сообщения
// ---------------------------------------------------------------------------

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Записи клиента после отметки: метод, путь, статус и причина отказа строгого стенда. */
function writesAfter(chain: Chain, mark: number): string {
  return chain.fake
    .writes(mark)
    .map((w) => `${w.method} ${w.path} → ${w.status}${w.rejected ? ` (стенд отверг как порчу: ${w.rejected.join("; ")})` : ""}`)
    .join("; ");
}

function failure(chain: Chain, label: string, detail: string, mark?: number): Error {
  const rejected =
    mark === undefined
      ? []
      : chain.fake
          .since(mark)
          .filter((entry) => entry.rejected)
          .map((entry) => `${entry.method} ${entry.path}: ${entry.rejected!.join("; ")}`);
  const rejections = rejected.length ? `\nСтрогий стенд отверг запись как порчу данных (О12а):\n  ${rejected.join("\n  ")}` : "";
  return new Error(`${label}: ${detail}${rejections}\nСостояние стенда:\n${describeStand(chain.fake)}`);
}

// ---------------------------------------------------------------------------
// Шаги и проверки
// ---------------------------------------------------------------------------

/** Шаг цепочки, который обязан пройти. */
async function act<T>(chain: Chain, label: string, run: () => Promise<T>): Promise<T> {
  const mark = chain.fake.mark();
  try {
    return await run();
  } catch (error) {
    throw failure(chain, label, `вызов не удался: ${messageOf(error)}`, mark);
  }
}

interface Refusal {
  code?: unknown;
  needsConfirm?: unknown;
  losses?: Array<{ instanceStart?: unknown }>;
  hint?: unknown;
  message?: string;
}

type CodeCheck = readonly string[] | { test: (code: unknown) => boolean; what: string };

/**
 * Коды отказов, названные планом для других причин: адрес (Р10, AddressError
 * в §2), время (О8), аномалии и блокировки (О14, Р3), разрез (Р9) и
 * пределы (Р1, О12д). Кода legacy-override нет: ремонт следов прежнего
 * кода исключён поправкой плана. Коды отказа по устаревшему etag (Р11)
 * и по потере данных (О11, needsConfirm) план не называет; пока их
 * проверяет `refusalFor`: код — строка и ни один из этих. Когда З10 или
 * З13 назовут коды, проверки сузить до точных.
 */
const OTHER_REASONS = [
  "invalid",
  "not-found",
  "excluded",
  "actual-start",
  "ambiguous",
  "mismatch",
  "invalid-time",
  "unparsable",
  "bad-rrule",
  "no-positions",
  "multiple-masters",
  "mixed-uids",
  "unknown-tzid",
  "range-override",
  "duplicate-override",
  "empty-series",
  "series-too-long",
  "unsynced-rule",
  "until-too-far",
  "split-mismatch",
  "split-stale-continuation",
  "split-already-done",
];

function refusalFor(what: string): CodeCheck {
  return {
    test: (code) => typeof code === "string" && !OTHER_REASONS.includes(code),
    what: `${what}: код — строка и не код другой причины из OTHER_REASONS`,
  };
}

/** Шаг, который обязан кончиться отказом с кодом и ничего не записать. */
async function expectRefused(chain: Chain, label: string, run: () => Promise<unknown>, codes: CodeCheck): Promise<Refusal> {
  const mark = chain.fake.mark();
  const what = Array.isArray(codes) ? codes.join(" или ") : (codes as { what: string }).what;
  let error: unknown;
  let resolved = false;
  try {
    await run();
    resolved = true;
  } catch (caught) {
    error = caught;
  }
  const writes = writesAfter(chain, mark);
  if (resolved) {
    throw failure(chain, label, `ожидался отказ (${what}), а вызов прошёл${writes ? ` и записал: ${writes}` : ""}`, mark);
  }
  if (writes) {
    throw failure(chain, label, `отказ обязан ничего не писать, а в журнале: ${writes}; ошибка: ${messageOf(error)}`, mark);
  }
  const code = (error as Refusal | undefined)?.code;
  const ok = Array.isArray(codes) ? codes.includes(code as string) : (codes as { test: (c: unknown) => boolean }).test(code);
  if (!ok) {
    throw failure(chain, label, `ожидался отказ с кодом ${what}, а пришёл ${code === undefined ? "отказ без кода" : `код ${String(code)}`}: ${messageOf(error)}`, mark);
  }
  return error as Refusal;
}

async function expectVisible(chain: Chain, label: string, expected: string[], options: { unordered?: boolean; from?: string; to?: string } = {}): Promise<void> {
  const got = await visible(chain.ctx, { from: options.from, to: options.to });
  const [actual, wanted] = options.unordered ? [[...got].sort(), [...expected].sort()] : [got, expected];
  expect(actual, `${label}: видимый список readEvents не совпал\n${describeStand(chain.fake)}`).toEqual(wanted);
}

function expectInvariants(chain: Chain, label: string): void {
  try {
    assertStoredInvariants(chain.fake);
  } catch (error) {
    throw new Error(`${label}: ${messageOf(error)}`);
  }
}

function expectPreserved(chain: Chain, label: string, before: string, options: PreserveOptions = {}): void {
  try {
    assertPropsPreserved(before, chain.fake.ics(chain.path), options);
  } catch (error) {
    throw new Error(`${label}: ${messageOf(error)}`);
  }
}

/** Слот встречи в выдаче: стенное время instanceStart в поясе показа (у одиночной — начало). */
function slotOf(event: CalendarEvent): string {
  const address = event.instanceStart ?? event.start;
  return event.allDay ? address.slice(0, 10) : wallTime(address, ZONE);
}

/** Встреча серии по её слоту — ровно одна, из настоящей выдачи readEvents. */
async function occurrence(chain: Chain, slot: string): Promise<CalendarEvent> {
  const list = await readEvents(chain.ctx, DEFAULT_WINDOW);
  const hits = list.filter((event) => (event.id === chain.uid || event.seriesId === chain.uid) && slotOf(event) === slot);
  if (hits.length !== 1) {
    throw new Error(
      `в выдаче readEvents ${hits.length} встреч со слотом ${slot} (нужна ровно одна):\n${list.map((e) => formatEvent(e)).join("\n")}`,
    );
  }
  return hits[0];
}

// ---------------------------------------------------------------------------
// Разбор хранимого текста (независимо от src/)
// ---------------------------------------------------------------------------

interface Stored {
  masters: RawComponent[];
  overrides: RawComponent[];
  zones: string[];
}

function stored(chain: Chain): Stored {
  const root = parseRawComponents(chain.fake.ics(chain.path))[0];
  const events = root.children.filter((child) => child.name === "VEVENT");
  const has = (component: RawComponent, name: string) => component.lines.some((line) => lineName(line) === name);
  return {
    masters: events.filter((event) => !has(event, "RECURRENCE-ID")),
    overrides: events.filter((event) => has(event, "RECURRENCE-ID")),
    zones: root.children
      .filter((child) => child.name === "VTIMEZONE")
      .flatMap((zone) => zone.lines.filter((line) => lineName(line) === "TZID").map((line) => line.slice(line.indexOf(":") + 1))),
  };
}

function linesOf(component: RawComponent, name: string): string[] {
  return component.lines.filter((line) => lineName(line) === name);
}

/** Значения времени строки свойства: «TZID значение» или просто «значение», по одному на значение списка. */
function timeKeys(line: string): string[] {
  const colon = line.indexOf(":");
  const tzid = /;TZID=([^;]+)/i.exec(line.slice(0, colon))?.[1];
  return line
    .slice(colon + 1)
    .split(",")
    .map((value) => (tzid ? `${tzid} ${value}` : value));
}

/** Значения времени свойства компонента, как timeKeys. */
function timesOf(component: RawComponent, name: string): string[] {
  return linesOf(component, name).flatMap(timeKeys);
}

/** Части RRULE основного компонента: FREQ, COUNT, UNTIL… */
function ruleOf(master: RawComponent): Record<string, string> {
  const rule = linesOf(master, "RRULE")[0];
  if (!rule) return {};
  return Object.fromEntries(
    rule
      .slice(rule.indexOf(":") + 1)
      .split(";")
      .map((part) => part.split("=") as [string, string]),
  );
}

/** Один основной компонент, переопределения — ровно с такими RECURRENCE-ID. */
function expectShape(chain: Chain, label: string, rids: string[]): Stored {
  const now = stored(chain);
  const context = `\n${describeStand(chain.fake)}`;
  expect(now.masters.length, `${label}: основных компонентов (VEVENT без RECURRENCE-ID)${context}`).toBe(1);
  expect(now.overrides.flatMap((o) => timesOf(o, "RECURRENCE-ID")).sort(), `${label}: RECURRENCE-ID переопределений${context}`).toEqual(
    [...rids].sort(),
  );
  return now;
}

// ---------------------------------------------------------------------------
// Сохранность: шаг меняет только то, что называет (§6 плана, assertPropsPreserved)
// ---------------------------------------------------------------------------

/**
 * Что пишущему шагу можно менять в объекте. Всё прочее сверяется с текстом
 * до шага: свойства и вложенные компоненты основного VEVENT, каждого
 * оставшегося переопределения и VTIMEZONE (О5: VTIMEZONE только
 * добавляются). Метаданные О10 (DTSTAMP, LAST-MODIFIED, SEQUENCE)
 * assertPropsPreserved по умолчанию не сверяет, SEQUENCE проверяет C54.
 * Компоненты, которых до шага не было (новое переопределение), не
 * сверяются — их проверяют видимый список и форма объекта.
 */
interface Allowed {
  /** Свойства и вложенные компоненты основного VEVENT, которые шаг меняет. */
  master?: readonly string[];
  /** То же у переопределений. */
  overrides?: readonly string[];
  /** Переопределения, которые шаг снимает: RECURRENCE-ID как «TZID значение». */
  dropped?: readonly string[];
  /**
   * Сдвиг или смена пояса серии: RECURRENCE-ID переопределения до шага →
   * после, как «TZID значение». Новый RID — по позиции слота (Р1) и в форме
   * DTSTART (О4).
   */
  moved?: Readonly<Record<string, string>>;
}

/** Текст «до» с RECURRENCE-ID, переписанными по `moved`: так assertPropsPreserved сопоставит переопределение с новым RID. */
function remapRids(ics: string, moved: Readonly<Record<string, string>>): string {
  return unfold(ics)
    .split("\n")
    .map((line) => {
      if (lineName(line) !== "RECURRENCE-ID") return line;
      const target = moved[timeKeys(line)[0]];
      if (target === undefined) return line;
      const [tzid, value] = target.includes(" ") ? target.split(" ") : [undefined, target];
      const params = line
        .slice(0, line.indexOf(":"))
        .split(";")
        .slice(1)
        .filter((param) => !/^TZID=/i.test(param));
      return `${["RECURRENCE-ID", ...params, ...(tzid ? [`TZID=${tzid}`] : [])].join(";")}:${value}`;
    })
    .join("\n");
}

function allowedText(allowed: Allowed): string {
  const parts = [
    allowed.master?.length ? `основному компоненту — ${allowed.master.join(", ")}` : "",
    allowed.overrides?.length ? `переопределениям — ${allowed.overrides.join(", ")}` : "",
    allowed.dropped?.length ? `снять переопределения ${allowed.dropped.join(", ")}` : "",
    allowed.moved ? `сдвинуть RECURRENCE-ID ${Object.entries(allowed.moved).map(([a, b]) => `${a} → ${b}`).join(", ")}` : "",
  ].filter(Boolean);
  return parts.length ? `можно было: ${parts.join("; ")}` : "шаг не вправе был менять ничего из прежнего";
}

function expectKept(chain: Chain, label: string, before: string, allowed: Allowed = {}): void {
  const was = remapRids(before, allowed.moved ?? {});
  const now = chain.fake.ics(chain.path);
  const rid = (component: RawComponent) => timesOf(component, "RECURRENCE-ID")[0];
  const dropped = new Set(allowed.dropped ?? []);
  const parts: Array<[string, (component: RawComponent) => boolean, readonly string[]]> = [
    ["основной компонент", (c) => c.name === "VEVENT" && rid(c) === undefined, allowed.master ?? []],
    ["переопределения", (c) => c.name === "VEVENT" && rid(c) !== undefined && !dropped.has(rid(c)), allowed.overrides ?? []],
    ["прочие компоненты", (c) => c.name !== "VEVENT", []],
  ];
  const problems: string[] = [];
  for (const [what, scope, except] of parts) {
    try {
      assertPropsPreserved(was, now, { scope, except: [...except] });
    } catch (error) {
      problems.push(`${what}: ${messageOf(error)}`);
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `${label}: шаг тронул то, чего не называл (${allowedText(allowed)}):\n${problems.join("\n")}\nСостояние стенда:\n${describeStand(chain.fake)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Затравки чужих объектов (текст целиком здесь, чтобы не зависеть от правок seeds.ts)
// ---------------------------------------------------------------------------

const CRLF = "\r\n";
const MOSCOW_TZ = [
  "BEGIN:VTIMEZONE",
  "TZID:Europe/Moscow",
  "BEGIN:STANDARD",
  "TZNAME:MSK",
  "TZOFFSETFROM:+0300",
  "TZOFFSETTO:+0300",
  "DTSTART:19700101T000000",
  "END:STANDARD",
  "END:VTIMEZONE",
];
const YANDEX_PRODID = "-//Yandex LLC//Yandex Calendar//EN";
const YANDEX_TAIL = ["CREATED:20261001T090000Z", "LAST-MODIFIED:20261001T090000Z", "TRANSP:OPAQUE", "CLASS:PUBLIC"];

/** Объект с поясом Europe/Moscow; каждый VEVENT получает UID и DTSTAMP. */
function seedOf(uid: string, about: string, prodid: string, ...events: string[][]): Seed {
  const lines = [
    "BEGIN:VCALENDAR",
    `PRODID:${prodid}`,
    "VERSION:2.0",
    "CALSCALE:GREGORIAN",
    ...MOSCOW_TZ,
    ...events.flatMap((event) => ["BEGIN:VEVENT", `UID:${uid}`, "DTSTAMP:20261001T090000Z", ...event, "END:VEVENT"]),
    "END:VCALENDAR",
  ];
  return { uid, about, ics: lines.join(CRLF) + CRLF };
}

const moscow = (wall: string) => `TZID=Europe/Moscow:${wall}`;

/** C04: переопределение 21.10 (перенос на 11:30) стоит в объекте раньше основного компонента. */
const overrideFirst = seedOf(
  "c04f1r5tover@yandex.ru",
  "Пн и Ср 10:00 МСК, COUNT=6; перенос 21.10 на 11:30 записан первым VEVENT (другой клиент)",
  YANDEX_PRODID,
  [
    `RECURRENCE-ID;${moscow("20261021T100000")}`,
    `DTSTART;${moscow("20261021T113000")}`,
    `DTEND;${moscow("20261021T123000")}`,
    "SUMMARY:Планёрка",
    "SEQUENCE:1",
    ...YANDEX_TAIL,
  ],
  [
    `DTSTART;${moscow("20261019T100000")}`,
    `DTEND;${moscow("20261019T110000")}`,
    "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6",
    "SUMMARY:Планёрка",
    "SEQUENCE:0",
    ...YANDEX_TAIL,
  ],
);

/** C39: ежедневно 10:00–11:00 МСК с 19.10.2026, COUNT=10. */
const dailyMoscow = seedOf("c39daily10x@yandex.ru", "Ежедневно 10:00–11:00 МСК с 19.10.2026, COUNT=10", YANDEX_PRODID, [
  `DTSTART;${moscow("20261019T100000")}`,
  `DTEND;${moscow("20261019T110000")}`,
  "RRULE:FREQ=DAILY;COUNT=10",
  "SUMMARY:Планёрка",
  "SEQUENCE:0",
  ...YANDEX_TAIL,
]);

/** C43: раз в две недели, Пн и Ср 10:00–11:00 МСК с 19.10.2026, COUNT=6. */
const biweeklyMoscow = seedOf("c43interval2@yandex.ru", "Пн и Ср раз в две недели 10:00 МСК, INTERVAL=2, COUNT=6", YANDEX_PRODID, [
  `DTSTART;${moscow("20261019T100000")}`,
  `DTEND;${moscow("20261019T110000")}`,
  "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=6",
  "SUMMARY:Планёрка",
  "SEQUENCE:0",
  ...YANDEX_TAIL,
]);

/** C44, C45: своя встреча с участниками (CN, ROLE, ответы) и двумя напоминаниями, одно — AUDIO. */
const teamMoscow = seedOf("c44team0001@yandex.ru", "Пн и Ср 10:00 МСК, COUNT=6; организатор — владелец, два участника, VALARM AUDIO и DISPLAY", YANDEX_PRODID, [
  `DTSTART;${moscow("20261019T100000")}`,
  `DTEND;${moscow("20261019T110000")}`,
  "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6",
  "SUMMARY:Планёрка",
  "ORGANIZER;CN=Ян Свинцов:mailto:user@yandex.ru",
  "ATTENDEE;CN=Пётр Петров;PARTSTAT=ACCEPTED;ROLE=REQ-PARTICIPANT:mailto:petrov@example.com",
  "ATTENDEE;CN=Мария Иванова;PARTSTAT=DECLINED;ROLE=OPT-PARTICIPANT:mailto:ivanova@example.com",
  "SEQUENCE:0",
  ...YANDEX_TAIL,
  "BEGIN:VALARM",
  "ACTION:AUDIO",
  "TRIGGER:-PT10M",
  "END:VALARM",
  "BEGIN:VALARM",
  "ACTION:DISPLAY",
  "DESCRIPTION:Напоминание",
  "TRIGGER:-PT15M",
  "END:VALARM",
]);

/** C54: чужая встреча — ORGANIZER не владелец, SEQUENCE:2. */
const foreignOrganizer = seedOf("c54foreign02@yandex.ru", "Пн и Ср 10:00 МСК, COUNT=6; организатор — другой человек, SEQUENCE:2", YANDEX_PRODID, [
  `DTSTART;${moscow("20261019T100000")}`,
  `DTEND;${moscow("20261019T110000")}`,
  "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6",
  "SUMMARY:Планёрка",
  'ORGANIZER;CN="Анна Смирнова":mailto:anna@example.com',
  "ATTENDEE;CN=Ян Свинцов;PARTSTAT=ACCEPTED;ROLE=REQ-PARTICIPANT:mailto:user@yandex.ru",
  "SEQUENCE:2",
  ...YANDEX_TAIL,
]);

/** C54: объект другого клиента без SEQUENCE и без ORGANIZER. */
const noSequence = seedOf("c54noseq0001@example.com", "Пн и Ср 10:00 МСК, COUNT=6; без SEQUENCE (другой клиент)", "-//Example Corp.//Other Client//EN", [
  `DTSTART;${moscow("20261019T100000")}`,
  `DTEND;${moscow("20261019T110000")}`,
  "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6",
  "SUMMARY:Планёрка",
]);

/** C58: по понедельникам 10:00 МСК с 19.10.2026 до 30.10.2028 включительно (UNTIL — 10:00 МСК в UTC). */
const untilMoscow = seedOf("c58until2028@yandex.ru", "Пн 10:00–11:00 МСК с 19.10.2026, UNTIL=20281030T070000Z (последняя — 30.10.2028)", YANDEX_PRODID, [
  `DTSTART;${moscow("20261019T100000")}`,
  `DTEND;${moscow("20261019T110000")}`,
  "RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20281030T070000Z",
  "SUMMARY:Планёрка",
  "SEQUENCE:0",
  ...YANDEX_TAIL,
]);

// ---------------------------------------------------------------------------
// Ожидаемые строки
// ---------------------------------------------------------------------------

/** Даты серии по умолчанию: Пн и Ср с 19.10.2026, COUNT=6. */
const DATES = ["2026-10-19", "2026-10-21", "2026-10-26", "2026-10-28", "2026-11-02", "2026-11-04"];

/**
 * Шесть строк серии по умолчанию в формате visible(): text — «Имя» или
 * «Имя @Место»; replace заменяет строку даты (null — даты нет в выдаче).
 */
function rows(text: string, replace: Record<string, string | null> = {}, time = "10:00–11:00", dates = DATES): string[] {
  return dates.flatMap((date) => (date in replace ? (replace[date] === null ? [] : [replace[date] as string]) : [`${date} ${time} ${text}`]));
}

/** Понедельники с from по to включительно (даты UTC-календаря, без пояса процесса). */
function mondays(from: string, to: string): string[] {
  const ms = (date: string) => Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
  const out: string[] = [];
  for (let t = ms(from); t <= ms(to); t += 7 * 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

// ---------------------------------------------------------------------------
// Цепочки
// ---------------------------------------------------------------------------

describe("Цепочки правки (З05a)", () => {
  // Поломки: AE17 (all_series не доходит до перенесённой), R13-N1 и R13-F1
  // (replaceMaster ставит основной компонент последним, следующая правка
  // берёт переопределение за серию и даёт два основных).
  // Прежний код: падает на шаге 2 — 21.10 осталась «Планёрка» (AE17).
  it.fails("C01: перенос 21.10 → вся серия: имя → вся серия: место — перенос на месте и наследует имя и место", async () => {
    const chain = standWith(weeklyMoscow);
    const initial = chain.fake.ics(chain.path);

    const slot21 = await occurrence(chain, "2026-10-21 10:00");
    await act(chain, "C01 шаг 1 (перенос 21.10 на 11:30)", () =>
      update(chain, {
        scope: "this",
        instanceStart: slot21.instanceStart,
        patch: { start: "2026-10-21T11:30:00+03:00", end: "2026-10-21T12:30:00+03:00" },
      }),
    );
    await expectVisible(chain, "C01 шаг 1", rows("Планёрка", { "2026-10-21": "2026-10-21 11:30–12:30 Планёрка [слот 2026-10-21 10:00]" }));
    expectInvariants(chain, "C01 шаг 1");
    expectKept(chain, "C01 шаг 1", initial);
    expectShape(chain, "C01 шаг 1", ["Europe/Moscow 20261021T100000"]);

    const afterMove = chain.fake.ics(chain.path);
    await act(chain, "C01 шаг 2 (вся серия: имя)", () => update(chain, { scope: "all_series", patch: { summary: "Планёрка команды" } }));
    await expectVisible(
      chain,
      "C01 шаг 2",
      rows("Планёрка команды", { "2026-10-21": "2026-10-21 11:30–12:30 Планёрка команды [слот 2026-10-21 10:00]" }),
    );
    expectInvariants(chain, "C01 шаг 2");
    expectPreserved(chain, "C01 шаг 2", afterMove, { except: ["SUMMARY"] });
    expectShape(chain, "C01 шаг 2", ["Europe/Moscow 20261021T100000"]);

    const afterRename = chain.fake.ics(chain.path);
    await act(chain, "C01 шаг 3 (вся серия: место)", () => update(chain, { scope: "all_series", patch: { location: "Переговорная 5" } }));
    await expectVisible(
      chain,
      "C01 шаг 3",
      rows("Планёрка команды @Переговорная 5", {
        "2026-10-21": "2026-10-21 11:30–12:30 Планёрка команды @Переговорная 5 [слот 2026-10-21 10:00]",
      }),
    );
    expectInvariants(chain, "C01 шаг 3");
    expectPreserved(chain, "C01 шаг 3", afterRename, { except: ["LOCATION"] });
    expectShape(chain, "C01 шаг 3", ["Europe/Moscow 20261021T100000"]);
  });

  // Поломки: AD1, R13-N1 — после all_series переопределение стоит первым,
  // и delete this или this_and_following удаляет ВСЮ серию DELETE'ом.
  // Прежний код: падает на шаге 3 — видимый список пуст, объект удалён.
  it.fails("C02: своё место 21.10 → вся серия: место → удаление 04.11 или хвоста с 02.11 — удалено ровно названное", async () => {
    for (const tail of [false, true]) {
      const chain = await standWithCreated(OWN_WEEKLY);
      const label = tail ? "C02 (хвост)" : "C02 (экземпляр)";

      const created = chain.fake.ics(chain.path);
      const slot21 = await occurrence(chain, "2026-10-21 10:00");
      await act(chain, `${label} шаг 1 (21.10: место)`, () =>
        update(chain, { scope: "this", instanceStart: slot21.instanceStart, patch: { location: "Кабинет 3" } }),
      );
      await expectVisible(chain, `${label} шаг 1`, rows("Планёрка", { "2026-10-21": "2026-10-21 10:00–11:00 Планёрка @Кабинет 3" }));
      expectInvariants(chain, `${label} шаг 1`);
      expectKept(chain, `${label} шаг 1`, created);
      expectShape(chain, `${label} шаг 1`, ["Europe/Moscow 20261021T100000"]);

      const afterOverride = chain.fake.ics(chain.path);
      await act(chain, `${label} шаг 2 (вся серия: место)`, () =>
        update(chain, { scope: "all_series", patch: { location: "Переговорная 5" } }),
      );
      // Место переопределения не совпадало с местом серии — оно своё и остаётся (О7).
      await expectVisible(
        chain,
        `${label} шаг 2`,
        rows("Планёрка @Переговорная 5", { "2026-10-21": "2026-10-21 10:00–11:00 Планёрка @Кабинет 3" }),
      );
      expectInvariants(chain, `${label} шаг 2`);
      expectKept(chain, `${label} шаг 2`, afterOverride, { master: ["LOCATION"] });
      expectShape(chain, `${label} шаг 2`, ["Europe/Moscow 20261021T100000"]);

      const afterSeries = chain.fake.ics(chain.path);
      const target = await occurrence(chain, tail ? "2026-11-02 10:00" : "2026-11-04 10:00");
      await act(chain, `${label} шаг 3 (удаление)`, () =>
        remove(chain, { scope: tail ? "this_and_following" : "this", instanceStart: target.instanceStart, etag: target.etag }),
      );
      expect(chain.fake.has(chain.path), `${label} шаг 3: объект серии обязан остаться на сервере`).toBe(true);
      await expectVisible(
        chain,
        `${label} шаг 3`,
        rows(
          "Планёрка @Переговорная 5",
          tail
            ? { "2026-10-21": "2026-10-21 10:00–11:00 Планёрка @Кабинет 3", "2026-11-02": null, "2026-11-04": null }
            : { "2026-10-21": "2026-10-21 10:00–11:00 Планёрка @Кабинет 3", "2026-11-04": null },
        ),
      );
      expectInvariants(chain, `${label} шаг 3`);
      // delete this ставит EXDATE; усечение меняет конец правила (EXDATE ≥ границы
      // в этой серии нет). Переопределение 21.10 раньше границы цело.
      expectKept(chain, `${label} шаг 3`, afterSeries, { master: tail ? ["RRULE"] : ["EXDATE"] });
      expectShape(chain, `${label} шаг 3`, ["Europe/Moscow 20261021T100000"]);
    }
  });

  // Поломки: AD4, R13-N1 (S4) — после this → all_series следующая правка
  // this другого экземпляра принимает переопределение 21.10 за одиночное
  // событие, стирает его и дописывает второй основной компонент.
  // Прежний код: падает на шаге 3 — строгий стенд отвергает PUT (multiple-masters).
  it("C03: имя 21.10 → вся серия: имя → имя 26.10 — обе правки видны, основной компонент один", async () => {
    const chain = await standWithCreated(OWN_WEEKLY);

    const created = chain.fake.ics(chain.path);
    const slot21 = await occurrence(chain, "2026-10-21 10:00");
    await act(chain, "C03 шаг 1 (21.10: имя)", () =>
      update(chain, { scope: "this", instanceStart: slot21.instanceStart, patch: { summary: "С заказчиком" } }),
    );
    await expectVisible(chain, "C03 шаг 1", rows("Планёрка", { "2026-10-21": "2026-10-21 10:00–11:00 С заказчиком" }));
    expectInvariants(chain, "C03 шаг 1");
    expectKept(chain, "C03 шаг 1", created);
    expectShape(chain, "C03 шаг 1", ["Europe/Moscow 20261021T100000"]);

    const afterOverride = chain.fake.ics(chain.path);
    await act(chain, "C03 шаг 2 (вся серия: имя)", () => update(chain, { scope: "all_series", patch: { summary: "Планёрка отдела" } }));
    // Имя переопределения своё («С заказчиком» ≠ «Планёрка») — не наследуется (О7).
    await expectVisible(chain, "C03 шаг 2", rows("Планёрка отдела", { "2026-10-21": "2026-10-21 10:00–11:00 С заказчиком" }));
    expectInvariants(chain, "C03 шаг 2");
    expectKept(chain, "C03 шаг 2", afterOverride, { master: ["SUMMARY"] });
    expectShape(chain, "C03 шаг 2", ["Europe/Moscow 20261021T100000"]);

    const afterSeries = chain.fake.ics(chain.path);
    const slot26 = await occurrence(chain, "2026-10-26 10:00");
    await act(chain, "C03 шаг 3 (26.10: имя)", () =>
      update(chain, { scope: "this", instanceStart: slot26.instanceStart, patch: { summary: "Короткая" } }),
    );
    await expectVisible(
      chain,
      "C03 шаг 3",
      rows("Планёрка отдела", {
        "2026-10-21": "2026-10-21 10:00–11:00 С заказчиком",
        "2026-10-26": "2026-10-26 10:00–11:00 Короткая",
      }),
    );
    expectInvariants(chain, "C03 шаг 3");
    expectPreserved(chain, "C03 шаг 3", afterSeries);
    expectShape(chain, "C03 шаг 3", ["Europe/Moscow 20261021T100000", "Europe/Moscow 20261026T100000"]);
  });

  // Поломки: AE4, AD1, R13-O2 — основной компонент — первый VEVENT: get_event
  // отдаёт переопределение, правка и удаление принимают серию за одиночное
  // событие. Та же цепочка есть в foreign.test.ts (З05c): план §7 называет
  // C04 в обоих файлах, здесь упор на правку.
  // Прежний код: падает на шаге 0 — readEvent отдаёт переопределение 21.10.
  it.fails("C04: чужой объект с переопределением первым: get_event, this, all_series, delete this, delete хвоста", async () => {
    const chain = standWith(overrideFirst);
    const initial = chain.fake.ics(chain.path);

    const event = await act(chain, "C04 шаг 0 (get_event)", () => readEvent(chain.ctx, calendarA.id, chain.uid));
    expect(
      { summary: event.summary, start: wallTime(event.start, ZONE), frequency: event.recurrence?.frequency },
      `C04 шаг 0: get_event обязан отдать основной компонент серии, а не переопределение\n${describeStand(chain.fake)}`,
    ).toEqual({ summary: "Планёрка", start: "2026-10-19 10:00", frequency: "weekly" });
    await expectVisible(chain, "C04 шаг 0", rows("Планёрка", { "2026-10-21": "2026-10-21 11:30–12:30 Планёрка [слот 2026-10-21 10:00]" }));

    const slot26 = await occurrence(chain, "2026-10-26 10:00");
    await act(chain, "C04 шаг 1 (26.10: имя)", () =>
      update(chain, { scope: "this", instanceStart: slot26.instanceStart, patch: { summary: "Только 26-е" } }),
    );
    await expectVisible(
      chain,
      "C04 шаг 1",
      rows("Планёрка", {
        "2026-10-21": "2026-10-21 11:30–12:30 Планёрка [слот 2026-10-21 10:00]",
        "2026-10-26": "2026-10-26 10:00–11:00 Только 26-е",
      }),
    );
    expectInvariants(chain, "C04 шаг 1");
    expectPreserved(chain, "C04 шаг 1", initial);
    expectShape(chain, "C04 шаг 1", ["Europe/Moscow 20261021T100000", "Europe/Moscow 20261026T100000"]);

    const afterThis = chain.fake.ics(chain.path);
    await act(chain, "C04 шаг 2 (вся серия: имя)", () => update(chain, { scope: "all_series", patch: { summary: "Планёрка отдела" } }));
    await expectVisible(
      chain,
      "C04 шаг 2",
      rows("Планёрка отдела", {
        "2026-10-21": "2026-10-21 11:30–12:30 Планёрка отдела [слот 2026-10-21 10:00]",
        "2026-10-26": "2026-10-26 10:00–11:00 Только 26-е",
      }),
    );
    expectInvariants(chain, "C04 шаг 2");
    expectPreserved(chain, "C04 шаг 2", afterThis, { except: ["SUMMARY"] });
    expectShape(chain, "C04 шаг 2", ["Europe/Moscow 20261021T100000", "Europe/Moscow 20261026T100000"]);

    const afterSeries = chain.fake.ics(chain.path);
    const again26 = await occurrence(chain, "2026-10-26 10:00");
    await act(chain, "C04 шаг 3 (удаление 26.10)", () =>
      remove(chain, { scope: "this", instanceStart: again26.instanceStart, etag: again26.etag }),
    );
    await expectVisible(
      chain,
      "C04 шаг 3",
      rows("Планёрка отдела", { "2026-10-21": "2026-10-21 11:30–12:30 Планёрка отдела [слот 2026-10-21 10:00]", "2026-10-26": null }),
    );
    expectInvariants(chain, "C04 шаг 3");
    // Снимается переопределение 26.10 целиком, основному — только EXDATE;
    // перенос 21.10, стоящий в объекте первым, цел.
    expectKept(chain, "C04 шаг 3", afterSeries, { master: ["EXDATE"], dropped: ["Europe/Moscow 20261026T100000"] });
    const afterDelete = expectShape(chain, "C04 шаг 3", ["Europe/Moscow 20261021T100000"]);
    expect(timesOf(afterDelete.masters[0], "EXDATE"), "C04 шаг 3: EXDATE ровно на слот 26.10").toEqual(["Europe/Moscow 20261026T100000"]);

    const afterSlot = chain.fake.ics(chain.path);
    const slot02 = await occurrence(chain, "2026-11-02 10:00");
    await act(chain, "C04 шаг 4 (удаление хвоста с 02.11)", () =>
      remove(chain, { scope: "this_and_following", instanceStart: slot02.instanceStart, etag: slot02.etag }),
    );
    await expectVisible(
      chain,
      "C04 шаг 4",
      rows("Планёрка отдела", {
        "2026-10-21": "2026-10-21 11:30–12:30 Планёрка отдела [слот 2026-10-21 10:00]",
        "2026-10-26": null,
        "2026-11-02": null,
        "2026-11-04": null,
      }),
    );
    expect(chain.fake.has(chain.path), "C04 шаг 4: объект серии обязан остаться на сервере").toBe(true);
    expectInvariants(chain, "C04 шаг 4");
    // Усечение меняет только конец правила: EXDATE 26.10 и перенос 21.10
    // раньше границы целы.
    expectKept(chain, "C04 шаг 4", afterSlot, { master: ["RRULE"] });
    const afterTail = expectShape(chain, "C04 шаг 4", ["Europe/Moscow 20261021T100000"]);
    // COUNT — по позициям правила до границы: 19, 21, 26, 28 (EXDATE не влияет).
    expect(ruleOf(afterTail.masters[0]).COUNT, "C04 шаг 4: COUNT усечённой серии").toBe("4");
  });

  // Поломки: AE8, R13-N2 — вторая правка того же экземпляра собирает
  // переопределение заново из основного компонента, прошлая правка теряется.
  // Прежний код: падает на шаге 2 — 21.10 стала «Планёрка @Офис», имя «Особая» потеряно.
  it.fails("C05: имя 21.10 → место 21.10 — оба поля сохранены, переопределение одно", async () => {
    const chain = standWith(weeklyMoscow);

    const initial = chain.fake.ics(chain.path);
    const slot21 = await occurrence(chain, "2026-10-21 10:00");
    await act(chain, "C05 шаг 1 (21.10: имя)", () =>
      update(chain, { scope: "this", instanceStart: slot21.instanceStart, patch: { summary: "Особая" } }),
    );
    await expectVisible(chain, "C05 шаг 1", rows("Планёрка", { "2026-10-21": "2026-10-21 10:00–11:00 Особая" }));
    expectInvariants(chain, "C05 шаг 1");
    expectKept(chain, "C05 шаг 1", initial);
    expectShape(chain, "C05 шаг 1", ["Europe/Moscow 20261021T100000"]);

    const afterFirst = chain.fake.ics(chain.path);
    const again21 = await occurrence(chain, "2026-10-21 10:00");
    await act(chain, "C05 шаг 2 (21.10: место)", () =>
      update(chain, { scope: "this", instanceStart: again21.instanceStart, patch: { location: "Офис" } }),
    );
    await expectVisible(chain, "C05 шаг 2", rows("Планёрка", { "2026-10-21": "2026-10-21 10:00–11:00 Особая @Офис" }));
    expectInvariants(chain, "C05 шаг 2");
    expectKept(chain, "C05 шаг 2", afterFirst, { overrides: ["LOCATION"] });
    expectShape(chain, "C05 шаг 2", ["Europe/Moscow 20261021T100000"]);
  });

  // Поломки: AE12, R13-N4 — правка по фактическому времени перенесённой
  // создаёт переопределение-сироту, а по instanceStart из выдачи перенесённую
  // править нельзя.
  // Правка по фактическому времени идёт раньше правки по слоту: на прежнем
  // коде она показывает саму порчу (запись сироты), а правка по слоту падает
  // раньше порчи — на отказе прежней проверки адреса. Отказ ничего не
  // меняет, так что порядок шагов на итог не влияет.
  // Прежний код: падает на шаге 2 — вместо отказа actual-start PUT с
  // переопределением-сиротой, отвергнутый строгим стендом (orphan-override).
  it.fails("C06: перенос 21.10 → правка по фактическому времени — actual-start → правка по слоту из выдачи", async () => {
    const chain = standWith(weeklyMoscow);
    const moved21 = "2026-10-21 11:30–12:30 Планёрка [слот 2026-10-21 10:00]";

    const initial = chain.fake.ics(chain.path);
    const slot21 = await occurrence(chain, "2026-10-21 10:00");
    await act(chain, "C06 шаг 1 (перенос 21.10 на 11:30)", () =>
      update(chain, {
        scope: "this",
        instanceStart: slot21.instanceStart,
        patch: { start: "2026-10-21T11:30:00+03:00", end: "2026-10-21T12:30:00+03:00" },
      }),
    );
    await expectVisible(chain, "C06 шаг 1", rows("Планёрка", { "2026-10-21": moved21 }));
    expectInvariants(chain, "C06 шаг 1");
    expectKept(chain, "C06 шаг 1", initial);
    expectShape(chain, "C06 шаг 1", ["Europe/Moscow 20261021T100000"]);

    const shown = await occurrence(chain, "2026-10-21 10:00");
    const refusal = await expectRefused(
      chain,
      "C06 шаг 2 (правка по фактическому времени 11:30)",
      () => update(chain, { scope: "this", instanceStart: shown.start, patch: { summary: "Мимо слота" } }),
      ["actual-start"],
    );
    expect(
      `${String(refusal.hint ?? "")} ${refusal.message ?? ""}`,
      "C06 шаг 2: подсказка называет адрес перенесённой встречи (её слот)",
    ).toContain("2026-10-21T10:00");
    await expectVisible(chain, "C06 шаг 2", rows("Планёрка", { "2026-10-21": moved21 }));

    const afterMove = chain.fake.ics(chain.path);
    await act(chain, "C06 шаг 3 (правка перенесённой по её instanceStart)", () =>
      update(chain, { scope: "this", instanceStart: shown.instanceStart, patch: { summary: "Перенесённая" } }),
    );
    await expectVisible(
      chain,
      "C06 шаг 3",
      rows("Планёрка", { "2026-10-21": "2026-10-21 11:30–12:30 Перенесённая [слот 2026-10-21 10:00]" }),
    );
    expectInvariants(chain, "C06 шаг 3");
    expectKept(chain, "C06 шаг 3", afterMove, { overrides: ["SUMMARY"] });
    // RECURRENCE-ID неизменен: правка легла на то же переопределение.
    expectShape(chain, "C06 шаг 3", ["Europe/Moscow 20261021T100000"]);
  });

  // Поломка: AE16 — start без end: конец берётся от исходного слота, DTEND < DTSTART.
  // Прежний код: падает на шаге 1 — строгий стенд отвергает PUT (end-not-after-start).
  it.fails("C22: start без end у экземпляра и у серии — длительность сохранена; конец не позже начала — invalid-time", async () => {
    const chain = standWith(weeklyMoscow);

    const initial = chain.fake.ics(chain.path);
    const slot21 = await occurrence(chain, "2026-10-21 10:00");
    await act(chain, "C22 шаг 1 (21.10: start 15:00 без end)", () =>
      update(chain, { scope: "this", instanceStart: slot21.instanceStart, patch: { start: "2026-10-21T15:00:00+03:00" } }),
    );
    await expectVisible(chain, "C22 шаг 1", rows("Планёрка", { "2026-10-21": "2026-10-21 15:00–16:00 Планёрка [слот 2026-10-21 10:00]" }));
    expectInvariants(chain, "C22 шаг 1");
    expectKept(chain, "C22 шаг 1", initial);
    expectShape(chain, "C22 шаг 1", ["Europe/Moscow 20261021T100000"]);

    const afterMove = chain.fake.ics(chain.path);
    await act(chain, "C22 шаг 2 (вся серия: start 12:00 без end)", () =>
      update(chain, { scope: "all_series", patch: { start: "2026-10-19T12:00:00+03:00" } }),
    );
    // Р1: дата DTSTART прежняя, время суток новое, длительность сохранена;
    // перенесённая остаётся в 15:00, её слот сдвинут по позиции.
    await expectVisible(
      chain,
      "C22 шаг 2",
      rows("Планёрка", { "2026-10-21": "2026-10-21 15:00–16:00 Планёрка [слот 2026-10-21 12:00]" }, "12:00–13:00"),
    );
    expectInvariants(chain, "C22 шаг 2");
    // Основному — только время (COUNT и прочее правило целы); у перенесённой
    // меняется лишь RECURRENCE-ID, её 15:00–16:00 и всё прочее целы (О7).
    expectKept(chain, "C22 шаг 2", afterMove, {
      master: ["DTSTART", "DTEND"],
      moved: { "Europe/Moscow 20261021T100000": "Europe/Moscow 20261021T120000" },
    });
    expectShape(chain, "C22 шаг 2", ["Europe/Moscow 20261021T120000"]);

    const slot26 = await occurrence(chain, "2026-10-26 12:00");
    await expectRefused(
      chain,
      "C22 шаг 3 (26.10: end раньше start)",
      () =>
        update(chain, {
          scope: "this",
          instanceStart: slot26.instanceStart,
          patch: { start: "2026-10-26T13:00:00+03:00", end: "2026-10-26T12:30:00+03:00" },
        }),
      ["invalid-time"],
    );
    await expectRefused(
      chain,
      "C22 шаг 4 (вся серия: end раньше начала серии)",
      () => update(chain, { scope: "all_series", patch: { end: "2026-10-19T11:30:00+03:00" } }),
      ["invalid-time"],
    );
    await expectVisible(
      chain,
      "C22 шаг 4",
      rows("Планёрка", { "2026-10-21": "2026-10-21 15:00–16:00 Планёрка [слот 2026-10-21 12:00]" }, "12:00–13:00"),
    );
  });

  // Поломки: AE11, R13-N7 (replaceMaster удаляет все VTIMEZONE, на
  // которые ссылаются переопределения), AE19 (this с timeZone без VTIMEZONE).
  // Прежний код: падает на шаге 2 — строгий стенд отвергает PUT (missing-vtimezone).
  it.fails("C23: имя 21.10 → вся серия в Asia/Yekaterinburg → 26.10 в Asia/Novosibirsk — VTIMEZONE на каждый пояс, 21.10 одна", async () => {
    const chain = standWith(weeklyMoscow);

    const initial = chain.fake.ics(chain.path);
    const slot21 = await occurrence(chain, "2026-10-21 10:00");
    await act(chain, "C23 шаг 1 (21.10: имя)", () =>
      update(chain, { scope: "this", instanceStart: slot21.instanceStart, patch: { summary: "Особая" } }),
    );
    await expectVisible(chain, "C23 шаг 1", rows("Планёрка", { "2026-10-21": "2026-10-21 10:00–11:00 Особая" }));
    expectInvariants(chain, "C23 шаг 1");
    expectKept(chain, "C23 шаг 1", initial);
    expectShape(chain, "C23 шаг 1", ["Europe/Moscow 20261021T100000"]);

    const afterName = chain.fake.ics(chain.path);
    await act(chain, "C23 шаг 2 (вся серия: пояс Екатеринбурга)", () =>
      update(chain, { scope: "all_series", patch: { timeZone: "Asia/Yekaterinburg" } }),
    );
    // О8: timeZone без start сохраняет моменты — в МСК всё на прежних местах.
    await expectVisible(chain, "C23 шаг 2", rows("Планёрка", { "2026-10-21": "2026-10-21 10:00–11:00 Особая" }));
    expectInvariants(chain, "C23 шаг 2");
    // Основному — DTSTART и DTEND в новом поясе; неперенесённое переопределение
    // 21.10 идёт за серией (О7), его RECURRENCE-ID — в форме DTSTART (О4):
    // тот же момент 10:00 МСК = 12:00 Екатеринбурга. Имя «Особая», прочие
    // свойства и VTIMEZONE Europe/Moscow целы (О5).
    expectKept(chain, "C23 шаг 2", afterName, {
      master: ["DTSTART", "DTEND"],
      overrides: ["DTSTART", "DTEND"],
      moved: { "Europe/Moscow 20261021T100000": "Asia/Yekaterinburg 20261021T120000" },
    });
    const afterZone = stored(chain);
    expect(afterZone.masters.length, "C23 шаг 2: основной компонент один").toBe(1);
    expect(afterZone.overrides.length, "C23 шаг 2: переопределение 21.10 одно").toBe(1);
    expect(timesOf(afterZone.masters[0], "DTSTART"), "C23 шаг 2: DTSTART в новом поясе, тот же момент").toEqual([
      "Asia/Yekaterinburg 20261019T120000",
    ]);
    expect([...afterZone.zones].sort(), "C23 шаг 2: VTIMEZONE только добавляются (О5)").toEqual(["Asia/Yekaterinburg", "Europe/Moscow"]);

    const zoneText = chain.fake.ics(chain.path);
    const slot26 = await occurrence(chain, "2026-10-26 10:00");
    await act(chain, "C23 шаг 3 (26.10: пояс Новосибирска и имя)", () =>
      update(chain, {
        scope: "this",
        instanceStart: slot26.instanceStart,
        patch: { timeZone: "Asia/Novosibirsk", summary: "Из Новосибирска" },
      }),
    );
    await expectVisible(
      chain,
      "C23 шаг 3",
      rows("Планёрка", { "2026-10-21": "2026-10-21 10:00–11:00 Особая", "2026-10-26": "2026-10-26 10:00–11:00 Из Новосибирска" }),
    );
    expectInvariants(chain, "C23 шаг 3");
    // Правка одной встречи: основной, переопределение 21.10 и оба VTIMEZONE целы.
    expectKept(chain, "C23 шаг 3", zoneText);
    const afterThis = stored(chain);
    expect(afterThis.overrides.length, "C23 шаг 3: два переопределения").toBe(2);
    expect([...afterThis.zones].sort(), "C23 шаг 3: определение нового пояса добавлено").toEqual([
      "Asia/Novosibirsk",
      "Asia/Yekaterinburg",
      "Europe/Moscow",
    ]);
  });

  // Поломки: AE11, R13-N6 — all_series со сдвигом времени не переносит
  // переопределения и EXDATE: удалённое воскресает, перенесённая двоится.
  // Прежний код: падает на шаге 3 — строгий стенд отвергает PUT (orphan-override).
  it.fails("C24: перенос 21.10 на 11:30, удаление 04.11 → вся серия в 11:00 — 5 встреч, 21.10 одна, EXDATE сдвинут", async () => {
    const chain = standWith(weeklyMoscow);
    const moved21 = "2026-10-21 11:30–12:30 Планёрка [слот 2026-10-21 10:00]";

    const initial = chain.fake.ics(chain.path);
    const slot21 = await occurrence(chain, "2026-10-21 10:00");
    await act(chain, "C24 шаг 1 (перенос 21.10 на 11:30)", () =>
      update(chain, {
        scope: "this",
        instanceStart: slot21.instanceStart,
        patch: { start: "2026-10-21T11:30:00+03:00", end: "2026-10-21T12:30:00+03:00" },
      }),
    );
    await expectVisible(chain, "C24 шаг 1", rows("Планёрка", { "2026-10-21": moved21 }));
    expectInvariants(chain, "C24 шаг 1");
    expectKept(chain, "C24 шаг 1", initial);
    expectShape(chain, "C24 шаг 1", ["Europe/Moscow 20261021T100000"]);

    const afterMove = chain.fake.ics(chain.path);
    const slot04 = await occurrence(chain, "2026-11-04 10:00");
    await act(chain, "C24 шаг 2 (удаление 04.11)", () =>
      remove(chain, { scope: "this", instanceStart: slot04.instanceStart, etag: slot04.etag }),
    );
    await expectVisible(chain, "C24 шаг 2", rows("Планёрка", { "2026-10-21": moved21, "2026-11-04": null }));
    expectInvariants(chain, "C24 шаг 2");
    expectKept(chain, "C24 шаг 2", afterMove, { master: ["EXDATE"] });
    const afterDelete = expectShape(chain, "C24 шаг 2", ["Europe/Moscow 20261021T100000"]);
    expect(timesOf(afterDelete.masters[0], "EXDATE"), "C24 шаг 2: EXDATE ровно на слот 04.11").toEqual(["Europe/Moscow 20261104T100000"]);

    const beforeShift = chain.fake.ics(chain.path);
    await act(chain, "C24 шаг 3 (вся серия: 11:00–12:00)", () =>
      update(chain, { scope: "all_series", patch: { start: "2026-10-19T11:00:00+03:00", end: "2026-10-19T12:00:00+03:00" } }),
    );
    await expectVisible(
      chain,
      "C24 шаг 3",
      rows("Планёрка", { "2026-10-21": "2026-10-21 11:30–12:30 Планёрка [слот 2026-10-21 11:00]", "2026-11-04": null }, "11:00–12:00"),
    );
    expectInvariants(chain, "C24 шаг 3");
    const after = expectShape(chain, "C24 шаг 3", ["Europe/Moscow 20261021T110000"]);
    expect(timesOf(after.masters[0], "EXDATE"), "C24 шаг 3: EXDATE сдвинут вместе с серией").toEqual(["Europe/Moscow 20261104T110000"]);
    // У перенесённой меняется лишь RECURRENCE-ID, её 11:30–12:30 целы (О7).
    expectKept(chain, "C24 шаг 3", beforeShift, {
      master: ["DTSTART", "DTEND", "EXDATE"],
      moved: { "Europe/Moscow 20261021T100000": "Europe/Moscow 20261021T110000" },
    });
  });

  // Поломки: AE11, AE6 — смена правила all_series молча осиротила или
  // потеряла перенесённую встречу; нужен отказ с перечнем потерь и confirm.
  // Прежний код: падает на шаге 2 — вместо отказа PUT, отвергнутый строгим
  // стендом (orphan-override).
  it.fails("C25: перенос 21.10 → вся серия по понедельникам — отказ с перечнем потерь; с confirm переопределение снято", async () => {
    const chain = standWith(weeklyMoscow);
    const moved21 = "2026-10-21 11:30–12:30 Планёрка [слот 2026-10-21 10:00]";
    const rid21 = "Europe/Moscow 20261021T100000";

    const initial = chain.fake.ics(chain.path);
    const slot21 = await occurrence(chain, "2026-10-21 10:00");
    await act(chain, "C25 шаг 1 (перенос 21.10 на 11:30)", () =>
      update(chain, {
        scope: "this",
        instanceStart: slot21.instanceStart,
        patch: { start: "2026-10-21T11:30:00+03:00", end: "2026-10-21T12:30:00+03:00" },
      }),
    );
    await expectVisible(chain, "C25 шаг 1", rows("Планёрка", { "2026-10-21": moved21 }));
    expectInvariants(chain, "C25 шаг 1");
    expectKept(chain, "C25 шаг 1", initial);
    expectShape(chain, "C25 шаг 1", [rid21]);

    const afterMove = chain.fake.ics(chain.path);
    const seen = await occurrence(chain, "2026-10-19 10:00");
    const rule = { frequency: "weekly", interval: 1, byWeekday: ["MO"] };
    const refusal = await expectRefused(
      chain,
      "C25 шаг 2 (вся серия: только понедельники, без confirm)",
      () => update(chain, { scope: "all_series", patch: { recurrence: rule } }),
      refusalFor("отказа с просьбой confirm (потеря сверх названного, О11)"),
    );
    expect(refusal.needsConfirm, `C25 шаг 2: отказ обязан просить confirm: ${refusal.message}`).toBe(true);
    expect(
      (refusal.losses ?? []).map((loss) => String(loss.instanceStart ?? "")).some((address) => address.startsWith("2026-10-21")),
      `C25 шаг 2: в перечне потерь — перенесённая 21.10: ${JSON.stringify(refusal.losses)}`,
    ).toBe(true);
    await expectVisible(chain, "C25 шаг 2", rows("Планёрка", { "2026-10-21": moved21 }));

    const result = (await act(chain, "C25 шаг 3 (то же с confirm и etag)", () =>
      update(chain, { scope: "all_series", patch: { recurrence: rule }, confirm: true, etag: seen.etag }),
    )) as { removed?: Array<{ instanceStart?: unknown }> } | undefined;
    // COUNT не менялся: шесть понедельников с 19.10.
    await expectVisible(
      chain,
      "C25 шаг 3",
      ["2026-10-19", "2026-10-26", "2026-11-02", "2026-11-09", "2026-11-16", "2026-11-23"].map((d) => `${d} 10:00–11:00 Планёрка`),
    );
    expectInvariants(chain, "C25 шаг 3");
    // Основному — только правило; перенос 21.10 снят с confirm.
    expectKept(chain, "C25 шаг 3", afterMove, { master: ["RRULE"], dropped: [rid21] });
    const after = expectShape(chain, "C25 шаг 3", []);
    expect(ruleOf(after.masters[0]), "C25 шаг 3: BYDAY сменён, COUNT прежний").toMatchObject({ FREQ: "WEEKLY", BYDAY: "MO", COUNT: "6" });
    // A §6.2: «с confirm переопределение снято и указано в removed». Форму
    // ответа updateEvent план (§2) не задаёт; поле названо, как у ответа
    // deleteEvent и WritePlan. Если З13 выберет иную форму, проверку
    // переписать на неё — снятая встреча в ответе должна быть названа.
    expect(
      (result?.removed ?? []).some((loss) => String(loss.instanceStart ?? "").startsWith("2026-10-21")),
      `C25 шаг 3: снятая перенесённая 21.10 названа в removed ответа правки: ${JSON.stringify(result?.removed)}`,
    ).toBe(true);
  });

  // Поломка: J-A1 — start с чужого экземпляра сдвигал дату серии; плюс
  // AE11 (EXDATE и переопределение не следуют за временем).
  // Прежний код: падает на шаге 3 — строгий стенд отвергает PUT
  // (DTEND раньше DTSTART, переопределение-сирота).
  it.fails("C39: DAILY COUNT=10 → удаление 21.10 → имя 23.10 → вся серия start 22.10 11:00 — 9 встреч на прежних датах в 11:00", async () => {
    const chain = standWith(dailyMoscow);
    const days = ["19", "20", "21", "22", "23", "24", "25", "26", "27", "28"].map((d) => `2026-10-${d}`);

    const initial = chain.fake.ics(chain.path);
    const slot21 = await occurrence(chain, "2026-10-21 10:00");
    await act(chain, "C39 шаг 1 (удаление 21.10)", () =>
      remove(chain, { scope: "this", instanceStart: slot21.instanceStart, etag: slot21.etag }),
    );
    await expectVisible(chain, "C39 шаг 1", rows("Планёрка", { "2026-10-21": null }, "10:00–11:00", days));
    expectInvariants(chain, "C39 шаг 1");
    expectKept(chain, "C39 шаг 1", initial, { master: ["EXDATE"] });
    const afterDelete = expectShape(chain, "C39 шаг 1", []);
    expect(timesOf(afterDelete.masters[0], "EXDATE"), "C39 шаг 1: EXDATE ровно на слот 21.10").toEqual(["Europe/Moscow 20261021T100000"]);

    const afterSlot = chain.fake.ics(chain.path);
    const slot23 = await occurrence(chain, "2026-10-23 10:00");
    await act(chain, "C39 шаг 2 (23.10: имя)", () =>
      update(chain, { scope: "this", instanceStart: slot23.instanceStart, patch: { summary: "Ретро" } }),
    );
    await expectVisible(
      chain,
      "C39 шаг 2",
      rows("Планёрка", { "2026-10-21": null, "2026-10-23": "2026-10-23 10:00–11:00 Ретро" }, "10:00–11:00", days),
    );
    expectInvariants(chain, "C39 шаг 2");
    expectKept(chain, "C39 шаг 2", afterSlot);
    expectShape(chain, "C39 шаг 2", ["Europe/Moscow 20261023T100000"]);

    const afterName = chain.fake.ics(chain.path);
    await act(chain, "C39 шаг 3 (вся серия: start с экземпляра 22.10, 11:00)", () =>
      update(chain, { scope: "all_series", patch: { start: "2026-10-22T11:00+03:00" } }),
    );
    // Р1: из start берутся только время суток и пояс; дата DTSTART прежняя.
    await expectVisible(
      chain,
      "C39 шаг 3",
      rows("Планёрка", { "2026-10-21": null, "2026-10-23": "2026-10-23 11:00–12:00 Ретро" }, "11:00–12:00", days),
    );
    expectInvariants(chain, "C39 шаг 3");
    // Основному — время и EXDATE (сдвинут по позиции); неперенесённое «Ретро»
    // идёт за серией (О7): его DTSTART, DTEND и RECURRENCE-ID — 11:00, имя и
    // прочее цело.
    expectKept(chain, "C39 шаг 3", afterName, {
      master: ["DTSTART", "DTEND", "EXDATE"],
      overrides: ["DTSTART", "DTEND"],
      moved: { "Europe/Moscow 20261023T100000": "Europe/Moscow 20261023T110000" },
    });
    const after = expectShape(chain, "C39 шаг 3", ["Europe/Moscow 20261023T110000"]);
    expect(timesOf(after.masters[0], "DTSTART"), "C39 шаг 3: дата DTSTART прежняя").toEqual(["Europe/Moscow 20261019T110000"]);
    expect(timesOf(after.masters[0], "EXDATE"), "C39 шаг 3: EXDATE на прежней дате в новое время").toEqual(["Europe/Moscow 20261021T110000"]);
    expect(ruleOf(after.masters[0]).COUNT, "C39 шаг 3: COUNT не меняется").toBe("10");
  });

  // Поломки: NEW-5, AE6 — правка правила заменяет его целиком: части,
  // которых нет в патче (BYDAY, INTERVAL), пропадают.
  // Прежний код: падает на шаге 1 — BYDAY потерян, остались одни понедельники.
  it.fails("C43: INTERVAL=2 → {count} — INTERVAL и BYDAY целы", async () => {
    const chain = standWith(biweeklyMoscow);
    const initial = chain.fake.ics(chain.path);

    await act(chain, "C43 шаг 1 (вся серия: COUNT=4 при тех же частоте и интервале)", () =>
      update(chain, { scope: "all_series", patch: { recurrence: { frequency: "weekly", interval: 2, count: 4 } } }),
    );
    await expectVisible(
      chain,
      "C43 шаг 1",
      ["2026-10-19", "2026-10-21", "2026-11-02", "2026-11-04"].map((d) => `${d} 10:00–11:00 Планёрка`),
    );
    expectInvariants(chain, "C43 шаг 1");
    expect(ruleOf(stored(chain).masters[0]), "C43 шаг 1: части правила").toMatchObject({
      FREQ: "WEEKLY",
      INTERVAL: "2",
      BYDAY: "MO,WE",
      COUNT: "4",
    });
    expectPreserved(chain, "C43 шаг 1", initial, { except: ["RRULE"] });

    const afterFirst = chain.fake.ics(chain.path);
    await act(chain, "C43 шаг 2 (вся серия: только COUNT=5)", () =>
      update(chain, { scope: "all_series", patch: { recurrence: { count: 5 } } }),
    );
    await expectVisible(
      chain,
      "C43 шаг 2",
      ["2026-10-19", "2026-10-21", "2026-11-02", "2026-11-04", "2026-11-16"].map((d) => `${d} 10:00–11:00 Планёрка`),
    );
    expectInvariants(chain, "C43 шаг 2");
    expectKept(chain, "C43 шаг 2", afterFirst, { master: ["RRULE"] });
    expect(ruleOf(stored(chain).masters[0]), "C43 шаг 2: INTERVAL и BYDAY целы").toMatchObject({
      FREQ: "WEEKLY",
      INTERVAL: "2",
      BYDAY: "MO,WE",
      COUNT: "5",
    });
  });

  // Поломки: NEW-3, J-B4 — правка участников пересобирает их из модели:
  // теряются CN, ROLE, ответы (PARTSTAT); без status — сброс или падение.
  // Прежний код: падает на шаге 1 — строки ATTENDEE потеряли CN и ROLE.
  it.fails("C44: участники со status, затем без status — PARTSTAT, CN и ROLE целы, новые — NEEDS-ACTION", async () => {
    const chain = standWith(teamMoscow);
    const initial = chain.fake.ics(chain.path);

    await act(chain, "C44 шаг 1 (вся серия: участники с ответами и новый)", () =>
      update(chain, {
        scope: "all_series",
        patch: {
          attendees: [
            { email: "petrov@example.com", status: "accepted" },
            { email: "ivanova@example.com", status: "declined" },
            { email: "sidorov@example.com", status: "needs-action" },
          ],
        },
      }),
    );
    await expectVisible(chain, "C44 шаг 1", rows("Планёрка"));
    expectInvariants(chain, "C44 шаг 1");
    expectPreserved(chain, "C44 шаг 1 (прежние участники)", initial, { scope: "master", only: ["ATTENDEE"] });
    const attendees1 = linesOf(stored(chain).masters[0], "ATTENDEE");
    expect(
      attendees1.some((line) => /mailto:sidorov@example\.com$/i.test(line) && /PARTSTAT=NEEDS-ACTION/i.test(line)),
      `C44 шаг 1: новый участник с PARTSTAT=NEEDS-ACTION:\n${attendees1.join("\n")}`,
    ).toBe(true);
    expectPreserved(chain, "C44 шаг 1", initial, { except: ["ATTENDEE"] });

    const afterFirst = chain.fake.ics(chain.path);
    await act(chain, "C44 шаг 2 (вся серия: участники без status и ещё один)", () =>
      update(chain, {
        scope: "all_series",
        patch: {
          attendees: [
            { email: "petrov@example.com" },
            { email: "ivanova@example.com" },
            { email: "sidorov@example.com" },
            { email: "orlova@example.com" },
          ],
        },
      }),
    );
    await expectVisible(chain, "C44 шаг 2", rows("Планёрка"));
    expectInvariants(chain, "C44 шаг 2");
    expectPreserved(chain, "C44 шаг 2 (участники без status)", afterFirst, { scope: "master", only: ["ATTENDEE"] });
    expectKept(chain, "C44 шаг 2", afterFirst, { master: ["ATTENDEE"] });
    const attendees2 = linesOf(stored(chain).masters[0], "ATTENDEE");
    expect(
      attendees2.some((line) => /mailto:orlova@example\.com$/i.test(line) && /PARTSTAT=NEEDS-ACTION/i.test(line)),
      `C44 шаг 2: новый участник с PARTSTAT=NEEDS-ACTION:\n${attendees2.join("\n")}`,
    ).toBe(true);
    expect(attendees2.length, "C44 шаг 2: участников четверо").toBe(4);
  });

  // Поломка: правка напоминаний пересобирает VALARM из модели, чужое
  // напоминание (AUDIO) пропадает (О9).
  // Прежний код: падает на шаге 1 — VALARM AUDIO исчез.
  it.fails("C45: напоминания при VALARM AUDIO — чужой VALARM цел, DISPLAY заменён", async () => {
    const chain = standWith(teamMoscow);
    const initial = chain.fake.ics(chain.path);
    const alarms = () =>
      stored(chain)
        .masters[0].children.filter((child) => child.name === "VALARM")
        .map((alarm) => [...alarm.lines].sort().join(" | "))
        .sort();
    const audio = "ACTION:AUDIO | TRIGGER:-PT10M";

    await act(chain, "C45 шаг 1 (вся серия: напоминание за 30 минут)", () =>
      update(chain, { scope: "all_series", patch: { reminders: [{ minutesBefore: 30, method: "display" }] } }),
    );
    await expectVisible(chain, "C45 шаг 1", rows("Планёрка"));
    expectInvariants(chain, "C45 шаг 1");
    const after1 = alarms();
    expect(after1, `C45 шаг 1: VALARM AUDIO цел дословно, а напоминания теперь: ${after1.join(" || ") || "нет"}`).toContain(audio);
    expect(after1.length, `C45 шаг 1: напоминаний два (AUDIO и новое DISPLAY): ${after1.join(" || ")}`).toBe(2);
    expect(
      after1.some((alarm) => alarm.includes("ACTION:DISPLAY") && alarm.includes("TRIGGER:-PT30M")),
      `C45 шаг 1: DISPLAY за 30 минут: ${after1.join(" || ")}`,
    ).toBe(true);
    expectPreserved(chain, "C45 шаг 1", initial, { except: ["VALARM"] });

    const afterFirst = chain.fake.ics(chain.path);
    await act(chain, "C45 шаг 2 (вся серия: без напоминаний)", () => update(chain, { scope: "all_series", patch: { reminders: [] } }));
    await expectVisible(chain, "C45 шаг 2", rows("Планёрка"));
    expectInvariants(chain, "C45 шаг 2");
    expect(alarms(), "C45 шаг 2: снимаются только DISPLAY и EMAIL, AUDIO остаётся").toEqual([audio]);
    expectKept(chain, "C45 шаг 2", afterFirst, { master: ["VALARM"] });
  });

  // Поломки: AD3 (для правки — J-B3), AD9 — правка по адресу, совпадающему
  // и со слотом, и с фактическим временем перенесённой, шла вслепую; confirm
  // с устаревшим etag обязан получить отказ.
  // Прежний код: падает на шаге 2 — вместо отказа ambiguous правка записана.
  it.fails("C53: перенос 26.10 на 28.10 → правка 28.10 — ambiguous; confirm с устаревшим etag — отказ; со свежим — правка слота", async () => {
    const chain = standWith(weeklyMoscow);

    const initial = chain.fake.ics(chain.path);
    const slot26 = await occurrence(chain, "2026-10-26 10:00");
    await act(chain, "C53 шаг 1 (перенос 26.10 на 28.10 10:00)", () =>
      update(chain, {
        scope: "this",
        instanceStart: slot26.instanceStart,
        patch: { start: "2026-10-28T10:00:00+03:00", end: "2026-10-28T11:00:00+03:00" },
      }),
    );
    const moved = "2026-10-28 10:00–11:00 Планёрка [слот 2026-10-26 10:00]";
    await expectVisible(chain, "C53 шаг 1", [...rows("Планёрка", { "2026-10-26": null }), moved], { unordered: true });
    expectInvariants(chain, "C53 шаг 1");
    expectKept(chain, "C53 шаг 1", initial);
    expectShape(chain, "C53 шаг 1", ["Europe/Moscow 20261026T100000"]);

    const slot28 = await occurrence(chain, "2026-10-28 10:00");
    await expectRefused(
      chain,
      "C53 шаг 2 (правка 28.10 10:00 без confirm)",
      () => update(chain, { scope: "this", instanceStart: slot28.instanceStart, patch: { summary: "Ретроспектива" } }),
      ["ambiguous"],
    );

    chain.fake.externalEdit(chain.path, (ics) => ics.split("SUMMARY:Планёрка").join("SUMMARY:Планёрка (веб)"));
    const external = chain.fake.ics(chain.path);
    await expectRefused(
      chain,
      "C53 шаг 3 (confirm с etag, прочитанным до чужой правки)",
      () =>
        update(chain, {
          scope: "this",
          instanceStart: slot28.instanceStart,
          patch: { summary: "Ретроспектива" },
          confirm: true,
          etag: slot28.etag,
        }),
      refusalFor("отказа по устаревшему etag (Р11)"),
    );
    expect(chain.fake.ics(chain.path), "C53 шаг 3: чужая правка цела").toBe(external);

    const fresh = await occurrence(chain, "2026-10-28 10:00");
    await act(chain, "C53 шаг 4 (confirm со свежим etag)", () =>
      update(chain, {
        scope: "this",
        instanceStart: fresh.instanceStart,
        patch: { summary: "Ретроспектива" },
        confirm: true,
        etag: fresh.etag,
      }),
    );
    await expectVisible(
      chain,
      "C53 шаг 4",
      [
        ...rows("Планёрка (веб)", { "2026-10-26": null, "2026-10-28": "2026-10-28 10:00–11:00 Ретроспектива" }),
        "2026-10-28 10:00–11:00 Планёрка (веб) [слот 2026-10-26 10:00]",
      ],
      { unordered: true },
    );
    expectInvariants(chain, "C53 шаг 4");
    // Правка слота 28.10 заводит новое переопределение; основной с чужим
    // именем и перенос 26.10 целы.
    expectKept(chain, "C53 шаг 4", external);
    expectShape(chain, "C53 шаг 4", ["Europe/Moscow 20261026T100000", "Europe/Moscow 20261028T100000"]);
  });

  // Поломка: T16 (SEQUENCE) — пересборка теряет SEQUENCE чужой встречи;
  // О10: SEQUENCE растёт, только если он есть и ORGANIZER свой.
  // Прежний код: падает на шаге (б)1 — SEQUENCE:2 пропал.
  it.fails("C54: SEQUENCE при чужом ORGANIZER и при его отсутствии не трогается", async () => {
    // (б) Чужой организатор, SEQUENCE:2.
    const foreign = standWith(foreignOrganizer);
    const sequences = (chain: Chain) => {
      const now = stored(chain);
      return [...now.masters, ...now.overrides].map((event) => linesOf(event, "SEQUENCE").join(",") || "нет");
    };

    const moved26 = "2026-10-26 15:00–16:00 Планёрка [слот 2026-10-26 12:00]";
    const foreignInitial = foreign.fake.ics(foreign.path);
    await act(foreign, "C54 (б) шаг 1 (вся серия: 12:00–13:00)", () =>
      update(foreign, { scope: "all_series", patch: { start: "2026-10-19T12:00:00+03:00", end: "2026-10-19T13:00:00+03:00" } }),
    );
    await expectVisible(foreign, "C54 (б) шаг 1", rows("Планёрка", {}, "12:00–13:00"));
    expectInvariants(foreign, "C54 (б) шаг 1");
    expect(sequences(foreign), "C54 (б) шаг 1: SEQUENCE чужой встречи не растёт").toEqual(["SEQUENCE:2"]);
    // Основному — только время: ORGANIZER, ATTENDEE и прочее целы.
    expectKept(foreign, "C54 (б) шаг 1", foreignInitial, { master: ["DTSTART", "DTEND"] });

    const foreignShifted = foreign.fake.ics(foreign.path);
    const slot26 = await occurrence(foreign, "2026-10-26 12:00");
    await act(foreign, "C54 (б) шаг 2 (перенос 26.10 на 15:00)", () =>
      update(foreign, {
        scope: "this",
        instanceStart: slot26.instanceStart,
        patch: { start: "2026-10-26T15:00:00+03:00", end: "2026-10-26T16:00:00+03:00" },
      }),
    );
    await expectVisible(foreign, "C54 (б) шаг 2", rows("Планёрка", { "2026-10-26": moved26 }, "12:00–13:00"));
    expectInvariants(foreign, "C54 (б) шаг 2");
    expect(sequences(foreign), "C54 (б) шаг 2: у основного и у переопределения SEQUENCE:2").toEqual(["SEQUENCE:2", "SEQUENCE:2"]);
    expectKept(foreign, "C54 (б) шаг 2", foreignShifted);

    // (а) SEQUENCE нет — не добавляется.
    const bare = standWith(noSequence);
    const bareInitial = bare.fake.ics(bare.path);
    await act(bare, "C54 (а) шаг 1 (вся серия: 12:00–13:00)", () =>
      update(bare, { scope: "all_series", patch: { start: "2026-10-19T12:00:00+03:00", end: "2026-10-19T13:00:00+03:00" } }),
    );
    await expectVisible(bare, "C54 (а) шаг 1", rows("Планёрка", {}, "12:00–13:00"));
    expectInvariants(bare, "C54 (а) шаг 1");
    expectKept(bare, "C54 (а) шаг 1", bareInitial, { master: ["DTSTART", "DTEND"] });
    const bareShifted = bare.fake.ics(bare.path);
    const bare26 = await occurrence(bare, "2026-10-26 12:00");
    await act(bare, "C54 (а) шаг 2 (перенос 26.10 на 15:00)", () =>
      update(bare, {
        scope: "this",
        instanceStart: bare26.instanceStart,
        patch: { start: "2026-10-26T15:00:00+03:00", end: "2026-10-26T16:00:00+03:00" },
      }),
    );
    await expectVisible(bare, "C54 (а) шаг 2", rows("Планёрка", { "2026-10-26": moved26 }, "12:00–13:00"));
    expectInvariants(bare, "C54 (а) шаг 2");
    expect(sequences(bare), "C54 (а) шаг 2: отсутствующий SEQUENCE не добавляется").toEqual(["нет", "нет"]);
    expectKept(bare, "C54 (а) шаг 2", bareShifted);
  });

  // Поломки: AE11, П «UNTIL за горизонтом» — сдвиг времени серии не
  // пересчитывает UNTIL: последняя встреча пропадает (или лишняя появляется).
  // Прежний код: падает на шаге 1 — нет последней встречи 30.10.2028.
  it.fails("C58: WEEKLY UNTIL=20281030T070000Z → вся серия в 11:00, затем в 09:00 — последняя 30.10.2028 есть, лишних нет", async () => {
    const chain = standWith(untilMoscow);
    const dates = mondays("2026-10-19", "2028-10-30");
    expect(dates.length, "C58: 107 понедельников").toBe(107);

    const initial = chain.fake.ics(chain.path);
    await act(chain, "C58 шаг 1 (вся серия: 11:00–12:00)", () =>
      update(chain, { scope: "all_series", patch: { start: "2026-10-19T11:00:00+03:00", end: "2026-10-19T12:00:00+03:00" } }),
    );
    await expectVisible(chain, "C58 шаг 1", rows("Планёрка", {}, "11:00–12:00", dates));
    expectInvariants(chain, "C58 шаг 1");
    expect(ruleOf(stored(chain).masters[0]), "C58 шаг 1: UNTIL — 30.10.2028 11:00 МСК в UTC, прочие части прежние").toEqual({
      FREQ: "WEEKLY",
      BYDAY: "MO",
      UNTIL: "20281030T080000Z",
    });
    // Основному — время и конец правила (UNTIL по Р1), остальное цело.
    expectKept(chain, "C58 шаг 1", initial, { master: ["DTSTART", "DTEND", "RRULE"] });

    const afterFirst = chain.fake.ics(chain.path);
    await act(chain, "C58 шаг 2 (вся серия: 09:00–10:00)", () =>
      update(chain, { scope: "all_series", patch: { start: "2026-10-19T09:00:00+03:00", end: "2026-10-19T10:00:00+03:00" } }),
    );
    await expectVisible(chain, "C58 шаг 2", rows("Планёрка", {}, "09:00–10:00", dates));
    expectInvariants(chain, "C58 шаг 2");
    expect(ruleOf(stored(chain).masters[0]), "C58 шаг 2: UNTIL — 30.10.2028 09:00 МСК в UTC, прочие части прежние").toEqual({
      FREQ: "WEEKLY",
      BYDAY: "MO",
      UNTIL: "20281030T060000Z",
    });
    expectKept(chain, "C58 шаг 2", afterFirst, { master: ["DTSTART", "DTEND", "RRULE"] });
  });

  // Поломки: AD3 для правки (П), R13-N4 — адрес совпадает со слотом 28.10 и
  // с фактическим временем перенесённой 26.10: правка обязана отказать.
  // Прежний код: падает на шаге 2 — вместо отказа ambiguous правка записана.
  it.fails("C61: перенос 26.10 на 28.10 10:00 → правка 28.10 10:00 — ambiguous, записей нет", async () => {
    const chain = standWith(weeklyMoscow);

    const initial = chain.fake.ics(chain.path);
    const slot26 = await occurrence(chain, "2026-10-26 10:00");
    await act(chain, "C61 шаг 1 (перенос 26.10 на 28.10 10:00)", () =>
      update(chain, {
        scope: "this",
        instanceStart: slot26.instanceStart,
        patch: { start: "2026-10-28T10:00:00+03:00", end: "2026-10-28T11:00:00+03:00" },
      }),
    );
    const expected = [...rows("Планёрка", { "2026-10-26": null }), "2026-10-28 10:00–11:00 Планёрка [слот 2026-10-26 10:00]"];
    await expectVisible(chain, "C61 шаг 1", expected, { unordered: true });
    expectInvariants(chain, "C61 шаг 1");
    expectKept(chain, "C61 шаг 1", initial);
    expectShape(chain, "C61 шаг 1", ["Europe/Moscow 20261026T100000"]);

    const slot28 = await occurrence(chain, "2026-10-28 10:00");
    const before = chain.fake.ics(chain.path);
    const refusal = await expectRefused(
      chain,
      "C61 шаг 2 (правка по адресу 28.10 10:00)",
      () => update(chain, { scope: "this", instanceStart: slot28.instanceStart, patch: { summary: "Ретроспектива" } }),
      ["ambiguous"],
    );
    expect(
      `${String(refusal.hint ?? "")} ${refusal.message ?? ""}`,
      "C61 шаг 2: в отказе назван адрес перенесённой встречи (слот 26.10)",
    ).toContain("2026-10-26T10:00");
    expect(chain.fake.ics(chain.path), "C61 шаг 2: объект не тронут").toBe(before);
    await expectVisible(chain, "C61 шаг 2", expected, { unordered: true });
  });
});
