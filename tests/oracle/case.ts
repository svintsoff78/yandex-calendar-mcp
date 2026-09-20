// Один случай обхода: планировщик, предохранитель, запись на подставной
// сервер и сверка со смыслом scope. Вынесено из sweep.ts отдельным модулем,
// потому что случай выполняется в чужом потоке (isolate.ts, worker.mjs): туда
// уходит только его описание (`CaseSpec`), а не живые объекты.
//
// Законных исходов ровно два: планировщик отказал типизированным
// EditRefusal (или AddressError по адресу) — либо план построен, принят
// предохранителем и записан. Всё прочее — нарушение того или иного вида.
import { planDelete, planUpdate } from "../../src/ical/edit.js";
import { GuardError, verifyPlan } from "../../src/ical/guard.js";
import { AddressError } from "../../src/ical/instances.js";
import { EditRefusal, type WritePlan } from "../../src/ical/plan.js";
import type { EditScope } from "../../src/types.js";
import { applyPlan, standWith, storedIcs } from "./apply.js";
import { ORACLE_PATCHES, ORACLE_SEEDS, type OraclePatch, type OracleSeed, type RefusalBan } from "./corpus.js";
import { checkSemantics } from "./semantics.js";
import { NOW, load, worldOf, type World } from "./world.js";

/**
 * Вид нарушения:
 * - `disagreement` — план построен, а предохранитель его отверг: двое
 *   несогласны между собой;
 * - `semantics` — записанный результат разошёлся со смыслом scope либо
 *   сервер не принял запись;
 * - `bare-error` — планировщик бросил голую ошибку вместо типизированного
 *   отказа;
 * - `bare-guard` — предохранитель бросил не GuardError, а голую ошибку
 *   библиотеки: наружу ушло бы не «правка отклонена», а внутренний сбой.
 *   Это нарушение договора одного участника, а не разногласие пары, поэтому
 *   считается отдельно от `disagreement`;
 * - `over-strict` — отказ с кодом, который корпус объявил здесь незаконным
 *   (`bannedRefusals` затравки или патча): правка обязана была пройти или
 *   отказать по другому поводу. Отказ сам по себе — законный исход, и
 *   прочие проверки его не разбирают вовсе; этот вид — единственное место,
 *   где отказ считается нарушением, и только там, где корпус назвал, почему;
 * - `timeout` — случай не уложился в предел времени или исчерпал кучу:
 *   планировщик или предохранитель зациклился либо разогнал память.
 */
export type FindingKind = "disagreement" | "semantics" | "bare-error" | "bare-guard" | "over-strict" | "timeout";

export interface Finding {
  kind: FindingKind;
  seed: string;
  patch: string;
  scope: EditScope;
  address: string;
  op: "update" | "delete";
  detail: string;
  minimalRepro: string;
}

/**
 * Описание случая — всё, что нужно, чтобы его выполнить и повторить.
 * Переносится между потоками, поэтому в нём только строки и признаки:
 * затравка и патч называются по имени, а не передаются объектами.
 */
export interface CaseSpec {
  seedName: string;
  op: "update" | "delete";
  scope: EditScope;
  /** Роль адреса в корпусе — для читаемых таблиц. */
  role: string;
  /** Сам адрес; undefined — вызов без instanceStart. */
  address?: string;
  /** Имя патча; у delete патча нет. */
  patchName?: string;
  /** Повтор отказа с подтверждением потерь (confirm + etag). */
  confirmed?: boolean;
}

export interface CaseOutcome {
  findings: Finding[];
  refused: boolean;
  code?: string;
  needsConfirm: boolean;
  message?: string;
  noop: boolean;
}

/** Миры «до» по затравкам: у бесконечной серии разворот не бесплатный. */
const beforeWorlds = new Map<string, World>();

function seedNamed(name: string): OracleSeed {
  const seed = ORACLE_SEEDS.find((s) => s.name === name);
  if (!seed) throw new Error(`затравки ${name} в корпусе нет`);
  return seed;
}

function patchNamed(name: string): OraclePatch {
  const entry = ORACLE_PATCHES.find((p) => p.name === name);
  if (!entry) throw new Error(`патча ${name} в корпусе нет`);
  return entry;
}

function planSummary(plan: WritePlan): string {
  if (plan.kind === "split") return `план split: продолжение ${plan.continuation.uid}, граница ${plan.boundary}`;
  if (plan.kind === "put") return `план put, ${plan.ics.split("\r\n").length} строк`;
  return `план ${plan.kind}`;
}

function icsOfPlan(plan: WritePlan): string {
  if (plan.kind === "put") return plan.ics;
  if (plan.kind === "split") return `ПРОДОЛЖЕНИЕ\n${plan.continuation.ics}\nУСЕЧЁННЫЙ\n${plan.truncated.ics}`;
  return "";
}

