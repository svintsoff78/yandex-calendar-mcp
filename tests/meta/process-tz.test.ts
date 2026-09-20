// Страж прогона под тремя поясами процесса (§6 плана переделки,
// docs/superpowers/plans/2026-09-19-recurring-events-rework.md).
//
// `npm run test:tz` запускает весь набор трижды, отдельными процессами, с
// TZ=UTC, TZ=Europe/Moscow и TZ=America/New_York и каждый раз передаёт тот
// же пояс в EXPECTED_TZ. Если TZ по какой-то причине не применился (его
// выставили внутри уже запущенного процесса, обёртка его срезала, пул
// воркеров не унаследовал окружение), три прогона молча прошли бы в поясе
// машины и доказали бы ничего. Этот тест ловит ровно такой пустой прогон.
//
// Без EXPECTED_TZ (обычный `npm test`) о поясе процесса не утверждается
// ничего: первый тест пропускается, остальные проверяют, что сценарии
// запуска настроены.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import config from "../../vitest.config.js";

const ZONES = ["UTC", "Europe/Moscow", "America/New_York"] as const;

// Смещение Date#getTimezoneOffset() для 1 января 2026 года: минуты, на
// которые UTC впереди местного времени (у Москвы UTC+3 → −180).
const OFFSET_ON_2026_01_01: Record<string, number> = {
  UTC: 0,
  "Europe/Moscow": -180,
  "America/New_York": 300,
};

const expected = process.env.EXPECTED_TZ;

function wallIn(zone: string, date: Date): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

function packageScripts(): Record<string, string> {
  return JSON.parse(readFileSync("package.json", "utf8")).scripts;
}

describe("пояс процесса", () => {
  it.runIf(Boolean(expected))("процесс действительно работает в поясе EXPECTED_TZ", () => {
    const zone = expected as string;
    expect(process.env.TZ).toBe(zone);
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(zone);

    // Полночь 1 января 2026 года по поясу процесса. Если TZ не применился,
    // эта полночь окажется другим моментом, и в поясе EXPECTED_TZ часы
    // покажут не 00:00. Здесь, в тесте, конструктор от чисел разрешён:
    // запрет действует только в src/ical и src/domain.
    const localMidnight = new Date(2026, 0, 1);
    expect(wallIn(zone, localMidnight)).toBe("2026-01-01 00:00");
    if (zone in OFFSET_ON_2026_01_01) {
      expect(localMidnight.getTimezoneOffset()).toBe(OFFSET_ON_2026_01_01[zone]);
    }
  });

  it("test:tz гоняет весь набор под UTC, Europe/Moscow и America/New_York и падает в конце, если упал хоть один", () => {
    const script = packageScripts()["test:tz"];
    expect(script).toBeDefined();
    for (const zone of ZONES) expect(script).toContain(zone);
    // Пояс задаётся до старта процесса и тем же значением уходит стражу.
    expect(script).toMatch(/TZ=\$\w+ EXPECTED_TZ=\$\w+ /);
    // Сбой одного пояса не обрывает прогон: прогоняются все три, сбой
    // запоминается, и падение — в конце. Иначе о поясах после первого
    // упавшего не было бы известно ничего.
    expect(script).not.toContain("|| exit 1");
    expect(script).toMatch(/\|\|\s*failed=/);
    expect(script).toContain("exit 1");
  });

  it("цепочки — отдельный проект chains, который npm test не запускает", () => {
    const scripts = packageScripts();
    expect(scripts.test).toContain("--project unit");
    expect(scripts["test:chains"]).toContain("--project chains");

    const projects = (config.test?.projects ?? []) as Array<{
      test?: { name?: string; include?: string[]; exclude?: string[] };
    }>;
    const byName = new Map(projects.map((project) => [project.test?.name, project.test]));
    expect([...byName.keys()].sort()).toEqual(["chains", "unit"]);
    expect(byName.get("unit")?.exclude).toContain("tests/chains/**");
    expect(byName.get("chains")?.include).toEqual(["tests/chains/**/*.test.ts"]);
  });
});
