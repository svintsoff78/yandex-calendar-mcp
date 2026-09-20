// Семантика scope (пункт 4б задания): ожидание считается ИЗ СМЫСЛА области
// правки по затравке и патчу, а не из того, что сделал планировщик. В
// src/ical/edit.ts этот файл не заглядывает: правила взяты из описания
// языка правки (src/ical/plan.ts) и решений Р1, О7, О11.
//
// Что проверяется всегда:
// - вне области правки встречи тождественны: адрес, момент начала, момент
//   конца, всесуточность и видимые поля;
// - встреч не прибавилось и не убавилось (кроме правки повтора и удаления);
// - удалённые действительно исчезли, и только они;
// - конец серии («проба за концом») изменился только там, где это оправдано
//   патчем.
//
// Что проверяется, когда ожидание считается точно:
// - патч поля (summary, description, location, участники) не двигает ни одну
//   встречу области и ставит новое значение слотам без своего компонента;
// - патч времени не трогает видимые поля и ставит слотам без своего
//   компонента ровно то время, которое следует из смысла области: у "this" —
//   названный момент целиком, у "this_and_following" и "all_series" — только
//   время суток и длительность, дата слота прежняя (Р1).
//
// Встречи со своим компонентом (переопределения, оторванные, перенесённые)
// в точное ожидание не входят: у них своё время и свои поля (О7), и оракул
// требует от них только того, что обязано выполняться всегда, — не пропасть
// и не размножиться.
import ICAL from "ical.js";
import type { CalendarObject } from "../../src/ical/object.js";
import type { EditScope } from "../../src/types.js";
import type { OraclePatch } from "./corpus.js";
import { ENV, SEP, fieldSigOf, rdateKeysOf, keyAtLeast, keyOfAddress, msOf, showSnap, sigOf, timeSigOf, type Snap, type World } from "./world.js";

export interface SemanticsCase {
  o: CalendarObject;
  before: World;
  after: World;
  op: "update" | "delete";
  scope: EditScope;
  address?: string;
  entry?: OraclePatch;
  /**
   * Адреса встреч, которые план объявил потерянными (plan.removed, О11):
   * пользователь их подтвердил, и исчезнуть им позволено. Всё остальное
   * вне области правки обязано остаться тождественным.
   */
  declaredLosses?: readonly string[];
}

/** Множество строк с подсчётом: сравнение наборов встреч без порядка. */
class Bag {
  private readonly counts = new Map<string, number>();

  constructor(values: Iterable<string>) {
    for (const value of values) this.counts.set(value, (this.counts.get(value) ?? 0) + 1);
  }

  take(value: string): boolean {
    const n = this.counts.get(value) ?? 0;
    if (n === 0) return false;
    if (n === 1) this.counts.delete(value);
    else this.counts.set(value, n - 1);
    return true;
  }

  rest(): string[] {
    const out: string[] = [];
    for (const [value, n] of this.counts) for (let i = 0; i < n; i += 1) out.push(value);
    return out.sort();
  }
}

const WALL = /^(\d{4})-(\d{2})-(\d{2})(?:[Tt](\d{2}):(\d{2})(?::(\d{2}))?)?$/;

interface Wall {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  dateOnly: boolean;
}

function wallOf(iso: string | undefined): Wall | undefined {
  if (iso === undefined) return undefined;
  const m = WALL.exec(iso);
  if (!m) return undefined;
  return {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: Number(m[4] ?? 0),
    minute: Number(m[5] ?? 0),
    second: Number(m[6] ?? 0),
    dateOnly: m[4] === undefined,
  };
}

/** Время суток патча поверх даты снимка (Р1: у серии берётся только время суток). */
function timeOfDayOn(base: ICAL.Time, wall: Wall): ICAL.Time {
  const time = base.clone();
  time.isDate = false;
  time.hour = wall.hour;
  time.minute = wall.minute;
  time.second = wall.second;
  return time;
}

/** Названный момент целиком в форме и поясе снимка (scope "this"). */
function wholeMoment(base: ICAL.Time, wall: Wall): ICAL.Time {
  const time = base.clone();
  time.isDate = false;
  time.year = wall.year;
  time.month = wall.month;
  time.day = wall.day;
  time.hour = wall.hour;
  time.minute = wall.minute;
  time.second = wall.second;
  return time;
}

