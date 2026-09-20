// Выход оракула (пункт 6 задания): tests/oracle/findings.json — по записи на
// нарушение, и tests/oracle/summary.md — таблица отказов, число нарушений по
// видам и список первопричин. Оба файла пишет прогон (sweep.test.ts), чтобы
// они не расходились с кодом обхода.
import { writeFileSync } from "node:fs";
import { CAUSES, groupByCause } from "./causes.js";
import { ORACLE_PATCHES, ORACLE_SCOPES, ORACLE_SEEDS } from "./corpus.js";
import { ORACLE_SEED, type Finding, type SweepResult } from "./sweep.js";
import { HORIZON_CAP, HORIZON_FROM, HORIZON_TO, PROBE } from "./world.js";

/** Сколько знаков плана оставлять в detail: файл нарушений должен читаться. */
const PLAN_LIMIT = 900;

function trimmed(finding: Finding): Finding {
  const [head, plan] = finding.detail.split("\nПЛАН:");
  if (plan === undefined) return finding;
  const cut = plan.length > PLAN_LIMIT ? `${plan.slice(0, PLAN_LIMIT)}\n… (план обрезан)` : plan;
  return { ...finding, detail: `${head}\nПЛАН:${cut}` };
}

export interface ReportPaths {
  findings: URL | string;
  summary: URL | string;
}

const date = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function refusalTable(result: SweepResult): string[] {
  const lines = [
    "| патч | scope | вызовов | отказов | из них по адресу | доля отказов без адресных | из них снимается confirm | коды |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |",
  ];
  const names = ["delete", ...ORACLE_PATCHES.map((p) => p.name)];
  for (const name of names) {
    for (const scope of ORACLE_SCOPES) {
      const stat = result.refusals.get(`${name}|${scope}`);
      if (!stat) continue;
      const denominator = stat.total - stat.address;
      const share = denominator === 0 ? 0 : (stat.refused - stat.address) / denominator;
      const codes = Object.entries(stat.codes)
        .filter(([code]) => !code.startsWith("address:"))
        .sort((a, b) => b[1] - a[1])
        .map(([code, n]) => `${code}: ${n}`)
        .join(", ");
      const mark = share > 0.5 ? " ⚠" : "";
      lines.push(
        `| ${name} | ${scope} | ${stat.total} | ${stat.refused} | ${stat.address} | ${(share * 100).toFixed(0)}%${mark} | ${stat.needsConfirm} | ${codes || "—"} |`,
      );
    }
  }
  return lines;
}

function suspicious(result: SweepResult): string[] {
  const rows: string[] = [];
  for (const [key, stat] of result.refusals) {
    const denominator = stat.total - stat.address;
    if (denominator === 0) continue;
    const share = (stat.refused - stat.address) / denominator;
    if (share > 0.5) rows.push(`${key.replace("|", " × ")} — ${(share * 100).toFixed(0)}%`);
  }
  return rows.sort();
}

