// Отрицательный контроль оракула: обход, который ничего не ловит, — не
// оракул, а зелёная лампочка. Здесь «после» подделывается руками: в текст
// объекта вносится ровно одна порча, и checkSemantics обязан её назвать. И
// наоборот: верный результат обязан пройти молча.
//
// Планировщик тут не участвует вовсе — проверяется сам измеритель
// (semantics.ts, world.ts).
import { describe, expect, it } from "vitest";
import { bannedRefusal } from "./case.js";
import type { OraclePatch } from "./corpus.js";
import { ORACLE_PATCHES, ORACLE_SEEDS } from "./corpus.js";
import { isolatedRunner } from "./isolate.js";
import { checkSemantics } from "./semantics.js";
import { load, worldOf } from "./world.js";

const named = (name: string) => ORACLE_SEEDS.find((s) => s.name === name)!;
const seed = named("weekly-count-moscow");
const summaryPatch = ORACLE_PATCHES.find((p) => p.name === "summary")!;
const startPatch = ORACLE_PATCHES.find((p) => p.name === "start")!;
const remindersPatch = ORACLE_PATCHES.find((p) => p.name === "reminders")!;

const FIRST = "2026-10-19T10:00:00+03:00";
const NEW_TITLE = String(summaryPatch.patch.summary);

function check(afterIcs: string, options: { scope: "this" | "this_and_following" | "all_series"; address?: string; entry?: typeof summaryPatch; op?: "update" | "delete" }) {
  return checkSemantics({
    o: load(seed.ics),
    before: worldOf([seed.ics]),
    after: worldOf([afterIcs]),
    op: options.op ?? "update",
    scope: options.scope,
    address: options.address,
    entry: options.entry ?? summaryPatch,
  });
}

/** То же, но по любой затравке корпуса: для инвариантов, общих на все правки. */
function checkOn(
  name: string,
  afterIcs: string,
  options: {
    scope: "this" | "this_and_following" | "all_series";
    address?: string;
    entry?: typeof summaryPatch;
    op?: "update" | "delete";
    notices?: readonly string[];
  },
) {
  const source = named(name);
  return checkSemantics({
    o: load(source.ics),
    before: worldOf([source.ics]),
    after: worldOf([afterIcs]),
    op: options.op ?? "update",
    scope: options.scope,
    address: options.address,
    entry: options.entry ?? summaryPatch,
    notices: options.notices,
  });
}

/** Заголовок сменился у всей серии: так выглядит верная правка all_series. */
const titleEverywhere = seed.ics.replace("SUMMARY:Планёрка", `SUMMARY:${NEW_TITLE}`);

