import { createHash } from "node:crypto";
import ICAL from "ical.js";
import { describe, expect, it } from "vitest";
import { continuationUid, planDelete, planUpdate, type DeleteRequest, type UpdateRequest } from "../../src/ical/edit.js";
import { verifyPlan } from "../../src/ical/guard.js";
import { AddressError, instancesBetween, type Instance } from "../../src/ical/instances.js";
import { loadObject, semanticDigest, serializeObject, type CalendarObject, type Unparsable } from "../../src/ical/object.js";
import { EditRefusal, type WritePlan } from "../../src/ical/plan.js";
import { formatForModel, type IcalEnv, type SlotKey } from "../../src/ical/values.js";

// Планировщики planUpdate и planDelete (таблица §3, Р1–Р7, Р9 без сети, О11,
// О13, О14 плана переделки,
// docs/superpowers/plans/2026-09-19-recurring-events-rework.md, задача З10;
// роли переопределений — slot, hidden, detached по поправке «без ремонта
// следов прежнего кода»).
//
// Каждый тест строит объект текстом, получает план и читает записанный текст
// заново (loadObject): видимые встречи — через instancesBetween, строки — как
// их записал ical.js. Ожидания — строки ISO со смещением: от пояса процесса
// тесты не зависят (npm run test:tz).
//
// Каждый построенный план проходит и независимый предохранитель (guard.ts,
// verifyPlan, О12) — как в оркестрации (З13): план → verifyPlan → запись.

const ENV: IcalEnv = { floatingZone: "Europe/Moscow", ownerEmail: "user@yandex.ru" };
const CRLF = "\r\n";
const UID = "edit-test@yandex.ru";
const NOW = Date.parse("2026-10-15T09:00:00Z");
const STAMP = "DTSTAMP:20261015T090000Z";
const ETAG = '"e1"';

const MOSCOW = [
  "BEGIN:VTIMEZONE", "TZID:Europe/Moscow", "BEGIN:STANDARD", "TZNAME:MSK", "TZOFFSETFROM:+0300",
  "TZOFFSETTO:+0300", "DTSTART:19700101T000000", "END:STANDARD", "END:VTIMEZONE",
];

/** Берлин с переходами: CEST до 25.10.2026 03:00, затем CET. */
const BERLIN_ZONE = [
  "BEGIN:VTIMEZONE", "TZID:Europe/Berlin",
  "BEGIN:DAYLIGHT", "TZOFFSETFROM:+0100", "TZOFFSETTO:+0200", "TZNAME:CEST", "DTSTART:19700329T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU", "END:DAYLIGHT",
  "BEGIN:STANDARD", "TZOFFSETFROM:+0200", "TZOFFSETTO:+0100", "TZNAME:CET", "DTSTART:19701025T030000",
  "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU", "END:STANDARD", "END:VTIMEZONE",
];

/** Пн и Ср 10:00–11:00 МСК с 19.10.2026, COUNT=6: 19, 21, 26, 28 окт., 2, 4 нояб. */
const WEEKLY = ["DTSTART;TZID=Europe/Moscow:20261019T100000", "DTEND;TZID=Europe/Moscow:20261019T110000",
  "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6", "SUMMARY:Планёрка"];

function vevent(lines: string[], uid = UID): string[] {
  return ["BEGIN:VEVENT", `UID:${uid}`, "DTSTAMP:20261001T090000Z", ...lines, "END:VEVENT"];
}

function calendar(zones: string[], ...events: string[][]): string {
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//edit//RU", ...zones, ...events.flat(), "END:VCALENDAR"]
    .join(CRLF) + CRLF;
}

/** Переопределение серии в МСК: RID, начало и конец — стенное время. */
function override(rid: string, start: string, end: string, ...extra: string[]): string[] {
  const summary = extra.some((line) => line.startsWith("SUMMARY:")) ? [] : ["SUMMARY:Планёрка"];
  return vevent([`RECURRENCE-ID;TZID=Europe/Moscow:${rid}`, `DTSTART;TZID=Europe/Moscow:${start}`,
    `DTEND;TZID=Europe/Moscow:${end}`, ...summary, ...extra]);
}

function weekly(masterExtra: string[] = [], ...overrides: string[][]): CalendarObject {
  return load(calendar(MOSCOW, vevent([...WEEKLY, ...masterExtra]), ...overrides));
}

function load(ics: string, env: IcalEnv = ENV): CalendarObject {
  const object = loadObject(ics, env);
  if (object.kind === "unparsable") throw new Error(`не разобран: ${object.error}`);
  return object;
}

/** План проходит предохранитель; у неразобранного объекта — только удаление целиком (guard.ts). */
function guarded(o: CalendarObject | Unparsable, plan: WritePlan): WritePlan {
  if (o.kind !== "unparsable") verifyPlan(serializeObject(o), plan, o.env, { now: NOW });
  return plan;
}

function update(o: CalendarObject | Unparsable, request: Omit<UpdateRequest, "now">): WritePlan {
  return guarded(o, planUpdate(o, { now: NOW, ...request }));
}

function remove(o: CalendarObject | Unparsable, request: Omit<DeleteRequest, "now">): WritePlan {
  return guarded(o, planDelete(o, { now: NOW, ...request }));
}

function icsOf(plan: WritePlan): string {
  if (plan.kind !== "put") throw new Error(`ожидался план put, получен ${plan.kind}`);
  return plan.ics;
}

function after(plan: WritePlan): CalendarObject {
  return load(icsOf(plan));
}

function split(plan: WritePlan): Extract<WritePlan, { kind: "split" }> {
  if (plan.kind !== "split") throw new Error(`ожидался план split, получен ${plan.kind}`);
  return plan;
}

const iso = (t: ICAL.Time, env: IcalEnv = ENV) => formatForModel(t, env, "time");
const summaryOf = (c: ICAL.Component) => String(c.getFirstPropertyValue("summary") ?? "");
const at = (instant: string): SlotKey => `T:${Date.parse(instant) / 1000}`;

/** Встреча строкой: «адрес → начало–конец заголовок». */
function row(i: Instance, env: IcalEnv = ENV): string {
  return `${i.instanceStart} → ${iso(i.start, env)}–${iso(i.end, env).slice(11, 16)} ${summaryOf(i.shown)}`;
}

function visible(o: CalendarObject, from = "2026-10-01T00:00:00+03:00", to = "2027-01-01T00:00:00+03:00"): string[] {
  return instancesBetween(o, Date.parse(from), Date.parse(to)).map((i) => row(i, o.env));
}

/** Строки содержимого с развёрткой (RFC 5545 §3.1). */
function unfolded(ics: string): string[] {
  return ics.replace(/\r\n[ \t]/g, "").split(CRLF).filter(Boolean);
}

/** Строки VEVENT по компонентам. */
function events(ics: string): string[][] {
  const result: string[][] = [];
  let current: string[] | undefined;
  let depth = 0;
  for (const line of unfolded(ics)) {
    if (line === "BEGIN:VEVENT") {
      current = [];
      depth = 0;
      continue;
    }
    if (line === "END:VEVENT") {
      result.push(current!);
      current = undefined;
      continue;
    }
    if (!current) continue;
    if (line.startsWith("BEGIN:")) depth += 1;
    if (line.startsWith("END:")) depth -= 1;
    if (depth === 0 && !line.startsWith("END:")) current.push(line);
  }
  return result;
}

function masterLines(ics: string): string[] {
  return events(ics).find((lines) => !lines.some((line) => line.startsWith("RECURRENCE-ID")))!;
}

function overrideLines(ics: string, rid: string): string[] {
  const found = events(ics).find((lines) => lines.some((line) => line.startsWith("RECURRENCE-ID") && line.endsWith(rid)));
  if (!found) throw new Error(`нет переопределения ${rid}`);
  return found;
}

function linesNamed(lines: readonly string[], name: string): string[] {
  return lines.filter((line) => line.split(/[;:]/)[0] === name);
}

/** Разница строк двух текстов как мультимножеств: что ушло и что пришло. */
function diff(before: string, next: string): { removed: string[]; added: string[] } {
  const a = unfolded(before);
  const b = unfolded(next);
  const rest = [...b];
  const removed: string[] = [];
  for (const line of a) {
    const index = rest.indexOf(line);
    if (index >= 0) rest.splice(index, 1);
    else removed.push(line);
  }
  return { removed: removed.sort(), added: rest.sort() };
}

function refusal(run: () => unknown): EditRefusal {
  try {
    run();
  } catch (error) {
    if (error instanceof EditRefusal) return error;
    throw error;
  }
  throw new Error("ожидался отказ EditRefusal");
}

function addressRefusal(run: () => unknown): AddressError {
  try {
    run();
  } catch (error) {
    if (error instanceof AddressError) return error;
    throw error;
  }
  throw new Error("ожидался отказ AddressError");
}

const WEEKLY_ROWS = [
  "2026-10-19T10:00:00+03:00 → 2026-10-19T10:00:00+03:00–11:00 Планёрка",
  "2026-10-21T10:00:00+03:00 → 2026-10-21T10:00:00+03:00–11:00 Планёрка",
  "2026-10-26T10:00:00+03:00 → 2026-10-26T10:00:00+03:00–11:00 Планёрка",
  "2026-10-28T10:00:00+03:00 → 2026-10-28T10:00:00+03:00–11:00 Планёрка",
  "2026-11-02T10:00:00+03:00 → 2026-11-02T10:00:00+03:00–11:00 Планёрка",
  "2026-11-04T10:00:00+03:00 → 2026-11-04T10:00:00+03:00–11:00 Планёрка",
];

/** Строка встречи WEEKLY с другим заголовком или временем. */
function weeklyRow(date: string, summary = "Планёрка", time = "10:00", end = "11:00", actualDate = date): string {
  return `${date}T10:00:00+03:00 → ${actualDate}T${time}:00+03:00–${end} ${summary}`;
}

// ─────────────────────────────── одиночное событие ───────────────────────────────

describe("одиночное событие", () => {
  const SINGLE = calendar(MOSCOW, vevent([
    "DTSTART;TZID=Europe/Moscow:20261021T100000", "DTEND;TZID=Europe/Moscow:20261021T110000",
    "SUMMARY:Встреча", "LOCATION:Переговорная", "X-CUSTOM;X-PARAM=1:своё",
    "ATTENDEE;CN=Гость;PARTSTAT=ACCEPTED:mailto:guest@example.com",
  ]));

  it("update: правка на месте — меняются только SUMMARY и DTSTAMP", () => {
    const plan = update(load(SINGLE), { patch: { summary: "Новая" } });
    expect(plan.kind).toBe("put");
    expect(diff(SINGLE, icsOf(plan))).toEqual({
      removed: ["DTSTAMP:20261001T090000Z", "SUMMARY:Встреча"],
      added: [STAMP, "SUMMARY:Новая"],
    });
    expect([...plan.expect.fields]).toEqual(["summary"]);
    expect(plan.expect.removed).toEqual([]);
  });

  it.each(["this", "this_and_following", "all_series"] as const)("update со scope %s — то же, что на месте", (scope) => {
    const plan = update(load(SINGLE), { scope, instanceStart: "2026-10-21T10:00:00+03:00", patch: { summary: "Новая" } });
    expect(diff(SINGLE, icsOf(plan)).added).toEqual([STAMP, "SUMMARY:Новая"]);
  });

  it("update: instanceStart не совпадает с началом — отказ mismatch, объект не тронут", () => {
    const o = load(SINGLE);
    const error = addressRefusal(() => update(o, { instanceStart: "2026-10-22T10:00:00+03:00", patch: { summary: "Х" } }));
    expect(error.code).toBe("mismatch");
  });

  it("update: значение, равное прежнему, — пустой план noop (О13)", () => {
    expect(update(load(SINGLE), { patch: { summary: "Встреча" } }).kind).toBe("noop");
  });

  it("update с recurrence превращает событие в серию: RRULE по патчу, прочее цело", () => {
    const plan = update(load(SINGLE), { patch: { recurrence: { frequency: "weekly", count: 3 } } });
    const next = after(plan);
    expect(next.kind).toBe("series");
    expect(linesNamed(masterLines(icsOf(plan)), "RRULE")).toEqual(["RRULE:FREQ=WEEKLY;COUNT=3"]);
    expect(visible(next).map((line) => line.slice(0, 16))).toEqual(["2026-10-21T10:00", "2026-10-28T10:00", "2026-11-04T10:00"]);
    expect(plan.expect.ruleChanged).toBe(true);
    expect(plan.expect.tail).toEqual({ count: 3, lastDate: "2026-11-04" });
  });

  it("update с recurrence, с которым начало не на первой позиции правила, — отказ unsynced-rule", () => {
    const error = refusal(() => update(load(SINGLE), { patch: { recurrence: { frequency: "weekly", byWeekday: ["TU"], count: 3 } } }));
    expect(error.code).toBe("unsynced-rule");
  });

  it("update с recurrence без frequency у одиночного события — отказ invalid-rule", () => {
    expect(refusal(() => update(load(SINGLE), { patch: { recurrence: { count: 3 } } })).code).toBe("invalid-rule");
  });

  it.each(["this", "this_and_following", "all_series"] as const)("delete со scope %s — удаление объекта", (scope) => {
    const plan = remove(load(SINGLE), { scope, instanceStart: "2026-10-21T10:00:00+03:00" });
    expect(plan.kind).toBe("delete-object");
    expect(plan.removed.map((loss) => [loss.instanceStart, loss.start, loss.summary])).toEqual([
      ["2026-10-21T10:00:00+03:00", "2026-10-21T10:00:00+03:00", "Встреча"],
    ]);
  });

  it("delete без scope и instanceStart — удаление объекта", () => {
    expect(remove(load(SINGLE), {}).kind).toBe("delete-object");
  });

  it("delete: instanceStart не совпадает с началом — отказ mismatch", () => {
    expect(addressRefusal(() => remove(load(SINGLE), { instanceStart: "2026-10-22T10:00:00+03:00" })).code).toBe("mismatch");
  });
});

// ─────────────────────────────── серия: update this ───────────────────────────────

