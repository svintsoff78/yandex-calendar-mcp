// Отрицательный контроль оракула: обход, который ничего не ловит, — не
// оракул, а зелёная лампочка. Здесь «после» подделывается руками: в текст
// объекта вносится ровно одна порча, и checkSemantics обязан её назвать. И
// наоборот: верный результат обязан пройти молча.
//
// Планировщик тут не участвует вовсе — проверяется сам измеритель
// (semantics.ts, world.ts).
import { describe, expect, it } from "vitest";
import { ORACLE_PATCHES, ORACLE_SEEDS } from "./corpus.js";
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
