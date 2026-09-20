// Обход операций правки (пункт 4 задания): для каждого сочетания
// (затравка × патч × адрес × scope), отдельно для update и для delete,
// выполняются две проверки.
//
// (а) СОГЛАСИЕ ПАРЫ. Законных исходов ровно два: планировщик отказал
//     типизированным EditRefusal (или AddressError по адресу) — либо план
//     построен и предохранитель его принял. Исход «план построен,
//     предохранитель отверг» — дефект всегда: двое несогласны между собой.
//     verifyPlan зовётся так, как обязана звать оркестрация: с патчем в
//     GuardOptions.patch при каждом update (guard.ts, GuardOptions.patch —
//     «контракт с оркестрацией (З13): у op update патч передаётся всегда»).
//
// (б) СЕМАНТИКА. План пишется на подставной сервер, результат
//     разворачивается чтением и сверяется с ожиданием, посчитанным из
//     смысла scope (semantics.ts), а не из планировщика.
//
// Детерминированность (пункт 7): фиксированный список затравок, фиксированный
// порядок патчей и адресов, генератор случайных чисел mulberry32 с зерном
// ORACLE_SEED. Повтор обхода даёт тот же список нарушений.
import { planDelete, planUpdate } from "../../src/ical/edit.js";
import { GuardError, verifyPlan } from "../../src/ical/guard.js";
import { AddressError } from "../../src/ical/instances.js";
import type { CalendarObject } from "../../src/ical/object.js";
import { EditRefusal, type WritePlan } from "../../src/ical/plan.js";
import type { EditScope } from "../../src/types.js";
import { applyPlan, standWith, storedIcs } from "./apply.js";
import { ADDRESS_ROLES, ORACLE_PATCHES, ORACLE_SCOPES, ORACLE_SEEDS, type OraclePatch, type OracleSeed } from "./corpus.js";
import { checkSemantics } from "./semantics.js";
import { NOW, addressesOf, load, worldOf, type World } from "./world.js";

/** Зерно генератора случайных чисел; записано и в summary.md. */
export const ORACLE_SEED = 20260920;

/** Сколько адресов берётся на каждую область правки. */
const ADDRESS_LIMIT: Record<EditScope, number> = { this: 6, this_and_following: 6, all_series: 3 };

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type FindingKind = "disagreement" | "semantics" | "bare-error";

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

export interface RefusalStat {
  /** Всего вызовов на чистых затравках. */
  total: number;
  /** Из них отказов. */
  refused: number;
  /** Из них отказов по адресу (AddressError): адрес не подходит этой затравке. */
  address: number;
  /** Из них отказов, снимаемых подтверждением (confirm). */
  needsConfirm: number;
  codes: Record<string, number>;
}

export interface SweepResult {
  findings: Finding[];
  /** Ключ — "патч|scope". */
  refusals: Map<string, RefusalStat>;
  /** Коды отказов по всему обходу: код → сколько раз и пример сообщения. */
  codes: Map<string, { count: number; example: string; needsConfirm: boolean }>;
  counts: { cases: number; update: number; delete: number; plans: number; refusals: number; noop: number };
  seedsUsed: number;
  ms: number;
}

interface CaseAddress {
  role: string;
  value?: string;
}