/** Готовое воспроизведение случая: его можно вставить в файл и запустить. */
export function repro(spec: CaseSpec, tail: string): string {
  const { seedName, op, scope, address, patchName, confirmed } = spec;
  // Обход зовёт планировщик с etag и currentEtag всегда, а confirm ставит
  // только при повторе подтверждённого отказа. Без этих трёх полей
  // воспроизведение расходится с описанным исходом: неподтверждённый вызов
  // упирается в confirm-required там, где обход шёл дальше.
  const consent = `confirm: ${confirmed === true}, etag: ${confirmed ? "stand.etag" : "undefined"}, currentEtag: stand.etag`;
  const call =
    op === "update"
      ? `const plan = planUpdate(o, { now: NOW, scope: ${JSON.stringify(scope)}, instanceStart: ${JSON.stringify(address)}, patch, ${consent} });`
      : `const plan = planDelete(o, { now: NOW, scope: ${JSON.stringify(scope)}, instanceStart: ${JSON.stringify(address)}, ${consent} });`;
  const guard =
    op === "update"
      ? `verifyPlan(ics, plan, ENV, { now: NOW, patch }); // как зовёт оркестрация: с патчем`
      : `verifyPlan(ics, plan, ENV, { now: NOW });`;
  const patch = patchName === undefined ? undefined : patchNamed(patchName).patch;
  return [
    `import { ${op === "update" ? "planUpdate" : "planDelete"} } from "../../src/ical/edit.js";`,
    `import { verifyPlan } from "../../src/ical/guard.js";`,
    `import { ORACLE_SEEDS } from "./corpus.js";`,
    `import { ENV, NOW, load, worldOf } from "./world.js";`,
    `import { applyPlan, standWith, storedIcs } from "./apply.js";`,
    ``,
    `const seed = ORACLE_SEEDS.find((s) => s.name === ${JSON.stringify(seedName)})!;`,
    `const stand = standWith(seed);`,
    `const ics = stand.fake.ics(stand.path);`,
    `const o = load(ics);`,
    ...(op === "update" ? [`const patch = ${JSON.stringify(patch ?? {})};`] : []),
    call,
    guard,
    `await applyPlan(stand, plan);`,
    `console.log(worldOf(storedIcs(stand)).snaps.map((s) => s.address + " " + s.summary));`,
    `// ${tail}`,
  ].join("\n");
}

/**
 * Запрет, под который попал отказ: первый по порядку (сперва запреты
 * затравки, затем патча). `undefined` — отказ законен, как и всякий другой.
 *
 * Отказ по адресу (`AddressError`) сюда не попадает вовсе: он про то, что
 * адреса у затравки нет, а не про строгость правки. Отказ, снимаемый
 * подтверждением (`needsConfirm`), тоже не в счёт: обход повторяет его с
 * confirm, и исход считается по повтору.
 */
export function bannedRefusal(seed: OracleSeed, entry: OraclePatch | undefined, code: string): RefusalBan | undefined {
  const bans = [...(seed.bannedRefusals ?? []), ...(entry?.bannedRefusals ?? [])];
  return bans.find((ban) => ban.code === code && (ban.where === undefined || ban.where(seed)));
}

/** Общие поля нарушения по описанию случая. */
export function labelOf(spec: CaseSpec): Pick<Finding, "seed" | "patch" | "scope" | "address" | "op"> {
  const name = spec.patchName ?? "—";
  return {
    seed: spec.seedName,
    patch: spec.confirmed ? `${name} +confirm` : name,
    scope: spec.scope,
    address: `${spec.role}${spec.address === undefined ? "" : ` (${spec.address})`}`,
    op: spec.op,
  };
}

