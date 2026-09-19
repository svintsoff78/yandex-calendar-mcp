// Цепочки удаления повторяющихся встреч на изменяемом стенде — задача З05a
// плана переделки (docs/superpowers/plans/2026-09-19-recurring-events-rework.md,
// §6 и §7). Сценарии C01–C38 — из §6.2 проекта A
// (.superpowers/sdd/2026-09-18-yandex-calendar-mcp/wave-b/проект-сырое-дерево.recovered.md),
// C39–C63 — из §6 плана; поломки — из каталога
// .superpowers/sdd/2026-09-18-yandex-calendar-mcp/wave-a-results.json
// (AE — adversaryEdit, AD — adversaryDelete, R13 — review13, R8 — review8).
//
// Цепочка — последовательность публичных вызовов deleteEvent, updateEvent,
// readEvents на FakeCaldav из tests/support: что записал шаг, то следующий
// шаг читает с сервера. instanceStart и etag берутся только из выдачи
// readEvents (кроме цепочек, где адрес нарочно чужой: C18, C46).
//
// После каждого пишущего шага, пока объект жив:
// - точный видимый список readEvents;
// - инварианты О12а всех объектов стенда (строгий стенд к тому же отвергает
//   запись, добавляющую нарушение, кодом 400);
// - сохранность (assertPropsPreserved, §6 плана) через expectKept: у шага
//   названо, что он вправе менять (основному компоненту при delete this —
//   EXDATE, при усечении — RRULE; снятые переопределения), всё
//   прочее — свойства и вложенные компоненты основного VEVENT, каждого
//   оставшегося переопределения и VTIMEZONE — сверяется с состоянием до шага;
// - форма хранимого объекта (RECURRENCE-ID, EXDATE, части RRULE).
// Отказ сверяется по `code` и обязан ничего не записать.
//
// Цепочки помечены it.fails: на прежнем коде (dd99d80; домен
// src/domain/events.ts не менялся до З13) каждая падает на утверждении о
// порче данных — какое именно, записано в строке «Прежний код» у цепочки и
// в отчёте З05a (.superpowers/sdd/2026-09-18-yandex-calendar-mcp/rework-З05a-report.md).
// Задача З13 снимает .fails, когда цепочки станут зелёными.
//
// Помощники повторяют помощники edit.test.ts: общий модуль в tests/chains
// не входит в файлы задачи, а импорт из тестового файла зарегистрировал бы
// его тесты второй раз.
import { describe, expect, it } from "vitest";
import { deleteEvent, readEvents, updateEvent } from "../../src/domain/events.js";
import type { CalendarEvent, EditScope } from "../../src/types.js";
import { makeStand, plant, type Stand } from "../support/context.js";
import { lineName, parseRawComponents, unfold, type RawComponent } from "../support/invariants.js";
import {
  assertPropsPreserved,
  assertStoredInvariants,
  DEFAULT_WINDOW,
  describeStand,
  formatEvent,
  visible,
  wallTime,
} from "../support/observe.js";
import { singleMoscow, weeklyMoscow, type Seed } from "../support/seeds.js";

// ---------------------------------------------------------------------------
// Стенд цепочки
// ---------------------------------------------------------------------------

const ZONE = "Europe/Moscow";

interface Chain extends Stand {
  path: string;
  uid: string;
}

function standWith(seed: Seed): Chain {
  const stand = makeStand();
  return { ...stand, path: plant(stand.fake, seed), uid: seed.uid };
}

// Параметры вызовов — в новом виде (§2 плана): etag обязателен у удаления
// (Р11), confirm. Приведение типа — чтобы файл одинаково запускался и на
// прежних, и на новых сигнатурах домена.
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

/** Ответ удаления в новом виде (§2 плана): {deleted, scope, objectRemoved, removed, notices?}. */
interface DeleteResult {
  objectRemoved?: unknown;
  removed?: Array<{ instanceStart?: unknown; summary?: unknown }>;
}

function update(chain: Chain, call: UpdateCall): Promise<unknown> {
  return updateEvent(chain.ctx, { id: chain.uid, ...call } as unknown as Parameters<typeof updateEvent>[1]);
}

async function remove(chain: Chain, call: DeleteCall): Promise<DeleteResult> {
  return (await deleteEvent(chain.ctx, { id: chain.uid, ...call } as unknown as Parameters<typeof deleteEvent>[1])) as DeleteResult;
}

// ---------------------------------------------------------------------------
// Сообщения, шаги и проверки
// ---------------------------------------------------------------------------

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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

function codeMatches(codes: CodeCheck, code: unknown): boolean {
  return Array.isArray(codes) ? codes.includes(code as string) : (codes as { test: (c: unknown) => boolean }).test(code);
}

function codesText(codes: CodeCheck): string {
  return Array.isArray(codes) ? codes.join(" или ") : (codes as { what: string }).what;
}

/** Шаг, который обязан кончиться отказом с кодом и ничего не записать. */
async function expectRefused(chain: Chain, label: string, run: () => Promise<unknown>, codes: CodeCheck): Promise<Refusal> {
  const mark = chain.fake.mark();
  const what = codesText(codes);
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
  if (!codeMatches(codes, code)) {
    throw failure(chain, label, `ожидался отказ с кодом ${what}, а пришёл ${code === undefined ? "отказ без кода" : `код ${String(code)}`}: ${messageOf(error)}`, mark);
  }
  return error as Refusal;
}

type Window = { from?: string; to?: string };

