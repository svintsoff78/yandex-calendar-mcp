// Ворота оракула: полный обход операций правки падает, если есть хоть одно
// нарушение (пункт 8 задания). Запуск — `npm run test:oracle`; обход входит и
// в `npm test`, потому что лежит в tests/**.
//
// Прогон пишет tests/oracle/findings.json и tests/oracle/summary.md: список
// нарушений с готовым воспроизведением, таблицу отказов и первопричины. Файлы
// обновляются на каждом прогоне, чтобы не расходиться с кодом обхода.
import { describe, expect, it } from "vitest";
import { CAUSES, groupByCause } from "./causes.js";
import { ORACLE_PATCHES, ORACLE_SCOPES, ORACLE_SEEDS } from "./corpus.js";
import { writeReport } from "./report.js";
import { runSweep } from "./sweep.js";
import { HORIZON_FROM, HORIZON_TO, NOW, PROBE, worldOf } from "./world.js";

const FINDINGS = new URL("./findings.json", import.meta.url);
const SUMMARY = new URL("./summary.md", import.meta.url);

/** Обход целиком укладывается в минуту; предел с запасом (пункт 7). */
const TIMEOUT = 180_000;

describe("оракул правки", () => {
  it("корпус покрывает всё, что перечислено в задании", () => {
    expect(ORACLE_SEEDS.length).toBeGreaterThanOrEqual(31);
    expect(ORACLE_PATCHES.length).toBeGreaterThanOrEqual(21);
    expect(ORACLE_SCOPES).toEqual(["this", "this_and_following", "all_series"]);
    // Пояса с переводом часов и без него — оба в корпусе.
    expect(ORACLE_SEEDS.some((seed) => seed.ics.includes("TZID:Europe/Moscow"))).toBe(true);
    expect(ORACLE_SEEDS.some((seed) => seed.ics.includes("TZID:Europe/Berlin"))).toBe(true);
    // Испорченные чужими клиентами — отдельной группой, в учёте отказов их нет.
    expect(ORACLE_SEEDS.filter((seed) => seed.corrupted).length).toBeGreaterThanOrEqual(2);
    // Объекты с испорченным временем: правка обязана либо отказать внятно, либо
    // записать годное время, поэтому пометки corrupted у них нет — их отказы
    // считаются наравне с прочими.
    const brokenTime = ["dtend-with-duration-moscow", "zero-length-moscow", "end-before-start-moscow", "date-start-time-end-moscow"];
    for (const name of brokenTime) {
      const seed = ORACLE_SEEDS.find((s) => s.name === name);
      expect(seed, name).toBeDefined();
      expect(seed!.corrupted, name).toBe(false);
    }
    // Напоминания: патч в корпусе есть, и есть затравка с богатым письмом.
    expect(ORACLE_PATCHES.some((entry) => entry.name === "reminders")).toBe(true);
    expect(ORACLE_SEEDS.some((seed) => seed.ics.includes("ACTION:EMAIL") && seed.ics.includes("ATTACH"))).toBe(true);
  });

  it("горизонт разворота накрывает весь корпус и уходит дальше двух лет", () => {
    // Дальше, чем «сейчас» плюс два года, и с пробой за концом внутри.
    expect(HORIZON_TO).toBeGreaterThan(NOW + 2 * 365 * 86_400_000);
    expect(PROBE).toBeGreaterThan(NOW + 365 * 86_400_000);
    expect(PROBE).toBeLessThan(HORIZON_TO);
    for (const seed of ORACLE_SEEDS) {
      const world = worldOf([seed.ics]);
      expect(world.snaps.length, seed.name).toBeGreaterThan(0);
      // Все явные слоты и начала серий — внутри горизонта, и с запасом от края.
      expect(world.snaps[0].startMs, seed.name).toBeGreaterThan(HORIZON_FROM);
      expect(world.snaps[0].startMs, seed.name).toBeLessThan(PROBE);
      // Конечные серии кончаются внутри горизонта, бесконечные упираются в упор.
      expect(world.capped || world.snaps[world.snaps.length - 1].startMs < HORIZON_TO, seed.name).toBe(true);
    }
  });

  it(
    "обход не нашёл ни расхождений пары, ни расхождений со смыслом scope",
    async () => {
      const result = await runSweep();
      writeReport(result, { findings: FINDINGS, summary: SUMMARY });

      expect(result.counts.cases).toBeGreaterThan(1000);
      expect(result.ms).toBeLessThan(TIMEOUT);

      const groups = groupByCause(result.findings);
      const byCause = CAUSES.map((cause) => {
        const list = groups.get(cause.id) ?? [];
        return list.length === 0 ? undefined : `${cause.id} (${list.length}): ${cause.title}`;
      }).filter(Boolean);
      const uncovered = groups.get("—") ?? [];
      const report = [
        `Нарушений: ${result.findings.length} из ${result.counts.cases} случаев.`,
        ...byCause,
        ...(uncovered.length > 0 ? [`вне перечня причин: ${uncovered.length}`] : []),
        "Подробно — tests/oracle/findings.json и tests/oracle/summary.md.",
        ...result.findings
          .slice(0, 5)
          .map((f) => `• ${f.kind} ${f.seed} / ${f.patch} / ${f.scope} / ${f.address} / ${f.op}: ${f.detail.split("\nПЛАН:")[0].slice(0, 200)}`),
      ].join("\n");

      expect(result.findings.length, report).toBe(0);
    },
    TIMEOUT,
  );
});