/** Область правки: встречи, которых операция вправе коснуться. */
function affectedOf(c: SemanticsCase): { affected: Snap[]; known: boolean } {
  const { before, scope, address, o } = c;
  if (scope === "all_series") return { affected: [...before.snaps], known: true };
  if (address === undefined) {
    // Без адреса область называет только одиночное событие.
    if (before.snaps.length <= 1) return { affected: [...before.snaps], known: true };
    return { affected: [], known: false };
  }
  if (scope === "this") {
    return { affected: before.snaps.filter((s) => s.address === address), known: true };
  }
  const boundary = keyOfAddress(o, address);
  if (boundary === undefined) return { affected: [], known: false };
  return { affected: before.snaps.filter((s) => keyAtLeast(s.key, boundary)), known: true };
}

const TIME_FIELDS = new Set(["start", "end", "timeZone", "allDay"]);

function touchesTime(patch: Record<string, unknown>): boolean {
  return Object.keys(patch).some((key) => TIME_FIELDS.has(key));
}

function lastStart(snaps: readonly Snap[]): number {
  return snaps.length === 0 ? Number.POSITIVE_INFINITY : snaps[snaps.length - 1].startMs;
}

/**
 * Нарушения семантики области правки. Пустой список — расхождений нет.
 * Каждая строка — готовое пояснение по-русски для findings.json.
 */
export function checkSemantics(c: SemanticsCase): string[] {
  const problems: string[] = [];
  const { op, scope, entry } = c;
  const patch = (entry?.patch ?? {}) as Record<string, unknown>;
  // Упор в 400 встреч (бесконечная серия) делает хвосты миров несравнимыми:
  // сравнивается общее окно — до последней встречи, которую видели оба.
  // Запас в двое суток и рез по границе суток: у краёв упора встречи «до» и
  // «после» приходятся на разное время суток, и оба мира должны кончаться в
  // одном и том же месте, иначе счёт разойдётся на единицу.
  const edge = Math.min(lastStart(c.before.snaps), lastStart(c.after.snaps)) - 2 * 86_400_000;
  const limit = c.before.capped || c.after.capped ? Math.floor(edge / 86_400_000) * 86_400_000 : Number.POSITIVE_INFINITY;
  const before = { ...c.before, snaps: c.before.snaps.filter((s) => s.startMs < limit) };
  const after = { ...c.after, snaps: c.after.snaps.filter((s) => s.startMs < limit) };
  const { affected, known } = affectedOf({ ...c, before });
  const losses = new Set(c.declaredLosses ?? []);
  const affectedSet = new Set(affected);
  for (const snap of before.snaps) if (losses.has(snap.address)) affectedSet.add(snap);
  const unaffected = before.snaps.filter((s) => !affectedSet.has(s));

  // 1. Вне области правки — тождественность.
  const pool = new Bag(after.snaps.map(sigOf));
  const missing: Snap[] = [];
  for (const snap of unaffected) if (!pool.take(sigOf(snap))) missing.push(snap);
  if (missing.length > 0) {
    problems.push(
      `вне области правки изменились или исчезли встречи (${missing.length}): ` +
        missing.slice(0, 4).map(showSnap).join("; ") +
        `; после записи остались: ${after.snaps.slice(0, 8).map(showSnap).join("; ")}`,
    );
  }
  const leftovers = pool.rest();

  // 2. Число встреч в области правки. Подтверждённые потери (О11) исчезают,
  // остальные встречи области остаются: правка встреч не убирает.
  const staying = [...affectedSet].filter((s) => !losses.has(s.address)).length;
  // У бесконечной серии края упора «до» и «после» не совпадают на одну
  // встречу: сдвиг времени суток или переход на «весь день» переносит
  // последнюю встречу окна через границу суток. Поэтому у миров с упором
  // счёт сверяется с допуском в одну встречу.
  const tolerance = c.before.capped || c.after.capped ? 1 : 0;
  const recurrencePatch = patch.recurrence !== undefined;
  if (missing.length === 0 && known) {
    if (op === "delete") {
      if (leftovers.length > 0) {
        problems.push(
          `удаление оставило или добавило встречи в названной области (${leftovers.length}): ${leftovers.slice(0, 4).join("; ")}`,
        );
      }
    } else if (!recurrencePatch && Math.abs(leftovers.length - staying) > tolerance) {
      problems.push(
        `в области правки должно было остаться ${staying} встреч, после записи их ${leftovers.length}: ${leftovers.slice(0, 4).join("; ")}`,
      );
    }
  }

  // 3. Точное ожидание — только для правки (update) и только когда область известна.
  if (op === "update" && known && missing.length === 0 && affected.length > 0 && entry && losses.size === 0) {
    problems.push(...checkUpdate(c, affected, leftovers, entry));
  }

  // 4. Проба за концом серии.
  if (before.ends !== after.ends) {
    const justified = recurrencePatch || (op === "delete" && scope !== "this");
    if (!justified) {
      problems.push(
        before.ends
          ? "до записи серия кончалась в пределах горизонта, после — нет, а патч конца серии не касался"
          : "до записи серия уходила за горизонт, после — кончилась, а патч конца серии не касался",
      );
    }
  }
  return problems;
}