describe("серия: update this", () => {
  it("встреча без переопределения: клон основного с RID слота, основной не тронут", () => {
    const o = weekly(["X-CUSTOM:своё", "ORGANIZER:mailto:user@yandex.ru"]);
    const before = calendar(MOSCOW, vevent([...WEEKLY, "X-CUSTOM:своё", "ORGANIZER:mailto:user@yandex.ru"]));
    const plan = update(o, { instanceStart: "2026-10-26T10:00:00+03:00", patch: { summary: "Ретро" } });
    const ics = icsOf(plan);
    expect(masterLines(ics)).toEqual(masterLines(before));
    const clone = overrideLines(ics, "20261026T100000");
    expect(clone).toEqual(expect.arrayContaining([
      "RECURRENCE-ID;TZID=Europe/Moscow:20261026T100000",
      "DTSTART;TZID=Europe/Moscow:20261026T100000",
      "DTEND;TZID=Europe/Moscow:20261026T110000",
      "SUMMARY:Ретро",
      "X-CUSTOM:своё",
      STAMP,
    ]));
    expect(linesNamed(clone, "RRULE")).toEqual([]);
    expect(visible(after(plan))).toEqual(WEEKLY_ROWS.map((line, i) => (i === 2 ? weeklyRow("2026-10-26", "Ретро") : line)));
    expect(plan.expect.target).toBe(at("2026-10-26T10:00:00+03:00"));
    expect(plan.expect.removed).toEqual([]);
  });

  it("переопределение правится на месте: RID прежний, прочие его свойства целы", () => {
    const ovr = override("20261026T100000", "20261027T120000", "20261027T130000", "SUMMARY:Перенос", "LOCATION:Зал", "X-OWN:1");
    const source = calendar(MOSCOW, vevent(WEEKLY), ovr);
    const plan = update(load(source), { instanceStart: "2026-10-26T10:00:00+03:00", patch: { summary: "Итоги" } });
    expect(diff(source, icsOf(plan))).toEqual({
      removed: ["DTSTAMP:20261001T090000Z", "SUMMARY:Перенос"],
      added: [STAMP, "SUMMARY:Итоги"],
    });
  });

  it("повторная правка перенесённой встречи: новое время, прежние поля (S5)", () => {
    const ovr = override("20261026T100000", "20261027T120000", "20261027T130000", "SUMMARY:Перенос", "LOCATION:Зал");
    const plan = update(load(calendar(MOSCOW, vevent(WEEKLY), ovr)), {
      instanceStart: "2026-10-26T10:00:00+03:00",
      patch: { start: "2026-10-27T15:00:00+03:00" },
    });
    const lines = overrideLines(icsOf(plan), "20261026T100000");
    expect(lines).toEqual(expect.arrayContaining([
      "DTSTART;TZID=Europe/Moscow:20261027T150000", "DTEND;TZID=Europe/Moscow:20261027T160000", "LOCATION:Зал", "SUMMARY:Перенос",
    ]));
  });

  it("правка без изменений у слота без переопределения — noop, клона нет", () => {
    expect(update(weekly(), { instanceStart: "2026-10-26T10:00:00+03:00", patch: { summary: "Планёрка" } }).kind).toBe("noop");
  });

  it("recurrence у одной встречи — отказ", () => {
    const error = refusal(() => update(weekly(), { instanceStart: "2026-10-26T10:00:00+03:00", patch: { recurrence: { count: 2 } } }));
    expect(error.code).toBe("invalid-field");
  });

  it("смена «весь день» у одной встречи — отказ invalid-time", () => {
    const error = refusal(() => update(weekly(), { instanceStart: "2026-10-26T10:00:00+03:00", patch: { allDay: true } }));
    expect(error.code).toBe("invalid-time");
  });

  it("отменённая встреча (STATUS:CANCELLED) — отказ (Р7)", () => {
    const o = load(calendar(MOSCOW, vevent(WEEKLY), override("20261026T100000", "20261026T100000", "20261026T110000", "STATUS:CANCELLED")));
    expect(refusal(() => update(o, { instanceStart: "2026-10-26T10:00:00+03:00", patch: { summary: "Х" } })).code).toBe("invalid-field");
  });

  it("оторванное переопределение (detached) правится на месте по своему RID", () => {
    const detached = override("20261022T100000", "20261022T150000", "20261022T160000", "SUMMARY:Чужое");
    const source = calendar(MOSCOW, vevent(WEEKLY), detached);
    const plan = update(load(source), { instanceStart: "2026-10-22T10:00:00+03:00", patch: { location: "Зал" } });
    expect(diff(source, icsOf(plan))).toEqual({ removed: ["DTSTAMP:20261001T090000Z"], added: [STAMP, "LOCATION:Зал"] });
  });

  it("скрытое переопределение (под EXDATE) правкой не адресуется", () => {
    const o = load(calendar(MOSCOW, vevent([...WEEKLY, "EXDATE;TZID=Europe/Moscow:20261028T100000"]),
      override("20261028T100000", "20261028T100000", "20261028T110000")));
    expect(addressRefusal(() => update(o, { instanceStart: "2026-10-28T10:00:00+03:00", patch: { summary: "Х" } })).code).toBe("excluded");
  });

  it("серия без instanceStart при scope this — отказ invalid с подсказкой", () => {
    const error = addressRefusal(() => update(weekly(), { patch: { summary: "Х" } }));
    expect(error.code).toBe("invalid");
    expect(error.message).toContain("all_series");
  });

  describe("неоднозначный адрес (C61, Р10, О11)", () => {
    const moved = override("20261026T100000", "20261028T100000", "20261028T110000", "SUMMARY:Перенос");
    const source = calendar(MOSCOW, vevent(WEEKLY), moved);

    it("без confirm — отказ ambiguous с адресом перенесённой", () => {
      const error = addressRefusal(() => update(load(source), { instanceStart: "2026-10-28T10:00:00+03:00", patch: { summary: "Ретро" } }));
      expect(error.code).toBe("ambiguous");
      expect(error.alternatives).toContain("2026-10-26T10:00:00+03:00");
    });

    it("с confirm и etag прочитанного состояния — правится слот 28.10, перенесённая цела, notice", () => {
      const plan = update(load(source), {
        instanceStart: "2026-10-28T10:00:00+03:00",
        patch: { summary: "Ретро" },
        confirm: true,
        etag: ETAG,
        currentEtag: ETAG,
      });
      const ics = icsOf(plan);
      expect(overrideLines(ics, "20261028T100000")).toContain("SUMMARY:Ретро");
      expect(overrideLines(ics, "20261026T100000")).toContain("SUMMARY:Перенос");
      expect(plan.notices.join(" ")).toContain("2026-10-26T10:00:00+03:00");
    });

    it("confirm без etag или с устаревшим etag — отказ confirm-required, объект не тронут", () => {
      const o = load(source);
      for (const etags of [{}, { etag: '"old"', currentEtag: ETAG }, { etag: ETAG }]) {
        const error = refusal(() => update(o, {
          instanceStart: "2026-10-28T10:00:00+03:00", patch: { summary: "Ретро" }, confirm: true, ...etags,
        }));
        expect(error.code).toBe("confirm-required");
        expect(error.needsConfirm).toBe(true);
      }
    });
  });
});

// ─────────────────────────────── серия: update all_series ───────────────────────────────