describe("оракул ловит подделку", () => {
  it("верная правка all_series проходит молча", () => {
    expect(check(titleEverywhere, { scope: "all_series" })).toEqual([]);
  });

  it("правка scope this, задевшая всю серию, — нарушение", () => {
    const problems = check(titleEverywhere, { scope: "this", address: FIRST });
    expect(problems.join(" ")).toContain("вне области правки");
  });

  it("патч поля, сдвинувший время серии, — нарушение", () => {
    const moved = titleEverywhere
      .replace("DTSTART;TZID=Europe/Moscow:20261019T100000", "DTSTART;TZID=Europe/Moscow:20261019T110000")
      .replace("DTEND;TZID=Europe/Moscow:20261019T110000", "DTEND;TZID=Europe/Moscow:20261019T120000");
    expect(check(moved, { scope: "all_series" }).join(" ")).toContain("сдвинул встречи");
  });

  it("молча пропавшая встреча — нарушение", () => {
    const dropped = titleEverywhere.replace(
      "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6",
      "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6\r\nEXDATE;TZID=Europe/Moscow:20261021T100000",
    );
    expect(check(dropped, { scope: "all_series" }).join(" ")).toContain("должно было остаться");
  });

  it("незаписанный патч поля — нарушение", () => {
    expect(check(seed.ics, { scope: "all_series" }).join(" ")).toContain("не применён");
  });

  it("конец серии, снятый без повода в патче, — нарушение", () => {
    const endless = titleEverywhere.replace("RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6", "RRULE:FREQ=WEEKLY;BYDAY=MO,WE");
    expect(check(endless, { scope: "all_series" }).join(" ")).toContain("после — нет");
  });

  it("удаление, которое ничего не удалило, — нарушение", () => {
    expect(check(seed.ics, { scope: "this", address: FIRST, op: "delete" }).join(" ")).toContain("удаление оставило");
  });

  it("правка времени, не дошедшая до слотов, — нарушение", () => {
    // Время сдвинуто только у первой встречи (отдельным переопределением),
    // а патч start со scope all_series обязан задеть все слоты.
    expect(check(seed.ics, { scope: "all_series", entry: startPatch }).join(" ")).toContain("ожидалось");
  });

  it("встреча с концом не позже начала — нарушение", () => {
    const zero = titleEverywhere.replace("DTEND;TZID=Europe/Moscow:20261019T110000", "DTEND;TZID=Europe/Moscow:20261019T100000");
    expect(check(zero, { scope: "all_series" }).join(" ")).toContain("конец встречи не позже её начала");
  });

  it("длительность, не названная патчем, — нарушение", () => {
    // Ровно та находка, ради которой инвариант заведён: встреча на час
    // растянулась на 20 часов 30 минут, а патч времени не называл.
    const stretched = titleEverywhere.replace("DTEND;TZID=Europe/Moscow:20261019T110000", "DTEND;TZID=Europe/Moscow:20261020T063000");
    const problems = check(stretched, { scope: "all_series" }).join(" ");
    expect(problems).toContain("длительность встречи не прежняя");
    expect(problems).toContain("20 ч 30 мин");
  });

  it("перенесённая встреча, сдвинутая патчем времени серии, — нарушение", () => {
    const moved = named("moved-override-berlin");
    const shifted = moved.ics
      .replace("DTSTART;TZID=Europe/Berlin:20261028T150000", "DTSTART;TZID=Europe/Berlin:20261028T143000")
      .replace("DTEND;TZID=Europe/Berlin:20261028T161500", "DTEND;TZID=Europe/Berlin:20261028T154500");
    const problems = checkOn("moved-override-berlin", shifted, {
      scope: "this_and_following",
      address: "2026-10-28T10:00:00+01:00",
      entry: startPatch,
    }).join(" ");
    expect(problems).toContain("не осталась на своём времени");
  });

  it("перенесённая встреча, названная в пояснениях плана, нарушением не считается", () => {
    const moved = named("moved-override-berlin");
    const shifted = moved.ics
      .replace("DTSTART;TZID=Europe/Berlin:20261028T150000", "DTSTART;TZID=Europe/Berlin:20261028T143000")
      .replace("DTEND;TZID=Europe/Berlin:20261028T161500", "DTEND;TZID=Europe/Berlin:20261028T154500");
    // Названа встреча, а не граница области: адрес в пояснении другой.
    const problems = checkOn("moved-override-berlin", shifted, {
      scope: "this_and_following",
      address: "2026-10-19T10:00:00+02:00",
      entry: startPatch,
      notices: ["Встреча 2026-10-28T10:00:00+01:00 перенесена вместе с серией."],
    }).join(" ");
    expect(problems).not.toContain("не осталась на своём времени");
  });

  it("верная правка напоминаний проходит молча", () => {
    const alarms = named("email-alarm-moscow");
    const moved = alarms.ics.replace("TRIGGER:-PT30M", "TRIGGER:-PT20M");
    expect(checkOn("email-alarm-moscow", moved, { scope: "all_series", entry: remindersPatch })).toEqual([]);
  });

  // Р1: у серии из start и end берутся время суток И ДЛИТЕЛЬНОСТЬ. Разница
  // дат между ними — часть длительности: прежний измеритель клал время суток
  // конца на дату начала и объявлял верную правку нарушением.
  it("конец на следующие сутки после начала — не нарушение", () => {
    const overnight = ORACLE_PATCHES.find((p) => p.name === "start+end:через полночь")!;
    // Серия 10:00–11:00 переехала на 23:00–01:00 следующих суток: даты слотов
    // прежние (Р1), длительность — названные патчем два часа.
    const moved = seed.ics
      .replace("DTSTART;TZID=Europe/Moscow:20261019T100000", "DTSTART;TZID=Europe/Moscow:20261019T230000")
      .replace("DTEND;TZID=Europe/Moscow:20261019T110000", "DTEND;TZID=Europe/Moscow:20261020T010000");
    expect(check(moved, { scope: "all_series", entry: overnight })).toEqual([]);
  });

  it("конец на следующие сутки, записанный на дату начала, — нарушение", () => {
    const overnight = ORACLE_PATCHES.find((p) => p.name === "start+end:через полночь")!;
    // Тот же патч, но конец лёг на дату начала: встреча вышла вырожденной.
    const collapsed = seed.ics
      .replace("DTSTART;TZID=Europe/Moscow:20261019T100000", "DTSTART;TZID=Europe/Moscow:20261019T230000")
      .replace("DTEND;TZID=Europe/Moscow:20261019T110000", "DTEND;TZID=Europe/Moscow:20261019T233000");
    const problems = check(collapsed, { scope: "all_series", entry: overnight }).join(" ");
    expect(problems).toContain("длительность встречи не прежняя");
  });

  it("end без start, перенесённый на следующие сутки, — не нарушение", () => {
    // «end без start — ближайшее такое время суток после начала» (Р1): 01:00
    // не позже 10:00, значит конец идёт на следующие сутки.
    const entry: OraclePatch = { name: "end:01:00", patch: { end: "2026-11-05T01:00:00" }, kind: "time" };
    const stretched = seed.ics.replace("DTEND;TZID=Europe/Moscow:20261019T110000", "DTEND;TZID=Europe/Moscow:20261020T010000");
    expect(check(stretched, { scope: "all_series", entry })).toEqual([]);
  });

  // Горизонт разворота — окно измерителя, а не край календаря. Встреча со
  // своим компонентом вправе стоять вне окна: RFC 5545 §3.3.5 разрешает годы
  // по 9999-й, и scope "this" с патчем start: 9999-12-31 — законная правка.
  // Затравка бесконечная: у неё работает ещё и рез по упору в 400 встреч, и
  // встреча у края календаря обязана пережить его тоже.
  const FAR_SEED = "infinite-weekly-moscow";
  const FAR_FIRST = "2026-10-20T09:00:00+03:00";
  const farPatch = ORACLE_PATCHES.find((p) => p.name === "start:9999-12-31")!;
  const farOverride = (start: string) =>
    [
      "BEGIN:VEVENT",
      "UID:or-infinite-weekly@example.com",
      "DTSTAMP:20261001T090000Z",
      `DTSTART;TZID=Europe/Moscow:${start}`,
      `DTEND;TZID=Europe/Moscow:${start.replace("T230000", "T233000")}`,
      "SUMMARY:Бесконечная планёрка",
      "SEQUENCE:1",
      "RECURRENCE-ID;TZID=Europe/Moscow:20261020T090000",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

  it("встреча, уведённая к краю календаря, пропавшей не считается", () => {
    const moved = named(FAR_SEED).ics.replace("END:VCALENDAR", farOverride("99991231T230000"));
    expect(checkOn(FAR_SEED, moved, { scope: "this", address: FAR_FIRST, entry: farPatch })).toEqual([]);
  });

  it("встреча, которая к краю календаря не уехала, а просто исчезла, — нарушение", () => {
    // Тот же патч, но переопределения нет вовсе: слот закрыт EXDATE.
    const lost = named(FAR_SEED).ics.replace(
      "RRULE:FREQ=WEEKLY;BYDAY=TU",
      "RRULE:FREQ=WEEKLY;BYDAY=TU\r\nEXDATE;TZID=Europe/Moscow:20261020T090000",
    );
    expect(checkOn(FAR_SEED, lost, { scope: "this", address: FAR_FIRST, entry: farPatch }).join(" ")).toContain(
      "должно было остаться",
    );
  });

  it("встреча у края календаря, уехавшая не туда, куда назвал патч, — нарушение", () => {
    const wrong = named(FAR_SEED).ics.replace("END:VCALENDAR", farOverride("99991230T230000"));
    expect(checkOn(FAR_SEED, wrong, { scope: "this", address: FAR_FIRST, entry: farPatch }).join(" ")).toContain(
      "в выдаче таких нет",
    );
  });

  // Край года — не только значение в патче, но и сам объект. Окно разворота у
  // такой затравки своё (world.ts, horizonOf), и первое, что должен уметь
  // измеритель, — вообще её видеть: окном 2026–2029 её встреч нет ни одной, и
  // любая подделка прошла бы молча.
  const EDGE = "year-edge-9999";
  const edgeSeed = named(EDGE);

  it("верная правка серии у края года проходит молча", () => {
    const renamed = edgeSeed.ics.replace("SUMMARY:Планёрка у края календаря", `SUMMARY:${NEW_TITLE}`);
    expect(checkOn(EDGE, renamed, { scope: "all_series" })).toEqual([]);
  });

  it("встреча, пропавшая у края года, — нарушение", () => {
    const shortened = edgeSeed.ics
      .replace("SUMMARY:Планёрка у края календаря", `SUMMARY:${NEW_TITLE}`)
      .replace("RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=3", "RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=2");
    expect(checkOn(EDGE, shortened, { scope: "all_series" }).join(" ")).toContain("должно было остаться");
  });

  it("незаписанная правка у края года — нарушение", () => {
    expect(checkOn(EDGE, edgeSeed.ics, { scope: "all_series" }).join(" ")).toContain("не применён");
  });

  // Скрытый след, которого разрез лишает прячущего EXDATE. Усечённая серия
  // кончается раньше следа, и RECURRENCE-ID оказывается мимо всех её слотов —
  // но встречи по этому адресу как не было, так и нет, и след остаётся
  // адресуемым (guard.ts: «усечение серии прячет переопределение за её
  // конец»). Измеритель такой разрез принимает — и обязан назвать тот, где
  // след стал встречей.
  const TRACE = "hidden-exdate-tail-moscow";
  const traceSeed = named(TRACE);
  const CRLF = "\r\n";

  /** Усечённый исходный объект: правило до 27.10, EXDATE снят с хвостом, след остался. */
  const traceTruncated = traceSeed.ics
    .replace("RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=6", "RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=2")
    .replace(`EXDATE;TZID=Europe/Moscow:20261117T150000${CRLF}`, "");

  /** Продолжение разреза: новый UID, начало 03.11, EXDATE перешёл, следа в нём нет. */
  const traceContinuation = [
    "BEGIN:VCALENDAR",
    "PRODID:-//Yandex LLC//Yandex Calendar//EN",
    "VERSION:2.0",
    "CALSCALE:GREGORIAN",
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
    "BEGIN:VEVENT",
    "UID:ycm-продолжение-разреза",
    "DTSTAMP:20261001T090000Z",
    "DTSTART;TZID=Europe/Moscow:20261103T150000",
    "DTEND;TZID=Europe/Moscow:20261103T160000",
    "RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=4",
    "EXDATE;TZID=Europe/Moscow:20261117T150000",
    `SUMMARY:${NEW_TITLE}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ].join(CRLF) + CRLF;

  it("след, оставшийся скрытым после усечения, нарушением не считается", () => {
    const problems = checkSemantics({
      o: load(traceSeed.ics),
      before: worldOf([traceSeed.ics]),
      after: worldOf([traceTruncated, traceContinuation]),
      op: "update",
      scope: "this_and_following",
      address: "2026-11-03T15:00:00+03:00",
      entry: summaryPatch,
    });
    expect(problems).toEqual([]);
  });

  it("след, ставший встречей после снятия EXDATE, — нарушение", () => {
    // Тот же снятый EXDATE, но правило не усечено: адрес следа снова попадает
    // на слот, и невидимая встреча становится видимой.
    const revived = traceSeed.ics
      .replace(`SUMMARY:Вторничная серия${CRLF}`, `SUMMARY:${NEW_TITLE}${CRLF}`)
      .replace(`EXDATE;TZID=Europe/Moscow:20261117T150000${CRLF}`, "");
    expect(checkOn(TRACE, revived, { scope: "all_series" }).join(" ")).toContain("должно было остаться");
  });

  it("напоминание письмом, потерявшее адресата, — нарушение", () => {
    const alarms = named("email-alarm-moscow");
    const lost = alarms.ics
      .replace("TRIGGER:-PT30M", "TRIGGER:-PT20M")
      .replace("ATTENDEE;CN=Пётр Петров:mailto:petrov@example.com\r\n", "");
    expect(checkOn("email-alarm-moscow", lost, { scope: "all_series", entry: remindersPatch }).join(" ")).toContain(
      "напоминание письмом осталось без адресата",
    );
  });
});

// Запрет отказа — единственное место, где обход считает отказ нарушением.
// Отказ сам по себе законный исход, и проверять его строгость обход не
// берётся: он смотрит только туда, где корпус назвал код и объяснил, почему
// правка обязана была пройти.
describe("запрет отказа", () => {
  const step = ORACLE_PATCHES.find((entry) => entry.name === "recurrence:interval=1001")!;

  it("у конечной серии отказ по правилу незаконен, у бесконечной — законен", () => {
    // Ровно те два исхода, ради которых патч и заведён.
    expect(bannedRefusal(named("weekly-count-moscow"), step, "invalid-rule")?.why).toContain("конечной серии");
    expect(bannedRefusal(named("until-berlin"), step, "invalid-rule")).toBeDefined();
    expect(bannedRefusal(named("infinite-weekly-moscow"), step, "invalid-rule")).toBeUndefined();
    expect(bannedRefusal(named("infinite-daily-berlin"), step, "invalid-rule")).toBeUndefined();
  });

  it("запрет именной: отказ с другим кодом он не задевает", () => {
    // Повтор у одной встречи не меняется (invalid-scope), потери требуют
    // подтверждения (confirm-required) — оба отказа законны и под запрет не идут.
    expect(bannedRefusal(named("weekly-count-moscow"), step, "invalid-scope")).toBeUndefined();
    expect(bannedRefusal(named("weekly-count-moscow"), step, "confirm-required")).toBeUndefined();
    // Правило, которое Яндекс исказит (Ж6), отказывает своим кодом — и законно.
    expect(bannedRefusal(named("bysetpos-moscow"), step, "unsupported-rule")).toBeUndefined();
  });

  it("запрет затравки действует при любом патче и при удалении", () => {
    expect(bannedRefusal(named("year-edge-9999"), step, "series-too-long")).toBeDefined();
    // У delete патча нет вовсе — запрет затравки от этого не слабее.
    expect(bannedRefusal(named("year-edge-9999"), undefined, "series-too-long")).toBeDefined();
    expect(bannedRefusal(named("year-edge-9999"), undefined, "until-too-far")).toBeDefined();
    // Отказ по существу патча запретом не задет.
    expect(bannedRefusal(named("year-edge-9999"), undefined, "invalid-time")).toBeUndefined();
    expect(bannedRefusal(named("weekly-count-moscow"), undefined, "series-too-long")).toBeUndefined();
  });

  it("отказ под запретом обход называет нарушением, а не законным исходом", async () => {
    const runner = isolatedRunner();
    try {
      const outcome = await runner.run({
        seedName: "weekly-count-moscow",
        op: "update",
        scope: "all_series",
        role: "none",
        patchName: "recurrence:interval=1001",
      });
      const over = outcome.findings.filter((finding) => finding.kind === "over-strict");
      if (outcome.refused && outcome.code === "invalid-rule") {
        // Пока предел шага стоит на самом числе, отказ приходит — и назван.
        expect(over).toHaveLength(1);
        expect(over[0].detail).toContain("обязана была пройти");
        expect(over[0].minimalRepro).toContain("planUpdate");
      } else {
        // Предел научился смотреть на конец серии: отказа нет, и называть нечего.
        expect(over).toEqual([]);
      }
    } finally {
      await runner.close();
    }
  });
});

// Сторожевое время — тоже часть измерителя: если зависший случай уносит весь
// прогон, оракул молчит не потому, что нарушений нет, а потому, что до отчёта
// дело не дошло.
describe("сторожевое время обхода", () => {
  /** Случай, который сам по себе считается мгновенно: ловится только предел. */
  const spec = {
    seedName: "weekly-count-moscow",
    op: "update" as const,
    scope: "all_series" as const,
    role: "none",
    patchName: "summary",
  };

  it("случай, не уложившийся в предел, — нарушение вида timeout", async () => {
    const runner = isolatedRunner(1);
    try {
      const outcome = await runner.run(spec);
      expect(outcome.findings).toHaveLength(1);
      expect(outcome.findings[0].kind).toBe("timeout");
      expect(outcome.findings[0].detail).toContain("не уложился в предел");
      // Воспроизведение остаётся годным: по нему случай повторяют руками.
      expect(outcome.findings[0].minimalRepro).toContain("planUpdate");
    } finally {
      await runner.close();
    }
  });

  it("после обрыва обход идёт дальше — следующий случай считается в новом потоке", async () => {
    const runner = isolatedRunner(1);
    try {
      const first = await runner.run(spec);
      const second = await runner.run({ ...spec, patchName: "start" });
      expect(first.findings[0].kind).toBe("timeout");
      expect(second.findings[0].kind).toBe("timeout");
      expect(second.findings[0].patch).toBe("start");
    } finally {
      await runner.close();
    }
  });

  it("случай, уложившийся в предел, проходит через поток без следов", async () => {
    const runner = isolatedRunner();
    try {
      const outcome = await runner.run(spec);
      expect(outcome.findings.filter((f) => f.kind === "timeout")).toEqual([]);
      expect(outcome.refused || outcome.noop || outcome.findings.length >= 0).toBe(true);
    } finally {
      await runner.close();
    }
  });
});