function checkUpdate(c: SemanticsCase, affected: Snap[], leftovers: string[], entry: OraclePatch): string[] {
  const problems: string[] = [];
  const patch = entry.patch as Record<string, unknown> & { timeZone?: string; start?: string; end?: string; allDay?: boolean };
  const changed = new Set(leftovers);

  if (entry.kind === "field" && entry.field) {
    // Патч поля не вправе двигать встречи: адрес, моменты и всесуточность те же.
    const times = new Bag(leftovers.map((sig) => sig.split(SEP).slice(0, 4).join(SEP)));
    const moved = affected.filter((s) => !times.take(timeSigOf(s)));
    if (moved.length > 0) {
      problems.push(
        `патч поля ${entry.field} сдвинул встречи или сменил их адрес (${moved.length}): ${moved.slice(0, 4).map(showSnap).join("; ")}`,
      );
    }
    // Слоты без своего компонента обязаны принять новое значение.
    const want = entry.field === "attendees" ? "oracle@example.com" : String(patch[entry.field] ?? "");
    const index = new Map<string, string[]>();
    for (const sig of changed) {
      const parts = sig.split(SEP);
      const key = parts.slice(0, 4).join(SEP);
      const list = index.get(key) ?? [];
      list.push(sig);
      index.set(key, list);
    }
    const position = { summary: 4, description: 5, location: 6, status: 7, attendees: 8 }[entry.field];
    for (const snap of affected) {
      if (!snap.plain) continue;
      const list = index.get(timeSigOf(snap));
      if (!list || list.length === 0) continue;
      const value = list[0].split(SEP)[position];
      const ok = entry.field === "attendees" ? value.includes(want) : value === want;
      if (!ok) {
        problems.push(`слоту ${snap.address} патч ${entry.field} не применён: ожидалось ${JSON.stringify(want)}, в выдаче ${JSON.stringify(value)}`);
        break;
      }
    }
    return problems;
  }

  if (entry.kind === "time") {
    // Патч времени не вправе менять видимые поля.
    const fields = new Bag(leftovers.map((sig) => sig.split(SEP).slice(4).join(SEP)));
    const spoiled = affected.filter((s) => !fields.take(fieldSigOf(s)));
    if (spoiled.length > 0 && patch.summary === undefined) {
      problems.push(
        `патч времени изменил видимые поля встреч (${spoiled.length}): ${spoiled.slice(0, 4).map(showSnap).join("; ")}`,
      );
    }
    problems.push(...checkTime(c, affected, leftovers, entry));
    return problems;
  }

  // Патч одного пояса: моменты сохраняются у начала серии (якорь), дальше
  // ими правит стенное время нового пояса (перевод часов).
  if (patch.timeZone !== undefined && patch.start === undefined && patch.end === undefined && patch.allDay === undefined) {
    // Якорь — первая встреча области: её момент смена пояса сохраняет
    // (DTSTART серии или начало продолжения). Если первая встреча области
    // со своим компонентом, якоря нет: у неё своё время (О7).
    const anchor = affected[0]?.plain ? affected[0] : undefined;
    if (anchor) {
      const moments = new Bag(leftovers.map((sig) => sig.split(SEP).slice(1, 4).join(SEP)));
      if (!moments.take([anchor.startMs, anchor.endMs, anchor.allDay ? "D" : "T"].join(SEP))) {
        problems.push(
          `смена пояса без start сдвинула начало области: у ${anchor.address} было ` +
            `${new Date(anchor.startMs).toISOString()}–${new Date(anchor.endMs).toISOString()}, ` +
            `в выдаче таких моментов нет: ${leftovers.slice(0, 4).join("; ")}`,
        );
      }
    }
    return problems;
  }

  // kind "invariant": сверх инвариантов области ожидания нет.
  if (!touchesTime(patch) && patch.recurrence === undefined) {
    const fields = new Bag(leftovers.map((sig) => sig.split(SEP).slice(0, 4).join(SEP)));
    const moved = affected.filter((s) => !fields.take(timeSigOf(s)));
    if (moved.length > 0) {
      problems.push(`патч ${entry.name} сдвинул встречи, хотя времени не касался (${moved.length}): ${moved.slice(0, 3).map(showSnap).join("; ")}`);
    }
  }
  return problems;
}

