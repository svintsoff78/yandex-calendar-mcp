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
import { HORIZON_TO, NOW, PROBE, horizonOf, load, worldOf } from "./world.js";

const FINDINGS = new URL("./findings.json", import.meta.url);
const SUMMARY = new URL("./summary.md", import.meta.url);

/**
 * Предел на весь обход. Случаи с краю значений (INTERVAL=1000000) не
 * возвращают управление и каждый доживает до своего сторожевого предела
 * (isolate.ts), поэтому обход идёт минутами, а не секундами; предел взят с
 * запасом от замеренного времени.
 */
const TIMEOUT = 1_200_000;

describe("оракул правки", () => {
  it("корпус покрывает всё, что перечислено в задании", () => {
    expect(ORACLE_SEEDS.length).toBeGreaterThanOrEqual(35);
    expect(ORACLE_PATCHES.length).toBeGreaterThanOrEqual(28);
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
    // Испорченная форма UNTIL (RFC 5545 §3.3.10): в форме DATE при DTSTART со
    // временем и без Z при DTSTART с TZID.
    expect(ORACLE_SEEDS.some((seed) => /RRULE:[^\r\n]*UNTIL=\d{8}(?![T\d])/.test(seed.ics))).toBe(true);
    expect(ORACLE_SEEDS.some((seed) => /RRULE:[^\r\n]*UNTIL=\d{8}T\d{6}(?!Z)/.test(seed.ics) && seed.ics.includes("DTSTART;TZID="))).toBe(true);
  });

  it("корпус берёт края значений и сочетания осей, а не одни середины", () => {
    const patch = (name: string) => ORACLE_PATCHES.find((entry) => entry.name === name)?.patch;
    // Края года по RFC 5545 §3.3.5 и край INTERVAL.
    expect(patch("start:0001-01-01")).toEqual({ start: "0001-01-01T00:00:00" });
    expect(patch("start:9999-12-31")).toEqual({ start: "9999-12-31T23:00:00" });
    expect(patch("recurrence:interval=1000000")).toEqual({ recurrence: { interval: 1000000 } });
    // Повтор и время в одном патче: поодиночке обе оси перебираются, вместе — тоже.
    const both = ORACLE_PATCHES.filter(
      (entry) =>
        entry.patch.recurrence !== undefined &&
        ["start", "end", "timeZone", "allDay"].some((field) => entry.patch[field as "start"] !== undefined),
    );
    expect(both.length).toBeGreaterThanOrEqual(2);
    expect(both.some((entry) => entry.patch.start !== undefined && entry.patch.end !== undefined)).toBe(true);
    expect(both.some((entry) => entry.patch.timeZone !== undefined)).toBe(true);
    // Конец на следующие сутки после начала: разница дат — часть длительности (Р1).
    expect(patch("start+end:через полночь")).toEqual({ start: "2026-11-05T23:00:00", end: "2026-11-06T01:00:00" });
  });

  it("корпус берёт края у самих объектов, а не только у значений в патче", () => {
    // Объект у ВЕРХНЕГО КРАЯ ГОДА: конечная серия целиком внутри 9999-го. Не
    // то же, что патч start:9999-12-31: патч проверяется разбором значения, а
    // объект идёт через пределы разворота, которые считаются по началу серии.
    const edge = ORACLE_SEEDS.find((seed) => seed.name === "year-edge-9999");
    expect(edge).toBeDefined();
    expect(edge!.ics).toContain("DTSTART;TZID=Europe/Moscow:99990302T100000");
    expect(edge!.ics).toContain("RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=3");
    const edgeWorld = worldOf([edge!.ics]);
    expect(edgeWorld.snaps).toHaveLength(3);
    // Вся серия внутри 9999 года: у последней встречи тот же год, что у первой.
    const year = (ms: number) => new Date(ms).getUTCFullYear();
    expect(year(edgeWorld.snaps[0].startMs)).toBe(9999);
    expect(year(edgeWorld.snaps[2].endMs)).toBe(9999);
    // Серия конечная: пределу разворота упираться здесь не во что.
    expect(edgeWorld.ends).toBe(true);
    expect(edgeWorld.capped).toBe(false);
    // Отказ по длине серии на ней объявлен незаконным — с объяснением.
    const banned = (edge!.bannedRefusals ?? []).map((ban) => ban.code);
    expect(banned).toContain("series-too-long");
    expect(banned).toContain("until-too-far");
    for (const ban of edge!.bannedRefusals ?? []) expect(ban.why.length).toBeGreaterThan(40);

    // Шаг повтора ЧУТЬ ВЫШЕ предела: у конечной серии обязан проходить, у
    // бесконечной отказ законен. Два исхода разведены запретом по затравке.
    const step = ORACLE_PATCHES.find((entry) => entry.name === "recurrence:interval=1001");
    expect(step?.patch).toEqual({ recurrence: { interval: 1001 } });
    const ban = (step!.bannedRefusals ?? [])[0];
    expect(ban).toBeDefined();
    expect(ban.code).toBe("invalid-rule");
    const named = (name: string) => ORACLE_SEEDS.find((seed) => seed.name === name)!;
    expect(ban.where!(named("weekly-count-moscow"))).toBe(true);
    expect(ban.where!(named("until-berlin"))).toBe(true);
    expect(ban.where!(named("infinite-weekly-moscow"))).toBe(false);
    expect(ban.where!(named("infinite-daily-berlin"))).toBe(false);
    expect(ban.where!(named("year-edge-9999"))).toBe(false);

    // Скрытый след, которого разрез лишает прячущего EXDATE: EXDATE и след
    // стоят в ХВОСТЕ серии, и до них есть слоты — иначе граница разреза между
    // ними не ляжет и случай не соберётся.
    const trace = ORACLE_SEEDS.find((seed) => seed.name === "hidden-exdate-tail-moscow");
    expect(trace).toBeDefined();
    expect(trace!.ics).toContain("EXDATE;TZID=Europe/Moscow:20261117T150000");
    expect(trace!.ics).toContain("RECURRENCE-ID;TZID=Europe/Moscow:20261117T150000");
    const traceWorld = worldOf([trace!.ics]);
    // Встреча по адресу следа не видна (EXDATE), а до неё есть ещё три слота.
    expect(traceWorld.snaps.map((snap) => snap.address)).not.toContain("2026-11-17T15:00:00+03:00");
    expect(traceWorld.snaps.filter((snap) => snap.startMs < Date.parse("2026-11-17T12:00:00Z"))).toHaveLength(4);
  });

  it("горизонт разворота накрывает весь корпус и уходит дальше двух лет", () => {
    // Дальше, чем «сейчас» плюс два года, и с пробой за концом внутри.
    expect(HORIZON_TO).toBeGreaterThan(NOW + 2 * 365 * 86_400_000);
    expect(PROBE).toBeGreaterThan(NOW + 365 * 86_400_000);
    expect(PROBE).toBeLessThan(HORIZON_TO);
    for (const seed of ORACLE_SEEDS) {
      // Окно у каждой затравки своё (world.ts, horizonOf): обычное — 2026–2029,
      // у серии за ним (край года) — её собственный год.
      const horizon = horizonOf(load(seed.ics));
      const world = worldOf([seed.ics]);
      expect(world.snaps.length, seed.name).toBeGreaterThan(0);
      // Все явные слоты и начала серий — внутри окна, и с запасом от края.
      expect(world.snaps[0].startMs, seed.name).toBeGreaterThan(horizon.fromMs);
      expect(world.snaps[0].startMs, seed.name).toBeLessThan(horizon.probeMs);
      // Конечные серии кончаются внутри окна, бесконечные упираются в упор.
      expect(world.capped || world.snaps[world.snaps.length - 1].startMs < horizon.toMs, seed.name).toBe(true);
    }
    // Обычным окном накрыт весь корпус, кроме затравки у края года: ради неё
    // окно и сделано своим у каждого объекта.
    const outside = ORACLE_SEEDS.filter((seed) => horizonOf(load(seed.ics)).toMs !== HORIZON_TO);
    expect(outside.map((seed) => seed.name)).toEqual(["year-edge-9999"]);
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