export function writeReport(result: SweepResult, paths: ReportPaths): void {
  const findings = result.findings.map(trimmed);
  writeFileSync(
    paths.findings,
    JSON.stringify(
      {
        зерно: ORACLE_SEED,
        затравок: ORACLE_SEEDS.length,
        патчей: ORACLE_PATCHES.length,
        случаев: result.counts.cases,
        нарушений: findings.length,
        по_видам: {
          disagreement: findings.filter((f) => f.kind === "disagreement").length,
          semantics: findings.filter((f) => f.kind === "semantics").length,
          "bare-error": findings.filter((f) => f.kind === "bare-error").length,
        },
        findings,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  const groups = groupByCause(result.findings);
  const kinds = {
    disagreement: findings.filter((f) => f.kind === "disagreement").length,
    semantics: findings.filter((f) => f.kind === "semantics").length,
    "bare-error": findings.filter((f) => f.kind === "bare-error").length,
  };

  const md: string[] = [
    "# Оракул правки: итог обхода",
    "",
    "Полный обход операций правки: каждое сочетание (затравка × патч × адрес × scope), отдельно для",
    "update и delete. Файл создаёт сам прогон (`npm run test:oracle`), править руками его не нужно.",
    "",
    "## Что проверяется",
    "",
    "1. **Согласие пары.** Законных исходов ровно два: планировщик отказал типизированным `EditRefusal`",
    "   (или `AddressError` по адресу) — либо план построен и `verifyPlan` его принял. Исход «план построен,",
    "   предохранитель отверг» — дефект без разбирательства: двое несогласны между собой. `verifyPlan`",
    "   зовётся так, как обязана звать оркестрация: с патчем в `GuardOptions.patch` у каждого update.",
    "2. **Семантика scope.** План пишется на подставной сервер (`tests/support/fakeCaldav.ts`, поведение по",
    "   умолчанию — яндексовское, Ж13–Ж16), результат разворачивается чтением и сверяется с ожиданием,",
    "   посчитанным из смысла scope независимо от планировщика (`semantics.ts`).",
    "",
    "## Цифры прогона",
    "",
    `- зерно генератора случайных чисел: **${ORACLE_SEED}** (выбор адресов сверх предела; повтор обхода даёт тот же список);`,
    `- затравок: ${ORACLE_SEEDS.length}, патчей: ${ORACLE_PATCHES.length}, областей правки: ${ORACLE_SCOPES.length};`,
    `- случаев: ${result.counts.cases} (update ${result.counts.update}, delete ${result.counts.delete});`,
    `- из них: планов построено ${result.counts.plans}, пустых планов ${result.counts.noop}, отказов ${result.counts.refusals};`,
    `- время обхода: ${(result.ms / 1000).toFixed(1)} с;`,
    `- горизонт разворота: ${date(HORIZON_FROM)} … ${date(HORIZON_TO)}, упор ${HORIZON_CAP} встреч, проба «за концом» — ${date(PROBE)}.`,
    "",
    "## Нарушения по видам",
    "",
    "| вид | сколько | что значит |",
    "| --- | ---: | --- |",
    `| disagreement | ${kinds.disagreement} | планировщик построил план, предохранитель его отверг |`,
    `| semantics | ${kinds.semantics} | записанный результат разошёлся со смыслом scope или сервер не принял запись |`,
    `| bare-error | ${kinds["bare-error"]} | планировщик бросил голую ошибку вместо типизированного отказа |`,
    `| **всего** | **${findings.length}** | |`,
    "",
    "## Первопричины",
    "",
    `Различных первопричин: ${CAUSES.filter((c) => (groups.get(c.id) ?? []).length > 0).length} (предел задания — 12).`,
    "",
  ];

  for (const cause of CAUSES) {
    const list = groups.get(cause.id) ?? [];
    if (list.length === 0) continue;
    const seeds = [...new Set(list.map((f) => f.seed))];
    const patches = [...new Set(list.map((f) => f.patch))];
    md.push(
      `### ${cause.id}. ${cause.title} — ${list.length} нарушени${list.length === 1 ? "е" : "й"}`,
      "",
      cause.detail,
      "",
      `- затравки: ${seeds.join(", ")};`,
      `- патчи: ${patches.join(", ")};`,
      `- области: ${[...new Set(list.map((f) => f.scope))].join(", ")};`,
      `- где чинить: ${cause.where}`,
      "",
    );
  }
  const rest = groups.get("—") ?? [];
  if (rest.length > 0) {
    md.push(
      `### Вне перечня причин — ${rest.length}`,
      "",
      "Записи, которые ни одна причина не объясняет; разбирать поимённо в findings.json:",
      "",
      ...rest.slice(0, 20).map((f) => `- ${f.kind}: ${f.seed} / ${f.patch} / ${f.scope} / ${f.address} / ${f.op}`),
      "",
    );
  }

  md.push(
    "## Учёт отказов (пункт 5)",
    "",
    "Доля отказов по каждой паре (патч, scope) на **чистых** затравках — испорченные чужими клиентами",
    "(`two-rrules-moscow`, `duplicate-override-moscow`) в счёт не идут: у них любой отказ законен.",
    "",
    "В корпусе адресов нарочно есть те, которых у затравки нет (адрес за концом серии, слот под EXDATE,",
    "скрытое переопределение): отказы по адресу (`AddressError`) — это про адрес, а не про строгость патча,",
    "поэтому они вынесены в свой столбец, а доля считается без них. Подозрительным помечено (⚠) всё, что",
    "отказывает больше чем на половине чистых затравок.",
    "",
    ...refusalTable(result),
    "",
    "Подозрительные пары:",
    "",
    ...(suspicious(result).length === 0 ? ["- нет."] : suspicious(result).map((row) => `- ${row}`)),
    "",
    "Разбор подозрительных пар (отказы разобраны поимённо, ложной строгости в них нет):",
    "",
    "- `status × *` — в языке правки (`FieldPatch`, src/ical/plan.ts) поля `status` нет вовсе. Патч оставлен в",
    "  корпусе нарочно: он показывает, что на неизвестное поле приходит типизированный `invalid-field`, а не",
    "  голая ошибка. Это расхождение корпуса задания с языком правки, а не дефект.",
    "- `allDay:true × this` и `allDay:true+start+end × this` — «весь день» у одной встречи серии запрещён",
    "  формой времени (RFC 5545 §3.8.4.4): у переопределения форма обязана совпадать с серией. Отказ",
    "  `invalid-time` с внятным hint «передайте scope: all_series».",
    "- `recurrence:* × this` — повтор у одной встречи не меняется по смыслу операции; отказ приходит с",
    "  подсказкой про all_series и this_and_following. Код при этом `invalid-field`, хотя поле известное и",
    "  дело в области правки: на ложную строгость не тянет, но код вводит в заблуждение.",
    "- `recurrence:replace × this_and_following` и `× all_series` — почти всё это `confirm-required`:",
    "  `replace` собирает правило только из патча, и потерянные части (BYDAY, COUNT, INTERVAL) обязаны быть",
    "  подтверждены (О11). Отказ снимается повтором с confirm — оракул такой повтор делает и нарушений в нём",
    "  не нашёл.",
    "",
    "## Чего оракул не проверяет",
    "",
    "- У встреч со своим компонентом (переопределения, оторванные, перенесённые) точное ожидание полей и",
    "  времени не считается: у них свои значения (О7). От них требуется не пропасть, не размножиться и не",
    "  поменять время под патчем поля.",
    "- У патчей повтора (`recurrence:*`) проверяются только инварианты области: голова серии до границы",
    "  тождественна, встречи не исчезают молча, конец серии меняется только по поводу из патча. Пересчитывать",
    "  RRULE своим кодом оракул не берётся.",
    "- «timeZone без start сохраняет моменты» сверяется якорем — моментом первой встречи области. Дальше",
    "  моменты законно расходятся: в поясе с переводом часов стенное время нового пояса правит остальными",
    "  встречами.",
    "- У бесконечной серии края упора в 400 встреч у миров «до» и «после» не совпадают на одну встречу:",
    "  счёт там сверяется с допуском в единицу, а адресов у самого упора обход не берёт.",
    "",
    "## Как перезапустить",
    "",
    "```sh",
    "npm run test:oracle",
    "```",
    "",
    "Обход детерминирован: тот же список нарушений при повторе. Коды отказов и их смысл — в",
    "[refusals.md](./refusals.md), сами нарушения с готовым воспроизведением — в",
    "[findings.json](./findings.json).",
    "",
  );

  writeFileSync(paths.summary, md.join("\n"), "utf8");
}