describe("серия: update all_series", () => {
  it("поля без времени: основной на месте, переопределения — по О7", () => {
    const same = override("20261026T100000", "20261027T100000", "20261027T110000", "SUMMARY:Планёрка");
    const own = override("20261028T100000", "20261028T100000", "20261028T110000", "SUMMARY:Своё");
    const plan = update(load(calendar(MOSCOW, vevent(WEEKLY), same, own)), { scope: "all_series", patch: { summary: "Итоги" } });
    const ics = icsOf(plan);
    expect(linesNamed(masterLines(ics), "SUMMARY")).toEqual(["SUMMARY:Итоги"]);
    expect(linesNamed(overrideLines(ics, "20261026T100000"), "SUMMARY")).toEqual(["SUMMARY:Итоги"]);
    expect(overrideLines(ics, "20261028T100000")).toEqual(own.slice(1, -1).map((line) => line));
    expect(plan.expect.ruleChanged).toBe(false);
  });

  const DAILY = calendar(MOSCOW, vevent(["DTSTART;TZID=Europe/Moscow:20261019T100000", "DTEND;TZID=Europe/Moscow:20261019T110000",
    "RRULE:FREQ=DAILY;COUNT=10", "SUMMARY:Планёрка"]));

  it("C39: удаление 21.10 → имя 23.10 → вся серия start с экземпляра 22.10 11:00 — 9 встреч на прежних датах в 11:00", () => {
    const step1 = remove(load(DAILY), { scope: "this", instanceStart: "2026-10-21T10:00:00+03:00" });
    const step2 = update(after(step1), { scope: "this", instanceStart: "2026-10-23T10:00:00+03:00", patch: { summary: "Ретро" } });
    const step3 = update(after(step2), { scope: "all_series", patch: { start: "2026-10-22T11:00:00+03:00" } });
    const ics = icsOf(step3);
    const master = masterLines(ics);
    expect(linesNamed(master, "DTSTART")).toEqual(["DTSTART;TZID=Europe/Moscow:20261019T110000"]);
    expect(linesNamed(master, "DTEND")).toEqual(["DTEND;TZID=Europe/Moscow:20261019T120000"]);
    expect(linesNamed(master, "EXDATE")).toEqual(["EXDATE;TZID=Europe/Moscow:20261021T110000"]);
    expect(linesNamed(master, "RRULE")).toEqual(["RRULE:FREQ=DAILY;COUNT=10"]);
    const retro = overrideLines(ics, "20261023T110000");
    expect(retro).toEqual(expect.arrayContaining([
      "DTSTART;TZID=Europe/Moscow:20261023T110000", "DTEND;TZID=Europe/Moscow:20261023T120000", "SUMMARY:Ретро",
    ]));
    const days = ["19", "20", "22", "23", "24", "25", "26", "27", "28"];
    expect(visible(after(step3))).toEqual(days.map((d) =>
      `2026-10-${d}T11:00:00+03:00 → 2026-10-${d}T11:00:00+03:00–12:00 ${d === "23" ? "Ретро" : "Планёрка"}`));
    expect(step3.notices.join(" ")).toContain("2026-10-22");
    expect(step3.expect.datesFixed).toBe(true);
    expect(step3.expect.keyMap?.(at("2026-10-21T10:00:00+03:00"))).toBe(at("2026-10-21T11:00:00+03:00"));
    expect(step3.expect.keyMap?.(at("2026-10-28T10:00:00+03:00"))).toBe(at("2026-10-28T11:00:00+03:00"));
  });

  it("сдвиг серии: перенесённая встреча остаётся на своём времени, RID следует за слотом", () => {
    const moved = override("20261026T100000", "20261027T150000", "20261027T160000");
    const plan = update(load(calendar(MOSCOW, vevent(WEEKLY), moved)), {
      scope: "all_series",
      patch: { start: "2026-10-19T12:00:00+03:00", end: "2026-10-19T13:30:00+03:00" },
    });
    const lines = overrideLines(icsOf(plan), "20261026T120000");
    expect(lines).toEqual(expect.arrayContaining([
      "DTSTART;TZID=Europe/Moscow:20261027T150000", "DTEND;TZID=Europe/Moscow:20261027T160000",
    ]));
    expect(visible(after(plan))[2]).toBe("2026-10-26T12:00:00+03:00 → 2026-10-27T15:00:00+03:00–16:00 Планёрка");
    expect(visible(after(plan))[0]).toBe("2026-10-19T12:00:00+03:00 → 2026-10-19T12:00:00+03:00–13:30 Планёрка");
  });

  it("неперенесённое переопределение со своей длительностью её сохраняет, с длительностью серии — получает новую", () => {
    const sameLength = override("20261021T100000", "20261021T100000", "20261021T110000", "SUMMARY:А");
    const ownLength = override("20261026T100000", "20261026T100000", "20261026T103000", "SUMMARY:Б");
    const plan = update(load(calendar(MOSCOW, vevent(WEEKLY), sameLength, ownLength)), {
      scope: "all_series",
      patch: { end: "2026-10-19T12:00:00+03:00" },
    });
    const rows = visible(after(plan));
    expect(rows[1]).toBe("2026-10-21T10:00:00+03:00 → 2026-10-21T10:00:00+03:00–12:00 А");
    expect(rows[2]).toBe("2026-10-26T10:00:00+03:00 → 2026-10-26T10:00:00+03:00–10:30 Б");
  });

  it("end без start берёт время суток: конец в тот же день после начала", () => {
    const plan = update(weekly(), { scope: "all_series", patch: { end: "2026-11-04T11:45:00+03:00" } });
    expect(linesNamed(masterLines(icsOf(plan)), "DTEND")).toEqual(["DTEND;TZID=Europe/Moscow:20261019T114500"]);
  });

  it("сдвиг начала с новой длительностью: неперенесённое с длительностью серии её получает, со своей — сохраняет", () => {
    const sameLength = override("20261021T100000", "20261021T100000", "20261021T110000", "SUMMARY:А");
    const ownLength = override("20261026T100000", "20261026T100000", "20261026T103000", "SUMMARY:Б");
    const plan = update(load(calendar(MOSCOW, vevent(WEEKLY), sameLength, ownLength)), {
      scope: "all_series",
      patch: { start: "2026-10-19T12:00:00+03:00", end: "2026-10-19T13:30:00+03:00" },
    });
    const rows = visible(after(plan));
    expect(rows[1]).toBe("2026-10-21T12:00:00+03:00 → 2026-10-21T12:00:00+03:00–13:30 А");
    expect(rows[2]).toBe("2026-10-26T12:00:00+03:00 → 2026-10-26T12:00:00+03:00–12:30 Б");
  });

  it("end без start раньше начала по времени суток — конец на следующий день", () => {
    const o = load(calendar(MOSCOW, vevent(["DTSTART;TZID=Europe/Moscow:20261019T230000", "DTEND;TZID=Europe/Moscow:20261019T233000",
      "RRULE:FREQ=DAILY;COUNT=3", "SUMMARY:Ночная"])));
    const plan = update(o, { scope: "all_series", patch: { end: "2026-10-21T01:00:00+03:00" } });
    expect(linesNamed(masterLines(icsOf(plan)), "DTEND")).toEqual(["DTEND;TZID=Europe/Moscow:20261020T010000"]);
  });

  describe("C58: UNTIL пересчитывается по последней встрече (Р1)", () => {
    const UNTIL_SERIES = calendar(MOSCOW, vevent(["DTSTART;TZID=Europe/Moscow:20261019T100000", "DTEND;TZID=Europe/Moscow:20261019T110000",
      "RRULE:FREQ=WEEKLY;UNTIL=20281030T070000Z", "SUMMARY:Планёрка"]));
    const window = ["2026-10-01T00:00:00+03:00", "2029-01-01T00:00:00+03:00"] as const;

    it("11:00, затем 09:00 — последняя 30.10.2028 есть, лишних нет", () => {
      const first = update(load(UNTIL_SERIES), {
        scope: "all_series", patch: { start: "2026-10-19T11:00:00+03:00", end: "2026-10-19T12:00:00+03:00" },
      });
      expect(linesNamed(masterLines(icsOf(first)), "RRULE")).toEqual(["RRULE:FREQ=WEEKLY;UNTIL=20281030T080000Z"]);
      const rows1 = visible(after(first), ...window);
      expect(rows1).toHaveLength(107);
      expect(rows1.at(-1)).toBe("2028-10-30T11:00:00+03:00 → 2028-10-30T11:00:00+03:00–12:00 Планёрка");
      expect(first.expect.tail).toEqual({ count: 107, lastDate: "2028-10-30" });

      const second = update(after(first), {
        scope: "all_series", patch: { start: "2026-10-19T09:00:00+03:00", end: "2026-10-19T10:00:00+03:00" },
      });
      expect(linesNamed(masterLines(icsOf(second)), "RRULE")).toEqual(["RRULE:FREQ=WEEKLY;UNTIL=20281030T060000Z"]);
      const rows2 = visible(after(second), ...window);
      expect(rows2).toHaveLength(107);
      expect(rows2.at(-1)).toBe("2028-10-30T09:00:00+03:00 → 2028-10-30T09:00:00+03:00–10:00 Планёрка");
    });
  });

  it("until-too-far: последняя встреча под UNTIL дальше 200 000 слотов — отказ", { timeout: 60_000 }, () => {
    const hourly = load(calendar([], vevent(["DTSTART:20000101T000000Z", "DTEND:20000101T003000Z",
      "RRULE:FREQ=HOURLY;UNTIL=20300101T000000Z", "SUMMARY:Каждый час"])));
    expect(refusal(() => update(hourly, { scope: "all_series", patch: { start: "2000-01-01T00:15:00Z" } })).code).toBe("until-too-far");
  });

  it("unsynced-rule: новое время не на первой позиции правила (BYHOUR)", () => {
    const o = load(calendar(MOSCOW, vevent(["DTSTART;TZID=Europe/Moscow:20261019T100000", "DTEND;TZID=Europe/Moscow:20261019T110000",
      "RRULE:FREQ=DAILY;BYHOUR=10;COUNT=5", "SUMMARY:Планёрка"])));
    expect(refusal(() => update(o, { scope: "all_series", patch: { start: "2026-10-19T11:00:00+03:00" } })).code).toBe("unsynced-rule");
  });

  it("unsynced-rule: byWeekday без нового start, согласованного с правилом", () => {
    const error = refusal(() => update(weekly(), { scope: "all_series", patch: { recurrence: { byWeekday: ["TU"] } } }));
    expect(error.code).toBe("unsynced-rule");
  });

  it("recurrence со start на новую дату: серия по вторникам с 20.10", () => {
    const plan = update(weekly(), {
      scope: "all_series",
      patch: { start: "2026-10-20T10:00:00+03:00", recurrence: { byWeekday: ["TU"] } },
    });
    const next = after(plan);
    expect(linesNamed(masterLines(icsOf(plan)), "DTSTART")).toEqual(["DTSTART;TZID=Europe/Moscow:20261020T100000"]);
    expect(visible(next).map((line) => line.slice(0, 10))).toEqual(
      ["2026-10-20", "2026-10-27", "2026-11-03", "2026-11-10", "2026-11-17", "2026-11-24"]);
  });

  describe("смена правила: сопоставление по ключу (Р1)", () => {
    const own = override("20261102T100000", "20261102T120000", "20261102T130000", "SUMMARY:Своё");
    const source = calendar(MOSCOW, vevent([...WEEKLY, "EXDATE;TZID=Europe/Moscow:20261104T100000"]), own);

    it("переопределение, чей слот исчезает, — needsConfirm с перечнем потерь, записи нет", () => {
      const error = refusal(() => update(load(source), { scope: "all_series", patch: { recurrence: { count: 4 } } }));
      expect(error.needsConfirm).toBe(true);
      expect(error.losses.map((loss) => [loss.instanceStart, loss.start, loss.summary])).toEqual([
        ["2026-11-02T10:00:00+03:00", "2026-11-02T12:00:00+03:00", "Своё"],
      ]);
    });

    it("с confirm и etag — переопределение снято и в removed, EXDATE за концом серии цел", () => {
      const plan = update(load(source), {
        scope: "all_series", patch: { recurrence: { count: 4 } }, confirm: true, etag: ETAG, currentEtag: ETAG,
      });
      const ics = icsOf(plan);
      expect(events(ics)).toHaveLength(1);
      // EXDATE — след удаления 04.11 пользователем: без него продление серии воскресило бы встречу.
      expect(linesNamed(masterLines(ics), "EXDATE")).toEqual(["EXDATE;TZID=Europe/Moscow:20261104T100000"]);
      expect(linesNamed(masterLines(ics), "RRULE")).toEqual(["RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=4"]);
      expect(plan.removed.map((loss) => loss.instanceStart)).toEqual(["2026-11-02T10:00:00+03:00"]);
      expect(plan.expect.ruleChanged).toBe(true);
      expect(plan.expect.tail).toEqual({ count: 4, lastDate: "2026-10-28" });
    });

    it("count больше прежнего — потерь нет, confirm не нужен", () => {
      const plan = update(load(source), { scope: "all_series", patch: { recurrence: { count: 8 } } });
      expect(visible(after(plan))).toHaveLength(7);
    });
  });

  it("смена правила: скрытый след за концом серии, попавший в серию, — needsConfirm; с confirm снят и назван в removed", () => {
    const trace = override("20261109T100000", "20261109T100000", "20261109T110000", "SUMMARY:След");
    const o = load(calendar(MOSCOW, vevent(WEEKLY), trace));
    const error = refusal(() => update(o, { scope: "all_series", patch: { recurrence: { count: 8 } } }));
    expect(error.needsConfirm).toBe(true);
    expect(error.losses.map((loss) => [loss.instanceStart, loss.summary])).toEqual([["2026-11-09T10:00:00+03:00", "След"]]);
    const plan = update(o, { scope: "all_series", patch: { recurrence: { count: 8 } }, confirm: true, etag: ETAG, currentEtag: ETAG });
    expect(events(icsOf(plan))).toHaveLength(1);
    expect(visible(after(plan)).at(-2)).toBe(weeklyRow("2026-11-09"));
    expect(plan.removed.map((loss) => [loss.instanceStart, loss.summary])).toEqual([["2026-11-09T10:00:00+03:00", "След"]]);
    // Скрытая встреча видимой не была: в ключах убранных видимых её нет.
    expect(plan.expect.removed).toEqual([]);
  });

  it("replace с потерей частей правила — needsConfirm, в тексте отказа — теряемые части", () => {
    const o = load(calendar(MOSCOW, vevent(["DTSTART;TZID=Europe/Moscow:20261019T100000", "DTEND;TZID=Europe/Moscow:20261019T110000",
      "RRULE:FREQ=MONTHLY;BYMONTHDAY=19;COUNT=3", "SUMMARY:Отчёт"])));
    const error = refusal(() => update(o, { scope: "all_series", patch: { recurrence: { frequency: "monthly", count: 3, replace: true } } }));
    expect(error.needsConfirm).toBe(true);
    expect(error.message).toContain("BYMONTHDAY=19");
    const plan = update(o, {
      scope: "all_series", patch: { recurrence: { frequency: "monthly", count: 3, replace: true } }, confirm: true, etag: ETAG, currentEtag: ETAG,
    });
    expect(linesNamed(masterLines(icsOf(plan)), "RRULE")).toEqual(["RRULE:FREQ=MONTHLY;COUNT=3"]);
  });

  it("timeZone без start: моменты начала серии прежние, EXDATE и RID — в новом поясе на своих слотах", () => {
    const retro = override("20261026T100000", "20261026T100000", "20261026T110000", "SUMMARY:Ретро");
    // EXDATE после перехода на зимнее время (25.10): по позиции это 28.10 09:00 CET (08:00Z),
    // а тем же моментом (07:00Z) было бы 08:00 — мимо встречи.
    const source = calendar(MOSCOW, vevent([...WEEKLY, "EXDATE;TZID=Europe/Moscow:20261028T100000"]), retro);
    const plan = update(load(source), { scope: "all_series", patch: { timeZone: "Europe/Berlin" } });
    const ics = icsOf(plan);
    expect(linesNamed(masterLines(ics), "DTSTART")).toEqual(["DTSTART;TZID=Europe/Berlin:20261019T090000"]);
    expect(linesNamed(masterLines(ics), "EXDATE")).toEqual(["EXDATE;TZID=Europe/Berlin:20261028T090000"]);
    expect(overrideLines(ics, "20261026T090000")).toEqual(expect.arrayContaining([
      "RECURRENCE-ID;TZID=Europe/Berlin:20261026T090000", "DTSTART;TZID=Europe/Berlin:20261026T090000",
      "DTEND;TZID=Europe/Berlin:20261026T100000",
    ]));
    expect(ics).toContain("TZID:Europe/Berlin");
    expect(ics).toContain("TZID:Europe/Moscow");
    const rows = visible(after(plan));
    expect(rows.map((line) => line.slice(0, 25))).toEqual([
      "2026-10-19T09:00:00+02:00", "2026-10-21T09:00:00+02:00", "2026-10-26T09:00:00+01:00",
      "2026-11-02T09:00:00+01:00", "2026-11-04T09:00:00+01:00",
    ]);
    expect(rows[2]).toContain("Ретро");
    expect(plan.expect.keyMap?.(at("2026-10-28T10:00:00+03:00"))).toBe(at("2026-10-28T09:00:00+01:00"));
  });

  it("смена пояса через полночь: моменты прежние, даты в новом поясе другие — datesFixed нет", () => {
    const o = load(calendar(MOSCOW, vevent(["DTSTART;TZID=Europe/Moscow:20261020T013000", "DTEND;TZID=Europe/Moscow:20261020T020000",
      "RRULE:FREQ=DAILY;COUNT=3", "SUMMARY:Ночная"])));
    const plan = update(o, { scope: "all_series", patch: { timeZone: "Europe/London" } });
    expect(linesNamed(masterLines(icsOf(plan)), "DTSTART")).toEqual(["DTSTART;TZID=Europe/London:20261019T233000"]);
    expect(plan.expect.datesFixed).toBe(false);
  });

  it("Нью-Йорк через переход 01.11: 10:30 по стенному времени до и после перехода, EXDATE на своём дне", () => {
    const newYork: IcalEnv = { floatingZone: "America/New_York", ownerEmail: "user@yandex.ru" };
    const o = load(calendar([], vevent(["DTSTART;TZID=America/New_York:20261028T090000", "DTEND;TZID=America/New_York:20261028T100000",
      "RRULE:FREQ=DAILY;COUNT=10", "EXDATE;TZID=America/New_York:20261103T090000", "SUMMARY:NY"])), newYork);
    const plan = update(o, { scope: "all_series", patch: { start: "2026-10-28T10:30:00-04:00" } });
    expect(linesNamed(masterLines(icsOf(plan)), "EXDATE")).toEqual(["EXDATE;TZID=America/New_York:20261103T103000"]);
    const starts = instancesBetween(load(icsOf(plan), newYork), Date.parse("2026-10-01T00:00:00Z"), Date.parse("2026-12-01T00:00:00Z"))
      .map((i) => formatForModel(i.start, newYork, "time"));
    expect(starts).toHaveLength(9);
    expect(starts[3]).toBe("2026-10-31T10:30:00-04:00");
    expect(starts[4]).toBe("2026-11-01T10:30:00-05:00");
    expect(starts).not.toContain("2026-11-03T10:30:00-05:00");
  });

  it("«весь день» при переопределениях — отказ invalid-time", () => {
    const o = load(calendar(MOSCOW, vevent(WEEKLY), override("20261026T100000", "20261026T100000", "20261026T110000")));
    expect(refusal(() => update(o, { scope: "all_series", patch: { allDay: true } })).code).toBe("invalid-time");
  });

  it("«весь день» без переопределений: EXDATE и UNTIL переходят в форму DATE (О4)", () => {
    const o = load(calendar(MOSCOW, vevent(["DTSTART;TZID=Europe/Moscow:20261019T100000", "DTEND;TZID=Europe/Moscow:20261019T110000",
      "RRULE:FREQ=DAILY;UNTIL=20261025T070000Z", "EXDATE;TZID=Europe/Moscow:20261021T100000", "SUMMARY:Дежурство"])));
    const plan = update(o, { scope: "all_series", patch: { allDay: true } });
    const master = masterLines(icsOf(plan));
    expect(linesNamed(master, "DTSTART")).toEqual(["DTSTART;VALUE=DATE:20261019"]);
    expect(linesNamed(master, "EXDATE")).toEqual(["EXDATE;VALUE=DATE:20261021"]);
    expect(linesNamed(master, "RRULE")).toEqual(["RRULE:FREQ=DAILY;UNTIL=20261025"]);
    expect(visible(after(plan)).map((line) => line.slice(0, 10))).toEqual(
      ["2026-10-19", "2026-10-20", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25"]);
  });

  it("SEQUENCE +1 у своей встречи при смене времени, у чужого организатора — нет (О10)", () => {
    const own = update(weekly(["SEQUENCE:3", "ORGANIZER:mailto:user@yandex.ru"]), {
      scope: "all_series", patch: { start: "2026-10-19T11:00:00+03:00" },
    });
    expect(linesNamed(masterLines(icsOf(own)), "SEQUENCE")).toEqual(["SEQUENCE:4"]);
    const foreign = update(weekly(["SEQUENCE:3", "ORGANIZER:mailto:boss@example.com"]), {
      scope: "all_series", patch: { start: "2026-10-19T11:00:00+03:00" },
    });
    expect(linesNamed(masterLines(icsOf(foreign)), "SEQUENCE")).toEqual(["SEQUENCE:3"]);
  });

  describe("сдвиг серии и отступления других клиентов", () => {
    const DAILY_MSK = ["DTSTART;TZID=Europe/Moscow:20261019T100000", "DTEND;TZID=Europe/Moscow:20261019T110000",
      "RRULE:FREQ=DAILY;COUNT=12", "SUMMARY:Планёрка"];

    it("оторванная встреча идёт за сдвигом и остаётся оторванной; скрытая — под своим EXDATE", () => {
      const detached = override("20261022T103000", "20261022T103000", "20261022T113000", "SUMMARY:Чужое");
      const hidden = override("20261024T100000", "20261024T100000", "20261024T110000", "SUMMARY:След");
      const o = load(calendar(MOSCOW, vevent([...DAILY_MSK, "EXDATE;TZID=Europe/Moscow:20261024T100000"]), detached, hidden));
      const plan = update(o, { scope: "all_series", patch: { start: "2026-10-19T12:00:00+03:00" } });
      const ics = icsOf(plan);
      expect(overrideLines(ics, "20261022T123000")).toEqual(expect.arrayContaining([
        "DTSTART;TZID=Europe/Moscow:20261022T123000", "DTEND;TZID=Europe/Moscow:20261022T133000",
      ]));
      expect(linesNamed(masterLines(ics), "EXDATE")).toEqual(["EXDATE;TZID=Europe/Moscow:20261024T120000"]);
      expect(overrideLines(ics, "20261024T120000")).toEqual(expect.arrayContaining([
        "SUMMARY:След", "DTSTART;TZID=Europe/Moscow:20261024T120000", "DTEND;TZID=Europe/Moscow:20261024T130000",
      ]));
      const next = after(plan);
      expect(visible(next).filter((line) => line.includes("Чужое"))).toEqual([
        "2026-10-22T12:30:00+03:00 → 2026-10-22T12:30:00+03:00–13:30 Чужое",
      ]);
      expect(visible(next).some((line) => line.includes("След"))).toBe(false);
    });

    it("RDATE сдвигается на ту же стенную разницу", () => {
      const o = load(calendar(MOSCOW, vevent([...DAILY_MSK.slice(0, 2), "RRULE:FREQ=WEEKLY;COUNT=2", "SUMMARY:Планёрка",
        "RDATE;TZID=Europe/Moscow:20261022T100000"])));
      const plan = update(o, { scope: "all_series", patch: { start: "2026-10-19T09:30:00+03:00" } });
      expect(linesNamed(masterLines(icsOf(plan)), "RDATE")).toEqual(["RDATE;TZID=Europe/Moscow:20261022T093000"]);
      expect(visible(after(plan)).map((line) => line.slice(28, 44))).toEqual(["2026-10-19T09:30", "2026-10-22T09:30", "2026-10-26T09:30"]);
    });

    it("смена пояса: оторванная встреча совпала бы со встречей серии — отказ, записи нет", () => {
      // 28.10 11:00 МСК = 08:00Z; после смены пояса встреча серии 28.10 — 09:00 CET = 08:00Z.
      const o = load(calendar(MOSCOW, vevent(DAILY_MSK), override("20261028T110000", "20261028T110000", "20261028T120000")));
      expect(refusal(() => update(o, { scope: "all_series", patch: { timeZone: "Europe/Berlin" } })).code).toBe("unsynced-rule");
    });

    it("смена пояса: EXDATE мимо встреч совпал бы со встречей и скрыл её — отказ", () => {
      const o = load(calendar(MOSCOW, vevent([...DAILY_MSK, "EXDATE;TZID=Europe/Moscow:20261028T110000"])));
      expect(refusal(() => update(o, { scope: "all_series", patch: { timeZone: "Europe/Berlin" } })).code).toBe("unsynced-rule");
    });

    it("смена правила: EXDATE мимо встреч, держащий скрытое переопределение, остаётся", () => {
      const hidden = override("20261022T150000", "20261022T150000", "20261022T160000", "SUMMARY:След");
      const o = load(calendar(MOSCOW, vevent([...DAILY_MSK, "EXDATE;TZID=Europe/Moscow:20261022T150000"]), hidden));
      const plan = update(o, { scope: "all_series", patch: { recurrence: { count: 14 } } });
      const ics = icsOf(plan);
      expect(linesNamed(masterLines(ics), "EXDATE")).toEqual(["EXDATE;TZID=Europe/Moscow:20261022T150000"]);
      expect(overrideLines(ics, "20261022T150000")).toContain("SUMMARY:След");
      expect(visible(after(plan))).toHaveLength(14);
    });
  });

  it("плавающая серия и серия в UTC: значения — в своей форме (О4)", () => {
    const floating = load(calendar([], vevent(["DTSTART:20261019T100000", "DTEND:20261019T110000", "RRULE:FREQ=DAILY;UNTIL=20261025T100000",
      "EXDATE:20261021T100000", "SUMMARY:Плавающая"])));
    const f = masterLines(icsOf(update(floating, { scope: "all_series", patch: { start: "2026-10-19T11:00:00" } })));
    expect(linesNamed(f, "DTSTART")).toEqual(["DTSTART:20261019T110000"]);
    expect(linesNamed(f, "EXDATE")).toEqual(["EXDATE:20261021T110000"]);
    expect(linesNamed(f, "RRULE")).toEqual(["RRULE:FREQ=DAILY;UNTIL=20261025T110000"]);

    const utc = load(calendar([], vevent(["DTSTART:20261019T070000Z", "DTEND:20261019T080000Z", "RRULE:FREQ=DAILY;COUNT=5", "SUMMARY:UTC"])));
    const u = masterLines(icsOf(remove(utc, { scope: "this", instanceStart: "2026-10-21T10:00:00+03:00" })));
    expect(linesNamed(u, "EXDATE")).toEqual(["EXDATE:20261021T070000Z"]);
  });

  it("серия на весь день: start с другой датой — дата прежняя, notice", () => {
    const o = load(calendar([], vevent(["DTSTART;VALUE=DATE:20261019", "DTEND;VALUE=DATE:20261020", "RRULE:FREQ=WEEKLY;COUNT=3", "SUMMARY:Отчёт"])));
    const plan = update(o, { scope: "all_series", patch: { start: "2026-10-21", end: "2026-10-23" } });
    const master = masterLines(icsOf(plan));
    expect(linesNamed(master, "DTSTART")).toEqual(["DTSTART;VALUE=DATE:20261019"]);
    expect(linesNamed(master, "DTEND")).toEqual(["DTEND;VALUE=DATE:20261021"]);
    expect(plan.notices.join(" ")).toContain("2026-10-21");
  });

  it("смена пояса, при которой RDATE сливается со слотом правила, — отказ, записи нет", () => {
    const o = load(calendar(MOSCOW, vevent(["DTSTART;TZID=Europe/Moscow:20261019T100000", "DTEND;TZID=Europe/Moscow:20261019T103000",
      "RRULE:FREQ=DAILY;COUNT=10", "RDATE;TZID=Europe/Moscow:20261026T110000", "SUMMARY:Планёрка"])));
    expect(refusal(() => update(o, { scope: "all_series", patch: { timeZone: "Europe/Berlin" } })).code).toBe("unsynced-rule");
  });
});

// ─────────────────────────────── серия: update this_and_following ───────────────────────────────

describe("серия: update this_and_following (разрез, Р9)", () => {
  const B = "2026-10-26T10:00:00+03:00";
  const B_KEY = at(B);

  it("разрез: продолжение с новым UID, исходная усечена COUNT, переопределения и EXDATE ≥ B переехали", () => {
    const early = override("20261021T100000", "20261021T100000", "20261021T110000", "SUMMARY:Своё");
    const moved = override("20261102T100000", "20261103T100000", "20261103T110000", "SUMMARY:Планёрка");
    const late = override("20261104T100000", "20261104T100000", "20261104T110000", "SUMMARY:Своё-2");
    const source = calendar(MOSCOW,
      vevent([...WEEKLY, "EXDATE;TZID=Europe/Moscow:20261028T100000", "SEQUENCE:2", "CREATED:20261001T090000Z"]),
      early, moved, late);
    const plan = split(update(load(source), { scope: "this_and_following", instanceStart: B, patch: { summary: "Хвост" } }));

    expect(plan.boundary).toBe(B_KEY);
    expect(plan.continuation.uid).toBe(continuationUid(UID, B_KEY));

    const truncated = plan.truncated.ics;
    expect(linesNamed(masterLines(truncated), "RRULE")).toEqual(["RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=2"]);
    expect(linesNamed(masterLines(truncated), "EXDATE")).toEqual([]);
    expect(events(truncated)).toHaveLength(2);
    expect(visible(load(truncated))).toEqual([WEEKLY_ROWS[0], weeklyRow("2026-10-21", "Своё")]);

    const tail = plan.continuation.ics;
    const master = masterLines(tail);
    expect(master).toEqual(expect.arrayContaining([
      `UID:${plan.continuation.uid}`, "DTSTART;TZID=Europe/Moscow:20261026T100000", "DTEND;TZID=Europe/Moscow:20261026T110000",
      "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=4", "EXDATE;TZID=Europe/Moscow:20261028T100000", "SUMMARY:Хвост", STAMP,
    ]));
    expect(linesNamed(master, "SEQUENCE")).toEqual([]);
    expect(linesNamed(master, "CREATED")).toEqual([]);
    expect(events(tail).every((lines) => lines.includes(`UID:${plan.continuation.uid}`))).toBe(true);
    expect(visible(load(tail))).toEqual([
      weeklyRow("2026-10-26", "Хвост"),
      weeklyRow("2026-11-02", "Хвост", "10:00", "11:00", "2026-11-03"),
      weeklyRow("2026-11-04", "Своё-2"),
    ]);
    expect(plan.expect.ruleChanged).toBe(true);
    expect(plan.expect.datesFixed).toBe(true);
    // tail разреза — протяжённость продолжения: 4 слота (28.10 закрыт EXDATE), последний 04.11.
    expect(plan.expect.tail).toEqual({ count: 4, lastDate: "2026-11-04" });
  });

  it("C49: удалённая 04.11 при смене времени не воскресает — EXDATE сдвинут в продолжении, EXDATE до B — только в исходной", () => {
    const o = weekly(["EXDATE;TZID=Europe/Moscow:20261021T100000", "EXDATE;TZID=Europe/Moscow:20261104T100000"]);
    const plan = split(update(o, {
      scope: "this_and_following", instanceStart: B, patch: { start: "2026-10-26T12:00:00+03:00", end: "2026-10-26T13:00:00+03:00" },
    }));
    expect(linesNamed(masterLines(plan.continuation.ics), "EXDATE")).toEqual(["EXDATE;TZID=Europe/Moscow:20261104T120000"]);
    expect(linesNamed(masterLines(plan.truncated.ics), "EXDATE")).toEqual(["EXDATE;TZID=Europe/Moscow:20261021T100000"]);
    expect(visible(load(plan.continuation.ics))).toEqual([
      "2026-10-26T12:00:00+03:00 → 2026-10-26T12:00:00+03:00–13:00 Планёрка",
      "2026-10-28T12:00:00+03:00 → 2026-10-28T12:00:00+03:00–13:00 Планёрка",
      "2026-11-02T12:00:00+03:00 → 2026-11-02T12:00:00+03:00–13:00 Планёрка",
    ]);
  });

  it("дата из start без recurrence не применяется: продолжение с даты B, notice", () => {
    const plan = split(update(weekly(), { scope: "this_and_following", instanceStart: B, patch: { start: "2026-10-27T12:00:00+03:00" } }));
    expect(linesNamed(masterLines(plan.continuation.ics), "DTSTART")).toEqual(["DTSTART;TZID=Europe/Moscow:20261026T120000"]);
    expect(plan.notices.join(" ")).toContain("2026-10-27");
  });

  it("серия с UNTIL: UNTIL продолжения пересчитан по последней встрече, исходной — перед B", () => {
    const o = load(calendar(MOSCOW, vevent(["DTSTART;TZID=Europe/Moscow:20261019T100000", "DTEND;TZID=Europe/Moscow:20261019T110000",
      "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20261104T070000Z", "SUMMARY:Планёрка"])));
    const plan = split(update(o, { scope: "this_and_following", instanceStart: B, patch: { start: "2026-10-26T11:00:00+03:00" } }));
    expect(linesNamed(masterLines(plan.truncated.ics), "RRULE")).toEqual(["RRULE:FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20261026T065959Z"]);
    expect(linesNamed(masterLines(plan.continuation.ics), "RRULE")).toEqual(["RRULE:FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20261104T080000Z"]);
    expect(visible(load(plan.continuation.ics)).map((line) => line.slice(28, 44))).toEqual([
      "2026-10-26T11:00", "2026-10-28T11:00", "2026-11-02T11:00", "2026-11-04T11:00",
    ]);
  });

  it("переопределение самой границы получает поля патча безусловно", () => {
    const own = override("20261026T100000", "20261026T100000", "20261026T110000", "SUMMARY:Своё");
    const plan = split(update(load(calendar(MOSCOW, vevent(WEEKLY), own)), {
      scope: "this_and_following", instanceStart: B, patch: { summary: "Хвост" },
    }));
    expect(visible(load(plan.continuation.ics))[0]).toBe(weeklyRow("2026-10-26", "Хвост"));
  });

  it("встреча до B, перенесённая за B, остаётся в исходной — notice", () => {
    const moved = override("20261021T100000", "20261029T100000", "20261029T110000");
    const plan = split(update(load(calendar(MOSCOW, vevent(WEEKLY), moved)), {
      scope: "this_and_following", instanceStart: B, patch: { summary: "Хвост" },
    }));
    expect(visible(load(plan.truncated.ics))[1]).toBe(weeklyRow("2026-10-21", "Планёрка", "10:00", "11:00", "2026-10-29"));
    expect(plan.notices.join(" ")).toContain("2026-10-21T10:00:00+03:00");
  });

  it("с первой видимой встречи — вся серия с тем же UID, без разреза (Р2)", () => {
    const first = update(weekly(), { scope: "this_and_following", instanceStart: "2026-10-19T10:00:00+03:00", patch: { summary: "Все" } });
    expect(first.kind).toBe("put");
    expect(visible(after(first)).every((line) => line.endsWith("Все"))).toBe(true);

    const excluded = weekly(["EXDATE;TZID=Europe/Moscow:20261019T100000"]);
    const second = update(excluded, { scope: "this_and_following", instanceStart: "2026-10-21T10:00:00+03:00", patch: { summary: "Все" } });
    expect(second.kind).toBe("put");
    expect(masterLines(icsOf(second))).toContain(`UID:${UID}`);
  });

  it("C51: разрез серии с чужим участником — needsConfirm, с confirm — продолжение с участником", () => {
    const o = weekly(["ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:guest@example.com"]);
    const error = refusal(() => update(o, { scope: "this_and_following", instanceStart: B, patch: { location: "Зал" } }));
    expect(error.needsConfirm).toBe(true);
    expect(error.message).toContain("guest@example.com");
    const plan = split(update(o, {
      scope: "this_and_following", instanceStart: B, patch: { location: "Зал" }, confirm: true, etag: ETAG, currentEtag: ETAG,
    }));
    expect(masterLines(plan.continuation.ics)).toContain("ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:guest@example.com");
  });

  it("граница — оторванное переопределение: отказ", () => {
    const o = load(calendar(MOSCOW, vevent(WEEKLY), override("20261022T100000", "20261022T100000", "20261022T110000")));
    const error = refusal(() => update(o, { scope: "this_and_following", instanceStart: "2026-10-22T10:00:00+03:00", patch: { summary: "Х" } }));
    expect(error.code).toBe("invalid-field");
  });

  it("split-mismatch: при смене пояса RDATE сливается со слотом продолжения — отказ", () => {
    const o = load(calendar(MOSCOW, vevent(["DTSTART;TZID=Europe/Moscow:20261019T100000", "DTEND;TZID=Europe/Moscow:20261019T103000",
      "RRULE:FREQ=DAILY;COUNT=10", "RDATE;TZID=Europe/Moscow:20261026T110000", "SUMMARY:Планёрка"])));
    const error = refusal(() => update(o, {
      scope: "this_and_following", instanceStart: "2026-10-21T10:00:00+03:00", patch: { timeZone: "Europe/Berlin" },
    }));
    expect(error.code).toBe("split-mismatch");
  });

  it("переход часов в Берлине: продолжение в 11:00 и за переходом, EXDATE на своём дне", () => {
    const berlin: IcalEnv = { floatingZone: "Europe/Berlin", ownerEmail: "user@yandex.ru" };
    const o = load(calendar(BERLIN_ZONE, vevent(["DTSTART;TZID=Europe/Berlin:20261021T100000", "DTEND;TZID=Europe/Berlin:20261021T110000",
      "RRULE:FREQ=DAILY;COUNT=10", "EXDATE;TZID=Europe/Berlin:20261027T100000", "SUMMARY:Стендап"])), berlin);
    const plan = split(update(o, { scope: "this_and_following", instanceStart: "2026-10-24T10:00:00+02:00", patch: { start: "2026-10-24T11:00:00+02:00" } }));
    expect(linesNamed(masterLines(plan.continuation.ics), "EXDATE")).toEqual(["EXDATE;TZID=Europe/Berlin:20261027T110000"]);
    expect(linesNamed(masterLines(plan.continuation.ics), "RRULE")).toEqual(["RRULE:FREQ=DAILY;COUNT=7"]);
    const rows = instancesBetween(load(plan.continuation.ics, berlin), Date.parse("2026-10-01T00:00:00Z"), Date.parse("2026-12-01T00:00:00Z"))
      .map((i) => formatForModel(i.start, berlin, "time"));
    expect(rows).toEqual([
      "2026-10-24T11:00:00+02:00", "2026-10-25T11:00:00+01:00", "2026-10-26T11:00:00+01:00",
      "2026-10-28T11:00:00+01:00", "2026-10-29T11:00:00+01:00", "2026-10-30T11:00:00+01:00",
    ]);
  });

  it("серия на весь день: продолжение с EXDATE;VALUE=DATE, исходная — UNTIL датой", () => {
    const o = load(calendar([], vevent(["DTSTART;VALUE=DATE:20261019", "DTEND;VALUE=DATE:20261020", "RRULE:FREQ=DAILY;UNTIL=20261030",
      "EXDATE;VALUE=DATE:20261025", "SUMMARY:Дежурство"])));
    const plan = split(update(o, { scope: "this_and_following", instanceStart: "2026-10-22", patch: { summary: "Новое" } }));
    expect(linesNamed(masterLines(plan.truncated.ics), "RRULE")).toEqual(["RRULE:FREQ=DAILY;UNTIL=20261021"]);
    const tail = masterLines(plan.continuation.ics);
    expect(linesNamed(tail, "DTSTART")).toEqual(["DTSTART;VALUE=DATE:20261022"]);
    expect(linesNamed(tail, "EXDATE")).toEqual(["EXDATE;VALUE=DATE:20261025"]);
    expect(linesNamed(tail, "RRULE")).toEqual(["RRULE:FREQ=DAILY;UNTIL=20261030"]);
  });

  it("скрытое переопределение ≥ B переходит в продолжение и остаётся скрытым", () => {
    const hidden = override("20261028T100000", "20261028T100000", "20261028T110000", "SUMMARY:След");
    const o = load(calendar(MOSCOW, vevent([...WEEKLY, "EXDATE;TZID=Europe/Moscow:20261028T100000"]), hidden));
    const plan = split(update(o, { scope: "this_and_following", instanceStart: B, patch: { start: "2026-10-26T12:00:00+03:00" } }));
    expect(overrideLines(plan.continuation.ics, "20261028T120000")).toContain("SUMMARY:След");
    expect(visible(load(plan.continuation.ics)).some((line) => line.includes("След"))).toBe(false);
  });

  it("с recurrence: правило продолжения меняется, переопределение без пары — needsConfirm", () => {
    const own = override("20261104T100000", "20261104T100000", "20261104T110000", "SUMMARY:Своё");
    const o = load(calendar(MOSCOW, vevent(WEEKLY), own));
    const error = refusal(() => update(o, { scope: "this_and_following", instanceStart: B, patch: { recurrence: { count: 2 } } }));
    expect(error.needsConfirm).toBe(true);
    expect(error.losses.map((loss) => loss.instanceStart)).toEqual(["2026-11-04T10:00:00+03:00"]);

    const plan = split(update(weekly(), { scope: "this_and_following", instanceStart: B, patch: { recurrence: { count: 2 } } }));
    expect(linesNamed(masterLines(plan.continuation.ics), "RRULE")).toEqual(["RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=2"]);
    expect(visible(load(plan.continuation.ics)).map((line) => line.slice(0, 10))).toEqual(["2026-10-26", "2026-10-28"]);
    expect(plan.expect.datesFixed).toBe(false);
  });

  it("оторванная встреча до B, оказавшаяся бы за концом усечённой серии, — needsConfirm", () => {
    const o = load(calendar(MOSCOW, vevent(WEEKLY), override("20261023T100000", "20261023T100000", "20261023T110000", "SUMMARY:Чужое")));
    const error = refusal(() => update(o, { scope: "this_and_following", instanceStart: B, patch: { summary: "Хвост" } }));
    expect(error.needsConfirm).toBe(true);
    expect(error.losses.map((loss) => loss.instanceStart)).toEqual(["2026-10-23T10:00:00+03:00"]);
    const plan = split(update(o, {
      scope: "this_and_following", instanceStart: B, patch: { summary: "Хвост" }, confirm: true, etag: ETAG, currentEtag: ETAG,
    }));
    // Компонент не удаляется: теряется только видимость, данные остаются скрытыми.
    expect(overrideLines(plan.truncated.ics, "20261023T100000")).toContain("SUMMARY:Чужое");
    expect(visible(load(plan.truncated.ics)).some((line) => line.includes("Чужое"))).toBe(false);
    expect(plan.removed.map((loss) => loss.instanceStart)).toEqual(["2026-10-23T10:00:00+03:00"]);
    expect(plan.expect.removed).toContain(at("2026-10-23T10:00:00+03:00"));
  });

  it("C62: основной с DURATION — у клона и продолжения только DURATION, без DTEND", () => {
    const o = load(calendar(MOSCOW, vevent(["DTSTART;TZID=Europe/Moscow:20261019T100000", "DURATION:PT1H",
      "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6", "SUMMARY:Планёрка"])));
    const clone = overrideLines(icsOf(update(o, { instanceStart: B, patch: { summary: "Ретро" } })), "20261026T100000");
    expect(linesNamed(clone, "DURATION")).toEqual(["DURATION:PT1H"]);
    expect(linesNamed(clone, "DTEND")).toEqual([]);
    const plan = split(update(o, { scope: "this_and_following", instanceStart: B, patch: { start: "2026-10-26T12:00:00+03:00" } }));
    const master = masterLines(plan.continuation.ics);
    expect(linesNamed(master, "DURATION")).toEqual(["DURATION:PT1H"]);
    expect(linesNamed(master, "DTEND")).toEqual([]);
    expect(visible(load(plan.continuation.ics))[0]).toBe("2026-10-26T12:00:00+03:00 → 2026-10-26T12:00:00+03:00–13:00 Планёрка");
  });

  it("продолжение несёт VTIMEZONE пояса, описанного только в объекте", () => {
    const PLUS5 = ["BEGIN:VTIMEZONE", "TZID:Custom/Plus5", "BEGIN:STANDARD", "TZOFFSETFROM:+0500", "TZOFFSETTO:+0500",
      "DTSTART:19700101T000000", "END:STANDARD", "END:VTIMEZONE"];
    const o = load(calendar(PLUS5, vevent(["DTSTART;TZID=Custom/Plus5:20261019T100000", "DTEND;TZID=Custom/Plus5:20261019T110000",
      "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6", "SUMMARY:Планёрка"])));
    const plan = split(update(o, { scope: "this_and_following", instanceStart: "2026-10-26T10:00:00+05:00", patch: { start: "2026-10-26T12:00:00+05:00" } }));
    expect(plan.continuation.ics).toContain("TZID:Custom/Plus5");
    expect(linesNamed(masterLines(plan.continuation.ics), "DTEND")).toEqual(["DTEND;TZID=Custom/Plus5:20261026T130000"]);
    expect(visible(load(plan.continuation.ics))[0]).toBe("2026-10-26T12:00:00+05:00 → 2026-10-26T12:00:00+05:00–13:00 Планёрка");
  });

  it("исходный объект без VTIMEZONE: в продолжение описание пояса добавляется (О12а)", () => {
    const o = load(calendar([], vevent(WEEKLY)));
    const plan = split(update(o, { scope: "this_and_following", instanceStart: B, patch: { summary: "Хвост" } }));
    expect(plan.continuation.ics).toContain("TZID:Europe/Moscow");
    expect(plan.continuation.ics).toContain("BEGIN:VTIMEZONE");
  });

  it("новое время хвоста не на позиции правила (BYHOUR) — отказ, записи нет", () => {
    const o = load(calendar(MOSCOW, vevent(["DTSTART;TZID=Europe/Moscow:20261019T100000", "DTEND;TZID=Europe/Moscow:20261019T110000",
      "RRULE:FREQ=DAILY;BYHOUR=10;COUNT=10", "SUMMARY:Планёрка"])));
    const error = refusal(() => update(o, { scope: "this_and_following", instanceStart: "2026-10-22T10:00:00+03:00", patch: { start: "2026-10-22T11:00:00+03:00" } }));
    expect(error.code).toBe("unsynced-rule");
  });

  it("до B только оторванная встреча — разрез, а не правка всей серии", () => {
    const o = load(calendar(MOSCOW, vevent([...WEEKLY, "EXDATE;TZID=Europe/Moscow:20261019T100000", "EXDATE;TZID=Europe/Moscow:20261021T100000"]),
      override("20261020T100000", "20261020T100000", "20261020T110000", "SUMMARY:Чужое")));
    expect(update(o, { scope: "this_and_following", instanceStart: B, patch: { summary: "Хвост" } }).kind).toBe("split");
  });

  it("серия только из RDATE: граница — DTSTART продолжения, её значение RDATE не дублируется", () => {
    const o = load(calendar(MOSCOW, vevent(["DTSTART;TZID=Europe/Moscow:20261019T100000", "DTEND;TZID=Europe/Moscow:20261019T110000",
      "RDATE;TZID=Europe/Moscow:20261021T100000,20261023T100000,20261026T100000", "SUMMARY:Встречи"])));
    const plan = split(update(o, { scope: "this_and_following", instanceStart: "2026-10-23T10:00:00+03:00", patch: { summary: "Позже" } }));
    const tail = masterLines(plan.continuation.ics);
    expect(linesNamed(tail, "DTSTART")).toEqual(["DTSTART;TZID=Europe/Moscow:20261023T100000"]);
    expect(linesNamed(tail, "RDATE")).toEqual(["RDATE;TZID=Europe/Moscow:20261026T100000"]);
    expect(linesNamed(masterLines(plan.truncated.ics), "RDATE")).toEqual(["RDATE;TZID=Europe/Moscow:20261021T100000"]);
  });

  it("allDay у хвоста: продолжение на весь день с даты B, EXDATE — датой", () => {
    const o = load(calendar(MOSCOW, vevent(["DTSTART;TZID=Europe/Moscow:20261019T100000", "DTEND;TZID=Europe/Moscow:20261019T110000",
      "RRULE:FREQ=DAILY;COUNT=6", "EXDATE;TZID=Europe/Moscow:20261022T100000", "SUMMARY:А"])));
    const plan = split(update(o, { scope: "this_and_following", instanceStart: "2026-10-21T10:00:00+03:00", patch: { allDay: true } }));
    const tail = masterLines(plan.continuation.ics);
    expect(linesNamed(tail, "DTSTART")).toEqual(["DTSTART;VALUE=DATE:20261021"]);
    expect(linesNamed(tail, "EXDATE")).toEqual(["EXDATE;VALUE=DATE:20261022"]);
    expect(linesNamed(tail, "RRULE")).toEqual(["RRULE:FREQ=DAILY;COUNT=4"]);
    expect(visible(load(plan.continuation.ics)).map((line) => line.slice(0, 10))).toEqual(["2026-10-21", "2026-10-23", "2026-10-24"]);
  });

  it("с recurrence дата из start применяется: хвост со вторника 27.10 по вторникам", () => {
    const plan = split(update(weekly(), {
      scope: "this_and_following",
      instanceStart: B,
      patch: { start: "2026-10-27T10:00:00+03:00", recurrence: { byWeekday: ["TU"] } },
    }));
    const tail = masterLines(plan.continuation.ics);
    expect(linesNamed(tail, "DTSTART")).toEqual(["DTSTART;TZID=Europe/Moscow:20261027T100000"]);
    expect(linesNamed(tail, "RRULE")).toEqual(["RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=4"]);
    expect(visible(load(plan.continuation.ics)).map((line) => line.slice(0, 10))).toEqual(["2026-10-27", "2026-11-03", "2026-11-10", "2026-11-17"]);
    expect(plan.notices.join(" ")).not.toContain("не применена");
  });

  it("C41: после продления усечённой серии повтор разреза даёт тот же UID и другое продолжение", () => {
    const first = split(update(weekly(), { scope: "this_and_following", instanceStart: B, patch: { summary: "Хвост" } }));
    const extended = update(load(first.truncated.ics), {
      scope: "all_series", patch: { recurrence: { until: "2026-11-30T23:59:59+03:00", count: null } },
    });
    const again = split(update(after(extended), { scope: "this_and_following", instanceStart: B, patch: { summary: "Хвост" } }));
    expect(again.continuation.uid).toBe(first.continuation.uid);
    expect(semanticDigest(again.continuation.ics, ENV)).not.toBe(semanticDigest(first.continuation.ics, ENV));
  });

  it("повтор того же разреза на исходном объекте даёт то же продолжение (дайджест)", () => {
    const once = split(update(weekly(), { scope: "this_and_following", instanceStart: B, patch: { summary: "Хвост" } }));
    const twice = split(update(weekly(), { scope: "this_and_following", instanceStart: B, patch: { summary: "Хвост" } }));
    expect(semanticDigest(twice.continuation.ics, ENV)).toBe(semanticDigest(once.continuation.ics, ENV));
  });
});

// ─────────────────────────────── серия: delete this ───────────────────────────────

describe("серия: delete this", () => {
  it("слот без переопределения: EXDATE в форме DTSTART, прочее цело", () => {
    const source = calendar(MOSCOW, vevent(WEEKLY));
    const plan = remove(load(source), { scope: "this", instanceStart: "2026-10-21T10:00:00+03:00" });
    expect(diff(source, icsOf(plan))).toEqual({
      removed: ["DTSTAMP:20261001T090000Z"],
      added: [STAMP, "EXDATE;TZID=Europe/Moscow:20261021T100000"],
    });
    expect(plan.removed.map((loss) => loss.instanceStart)).toEqual(["2026-10-21T10:00:00+03:00"]);
    expect(plan.expect.removed).toEqual([at("2026-10-21T10:00:00+03:00")]);
  });

  it("перенесённая встреча: сняты её компоненты (с дублями) и EXDATE на слот", () => {
    const a = override("20261026T100000", "20261027T100000", "20261027T110000", "SUMMARY:А", "SEQUENCE:1");
    const b = override("20261026T100000", "20261027T120000", "20261027T130000", "SUMMARY:Б", "SEQUENCE:2");
    const plan = remove(load(calendar(MOSCOW, vevent(WEEKLY), a, b)), { scope: "this", instanceStart: "2026-10-26T10:00:00+03:00" });
    const ics = icsOf(plan);
    expect(events(ics)).toHaveLength(1);
    expect(linesNamed(masterLines(ics), "EXDATE")).toEqual(["EXDATE;TZID=Europe/Moscow:20261026T100000"]);
    expect(plan.removed.map((loss) => [loss.start, loss.summary])).toEqual([["2026-10-27T12:00:00+03:00", "Б"]]);
  });

  it("встреча только из RDATE: снимается значение RDATE, EXDATE не ставится", () => {
    const plan = remove(weekly(["RDATE;TZID=Europe/Moscow:20261023T100000,20261030T100000"]), {
      scope: "this", instanceStart: "2026-10-23T10:00:00+03:00",
    });
    const master = masterLines(icsOf(plan));
    expect(linesNamed(master, "RDATE")).toEqual(["RDATE;TZID=Europe/Moscow:20261030T100000"]);
    expect(linesNamed(master, "EXDATE")).toEqual([]);
  });

  it("оторванное переопределение: снимается компонент, EXDATE нет", () => {
    const plan = remove(load(calendar(MOSCOW, vevent(WEEKLY), override("20261022T100000", "20261022T100000", "20261022T110000"))), {
      scope: "this", instanceStart: "2026-10-22T10:00:00+03:00",
    });
    expect(icsOf(plan)).toBe(calendar(MOSCOW, vevent(WEEKLY)));
  });

  it("скрытое переопределение: снимается только компонент", () => {
    const source = calendar(MOSCOW, vevent([...WEEKLY, "EXDATE;TZID=Europe/Moscow:20261028T100000"]),
      override("20261028T100000", "20261028T100000", "20261028T110000"));
    const plan = remove(load(source), { scope: "this", instanceStart: "2026-10-28T10:00:00+03:00" });
    expect(icsOf(plan)).toBe(calendar(MOSCOW, vevent([...WEEKLY, "EXDATE;TZID=Europe/Moscow:20261028T100000"])));
    expect(plan.expect.removed).toEqual([]);
  });

  describe("C42: последняя видимая встреча", () => {
    const TWO = ["DTSTART;TZID=Europe/Moscow:20261019T100000", "DTEND;TZID=Europe/Moscow:20261019T110000",
      "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=2", "SUMMARY:Планёрка", "EXDATE;TZID=Europe/Moscow:20261019T100000"];

    it("со скрытым переопределением — удаление объекта, скрытое в removed", () => {
      const o = load(calendar(MOSCOW, vevent(TWO), override("20261019T100000", "20261019T100000", "20261019T110000", "SUMMARY:След")));
      const plan = remove(o, { scope: "this", instanceStart: "2026-10-21T10:00:00+03:00" });
      expect(plan.kind).toBe("delete-object");
      expect(plan.removed.map((loss) => [loss.instanceStart, loss.summary])).toEqual([
        ["2026-10-21T10:00:00+03:00", "Планёрка"],
        ["2026-10-19T10:00:00+03:00", "След"],
      ]);
    });

    it("с оторванной встречей — объект жив", () => {
      const o = load(calendar(MOSCOW, vevent(TWO), override("20261020T100000", "20261020T100000", "20261020T110000", "SUMMARY:Чужое")));
      const plan = remove(o, { scope: "this", instanceStart: "2026-10-21T10:00:00+03:00" });
      expect(visible(after(plan))).toEqual(["2026-10-20T10:00:00+03:00 → 2026-10-20T10:00:00+03:00–11:00 Чужое"]);
    });
  });

  describe("C57: редкие серии не удаляются целиком", () => {
    const yearly = (rule: string, start: string) => load(calendar(MOSCOW, vevent([`DTSTART;TZID=Europe/Moscow:${start}T100000`,
      `DTEND;TZID=Europe/Moscow:${start}T110000`, `RRULE:${rule}`, "SUMMARY:Планёрка"])));

    it("YEARLY;INTERVAL=2 без конца: удаление ближайшей — объект жив", () => {
      const plan = remove(yearly("FREQ=YEARLY;INTERVAL=2", "20261019"), { scope: "this", instanceStart: "2026-10-19T10:00:00+03:00" });
      expect(visible(after(plan), "2026-01-01T00:00:00+03:00", "2029-01-01T00:00:00+03:00"))
        .toEqual(["2028-10-19T10:00:00+03:00 → 2028-10-19T10:00:00+03:00–11:00 Планёрка"]);
    });

    it.each([
      ["FREQ=YEARLY;INTERVAL=2;COUNT=2", "20261019", "2026-10-19T10:00:00+03:00", "2028-10-19T10:00:00+03:00"],
      ["FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29;COUNT=2", "20280229", "2028-02-29T10:00:00+03:00", "2032-02-29T10:00:00+03:00"],
    ])("%s: удаление первой — объект жив, удаление последней — удаление объекта", (rule, start, first, last) => {
      const step1 = remove(yearly(rule, start), { scope: "this", instanceStart: first });
      expect(step1.kind).toBe("put");
      const step2 = remove(after(step1), { scope: "this", instanceStart: last });
      expect(step2.kind).toBe("delete-object");
    });
  });

  it("SEQUENCE +1 у своей встречи (EXDATE — значимая правка), у чужого организатора — нет", () => {
    const own = remove(weekly(["SEQUENCE:5", "ORGANIZER:mailto:USER@yandex.ru"]), { scope: "this", instanceStart: "2026-10-21T10:00:00+03:00" });
    expect(linesNamed(masterLines(icsOf(own)), "SEQUENCE")).toEqual(["SEQUENCE:6"]);
    const foreign = remove(weekly(["SEQUENCE:5", "ORGANIZER:mailto:boss@example.com"]), { scope: "this", instanceStart: "2026-10-21T10:00:00+03:00" });
    expect(linesNamed(masterLines(icsOf(foreign)), "SEQUENCE")).toEqual(["SEQUENCE:5"]);
  });

  it("серия без видимых встреч: снятие скрытого компонента объект не удаляет", () => {
    const TWO = ["DTSTART;TZID=Europe/Moscow:20261019T100000", "DTEND;TZID=Europe/Moscow:20261019T110000",
      "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=2", "SUMMARY:Планёрка",
      "EXDATE;TZID=Europe/Moscow:20261019T100000", "EXDATE;TZID=Europe/Moscow:20261021T100000"];
    const o = load(calendar(MOSCOW, vevent(TWO), override("20261019T100000", "20261019T100000", "20261019T110000", "SUMMARY:След")));
    const plan = remove(o, { scope: "this", instanceStart: "2026-10-19T10:00:00+03:00" });
    expect(plan.kind).toBe("put");
    expect(events(icsOf(plan))).toHaveLength(1);
  });

  it("ожидание для предохранителя: тронуты EXDATE и DTSTAMP основного и снятый компонент", () => {
    const o = load(calendar(MOSCOW, vevent(WEEKLY), override("20261026T100000", "20261027T100000", "20261027T110000")));
    const plan = remove(o, { scope: "this", instanceStart: "2026-10-26T10:00:00+03:00" });
    const names = [...plan.expect.touched.names.entries()].map(([c, set]) => `${c.name}:${[...set].sort().join(",")}`).sort();
    expect(names).toEqual(["vcalendar:vevent", "vevent:dtstamp,exdate"]);
    expect([...plan.expect.touched.components].map((c) => c.name)).toEqual(["vevent"]);
  });

  it("отменённая встреча (Р7): EXDATE на слот и снятие компонента", () => {
    const o = load(calendar(MOSCOW, vevent(WEEKLY), override("20261026T100000", "20261026T100000", "20261026T110000", "STATUS:CANCELLED")));
    const ics = icsOf(remove(o, { scope: "this", instanceStart: "2026-10-26T10:00:00+03:00" }));
    expect(events(ics)).toHaveLength(1);
    expect(linesNamed(masterLines(ics), "EXDATE")).toEqual(["EXDATE;TZID=Europe/Moscow:20261026T100000"]);
  });

  it("серия на весь день: EXDATE;VALUE=DATE", () => {
    const o = load(calendar([], vevent(["DTSTART;VALUE=DATE:20261019", "DTEND;VALUE=DATE:20261020", "RRULE:FREQ=DAILY;COUNT=5", "SUMMARY:Отпуск"])));
    const plan = remove(o, { scope: "this", instanceStart: "2026-10-21" });
    expect(linesNamed(masterLines(icsOf(plan)), "EXDATE")).toEqual(["EXDATE;VALUE=DATE:20261021"]);
  });

  it("серия с правилом без позиций — не одиночное событие: delete this отказ, all_series удаляет", () => {
    const o = load(calendar(MOSCOW, vevent(["DTSTART;TZID=Europe/Moscow:20260130T100000", "DTEND;TZID=Europe/Moscow:20260130T110000",
      "RRULE:FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30", "SUMMARY:Сломано"])));
    expect(o.kind).toBe("series");
    expect(refusal(() => remove(o, { scope: "this", instanceStart: "2026-01-30T10:00:00+03:00" })).code).toBe("no-positions");
    expect(refusal(() => remove(o, { instanceStart: "2026-01-30T10:00:00+03:00" })).code).toBe("no-positions");
    expect(remove(o, { scope: "all_series" }).kind).toBe("delete-object");
  });

  it("C08: адрес слота совпал с фактическим началом перенесённой — ambiguous; с confirm — удалён слот", () => {
    const moved = override("20261026T100000", "20261028T100000", "20261028T110000", "SUMMARY:Перенос");
    const o = load(calendar(MOSCOW, vevent(WEEKLY), moved));
    const error = addressRefusal(() => remove(o, { scope: "this", instanceStart: "2026-10-28T10:00:00+03:00" }));
    expect(error.code).toBe("ambiguous");
    const plan = remove(o, { scope: "this", instanceStart: "2026-10-28T10:00:00+03:00", confirm: true, etag: ETAG, currentEtag: ETAG });
    const ics = icsOf(plan);
    expect(linesNamed(masterLines(ics), "EXDATE")).toEqual(["EXDATE;TZID=Europe/Moscow:20261028T100000"]);
    expect(overrideLines(ics, "20261026T100000")).toContain("SUMMARY:Перенос");
  });

  it("серия без instanceStart — отказ invalid, объект не удаляется", () => {
    expect(addressRefusal(() => remove(weekly(), {})).code).toBe("invalid");
  });
});

// ─────────────────────────────── серия: delete this_and_following ───────────────────────────────

describe("серия: delete this_and_following", () => {
  const B = "2026-10-26T10:00:00+03:00";

  it("усечение COUNT: EXDATE и переопределения ≥ B сняты, до B — целы", () => {
    const early = override("20261021T100000", "20261021T100000", "20261021T110000", "SUMMARY:Своё");
    const late = override("20261102T100000", "20261102T120000", "20261102T130000", "SUMMARY:Позже");
    const o = load(calendar(MOSCOW, vevent([...WEEKLY, "EXDATE;TZID=Europe/Moscow:20261028T100000"]), early, late));
    const plan = remove(o, { scope: "this_and_following", instanceStart: B });
    const ics = icsOf(plan);
    expect(linesNamed(masterLines(ics), "RRULE")).toEqual(["RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=2"]);
    expect(linesNamed(masterLines(ics), "EXDATE")).toEqual([]);
    expect(events(ics)).toHaveLength(2);
    expect(visible(after(plan))).toEqual([WEEKLY_ROWS[0], weeklyRow("2026-10-21", "Своё")]);
    expect(plan.removed.map((loss) => loss.instanceStart)).toEqual([
      "2026-10-26T10:00:00+03:00", "2026-11-02T10:00:00+03:00", "2026-11-04T10:00:00+03:00",
    ]);
    expect(plan.expect.removed).toEqual([B, "2026-11-02T10:00:00+03:00", "2026-11-04T10:00:00+03:00"].map(at));
    expect(plan.expect.tail).toEqual({ count: 2, lastDate: "2026-10-21" });
  });

  it("бесконечная серия: UNTIL на секунду раньше B в UTC", () => {
    const o = load(calendar(MOSCOW, vevent(["DTSTART;TZID=Europe/Moscow:20261019T100000", "DTEND;TZID=Europe/Moscow:20261019T110000",
      "RRULE:FREQ=WEEKLY;BYDAY=MO,WE", "SUMMARY:Планёрка"])));
    const plan = remove(o, { scope: "this_and_following", instanceStart: B });
    expect(linesNamed(masterLines(icsOf(plan)), "RRULE")).toEqual(["RRULE:FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20261026T065959Z"]);
    expect(visible(after(plan))).toEqual(WEEKLY_ROWS.slice(0, 2));
    expect(plan.notices.join(" ")).toContain("следующие");
  });

  it("серия на весь день: UNTIL — дата накануне B", () => {
    const o = load(calendar([], vevent(["DTSTART;VALUE=DATE:20261019", "DTEND;VALUE=DATE:20261020", "RRULE:FREQ=DAILY", "SUMMARY:Отпуск"])));
    const plan = remove(o, { scope: "this_and_following", instanceStart: "2026-10-22" });
    expect(linesNamed(masterLines(icsOf(plan)), "RRULE")).toEqual(["RRULE:FREQ=DAILY;UNTIL=20261021"]);
  });

  it("COUNT — по позициям правила: EXDATE до границы их не сдвигает (R8-N2)", () => {
    const o = weekly(["EXDATE;TZID=Europe/Moscow:20261021T100000"]);
    const plan = remove(o, { scope: "this_and_following", instanceStart: "2026-10-28T10:00:00+03:00" });
    const master = masterLines(icsOf(plan));
    expect(linesNamed(master, "RRULE")).toEqual(["RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=3"]);
    expect(linesNamed(master, "EXDATE")).toEqual(["EXDATE;TZID=Europe/Moscow:20261021T100000"]);
    expect(visible(after(plan))).toEqual([WEEKLY_ROWS[0], WEEKLY_ROWS[2]]);
  });

  it("оторванная встреча до границы, которая оказалась бы за концом серии, — needsConfirm", () => {
    const detached = override("20261023T100000", "20261023T100000", "20261023T110000", "SUMMARY:Чужое");
    const o = load(calendar(MOSCOW, vevent(WEEKLY), detached));
    const error = refusal(() => remove(o, { scope: "this_and_following", instanceStart: B }));
    expect(error.needsConfirm).toBe(true);
    expect(error.losses.map((loss) => [loss.instanceStart, loss.summary])).toEqual([["2026-10-23T10:00:00+03:00", "Чужое"]]);
    const plan = remove(o, { scope: "this_and_following", instanceStart: B, confirm: true, etag: ETAG, currentEtag: ETAG });
    expect(overrideLines(icsOf(plan), "20261023T100000")).toContain("SUMMARY:Чужое");
    expect(visible(after(plan))).toEqual(WEEKLY_ROWS.slice(0, 2));
    expect(plan.removed.map((loss) => loss.instanceStart)).toContain("2026-10-23T10:00:00+03:00");
    expect(plan.expect.removed).toContain(at("2026-10-23T10:00:00+03:00"));
  });

  it("с первой видимой встречи, но встреча хвоста перенесена раньше границы — needsConfirm", () => {
    const o = load(calendar(MOSCOW, vevent([...WEEKLY, "EXDATE;TZID=Europe/Moscow:20261019T100000"]),
      override("20261026T100000", "20261020T100000", "20261020T110000", "SUMMARY:Перенос")));
    const error = refusal(() => remove(o, { scope: "this_and_following", instanceStart: "2026-10-21T10:00:00+03:00" }));
    expect(error.needsConfirm).toBe(true);
    expect(error.losses.map((loss) => loss.start)).toEqual(["2026-10-20T10:00:00+03:00"]);
  });

  it("граница — оторванная встреча после UNTIL: прежний, более ранний UNTIL не продлевается", () => {
    const o = load(calendar(MOSCOW, vevent(["DTSTART;TZID=Europe/Moscow:20261019T100000", "DTEND;TZID=Europe/Moscow:20261019T110000",
      "RRULE:FREQ=WEEKLY;UNTIL=20261026T070000Z", "RDATE;TZID=Europe/Moscow:20261109T100000", "SUMMARY:Планёрка"]),
      override("20261104T100000", "20261104T100000", "20261104T110000", "SUMMARY:Чужое")));
    const plan = remove(o, { scope: "this_and_following", instanceStart: "2026-11-04T10:00:00+03:00" });
    const master = masterLines(icsOf(plan));
    expect(linesNamed(master, "RRULE")).toEqual(["RRULE:FREQ=WEEKLY;UNTIL=20261026T070000Z"]);
    expect(linesNamed(master, "RDATE")).toEqual([]);
    expect(visible(after(plan))).toEqual([WEEKLY_ROWS[0], WEEKLY_ROWS[2]]);
  });

  it("с первой видимой встречи — удаление объекта (Р2)", () => {
    const o = weekly(["EXDATE;TZID=Europe/Moscow:20261019T100000"]);
    const plan = remove(o, { scope: "this_and_following", instanceStart: "2026-10-21T10:00:00+03:00" });
    expect(plan.kind).toBe("delete-object");
  });

  describe("C50: встреча со слотом ≥ B, перенесённая раньше B", () => {
    const moved = override("20261104T100000", "20261027T100000", "20261027T110000", "SUMMARY:Перенос");
    const source = calendar(MOSCOW, vevent(WEEKLY), moved);

    it("без confirm — needsConfirm с этой встречей в losses", () => {
      const error = refusal(() => remove(load(source), { scope: "this_and_following", instanceStart: "2026-10-28T10:00:00+03:00" }));
      expect(error.needsConfirm).toBe(true);
      expect(error.losses.map((loss) => [loss.instanceStart, loss.start])).toEqual([
        ["2026-11-04T10:00:00+03:00", "2026-10-27T10:00:00+03:00"],
      ]);
    });

    it("с confirm и etag — усечение, перенесённая снята", () => {
      const plan = remove(load(source), {
        scope: "this_and_following", instanceStart: "2026-10-28T10:00:00+03:00", confirm: true, etag: ETAG, currentEtag: ETAG,
      });
      expect(linesNamed(masterLines(icsOf(plan)), "RRULE")).toEqual(["RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=3"]);
      expect(events(icsOf(plan))).toHaveLength(1);
    });

    it("confirm с устаревшим etag — отказ confirm-required с теми же потерями", () => {
      const error = refusal(() => remove(load(source), {
        scope: "this_and_following", instanceStart: "2026-10-28T10:00:00+03:00", confirm: true, etag: '"old"', currentEtag: ETAG,
      }));
      expect(error.code).toBe("confirm-required");
      expect(error.losses.map((loss) => loss.instanceStart)).toEqual(["2026-11-04T10:00:00+03:00"]);
    });
  });
});

// ─────────────────────────────── delete all_series, аномалии ───────────────────────────────

describe("delete all_series и аномалии", () => {
  it("удаление объекта; неразрешимый instanceStart — отказ (C46)", () => {
    expect(remove(weekly(), { scope: "all_series" }).kind).toBe("delete-object");
    expect(remove(weekly(), { scope: "all_series", instanceStart: "2026-10-26T10:00:00+03:00" }).kind).toBe("delete-object");
    expect(addressRefusal(() => remove(weekly(), { scope: "all_series", instanceStart: "2026-10-27T10:00:00+03:00" })).code).toBe("not-found");
  });

  it("неразбираемый объект (Р4): delete all_series — удаление, прочее — отказ unparsable", () => {
    const broken = loadObject(calendar(MOSCOW, vevent(["DTSTART;TZID=Europe/Moscow:20261019T100000", "RRULE:FREQ=FOO", "SUMMARY:Х"])), ENV);
    expect(broken.kind).toBe("unparsable");
    expect(remove(broken, { scope: "all_series" }).kind).toBe("delete-object");
    expect(refusal(() => remove(broken, { scope: "this", instanceStart: "2026-10-19T10:00:00+03:00" })).code).toBe("unparsable");
    expect(refusal(() => remove(broken, {})).code).toBe("unparsable");
    expect(refusal(() => remove(broken, { scope: "this_and_following" })).code).toBe("unparsable");
    expect(refusal(() => remove(broken, { scope: "all_series", instanceStart: "2026-10-19T10:00:00+03:00" })).code).toBe("unparsable");
    expect(refusal(() => update(broken, { scope: "all_series", patch: { summary: "Х" } })).code).toBe("unparsable");
  });

  it("два основных компонента: правка — отказ multiple-masters, delete all_series — удаление", () => {
    const o = load(calendar(MOSCOW, vevent(WEEKLY), vevent(WEEKLY)));
    expect(refusal(() => update(o, { scope: "all_series", patch: { summary: "Х" } })).code).toBe("multiple-masters");
    expect(refusal(() => remove(o, { scope: "this", instanceStart: "2026-10-19T10:00:00+03:00" })).code).toBe("multiple-masters");
    expect(remove(o, { scope: "all_series" }).kind).toBe("delete-object");
  });

  it("RANGE=THISANDFUTURE (Р7): любая правка и удаление встречи — отказ range-override, delete all_series — удаление", () => {
    const range = vevent(["RECURRENCE-ID;RANGE=THISANDFUTURE;TZID=Europe/Moscow:20261026T100000",
      "DTSTART;TZID=Europe/Moscow:20261026T120000", "DTEND;TZID=Europe/Moscow:20261026T130000", "SUMMARY:Сдвиг"]);
    const o = load(calendar(MOSCOW, vevent(WEEKLY), range));
    expect(refusal(() => update(o, { scope: "all_series", patch: { summary: "Х" } })).code).toBe("range-override");
    expect(refusal(() => remove(o, { scope: "this", instanceStart: "2026-10-19T10:00:00+03:00" })).code).toBe("range-override");
    expect(remove(o, { scope: "all_series" }).kind).toBe("delete-object");
  });

  it("дубли одного RID: правка слота — отказ duplicate-override, delete this — снимает все", () => {
    const o = load(calendar(MOSCOW, vevent(WEEKLY),
      override("20261026T100000", "20261026T100000", "20261026T110000"), override("20261026T100000", "20261026T120000", "20261026T130000")));
    expect(refusal(() => update(o, { instanceStart: "2026-10-26T10:00:00+03:00", patch: { summary: "Х" } })).code).toBe("duplicate-override");
    expect(events(icsOf(remove(o, { scope: "this", instanceStart: "2026-10-26T10:00:00+03:00" })))).toHaveLength(1);
  });
});

// ─────────────────────────────── правила, которые искажает Яндекс (Ж6) ───────────────────────────────

describe("BYSETPOS и WKST (Ж6, C16a, C16c)", () => {
  const LAST_WORKDAY = calendar(MOSCOW, vevent(["DTSTART;TZID=Europe/Moscow:20261030T170000", "DTEND;TZID=Europe/Moscow:20261030T180000",
    "RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;COUNT=3", "SUMMARY:Итоги месяца"]));

  it("правка полей всей серии и удаление одной встречи — правило дословно", () => {
    const renamed = update(load(LAST_WORKDAY), { scope: "all_series", patch: { summary: "Итоги" } });
    expect(linesNamed(masterLines(icsOf(renamed)), "RRULE")).toEqual(["RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;COUNT=3"]);
    const removed = remove(load(LAST_WORKDAY), { scope: "this", instanceStart: "2026-11-30T17:00:00+03:00" });
    expect(linesNamed(masterLines(icsOf(removed)), "RRULE")).toEqual(["RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;COUNT=3"]);
    expect(visible(after(removed), "2026-10-01T00:00:00+03:00", "2027-01-15T00:00:00+03:00").map((line) => line.slice(0, 10)))
      .toEqual(["2026-10-30", "2026-12-31"]);
  });

  it("смена конца правила, сдвиг с UNTIL и разрез — отказ unsupported-rule, записи нет", () => {
    const o = load(LAST_WORKDAY);
    expect(refusal(() => remove(o, { scope: "this_and_following", instanceStart: "2026-11-30T17:00:00+03:00" })).code).toBe("unsupported-rule");
    expect(refusal(() => update(o, { scope: "this_and_following", instanceStart: "2026-11-30T17:00:00+03:00", patch: { summary: "Х" } })).code)
      .toBe("unsupported-rule");
    const wkst = load(calendar(MOSCOW, vevent(["DTSTART;TZID=Europe/Moscow:20261020T100000", "DTEND;TZID=Europe/Moscow:20261020T110000",
      "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,SU;WKST=SU;UNTIL=20261231T070000Z", "SUMMARY:Спринт"])));
    expect(refusal(() => update(wkst, { scope: "all_series", patch: { start: "2026-10-20T11:00:00+03:00" } })).code).toBe("unsupported-rule");
  });
});

// ─────────────────────────────── объект из одних переопределений (Р6) ───────────────────────────────

describe("объект без основного компонента (Р6)", () => {
  const A = override("20261021T100000", "20261021T100000", "20261021T110000", "SUMMARY:А");
  const Bo = override("20261028T100000", "20261028T120000", "20261028T130000", "SUMMARY:Б");
  const SOURCE = calendar(MOSCOW, A, Bo);

  it("update this — на месте", () => {
    const plan = update(load(SOURCE), { instanceStart: "2026-10-21T10:00:00+03:00", patch: { summary: "А2" } });
    expect(diff(SOURCE, icsOf(plan))).toEqual({
      removed: ["DTSTAMP:20261001T090000Z", "SUMMARY:А"],
      added: [STAMP, "SUMMARY:А2"],
    });
  });

  it.each(["this_and_following", "all_series"] as const)("update %s — отказ", (scope) => {
    expect(refusal(() => update(load(SOURCE), { scope, instanceStart: "2026-10-21T10:00:00+03:00", patch: { summary: "Х" } })).code)
      .toBe("invalid-field");
  });

  it("delete this снимает компонент; последний — удаление объекта", () => {
    const step1 = remove(load(SOURCE), { scope: "this", instanceStart: "2026-10-21T10:00:00+03:00" });
    expect(icsOf(step1)).toBe(calendar(MOSCOW, Bo));
    expect(remove(after(step1), { scope: "this", instanceStart: "2026-10-28T10:00:00+03:00" }).kind).toBe("delete-object");
  });

  it("delete this_and_following снимает RID ≥ B; с первого — удаление объекта", () => {
    expect(icsOf(remove(load(SOURCE), { scope: "this_and_following", instanceStart: "2026-10-28T10:00:00+03:00" })))
      .toBe(calendar(MOSCOW, A));
    expect(remove(load(SOURCE), { scope: "this_and_following", instanceStart: "2026-10-21T10:00:00+03:00" }).kind).toBe("delete-object");
  });

  it("delete this_and_following: встреча с RID ≥ B, перенесённая раньше B, — needsConfirm", () => {
    const early = override("20261028T100000", "20261020T120000", "20261020T130000", "SUMMARY:Рано");
    const error = refusal(() => remove(load(calendar(MOSCOW, A, early)), { scope: "this_and_following", instanceStart: "2026-10-21T10:00:00+03:00" }));
    expect(error.needsConfirm).toBe(true);
    expect(error.losses.map((loss) => loss.summary)).toEqual(["Рано"]);
  });

  it("delete all_series — удаление объекта с пометкой, что серия организатора не затронута", () => {
    const plan = remove(load(SOURCE), { scope: "all_series" });
    expect(plan.kind).toBe("delete-object");
    expect(plan.notices.join(" ")).toContain("организатора");
  });
});

// ─────────────────────────────── правка по ревью ───────────────────────────────

describe("правка по ревью: ни одна ветка не теряет больше, чем просили", () => {
  const B = "2026-10-26T10:00:00+03:00";
  const B_KEY = at(B);
  const confirmed = { confirm: true, etag: ETAG, currentEtag: ETAG } as const;
  const DAILY_MSK = ["DTSTART;TZID=Europe/Moscow:20261019T100000", "DTEND;TZID=Europe/Moscow:20261019T110000",
    "RRULE:FREQ=DAILY;COUNT=12", "SUMMARY:Планёрка"];

  describe("одиночное событие, показанное своим переопределением (RECURRENCE-ID = DTSTART)", () => {
    // Серия из DTSTART и RDATE: правка 19.10 даёт клон, удаление хвоста с 21.10 — одиночное событие с ним.
    const RDATE_PAIR = calendar(MOSCOW, vevent(["DTSTART;TZID=Europe/Moscow:20261019T100000", "DTEND;TZID=Europe/Moscow:20261019T110000",
      "RDATE;TZID=Europe/Moscow:20261021T100000", "SUMMARY:Встреча"]));
    const FIRST = "2026-10-19T10:00:00+03:00";

    function shownSingle(): CalendarObject {
      const o1 = after(update(load(RDATE_PAIR), { scope: "this", instanceStart: FIRST, patch: { location: "Каб. 7", description: "повестка" } }));
      const o2 = after(remove(o1, { scope: "this_and_following", instanceStart: "2026-10-21T10:00:00+03:00" }));
      expect(o2.kind).toBe("single");
      expect(o2.overrides.size).toBe(1);
      return o2;
    }

    it("сдвиг начала ложится на показанное переопределение: встреча в 12:00 со своим местом и описанием", () => {
      const next = after(update(shownSingle(), { scope: "this", instanceStart: FIRST, patch: { start: "2026-10-19T12:00:00+03:00" } }));
      const shown = instancesBetween(next, Date.parse("2026-10-01T00:00:00+03:00"), Date.parse("2026-11-01T00:00:00+03:00"));
      expect(shown.map((i) => row(i))).toEqual(["2026-10-19T10:00:00+03:00 → 2026-10-19T12:00:00+03:00–13:00 Встреча"]);
      expect(shown[0].shown.getFirstPropertyValue("location")).toBe("Каб. 7");
      expect(shown[0].shown.getFirstPropertyValue("description")).toBe("повестка");
      // Основной компонент не тронут: DTSTART на месте, переопределение не ушло в скрытые.
      expect(linesNamed(masterLines(serializeObject(next)), "DTSTART")).toEqual(["DTSTART;TZID=Europe/Moscow:20261019T100000"]);
    });

    it.each([
      ["this с адресом", { scope: "this", instanceStart: FIRST }],
      ["без scope и адреса", {}],
      ["all_series", { scope: "all_series" }],
    ] as const)("правка полей (%s) видна: ложится на переопределение, а не на невидимый основной", (_name, request) => {
      const plan = update(shownSingle(), { ...request, patch: { summary: "X" } });
      expect(visible(after(plan))).toEqual(["2026-10-19T10:00:00+03:00 → 2026-10-19T10:00:00+03:00–11:00 X"]);
      expect(linesNamed(masterLines(icsOf(plan)), "SUMMARY")).toEqual(["SUMMARY:Встреча"]);
    });

    it("recurrence у такого события — отказ, записи нет", () => {
      const error = refusal(() => update(shownSingle(), { scope: "all_series", patch: { recurrence: { frequency: "weekly", count: 3 } } }));
      expect(error.code).toBe("invalid-field");
    });

    it("разрез на последней RDATE с переопределением: продолжение-одиночное правится через переопределение", () => {
      const o = load(calendar(MOSCOW,
        vevent(["DTSTART;TZID=Europe/Moscow:20261019T100000", "DTEND;TZID=Europe/Moscow:20261019T110000",
          "RDATE;TZID=Europe/Moscow:20261021T100000,20261023T100000", "SUMMARY:Встреча"]),
        override("20261023T100000", "20261023T100000", "20261023T110000", "SUMMARY:Встреча", "LOCATION:Зал")));
      const plan = split(update(o, { scope: "this_and_following", instanceStart: "2026-10-23T10:00:00+03:00", patch: { description: "итоги" } }));
      const continuation = load(plan.continuation.ics);
      expect(continuation.kind).toBe("single");
      const renamed = after(update(continuation, { patch: { summary: "Итоги" } }));
      expect(visible(renamed)).toEqual(["2026-10-23T10:00:00+03:00 → 2026-10-23T10:00:00+03:00–11:00 Итоги"]);
    });

    it("правка начала не делает скрытый компонент видимым: новое начало на его RECURRENCE-ID — отказ", () => {
      const o = load(calendar(MOSCOW, vevent(["DTSTART;TZID=Europe/Moscow:20261019T120000", "DTEND;TZID=Europe/Moscow:20261019T130000", "SUMMARY:Событие"]),
        override("20261019T100000", "20261019T100000", "20261019T110000", "SUMMARY:След")));
      expect(visible(o)).toEqual(["2026-10-19T12:00:00+03:00 → 2026-10-19T12:00:00+03:00–13:00 Событие"]);
      expect(refusal(() => update(o, { patch: { start: "2026-10-19T10:00:00+03:00" } })).code).toBe("invalid-time");
    });

    it("delete this по RECURRENCE-ID скрытого компонента снимает только его, событие цело", () => {
      // Предохранитель (guard.ts, checkPut) пока считает любое удаление у одиночного события
      // удалением объекта и такой put отвергает — вопрос передан З11; здесь — план без него.
      const o = load(calendar(MOSCOW, vevent(["DTSTART;TZID=Europe/Moscow:20261019T120000", "DTEND;TZID=Europe/Moscow:20261019T130000", "SUMMARY:Событие"]),
        override("20261019T100000", "20261019T100000", "20261019T110000", "SUMMARY:След")));
      const plan = planDelete(o, { now: NOW, scope: "this", instanceStart: "2026-10-19T10:00:00+03:00" });
      expect(plan.kind).toBe("put");
      expect(events(icsOf(plan))).toHaveLength(1);
      expect(visible(after(plan))).toEqual(["2026-10-19T12:00:00+03:00 → 2026-10-19T12:00:00+03:00–13:00 Событие"]);
      expect(plan.removed.map((loss) => [loss.instanceStart, loss.summary])).toEqual([["2026-10-19T10:00:00+03:00", "След"]]);
      expect(plan.expect.removed).toEqual([]);
    });
  });

  describe("разрез (t&f)", () => {
    it("О13: прежнее значение, пустой патч, прежние start и пояс — noop, серия не делится", () => {
      for (const patch of [{ summary: "Планёрка" }, {}, { start: B }, { timeZone: "Europe/Moscow" }, { recurrence: { count: 4 } }]) {
        const plan = update(weekly(), { scope: "this_and_following", instanceStart: B, patch });
        expect(plan.kind, JSON.stringify(patch)).toBe("noop");
        expect(plan.expect.target).toBe(B_KEY);
      }
      // С чужими участниками пустой план ничего не пишет — и подтверждения не требует.
      const guests = weekly(["ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:guest@example.com"]);
      expect(update(guests, { scope: "this_and_following", instanceStart: B, patch: { summary: "Планёрка" } }).kind).toBe("noop");
    });

    it("О11: разрез с чужими участниками и потерей переопределения — один отказ с полным перечнем", () => {
      const own = override("20261104T100000", "20261104T100000", "20261104T110000", "SUMMARY:Своё");
      const o = load(calendar(MOSCOW, vevent([...WEEKLY, "ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:guest@example.com"]), own));
      const request = { scope: "this_and_following", instanceStart: B, patch: { recurrence: { count: 2 } } } as const;
      const error = refusal(() => update(o, request));
      expect(error.code).toBe("confirm-required");
      expect(error.message).toContain("guest@example.com");
      expect(error.losses.map((loss) => loss.instanceStart)).toEqual(["2026-11-04T10:00:00+03:00"]);
      const stale = refusal(() => update(o, { ...request, confirm: true, etag: '"old"', currentEtag: ETAG }));
      expect(stale.losses.map((loss) => loss.instanceStart)).toEqual(["2026-11-04T10:00:00+03:00"]);
      const plan = split(update(o, { ...request, ...confirmed }));
      expect(plan.removed.map((loss) => loss.instanceStart)).toEqual(["2026-11-04T10:00:00+03:00"]);
      expect(plan.notices.join(" ")).toContain("guest@example.com");
    });

    it("участник — сам владелец (адрес в другом регистре): разрез без подтверждения", () => {
      const plan = update(weekly(["ATTENDEE;PARTSTAT=ACCEPTED:mailto:USER@Yandex.RU"]), {
        scope: "this_and_following", instanceStart: B, patch: { location: "Зал" },
      });
      expect(plan.kind).toBe("split");
    });

    it("граница — RDATE;VALUE=PERIOD с длительностью не как у серии: отказ split-mismatch, конец встречи не меняется молча", () => {
      const o = load(calendar(MOSCOW, vevent(["DTSTART;TZID=Europe/Moscow:20261019T100000", "DTEND;TZID=Europe/Moscow:20261019T110000",
        "RDATE;VALUE=PERIOD;TZID=Europe/Moscow:20261021T100000/PT3H,20261023T100000/PT2H", "SUMMARY:P"])));
      expect(visible(o)[1]).toBe("2026-10-21T10:00:00+03:00 → 2026-10-21T10:00:00+03:00–13:00 P");
      const error = refusal(() => update(o, { scope: "this_and_following", instanceStart: "2026-10-21T10:00:00+03:00", patch: { summary: "P2" } }));
      expect(error.code).toBe("split-mismatch");
    });

    it("граница — RDATE;VALUE=PERIOD с длительностью серии: разрез, встреча 10:00–11:00 как была", () => {
      const o = load(calendar(MOSCOW, vevent(["DTSTART;TZID=Europe/Moscow:20261019T100000", "DTEND;TZID=Europe/Moscow:20261019T110000",
        "RDATE;VALUE=PERIOD;TZID=Europe/Moscow:20261021T100000/PT1H,20261023T100000/PT2H", "SUMMARY:P"])));
      const plan = split(update(o, { scope: "this_and_following", instanceStart: "2026-10-21T10:00:00+03:00", patch: { summary: "P2" } }));
      expect(visible(load(plan.continuation.ics))).toEqual([
        "2026-10-21T10:00:00+03:00 → 2026-10-21T10:00:00+03:00–11:00 P2",
        "2026-10-23T10:00:00+03:00 → 2026-10-23T10:00:00+03:00–12:00 P2",
      ]);
    });

    it("смена пояса: оторванная встреча продолжения совпала бы со встречей серии — split-mismatch с адресом в поясе серии", () => {
      // 28.10 11:00 МСК = 08:00Z; после смены пояса встреча серии 28.10 — 09:00 CET = 08:00Z.
      const o = load(calendar(MOSCOW, vevent(DAILY_MSK), override("20261028T110000", "20261028T110000", "20261028T120000", "SUMMARY:Чужое")));
      const error = refusal(() => update(o, {
        scope: "this_and_following", instanceStart: "2026-10-21T10:00:00+03:00", patch: { timeZone: "Europe/Berlin" },
      }));
      expect(error.code).toBe("split-mismatch");
      expect(error.message).toContain("2026-10-28T11:00:00+03:00");
      expect(error.message).not.toContain("+00:00");
    });

    it("с recurrence и start на дату раньше границы — отказ: продолжение легло бы на встречи прежней серии", () => {
      const o = load(calendar(MOSCOW, vevent(["DTSTART;TZID=Europe/Moscow:20261019T100000", "DTEND;TZID=Europe/Moscow:20261019T110000",
        "RRULE:FREQ=DAILY;COUNT=10", "SUMMARY:Планёрка"])));
      const error = refusal(() => update(o, {
        scope: "this_and_following", instanceStart: "2026-10-24T10:00:00+03:00",
        patch: { start: "2026-10-21T10:00:00", recurrence: { interval: 1 } },
      }));
      expect(error.code).toBe("invalid-time");
    });

    it("DTEND в другом поясе (рейс): у продолжения конец остаётся в поясе DTEND", () => {
      const o = load(calendar([...MOSCOW, ...BERLIN_ZONE], vevent(["DTSTART;TZID=Europe/Moscow:20261019T100000",
        "DTEND;TZID=Europe/Berlin:20261019T110000", "RRULE:FREQ=WEEKLY;COUNT=4", "SUMMARY:Рейс"])));
      const plan = split(update(o, { scope: "this_and_following", instanceStart: B, patch: { summary: "Рейс 2" } }));
      // 26.10 10:00 МСК = 07:00Z, два часа пути — 09:00Z = 10:00 CET.
      expect(linesNamed(masterLines(plan.continuation.ics), "DTEND")).toEqual(["DTEND;TZID=Europe/Berlin:20261026T100000"]);
    });
  });

  describe("усечение (t&f): только то, что до границы, и без порчи правила", () => {
    it("до границы видна только оторванная встреча, после усечения видимых не осталось бы — отказ, объект не удаляется", () => {
      const o = load(calendar(MOSCOW, vevent(["DTSTART;TZID=Europe/Moscow:20261019T100000", "DTEND;TZID=Europe/Moscow:20261019T110000",
        "RRULE:FREQ=DAILY;COUNT=5", "EXDATE;TZID=Europe/Moscow:20261019T100000", "EXDATE;TZID=Europe/Moscow:20261020T100000", "SUMMARY:Планёрка"]),
        override("20261020T120000", "20261020T120000", "20261020T130000", "SUMMARY:Отдельная")));
      const B21 = "2026-10-21T10:00:00+03:00";
      for (const extra of [{}, confirmed]) {
        const deleted = refusal(() => remove(o, { scope: "this_and_following", instanceStart: B21, ...extra }));
        expect(deleted.code).toBe("split-mismatch");
        expect(deleted.needsConfirm).toBe(false);
        expect(deleted.message).toContain("2026-10-20T12:00:00+03:00");
        expect(refusal(() => update(o, { scope: "this_and_following", instanceStart: B21, patch: { summary: "Х" }, ...extra })).code)
          .toBe("split-mismatch");
      }
    });

    it("сама граница, перенесённая раньше своего адреса, — названная цель: удаление без подтверждения", () => {
      const o = load(calendar(MOSCOW, vevent(["DTSTART;TZID=Europe/Moscow:20261019T100000", "DTEND;TZID=Europe/Moscow:20261019T110000",
        "RRULE:FREQ=WEEKLY;COUNT=4", "SUMMARY:Планёрка"]), override("20261026T100000", "20261025T100000", "20261025T110000", "SUMMARY:Раньше")));
      const plan = remove(o, { scope: "this_and_following", instanceStart: B });
      expect(linesNamed(masterLines(icsOf(plan)), "RRULE")).toEqual(["RRULE:FREQ=WEEKLY;COUNT=1"]);
      expect(plan.removed.map((loss) => [loss.instanceStart, loss.start])).toContainEqual([B, "2026-10-25T10:00:00+03:00"]);
    });

    it("граница — начало серии, а раньше есть RDATE: отказ split-mismatch, а не правило без встреч", () => {
      const o = load(calendar(MOSCOW, vevent(["DTSTART;TZID=Europe/Moscow:20261019T100000", "DTEND;TZID=Europe/Moscow:20261019T110000",
        "RRULE:FREQ=DAILY;COUNT=3", "RDATE;TZID=Europe/Moscow:20261017T100000", "SUMMARY:Планёрка"])));
      const first = "2026-10-19T10:00:00+03:00";
      expect(refusal(() => remove(o, { scope: "this_and_following", instanceStart: first })).code).toBe("split-mismatch");
      expect(refusal(() => update(o, { scope: "this_and_following", instanceStart: first, patch: { summary: "Х" } })).code).toBe("split-mismatch");
    });

    it("DTSTART вне правила, граница — первая позиция правила: отказ split-mismatch, а не правило без встреч", () => {
      // DTSTART во вторник, правило — понедельники и среды: первая позиция 21.10.
      const o = load(calendar(MOSCOW, vevent(["DTSTART;TZID=Europe/Moscow:20261020T100000", "DTEND;TZID=Europe/Moscow:20261020T110000",
        "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20261104T070000Z", "SUMMARY:Планёрка"])));
      const first = "2026-10-21T10:00:00+03:00";
      expect(refusal(() => remove(o, { scope: "this_and_following", instanceStart: first })).code).toBe("split-mismatch");
      expect(refusal(() => update(o, { scope: "this_and_following", instanceStart: first, patch: { summary: "Х" } })).code).toBe("split-mismatch");
    });
  });

  describe("t&f без встреч до границы (Р2): граница — цель правки", () => {
    it("start с датой самой границы — без ложного пояснения о дате", () => {
      const plan = update(weekly(["EXDATE;TZID=Europe/Moscow:20261019T100000"]), {
        scope: "this_and_following", instanceStart: "2026-10-21T10:00:00+03:00", patch: { start: "2026-10-21T11:00:00+03:00" },
      });
      expect(plan.kind).toBe("put");
      expect(plan.notices.join(" ")).not.toContain("не применена");
      expect(visible(after(plan))[0]).toBe("2026-10-21T11:00:00+03:00 → 2026-10-21T11:00:00+03:00–12:00 Планёрка");
    });

    it("граница из RDATE в другое время суток, чем начало серии, со start — отказ, встреча не уезжает не туда", () => {
      const o = load(calendar(MOSCOW, vevent(["DTSTART;TZID=Europe/Moscow:20261019T100000", "DTEND;TZID=Europe/Moscow:20261019T110000",
        "RRULE:FREQ=WEEKLY;COUNT=3", "RDATE;TZID=Europe/Moscow:20261020T180000", "SUMMARY:Планёрка"])));
      const o1 = after(remove(o, { scope: "this", instanceStart: "2026-10-19T10:00:00+03:00" }));
      const error = refusal(() => update(o1, {
        scope: "this_and_following", instanceStart: "2026-10-20T18:00:00+03:00", patch: { start: "2026-10-20T12:00:00" },
      }));
      expect(error.code).toBe("unsynced-rule");
    });

    it("своё переопределение границы получает поля патча безусловно, как при разрезе", () => {
      const own = override("20261019T100000", "20261019T100000", "20261019T110000", "SUMMARY:Планёрка", "LOCATION:Каб. 7");
      const plan = update(load(calendar(MOSCOW, vevent(WEEKLY), own)), {
        scope: "this_and_following", instanceStart: "2026-10-19T10:00:00+03:00", patch: { location: "Зал" },
      });
      expect(linesNamed(overrideLines(icsOf(plan), "20261019T100000"), "LOCATION")).toEqual(["LOCATION:Зал"]);
      expect(linesNamed(masterLines(icsOf(plan)), "LOCATION")).toEqual(["LOCATION:Зал"]);
    });

    it("перенесённая граница со start получает новое время суток на своей дате", () => {
      const moved = override("20261019T100000", "20261020T150000", "20261020T160000");
      const plan = update(load(calendar(MOSCOW, vevent(WEEKLY), moved)), {
        scope: "this_and_following", instanceStart: "2026-10-19T10:00:00+03:00", patch: { start: "2026-10-19T12:00:00+03:00" },
      });
      const rows = visible(after(plan));
      expect(rows[0]).toBe("2026-10-19T12:00:00+03:00 → 2026-10-20T12:00:00+03:00–13:00 Планёрка");
      expect(rows[1]).toBe("2026-10-21T12:00:00+03:00 → 2026-10-21T12:00:00+03:00–13:00 Планёрка");
    });

    it("сама граница, перенесённая раньше своего адреса: Р2, а не разрез", () => {
      // Предохранитель считает встречей «до границы» саму B, перенесённую раньше своего адреса
      // (guard.ts, checkNothingBeforeBoundary), и такой план отвергает (plan-shape) — вопрос
      // передан З11; здесь — план без него. До B встреч нет: правка всей серии тем же UID,
      // B получает патч, её перенос цел, ничего до границы не переписано.
      const o = load(calendar([], vevent(["DTSTART:20261019T070000Z", "DTEND:20261019T080000Z",
        "RRULE:FREQ=DAILY;COUNT=15", "SUMMARY:Планёрка"])));
      const moved = after(update(o, { instanceStart: "2026-10-19T07:00:00+00:00", patch: { start: "2026-10-19T06:00:00+00:00" } }));
      const plan = planUpdate(moved, { now: NOW, scope: "this_and_following", instanceStart: "2026-10-19T07:00:00+00:00", patch: { summary: "Хвост" } });
      expect(plan.kind).toBe("put");
      expect(plan.expect.target).toBe(at("2026-10-19T07:00:00+00:00"));
      expect(visible(after(plan)).slice(0, 2)).toEqual([
        "2026-10-19T07:00:00+00:00 → 2026-10-19T06:00:00+00:00–07:00 Хвост",
        "2026-10-20T07:00:00+00:00 → 2026-10-20T07:00:00+00:00–08:00 Хвост",
      ]);
    });
  });

  describe("вся серия (Р1)", () => {
    it("начало серии вне правила (BYHOUR) и сдвиг времени без recurrence — отказ unsynced-rule", () => {
      const o = load(calendar(MOSCOW, vevent(["DTSTART;TZID=Europe/Moscow:20261019T100000", "DTEND;TZID=Europe/Moscow:20261019T103000",
        "RRULE:FREQ=DAILY;BYHOUR=11;COUNT=3", "SUMMARY:Планёрка"])));
      expect(visible(o)).toHaveLength(4);
      expect(refusal(() => update(o, { scope: "all_series", patch: { start: "2026-10-19T11:00:00+03:00" } })).code).toBe("unsynced-rule");
    });

    it("HOURLY: сдвиг n → n перенёс бы встречи на другие даты — отказ unsynced-rule, а не datesFixed", () => {
      const berlin: IcalEnv = { floatingZone: "Europe/Berlin", ownerEmail: "user@yandex.ru" };
      const o = load(calendar(BERLIN_ZONE, vevent(["DTSTART;TZID=Europe/Berlin:20261024T200000", "DTEND;TZID=Europe/Berlin:20261024T203000",
        "RRULE:FREQ=HOURLY;INTERVAL=7;COUNT=12", "SUMMARY:Обход"])), berlin);
      expect(refusal(() => update(o, { scope: "all_series", patch: { start: "2026-10-24T13:30:00" } })).code).toBe("unsynced-rule");
    });

    it("смена пояса: RDATE на позиции правила разошёлся бы с ней и встреча раздвоилась бы — отказ", () => {
      const o = load(calendar(MOSCOW, vevent([...DAILY_MSK, "RDATE;TZID=Europe/Moscow:20261027T100000"])));
      expect(refusal(() => update(o, { scope: "all_series", patch: { timeZone: "Europe/Berlin" } })).code).toBe("unsynced-rule");
    });

    it("смена пояса: сообщение об EXDATE — со смещением пояса, а не UTC", () => {
      const o = load(calendar(MOSCOW, vevent([...DAILY_MSK, "EXDATE;TZID=Europe/Moscow:20261028T110000"])));
      const error = refusal(() => update(o, { scope: "all_series", patch: { timeZone: "Europe/Berlin" } }));
      expect(error.message).toContain("2026-10-28T09:00:00+01:00");
      expect(error.message).not.toContain("+00:00");
    });

    it("EXDATE за концом укороченной серии остаётся: продление назад удалённую встречу не воскрешает", () => {
      const step1 = remove(weekly(), { scope: "this", instanceStart: "2026-11-02T10:00:00+03:00" });
      const step2 = update(after(step1), { scope: "all_series", patch: { recurrence: { count: 4 } } });
      const step3 = update(after(step2), { scope: "all_series", patch: { recurrence: { count: 6 } } });
      expect(visible(after(step3))).toEqual([...WEEKLY_ROWS.slice(0, 4), WEEKLY_ROWS[5]]);

      const cut = update(after(step1), { scope: "all_series", patch: { recurrence: { until: "2026-10-28", count: null } } });
      const back = update(after(cut), { scope: "all_series", patch: { recurrence: { until: null } } });
      expect(visible(after(back)).map((line) => line.slice(0, 10))).not.toContain("2026-11-02");
    });

    it("оторванная встреча, получившая слот в новом правиле, — не потеря: компонент цел, поля видны", () => {
      const detached = override("20261021T100000", "20261021T100000", "20261021T110000", "SUMMARY:Отдельная", "DESCRIPTION:важное");
      const o = load(calendar(MOSCOW, vevent(["DTSTART;TZID=Europe/Moscow:20261019T100000", "DTEND;TZID=Europe/Moscow:20261019T110000",
        "RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=4", "SUMMARY:W"]), detached));
      const plan = update(o, { scope: "all_series", patch: { recurrence: { byWeekday: ["MO", "WE"] } } });
      expect(plan.removed).toEqual([]);
      const next = after(plan);
      const meeting = instancesBetween(next, Date.parse("2026-10-21T00:00:00+03:00"), Date.parse("2026-10-22T00:00:00+03:00"));
      expect(meeting.map((i) => row(i))).toEqual(["2026-10-21T10:00:00+03:00 → 2026-10-21T10:00:00+03:00–11:00 Отдельная"]);
      expect(meeting[0].kind).toBe("override");
      expect(meeting[0].shown.getFirstPropertyValue("description")).toBe("важное");
    });

    it("DTEND переопределения в другом поясе сохраняет свой пояс при сдвиге серии", () => {
      const flight = vevent(["RECURRENCE-ID;TZID=Europe/Moscow:20261026T100000", "DTSTART;TZID=Europe/Moscow:20261026T100000",
        "DTEND;TZID=Europe/Berlin:20261026T100000", "SUMMARY:Рейс"]);
      const o = load(calendar([...MOSCOW, ...BERLIN_ZONE], vevent(["DTSTART;TZID=Europe/Moscow:20261019T100000",
        "DTEND;TZID=Europe/Berlin:20261019T110000", "RRULE:FREQ=WEEKLY;COUNT=4", "SUMMARY:Рейс"]), flight));
      const plan = update(o, { scope: "all_series", patch: { start: "2026-10-19T11:00:00+03:00" } });
      expect(linesNamed(overrideLines(icsOf(plan), "20261026T110000"), "DTEND")).toEqual(["DTEND;TZID=Europe/Berlin:20261026T110000"]);
    });

    it("UTC → «весь день» в календаре западнее UTC: дата — по поясу календаря, как у patch.ts", () => {
      // Предохранитель сверяет здесь дату UTC и такой план отвергает (date-shifted): какая дата
      // верна, решают З08 и З11; планировщик согласован с patch.ts (dateOfTimed).
      const newYork: IcalEnv = { floatingZone: "America/New_York", ownerEmail: "user@yandex.ru" };
      const o = load(calendar([], vevent(["DTSTART:20261020T020000Z", "DTEND:20261020T030000Z", "RRULE:FREQ=DAILY;COUNT=3", "SUMMARY:Ночь"])), newYork);
      const plan = planUpdate(o, { now: NOW, scope: "all_series", patch: { allDay: true } });
      expect(linesNamed(masterLines(icsOf(plan)), "DTSTART")).toEqual(["DTSTART;VALUE=DATE:20261019"]);
    });
  });
});

// ─────────────────────────────── continuationUid ───────────────────────────────

describe("continuationUid", () => {
  it("детерминирован: ycm- и 32 знака sha256 от UID и границы", () => {
    const key = at("2026-10-26T10:00:00+03:00");
    const expected = `ycm-${createHash("sha256").update(`${UID}\n${key}`).digest("hex").slice(0, 32)}`;
    expect(continuationUid(UID, key)).toBe(expected);
    expect(continuationUid(UID, key)).toBe(continuationUid(UID, key));
    expect(continuationUid(UID, at("2026-10-28T10:00:00+03:00"))).not.toBe(expected);
  });
});