async function expectVisible(chain: Chain, label: string, expected: string[], options: { unordered?: boolean } & Window = {}): Promise<void> {
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

function expectAlive(chain: Chain, label: string, alive: boolean): void {
  expect(
    chain.fake.has(chain.path),
    `${label}: объект серии ${alive ? "обязан остаться на сервере" : "обязан быть удалён с сервера"}\n${describeStand(chain.fake)}`,
  ).toBe(alive);
}

function slotOf(event: CalendarEvent): string {
  const address = event.instanceStart ?? event.start;
  return event.allDay ? address.slice(0, 10) : wallTime(address, ZONE);
}

/** Встреча серии по её слоту — ровно одна, из настоящей выдачи readEvents. */
async function occurrence(chain: Chain, slot: string, window: Window = DEFAULT_WINDOW): Promise<CalendarEvent> {
  const list = await readEvents(chain.ctx, { from: window.from ?? DEFAULT_WINDOW.from, to: window.to ?? DEFAULT_WINDOW.to });
  const hits = list.filter((event) => (event.id === chain.uid || event.seriesId === chain.uid) && slotOf(event) === slot);
  if (hits.length !== 1) {
    throw new Error(
      `в выдаче readEvents ${hits.length} встреч со слотом ${slot} (нужна ровно одна):\n${list.map((e) => formatEvent(e)).join("\n")}`,
    );
  }
  return hits[0];
}

/** ETag объекта из выдачи readEvents (у любой его встречи). */
async function etagSeen(chain: Chain): Promise<string | undefined> {
  const list = await readEvents(chain.ctx, DEFAULT_WINDOW);
  return list.find((event) => event.id === chain.uid || event.seriesId === chain.uid)?.etag;
}

// ---------------------------------------------------------------------------
// Разбор хранимого текста (независимо от src/)
// ---------------------------------------------------------------------------

interface Stored {
  masters: RawComponent[];
  overrides: RawComponent[];
}

function stored(chain: Chain): Stored {
  const root = parseRawComponents(chain.fake.ics(chain.path))[0];
  const events = root.children.filter((child) => child.name === "VEVENT");
  const has = (component: RawComponent, name: string) => component.lines.some((line) => lineName(line) === name);
  return {
    masters: events.filter((event) => !has(event, "RECURRENCE-ID")),
    overrides: events.filter((event) => has(event, "RECURRENCE-ID")),
  };
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

function timesOf(component: RawComponent, name: string): string[] {
  return component.lines.filter((line) => lineName(line) === name).flatMap(timeKeys);
}

function ruleOf(master: RawComponent): Record<string, string> {
  const rule = master.lines.find((line) => lineName(line) === "RRULE");
  if (!rule) return {};
  return Object.fromEntries(
    rule
      .slice(rule.indexOf(":") + 1)
      .split(";")
      .map((part) => part.split("=") as [string, string]),
  );
}

/** Один основной компонент; переопределения и EXDATE — ровно такие. */
function expectShape(chain: Chain, label: string, shape: { rids: string[]; exdates: string[] }): Stored {
  const now = stored(chain);
  const context = `\n${describeStand(chain.fake)}`;
  expect(now.masters.length, `${label}: основных компонентов (VEVENT без RECURRENCE-ID)${context}`).toBe(1);
  expect(now.overrides.flatMap((o) => timesOf(o, "RECURRENCE-ID")).sort(), `${label}: RECURRENCE-ID переопределений${context}`).toEqual(
    [...shape.rids].sort(),
  );
  expect(timesOf(now.masters[0], "EXDATE").sort(), `${label}: EXDATE основного компонента${context}`).toEqual([...shape.exdates].sort());
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
 * assertPropsPreserved по умолчанию не сверяет. Компоненты, которых до шага
 * не было (новое переопределение), не сверяются — их проверяют видимый
 * список и форма объекта.
 */
interface Allowed {
  /** Свойства и вложенные компоненты основного VEVENT, которые шаг меняет. */
  master?: readonly string[];
  /** То же у переопределений. */
  overrides?: readonly string[];
  /** Переопределения, которые шаг снимает: RECURRENCE-ID как «TZID значение». */
  dropped?: readonly string[];
  /** Сдвиг серии: RECURRENCE-ID переопределения до шага → после, как «TZID значение». */
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
const YANDEX_TAIL = ["SEQUENCE:0", "CREATED:20261001T090000Z", "LAST-MODIFIED:20261001T090000Z", "TRANSP:OPAQUE", "CLASS:PUBLIC"];

function seedOf(uid: string, about: string, ...events: string[][]): Seed {
  const lines = [
    "BEGIN:VCALENDAR",
    "PRODID:-//Yandex LLC//Yandex Calendar//EN",
    "VERSION:2.0",
    "CALSCALE:GREGORIAN",
    ...MOSCOW_TZ,
    ...events.flatMap((event) => ["BEGIN:VEVENT", `UID:${uid}`, "DTSTAMP:20261001T090000Z", ...event, "END:VEVENT"]),
    "END:VCALENDAR",
  ];
  return { uid, about, ics: lines.join(CRLF) + CRLF };
}

const moscow = (wall: string) => `TZID=Europe/Moscow:${wall}`;

const masterLines = (rule: string, start = "20261019T100000", end = "20261019T110000") => [
  `DTSTART;${moscow(start)}`,
  `DTEND;${moscow(end)}`,
  `RRULE:${rule}`,
  "SUMMARY:Планёрка",
  ...YANDEX_TAIL,
];

/** C21: Пн и Ср 10:00 МСК, COUNT=2 — 19 и 21 октября. */
const twoMeetings = seedOf("c21count2mw@yandex.ru", "Пн и Ср 10:00–11:00 МСК с 19.10.2026, COUNT=2", masterLines("FREQ=WEEKLY;BYDAY=MO,WE;COUNT=2"));

/** C42 (а): COUNT=2 и настоящее отдельное переопределение (RID вторник 20.10 — мимо позиций, внутри серии). */
const withDetached = seedOf(
  "c42detached1@yandex.ru",
  "Пн и Ср 10:00 МСК, COUNT=2; отдельная встреча с RECURRENCE-ID 20.10 10:00 (Р5, роль detached)",
  masterLines("FREQ=WEEKLY;BYDAY=MO,WE;COUNT=2"),
  [
    `RECURRENCE-ID;${moscow("20261020T100000")}`,
    `DTSTART;${moscow("20261020T140000")}`,
    `DTEND;${moscow("20261020T150000")}`,
    "SUMMARY:Разбор инцидента",
    ...YANDEX_TAIL,
  ],
);

/** C42 (б): COUNT=2 и скрытое переопределение за концом серии (RID 26.10, Р5.2, след R8-N1). */
const withHidden = seedOf(
  "c42hidden001@yandex.ru",
  "Пн и Ср 10:00 МСК, COUNT=2; переопределение 26.10 за концом серии (Р5.2, hidden)",
  masterLines("FREQ=WEEKLY;BYDAY=MO,WE;COUNT=2"),
  [
    `RECURRENCE-ID;${moscow("20261026T100000")}`,
    `DTSTART;${moscow("20261026T100000")}`,
    `DTEND;${moscow("20261026T110000")}`,
    "SUMMARY:Старый хвост",
    ...YANDEX_TAIL,
  ],
);

/** C57 (а): раз в два года 19.10 10:00 МСК, без конца — шаг между встречами 731 день. */
const everyTwoYears = seedOf("c57yearly2x@yandex.ru", "Раз в два года 19.10 10:00–11:00 МСК, без конца", masterLines("FREQ=YEARLY;INTERVAL=2"));

/** C57 (б): раз в два года, две встречи — 19.10.2026 и 19.10.2028. */
const everyTwoYearsTwice = seedOf(
  "c57yearly2c2@yandex.ru",
  "Раз в два года 19.10 10:00–11:00 МСК, COUNT=2: 19.10.2026 и 19.10.2028",
  masterLines("FREQ=YEARLY;INTERVAL=2;COUNT=2"),
);

/** C57 (в): 29.02 10:00 МСК с явными BYMONTH и BYMONTHDAY, две встречи — 29.02.2028 и 29.02.2032. */
const leapDayTwice = seedOf(
  "c57leapday29@yandex.ru",
  "Ежегодно 29.02 10:00–11:00 МСК, BYMONTH=2;BYMONTHDAY=29;COUNT=2: 29.02.2028 и 29.02.2032",
  masterLines("FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29;COUNT=2", "20280229T100000", "20280229T110000"),
);

// ---------------------------------------------------------------------------
// Ожидаемые строки
// ---------------------------------------------------------------------------

const DATES = ["2026-10-19", "2026-10-21", "2026-10-26", "2026-10-28", "2026-11-02", "2026-11-04"];

/** Строки серии по умолчанию в формате visible(); replace заменяет строку даты (null — даты нет). */
function rows(text: string, replace: Record<string, string | null> = {}, time = "10:00–11:00", dates = DATES): string[] {
  return dates.flatMap((date) => (date in replace ? (replace[date] === null ? [] : [replace[date] as string]) : [`${date} ${time} ${text}`]));
}

const MOVED_21 = "2026-10-21 11:30–12:30 Планёрка [слот 2026-10-21 10:00]";
const RID_21 = "Europe/Moscow 20261021T100000";

async function move21(chain: Chain, label: string): Promise<void> {
  const before = chain.fake.ics(chain.path);
  const slot21 = await occurrence(chain, "2026-10-21 10:00");
  await act(chain, `${label} (перенос 21.10 на 11:30)`, () =>
    update(chain, {
      scope: "this",
      instanceStart: slot21.instanceStart,
      patch: { start: "2026-10-21T11:30:00+03:00", end: "2026-10-21T12:30:00+03:00" },
    }),
  );
  await expectVisible(chain, label, rows("Планёрка", { "2026-10-21": MOVED_21 }));
  expectInvariants(chain, label);
  expectKept(chain, label, before);
  expectShape(chain, label, { rids: [RID_21], exdates: [] });
}

// ---------------------------------------------------------------------------
// Цепочки
// ---------------------------------------------------------------------------

describe("Цепочки удаления (З05a)", () => {
  // Поломки: AD3, AE12, R13-N4 — по фактическому времени перенесённой
  // delete ставит EXDATE «в пустоту» и рапортует успех (AD5); по instanceStart
  // из выдачи перенесённую удалить нельзя.
  // (б) идёт первой: на прежнем коде она показывает саму порчу — запись
  // EXDATE мимо слотов вместо отказа; (а) падает раньше порчи, на отказе
  // прежней проверки адреса.
  // Прежний код: падает на (б) шаге 2 — вместо отказа actual-start PUT → 204.
  it.fails("C07: перенос 21.10 → удаление по фактическому времени (actual-start); отдельно — по слоту", async () => {
    // (б) По фактическому времени — отказ с подсказкой адреса.
    const byStart = standWith(weeklyMoscow);
    await move21(byStart, "C07 (б) шаг 1");
    const shown = await occurrence(byStart, "2026-10-21 10:00");
    const refusal = await expectRefused(
      byStart,
      "C07 (б) шаг 2 (удаление по фактическому времени 11:30)",
      () => remove(byStart, { scope: "this", instanceStart: shown.start, etag: shown.etag }),
      ["actual-start"],
    );
    expect(
      `${String(refusal.hint ?? "")} ${refusal.message ?? ""}`,
      "C07 (б) шаг 2: подсказка называет адрес перенесённой встречи (её слот)",
    ).toContain("2026-10-21T10:00");
    await expectVisible(byStart, "C07 (б) шаг 2", rows("Планёрка", { "2026-10-21": MOVED_21 }));

    // (а) По слоту из выдачи.
    const bySlot = standWith(weeklyMoscow);
    await move21(bySlot, "C07 (а) шаг 1");
    const moved = await occurrence(bySlot, "2026-10-21 10:00");
    const before = bySlot.fake.ics(bySlot.path);
    await act(bySlot, "C07 (а) шаг 2 (удаление перенесённой по её instanceStart)", () =>
      remove(bySlot, { scope: "this", instanceStart: moved.instanceStart, etag: moved.etag }),
    );
    await expectVisible(bySlot, "C07 (а) шаг 2", rows("Планёрка", { "2026-10-21": null }));
    expectInvariants(bySlot, "C07 (а) шаг 2");
    expectAlive(bySlot, "C07 (а) шаг 2", true);
    expectKept(bySlot, "C07 (а) шаг 2", before, { master: ["EXDATE"], dropped: [RID_21] });
    expectShape(bySlot, "C07 (а) шаг 2", { rids: [], exdates: [RID_21] });
  });

  // Поломка: AD3 — перенос на время другого экземпляра: EXDATE гасит не ту встречу.
  // Прежний код: падает на шаге 2 — вместо отказа ambiguous удалена обычная 28.10.
  it.fails("C08: перенос 26.10 на 28.10 10:00 → удаление 28.10 — ambiguous; с confirm — обычная 28.10; по слоту 26.10 — перенесённая", async () => {
    const chain = standWith(weeklyMoscow);
    const moved = "2026-10-28 10:00–11:00 Планёрка [слот 2026-10-26 10:00]";
    const rid26 = "Europe/Moscow 20261026T100000";

    const initial = chain.fake.ics(chain.path);
    const slot26 = await occurrence(chain, "2026-10-26 10:00");
    await act(chain, "C08 шаг 1 (перенос 26.10 на 28.10 10:00)", () =>
      update(chain, {
        scope: "this",
        instanceStart: slot26.instanceStart,
        patch: { start: "2026-10-28T10:00:00+03:00", end: "2026-10-28T11:00:00+03:00" },
      }),
    );
    await expectVisible(chain, "C08 шаг 1", [...rows("Планёрка", { "2026-10-26": null }), moved], { unordered: true });
    expectInvariants(chain, "C08 шаг 1");
    expectKept(chain, "C08 шаг 1", initial);
    expectShape(chain, "C08 шаг 1", { rids: [rid26], exdates: [] });

    const slot28 = await occurrence(chain, "2026-10-28 10:00");
    await expectRefused(
      chain,
      "C08 шаг 2 (удаление по адресу 28.10 10:00 без confirm)",
      () => remove(chain, { scope: "this", instanceStart: slot28.instanceStart, etag: slot28.etag }),
      ["ambiguous"],
    );
    await expectVisible(chain, "C08 шаг 2", [...rows("Планёрка", { "2026-10-26": null }), moved], { unordered: true });

    const afterMove = chain.fake.ics(chain.path);
    await act(chain, "C08 шаг 3 (то же с confirm)", () =>
      remove(chain, { scope: "this", instanceStart: slot28.instanceStart, etag: slot28.etag, confirm: true }),
    );
    await expectVisible(chain, "C08 шаг 3", rows("Планёрка", { "2026-10-26": null, "2026-10-28": moved }));
    expectInvariants(chain, "C08 шаг 3");
    expectKept(chain, "C08 шаг 3", afterMove, { master: ["EXDATE"] });
    expectShape(chain, "C08 шаг 3", { rids: [rid26], exdates: ["Europe/Moscow 20261028T100000"] });

    const afterSlot = chain.fake.ics(chain.path);
    const movedNow = await occurrence(chain, "2026-10-26 10:00");
    await act(chain, "C08 шаг 4 (удаление перенесённой по слоту 26.10)", () =>
      remove(chain, { scope: "this", instanceStart: movedNow.instanceStart, etag: movedNow.etag }),
    );
    await expectVisible(chain, "C08 шаг 4", rows("Планёрка", { "2026-10-26": null, "2026-10-28": null }));
    expectInvariants(chain, "C08 шаг 4");
    expectAlive(chain, "C08 шаг 4", true);
    expectKept(chain, "C08 шаг 4", afterSlot, { master: ["EXDATE"], dropped: [rid26] });
    expectShape(chain, "C08 шаг 4", { rids: [], exdates: [rid26, "Europe/Moscow 20261028T100000"] });
  });

  // Поломки: AE13, AD5 — delete this не снимает переопределение: встреча
  // остаётся, повтор копит дубли EXDATE.
  // Прежний код: падает на шаге 2 — строгий стенд отвергает PUT
  // (excluded-override: EXDATE поставлен, переопределение не снято).
  it.fails("C09: имя 21.10 → удаление 21.10 дважды — встречи нет, EXDATE один, второй вызов ничего не пишет", async () => {
    const chain = standWith(weeklyMoscow);

    const initial = chain.fake.ics(chain.path);
    const slot21 = await occurrence(chain, "2026-10-21 10:00");
    await act(chain, "C09 шаг 1 (21.10: имя)", () =>
      update(chain, { scope: "this", instanceStart: slot21.instanceStart, patch: { summary: "Особая" } }),
    );
    await expectVisible(chain, "C09 шаг 1", rows("Планёрка", { "2026-10-21": "2026-10-21 10:00–11:00 Особая" }));
    expectInvariants(chain, "C09 шаг 1");
    expectKept(chain, "C09 шаг 1", initial);
    expectShape(chain, "C09 шаг 1", { rids: [RID_21], exdates: [] });

    const afterName = chain.fake.ics(chain.path);
    const renamed = await occurrence(chain, "2026-10-21 10:00");
    const mark = chain.fake.mark();
    await act(chain, "C09 шаг 2 (удаление 21.10)", () =>
      remove(chain, { scope: "this", instanceStart: renamed.instanceStart, etag: renamed.etag }),
    );
    await expectVisible(chain, "C09 шаг 2", rows("Планёрка", { "2026-10-21": null }));
    expectInvariants(chain, "C09 шаг 2");
    expectKept(chain, "C09 шаг 2", afterName, { master: ["EXDATE"], dropped: [RID_21] });
    expectShape(chain, "C09 шаг 2", { rids: [], exdates: [RID_21] });
    expect(chain.fake.writes(mark).length, `C09 шаг 2: запись ровно одна: ${writesAfter(chain, mark)}`).toBe(1);

    // Повтор: «уже удалено» — либо без ошибки, либо отказ excluded; записей нет.
    const again = chain.fake.mark();
    const before = chain.fake.ics(chain.path);
    let refusal: unknown;
    try {
      await remove(chain, { scope: "this", instanceStart: renamed.instanceStart, etag: await etagSeen(chain) });
    } catch (error) {
      refusal = error;
    }
    if (refusal !== undefined && (refusal as Refusal).code !== "excluded") {
      throw failure(chain, "C09 шаг 3 (повторное удаление 21.10)", `ожидалось «уже удалено» или отказ excluded, а пришло: ${messageOf(refusal)}`, again);
    }
    expect(writesAfter(chain, again), "C09 шаг 3: повтор ничего не пишет").toBe("");
    expect(chain.fake.ics(chain.path), "C09 шаг 3: объект не тронут").toBe(before);
    await expectVisible(chain, "C09 шаг 3", rows("Планёрка", { "2026-10-21": null }));
  });

  // Поломки: AD6, AE10, R13-O1 — усечение оставляет переопределения после
  // границы: «удалённая» встреча продолжает показываться.
  // Прежний код: падает на шаге 2 — строгий стенд отвергает PUT (orphan-override).
  it.fails("C10: имя 04.11 → удаление хвоста с 28.10 — 3 встречи, переопределения нет, COUNT=3", async () => {
    const chain = standWith(weeklyMoscow);
    const rid04 = "Europe/Moscow 20261104T100000";

    const initial = chain.fake.ics(chain.path);
    const slot04 = await occurrence(chain, "2026-11-04 10:00");
    await act(chain, "C10 шаг 1 (04.11: имя)", () =>
      update(chain, { scope: "this", instanceStart: slot04.instanceStart, patch: { summary: "Итоговая" } }),
    );
    await expectVisible(chain, "C10 шаг 1", rows("Планёрка", { "2026-11-04": "2026-11-04 10:00–11:00 Итоговая" }));
    expectInvariants(chain, "C10 шаг 1");
    expectKept(chain, "C10 шаг 1", initial);
    expectShape(chain, "C10 шаг 1", { rids: [rid04], exdates: [] });

    const afterName = chain.fake.ics(chain.path);
    const slot28 = await occurrence(chain, "2026-10-28 10:00");
    await act(chain, "C10 шаг 2 (удаление хвоста с 28.10)", () =>
      remove(chain, { scope: "this_and_following", instanceStart: slot28.instanceStart, etag: slot28.etag }),
    );
    await expectVisible(chain, "C10 шаг 2", rows("Планёрка", { "2026-10-28": null, "2026-11-02": null, "2026-11-04": null }));
    expectInvariants(chain, "C10 шаг 2");
    expectAlive(chain, "C10 шаг 2", true);
    expectKept(chain, "C10 шаг 2", afterName, { master: ["RRULE"], dropped: [rid04] });
    const after = expectShape(chain, "C10 шаг 2", { rids: [], exdates: [] });
    const rule = ruleOf(after.masters[0]);
    expect({ COUNT: rule.COUNT, UNTIL: rule.UNTIL }, "C10 шаг 2: COUNT по позициям до границы, без UNTIL").toEqual({ COUNT: "3", UNTIL: undefined });
    expect({ FREQ: rule.FREQ, BYDAY: rule.BYDAY }, "C10 шаг 2: прочие части правила прежние").toEqual({ FREQ: "WEEKLY", BYDAY: "MO,WE" });
  });

  // Поломка: AD2 — явный scope this у одиночного события с чужим
  // instanceStart удалял весь объект без отказа.
  // Коды: план (таблица §3: «instanceStart ≠ DTSTART — отказ») код не
  // называет; из AddressError (§2) подходят оба — mismatch (адрес не того
  // вида) и not-found (слота нет). Сузить, когда З07 или З10 выберут.
  // Прежний код: падает на шаге 1 — вместо отказа DELETE всего объекта.
  it.fails("C18: одиночное событие — delete и update this с чужим instanceStart: отказ, объект цел", async () => {
    const chain = standWith(singleMoscow);
    const initial = chain.fake.ics(chain.path);
    const foreign = "2026-10-27T15:00:00+03:00";
    const etag = await etagSeen(chain);

    await expectRefused(
      chain,
      "C18 шаг 1 (delete this с instanceStart 27.10 15:00)",
      () => remove(chain, { scope: "this", instanceStart: foreign, etag }),
      ["mismatch", "not-found"],
    );
    expectAlive(chain, "C18 шаг 1", true);

    await expectRefused(
      chain,
      "C18 шаг 2 (update this с instanceStart 27.10 15:00)",
      () => update(chain, { scope: "this", instanceStart: foreign, patch: { summary: "Чужой экземпляр" } }),
      ["mismatch", "not-found"],
    );
    expect(chain.fake.ics(chain.path), "C18 шаг 2: объект не тронут").toBe(initial);
    await expectVisible(chain, "C18 шаг 2", ["2026-10-20 15:00–16:00 Обед с командой"]);
  });

  // Поломки: AE15, AD10 — this_and_following с первой встречи ставил UNTIL
  // раньше DTSTART и заводил вторую серию или оставлял объект-зомби.
  // Прежний код: падает на (а) шаге 1 — строгий стенд отвергает PUT (until-before-dtstart).
  it.fails("C20: this_and_following с первой встречи: правка — та же серия и UID; удаление — объект удалён", async () => {
    // (а) Правка.
    const edited = standWith(weeklyMoscow);
    const initial = edited.fake.ics(edited.path);
    const first = await occurrence(edited, "2026-10-19 10:00");
    await act(edited, "C20 (а) шаг 1 (правка с 19.10 и далее)", () =>
      update(edited, { scope: "this_and_following", instanceStart: first.instanceStart, patch: { summary: "Новая планёрка" } }),
    );
    await expectVisible(edited, "C20 (а) шаг 1", rows("Новая планёрка"));
    expectInvariants(edited, "C20 (а) шаг 1");
    expect([...edited.fake.objects.keys()], "C20 (а) шаг 1: объект один — прежний, второй серии нет").toEqual([edited.path]);
    // Р2: это all_series с тем же UID — меняется только имя.
    expectKept(edited, "C20 (а) шаг 1", initial, { master: ["SUMMARY"] });
    const after = expectShape(edited, "C20 (а) шаг 1", { rids: [], exdates: [] });
    expect(ruleOf(after.masters[0]), "C20 (а) шаг 1: правило прежнее").toMatchObject({ FREQ: "WEEKLY", BYDAY: "MO,WE", COUNT: "6" });

    // (б) Удаление.
    const removed = standWith(weeklyMoscow);
    const head = await occurrence(removed, "2026-10-19 10:00");
    await act(removed, "C20 (б) шаг 1 (удаление с 19.10 и далее)", () =>
      remove(removed, { scope: "this_and_following", instanceStart: head.instanceStart, etag: head.etag }),
    );
    expectAlive(removed, "C20 (б) шаг 1", false);
    await expectVisible(removed, "C20 (б) шаг 1", []);
  });

  // Поломки: AD10, S4 — удаление через this всех встреч оставляло пустой объект-зомби.
  // Прежний код: падает на шаге 2 — объект остался на сервере.
  it.fails("C21: COUNT=2 — удаление обеих встреч по одной удаляет объект", async () => {
    const chain = standWith(twoMeetings);

    const initial = chain.fake.ics(chain.path);
    const slot19 = await occurrence(chain, "2026-10-19 10:00");
    await act(chain, "C21 шаг 1 (удаление 19.10)", () => remove(chain, { scope: "this", instanceStart: slot19.instanceStart, etag: slot19.etag }));
    await expectVisible(chain, "C21 шаг 1", ["2026-10-21 10:00–11:00 Планёрка"]);
    expectInvariants(chain, "C21 шаг 1");
    expectAlive(chain, "C21 шаг 1", true);
    expectKept(chain, "C21 шаг 1", initial, { master: ["EXDATE"] });
    expectShape(chain, "C21 шаг 1", { rids: [], exdates: ["Europe/Moscow 20261019T100000"] });

    const slot21 = await occurrence(chain, "2026-10-21 10:00");
    const result = await act(chain, "C21 шаг 2 (удаление 21.10)", () =>
      remove(chain, { scope: "this", instanceStart: slot21.instanceStart, etag: slot21.etag }),
    );
    expectAlive(chain, "C21 шаг 2", false);
    expect(result.objectRemoved, "C21 шаг 2: ответ сообщает, что объект удалён").toBe(true);
    await expectVisible(chain, "C21 шаг 2", []);
  });

  // Поломки: AD10, R8-N1 — (а) отдельная (detached) встреча держит объект
  // живым; (б) скрытое переопределение за концом серии — след прошлых
  // удалений: не показывается и не держит объект, уходит в removed.
  // Прежний код: (а) проходит; падает на (б) шаге 0 — скрытая сирота 26.10
  // видна в выдаче (R8-N1).
  it.fails("C42: удаление всех слотов при detached — объект жив; при скрытом переопределении — DELETE, скрытое в removed", async () => {
    // (а) Отдельная встреча.
    const detached = standWith(withDetached);
    const separate = "2026-10-20 14:00–15:00 Разбор инцидента [слот 2026-10-20 10:00]";
    await expectVisible(detached, "C42 (а) шаг 0", ["2026-10-19 10:00–11:00 Планёрка", separate, "2026-10-21 10:00–11:00 Планёрка"]);
    const steps = [
      { step: 1, slot: "2026-10-19 10:00", exdates: ["Europe/Moscow 20261019T100000"], left: [separate, "2026-10-21 10:00–11:00 Планёрка"] },
      { step: 2, slot: "2026-10-21 10:00", exdates: ["Europe/Moscow 20261019T100000", RID_21], left: [separate] },
    ];
    for (const { step, slot, exdates, left } of steps) {
      const label = `C42 (а) шаг ${step}`;
      const before = detached.fake.ics(detached.path);
      const target = await occurrence(detached, slot);
      await act(detached, `${label} (удаление ${slot})`, () =>
        remove(detached, { scope: "this", instanceStart: target.instanceStart, etag: target.etag }),
      );
      await expectVisible(detached, label, left);
      expectInvariants(detached, label);
      expectAlive(detached, label, true);
      // Отдельная встреча 20.10 цела целиком: её компонент шаг не называл.
      expectKept(detached, label, before, { master: ["EXDATE"] });
      expectShape(detached, label, { rids: ["Europe/Moscow 20261020T100000"], exdates });
    }

    // (б) Скрытое переопределение.
    const hidden = standWith(withHidden);
    await expectVisible(hidden, "C42 (б) шаг 0", ["2026-10-19 10:00–11:00 Планёрка", "2026-10-21 10:00–11:00 Планёрка"]);
    const initial = hidden.fake.ics(hidden.path);
    const slot19 = await occurrence(hidden, "2026-10-19 10:00");
    await act(hidden, "C42 (б) шаг 1 (удаление 19.10)", () => remove(hidden, { scope: "this", instanceStart: slot19.instanceStart, etag: slot19.etag }));
    expectAlive(hidden, "C42 (б) шаг 1", true);
    await expectVisible(hidden, "C42 (б) шаг 1", ["2026-10-21 10:00–11:00 Планёрка"]);
    expectInvariants(hidden, "C42 (б) шаг 1");
    expectKept(hidden, "C42 (б) шаг 1", initial, { master: ["EXDATE"] });
    const slot21 = await occurrence(hidden, "2026-10-21 10:00");
    const result = await act(hidden, "C42 (б) шаг 2 (удаление 21.10)", () =>
      remove(hidden, { scope: "this", instanceStart: slot21.instanceStart, etag: slot21.etag }),
    );
    expectAlive(hidden, "C42 (б) шаг 2", false);
    expect(
      (result.removed ?? []).some((loss) => String(loss.instanceStart ?? "").startsWith("2026-10-26")),
      `C42 (б) шаг 2: скрытое переопределение 26.10 названо в removed: ${JSON.stringify(result.removed)}`,
    ).toBe(true);
    await expectVisible(hidden, "C42 (б) шаг 2", []);
  });

  // Поломки: AD2, AD9 — delete all_series не проверял переданный
  // instanceStart: адрес, не указывающий ни на одну встречу, удалял серию.
  // Коды: как в C18 — mismatch или not-found из AddressError.
  // Прежний код: падает на шаге 1 — вместо отказа DELETE всего объекта.
  it.fails("C46: удаление всей серии с неразрешимым instanceStart — отказ, объект цел", async () => {
    const chain = standWith(weeklyMoscow);
    const initial = chain.fake.ics(chain.path);
    const etag = await etagSeen(chain);

    await expectRefused(
      chain,
      "C46 шаг 1 (all_series с instanceStart вторника 20.10 10:00)",
      () => remove(chain, { scope: "all_series", instanceStart: "2026-10-20T10:00:00+03:00", etag }),
      ["not-found", "mismatch"],
    );
    expectAlive(chain, "C46 шаг 1", true);
    expect(chain.fake.ics(chain.path), "C46 шаг 1: объект не тронут").toBe(initial);
    await expectVisible(chain, "C46 шаг 1", rows("Планёрка"));
  });

  // Поломки: AD6, AE10, J-B2 — удаление хвоста снимает встречу, перенесённую
  // раньше границы: это потеря сверх названного, нужен confirm.
  // Прежний код: падает на шаге 2 — вместо отказа PUT, отвергнутый строгим
  // стендом (orphan-override).
  it.fails("C50: перенос 04.11 на 27.10 → удаление хвоста с 28.10 — needsConfirm; с confirm — 3 встречи, COUNT=3", async () => {
    const chain = standWith(weeklyMoscow);
    const rid04 = "Europe/Moscow 20261104T100000";

    const initial = chain.fake.ics(chain.path);
    const slot04 = await occurrence(chain, "2026-11-04 10:00");
    await act(chain, "C50 шаг 1 (перенос 04.11 на 27.10)", () =>
      update(chain, {
        scope: "this",
        instanceStart: slot04.instanceStart,
        patch: { start: "2026-10-27T10:00:00+03:00", end: "2026-10-27T11:00:00+03:00" },
      }),
    );
    const early = "2026-10-27 10:00–11:00 Планёрка [слот 2026-11-04 10:00]";
    await expectVisible(chain, "C50 шаг 1", [
      "2026-10-19 10:00–11:00 Планёрка",
      "2026-10-21 10:00–11:00 Планёрка",
      "2026-10-26 10:00–11:00 Планёрка",
      early,
      "2026-10-28 10:00–11:00 Планёрка",
      "2026-11-02 10:00–11:00 Планёрка",
    ]);
    expectInvariants(chain, "C50 шаг 1");
    expectKept(chain, "C50 шаг 1", initial);
    expectShape(chain, "C50 шаг 1", { rids: [rid04], exdates: [] });

    const slot28 = await occurrence(chain, "2026-10-28 10:00");
    const refusal = await expectRefused(
      chain,
      "C50 шаг 2 (удаление хвоста с 28.10 без confirm)",
      () => remove(chain, { scope: "this_and_following", instanceStart: slot28.instanceStart, etag: slot28.etag }),
      refusalFor("отказа с просьбой confirm (потеря сверх названного, О11)"),
    );
    expect(refusal.needsConfirm, `C50 шаг 2: отказ обязан просить confirm: ${refusal.message}`).toBe(true);
    expect(
      (refusal.losses ?? []).map((loss) => String(loss.instanceStart ?? "")).some((address) => address.startsWith("2026-11-04")),
      `C50 шаг 2: в перечне потерь — встреча слота 04.11, перенесённая на 27.10: ${JSON.stringify(refusal.losses)}`,
    ).toBe(true);

    const afterMove = chain.fake.ics(chain.path);
    await act(chain, "C50 шаг 3 (то же с confirm)", () =>
      remove(chain, { scope: "this_and_following", instanceStart: slot28.instanceStart, etag: slot28.etag, confirm: true }),
    );
    await expectVisible(chain, "C50 шаг 3", rows("Планёрка", { "2026-10-28": null, "2026-11-02": null, "2026-11-04": null }));
    expectInvariants(chain, "C50 шаг 3");
    expectKept(chain, "C50 шаг 3", afterMove, { master: ["RRULE"], dropped: [rid04] });
    const after = expectShape(chain, "C50 шаг 3", { rids: [], exdates: [] });
    expect(ruleOf(after.masters[0]).COUNT, "C50 шаг 3: COUNT по позициям до границы").toBe("3");
  });

  // Поломка: AD9 — удаление не принимало etag вызывающего: чужая правка
  // между list_events и delete_event стиралась молча.
  // Шаг 2: Р11 делает etag у update без confirm необязательным («патч
  // ложится на свежее состояние»), а «несовпадение — отказ» стоит рядом с
  // confirm; прочтение «переданный и не совпавший etag — отказ» план не
  // исключает. Цепочка принимает оба исхода и проверяет общее для них:
  // чужая правка цела. Отказ по confirm с устаревшим etag закреплён в C53.
  // Прежний код: падает на шаге 1 — вместо отказа PUT с EXDATE поверх чужой правки.
  it.fails("C52: удаление с устаревшим etag — отказ; правка с ним — отказ или патч на свежем состоянии; чужая правка цела", async () => {
    const chain = standWith(weeklyMoscow);
    const renamed = "Планёрка — перенесена в переговорную 5";

    const seen = await occurrence(chain, "2026-10-21 10:00");
    chain.fake.externalEdit(chain.path, (ics) => ics.split("SUMMARY:Планёрка").join(`SUMMARY:${renamed}`));
    const external = chain.fake.ics(chain.path);
    const stale = refusalFor("отказа по устаревшему etag (Р11)");

    await expectRefused(
      chain,
      "C52 шаг 1 (delete this 21.10 с etag до чужой правки)",
      () => remove(chain, { scope: "this", instanceStart: seen.instanceStart, etag: seen.etag }),
      stale,
    );
    expect(chain.fake.ics(chain.path), "C52 шаг 1: чужая правка цела").toBe(external);

    const label = "C52 шаг 2 (update this 21.10 с etag до чужой правки)";
    const mark = chain.fake.mark();
    let refused: unknown;
    let failed = false;
    try {
      await update(chain, { scope: "this", instanceStart: seen.instanceStart, patch: { summary: "Особая" }, etag: seen.etag });
    } catch (error) {
      failed = true;
      refused = error;
    }
    if (failed) {
      const writes = writesAfter(chain, mark);
      if (writes) throw failure(chain, label, `отказ обязан ничего не писать, а в журнале: ${writes}; ошибка: ${messageOf(refused)}`, mark);
      const code = (refused as Refusal | undefined)?.code;
      if (!codeMatches(stale, code)) {
        throw failure(chain, label, `ожидался отказ с кодом ${codesText(stale)}, а пришёл ${code === undefined ? "отказ без кода" : `код ${String(code)}`}: ${messageOf(refused)}`, mark);
      }
      expect(chain.fake.ics(chain.path), `${label}: чужая правка цела`).toBe(external);
      await expectVisible(chain, label, rows(renamed));
    } else {
      // Патч лёг на свежее состояние: 21.10 — «Особая», остальное — с чужим именем.
      await expectVisible(chain, label, rows(renamed, { "2026-10-21": "2026-10-21 10:00–11:00 Особая" }));
      expectInvariants(chain, label);
      expectKept(chain, label, external);
      expectShape(chain, label, { rids: [RID_21], exdates: [] });
    }
  });

  // Поломки: AD10 и мутант M22 (`isEmpty` по горизонту, Р3) — у серии с шагом
  // больше горизонта (400 дней, О12в) после удаления ближайшей встречи в
  // горизонте слотов нет, а объект не пуст: удалить его — потерять встречу.
  // Конечные варианты (б) и (в) проверяют и обратное (Р3): удаление
  // последней встречи — DELETE объекта, а не зомби (AD10).
  //
  // 29.02 записан с явными BYMONTH=2;BYMONTHDAY=29. Голое FREQ=YEARLY от
  // 29.02 ical.js раскрывает не так, как предполагает план (Р3, «шаг > 400
  // дней»): без BY-частей expand_year_days переносит на каждый год день года
  // DTSTART (node_modules/ical.js/lib/ical/recur_iterator.js:1108–1111), и в
  // невисокосный год _nextByYearDay (там же, :923–944) даёт 01.03:
  // 2028-02-29 → 2029-03-01 → 2030-03-01 → 2031-03-01 → 2032-02-29.
  // Следующая встреча через 366 дней попадает в горизонт, и M22 такой
  // вариант не ловит. С BYMONTHDAY=29 next_year (там же, :899–921) через
  // normalizeByMonthDayRules (:578–582) отбрасывает 29-е невисокосного
  // февраля: 2028-02-29 → 2032-02-29, шаг 1461 день.
  // Прежний код: (а) проходит; падает на (б) шаге 2 — объект без встреч
  // остался на сервере (AD10).
  it.fails("C57: YEARLY;INTERVAL=2 и 29.02 — удаление ближайшей оставляет объект, удаление последней удаляет его", async () => {
    // (а) Без конца: удаление ближайшей.
    const endless = standWith(everyTwoYears);
    await expectVisible(endless, "C57 (а) шаг 0", ["2026-10-19 10:00–11:00 Планёрка", "2028-10-19 10:00–11:00 Планёрка"]);
    const initialEndless = endless.fake.ics(endless.path);
    const nearest = await occurrence(endless, "2026-10-19 10:00");
    await act(endless, "C57 (а) шаг 1 (удаление 19.10.2026)", () =>
      remove(endless, { scope: "this", instanceStart: nearest.instanceStart, etag: nearest.etag }),
    );
    expectAlive(endless, "C57 (а) шаг 1", true);
    expectInvariants(endless, "C57 (а) шаг 1");
    await expectVisible(endless, "C57 (а) шаг 1", ["2028-10-19 10:00–11:00 Планёрка"]);
    expectKept(endless, "C57 (а) шаг 1", initialEndless, { master: ["EXDATE"] });
    expectShape(endless, "C57 (а) шаг 1", { rids: [], exdates: ["Europe/Moscow 20261019T100000"] });

    // (б), (в) Две встречи далеко друг от друга: первая, затем последняя.
    const finite = [
      { part: "(б)", seed: everyTwoYearsTwice, first: "2026-10-19", last: "2028-10-19", window: DEFAULT_WINDOW },
      { part: "(в)", seed: leapDayTwice, first: "2028-02-29", last: "2032-02-29", window: { from: "2026-01-01T00:00:00Z", to: "2033-01-01T00:00:00Z" } },
    ];
    for (const { part, seed, first, last, window } of finite) {
      const chain = standWith(seed);
      const lastRow = `${last} 10:00–11:00 Планёрка`;
      await expectVisible(chain, `C57 ${part} шаг 0`, [`${first} 10:00–11:00 Планёрка`, lastRow], window);

      const initial = chain.fake.ics(chain.path);
      const head = await occurrence(chain, `${first} 10:00`, window);
      await act(chain, `C57 ${part} шаг 1 (удаление ${first})`, () =>
        remove(chain, { scope: "this", instanceStart: head.instanceStart, etag: head.etag }),
      );
      expectAlive(chain, `C57 ${part} шаг 1`, true);
      expectInvariants(chain, `C57 ${part} шаг 1`);
      await expectVisible(chain, `C57 ${part} шаг 1`, [lastRow], window);
      expectKept(chain, `C57 ${part} шаг 1`, initial, { master: ["EXDATE"] });
      expectShape(chain, `C57 ${part} шаг 1`, { rids: [], exdates: [`Europe/Moscow ${first.replaceAll("-", "")}T100000`] });

      const tail = await occurrence(chain, `${last} 10:00`, window);
      const result = await act(chain, `C57 ${part} шаг 2 (удаление ${last})`, () =>
        remove(chain, { scope: "this", instanceStart: tail.instanceStart, etag: tail.etag }),
      );
      expectAlive(chain, `C57 ${part} шаг 2`, false);
      expect(result.objectRemoved, `C57 ${part} шаг 2: ответ сообщает, что объект удалён`).toBe(true);
      await expectVisible(chain, `C57 ${part} шаг 2`, [], window);
    }
  });
});