/**
 * Ожидаемое время слотов без своего компонента.
 *
 * У одиночного события и у scope "this" патч называет момент целиком. У
 * серии (this_and_following, all_series) из патча берутся только время суток
 * и длительность, а даты слотов остаются прежними (Р1); значения RDATE
 * сдвигаются на ту же стенную разницу, что и слоты правила, — поэтому
 * ожидание считается сдвигом стенного времени, одинаковым для всей области.
 */
function checkTime(c: SemanticsCase, affected: Snap[], leftovers: string[], entry: OraclePatch): string[] {
  const patch = entry.patch as { start?: string; end?: string; timeZone?: string };
  const start = wallOf(patch.start);
  const end = wallOf(patch.end);
  if (patch.start !== undefined && !start) return [];
  if (patch.end !== undefined && !end) return [];

  const moments = new Bag(leftovers.map((sig) => sig.split(SEP).slice(1, 4).join(SEP)));
  const problems: string[] = [];
  // У серии правка времени берёт из патча только время суток и длительность
  // (Р1), у одиночного события — названный момент целиком: даты серии, за
  // которую надо держаться, у него нет.
  const whole = c.scope === "this" || c.o.kind !== "series";
  const plain = affected.filter((s) => s.plain);
  if (plain.length === 0) return problems;
  // Стенной сдвиг области: время суток из патча минус время суток первой
  // встречи области. У правила он даёт ровно время суток патча, у RDATE —
  // тот же сдвиг (Р1).
  const shift = start && !whole ? secondsOfDay(start) - secondsOfDay(plain[0].startTime) : 0;
  const rdate = rdateKeysOf(c.o);

  for (const snap of plain) {
    if (snap.allDay && ((start && !start.dateOnly) || (end && !end.dateOnly))) continue; // отказ по форме — законный исход
    if (!snap.allDay && ((start && start.dateOnly) || (end && end.dateOnly))) continue;
    if (end && rdate.has(snap.key)) continue; // свой конец периода RDATE — своё правило

    let startMs = snap.startMs;
    let endMs = snap.endMs;
    let startTime: ICAL.Time | undefined;
    if (start) {
      startTime = whole ? wholeMoment(snap.startTime, start) : shifted(snap.startTime, shift);
      startMs = msOf(startTime, ENV);
    }
    if (end) {
      // Конец: у одиночного события и у "this" — названный момент, у серии —
      // то же время суток на дате начала встречи.
      const base = startTime ?? snap.startTime;
      const time = whole ? wholeMoment(base, end) : timeOfDayOn(base, end);
      endMs = msOf(time, ENV);
    } else if (startTime) {
      // start без end сохраняет длительность: конец идёт тем же сдвигом.
      endMs = whole ? startMs + (snap.endMs - snap.startMs) : msOf(shifted(snap.endTime, shift), ENV);
    }
    if (endMs <= startMs) continue; // такой патч — законный отказ invalid-time

    const want = [startMs, endMs, snap.allDay ? "D" : "T"].join(SEP);
    if (!moments.take(want)) {
      problems.push(
        `слот ${snap.address}: ожидалось ${new Date(startMs).toISOString()}–${new Date(endMs).toISOString()}, ` +
          `в выдаче таких нет; изменённые встречи: ${leftovers.slice(0, 4).join("; ")}`,
      );
      break;
    }
  }
  return problems;
}

function secondsOfDay(t: ICAL.Time | Wall): number {
  return t.hour * 3600 + t.minute * 60 + t.second;
}

/** Стенное время, сдвинутое на seconds; момент считается по поясу значения. */
function shifted(t: ICAL.Time, seconds: number): ICAL.Time {
  const time = t.clone();
  time.isDate = false;
  if (seconds !== 0) time.adjust(0, 0, 0, seconds);
  return time;
}