export async function runCase(spec: CaseSpec): Promise<CaseOutcome> {
  const { op, scope, address, confirmed } = spec;
  const seed = seedNamed(spec.seedName);
  const entry = spec.patchName === undefined ? undefined : patchNamed(spec.patchName);
  const findings: Finding[] = [];
  const stand = standWith(seed);
  const beforeIcs = stand.fake.ics(stand.path);
  const o = load(beforeIcs);
  let before = beforeWorlds.get(seed.name);
  if (!before) {
    before = worldOf([seed.ics]);
    beforeWorlds.set(seed.name, before);
  }
  const common = labelOf(spec);

  let plan: WritePlan;
  try {
    plan =
      op === "update"
        ? planUpdate(o, {
            now: NOW,
            scope,
            instanceStart: address,
            patch: entry!.patch,
            confirm: confirmed,
            etag: confirmed ? stand.etag : undefined,
            currentEtag: stand.etag,
          })
        : planDelete(o, {
            now: NOW,
            scope,
            instanceStart: address,
            confirm: confirmed,
            etag: confirmed ? stand.etag : undefined,
            currentEtag: stand.etag,
          });
  } catch (error) {
    if (error instanceof EditRefusal) {
      const ban = error.needsConfirm ? undefined : bannedRefusal(seed, entry, error.code);
      if (ban) {
        findings.push({
          ...common,
          kind: "over-strict",
          detail:
            `правка отказала кодом ${error.code}, хотя обязана была пройти: ${ban.why}\n` +
            `ОТКАЗ: ${error.message}`,
          minimalRepro: repro(spec, `здесь отказ ${error.code}, а правка обязана проходить: ${ban.why.slice(0, 120)}`),
        });
      }
      return { findings, refused: true, code: error.code, needsConfirm: error.needsConfirm, message: error.message, noop: false };
    }
    if (error instanceof AddressError) {
      return { findings, refused: true, code: `address:${error.code}`, needsConfirm: false, message: error.message, noop: false };
    }
    const bare = error as Error;
    findings.push({
      ...common,
      kind: "bare-error",
      detail: `планировщик бросил ${bare.name ?? "ошибку"} вместо типизированного отказа: ${bare.message}`,
      minimalRepro: repro(spec, `здесь ${bare.name}: ${bare.message.slice(0, 120)}`),
    });
    return { findings, refused: false, needsConfirm: false, noop: false };
  }

  // (а) согласие пары: предохранитель обязан принять построенный план.
  try {
    verifyPlan(beforeIcs, plan, o.env, { now: NOW, patch: op === "update" ? entry!.patch : undefined });
  } catch (error) {
    const guard = error as Error;
    if (guard instanceof GuardError) {
      findings.push({
        ...common,
        kind: "disagreement",
        detail:
          `планировщик построил ${planSummary(plan)}, предохранитель его отверг: ` +
          `${guard.problems.map((p) => `[${p.code}] ${p.message}`).join(" ")}\nПЛАН:\n${icsOfPlan(plan)}`,
        minimalRepro: repro(spec, `здесь GuardError ${guard.code}`),
      });
    } else {
      // Голая ошибка библиотеки наружу — нарушение договора предохранителя:
      // он обязан либо принять план, либо отвергнуть его GuardError.
      findings.push({
        ...common,
        kind: "bare-guard",
        detail:
          `предохранитель бросил ${guard.name ?? "ошибку"} вместо GuardError (${planSummary(plan)}): ` +
          `${guard.message}\nПЛАН:\n${icsOfPlan(plan)}`,
        minimalRepro: repro(spec, `здесь голая ошибка предохранителя ${guard.name}: ${guard.message.slice(0, 120)}`),
      });
    }
    return { findings, refused: false, needsConfirm: false, noop: plan.kind === "noop" };
  }

  if (plan.kind === "noop") return { findings, refused: false, needsConfirm: false, noop: true };

  // (б) семантика: план пишется на стенд и разворачивается чтением.
  const applied = await applyPlan(stand, plan);
  if (!applied.ok) {
    findings.push({
      ...common,
      kind: "semantics",
      detail:
        `подставной сервер не принял запись (${planSummary(plan)}): ${applied.error.message}` +
        (applied.rejections.length > 0 ? ` Причины строгого режима: ${applied.rejections.join("; ")}.` : "") +
        `\nПЛАН:\n${icsOfPlan(plan)}`,
      minimalRepro: repro(spec, `здесь запись отклонена стендом: ${applied.error.message.slice(0, 120)}`),
    });
    return { findings, refused: false, needsConfirm: false, noop: false };
  }

  let after: World;
  try {
    after = worldOf(storedIcs(stand));
  } catch (error) {
    findings.push({
      ...common,
      kind: "semantics",
      detail: `после записи объект не читается: ${(error as Error).message}\nПЛАН:\n${icsOfPlan(plan)}`,
      minimalRepro: repro(spec, `здесь объект после записи не читается`),
    });
    return { findings, refused: false, needsConfirm: false, noop: false };
  }

  const problems = checkSemantics({
    o,
    before,
    after,
    op,
    scope,
    address,
    entry,
    declaredLosses: plan.removed.map((loss) => loss.instanceStart),
    notices: plan.notices,
  });
  for (const problem of problems) {
    findings.push({
      ...common,
      kind: "semantics",
      detail: `${problem}\nПЛАН:\n${icsOfPlan(plan)}`,
      minimalRepro: repro(spec, `здесь расходится со смыслом scope: ${problem.slice(0, 120)}`),
    });
  }
  return { findings, refused: false, needsConfirm: false, noop: false };
}