/** Адреса затравки для области правки: обязательные, затем выбор по зерну. */
function addressesFor(o: CalendarObject, scope: EditScope, random: () => number): CaseAddress[] {
  const found = addressesOf(o);
  const seen = new Set<string>();
  const available: CaseAddress[] = [];
  for (const role of ADDRESS_ROLES) {
    if (!found.has(role)) continue;
    const value = found.get(role);
    const token = value ?? "∅";
    if (seen.has(token)) continue;
    seen.add(token);
    available.push({ role, value });
  }
  const limit = ADDRESS_LIMIT[scope];
  if (available.length <= limit) return available;
  const head = available.slice(0, 2); // "none" и "first" — всегда
  const tail = available.slice(2);
  // Перемешивание Фишера — Йетса на фиксированном зерне: выбор устойчив.
  for (let i = tail.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [tail[i], tail[j]] = [tail[j], tail[i]];
  }
  return [...head, ...tail.slice(0, limit - head.length)].sort(
    (a, b) => ADDRESS_ROLES.indexOf(a.role as never) - ADDRESS_ROLES.indexOf(b.role as never),
  );
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

function repro(
  seed: OracleSeed,
  op: "update" | "delete",
  scope: EditScope,
  address: string | undefined,
  entry: OraclePatch | undefined,
  tail: string,
): string {
  const call =
    op === "update"
      ? `const plan = planUpdate(o, { now: NOW, scope: ${JSON.stringify(scope)}, instanceStart: ${JSON.stringify(address)}, patch });`
      : `const plan = planDelete(o, { now: NOW, scope: ${JSON.stringify(scope)}, instanceStart: ${JSON.stringify(address)} });`;
  const guard =
    op === "update"
      ? `verifyPlan(ics, plan, ENV, { now: NOW, patch }); // как зовёт оркестрация: с патчем`
      : `verifyPlan(ics, plan, ENV, { now: NOW });`;
  return [
    `import { ${op === "update" ? "planUpdate" : "planDelete"} } from "../../src/ical/edit.js";`,
    `import { verifyPlan } from "../../src/ical/guard.js";`,
    `import { ORACLE_SEEDS } from "./corpus.js";`,
    `import { ENV, NOW, load, worldOf } from "./world.js";`,
    `import { applyPlan, standWith, storedIcs } from "./apply.js";`,
    ``,
    `const seed = ORACLE_SEEDS.find((s) => s.name === ${JSON.stringify(seed.name)})!;`,
    `const stand = standWith(seed);`,
    `const ics = stand.fake.ics(stand.path);`,
    `const o = load(ics);`,
    ...(op === "update" ? [`const patch = ${JSON.stringify(entry?.patch ?? {})};`] : []),
    call,
    guard,
    `await applyPlan(stand, plan);`,
    `console.log(worldOf(storedIcs(stand)).snaps.map((s) => s.address + " " + s.summary));`,
    `// ${tail}`,
  ].join("\n");
}

interface CaseInput {
  seed: OracleSeed;
  op: "update" | "delete";
  scope: EditScope;
  address: CaseAddress;
  entry?: OraclePatch;
  before: World;
  /** Повтор отказа с подтверждением потерь (confirm + etag). */
  confirmed?: boolean;
}

interface CaseOutcome {
  findings: Finding[];
  refused: boolean;
  code?: string;
  needsConfirm: boolean;
  message?: string;
  noop: boolean;
}

async function runCase(input: CaseInput): Promise<CaseOutcome> {
  const { seed, op, scope, address, entry, before, confirmed } = input;
  const findings: Finding[] = [];
  const name = entry ? entry.name : "—";
  const addressLabel = `${address.role}${address.value === undefined ? "" : ` (${address.value})`}`;
  const stand = standWith(seed);
  const beforeIcs = stand.fake.ics(stand.path);
  const o = load(beforeIcs);
  const common = { seed: seed.name, patch: confirmed ? `${name} +confirm` : name, scope, address: addressLabel, op } as const;

  let plan: WritePlan;
  try {
    plan =
      op === "update"
        ? planUpdate(o, {
            now: NOW,
            scope,
            instanceStart: address.value,
            patch: entry!.patch,
            confirm: confirmed,
            etag: confirmed ? stand.etag : undefined,
            currentEtag: stand.etag,
          })
        : planDelete(o, {
            now: NOW,
            scope,
            instanceStart: address.value,
            confirm: confirmed,
            etag: confirmed ? stand.etag : undefined,
            currentEtag: stand.etag,
          });
  } catch (error) {
    if (error instanceof EditRefusal) {
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
      minimalRepro: repro(seed, op, scope, address.value, entry, `здесь ${bare.name}: ${bare.message.slice(0, 120)}`),
    });
    return { findings, refused: false, needsConfirm: false, noop: false };
  }

  // (а) согласие пары: предохранитель обязан принять построенный план.
  try {
    verifyPlan(beforeIcs, plan, o.env, { now: NOW, patch: op === "update" ? entry!.patch : undefined });
  } catch (error) {
    const guard = error as Error;
    const said =
      guard instanceof GuardError ? guard.problems.map((p) => `[${p.code}] ${p.message}`).join(" ") : `${guard.name}: ${guard.message}`;
    findings.push({
      ...common,
      kind: "disagreement",
      detail: `планировщик построил ${planSummary(plan)}, предохранитель его отверг: ${said}\nПЛАН:\n${icsOfPlan(plan)}`,
      minimalRepro: repro(seed, op, scope, address.value, entry, `здесь ${guard instanceof GuardError ? `GuardError ${guard.code}` : guard.name}`),
    });
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
      minimalRepro: repro(seed, op, scope, address.value, entry, `здесь запись отклонена стендом: ${applied.error.message.slice(0, 120)}`),
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
      minimalRepro: repro(seed, op, scope, address.value, entry, `здесь объект после записи не читается`),
    });
    return { findings, refused: false, needsConfirm: false, noop: false };
  }

  const problems = checkSemantics({
    o,
    before,
    after,
    op,
    scope,
    address: address.value,
    entry,
    declaredLosses: plan.removed.map((loss) => loss.instanceStart),
  });
  for (const problem of problems) {
    findings.push({
      ...common,
      kind: "semantics",
      detail: `${problem}\nПЛАН:\n${icsOfPlan(plan)}`,
      minimalRepro: repro(seed, op, scope, address.value, entry, `здесь расходится со смыслом scope: ${problem.slice(0, 120)}`),
    });
  }
  return { findings, refused: false, needsConfirm: false, noop: false };
}

