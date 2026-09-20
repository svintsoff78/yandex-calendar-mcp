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
// Сам случай считает case.ts, а зовётся он через сторожевое время
// (isolate.ts): зависание и обвал кучи становятся нарушением вида "timeout",
// а не падением прогона.
//
// Детерминированность (пункт 7): фиксированный список затравок, фиксированный
// порядок патчей и адресов, генератор случайных чисел mulberry32 с зерном
// ORACLE_SEED. Повтор обхода даёт тот же список нарушений.
import type { CalendarObject } from "../../src/ical/object.js";
import type { EditScope } from "../../src/types.js";
import type { CaseOutcome, CaseSpec } from "./case.js";
import { ADDRESS_ROLES, ORACLE_PATCHES, ORACLE_SCOPES, ORACLE_SEEDS } from "./corpus.js";
import { directRunner, isolatedRunner, type CaseRunner } from "./isolate.js";
import { addressesOf, load } from "./world.js";

export type { Finding, FindingKind } from "./case.js";
export { CASE_LIMIT_MS } from "./isolate.js";
import type { Finding } from "./case.js";

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

export interface SweepOptions {
  /** Ограничить обход этими затравками (по имени) — для отладки. */
  onlySeeds?: readonly string[];
  onlyPatches?: readonly string[];
  /** Повторять отказы с needsConfirm с подтверждением. */
  withConfirm?: boolean;
  /**
   * Выполнять случаи в том же потоке, без сторожевого времени. Только для
   * отладки одного случая: зависание уронит прогон.
   */
  inProcess?: boolean;
  /** Свой предел времени на случай (мс). */
  limitMs?: number;
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
  const runner: CaseRunner = options.inProcess ? directRunner() : isolatedRunner(options.limitMs);

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

  try {
    for (const seed of seeds) {
      // Своё зерно на затравку: выбор адресов не зависит от того, сколько
      // затравок в обходе, и отладка одной затравки повторяет полный обход.
      const random = mulberry32(ORACLE_SEED + ORACLE_SEEDS.indexOf(seed));
      const o = load(seed.ics);
      const clean = !seed.corrupted;
      for (const scope of ORACLE_SCOPES) {
        for (const address of addressesFor(o, scope, random)) {
          const common: CaseSpec = { seedName: seed.name, op: "delete", scope, role: address.role, address: address.value };
          // delete
          const del = await runner.run(common);
          counts.delete += 1;
          note(del, `delete|${scope}`, clean);
          if (withConfirm && del.refused && del.needsConfirm) {
            const again = await runner.run({ ...common, confirmed: true });
            findings.push(...again.findings);
          }
          // update
          for (const entry of patches) {
            const spec: CaseSpec = { ...common, op: "update", patchName: entry.name };
            const outcome = await runner.run(spec);
            counts.update += 1;
            note(outcome, `${entry.name}|${scope}`, clean);
            if (withConfirm && outcome.refused && outcome.needsConfirm) {
              const again = await runner.run({ ...spec, confirmed: true });
              findings.push(...again.findings);
            }
          }
        }
      }
    }
  } finally {
    await runner.close();
  }

  return { findings, refusals, codes, counts, seedsUsed: seeds.length, ms: Date.now() - started };
}
