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

const seed = ORACLE_SEEDS.find((s) => s.name === "weekly-count-moscow")!;
const summaryPatch = ORACLE_PATCHES.find((p) => p.name === "summary")!;
const startPatch = ORACLE_PATCHES.find((p) => p.name === "start")!;

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
});