export interface SweepOptions {
  /** Ограничить обход этими затравками (по имени) — для отладки. */
  onlySeeds?: readonly string[];
  onlyPatches?: readonly string[];
  /** Повторять отказы с needsConfirm с подтверждением. */
  withConfirm?: boolean;
}

export async function runSweep(options: SweepOptions = {}): Promise<SweepResult> {
  const started = Date.now();
  const findings: Finding[] = [];
  const refusals = new Map<string, RefusalStat>();
  const codes = new Map<string, { count: number; example: string; needsConfirm: boolean }>();
  const counts = { cases: 0, update: 0, delete: 0, plans: 0, refusals: 0, noop: 0 };
  const seeds = ORACLE_SEEDS.filter((seed) => !options.onlySeeds || options.onlySeeds.includes(seed.name));
  const patches = ORACLE_PATCHES.filter((entry) => !options.onlyPatches || options.onlyPatches.includes(entry.name));
  const withConfirm = options.withConfirm ?? true;

  const note = (outcome: CaseOutcome, key: string | undefined, clean: boolean) => {
    counts.cases += 1;
    findings.push(...outcome.findings);
    if (outcome.noop) counts.noop += 1;
    if (outcome.refused) {
      counts.refusals += 1;
      const code = outcome.code ?? "?";
      const seen = codes.get(code);
      if (seen) seen.count += 1;
      else codes.set(code, { count: 1, example: outcome.message ?? "", needsConfirm: outcome.needsConfirm });
    } else if (!outcome.noop) {
      counts.plans += 1;
    }
    if (key && clean) {
      const stat = refusals.get(key) ?? { total: 0, refused: 0, address: 0, needsConfirm: 0, codes: {} };
      stat.total += 1;
      if (outcome.refused) {
        stat.refused += 1;
        if (outcome.code?.startsWith("address:")) stat.address += 1;
        if (outcome.needsConfirm) stat.needsConfirm += 1;
        const code = outcome.code ?? "?";
        stat.codes[code] = (stat.codes[code] ?? 0) + 1;
      }
      refusals.set(key, stat);
    }
  };

  for (const seed of seeds) {
    // Своё зерно на затравку: выбор адресов не зависит от того, сколько
    // затравок в обходе, и отладка одной затравки повторяет полный обход.
    const random = mulberry32(ORACLE_SEED + ORACLE_SEEDS.indexOf(seed));
    const before = worldOf([seed.ics]);
    const o = load(seed.ics);
    const clean = !seed.corrupted;
    for (const scope of ORACLE_SCOPES) {
      for (const address of addressesFor(o, scope, random)) {
        // delete
        const del = await runCase({ seed, op: "delete", scope, address, before });
        counts.delete += 1;
        note(del, `delete|${scope}`, clean);
        if (withConfirm && del.refused && del.needsConfirm) {
          const again = await runCase({ seed, op: "delete", scope, address, before, confirmed: true });
          findings.push(...again.findings);
        }
        // update
        for (const entry of patches) {
          const outcome = await runCase({ seed, op: "update", scope, address, entry, before });
          counts.update += 1;
          note(outcome, `${entry.name}|${scope}`, clean);
          if (withConfirm && outcome.refused && outcome.needsConfirm) {
            const again = await runCase({ seed, op: "update", scope, address, entry, before, confirmed: true });
            findings.push(...again.findings);
          }
        }
      }
    }
  }

  return { findings, refusals, codes, counts, seedsUsed: seeds.length, ms: Date.now() - started };
}
